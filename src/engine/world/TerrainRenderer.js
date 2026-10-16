// Chunked heightfield renderer with distance LODs.
//
// The world is split into CHUNK x CHUNK m tiles. Each tile picks a LOD (vertex step 1, 2, 4, 8
// grid cells) from its distance to the camera; cracks between different LODs are hidden by
// skirts (a strip hanging down along each tile edge). Geometries are built on demand and cached
// per (tile, lod); an edit in the editor invalidates only the touched tiles.
// Smooth normals from the full-resolution heightfield (coarse LODs keep the fine shading), vertex
// colours = per-vertex tint; the textured splatting reads the material ids from a texture
// (render/TerrainMaterial.js).
import * as THREE from 'three';
import { LAYERS } from '../render/layers.js';
import { terrainMaterial } from '../render/TerrainMaterial.js';

const CHUNK = 256;
const LOD_STEPS = [1, 2, 4, 8, 16];

export class TerrainRenderer {
  constructor(terrain, lighting, { lodDistances = [160, 340, 700, 1100] } = {}) {
    this.terrain = terrain;
    this.lighting = lighting;
    this.lodDistances = lodDistances;
    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    this.material = terrainMaterial(lighting, terrain);
    this.idTex = this.material.userData.terrainIds;
    this.fillIds();
    const n = Math.round(terrain.size / CHUNK);
    this.n = n;
    this.cellsPerChunk = (terrain.res - 1) / n;
    this.indexCache = new Map();
    this.chunks = [];
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        // the real geometry comes with the first LOD (update); until then a stand-in with the same
        // attributes (WebGPU: the shader is built for the attributes the first geometry has)
        const mesh = new THREE.Mesh(placeholder(), this.material);
        mesh.matrixAutoUpdate = false;
        mesh.layers.set(LAYERS.STATIC);
        mesh.name = `terrain_${cx}_${cz}`;
        const chunk = { cx, cz, mesh, lod: -1, geos: [], cx0: cx * CHUNK - terrain.half + CHUNK / 2, cz0: cz * CHUNK - terrain.half + CHUNK / 2, minY: 0, maxY: 0 };
        mesh.userData.chunk = chunk;
        this.chunks.push(chunk);
        this.group.add(mesh);
      }
    }
    this.stats = { triangles: 0, built: 0 };
  }

  _indices(lod) {
    let idx = this.indexCache.get(lod);
    if (idx) return idx;
    const s = this.cellsPerChunk / LOD_STEPS[lod]; // quads per side
    const v = s + 1;
    const arr = [];
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        const a = j * v + i, b = a + 1, c = a + v, d = c + 1;
        arr.push(a, c, b, b, c, d);
      }
    }
    // skirts: 4 edges, each with its own row of dropped vertices appended after the grid
    const base = v * v;
    const edges = this._edgeOrder(v);
    edges.forEach((edge, e) => {
      const off = base + e * v;
      for (let k = 0; k < v - 1; k++) {
        const t0 = edge[k], t1 = edge[k + 1], b0 = off + k, b1 = off + k + 1;
        // two-sided so the skirt shows from any side
        arr.push(t0, b0, t1, t1, b0, b1, t0, t1, b0, t1, b1, b0);
      }
    });
    idx = new THREE.BufferAttribute(v * v + 4 * v > 65535 ? new Uint32Array(arr) : new Uint16Array(arr), 1);
    this.indexCache.set(lod, idx);
    return idx;
  }

  _edgeOrder(v) {
    const top = [], bottom = [], left = [], right = [];
    for (let k = 0; k < v; k++) {
      top.push(k);
      bottom.push((v - 1) * v + k);
      left.push(k * v);
      right.push(k * v + v - 1);
    }
    return [top, bottom, left, right];
  }

  _build(chunk, lod) {
    const t = this.terrain;
    const step = LOD_STEPS[lod];
    const s = this.cellsPerChunk / step;
    const v = s + 1;
    const i0 = chunk.cx * this.cellsPerChunk, j0 = chunk.cz * this.cellsPerChunk;
    const count = v * v + 4 * v;
    const pos = new Float32Array(count * 3);
    const color = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const c2 = 2 * t.cell;
    let minY = Infinity, maxY = -Infinity;
    for (let j = 0; j < v; j++) {
      for (let i = 0; i < v; i++) {
        const gi = i0 + i * step, gj = j0 + j * step;
        const o = (j * v + i) * 3;
        const h = t.heights[gj * t.res + gi];
        pos[o] = t.wx(gi); pos[o + 1] = h; pos[o + 2] = t.wz(gj);
        t.vertexTint(gi, gj, color, o);
        const nx = (t.h(gi - 1, gj) - t.h(gi + 1, gj)) / c2, nz = (t.h(gi, gj - 1) - t.h(gi, gj + 1)) / c2;
        const l = Math.hypot(nx, 1, nz);
        nrm[o] = nx / l; nrm[o + 1] = 1 / l; nrm[o + 2] = nz / l;
        if (h < minY) minY = h;
        if (h > maxY) maxY = h;
      }
    }
    const drop = 2 + step * 1.5;
    this._edgeOrder(v).forEach((edge, e) => {
      for (let k = 0; k < v; k++) {
        const src = edge[k] * 3, dst = (v * v + e * v + k) * 3;
        pos[dst] = pos[src]; pos[dst + 1] = pos[src + 1] - drop; pos[dst + 2] = pos[src + 2];
        color[dst] = color[src] * 0.7; color[dst + 1] = color[src + 1] * 0.7; color[dst + 2] = color[src + 2] * 0.7;
        nrm[dst] = nrm[src]; nrm[dst + 1] = nrm[src + 1]; nrm[dst + 2] = nrm[src + 2];
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(this._indices(lod));
    g.boundingBox = new THREE.Box3(new THREE.Vector3(pos[0], minY - drop, pos[2]), new THREE.Vector3(pos[0] + CHUNK, maxY, pos[2] + CHUNK));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    chunk.minY = minY; chunk.maxY = maxY;
    this.stats.built++;
    return g;
  }

  /** Pick LODs for the camera position. Call every frame (cheap: 256 distance checks). */
  update(camera) {
    const cp = camera.position;
    const [d0, d1, d2, d3] = this.lodDistances;
    let tris = 0;
    for (const c of this.chunks) {
      const dx = Math.max(0, Math.abs(cp.x - c.cx0) - CHUNK / 2);
      const dz = Math.max(0, Math.abs(cp.z - c.cz0) - CHUNK / 2);
      const dy = Math.max(0, cp.y - c.maxY);
      const d = Math.hypot(dx, dz, dy * 0.5);
      const lod = d < d0 ? 0 : d < d1 ? 1 : d < d2 ? 2 : d < d3 ? 3 : 4;
      if (lod !== c.lod) {
        c.lod = lod;
        c.geos[lod] ??= this._build(c, lod);
        c.mesh.geometry = c.geos[lod];
      }
      const s = this.cellsPerChunk / LOD_STEPS[lod];
      tris += s * s * 2;
    }
    this.stats.triangles = tris;
  }

  /** Material id per vertex -> the splatting texture (all of it, or a grid rect after an edit). */
  fillIds(rect) {
    const t = this.terrain, res = t.res, d = this.idTex.image.data;
    const i0 = Math.max(0, rect?.i0 ?? 0), i1 = Math.min(res - 1, rect?.i1 ?? res - 1);
    const j0 = Math.max(0, rect?.j0 ?? 0), j1 = Math.min(res - 1, rect?.j1 ?? res - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) d[j * res + i] = t.resolvedMaterial(i, j);
    this.idTex.needsUpdate = true;
  }

  /** Rebuild tiles overlapping a grid rect {i0, i1, j0, j1} (after sculpting / painting). */
  invalidate(rect) {
    this.fillIds(rect && { i0: rect.i0 - 3, i1: rect.i1 + 3, j0: rect.j0 - 3, j1: rect.j1 + 3 });
    const cpc = this.cellsPerChunk;
    const cx0 = Math.max(0, Math.floor((rect.i0 - 2) / cpc)), cx1 = Math.min(this.n - 1, Math.floor((rect.i1 + 2) / cpc));
    const cz0 = Math.max(0, Math.floor((rect.j0 - 2) / cpc)), cz1 = Math.min(this.n - 1, Math.floor((rect.j1 + 2) / cpc));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunks[cz * this.n + cx];
        for (const g of c.geos) g?.dispose();
        c.geos = [];
        c.lod = -1;
      }
    }
  }

  invalidateAll() {
    this.invalidate({ i0: 0, i1: this.terrain.res - 1, j0: 0, j1: this.terrain.res - 1 });
  }

  dispose() {
    for (const c of this.chunks) for (const g of c.geos) g?.dispose();
  }
}

let _placeholder = null;
/** One degenerate triangle with the attributes of a terrain chunk (shared, never disposed). */
function placeholder() {
  if (_placeholder) return _placeholder;
  const g = (_placeholder = new THREE.BufferGeometry());
  for (const k of ['position', 'color', 'normal']) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setIndex([0, 1, 2]);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return g;
}
