// Texture arrays (public/data/textures.json, packed by `mc textures build`) and the shader code that
// samples them:
//
//  - terrain  : albedo (A = height) + normal / roughness per terrain layer (TerrainMaterial.js)
//  - surfaces : opaque PBR layers for props, buildings, bark, rocks... albedo + normal / roughness
//  - foliage  : alpha-cut leaf atlases (palm frond, leaf clusters, fern, grass...)
//
// Each group is one tall strip image (layers stacked vertically) uploaded straight into a
// 2D texture array (texImage3D slices an image source by layer height): one fetch + one decode
// per group, no per-layer canvas work. Assets carry `uv` + a per-vertex `surface` id
// (assets/surfaces.js), so every prop / plant keeps sharing one material and one draw call per
// batch: the layer is picked in the shader. Albedo is divided by the layer's mean colour, so the
// vertex colours (asset palettes) still set the overall colour and the texture adds the detail.
import * as THREE from 'three';
import { Data } from '../core/Data.js';
import { setSurfaceManifest, FOLIAGE_BASE } from '../assets/surfaces.js';

const MAX_SURF = 32, MAX_FOL = 16;

function placeholder(srgb) {
  const t = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Load one strip image as a texture array of `size` x `size` layers. */
async function loadStrip(url, size, { srgb }) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const depth = Math.round(bmp.height / size);
  const tex = new THREE.DataArrayTexture(bmp, size, size, depth);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.unpackAlignment = 4;
  tex.needsUpdate = true;
  return tex;
}

const inv = (m) => (m ?? [0.2, 0.2, 0.2]).map((c) => 1 / Math.max(0.004, c));

