// Terrain material: smooth-shaded PBR splatting of the terrain texture array (render/Surfaces.js).
//
// The resolved material id of every heightfield vertex lives in an R8 texture (TerrainData
// resolvedMaterial: painted, else automatic). Each pixel reads the 4 vertices around it and
// blends their layers bilinearly, sharpened by the layers' height maps (sand fills the gaps
// between stones, grass grows through the dirt...), so painted borders follow the texture
// instead of the 2 m grid. Every material maps to a layer + a tint (its palette colour / the
// layer's mean colour, Surfaces.js surfRel: TERRAIN_MATERIALS still sets the colours, GI and the
// map agree). Flat ground samples a top projection, slopes switch to triplanar (no stretched
// cliffs); a second, much larger scale of the same layer breaks the tiling with distance. Vertex
// colours carry the per-vertex variation and the underwater darkening.
import * as THREE from 'three/webgpu';
import {
  Fn, If, texture, uniformArray, uniform, attribute, varying, vec2, vec3, vec4, float, int, ivec2, mix, max, clamp, pow, abs, sign, normalize, length, smoothstep, floor, fract,
  modelWorldMatrix, positionLocal, cameraPosition, cameraViewMatrix, renderGroup, mat3, select, property,
} from 'three/tsl';
import { TERRAIN_MATERIALS } from '../world/TerrainData.js';
import { luma, surfRel } from './Surfaces.js';
import { WorldStandardMaterial } from './WorldMaterial.js';
import { surfSpecK } from './nodes.js';

const N = 16; // material slots (TERRAIN_MATERIALS ids)

