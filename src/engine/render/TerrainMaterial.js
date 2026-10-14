// Terrain material: smooth-shaded PBR splatting of the terrain texture array (render/Surfaces.js).
//
// The resolved material id of every heightfield vertex lives in an R8 texture (TerrainData
// resolvedMaterial: painted, else automatic). Each pixel reads the 4 vertices around it and
// blends their layers bilinearly, sharpened by the layers' height maps (sand fills the gaps
// between stones, grass grows through the dirt...), so painted borders follow the texture
// instead of the 2 m grid. Every material maps to a layer + a tint (its palette colour / the
// layer's mean colour, Surfaces.js surfRel: TERRAIN_MATERIALS still sets the colours, GI and the
// map agree). Flat
// ground samples a top projection, slopes switch to triplanar (no stretched cliffs); a second,
// much larger scale of the same layer breaks the tiling with distance. Vertex colours carry the
// per-vertex variation and the underwater darkening.
import * as THREE from 'three';
import { TERRAIN_MATERIALS } from '../world/TerrainData.js';
import { SURF_DETAIL_GLSL, luma } from './Surfaces.js';

const N = 16; // material slots (TERRAIN_MATERIALS ids)

export function terrainMaterial(lighting, terrain) {
  const S = lighting.surfaces;
  const m = S.manifest?.terrain;
  const info = Array.from({ length: N }, () => new THREE.Vector4(1, 1, 1, 0));
  const info2 = Array.from({ length: N }, () => new THREE.Vector4(0.25, 0.6, 1, 0.6));
  const means = Array.from({ length: N }, (_, i) => {
    const mean = m?.layers?.[i]?.mean ?? [0.2, 0.2, 0.2];
    return new THREE.Vector4(1 / Math.max(mean[0], 0.004), 1 / Math.max(mean[1], 0.004), 1 / Math.max(mean[2], 0.004), luma(mean));
  });
  for (const tm of TERRAIN_MATERIALS) {
    if (!tm.id) continue;
    const layerId = m?.materials?.[tm.name] ?? tm.name;
    const li = S.terrainLayer(layerId);
    const L = m?.layers?.[li];
    const lin = tm.color.map((c) => c * c); // TerrainData authoring: linear = colour²
    info[tm.id].set(lin[0], lin[1], lin[2], li);
    info2[tm.id].set(1 / (L?.scale ?? 4), tm.roughness ?? 1, tm.normal ?? 1, tm.chroma ?? 0.6);
  }
  const ids = new THREE.DataTexture(new Uint8Array(terrain.res * terrain.res), terrain.res, terrain.res, THREE.RedFormat, THREE.UnsignedByteType);
  ids.minFilter = ids.magFilter = THREE.NearestFilter;
  ids.generateMipmaps = false;
  ids.needsUpdate = true;
  const uniforms = {
    terIds: { value: ids },
    terMat: { value: info },
    terMat2: { value: info2 },
    terMean: { value: means },
    terGrid: { value: new THREE.Vector4(-terrain.half, -terrain.half, 1 / terrain.cell, terrain.res) },
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  lighting.patch(mat, { terrain: true });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    Object.assign(sh.uniforms, uniforms, { terAlbedo: S.uniforms.terAlbedo, terNormal: S.uniforms.terNormal, surfDetail: S.uniforms.surfDetail, surfNormalScale: S.uniforms.surfNormalScale });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrW;\nvarying vec3 vTerrN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrW = (modelMatrix * vec4(position, 1.0)).xyz;\nvTerrN = normalize(mat3(modelMatrix) * normal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${SPLAT}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz);`);
  };
  const pk = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => pk() + '|terrain';
  mat.userData.terrainIds = ids;
  return mat;
}

const PARS = /* glsl */ `
uniform highp sampler2DArray terAlbedo;
uniform highp sampler2DArray terNormal;
uniform sampler2D terIds;
uniform vec4 terMat[${N}];  // rgb: palette colour (linear), a: layer
uniform vec4 terMat2[${N}]; // x: uv per m, y: roughness scale, z: normal strength, w: chroma
uniform vec4 terMean[${N}]; // per layer: 1 / mean albedo, mean luminance
${SURF_DETAIL_GLSL}
uniform vec4 terGrid;       // world -> grid: x0, z0, 1 / cell, res
uniform float surfDetail, surfNormalScale;
varying vec3 vTerrW;
varying vec3 vTerrN;

// one layer: albedo (a = height) + normal (world) + roughness, top or triplanar projection,
// near detail scale mixed with a large scale that breaks the tiling with distance
void terLayer(int id, vec3 P, vec3 Nw, vec3 bw, bool tri, float far, out vec4 alb, out vec3 nW, out float rough) {
  vec4 mi = terMat[id], m2 = terMat2[id];
  float L = mi.a, k = m2.x;
  vec4 nt;
  if (!tri) {
    vec2 uv = P.xz * k;
    alb = texture(terAlbedo, vec3(uv, L));
    nt = texture(terNormal, vec3(uv, L));
    if (far > 0.0) {
      vec4 a2 = texture(terAlbedo, vec3(uv * 0.173 + vec2(0.31, 0.77), L));
      alb.rgb = mix(alb.rgb, a2.rgb, far * 0.55);
    }
    vec2 t = (nt.xy * 2.0 - 1.0) * m2.z;
    nW = vec3(t.x, 0.0, t.y);
  } else {
    vec2 ux = P.zy * k, uy = P.xz * k, uz = P.xy * k;
    vec4 ax = texture(terAlbedo, vec3(ux, L)), ay = texture(terAlbedo, vec3(uy, L)), az = texture(terAlbedo, vec3(uz, L));
    alb = ax * bw.x + ay * bw.y + az * bw.z;
    vec4 nx = texture(terNormal, vec3(ux, L)), ny = texture(terNormal, vec3(uy, L)), nz = texture(terNormal, vec3(uz, L));
    nt = nx * bw.x + ny * bw.y + nz * bw.z;
    vec2 tx = (nx.xy * 2.0 - 1.0) * m2.z, ty = (ny.xy * 2.0 - 1.0) * m2.z, tz = (nz.xy * 2.0 - 1.0) * m2.z;
    nW = vec3(0.0, tx.y, tx.x * sign(Nw.x)) * bw.x + vec3(ty.x, 0.0, ty.y) * bw.y + vec3(tz.x * sign(Nw.z), tz.y, 0.0) * bw.z;
  }
  alb.rgb = mi.rgb * surfRel(alb.rgb, terMean[int(L)], m2.w, 1.0);
  rough = clamp(nt.b * m2.y, 0.04, 1.0);
}
`;

const SPLAT = /* glsl */ `
vec3 tN = normalize(vTerrN);
float tRough = 1.0;
surfSpecK = 0.35; // rough ground: little sky reflection, even at grazing angles
{
  vec3 Nw = tN;
  // 4 grid vertices around the pixel, their materials and bilinear weights
  vec2 g = (vTerrW.xz - terGrid.xy) * terGrid.z;
  vec2 f = fract(g);
  ivec2 c0 = clamp(ivec2(floor(g)), ivec2(0), ivec2(int(terGrid.w) - 2));
  int i0 = int(texelFetch(terIds, c0, 0).r * 255.0 + 0.5);
  int i1 = int(texelFetch(terIds, c0 + ivec2(1, 0), 0).r * 255.0 + 0.5);
  int i2 = int(texelFetch(terIds, c0 + ivec2(0, 1), 0).r * 255.0 + 0.5);
  int i3 = int(texelFetch(terIds, c0 + ivec2(1, 1), 0).r * 255.0 + 0.5);
  // projection: top on gentle ground, triplanar on slopes
  bool tri = Nw.y < 0.78;
  vec3 bw = pow(abs(Nw), vec3(4.0));
  bw /= bw.x + bw.y + bw.z;
  float dist = length(vTerrW - cameraPosition);
  float far = tri ? 0.0 : smoothstep(12.0, 90.0, dist);
  vec3 col, nAcc;
  float rAcc;
  vec4 a0;
  vec3 n0;
  float r0;
  terLayer(i0, vTerrW, Nw, bw, tri, far, a0, n0, r0);
  // Written out without arrays or loops: the generic 4-layer loop (local arrays indexed in a
  // loop) cost ~4.5 ms more per frame on Apple GPUs than this.
  if (i0 == i1 && i0 == i2 && i0 == i3) {
    // inside a material (most pixels): one layer
    col = a0.rgb; nAcc = n0; rAcc = r0;
  } else {
    // border: corners sharing a material add up, then the layers height-blend (the higher
    // texel, stone or tuft, wins near the border)
    float w0 = (1.0 - f.x) * (1.0 - f.y), w1 = f.x * (1.0 - f.y), w2 = (1.0 - f.x) * f.y, w3 = f.x * f.y;
    if (i1 == i0) { w0 += w1; w1 = 0.0; }
    if (i2 == i0) { w0 += w2; w2 = 0.0; } else if (i2 == i1) { w1 += w2; w2 = 0.0; }
    if (i3 == i0) { w0 += w3; w3 = 0.0; } else if (i3 == i1) { w1 += w3; w3 = 0.0; } else if (i3 == i2) { w2 += w3; w3 = 0.0; }
    vec4 a1 = vec4(0.0), a2 = vec4(0.0), a3 = vec4(0.0);
    vec3 n1 = vec3(0.0), n2 = vec3(0.0), n3 = vec3(0.0);
    float r1 = 1.0, r2 = 1.0, r3 = 1.0;
    if (w1 > 0.0) terLayer(i1, vTerrW, Nw, bw, tri, far, a1, n1, r1);
    if (w2 > 0.0) terLayer(i2, vTerrW, Nw, bw, tri, far, a2, n2, r2);
    if (w3 > 0.0) terLayer(i3, vTerrW, Nw, bw, tri, far, a3, n3, r3);
    float h0 = w0 > 0.0 ? w0 + a0.a * 0.55 : -1.0, h1 = w1 > 0.0 ? w1 + a1.a * 0.55 : -1.0;
    float h2 = w2 > 0.0 ? w2 + a2.a * 0.55 : -1.0, h3 = w3 > 0.0 ? w3 + a3.a * 0.55 : -1.0;
    float hmax = max(max(h0, h1), max(h2, h3));
    float b0 = max(h0 - hmax + 0.22, 0.0), b1 = max(h1 - hmax + 0.22, 0.0), b2 = max(h2 - hmax + 0.22, 0.0), b3 = max(h3 - hmax + 0.22, 0.0);
    float bs = max(b0 + b1 + b2 + b3, 1e-4);
    col = (a0.rgb * b0 + a1.rgb * b1 + a2.rgb * b2 + a3.rgb * b3) / bs;
    nAcc = (n0 * b0 + n1 * b1 + n2 * b2 + n3 * b3) / bs;
    rAcc = (r0 * b0 + r1 * b1 + r2 * b2 + r3 * b3) / bs;
  }
  // normal detail fades out with distance (mip noise), surfaces.normalScale from the environment
  float nk = surfNormalScale * surfDetail * (1.0 - smoothstep(60.0, 250.0, dist));
  tN = normalize(Nw + nAcc * nk);
  diffuseColor.rgb *= col;
  tRough = rAcc;
}
`;
