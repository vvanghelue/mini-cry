// Per-instance LOD selection with dithered cross-fades (no popping), for instanced fields.
//
// Each LOD mesh carries its range (inA, inB, outA, outB) in `mesh.userData.lodRange` (a per-object
// uniform): the instance (horizontal distance d from camPosW to its origin) fades in over [inA, inB],
// is solid up to outA and fades out over [outA, outB]. The CPU only picks which sectors each LOD mesh
// may need (every LOD whose range overlaps the sector); the vertex stage collapses the instances
// outside the range (degenerate triangles: nothing rasterized). Inside a band the two LODs fill
// complementary pixels of a 4x4 Bayer pattern (the fading-in one uses the mirrored threshold), so a
// pixel is never empty or drawn twice. Depth-only passes (sun cascades, SSAO pre-pass: lodPassMode
// = 1) switch hard at the middle of the band: stipple in a shadow map would only add noise.
import * as THREE from 'three/webgpu';
import { Fn, If, uniform, float, vec4, abs, select, length, varying, screenCoordinate, attribute, modelWorldMatrix } from 'three/tsl';
import { U, bayer4 } from './tsl.js';
import { cloneMaterial } from './Lighting.js';

export const LOD_BLEND = 0.12; // band width, as a fraction of the switch distance

/** 0: main view (dithered bands), 1: depth passes (hard switch at the middle of each band). */
export const lodPassMode = U(0);

const NO_RANGE = new THREE.Vector4(-1, -1, 1e9, 1e9);

/** Per object: mesh.userData.lodRange (Vector4) or no limit. */
export const lodRangeNode = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => object.userData.lodRange ?? NO_RANGE);

/** Ranges [inA, inB, outA, outB] per LOD for switch distances `lods[i].distance`. shrink: the last
 *  LOD fades out by shrinking (fadeMaterial) instead of dithering. */
export function lodRanges(lods, { blend = LOD_BLEND, shrink = false } = {}) {
  const d = lods.map((l) => l.distance);
  // band width per boundary, capped so that the two bands of one LOD never overlap
  const w = d.map((b, i) => {
    const prev = i ? d[i - 1] : 0, next = d[i + 1];
    let x = Math.min(b * blend, (b - prev) / 2);
    if (next !== undefined) x = Math.min(x, (next - b) / 2);
    return x;
  });
  return d.map((e, i) => {
    const last = i === d.length - 1;
    const inA = i ? d[i - 1] - w[i - 1] / 2 : -1, inB = i ? d[i - 1] + w[i - 1] / 2 : -1;
    const [outA, outB] = !last ? [e - w[i] / 2, e + w[i] / 2] : shrink ? [e, e] : [e - w[i], e];
    return [inA, inB, outA, outB];
  });
}

/** Set a LOD mesh's range. */
export function setLodRange(mesh, [a, b, c, d]) {
  (mesh.userData.lodRange ??= new THREE.Vector4()).set(a, b, c, d);
}

/** Horizontal distance of the instance origin to the view camera (vertex stage, instanced geometry). */
export const lodDist = (camPosW) => length(modelWorldMatrix.mul(vec4(attribute('iM3', 'vec4').xyz, 1.0)).xz.sub(camPosW.xz));

/** Vertex stage: is the instance drawn in this pass? (main: inside [inA, outB]; depth: between the
 *  middles of its bands) */
export const lodVisible = (camPosW) => {
  const r = lodRangeNode, d = lodDist(camPosW);
  const lo = select(lodPassMode.greaterThan(0.5), r.x.add(r.y).mul(0.5), r.x);
  const hi = select(lodPassMode.greaterThan(0.5), r.z.add(r.w).mul(0.5), r.w);
  return d.greaterThanEqual(lo).and(d.lessThan(hi));
};

/** Fade of the instance (flat varying): 1 solid, (0, 1) fading out, < 0 fading in (mirrored). */
const lodFadeVarying = (camPosW) => varying(Fn(() => {
  const r = lodRangeNode, d = lodDist(camPosW);
  const fin = select(r.y.greaterThan(r.x), d.sub(r.x).div(r.y.sub(r.x)), float(1.0));
  const fout = select(r.w.greaterThan(r.z), r.w.sub(d).div(r.w.sub(r.z)), float(1.0));
  return select(fin.lessThan(1.0), fin.negate(), fout.min(1.0));
})(), 'vLodFade').setInterpolation('flat');

/** Fragment mask of a LOD band: false where this LOD leaves the pixel to the other one. */
export const lodMask = (camPosW) => Fn(() => {
  const f = lodFadeVarying(camPosW);
  const keep = float(1.0).toVar();
  If(f.lessThan(1.0), () => {
    const t = bayer4(screenCoordinate.xy);
    If(select(f.lessThan(0.0), t.oneMinus(), t).greaterThanEqual(abs(f)), () => { keep.assign(0.0); });
  });
  return keep.greaterThan(0.5);
})();

/** Clone of a lit material that draws only its LOD's instances and dithers the bands. */
export function lodMaterial(base, lighting) {
  const cache = (lodMaterial.cache ??= new Map());
  let m = cache.get(base.uuid);
  if (m) return m;
  m = cloneMaterial(base);
  // impostors place their own quads and collapse their own out-of-range instances
  if (!base.mcCustomVertex) lighting.setupVertex(m, { ...(base.mcOpts ?? {}), lod: true }, base);
  m.maskNode = lodMask(lighting.uniforms.camPosW);
  cache.set(base.uuid, m);
  return m;
}
