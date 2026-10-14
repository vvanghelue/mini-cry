// Per-instance LOD selection with dithered cross-fades (no popping), for InstancedMeshes.
//
// Each LOD mesh's geometry carries a constant `lodRange` attribute (inA, inB, outA, outB): the
// instance (horizontal distance d from camPosW to its origin) fades in over [inA, inB], is solid up
// to outA and fades out over [outA, outB]. The CPU only picks which sectors each LOD mesh may need
// (every LOD whose range overlaps the sector); the shader collapses the instances outside the range
// before any other vertex work. Inside a band the two LODs fill complementary pixels of a dither
// threshold (the fading-in one uses the mirrored threshold), so a pixel is never empty or drawn
// twice. The threshold is interleaved gradient noise shifted by a per-instance hash: continuous
// (pixels drop out one by one, not 1/16 of the tree at once as with a 4x4 Bayer matrix), no
// regular screen-door grid, and two overlapping trees in their bands don't share a pattern. The
// bands are wide (LOD_BLEND of the switch distance, at least LOD_MIN_WIDTH): a near switch takes
// ~1 s at a sprint, ~2 s walking (medium preset: 8 m). Depth-only passes (sun cascades, SSAO
// pre-pass) switch hard at the middle of the band: stipple in a shadow map would only add noise.
//
// Merged static props (render/StaticBatch.js) are not instanced: their vertices carry `lodProp`
// (world x, z of the prop's origin, LOD + 2) and the ranges of their two LODs are uniforms
// (propLod0, propLod1), so each prop fades on its own like an instance.
//
// Meshes without the attributes read the generic vertex value, which three.js only ever sets to
// (0,0,0,1) or (1,1,1,1): `lodRange.w > 1.0` / `lodProp.z > 1.5` tell a real range apart.
import * as THREE from 'three';

export const LOD_BLEND = 0.15; // band width, as a fraction of the switch distance
export const LOD_MIN_WIDTH = 10; // m (x draw scale): near switches (ferns, bushes, LOD 0 trees) are the most visible

/** Ranges [inA, inB, outA, outB] per LOD for switch distances `lods[i].distance`. shrink: the last
 *  LOD fades out by shrinking (fadeMaterial) instead of dithering. */
export function lodRanges(lods, { blend = LOD_BLEND, minWidth = LOD_MIN_WIDTH, shrink = false } = {}) {
  const d = lods.map((l) => l.distance);
  // band width per boundary, capped so that the two bands of one LOD never overlap
  const w = d.map((b, i) => {
    const prev = i ? d[i - 1] : 0, next = d[i + 1];
    let x = Math.min(Math.max(b * blend, minWidth), (b - prev) / 2);
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
uniform vec4 propLod0, propLod1;
#ifdef USE_INSTANCING
attribute vec4 lodRange;
#endif
attribute vec3 lodProp;
// LOD range of this vertex's instance / prop and its origin (world xz); false: not LOD'd
bool lodOf(out vec4 r, out vec2 o) {
  #ifdef USE_INSTANCING
  if (lodRange.w > 1.0) { r = lodRange; o = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz; return true; }
  #endif
  if (lodProp.z > 1.5) { r = lodProp.z < 2.5 ? propLod0 : propLod1; o = lodProp.xy; return true; }
  return false;
}
`;
// declares camPosW itself: drop the declaration of an earlier patch in the chain (fadeMaterial)
const withPars = (vs) => vs.replace('uniform vec3 camPosW;', '').replace('#include <common>', `#include <common>\n${VERT_PARS}`);
// instances outside the range: one clipped point, no further vertex work
const CULL = 'gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return;';

/** The shared uniforms of the LOD code (camera position, prop LOD ranges), created on first use. */
export function lodUniforms(U) {
  U.camPosW ??= { value: new THREE.Vector3() };
  U.propLod0 ??= { value: new THREE.Vector4(-1, -1, 1e9, 1e9) };
  U.propLod1 ??= { value: new THREE.Vector4(1e9, 1e9, 1e9, 1e9) };
  return { camPosW: U.camPosW, propLod0: U.propLod0, propLod1: U.propLod1 };
}

/** Clone of a lit material that draws only its LOD's instances / props and dithers the bands. */
export function lodMaterial(base, lighting) {
  const cache = (lodMaterial.cache ??= new Map());
  let m = cache.get(base.uuid);
  if (m) return m;
  m = base.clone();
  const prev = base.onBeforeCompile;
  const U = lodUniforms(lighting.uniforms);
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = withPars(sh.vertexShader)
      .replace('#include <common>', '#include <common>\nflat varying vec2 vLodFade;')
      .replace('void main() {', `void main() {
        vLodFade = vec2(1.0, 0.0);
        vec4 lodR; vec2 lodO;
        if (lodOf(lodR, lodO)) {
          float d = length(lodO - camPosW.xz);
          if (d < lodR.x || d >= lodR.w) { ${CULL} }
          float fin = lodR.y > lodR.x ? (d - lodR.x) / (lodR.y - lodR.x) : 1.0;
          float fout = lodR.w > lodR.z ? (lodR.w - d) / (lodR.w - lodR.z) : 1.0;
          // fading in: negative, so the fragment side mirrors the threshold
          vLodFade.x = fin < 1.0 ? -fin : min(fout, 1.0);
          // per-instance shift of the threshold (same origin in every LOD mesh: the two LODs of
          // one instance stay complementary)
          uvec2 q = uvec2(ivec2(floor(lodO * 8.0)) + 1048576);
          uint h = q.x * 2654435761u ^ q.y * 2246822519u;
          h ^= h >> 15u; h *= 2246822519u; h ^= h >> 13u;
          vLodFade.y = float(h & 65535u) / 65536.0;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nflat varying vec2 vLodFade;')
      .replace('void main() {', `void main() {
        if (vLodFade.x < 1.0) {
          // interleaved gradient noise (Jimenez 2014), shifted per instance
          float t = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + vLodFade.y);
          if ((vLodFade.x < 0.0 ? 1.0 - t : t) >= abs(vLodFade.x)) discard;
        }`);
  };
  const pk = base.customProgramCacheKey.bind(base);
  m.customProgramCacheKey = () => pk() + '|lod';
  cache.set(base.uuid, m);
  return m;
}

/** Patch a depth-only override material (sun cascades, SSAO pre-pass): LOD meshes cast / occlude
 *  with one LOD per instance / prop, switching at the middle of each band. */
export function patchLodDepth(mat, uniforms) {
  const U = lodUniforms(uniforms);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = withPars(sh.vertexShader)
      .replace('void main() {', `void main() {
        vec4 lodR; vec2 lodO;
        if (lodOf(lodR, lodO)) {
          float d = length(lodO - camPosW.xz);
          if (d < 0.5 * (lodR.x + lodR.y) || d >= 0.5 * (lodR.z + lodR.w)) { ${CULL} }
        }`);
  };
  const pk = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => (pk ? pk() : '') + '|loddepth';
  mat.needsUpdate = true;
  return mat;
}
