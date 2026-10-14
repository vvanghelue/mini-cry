// Static batching for placed props (buildings, crates, fences...): every 128 m sector merges
// its props into one mesh per (material variant, LOD) — textures come from arrays indexed by a
// per-vertex surface id (render/Surfaces.js), so this stays two draw calls for a whole village
// instead of one per asset type. Sectors are rebuilt lazily and only when their content
// changes (editor moves), LOD 1 (quality 0.5) replaces LOD 0 past `nearDist`, and fades out at
// `farDist`.
// Each prop cross-fades on its own like a vegetation instance (render/LodFade.js): its vertices
// carry its origin and LOD (`lodProp`), the LOD ranges are uniforms. A sector across a blend band
// draws both LODs with the dithered LOD material (each prop keeps the pixels of its LOD); a sector
// wholly inside one LOD's solid range draws it with the plain material (no discard: tile GPUs keep
// their hidden surface removal for the bulk of the props).
import * as THREE from 'three';
import { LAYERS } from './layers.js';
import { lodRanges, lodMaterial, lodUniforms } from './LodFade.js';

const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _n = new THREE.Matrix3();

export class StaticBatch {
  constructor({ name = 'StaticBatch', assets, lighting, worldSize, sector = 128, nearDist = 220, farDist = 1100 }) {
    this.name = name;
    this.assets = assets;
    this.lighting = lighting;
    this.sector = sector;
    this.half = worldSize / 2;
    this.n = Math.ceil(worldSize / sector);
    this.nearDist = nearDist;
    this.farDist = farDist;
    this.group = new THREE.Group();
    this.group.name = name;
    this.items = [];
    this.sectors = new Map(); // key -> { items, sig, meshes: [[lod0 meshes], [lod1 meshes]], built: [bool, bool] }
    this.drawScale = 1;
    this.stats = { sectors: 0, meshes: 0, triangles: 0 };
  }

  clear() { this.items = []; this._dirty = true; this._warm = false; }

  add(asset, matrix, id) {
    const m = Float32Array.from(matrix.elements ?? matrix);
    this.items.push({ asset, matrix: m, id });
    this._dirty = true;
  }

  _regroup() {
    this._dirty = false;
    const groups = new Map();
    for (const it of this.items) {
      const cx = Math.min(this.n - 1, Math.max(0, Math.floor((it.matrix[12] + this.half) / this.sector)));
      const cz = Math.min(this.n - 1, Math.max(0, Math.floor((it.matrix[14] + this.half) / this.sector)));
      const key = cz * this.n + cx;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(it);
    }
    // drop sectors that vanished or changed
    for (const [key, s] of this.sectors) {
      const g = groups.get(key);
      const sig = g ? signature(g) : '';
      if (sig !== s.sig) { this._disposeSector(s); this.sectors.delete(key); }
    }
    for (const [key, g] of groups) {
      if (this.sectors.has(key)) continue;
      const cx = key % this.n, cz = Math.floor(key / this.n);
      this.sectors.set(key, { key, items: g, sig: signature(g), meshes: [null, null], center: new THREE.Vector3((cx + 0.5) * this.sector - this.half, 0, (cz + 0.5) * this.sector - this.half) });
    }
  }

  _disposeSector(s) {
    for (const lod of s.meshes) for (const m of lod ?? []) { m.geometry.dispose(); m.removeFromParent(); }
  }

