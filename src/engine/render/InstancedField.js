// Generic sector-culled, LOD'd instance renderer (vegetation, static props).
//
// kinds:  [{ id, asset, variants, lods: [{ distance, quality }], castShadow (m), fade (bool), blend, shareVariantsFrom,
//           impostor: { cell } (the last LOD is a camera-facing impostor, render/Impostors.js) }]
// castShadow: the kind casts into the sun cascades up to the first one at least that wide (bushes:
// the near one; trees: all three), each LOD mesh only into the cascades it can reach (_castLayers);
// an impostor LOD through a shadow-only twin facing the sun (Impostors.casterMaterials).
// Instances are added with add(kindIndex, variant, matrix). They are bucketed in SECTOR m
// sectors; every frame the visible sectors (frustum + a ring around the camera so shadow casters
// behind it still cast) go to every LOD whose distance range (blend bands included) overlaps them,
// and when that changes the per-sector matrix blocks are concatenated into one InstancedMesh per
// (kind, variant, LOD). The exact LOD of each instance, and the dithered cross-fade between two
// LODs, are decided in the shader (render/LodFade.js).
import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYERS } from './layers.js';
import { syncBlocks, liveCount } from './InstanceBlocks.js';
import { lodRanges, setLodRange, lodMaterial } from './LodFade.js';
import { Impostors } from './Impostors.js';
import { InstancedBatch } from './Instancing.js';
import { U } from './tsl.js';
import { cloneMaterial } from './Lighting.js';

const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _box = new THREE.Box3(), _v = new THREE.Vector3();
const CASCADE_BITS = 0b111 << LAYERS.CASCADE;
const CAST_SLACK = 8; // m: crowns reaching into a cascade from an instance origin past its reach

// Sub-cells: within a sector, instances are sorted by SUB x SUB cells, and a LOD range that only
// partly covers a sector (a near LOD's ring cutting through it) takes the cells it overlaps instead
// of the whole sector: instances outside their LOD's range still run the whole vertex shader (they
// collapse there), in every pass (main view, 3 cascades, SSAO pre-pass) — 64 m sectors gave the
// trees' LOD 0 (the heaviest meshes) ~5x the instances in its range. Only for ranges ending within
// SUB_MAX m (LOD 0): each cell crossing a band rebuilds the blocks (CPU), worth it only there.
const SUB_MAX = 150;
const SUB_KEY = 2 ** 30; // block keys: (variant, sector) below, (variant, sector, cell) + SUB_KEY

export class InstancedField {
  /** bounds: the square the sectors cover ({ x0, z0, size }: the TerrainData); sub: cells per sector side (1: whole sectors only) */
  constructor({ name, assets, lighting, bounds, sector = 64, sub = 1, kinds }) {
    this.name = name;
    this.assets = assets;
    this.lighting = lighting;
    this.sector = sector;
    this.sub = sub;
    this.x0 = bounds.x0;
    this.z0 = bounds.z0;
    this.n = Math.ceil(bounds.size / sector);
    this.group = new THREE.Group();
    this.group.name = name;
    this.drawScale = 1;
    this.kinds = kinds.map((k, i) => this._makeKind(k, i));
    // the instances in flat arrays (over a million of them: no object per instance): `count`, then
    // per instance kind + variant (_kv), its matrix (_mat, 16 floats), lowest / highest y (_y), id
    this.count = 0;
    this._kv = new Uint16Array(0);
    this._mat = new Float32Array(0);
    this._y = new Float32Array(0);
    this._id = new Int32Array(0);
    this.dirty = true;
    this._lastKey = -1;
    this.stats = { instances: 0, meshes: 0, triangles: 0 };
  }