export function terrainMaterial(lighting, terrain) {
  const S = lighting.surfaces, SU = S.uniforms;
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
  const g = (n) => n.setGroup(renderGroup);
  const U = {
    terIds: texture(ids),
    terMat: g(uniformArray(info, 'vec4')), // rgb: palette colour (linear), a: layer
    terMat2: g(uniformArray(info2, 'vec4')), // x: uv per m, y: roughness scale, z: normal strength, w: chroma
    terMean: g(uniformArray(means, 'vec4')), // per layer: 1 / mean albedo, mean luminance
    terGrid: g(uniform(new THREE.Vector4(-terrain.half, -terrain.half, 1 / terrain.cell, terrain.res))), // world -> grid: x0, z0, 1 / cell, res
  };
  const mat = new WorldStandardMaterial(lighting, { ao: true, sky: true, env: null }, { roughness: 1, metalness: 0 });
  mat.name = 'terrain';
  mat.vertexColors = false;
  const vW = varying(modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz, 'vTerrW');
  const vN = varying(normalize(mat3(modelWorldMatrix).mul(attribute('normal', 'vec3'))), 'vTerrN');
  const vCol = varying(attribute('color', 'vec3'), 'vTerrCol');

  // one layer: albedo (a = height) + normal (world) + roughness, top or triplanar projection,
  // near detail scale mixed with a large scale that breaks the tiling with distance (inline: the
  // per-pixel code is written out, no loop or local array, see the header of SunShadows.js)
  const layer = (id, P, Nw, bw, tri, far, out) => {
    const mi = U.terMat.element(id), m2 = U.terMat2.element(id);
    const L = int(mi.a), k = m2.x;
    const nt = vec4(0).toVar();
    If(tri.not(), () => {
      const uv = P.xz.mul(k);
      const alb = SU.terAlbedo.sample(uv).depth(L).toVar();
      nt.assign(SU.terNormal.sample(uv).depth(L));
      If(far.greaterThan(0), () => {
        const a2 = SU.terAlbedo.sample(uv.mul(0.173).add(vec2(0.31, 0.77))).depth(L);
        alb.rgb.assign(mix(alb.rgb, a2.rgb, far.mul(0.55)));
      });
      out.alb.assign(alb);
      const t = nt.xy.mul(2).sub(1).mul(m2.z);
      out.nW.assign(vec3(t.x, 0, t.y));
    }).Else(() => {
      const ux = P.zy.mul(k), uy = P.xz.mul(k), uz = P.xy.mul(k);
      const ax = SU.terAlbedo.sample(ux).depth(L), ay = SU.terAlbedo.sample(uy).depth(L), az = SU.terAlbedo.sample(uz).depth(L);
      out.alb.assign(ax.mul(bw.x).add(ay.mul(bw.y)).add(az.mul(bw.z)));
      const nx = SU.terNormal.sample(ux).depth(L), ny = SU.terNormal.sample(uy).depth(L), nz = SU.terNormal.sample(uz).depth(L);
      nt.assign(nx.mul(bw.x).add(ny.mul(bw.y)).add(nz.mul(bw.z)));
      const tx = nx.xy.mul(2).sub(1).mul(m2.z), ty = ny.xy.mul(2).sub(1).mul(m2.z), tz = nz.xy.mul(2).sub(1).mul(m2.z);
      out.nW.assign(vec3(0, tx.y, tx.x.mul(sign(Nw.x))).mul(bw.x).add(vec3(ty.x, 0, ty.y).mul(bw.y)).add(vec3(tz.x.mul(sign(Nw.z)), tz.y, 0).mul(bw.z)));
    });
    out.alb.rgb.assign(mi.rgb.mul(surfRel(out.alb.rgb, U.terMean.element(L), m2.w, 1)));
    out.rough.assign(clamp(nt.b.mul(m2.y), 0.04, 1));
  };

  // splat: colour (x vertex colour), world normal, roughness — computed once in the colour node
  mat.colorNode = Fn(() => {
    const P = vW;
    const Nw = normalize(vN).toVar('terNw');
    surfSpecK.assign(0.35); // rough ground: little sky reflection, even at grazing angles
    // 4 grid vertices around the pixel, their materials and bilinear weights
    const gp = P.xz.sub(U.terGrid.xy).mul(U.terGrid.z);
    const f = fract(gp);
    const c0 = clamp(ivec2(floor(gp)), ivec2(0), ivec2(int(U.terGrid.w).sub(2))).toVar();
    const idOf = (o) => int(U.terIds.load(c0.add(ivec2(...o))).r.mul(255).add(0.5)).toVar();
    const i0 = idOf([0, 0]), i1 = idOf([1, 0]), i2 = idOf([0, 1]), i3 = idOf([1, 1]);
    // projection: top on gentle ground, triplanar on slopes
    const tri = Nw.y.lessThan(0.78).toVar();
    const bw0 = pow(abs(Nw), vec3(4));
    const bw = bw0.div(bw0.x.add(bw0.y).add(bw0.z)).toVar();
    const dist = length(P.sub(cameraPosition)).toVar();
    const far = select(tri, float(0), smoothstep(12, 90, dist)).toVar();
    const lay = (n) => ({ alb: vec4(0).toVar('ta' + n), nW: vec3(0).toVar('tn' + n), rough: float(1).toVar('tr' + n) });
    const l0 = lay(0), l1 = lay(1), l2 = lay(2), l3 = lay(3);
    const col = vec3(0).toVar(), nAcc = vec3(0).toVar(), rAcc = float(1).toVar();
    layer(i0, P, Nw, bw, tri, far, l0);
    // written out without arrays or loops: the generic 4-layer loop (local arrays indexed in a
    // loop) cost ~4.5 ms more per frame on Apple GPUs than this
    If(i0.equal(i1).and(i0.equal(i2)).and(i0.equal(i3)), () => {
      // inside a material (most pixels): one layer
      col.assign(l0.alb.rgb); nAcc.assign(l0.nW); rAcc.assign(l0.rough);
    }).Else(() => {
      // border: corners sharing a material add up, then the layers height-blend (the higher
      // texel, stone or tuft, wins near the border)
      const w0 = f.x.oneMinus().mul(f.y.oneMinus()).toVar(), w1 = f.x.mul(f.y.oneMinus()).toVar();
      const w2 = f.x.oneMinus().mul(f.y).toVar(), w3 = f.x.mul(f.y).toVar();
      If(i1.equal(i0), () => { w0.addAssign(w1); w1.assign(0); });
      If(i2.equal(i0), () => { w0.addAssign(w2); w2.assign(0); }).ElseIf(i2.equal(i1), () => { w1.addAssign(w2); w2.assign(0); });
      If(i3.equal(i0), () => { w0.addAssign(w3); w3.assign(0); }).ElseIf(i3.equal(i1), () => { w1.addAssign(w3); w3.assign(0); }).ElseIf(i3.equal(i2), () => { w2.addAssign(w3); w3.assign(0); });
      If(w1.greaterThan(0), () => { layer(i1, P, Nw, bw, tri, far, l1); });
      If(w2.greaterThan(0), () => { layer(i2, P, Nw, bw, tri, far, l2); });
      If(w3.greaterThan(0), () => { layer(i3, P, Nw, bw, tri, far, l3); });
      const h = (w, l) => select(w.greaterThan(0), w.add(l.alb.a.mul(0.55)), float(-1));
      const h0 = h(w0, l0).toVar(), h1 = h(w1, l1).toVar(), h2 = h(w2, l2).toVar(), h3 = h(w3, l3).toVar();
      const hmax = max(max(h0, h1), max(h2, h3));
      const b = (hh) => max(hh.sub(hmax).add(0.22), 0);
      const b0 = b(h0).toVar(), b1 = b(h1).toVar(), b2 = b(h2).toVar(), b3 = b(h3).toVar();
      const bs = max(b0.add(b1).add(b2).add(b3), 1e-4);
      col.assign(l0.alb.rgb.mul(b0).add(l1.alb.rgb.mul(b1)).add(l2.alb.rgb.mul(b2)).add(l3.alb.rgb.mul(b3)).div(bs));
      nAcc.assign(l0.nW.mul(b0).add(l1.nW.mul(b1)).add(l2.nW.mul(b2)).add(l3.nW.mul(b3)).div(bs));
      rAcc.assign(l0.rough.mul(b0).add(l1.rough.mul(b1)).add(l2.rough.mul(b2)).add(l3.rough.mul(b3)).div(bs));
    });
    // normal detail fades out with distance (mip noise), surfaces.normalScale from the environment
    const nk = SU.surfNormalScale.mul(SU.surfDetail).mul(float(1).sub(smoothstep(60, 250, dist)));
    terNormal.assign(normalize(Nw.add(nAcc.mul(nk))));
    terRough.assign(rAcc);
    return vec4(vCol.mul(col), 1);
  })();
  mat.roughnessNode = terRough;
  mat.normalNode = normalize(cameraViewMatrix.mul(vec4(terNormal, 0)).xyz);
  mat.userData.terrainIds = ids;
  return mat;
}

const terNormal = property('vec3', 'terN'), terRough = property('float', 'terRough');