  /** Merge the sector's props at a LOD into one mesh per material variant. */
  _build(s, lod) {
    const q = lod === 0 ? 1 : 0.5;
    const byMat = new Map();
    for (const it of s.items) {
      let b;
      try { b = this.assets.build(it.asset, { quality: q }); } catch { continue; }
      const key = `${b.hasWind ? 'w' : ''}${b.hasEmissive ? 'e' : ''}${b.doubleSided ? 'd' : ''}${b.hasFoliage ? 'l' : ''}${b.hasCutout ? 'c' : ''}`;
      let list = byMat.get(key);
      if (!list) byMat.set(key, (list = { b, parts: [] }));
      list.parts.push({ b, matrix: it.matrix });
    }
    const L = lod + 2; // lodProp.z (> 1.5: a prop, render/LodFade.js)
    const meshes = [];
    for (const { b: proto, parts } of byMat.values()) {
      let n = 0;
      for (const p of parts) n += p.b.geometry.attributes.position.count;
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), wind = new Float32Array(n), emis = new Float32Array(n);
      const nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), surf = new Float32Array(n), lodP = new Float32Array(n * 3);
      let o = 0;
      for (const p of parts) {
        const g = p.b.geometry;
        const P = g.attributes.position.array, C = g.attributes.color.array, W = g.attributes.wind.array, E = g.attributes.emissive.array;
        _m.fromArray(p.matrix);
        const e = _m.elements;
        const cnt = g.attributes.position.count;
        for (let i = 0; i < cnt; i++) {
          const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
          pos[(o + i) * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
          pos[(o + i) * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          pos[(o + i) * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
        // normals follow the prop's rotation (their length flags leaves)
        const N = g.attributes.normal.array;
        _n.getNormalMatrix(_m);
        for (let i = 0; i < cnt; i++) { _v.fromArray(N, i * 3); const l = _v.length(); _v.applyMatrix3(_n).normalize().multiplyScalar(l).toArray(nrm, (o + i) * 3); }
        col.set(C, o * 3);
        wind.set(W, o);
        emis.set(E, o);
        uv.set(g.attributes.uv.array, o * 2);
        surf.set(g.attributes.surface.array, o);
        for (let i = 0; i < cnt; i++) { lodP[(o + i) * 3] = e[12]; lodP[(o + i) * 3 + 1] = e[14]; lodP[(o + i) * 3 + 2] = L; }
        o += cnt;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('surface', new THREE.BufferAttribute(surf, 1));
      geo.setAttribute('wind', new THREE.BufferAttribute(wind, 1));
      geo.setAttribute('emissive', new THREE.BufferAttribute(emis, 1));
      geo.setAttribute('lodProp', new THREE.BufferAttribute(lodP, 3));
      geo.computeBoundingSphere();
      const base = this.assets.material(proto);
      const mesh = new THREE.Mesh(geo, base);
      mesh.userData.baseMat = base;
      mesh.userData.lodMat = lodMaterial(base, this.lighting);
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYERS.STATIC);
      mesh.name = `${this.name}_${s.key}_lod${lod}`;
      mesh.userData.tris = n / 3;
      this.group.add(mesh);
      meshes.push(mesh);
    }
    s.meshes[lod] = meshes;
  }

  update(camera) {
    if (this._dirty) this._regroup();
    const cp = camera.position, ds = this.drawScale;
    // same camera as the sector choice below (the vegetation sets it too)
    lodUniforms(this.lighting.uniforms).camPosW.value.copy(cp);
    if (ds !== this._ds) {
      // [inA, inB, outA, outB] of LOD 0 and 1, blend bands as the vegetation's
      this._ds = ds;
      this.ranges = lodRanges([{ distance: this.nearDist }, { distance: this.farDist }]).map((r) => r.map((x) => x * ds));
      const U = lodUniforms(this.lighting.uniforms);
      U.propLod0.value.fromArray(this.ranges[0]);
      U.propLod1.value.fromArray(this.ranges[1]);
    }
    const R = this.ranges, half = this.sector / 2, pre = 30 * ds;
    let meshes = 0, tris = 0, sectors = 0, budget = 1;
    for (const s of this.sectors.values()) {
      const ax = Math.abs(cp.x - s.center.x), az = Math.abs(cp.z - s.center.z);
      // nearest / farthest prop origin possible in the sector (1 m of slack: float32 in the shader)
      const d = Math.hypot(Math.max(0, ax - half), Math.max(0, az - half)) - 1, dFar = Math.hypot(ax + half, az + half) + 1;
      const overlaps = (r, m = 0) => dFar >= r[0] - m && d < r[3] + m;
      // builds are spread over frames (1 per frame) so streaming never hitches, a little ahead of
      // need. The first update builds everything in view at once.
      for (let l = 0; l < 2; l++) if (overlaps(R[l], pre) && !s.meshes[l] && (budget > 0 || !this._warm)) { this._build(s, l); budget--; }
      // one LOD plainly when every prop is inside its solid range, else each LOD the sector
      // overlaps, dithered; a LOD not built yet: the other one stands in for the whole sector
      const solid = [0, 1].find((l) => (R[l][1] < 0 || d >= R[l][1]) && dFar < R[l][2]);
      let show = solid !== undefined ? [solid === 0, solid === 1] : [overlaps(R[0]), overlaps(R[1])];
      let dither = solid === undefined;
      if (show.some((v, l) => v && !s.meshes[l])) {
        const l = show[0] && s.meshes[0] ? 0 : show[1] && s.meshes[1] ? 1 : s.meshes[0] ? 0 : s.meshes[1] ? 1 : -1;
        show = [l === 0, l === 1];
        dither = false;
      }
      for (let l = 0; l < 2; l++) for (const m of s.meshes[l] ?? []) {
        m.visible = show[l];
        if (!m.visible) continue;
        m.material = dither ? m.userData.lodMat : m.userData.baseMat;
        // may discard: after the opaque world, near LOD first (as the vegetation)
        m.renderOrder = dither ? 1 + l * 0.01 : 0;
        meshes++;
        tris += m.userData.tris;
      }
      if (show[0] || show[1]) sectors++;
    }
    this._warm = true;
    this.stats = { sectors, meshes, triangles: tris };
  }

  /** The dithered LOD materials of every material the props use, both LODs (World.warmUp compiles them). */
  lodMaterials() {
    const out = new Set();
    for (const asset of new Set(this.items.map((it) => it.asset))) {
      for (const quality of [1, 0.5]) {
        let b;
        try { b = this.assets.build(asset, { quality }); } catch { continue; }
        out.add(lodMaterial(this.assets.material(b), this.lighting));
      }
    }
    return out;
  }

  /** Nearest prop whose bounding sphere the ray crosses (editor picking): { id, matrix } */
  pick(ray, maxDist = 2000) {
    let best = null, bd = maxDist;
    for (const it of this.items) {
      let b;
      try { b = this.assets.build(it.asset, { quality: 0.5 }); } catch { continue; }
      const sph = b.geometry.boundingSphere;
      _v.copy(sph.center).applyMatrix4(_m.fromArray(it.matrix));
      const r = Math.max(0.4, sph.radius * _m.getMaxScaleOnAxis() * 0.8);
      const t = ray.origin.distanceTo(_v);
      if (t - r > bd) continue;
      if (ray.distanceSqToPoint(_v) < r * r && t < bd) { bd = t; best = it; }
    }
    return best;
  }

  dispose() {
    for (const s of this.sectors.values()) this._disposeSector(s);
    this.sectors.clear();
    this.group.removeFromParent();
  }
}

function signature(items) {
  let s = '';
  for (const it of items) {
    s += it.asset + ':';
    for (let k = 0; k < 16; k++) s += Math.round(it.matrix[k] * 100) + ',';
  }
  return s;
}