  _makeKind(k, ki) {
    const lods = k.lods?.length ? k.lods : [{ distance: 300, quality: 1 }];
    const kind = { def: k, index: ki, lods, maxDist: lods[lods.length - 1].distance, variants: [], height: 1 };
    if (k.empty) { kind.variants = Array.from({ length: k.variants ?? 1 }, () => ({ meshes: [] })); kind.maxDist = 0; return kind; }
    const fade = k.fade ?? kind.maxDist < 160;
    kind.ranges = lodRanges(lods, { blend: k.blend, shrink: fade });
    // the last LOD as an impostor, baked from each variant's build at the quality of the LOD before
    // it (same crown volumes on both sides of the cross-fade; bakeImpostors)
    const impLod = k.impostor && lods.length > 1 ? lods.length - 1 : -1;
    kind.impLod = impLod;
    if (impLod >= 0) {
      const builds = Array.from({ length: k.variants ?? 1 }, (_, v) => this.assets.build(k.asset, { quality: lods[impLod - 1].quality ?? 1, variant: v }));
      kind.impostor = new Impostors(this.lighting, builds, { cell: k.impostor.cell ?? 64 });
      this.unbaked = true;
    }
    for (let v = 0; v < (k.variants ?? 1); v++) {
      const meshes = lods.map((lod, li) => {
        // far LODs (from `shareVariantsFrom`, default LOD 2): every variant draws with variant 0's
        // mesh (variations don't read at distance). LOD 1 keeps them: a cross-fade between two
        // different variants would show two ghost trees.
        if (v > 0 && li >= (k.shareVariantsFrom ?? 2)) return kind.variants[0].meshes[li];
        let geo, mat, tris;
        if (li === impLod) {
          geo = kind.impostor.geometry;
          mat = kind.impostor.materials[v];
          tris = kind.impostor.triangles;
        } else {
          const b = this.assets.build(k.asset, { quality: lod.quality ?? 1, variant: v });
          kind.height = Math.max(kind.height, b.bounds.max.y);
          kind.radius = Math.max(kind.radius ?? 0, b.geometry.boundingSphere.radius);
          geo = indexedGeometry(b.geometry);
          mat = this.assets.material(b);
          tris = b.triangles;
          if (fade) { mat = fadeMaterial(mat, this.lighting, kind.maxDist); kind.fadeRange = mat.mcFadeRange; }
        }
        const mesh = new InstancedBatch(geo, lodMaterial(mat, this.lighting), 16);
        setLodRange(mesh, kind.ranges[li]);
        // may discard (bands): after the opaque world, for tile GPUs' hidden surface removal; near
        // LODs first, so the far instances they hide fail the early depth test
        mesh.renderOrder = 1 + li * 0.01;
        mesh.matrixAutoUpdate = false;
        // sun cascades: _castLayers; the SSAO depth pre-pass takes the LODs starting within castShadow
        const start = li ? lods[li - 1].distance : 0;
        mesh.layers.set(LAYERS.DETAIL);
        if (k.castShadow && start < k.castShadow && li !== impLod) mesh.layers.enable(LAYERS.OCCLUDER);
        mesh.name = `${this.name}_${k.id}_${v}_lod${li}`;
        mesh.userData.lod = li;
        mesh.userData.capacity = 16;
        mesh.userData.tris = tris;
        this.group.add(mesh);
        if (li === impLod) {
          // shadow-only twin: the impostors as cards facing the sun, in the cascades only (it shares
          // the instance buffer and count: InstancedBatch.shareInstances)
          const c = new InstancedBatch(kind.impostor.geometry, kind.impostor.casterMaterials[v], 1);
          c.shareInstances(mesh);
          c.userData.lodRange = mesh.userData.lodRange;
          c.matrixAutoUpdate = false;
          c.layers.mask = CASCADE_BITS; // _castLayers narrows it; until then the loading warm-up compiles it
          c.raycast = () => {};
          c.renderOrder = mesh.renderOrder;
          c.name = `${mesh.name}_caster`;
          mesh.userData.caster = c;
          this.group.add(c);
        }
        return mesh;
      });
      kind.variants.push({ meshes });
    }
    return kind;
  }

  clear() { this.count = 0; this.dirty = true; }

