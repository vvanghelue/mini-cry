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
  /** sub: cells per sector side (1: whole sectors only) */
  constructor({ name, assets, lighting, worldSize, sector = 64, sub = 1, kinds }) {
    this.name = name;
    this.assets = assets;
    this.lighting = lighting;
    this.sector = sector;
    this.sub = sub;
    this.half = worldSize / 2;
    this.n = Math.ceil(worldSize / sector);
    this.group = new THREE.Group();
    this.group.name = name;
    this.drawScale = 1;
    this.kinds = kinds.map((k, i) => this._makeKind(k, i));
    this.items = []; // { kind, variant, matrix: Float32Array(16), y0, y1, id }
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

  clear() { this.items.length = 0; this.dirty = true; }

  add(kind, variant, matrix, id) {
    const k = this.kinds[kind];
    const m = matrix.elements ?? matrix;
    const y = m[13], s = Math.hypot(m[4], m[5], m[6]);
    this.items.push({ kind, variant: Math.min(variant, k.variants.length - 1), matrix: Float32Array.from(m), y0: y - 1, y1: y + k.height * s, id });
    this.dirty = true;
  }

  _bucket() {
    const n = this.n, half = this.half, S = this.sector, SB = this.sub, SS = SB * SB, C = S / SB;
    // instances sorted by sector, then by cell within it: a sector is one block of matrices, a cell
    // a block inside it (offsets: per sector, cellOffsets: per cell)
    for (const k of this.kinds) for (const v of k.variants) { v.counts = new Int32Array(n * n * SS); }
    const cellOf = new Int32Array(this.items.length);
    this.sectorY = new Float32Array(n * n * 2).fill(NaN);
    this.items.forEach((it, i) => {
      const gx = Math.min(n * SB - 1, Math.max(0, Math.floor((it.matrix[12] + half) / C)));
      const gz = Math.min(n * SB - 1, Math.max(0, Math.floor((it.matrix[14] + half) / C)));
      const sec = Math.floor(gz / SB) * n + Math.floor(gx / SB);
      cellOf[i] = sec * SS + (gz % SB) * SB + (gx % SB);
      this.kinds[it.kind].variants[it.variant].counts[cellOf[i]]++;
      const yy = this.sectorY;
      if (!(yy[sec * 2] <= it.y0)) yy[sec * 2] = it.y0;
      if (!(yy[sec * 2 + 1] >= it.y1)) yy[sec * 2 + 1] = it.y1;
    });
    for (const k of this.kinds) {
      for (const v of k.variants) {
        const co = new Int32Array(n * n * SS + 1);
        for (let i = 0; i < n * n * SS; i++) co[i + 1] = co[i] + v.counts[i];
        const offs = new Int32Array(n * n + 1);
        for (let i = 0; i <= n * n; i++) offs[i] = co[i * SS];
        v.cellOffsets = co;
        v.offsets = offs;
        v.matrices = new Float32Array(offs[n * n] * 16);
        v.fill = new Int32Array(n * n * SS);
        v.counts = null;
      }
    }
    this.items.forEach((it, i) => {
      const v = this.kinds[it.kind].variants[it.variant];
      const c = cellOf[i];
      v.matrices.set(it.matrix, (v.cellOffsets[c] + v.fill[c]++) * 16);
    });
    for (const k of this.kinds) for (const v of k.variants) v.fill = null;
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
    const n = this.n, half = this.half, S = this.sector, ds = this.drawScale;
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
    const ccx = Math.floor((cp.x + half) / S), ccz = Math.floor((cp.z + half) / S);
    const vis = this._vis ??= []; // per visible sector: sector, near and far distances, cells slot (-1: none)
    vis.length = 0;
    this._nCells = 0;
    // key: the visible sectors and the bands their edges fall in; cellKey: the near LOD bands the
    // cells of the sectors cut by them fall in (when only that changes, only those LODs' blocks)
    let key = 2166136261, cellKey = 2166136261;
    for (let cz = Math.max(0, ccz - r); cz <= Math.min(n - 1, ccz + r); cz++) {
      for (let cx = Math.max(0, ccx - r); cx <= Math.min(n - 1, ccx + r); cx++) {
        const sec = cz * n + cx;
        const y0 = this.sectorY[sec * 2];
        if (Number.isNaN(y0)) continue;
        const x0 = cx * S - half, z0 = cz * S - half;
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
        // a sector cut by a near LOD band: its cells' distances (for the blocks below), and which
        // cells are on which side counts in the key too
        let slot = -1;
        if (SB > 1 && b0 !== b1 && d < SUB_MAX) {
          const sb = this._subBands, cells = (this._cells ??= new Float32Array(1024 * 32));
          slot = this._nCells++;
          if (slot * 32 + 32 > cells.length) { this._cells = new Float32Array(cells.length * 2); this._cells.set(cells); }
          for (let c = 0; c < SB * SB; c++) {
            const [cd, cf] = cellDist(cp, x0 + (c % SB) * C, z0 + Math.floor(c / SB) * C, C);
            this._cells[slot * 32 + c * 2] = cd;
            this._cells[slot * 32 + c * 2 + 1] = cf;
            let c0 = 0, c1 = 0;
            while (c0 < sb.length && cd >= sb[c0]) c0++;
            while (c1 < sb.length && cf >= sb[c1]) c1++;
            cellKey = Math.imul(cellKey ^ (sec * 16 + c) ^ ((c0 * 64 + c1) << 20), 16777619);
          }
        }
        vis.push(sec, d, dFar, slot);
        key = Math.imul(Math.imul(key ^ sec, 16777619) ^ (b0 * 4096 + b1), 16777619);
      }
    }
    key = (key ^ vis.length) >>> 0;
    cellKey >>>= 0;
    const full = key !== this._lastKey;
    if (!full && cellKey === this._lastCellKey) return;
    this._lastKey = key;
    this._lastCellKey = cellKey;
    // the LOD meshes to rebuild: all of them, or only those split into cells
    const redo = (k, li) => full || (k.scaled?.[li]?.[3] ?? Infinity) < SUB_MAX;
    // wanted (variant, sector) blocks per mesh
    const nn = n * n;
    this._flushId = (this._flushId ?? 0) + 1;
    for (const k of this.kinds) {
      for (const v of k.variants) for (const m of v.meshes) {
        if (m.userData.flushed === this._flushId || !redo(k, m.userData.lod)) continue;
        m.userData.flushed = this._flushId;
        (m.userData.want ??= new Map()).clear();
      }
      const ranges = k.scaled;
      if (!ranges) continue;
      const cells = this._cells;
      k.variants.forEach((v, vi) => {
        for (let i = 0; i < vis.length; i += 4) {
          const sec = vis[i];
          if (v.offsets[sec] === v.offsets[sec + 1]) continue;
          const d = vis[i + 1], dFar = vis[i + 2], slot = vis[i + 3];
          // 1 m of slack: float32 distances in the shader
          for (let li = 0; li < ranges.length; li++) {
            const [r0, , , r3] = ranges[li];
            if (dFar < r0 - 1 || d >= r3 + 1 || !redo(k, li)) continue;
            const want = v.meshes[li].userData.want;
            if (slot < 0 || r3 >= SUB_MAX || (d >= r0 - 1 && dFar < r3 + 1)) { want.set(vi * nn + sec, v); continue; }
            // the range cuts through the sector: its cells that overlap it
            const cell0 = sec * SB * SB;
            for (let c = 0; c < SB * SB; c++) {
              if (v.cellOffsets[cell0 + c] === v.cellOffsets[cell0 + c + 1]) continue;
              if (cells[slot * 32 + c * 2 + 1] >= r0 - 1 && cells[slot * 32 + c * 2] < r3 + 1) want.set(SUB_KEY + vi * nn * SB * SB + cell0 + c, v);
            }
          }
        }
      });
    }
    let total = 0, meshes = 0, tris = 0;
    this._flushId++;
    const nc = nn * SB * SB;
    const range = (bk) => (bk >= SUB_KEY ? (bk - SUB_KEY) % nc : -1); // a cell's index, or -1: a whole sector
    for (const k of this.kinds) for (const v of k.variants) for (const m of v.meshes) {
      if (m.userData.flushed === this._flushId) continue;
      m.userData.flushed = this._flushId;
      if (redo(k, m.userData.lod)) syncBlocks(m, m.userData.want, (bk, v) => {
        const c = range(bk);
        if (c >= 0) return v.cellOffsets[c + 1] - v.cellOffsets[c];
        const sec = bk % nn;
        return v.offsets[sec + 1] - v.offsets[sec];
      }, (bk, v, dst, at) => {
        const c = range(bk);
        const [a, b] = c >= 0 ? [v.cellOffsets[c], v.cellOffsets[c + 1]] : [v.offsets[bk % nn], v.offsets[(bk % nn) + 1]];
        dst.set(v.matrices.subarray(a * 16, b * 16), at * 16);
      });
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
    let best = null, bd = maxDist;
    for (const it of this.items) {
      const k = this.kinds[it.kind];
      _v.set(it.matrix[12], it.matrix[13] + k.height * 0.5, it.matrix[14]);
      const r = Math.max(0.5, k.radius * 0.7);
      const t = ray.origin.distanceTo(_v);
      if (t - r > bd) continue;
      if (ray.distanceSqToPoint(_v) < r * r && t < bd) { bd = t; best = it; }
    }
    return best;
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
