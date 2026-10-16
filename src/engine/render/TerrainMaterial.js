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
import { Fn, If, float, int, ivec2, vec2, vec3, vec4, max, abs, pow, mix, clamp, length, normalize, smoothstep, sign, select, uniformArray, renderGroup, texture, attribute, varying, positionLocal, normalLocal, modelWorldMatrix, cameraPosition, cameraViewMatrix, mat3 } from 'three/tsl';
import { TERRAIN_MATERIALS } from '../world/TerrainData.js';
import { surfRel, luma } from './Surfaces.js';
import { U, tex } from './tsl.js';
import { ST } from './Lighting.js';

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
  const arr = (a) => uniformArray(a, 'vec4').setGroup(renderGroup);
  const u = {
    terIds: tex(ids),
    terMat: arr(info), // rgb: palette colour (linear), a: layer
    terMat2: arr(info2), // x: uv per m, y: roughness scale, z: normal strength, w: chroma
    terMean: arr(means), // per layer: 1 / mean albedo, mean luminance
    terGrid: U(new THREE.Vector4(-terrain.half, -terrain.half, 1 / terrain.cell, terrain.res)), // world -> grid: x0, z0, 1 / cell, res
  };
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  mat.vertexColors = false;
  const vTerrW = varying(modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz, 'vTerrW');
  const vTerrN = varying(normalize(mat3(modelWorldMatrix).mul(normalLocal)), 'vTerrN');
  const vCol = varying(attribute('color', 'vec3'), 'vColor');

  // one layer: albedo (a = height) + normal (world) + roughness, top or triplanar projection,
  // near detail scale mixed with a large scale that breaks the tiling with distance. Two WGSL
  // functions (albedo, normal + roughness): each samples its own texture array only.
  const IN = [{ name: 'id', type: 'int' }, { name: 'P', type: 'vec3' }, { name: 'Nw', type: 'vec3' }, { name: 'bw', type: 'vec3' }, { name: 'tri', type: 'float' }, { name: 'far', type: 'float' }];
  const terAlb = Fn(([id, P, Nw, bw, tri, far]) => {
    const mi = u.terMat.element(id).toVar(), k = u.terMat2.element(id).x;
    const L = int(mi.a).toVar();
    const alb = vec4(0.0).toVar();
    If(tri.lessThan(0.5), () => {
      const uv = P.xz.mul(k).toVar();
      alb.assign(SU.terAlbedo.sample(uv).depth(L));
      If(far.greaterThan(0.0), () => {
        const a2 = SU.terAlbedo.sample(uv.mul(0.173).add(vec2(0.31, 0.77))).depth(L);
        alb.rgb.assign(mix(alb.rgb, a2.rgb, far.mul(0.55)));
      });
    }).Else(() => {
      alb.assign(SU.terAlbedo.sample(P.zy.mul(k)).depth(L).mul(bw.x).add(SU.terAlbedo.sample(P.xz.mul(k)).depth(L).mul(bw.y)).add(SU.terAlbedo.sample(P.xy.mul(k)).depth(L).mul(bw.z)));
    });
    alb.rgb.assign(mi.rgb.mul(surfRel(alb.rgb, u.terMean.element(L), u.terMat2.element(id).w, 1.0)));
    return alb;
  }).setLayout({ name: 'terAlbedo', type: 'vec4', inputs: IN });
  const terNrm = Fn(([id, P, Nw, bw, tri]) => {
    const m2 = u.terMat2.element(id).toVar();
    const L = int(u.terMat.element(id).a).toVar(), k = m2.x;
    const nW = vec3(0.0).toVar(), nt = vec4(0.0).toVar();
    If(tri.lessThan(0.5), () => {
      nt.assign(SU.terNormal.sample(P.xz.mul(k)).depth(L));
      const t = nt.xy.mul(2.0).sub(1.0).mul(m2.z);
      nW.assign(vec3(t.x, 0.0, t.y));
    }).Else(() => {
      const nx = SU.terNormal.sample(P.zy.mul(k)).depth(L).toVar(), ny = SU.terNormal.sample(P.xz.mul(k)).depth(L).toVar(), nz = SU.terNormal.sample(P.xy.mul(k)).depth(L).toVar();
      nt.assign(nx.mul(bw.x).add(ny.mul(bw.y)).add(nz.mul(bw.z)));
      const tx = nx.xy.mul(2.0).sub(1.0).mul(m2.z), ty = ny.xy.mul(2.0).sub(1.0).mul(m2.z), tz = nz.xy.mul(2.0).sub(1.0).mul(m2.z);
      nW.assign(vec3(0.0, tx.y, tx.x.mul(sign(Nw.x))).mul(bw.x).add(vec3(ty.x, 0.0, ty.y).mul(bw.y)).add(vec3(tz.x.mul(sign(Nw.z)), tz.y, 0.0).mul(bw.z)));
    });
    return vec4(nW, clamp(nt.b.mul(m2.y), 0.04, 1.0));
  }).setLayout({ name: 'terNormal', type: 'vec4', inputs: IN.slice(0, 5) });
  const layer = (id, P, Nw, bw, tri, far) => {
    const alb = terAlb(id, P, Nw, bw, tri, far).toVar();
    const nr = terNrm(id, P, Nw, bw, tri).toVar();
    return { alb, nW: nr.xyz, rough: nr.w };
  };

  mat.colorNode = Fn(() => {
    const Nw = normalize(vTerrN).toVar();
    const P = vTerrW;
    // 4 grid vertices around the pixel, their materials and bilinear weights
    const g = P.xz.sub(u.terGrid.xy).mul(u.terGrid.z).toVar();
    const f = g.fract().toVar();
    const c0 = ivec2(g.floor()).clamp(ivec2(0), ivec2(int(u.terGrid.w).sub(2))).toVar();
    const id = (o) => int(u.terIds.load(c0.add(ivec2(...o))).r.mul(255.0).add(0.5)).toVar();
    const i0 = id([0, 0]), i1 = id([1, 0]), i2 = id([0, 1]), i3 = id([1, 1]);
    // projection: top on gentle ground, triplanar on slopes
    const tri = select(Nw.y.lessThan(0.78), float(1.0), float(0.0)).toVar();
    const bw0 = pow(abs(Nw), vec3(4.0));
    const bw = bw0.div(bw0.x.add(bw0.y).add(bw0.z)).toVar();
    const dist = length(P.sub(cameraPosition)).toVar();
    const far = select(tri.greaterThan(0.5), float(0.0), smoothstep(12.0, 90.0, dist)).toVar();
    const col = vec3(0.0).toVar(), nAcc = vec3(0.0).toVar(), rAcc = float(1.0).toVar();
    const l0 = layer(i0, P, Nw, bw, tri, far);
    // Written out without arrays or loops: the generic 4-layer loop (local arrays indexed in a
    // loop) cost ~4.5 ms more per frame on Apple GPUs than this.
    If(i0.equal(i1).and(i0.equal(i2)).and(i0.equal(i3)), () => {
      // inside a material (most pixels): one layer
      col.assign(l0.alb.rgb); nAcc.assign(l0.nW); rAcc.assign(l0.rough);
    }).Else(() => {
      // border: corners sharing a material add up, then the layers height-blend (the higher
      // texel, stone or tuft, wins near the border)
      const w0 = f.x.oneMinus().mul(f.y.oneMinus()).toVar(), w1 = f.x.mul(f.y.oneMinus()).toVar();
      const w2 = f.x.oneMinus().mul(f.y).toVar(), w3 = f.x.mul(f.y).toVar();
      If(i1.equal(i0), () => { w0.addAssign(w1); w1.assign(0.0); });
      If(i2.equal(i0), () => { w0.addAssign(w2); w2.assign(0.0); }).ElseIf(i2.equal(i1), () => { w1.addAssign(w2); w2.assign(0.0); });
      If(i3.equal(i0), () => { w0.addAssign(w3); w3.assign(0.0); }).ElseIf(i3.equal(i1), () => { w1.addAssign(w3); w3.assign(0.0); }).ElseIf(i3.equal(i2), () => { w2.addAssign(w3); w3.assign(0.0); });
      const a1 = vec4(0.0).toVar(), a2 = vec4(0.0).toVar(), a3 = vec4(0.0).toVar();
      const n1 = vec3(0.0).toVar(), n2 = vec3(0.0).toVar(), n3 = vec3(0.0).toVar();
      const r1 = float(1.0).toVar(), r2 = float(1.0).toVar(), r3 = float(1.0).toVar();
      const one = (w, i, a, n, r) => If(w.greaterThan(0.0), () => { const l = layer(i, P, Nw, bw, tri, far); a.assign(l.alb); n.assign(l.nW); r.assign(l.rough); });
      one(w1, i1, a1, n1, r1);
      one(w2, i2, a2, n2, r2);
      one(w3, i3, a3, n3, r3);
      const h = (w, a) => select(w.greaterThan(0.0), w.add(a.a.mul(0.55)), float(-1.0));
      const h0 = h(w0, l0.alb).toVar(), h1 = h(w1, a1).toVar(), h2 = h(w2, a2).toVar(), h3 = h(w3, a3).toVar();
      const hmax = max(max(h0, h1), max(h2, h3)).toVar();
      const b = (x) => max(x.sub(hmax).add(0.22), 0.0).toVar();
      const b0 = b(h0), b1 = b(h1), b2 = b(h2), b3 = b(h3);
      const bs = max(b0.add(b1).add(b2).add(b3), 1e-4).toVar();
      col.assign(l0.alb.rgb.mul(b0).add(a1.rgb.mul(b1)).add(a2.rgb.mul(b2)).add(a3.rgb.mul(b3)).div(bs));
      nAcc.assign(l0.nW.mul(b0).add(n1.mul(b1)).add(n2.mul(b2)).add(n3.mul(b3)).div(bs));
      rAcc.assign(l0.rough.mul(b0).add(r1.mul(b1)).add(r2.mul(b2)).add(r3.mul(b3)).div(bs));
    });
    // normal detail fades out with distance (mip noise), surfaces.normalScale from the environment
    const nk = SU.surfNormalScale.mul(SU.surfDetail).mul(float(1.0).sub(smoothstep(60.0, 250.0, dist)));
    const tN = normalize(Nw.add(nAcc.mul(nk)));
    ST.normal.assign(normalize(cameraViewMatrix.mul(vec4(tN, 0.0)).xyz));
    ST.rough.assign(rAcc);
    return vec4(vCol.mul(col), 1.0);
  })();
  mat.normalNode = ST.normal;
  mat.roughnessNode = ST.rough;
  mat.mcSpecK = float(0.35); // rough ground: little sky reflection, even at grazing angles
  lighting.light(mat);
  mat.userData.terrainIds = ids;
  mat.mcTerrain = u; // debug / tools
  return mat;
}