  /** Room for n instances (avoids growing the arrays while a known number is added). */
  reserve(n) {
    if (n <= this._id.length) return;
    const grow = (a, k) => { const b = new a.constructor(n * k); b.set(a.subarray(0, this.count * k)); return b; };
    this._kv = grow(this._kv, 2);
    this._mat = grow(this._mat, 16);
    this._y = grow(this._y, 2);
    this._id = grow(this._id, 1);
  }

  add(kind, variant, matrix, id) {
    const k = this.kinds[kind];
    const m = matrix.elements ?? matrix;
    const y = m[13], s = Math.hypot(m[4], m[5], m[6]);
    const i = this.count;
    if (i >= this._id.length) this.reserve(Math.max(1024, i * 2));
    this._kv[i * 2] = kind;
    this._kv[i * 2 + 1] = Math.min(variant, k.variants.length - 1);
    this._mat.set(m, i * 16);
    this._y[i * 2] = y - 1;
    this._y[i * 2 + 1] = y + k.height * s;
    this._id[i] = id ?? -1;
    this.count = i + 1;
    this.dirty = true;
  }

  _bucket() {
    const n = this.n, x0 = this.x0, z0 = this.z0, S = this.sector, SB = this.sub, SS = SB * SB, C = S / SB;
    const N = this.count, kv = this._kv, mat = this._mat, iy = this._y;
    // instances sorted by sector, then by cell within it: a sector is one block of matrices, a cell
    // a block inside it (offsets: per sector, cellOffsets: per cell). The kinds this field never
    // holds (`empty`: the other field's) get no arrays (nothing reads them: they have no ranges).
    const live = this.kinds.filter((k) => !k.def.empty);
    for (const k of live) for (const v of k.variants) { v.counts = new Int32Array(n * n * SS); }
    const cellOf = new Int32Array(N);
    this.sectorY = new Float32Array(n * n * 2).fill(NaN);
    const yy = this.sectorY;
    for (let i = 0; i < N; i++) {
      const gx = Math.min(n * SB - 1, Math.max(0, Math.floor((mat[i * 16 + 12] - x0) / C)));
      const gz = Math.min(n * SB - 1, Math.max(0, Math.floor((mat[i * 16 + 14] - z0) / C)));
      const sec = Math.floor(gz / SB) * n + Math.floor(gx / SB);
      cellOf[i] = sec * SS + (gz % SB) * SB + (gx % SB);
      this.kinds[kv[i * 2]].variants[kv[i * 2 + 1]].counts[cellOf[i]]++;
      if (!(yy[sec * 2] <= iy[i * 2])) yy[sec * 2] = iy[i * 2];
      if (!(yy[sec * 2 + 1] >= iy[i * 2 + 1])) yy[sec * 2 + 1] = iy[i * 2 + 1];
    }
    // the sectors with instances (the per-frame walk skips the empty ones)
    const occ = [];
    for (let sec = 0; sec < n * n; sec++) if (!Number.isNaN(this.sectorY[sec * 2])) occ.push(sec);
    this._occupied = Int32Array.from(occ);
    for (const k of live) {
      for (const v of k.variants) {
        const co = new Int32Array(n * n * SS + 1);
        for (let i = 0; i < n * n * SS; i++) co[i + 1] = co[i] + v.counts[i];
        const offs = new Int32Array(n * n + 1);
        for (let i = 0; i <= n * n; i++) offs[i] = co[i * SS];
        v.cellOffsets = co;
        v.offsets = offs;
        v.matrices = new Float32Array(offs[n * n] * 16);
        v.fill = v.counts.fill(0); // (the counts' array, reused as each cell's write cursor)
        v.counts = null;
      }
    }
    for (let i = 0; i < N; i++) {
      const v = this.kinds[kv[i * 2]].variants[kv[i * 2 + 1]];
      const c = cellOf[i];
      v.matrices.set(mat.subarray(i * 16, i * 16 + 16), (v.cellOffsets[c] + v.fill[c]++) * 16);
    }
    for (const k of live) for (const v of k.variants) v.fill = null;
    this.dirty = false;
    this._lastKey = -1;
    // offsets moved: every mesh is repacked on the next update
    for (const k of this.kinds) for (const v of k.variants) for (const m of v.meshes) { m.userData.repack = true; }
  }