export class Surfaces {
  constructor() {
    this.manifest = null;
    this.ready = false;
    const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4(1, 1, 1, 0.6));
    this.uniforms = {
      surfAlbedo: { value: placeholder(true) },
      surfNormal: { value: placeholder(false) },
      folAlbedo: { value: placeholder(true) },
      surfInfo: { value: v4(MAX_SURF) }, // xyz: 1 / mean albedo, w: metalness
      folInfo: { value: v4(MAX_FOL) }, // xyz: 1 / mean albedo, w: roughness
      folCut: { value: 0.5 },
      surfNormalScale: { value: 1 },
      surfDetail: { value: 1 }, // 0 = flat vertex colours (A/B), 1 = textured
      terAlbedo: { value: placeholder(true) },
      terNormal: { value: placeholder(false) },
    };
  }

  /** Read textures.json and upload the arrays. Missing files leave neutral placeholders. */
  async load(renderer) {
    let m;
    try { m = await Data.json('textures.json'); } catch (err) { console.warn('textures:', err.message); return this; }
    this.manifest = m;
    setSurfaceManifest(m);
    const U = this.uniforms;
    (m.surfaces?.layers ?? []).forEach((l, i) => { if (i < MAX_SURF) U.surfInfo.value[i].set(...inv(l.mean), l.metal ? 0.65 : 0); });
    (m.foliage?.layers ?? []).forEach((l, i) => { if (i < MAX_FOL) U.folInfo.value[i].set(...inv(l.mean), l.roughness ?? 0.65); });
    const url = (f) => `${Data.base}../${f}?v=${m.version ?? 0}`;
    const jobs = [];
    const strip = (group, map, uniform, srgb, size) => {
      const f = m[group]?.files?.[map];
      if (!f) return;
      jobs.push(loadStrip(url(f), size, { srgb }).then((t) => { U[uniform].value = t; }).catch((err) => console.warn('textures:', err.message)));
    };
    strip('surfaces', 'albedo', 'surfAlbedo', true, m.surfaces?.size);
    strip('surfaces', 'normal', 'surfNormal', false, m.surfaces?.normalSize ?? m.surfaces?.size);
    strip('foliage', 'albedo', 'folAlbedo', true, m.foliage?.size);
    strip('terrain', 'albedo', 'terAlbedo', true, m.terrain?.size);
    strip('terrain', 'normal', 'terNormal', false, m.terrain?.normalSize ?? m.terrain?.size);
    await Promise.all(jobs);
    // upload now (during loading) rather than on the first frame that uses them
    for (const k of ['surfAlbedo', 'surfNormal', 'folAlbedo', 'terAlbedo', 'terNormal']) renderer?.initTexture?.(U[k].value);
    this.ready = true;
    return this;
  }

  /** Terrain layer index of a layer id. */
  terrainLayer(id) { return Math.max(0, (this.manifest?.terrain?.layers ?? []).findIndex((l) => l.id === id)); }

  /** Inject the textured PBR surface code into a MeshStandardMaterial shader (assets). */
  inject(sh) {
    Object.assign(sh.uniforms, this.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float surface;
        varying vec2 vSurfUv;
        flat varying int vSurf;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurfUv = uv;
        vSurf = int(surface + 0.5);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        ${SURF_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${SURF_ALBEDO}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= sRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = max(metalnessFactor, sMetal);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        ${SURF_NORMAL}`);
  }

  /** Alpha-cut foliage in a depth-only override material (sun cascades, SSAO pre-pass). */
  patchDepth(mat) {
    const U = this.uniforms;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      sh.uniforms.folAlbedo = U.folAlbedo;
      sh.uniforms.folCut = U.folCut;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float surface;\nvarying vec2 vSurfUv;\nflat varying int vSurf;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfUv = uv;\nvSurf = int(surface + 0.5);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform highp sampler2DArray folAlbedo;\nuniform float folCut;\nvarying vec2 vSurfUv;\nflat varying int vSurf;')
        .replace('void main() {', `void main() {
          if (vSurf >= ${FOLIAGE_BASE} && texture(folAlbedo, vec3(vSurfUv, float(vSurf - ${FOLIAGE_BASE}))).a < folCut) discard;`);
    };
    const pk = mat.customProgramCacheKey?.bind(mat);
    mat.customProgramCacheKey = () => (pk ? pk() : '') + '|fdepth';
    mat.needsUpdate = true;
    return mat;
  }
}

const SURF_PARS = /* glsl */ `
uniform highp sampler2DArray surfAlbedo;
uniform highp sampler2DArray surfNormal;
uniform highp sampler2DArray folAlbedo;
uniform vec4 surfInfo[${MAX_SURF}];
uniform vec4 folInfo[${MAX_FOL}];
uniform float folCut, surfNormalScale, surfDetail;
varying vec2 vSurfUv;
flat varying int vSurf;
// cotangent frame from screen derivatives (no tangent attribute; three's getTangentFrame)
mat3 surfTBN(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos.xyz), q1 = dFdy(eye_pos.xyz);
  vec2 st0 = dFdx(uv.st), st1 = dFdy(uv.st);
  vec3 N = surf_norm;
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, N);
}
`;

const SURF_ALBEDO = /* glsl */ `
vec4 sNrm = vec4(0.5, 0.5, 0.6, 1.0);
float sRough = 0.6, sMetal = 0.0;
bool sLeaf = vSurf >= ${FOLIAGE_BASE};
if (sLeaf) {
  int li = vSurf - ${FOLIAGE_BASE};
  vec4 t = texture(folAlbedo, vec3(vSurfUv, float(li)));
  // cut-out, sharpened around the threshold (crisp at every mip, smooth with alpha to coverage)
  float a = (t.a - folCut) / max(fwidth(t.a), 1e-4) + 0.5;
  #ifdef OPAQUE
    if (a < 0.5) discard;
  #else
    if (a <= 0.0) discard;
    diffuseColor.a = clamp(a, 0.0, 1.0);
  #endif
  vec4 fi = folInfo[li];
  diffuseColor.rgb *= mix(vec3(1.0), t.rgb * fi.xyz, surfDetail);
  sRough = max(fi.w, 0.85);
  surfSpecK = 0.15;
} else {
  vec4 t = texture(surfAlbedo, vec3(vSurfUv, float(vSurf)));
  vec4 si = surfInfo[vSurf];
  diffuseColor.rgb *= mix(vec3(1.0), t.rgb * si.xyz, surfDetail);
  sNrm = texture(surfNormal, vec3(vSurfUv, float(vSurf)));
  sRough = mix(0.75, sNrm.b, surfDetail);
  sMetal = si.w * surfDetail;
}
`;

const SURF_NORMAL = /* glsl */ `
if (!sLeaf) {
  vec3 mapN = vec3((sNrm.xy * 2.0 - 1.0) * surfNormalScale * surfDetail, 0.0);
  mapN.z = sqrt(max(0.0, 1.0 - dot(mapN.xy, mapN.xy)));
  mat3 sTbn = surfTBN(-vViewPosition, normal, vSurfUv);
  #ifdef DOUBLE_SIDED
    sTbn[0] *= faceDirection; sTbn[1] *= faceDirection;
  #endif
  normal = normalize(sTbn * mapN);
} else {
  // thin, translucent leaves: light from above reaches their undersides too
  normal = normalize(normal + (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz * 0.9);
}
`;
