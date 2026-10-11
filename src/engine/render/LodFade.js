// Per-instance LOD selection with dithered cross-fades (no popping), for InstancedMeshes.
//
// Each LOD mesh's geometry carries a constant `lodRange` attribute (inA, inB, outA, outB): the
// instance (horizontal distance d from camPosW to its origin) fades in over [inA, inB], is solid up
// to outA and fades out over [outA, outB]. The CPU only picks which sectors each LOD mesh may need
// (every LOD whose range overlaps the sector); the shader collapses the instances outside the range
// before any other vertex work. Inside a band the two LODs fill complementary pixels of a 4x4
// Bayer pattern (the fading-in one uses the mirrored threshold), so a pixel is never empty or drawn
// twice. Depth-only passes (sun cascades, SSAO pre-pass) switch hard at the middle of the band:
// stipple in a shadow map would only add noise.
//
// Meshes without the attribute read the generic vertex value, which three.js only ever sets to
// (0,0,0,1) or (1,1,1,1): `lodRange.w > 1.0` tells a real range apart.
import * as THREE from 'three';

export const LOD_BLEND = 0.12; // band width, as a fraction of the switch distance

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

/** Geometry sharing `geometry`'s attributes plus its own lodRange attribute. */
export function lodGeometry(geometry, range) {
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(geometry.attributes)) g.setAttribute(k, a);
  if (geometry.index) g.setIndex(geometry.index);
  g.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  g.boundingBox = geometry.boundingBox?.clone() ?? null;
  const n = geometry.attributes.position.count;
  g.setAttribute('lodRange', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  setLodRange(g, range);
  g.userData.shared = Object.keys(geometry.attributes);
  return g;
}

export function setLodRange(g, [a, b, c, d]) {
  const attr = g.attributes.lodRange, arr = attr.array;
  for (let i = 0; i < arr.length; i += 4) { arr[i] = a; arr[i + 1] = b; arr[i + 2] = c; arr[i + 3] = d; }
  attr.needsUpdate = true;
}

/** Dispose a lodGeometry without freeing the GPU buffers it shares with its source geometry. */
export function disposeLodGeometry(g) {
  for (const k of g.userData.shared ?? []) g.deleteAttribute(k);
  g.setIndex(null);
  g.dispose();
}

const VERT_PARS = /* glsl */ `
uniform vec3 camPosW;
#ifdef USE_INSTANCING
attribute vec4 lodRange;
float lodDist() { return length((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz - camPosW.xz); }
#endif
`;
// declares camPosW itself: drop the declaration of an earlier patch in the chain (fadeMaterial)
const withPars = (vs) => vs.replace('uniform vec3 camPosW;', '').replace('#include <common>', `#include <common>\n${VERT_PARS}`);
// instances outside the range: one clipped point, no further vertex work
const CULL = 'gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return;';

/** Clone of a lit material that draws only its LOD's instances and dithers the bands. */
export function lodMaterial(base, lighting) {
  const cache = (lodMaterial.cache ??= new Map());
  let m = cache.get(base.uuid);
  if (m) return m;
  m = base.clone();
  const prev = base.onBeforeCompile;
  const camU = (lighting.uniforms.camPosW ??= { value: new THREE.Vector3() });
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.uniforms.camPosW = camU;
    sh.vertexShader = withPars(sh.vertexShader)
      .replace('#include <common>', '#include <common>\nflat varying float vLodFade;')
      .replace('void main() {', `void main() {
        vLodFade = 1.0;
        #ifdef USE_INSTANCING
        if (lodRange.w > 1.0) {
          float d = lodDist();
          if (d < lodRange.x || d >= lodRange.w) { ${CULL} }
          float fin = lodRange.y > lodRange.x ? (d - lodRange.x) / (lodRange.y - lodRange.x) : 1.0;
          float fout = lodRange.w > lodRange.z ? (lodRange.w - d) / (lodRange.w - lodRange.z) : 1.0;
          // fading in: negative, so the fragment side mirrors the threshold
          vLodFade = fin < 1.0 ? -fin : min(fout, 1.0);
        }
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        flat varying float vLodFade;
        float lodBayer(vec2 p) {
          ivec2 q = ivec2(p) & 3;
          const float b[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
          return (b[q.x + q.y * 4] + 0.5) / 16.0;
        }`)
      .replace('void main() {', `void main() {
        if (vLodFade < 1.0) {
          float t = lodBayer(gl_FragCoord.xy);
          if ((vLodFade < 0.0 ? 1.0 - t : t) >= abs(vLodFade)) discard;
        }`);
  };
  const pk = base.customProgramCacheKey.bind(base);
  m.customProgramCacheKey = () => pk() + '|lod';
  cache.set(base.uuid, m);
  return m;
}

/** Patch a depth-only override material (sun cascades, SSAO pre-pass): LOD meshes cast / occlude
 *  with one LOD per instance, switching at the middle of each band. */
export function patchLodDepth(mat, uniforms) {
  const camU = (uniforms.camPosW ??= { value: new THREE.Vector3() });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.uniforms.camPosW = camU;
    sh.vertexShader = withPars(sh.vertexShader)
      .replace('void main() {', `void main() {
        #ifdef USE_INSTANCING
        if (lodRange.w > 1.0) {
          float d = lodDist();
          if (d < 0.5 * (lodRange.x + lodRange.y) || d >= 0.5 * (lodRange.z + lodRange.w)) { ${CULL} }
        }
        #endif`);
  };
  const pk = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => (pk ? pk() : '') + '|loddepth';
  mat.needsUpdate = true;
  return mat;
}