  /** Render the impostor atlases (once the surface textures are loaded; World.load). */
  bakeImpostors(renderer) {
    for (const k of this.kinds) if (k.impostor && !k.impostor.baked) k.impostor.bake(renderer);
    this.unbaked = false;
  }

  /** Sun cascades each LOD mesh casts into (LAYERS.CASCADE + i). A kind casts into the cascades up
   *  to the first one at least as wide as its castShadow distance: past that one's border its shadow
   *  fades out across the blend band instead of popping at a LOD switch. A LOD mesh only goes into
   *  the cascades whose ground it can reach (SunShadows.reach; the depth passes switch LODs at the
   *  middle of the bands) — no vertex work for instances that can't land there. An impostor (a
   *  camera-facing card) casts through its sun-facing twin, into the last cascade only; where the
   *  last cascade's kinds turn into impostors is the sun's split (SunShadows.setCasterReach), or,
   *  with sun.impostorCasters off, where the shadow distance stops. */
  _castLayers() {
    const sun = this.lighting.sun, cs = sun.cascades, last = cs.length - 1;
    const reach = cs.map((c, i) => sun.reach(i) + CAST_SLACK);
    let stop = Infinity;
    for (const k of this.kinds) {
      if (!k.scaled) continue;
      const cast = k.def.castShadow ?? 0;
      let top = -1; // last cascade the kind casts into
      if (cast > 0) { top = cs.findIndex((c) => c.radius >= cast); if (top < 0) top = last; }
      for (const v of k.variants) for (const m of v.meshes) {
        const li = m.userData.lod, r = k.scaled[li], from = li ? (r[0] + r[1]) / 2 : 0;
        m.layers.mask &= ~CASCADE_BITS;
        if (li !== k.impLod) {
          for (let i = 0; i <= top; i++) if (from < reach[i]) m.layers.enable(LAYERS.CASCADE + i);
          continue;
        }
        // the impostor itself faces the camera: its sun-facing twin casts instead, into the last
        // cascade only (SunShadows: past the split, the shadow comes from that one alone)
        const caster = m.userData.caster;
        caster.layers.mask = 0;
        if (sun.impostorCasters && top === last && from < reach[last]) caster.layers.enable(LAYERS.CASCADE + last);
      }
      if (top === last && k.impLod > 0) stop = Math.min(stop, (k.scaled[k.impLod][0] + k.scaled[k.impLod][1]) / 2);
    }
    sun.setCasterReach(this.name, stop);
  }

