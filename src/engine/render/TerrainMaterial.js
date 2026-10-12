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
{
  vec3 Nw = tN;
  // 4 grid vertices around the pixel, their materials and bilinear weights
  vec2 g = (vTerrW.xz - terGrid.xy) * terGrid.z;
  vec2 f = fract(g);
  ivec2 c0 = clamp(ivec2(floor(g)), ivec2(0), ivec2(int(terGrid.w) - 2));
  int ids[4];
  ids[0] = int(texelFetch(terIds, c0, 0).r * 255.0 + 0.5);
  ids[1] = int(texelFetch(terIds, c0 + ivec2(1, 0), 0).r * 255.0 + 0.5);
  ids[2] = int(texelFetch(terIds, c0 + ivec2(0, 1), 0).r * 255.0 + 0.5);
  ids[3] = int(texelFetch(terIds, c0 + ivec2(1, 1), 0).r * 255.0 + 0.5);
  float ws[4];
  ws[0] = (1.0 - f.x) * (1.0 - f.y); ws[1] = f.x * (1.0 - f.y); ws[2] = (1.0 - f.x) * f.y; ws[3] = f.x * f.y;
  for (int i = 1; i < 4; i++) for (int j = 0; j < i; j++) if (ws[i] > 0.0 && ids[i] == ids[j]) { ws[j] += ws[i]; ws[i] = 0.0; }
  // projection: top on gentle ground, triplanar on slopes
  bool tri = Nw.y < 0.78;
  vec3 bw = pow(abs(Nw), vec3(4.0));
  bw /= bw.x + bw.y + bw.z;
  float dist = length(vTerrW - cameraPosition);
  float far = tri ? 0.0 : smoothstep(12.0, 90.0, dist);
  vec4 alb[4];
  vec3 nws[4];
  float rs[4];
  bool on[4];
  float hmax = -1.0;
  for (int i = 0; i < 4; i++) {
    alb[i] = vec4(0.0); nws[i] = vec3(0.0); rs[i] = 1.0;
    on[i] = ws[i] > 0.0;
    if (!on[i]) continue;
    terLayer(ids[i], vTerrW, Nw, bw, tri, far, alb[i], nws[i], rs[i]);
    // height-blend: the higher texel (stone, tuft) wins near the border
    ws[i] = ws[i] + alb[i].a * 0.55;
    hmax = max(hmax, ws[i]);
  }
  vec3 col = vec3(0.0), nAcc = vec3(0.0);
  float wsum = 0.0, rAcc = 0.0;
  for (int i = 0; i < 4; i++) {
    if (!on[i]) continue;
    float w = max(ws[i] - hmax + 0.22, 0.0);
    col += alb[i].rgb * w; nAcc += nws[i] * w; rAcc += rs[i] * w; wsum += w;
  }
  col /= max(wsum, 1e-4); nAcc /= max(wsum, 1e-4); rAcc /= max(wsum, 1e-4);
  // normal detail fades out with distance (mip noise), surfaces.normalScale from the environment
  float nk = surfNormalScale * surfDetail * (1.0 - smoothstep(60.0, 250.0, dist));
  tN = normalize(Nw + nAcc * nk);
  diffuseColor.rgb *= col;
  tRough = rAcc;
}
`;
