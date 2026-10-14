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
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAYERS } from './layers.js';
import { syncBlocks, liveCount } from './InstanceBlocks.js';
import { lodRanges, lodGeometry, setLodRange, disposeLodGeometry, lodMaterial } from './LodFade.js';
import { Impostors } from './Impostors.js';

const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _box = new THREE.Box3(), _v = new THREE.Vector3();
const CASCADE_BITS = 0b111 << LAYERS.CASCADE;
const CAST_SLACK = 8; // m: crowns reaching into a cascade from an instance origin past its reach

export class InstancedField {
  constructor({ name, assets, lighting, worldSize, sector = 64, kinds }) {
    this.name = name;
    this.assets = assets;
    this.lighting = lighting;
    this.sector = sector;
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
          if (fade) { mat = fadeMaterial(mat, this.lighting, kind.maxDist); kind.fadeRange = mat.userData.fadeRange; }
        }
        const mesh = new THREE.InstancedMesh(lodGeometry(geo, kind.ranges[li]), lodMaterial(mat, this.lighting), 16);
        // may discard (bands): after the opaque world, for tile GPUs' hidden surface removal; near
        // LODs first, so the far instances they hide fail the early depth test
        mesh.renderOrder = 1 + li * 0.01;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
          // the instance buffer, synced in update; never disposed: that would free the buffer)
          const c = new THREE.InstancedMesh(mesh.geometry, kind.impostor.casterMaterials[v], 1);
          c.count = 0;
          c.frustumCulled = false;
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
    const n = this.n, half = this.half, S = this.sector;
    for (const k of this.kinds) for (const v of k.variants) { v.counts = new Int32Array(n * n); }
    const secOf = new Int32Array(this.items.length);
    this.sectorY = new Float32Array(n * n * 2).fill(NaN);
    this.items.forEach((it, i) => {
      const cx = Math.min(n - 1, Math.max(0, Math.floor((it.matrix[12] + half) / S)));
      const cz = Math.min(n - 1, Math.max(0, Math.floor((it.matrix[14] + half) / S)));
      const sec = cz * n + cx;
      secOf[i] = sec;
      this.kinds[it.kind].variants[it.variant].counts[sec]++;
      const yy = this.sectorY;
      if (!(yy[sec * 2] <= it.y0)) yy[sec * 2] = it.y0;
      if (!(yy[sec * 2 + 1] >= it.y1)) yy[sec * 2 + 1] = it.y1;
    });
    for (const k of this.kinds) {
      for (const v of k.variants) {
        const offs = new Int32Array(n * n + 1);
        for (let i = 0; i < n * n; i++) offs[i + 1] = offs[i] + v.counts[i];
        v.offsets = offs;
        v.matrices = new Float32Array(offs[n * n] * 16);
        v.fill = new Int32Array(n * n);
      }
    }
    this.items.forEach((it, i) => {
      const v = this.kinds[it.kind].variants[it.variant];
      const sec = secOf[i];
      v.matrices.set(it.matrix, (v.offsets[sec] + v.fill[sec]++) * 16);
    });
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
        for (const v of k.variants) for (const m of v.meshes) setLodRange(m.geometry, k.scaled[m.userData.lod]);
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
    const bands = this._bands;
    let maxDist = 0;
    for (const k of this.kinds) maxDist = Math.max(maxDist, k.maxDist * ds);
    const r = Math.ceil(maxDist / S) + 1;
    const ccx = Math.floor((cp.x + half) / S), ccz = Math.floor((cp.z + half) / S);
    const vis = this._vis ??= [];
    vis.length = 0;
    let key = 2166136261;
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
        vis.push(sec, d, dFar);
        key = Math.imul(Math.imul(key ^ sec, 16777619) ^ (b0 * 4096 + b1), 16777619);
      }
    }
    key = (key ^ vis.length) >>> 0;
    if (key === this._lastKey) return;
    this._lastKey = key;
    // wanted (variant, sector) blocks per mesh
    const nn = n * n;
    this._flushId = (this._flushId ?? 0) + 1;
    for (const k of this.kinds) {
      for (const v of k.variants) for (const m of v.meshes) {
        if (m.userData.flushed === this._flushId) continue;
        m.userData.flushed = this._flushId;
        (m.userData.want ??= new Map()).clear();
      }
      const ranges = k.scaled;
      if (!ranges) continue;
      k.variants.forEach((v, vi) => {
        for (let i = 0; i < vis.length; i += 3) {
          const sec = vis[i];
          if (v.offsets[sec] === v.offsets[sec + 1]) continue;
          const d = vis[i + 1], dFar = vis[i + 2];
          // 1 m of slack: float32 distances in the shader
          for (let li = 0; li < ranges.length; li++) {
            if (dFar >= ranges[li][0] - 1 && d < ranges[li][3] + 1) v.meshes[li].userData.want.set(vi * nn + sec, v);
          }
        }
      });
    }
    let total = 0, meshes = 0, tris = 0;
    this._flushId++;
    for (const k of this.kinds) for (const v of k.variants) for (const m of v.meshes) {
      if (m.userData.flushed === this._flushId) continue;
      m.userData.flushed = this._flushId;
      syncBlocks(m, m.userData.want, (bk, v) => { const sec = bk % nn; return v.offsets[sec + 1] - v.offsets[sec]; }, (bk, v, dst, at) => { const sec = bk % nn; dst.set(v.matrices.subarray(v.offsets[sec] * 16, v.offsets[sec + 1] * 16), at * 16); });
      const caster = m.userData.caster;
      if (caster) { caster.instanceMatrix = m.instanceMatrix; caster.count = m.count; }
      total += liveCount(m);
      tris += liveCount(m) * m.userData.tris;
      if (m.count) meshes++;
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
        const meshes = new Set(k.variants.map((v) => v.meshes[li]).filter((m) => m?.count));
        if (!meshes.size) continue;
        const [inA, , , outB] = k.scaled[li], px = [];
        const row = { kind: k.def.id, lod: li, meshes: meshes.size, submitted: 0, inRange: 0, tiny: 0, medianPx: 0, vertexInvocations: 0, triangles: 0, shadow: '' };
        const cascades = new Set();
        for (const m of meshes) {
          const a = m.instanceMatrix.array, g = m.geometry;
          const verts = g.attributes.position.count, tris = (g.index ? g.index.count : verts) / 3;
          let inRange = 0;
          for (let i = 0; i < m.count; i++) {
            const o = i * 16, s = Math.hypot(a[o], a[o + 1], a[o + 2]);
            if (!s) continue;
            const d = Math.hypot(a[o + 12] - cp.x, a[o + 14] - cp.z);
            if (d < inA || d >= outB) continue;
            inRange++;
            px.push((k.height * s * f) / Math.max(d, 1));
          }
          row.submitted += m.count;
          row.inRange += inRange;
          row.vertexInvocations += m.count * verts;
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
      m.dispose();
      disposeLodGeometry(m.geometry);
    }
    this.group.removeFromParent();
  }
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
  m = base.clone();
  const prev = base.onBeforeCompile;
  const camU = (lighting.uniforms.camPosW ??= { value: new THREE.Vector3() });
  const range = { value: new THREE.Vector2(maxDist * 0.75, maxDist) };
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.camPosW = camU;
    sh.uniforms.fadeRange = range;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 camPosW;\nuniform vec2 fadeRange;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 fO = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          transformed *= 1.0 - smoothstep(fadeRange.x, fadeRange.y, distance(fO, camPosW));
        }`);
  };
  const pk = base.customProgramCacheKey.bind(base);
  m.customProgramCacheKey = () => pk() + '|fade';
  m.userData.fadeRange = range;
  cache.set(key, m);
  return m;
}