  update(camera) {
    if (this.unbaked && this.lighting.surfaces.ready) this.bakeImpostors(this.lighting.renderer);
    if (this.dirty) this._bucket();
    const cp = camera.position;
    _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    // same camera as the sector choice below, so shader and CPU agree on every instance's LOD
    (this.lighting.uniforms.camPosW ??= { value: new THREE.Vector3() }).value.copy(cp);
    const n = this.n, wx0 = this.x0, wz0 = this.z0, S = this.sector, ds = this.drawScale;
    if (ds !== this._bandsDs) {
      // every LOD range bound of every kind: a sector only needs work when its near or far edge crosses one
      const t = new Set();
      for (const k of this.kinds) {
        if (!k.maxDist) continue;
        k.scaled = k.ranges.map((r) => r.map((x) => x * ds));
        for (const r of k.scaled) for (const x of r) if (x >= 0) t.add(x);
        for (const v of k.variants) for (const m of v.meshes) setLodRange(m, k.scaled[m.userData.lod]);
        k.fadeRange?.value.set(k.maxDist * ds * 0.75, k.maxDist * ds);
      }
      this._bands = Float32Array.from([...t].sort((a, b) => a - b));
      this._bandsDs = ds;
      this._lastKey = -1; // new ranges: every block again
    }
    // cascades of each LOD mesh: again when the cascades, the shadow distance, the draw scale or
    // the sun's elevation (how far the cascades stretch on the ground) change
    const sun = this.lighting.sun, ck = (this._castKey ??= []);
    let same = ck[0] === sun.version && ck[1] === ds;
    ck[0] = sun.version;
    ck[1] = ds;
    for (let i = 0; i < sun.cascades.length; i++) {
      const q = Math.round(sun.reach(i) / 4);
      same &&= ck[2 + i] === q;
      ck[2 + i] = q;
    }
    if (!same) this._castLayers();
    // a still camera (and nothing else changed): the same sectors and blocks as last frame
    const pm = _pm.elements, last = (this._lastPm ??= new Float32Array(16));
    let still = same;
    for (let i = 0; i < 16 && still; i++) still = Math.fround(pm[i]) === last[i];
    if (still && this._lastKey !== -1) return;
    last.set(pm);
    const bands = this._bands, SB = this.sub, C = S / SB;
    if (this._subBandsOf !== bands) { this._subBandsOf = bands; this._subBands = bands.filter((b) => b < SUB_MAX); }
    let maxDist = 0;
    for (const k of this.kinds) maxDist = Math.max(maxDist, k.maxDist * ds);
    const r = Math.ceil(maxDist / S) + 1;
    const ccx = Math.floor((cp.x - wx0) / S), ccz = Math.floor((cp.z - wz0) / S);
    const vis = (this._vis ??= []); // per visible sector: sector, near and far distances, cells slot (-1: none)
    vis.length = 0;
    this._nCells = 0;
    // each visible sector's signature: the bands its near and far edges fall in (+ its cells' bands
    // when a near LOD's ring cuts through it). Only the sectors whose signature changed, and those
    // that came into view or left it, have their blocks recomputed: moving, a few sectors cross a
    // band every frame, out of a thousand in view of the far LODs
    const full = this._lastKey === -1;
    const sigs = (this._sigs ??= new Map()), next = (this._sigsNext ??= new Map());
    const changed = (this._changedSecs ??= []);
    changed.length = 0;
    next.clear();
    const x1 = ccx + r, z1 = ccz + r, xa = ccx - r, za = ccz - r;
    // the occupied sectors to test: those of the window around the camera when it holds fewer
    // sectors than the whole occupied list (short-range fields over a big world), else that list
    let occ = this._occupied;
    const wx0c = Math.max(0, xa), wx1c = Math.min(n - 1, x1), wz0c = Math.max(0, za), wz1c = Math.min(n - 1, z1);
    const win = (wx1c - wx0c + 1) * (wz1c - wz0c + 1);
    if (wx1c >= wx0c && wz1c >= wz0c && win < occ.length) {
      if (!(this._win?.length >= win)) this._win = new Int32Array(win);
      const w = this._win, sy = this.sectorY;
      let m = 0;
      for (let cz = wz0c; cz <= wz1c; cz++) for (let cx = wx0c; cx <= wx1c; cx++) if (!Number.isNaN(sy[(cz * n + cx) * 2])) w[m++] = cz * n + cx;
      occ = w.subarray(0, m);
    }
    for (let q = 0; q < occ.length; q++) {
      const sec = occ[q], cz = (sec / n) | 0, cx = sec - cz * n;
      if (cx < xa || cx > x1 || cz < za || cz > z1) continue;
      const y0 = this.sectorY[sec * 2];
      const x0 = wx0 + cx * S, z0 = wz0 + cz * S;
      const dx = Math.max(0, x0 - cp.x, cp.x - (x0 + S)), dz = Math.max(0, z0 - cp.z, cp.z - (z0 + S));
      const d = Math.hypot(dx, dz);
      if (d > maxDist) continue;
      const fx = Math.max(cp.x - x0, x0 + S - cp.x), fz = Math.max(cp.z - z0, z0 + S - cp.z);
      const dFar = Math.hypot(fx, fz);
      if (d > 40) {
        _box.min.set(x0 - 8, y0, z0 - 8);
        _box.max.set(x0 + S + 8, this.sectorY[sec * 2 + 1], z0 + S + 8);
        if (!_frustum.intersectsBox(_box)) continue;
      }
      let b0 = 0, b1 = 0;
      while (b0 < bands.length && d >= bands[b0]) b0++;
      while (b1 < bands.length && dFar >= bands[b1]) b1++;
      let sig = b0 * 4096 + b1;
      // a sector cut by a near LOD band: its cells' distances (for the blocks below), and which
      // cells are on which side, in its signature
      let slot = -1;
      if (SB > 1 && b0 !== b1 && d < SUB_MAX) {
        const sb = this._subBands, cells = (this._cells ??= new Float32Array(1024 * 32));
        slot = this._nCells++;
        if (slot * 32 + 32 > cells.length) { this._cells = new Float32Array(cells.length * 2); this._cells.set(cells); }
        sig = `${sig}`;
        for (let c = 0; c < SB * SB; c++) {
          const [cd, cf] = cellDist(cp, x0 + (c % SB) * C, z0 + Math.floor(c / SB) * C, C);
          this._cells[slot * 32 + c * 2] = cd;
          this._cells[slot * 32 + c * 2 + 1] = cf;
          let c0 = 0, c1 = 0;
          while (c0 < sb.length && cd >= sb[c0]) c0++;
          while (c1 < sb.length && cf >= sb[c1]) c1++;
          sig += `,${c0 * 64 + c1}`;
        }
      }
      next.set(sec, sig);
      if (full || sigs.get(sec) !== sig) changed.push(sec, d, dFar, slot);
      vis.push(sec, d, dFar, slot);
    }
    for (const sec of sigs.keys()) if (!next.has(sec)) changed.push(sec, 0, 0, -2); // left the view
    this._sigs = next;
    this._sigsNext = sigs;
    this._lastKey = 0;
    if (!changed.length) return;
    // wanted (variant, sector) blocks per mesh: a changed sector's blocks out, its new ones in
    const nn = n * n, cells = this._cells, contrib = (this._contrib ??= new Map()); // sector -> [mesh, key, ...]
    const touched = (this._touched ??= new Set());
    touched.clear();
    if (full) {
      contrib.clear();
      for (const k of this.kinds) for (const v of k.variants) for (const m of v.meshes) { (m.userData.want ??= new Map()).clear(); (m.userData.changed ??= new Set()).clear(); touched.add(m); }
    }
    for (let i = 0; i < changed.length; i += 4) {
      const sec = changed[i], d = changed[i + 1], dFar = changed[i + 2], slot = changed[i + 3];
      const old = contrib.get(sec);
      if (old) {
        for (let j = 0; j < old.length; j += 2) { const u = old[j].userData; u.want.delete(old[j + 1]); u.changed.add(old[j + 1]); touched.add(old[j]); }
        contrib.delete(sec);
      }
      if (slot === -2) continue;
      let list = null;
      const put = (m, key, v) => {
        const u = m.userData;
        (u.want ??= new Map()).set(key, v);
        (u.changed ??= new Set()).add(key);
        touched.add(m);
        (list ??= []).push(m, key);
      };
      for (const k of this.kinds) {
        const ranges = k.scaled;
        if (!ranges) continue;
        for (let vi = 0; vi < k.variants.length; vi++) {
          const v = k.variants[vi];
          if (v.offsets[sec] === v.offsets[sec + 1]) continue;
          // 1 m of slack: float32 distances in the shader
          for (let li = 0; li < ranges.length; li++) {
            const r0 = ranges[li][0], r3 = ranges[li][3];
            if (dFar < r0 - 1 || d >= r3 + 1) continue;
            if (slot < 0 || r3 >= SUB_MAX || (d >= r0 - 1 && dFar < r3 + 1)) { put(v.meshes[li], vi * nn + sec, v); continue; }
            // the range cuts through the sector: its cells that overlap it
            const cell0 = sec * SB * SB;
            for (let c = 0; c < SB * SB; c++) {
              if (v.cellOffsets[cell0 + c] === v.cellOffsets[cell0 + c + 1]) continue;
              if (cells[slot * 32 + c * 2 + 1] >= r0 - 1 && cells[slot * 32 + c * 2] < r3 + 1) put(v.meshes[li], SUB_KEY + vi * nn * SB * SB + cell0 + c, v);
            }
          }
        }
      }
      if (list) contrib.set(sec, list);
    }
    const nc = nn * SB * SB;
    const range = (bk) => (bk >= SUB_KEY ? (bk - SUB_KEY) % nc : -1); // a cell's index, or -1: a whole sector
    const lenOf = (bk, v) => {
      const c = range(bk);
      if (c >= 0) return v.cellOffsets[c + 1] - v.cellOffsets[c];
      const sec = bk % nn;
      return v.offsets[sec + 1] - v.offsets[sec];
    };
    const write = (bk, v, dst, at) => {
      const c = range(bk);
      const [a, b] = c >= 0 ? [v.cellOffsets[c], v.cellOffsets[c + 1]] : [v.offsets[bk % nn], v.offsets[(bk % nn) + 1]];
      dst.set(v.matrices.subarray(a * 16, b * 16), at * 16);
    };
    for (const m of touched) {
      syncBlocks(m, m.userData.want, lenOf, write, full ? null : m.userData.changed);
      m.userData.changed.clear();
    }
    let total = 0, meshes = 0, tris = 0;
    const counted = (this._counted ??= new Set());
    counted.clear();
    for (const k of this.kinds) for (const v of k.variants) for (const m of v.meshes) {
      if (counted.has(m)) continue;
      counted.add(m);
      total += liveCount(m);
      tris += liveCount(m) * m.userData.tris;
      if (m.instances) meshes++;
    }
    this.stats.instances = total;
    this.stats.meshes = meshes;
    this.stats.triangles = tris;
  }

