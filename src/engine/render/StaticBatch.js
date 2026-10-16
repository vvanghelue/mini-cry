// Static batching for placed props (buildings, crates, fences...): every 128 m sector merges
// its props into one mesh per (material variant, LOD) — textures come from arrays indexed by a
// per-vertex surface id (render/Surfaces.js), so this stays two draw calls for a whole village
// instead of one per asset type. Sectors are rebuilt lazily and only when their content
// changes (editor moves), LOD 1 (quality 0.5) replaces LOD 0 past `nearDist`.
import * as THREE from 'three';
import { LAYERS } from './layers.js';

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
      // one mesh per shared material (wind, leaves... are per-vertex data: Lighting.material)
      const key = this.assets.material(b).id;
      let list = byMat.get(key);
      if (!list) byMat.set(key, (list = { b, parts: [] }));
      list.parts.push({ b, matrix: it.matrix });
    }
    const meshes = [];
    for (const { b: proto, parts } of byMat.values()) {
      let n = 0;
      for (const p of parts) n += p.b.geometry.attributes.position.count;
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), wind = new Float32Array(n), emis = new Float32Array(n);
      const nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), surf = new Float32Array(n);
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
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.assets.material(proto));
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
    const cp = camera.position;
    let meshes = 0, tris = 0, sectors = 0, budget = 1;
    const near = this.nearDist * this.drawScale, far = this.farDist * this.drawScale, half = this.sector / 2;
    for (const s of this.sectors.values()) {
      const dx = Math.max(0, Math.abs(cp.x - s.center.x) - half), dz = Math.max(0, Math.abs(cp.z - s.center.z) - half);
      const d = Math.hypot(dx, dz);
      let lod = d < near ? 0 : d < far ? 1 : -1;
      // builds are spread over frames (1 per frame) so streaming never hitches; until a LOD is
      // ready the other one stands in. The first update builds everything in view at once.
      if (lod >= 0 && !s.meshes[lod] && (budget > 0 || !this._warm)) { this._build(s, lod); budget--; }
      if (lod >= 0 && !s.meshes[lod]) lod = s.meshes[1 - lod] ? 1 - lod : -1;
      for (let l = 0; l < 2; l++) for (const m of s.meshes[l] ?? []) {
        m.visible = l === lod;
        if (m.visible) { meshes++; tris += m.userData.tris; }
      }
      if (lod >= 0) sectors++;
    }
    this._warm = true;
    this.stats = { sectors, meshes, triangles: tris };
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