  /**
   * Draw statistics per (kind, LOD) for the camera of the last update (benchmarks, debug), over its
   * variant meshes: submitted = instances drawn (zeroed holes included: they still run the vertex
   * shader), inRange = instances inside the LOD's distance range (the others collapse in the vertex
   * shader), medianPx = median height on screen of those (`viewHeight` px viewport), tiny = how many
   * are under `tinyPx` px, vertexInvocations = sum of submitted x vertices, triangles = sum of
   * in-range x triangles (what is really rasterized).
   */
  lodStats(camera, viewHeight, tinyPx = 12) {
    const cp = camera.position, f = viewHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);
    const rows = [];
    for (const k of this.kinds) {
      if (!k.scaled) continue;
      for (let li = 0; li < k.lods.length; li++) {
        const meshes = new Set(k.variants.map((v) => v.meshes[li]).filter((m) => m?.instances));
        if (!meshes.size) continue;
        const [inA, , , outB] = k.scaled[li], px = [];
        const row = { kind: k.def.id, lod: li, meshes: meshes.size, submitted: 0, inRange: 0, tiny: 0, medianPx: 0, vertexInvocations: 0, triangles: 0, shadow: '' };
        const cascades = new Set();
        for (const m of meshes) {
          const a = m.instanceMatrix.array, g = m.geometry;
          const verts = g.attributes.position.count, tris = (g.index ? g.index.count : verts) / 3;
          let inRange = 0;
          for (let i = 0; i < m.instances; i++) {
            const o = i * 16, s = Math.hypot(a[o], a[o + 1], a[o + 2]);
            if (!s) continue;
            const d = Math.hypot(a[o + 12] - cp.x, a[o + 14] - cp.z);
            if (d < inA || d >= outB) continue;
            inRange++;
            px.push((k.height * s * f) / Math.max(d, 1));
          }
          row.submitted += m.instances;
          row.inRange += inRange;
          row.vertexInvocations += m.instances * verts;
          row.triangles += inRange * tris;
          for (let i = 0; i < 3; i++) if (m.layers.isEnabled(LAYERS.CASCADE + i)) cascades.add(i);
        }
        px.sort((a, b) => a - b);
        row.shadow = [...cascades].sort().map((i) => 'c' + i).join(' '); // the sun cascades it casts into
        row.medianPx = Math.round(px[px.length >> 1] ?? 0);
        row.tiny = px.filter((p) => p < tinyPx).length;
        rows.push(row);
      }
    }
    return rows;
  }

  /** Nearest item hit by a ray, using each kind's bounding sphere (editor picking). */
  pick(ray, maxDist = 2000) {
    let best = -1, bd = maxDist;
    const mat = this._mat;
    for (let i = 0; i < this.count; i++) {
      const k = this.kinds[this._kv[i * 2]];
      _v.set(mat[i * 16 + 12], mat[i * 16 + 13] + k.height * 0.5, mat[i * 16 + 14]);
      const r = Math.max(0.5, k.radius * 0.7);
      const t = ray.origin.distanceTo(_v);
      if (t - r > bd) continue;
      if (ray.distanceSqToPoint(_v) < r * r && t < bd) { bd = t; best = i; }
    }
    if (best < 0) return null;
    return { kind: this._kv[best * 2], variant: this._kv[best * 2 + 1], matrix: mat.slice(best * 16, best * 16 + 16), y0: this._y[best * 2], y1: this._y[best * 2 + 1], id: this._id[best] };
  }

  dispose() {
    const seen = new Set();
    for (const k of this.kinds) k.impostor?.dispose();
    for (const k of this.kinds) for (const v of k.variants) for (const m of v.meshes) {
      if (seen.has(m)) continue;
      seen.add(m);
      m.userData.caster?.removeFromParent();
      m.userData.caster?.disposeShared();
      m.disposeShared();
    }
    this.group.removeFromParent();
  }
}

/** Horizontal distances from the camera to the nearest and farthest points of a square cell. */
const _cd = [0, 0];
function cellDist(cp, x0, z0, size) {
  const dx = Math.max(0, x0 - cp.x, cp.x - (x0 + size)), dz = Math.max(0, z0 - cp.z, cp.z - (z0 + size));
  const fx = Math.max(cp.x - x0, x0 + size - cp.x), fz = Math.max(cp.z - z0, z0 + size - cp.z);
  _cd[0] = Math.hypot(dx, dz);
  _cd[1] = Math.hypot(fx, fz);
  return _cd;
}

/** Indexed copy of an asset build's geometry (cached): the builds are triangle soups, and the
 *  vertices they repeat (shared by neighbour triangles, both triangles of a leaf card) would be
 *  shaded again for every instance in every pass. Vertex work, not pixels, is most of the cost of
 *  distant vegetation. */
const _indexed = new WeakMap();
function indexedGeometry(g) {
  let ig = _indexed.get(g);
  if (!ig) {
    ig = mergeVertices(g);
    ig.computeBoundingBox();
    ig.computeBoundingSphere();
    _indexed.set(g, ig);
    // the asset library disposes its builds when an asset changes (editor)
    g.addEventListener('dispose', () => { ig.dispose(); _indexed.delete(g); });
  }
  return ig;
}

/** Clone of a lit material whose vertices shrink to nothing between 75% and 100% of maxDist. */
export function fadeMaterial(base, lighting, maxDist) {
  const cache = (fadeMaterial.cache ??= new Map());
  const key = base.uuid + '|' + maxDist;
  let m = cache.get(key);
  if (m) return m;
  m = cloneMaterial(base);
  const range = U(new THREE.Vector2(maxDist * 0.75, maxDist));
  lighting.setupVertex(m, { ...(base.mcOpts ?? {}), fadeRange: range });
  m.mcFadeRange = range;
  cache.set(key, m);
  return m;
}
