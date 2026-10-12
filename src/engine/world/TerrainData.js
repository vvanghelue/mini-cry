// Heightfield data: heights + painted material ids on a regular (res x res) vertex grid covering
// [-size/2, size/2] in x and z. Pure JS (runs in the browser and in the Node tools).
//
// The rendered mesh splits every grid quad along the same diagonal as heightAt(), so physics,
// raycasts and what you see agree exactly at LOD 0.
import { clamp, fbm, hash2, smoothstep, lerp } from '../math/random.js';

// Terrain materials (painted ids). 0 = automatic (chosen from height / slope / noise).
// color: authored sRGB-ish (linear = colour²): the vertex colours (GI bake, map) and the tint of
// the material's texture layer (textures.json terrain.materials, render/TerrainMaterial.js).
// roughness / normal: scale of the layer's roughness / normal map.
export const TERRAIN_MATERIALS = [
  { id: 0, name: 'auto', color: [0.5, 0.5, 0.5] },
  { id: 1, name: 'sand', color: [0.84, 0.76, 0.6] },
  { id: 2, name: 'wet_sand', color: [0.56, 0.49, 0.38], roughness: 0.55 },
  { id: 3, name: 'grass', color: [0.4, 0.48, 0.22] },
  { id: 4, name: 'jungle', color: [0.33, 0.35, 0.19] },
  { id: 5, name: 'dirt', color: [0.5, 0.37, 0.27] },
  { id: 6, name: 'rock', color: [0.46, 0.43, 0.39], normal: 1.3 },
  { id: 7, name: 'dark_rock', color: [0.25, 0.23, 0.22], normal: 1.3 },
  { id: 8, name: 'mud', color: [0.3, 0.25, 0.17], roughness: 0.6 },
  { id: 9, name: 'seabed', color: [0.76, 0.7, 0.52] },
  { id: 10, name: 'moss', color: [0.3, 0.37, 0.15] },
  { id: 11, name: 'ash', color: [0.27, 0.25, 0.24] },
  { id: 12, name: 'field', color: [0.5, 0.49, 0.27] },
  { id: 13, name: 'concrete', color: [0.55, 0.54, 0.5] },
];
export const MATERIAL_ID = Object.fromEntries(TERRAIN_MATERIALS.map((m) => [m.name, m.id]));

export class TerrainData {
  constructor({ size = 2048, res = 1025, seaLevel = 0 } = {}) {
    this.size = size;
    this.res = res;
    this.cell = size / (res - 1);
    this.half = size / 2;
    this.seaLevel = seaLevel;
    this.heights = new Float32Array(res * res);
    this.material = new Uint8Array(res * res);
    this.rivers = []; // [{ points: [[x, z, surfaceY], ...], width }]
    this.water = null; // coarse water-level grid (see buildWaterGrid)
    this.version = 0; // bumped on every edit (consumers re-sync)
  }

  // --- coordinates --------------------------------------------------------------------------
  /** world x -> continuous grid coordinate */
  gx(x) { return (x + this.half) / this.cell; }
  gz(z) { return (z + this.half) / this.cell; }
  wx(i) { return i * this.cell - this.half; }
  wz(j) { return j * this.cell - this.half; }
  idx(i, j) { return j * this.res + i; }
  h(i, j) {
    i = i < 0 ? 0 : i >= this.res ? this.res - 1 : i;
    j = j < 0 ? 0 : j >= this.res ? this.res - 1 : j;
    return this.heights[j * this.res + i];
  }

  /** Height at world (x, z), on the same triangles as the mesh (diagonal from (i+1, j) to (i, j+1)). */
  heightAt(x, z) {
    const fx = this.gx(x), fz = this.gz(z);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const h00 = this.h(i, j), h10 = this.h(i + 1, j), h01 = this.h(i, j + 1), h11 = this.h(i + 1, j + 1);
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  /** Face normal at (x, z) into out ({x, y, z}). */
  normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
    const fx = this.gx(x), fz = this.gz(z);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const c = this.cell;
    let dx, dz;
    if (u + v <= 1) {
      dx = this.h(i + 1, j) - this.h(i, j);
      dz = this.h(i, j + 1) - this.h(i, j);
    } else {
      dx = this.h(i + 1, j + 1) - this.h(i, j + 1);
      dz = this.h(i + 1, j + 1) - this.h(i + 1, j);
    }
    // n = (-dx/c, 1, -dz/c) normalized
    const nx = -dx / c, nz = -dz / c;
    const l = Math.hypot(nx, 1, nz);
    out.x = nx / l; out.y = 1 / l; out.z = nz / l;
    return out;
  }

  /** Smooth (bilinear) slope-aware normal at a grid vertex, for colouring. */
  vertexNormalY(i, j) {
    const c = this.cell;
    const dx = (this.h(i + 1, j) - this.h(i - 1, j)) / (2 * c);
    const dz = (this.h(i, j + 1) - this.h(i, j - 1)) / (2 * c);
    return 1 / Math.hypot(dx, 1, dz);
  }

  inBounds(x, z) { return Math.abs(x) < this.half && Math.abs(z) < this.half; }

  // --- water --------------------------------------------------------------------------------
  /** Coarse grid of water surface heights (sea level, rivers, ponds), 4 m cells. */
  buildWaterGrid(step = 4) {
    const n = Math.floor(this.size / step) + 1;
    const g = new Float32Array(n * n).fill(-Infinity);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) g[j * n + i] = this.seaLevel;
    for (const r of this.rivers) {
      const pts = r.points;
      const reach = r.width * 0.5 + step * 2;
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az, ay] = pts[k], [bx, bz, by] = pts[k + 1];
        const minI = Math.floor((Math.min(ax, bx) - reach + this.half) / step), maxI = Math.ceil((Math.max(ax, bx) + reach + this.half) / step);
        const minJ = Math.floor((Math.min(az, bz) - reach + this.half) / step), maxJ = Math.ceil((Math.max(az, bz) + reach + this.half) / step);
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
        for (let j = Math.max(0, minJ); j <= Math.min(n - 1, maxJ); j++) {
          for (let i = Math.max(0, minI); i <= Math.min(n - 1, maxI); i++) {
            const x = i * step - this.half, z = j * step - this.half;
            const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
            const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
            if (d > r.width * 0.5 + step) continue;
            const y = ay + (by - ay) * t;
            if (y > g[j * n + i]) g[j * n + i] = y;
          }
        }
      }
    }
    this.water = { step, n, g };
    return this.water;
  }

  /** Water surface height at (x, z) (-Infinity where there is none above the sea). */
  waterLevelAt(x, z) {
    const w = this.water;
    if (!w) return this.seaLevel;
    const fx = (x + this.half) / w.step, fz = (z + this.half) / w.step;
    const i = clamp(Math.round(fx), 0, w.n - 1), j = clamp(Math.round(fz), 0, w.n - 1);
    return w.g[j * w.n + i];
  }

  /** Depth of water above the ground at (x, z) (<= 0 when dry). */
  waterDepth(x, z) {
    return this.waterLevelAt(x, z) - this.heightAt(x, z);
  }

  // --- colours ------------------------------------------------------------------------------
  /** Automatic material at a vertex (used where the painted id is 0). */
  autoMaterial(i, j) {
    const h = this.heights[j * this.res + i];
    const ny = this.vertexNormalY(i, j);
    const x = this.wx(i), z = this.wz(j);
    const n = fbm(x / 40, z / 40, 2, 7);
    const wl = this.waterLevelAt(x, z);
    if (h < wl - 0.6) return wl > this.seaLevel + 0.5 ? 8 : 9; // river bed / seabed
    if (ny < 0.72) return h > 120 ? 7 : 6; // cliffs
    if (h < wl + 0.5) return 2;
    if (h < this.seaLevel + 3.0 + n * 1.2) return 1; // beach
    if (h > 150) return ny < 0.85 ? 7 : 11; // volcano top
    if (ny < 0.84) return 10; // steep: moss
    if (h > 60 + n * 20) return 3; // highland grass
    return n > 0.25 ? 3 : 4; // jungle floor with grass patches
  }

  materialAt(i, j) {
    const m = this.material[j * this.res + i];
    return m || this.autoMaterial(i, j);
  }

  /** materialAt, cached per vertex (the terrain material id texture); filled by the colour worker. */
  resolvedMaterial(i, j) {
    const n = this.res * this.res;
    if (!this._mc || this._mc.length !== n) this._mc = new Uint8Array(n);
    const k = j * this.res + i;
    return this._mc[k] || (this._mc[k] = this.materialAt(i, j));
  }

  /** Vertex tint (linear RGB): the vertex colour without the material colour = the per-vertex
   *  variation and underwater darkening the textured terrain multiplies its layers by. */
  vertexTint(i, j, out, o) {
    this.vertexColor(i, j, out, o);
    const c = TERRAIN_MATERIALS[this.resolvedMaterial(i, j)].color;
    for (let k = 0; k < 3; k++) out[o + k] = Math.min(2, out[o + k] / Math.max(1e-3, c[k] * c[k]));
  }

  materialAtWorld(x, z) {
    const i = clamp(Math.round(this.gx(x)), 0, this.res - 1), j = clamp(Math.round(this.gz(z)), 0, this.res - 1);
    return this.materialAt(i, j);
  }

  /**
   * Vertex colour (linear RGB) into out[o..o+2]: material colour with some per-vertex variation.
   * Cached per vertex (3 bytes + valid flag); edits call invalidateColors(rect).
   */
  vertexColor(i, j, out, o) {
    const n = this.res * this.res;
    if (!this._cc || this._cc.length !== n * 4) this._cc = new Uint8Array(n * 4);
    const k4 = (j * this.res + i) * 4, cc = this._cc;
    if (cc[k4 + 3]) {
      out[o] = (cc[k4] / 255) ** 2; out[o + 1] = (cc[k4 + 1] / 255) ** 2; out[o + 2] = (cc[k4 + 2] / 255) ** 2;
      return;
    }
    this._vertexColor(i, j, out, o);
    // clamp: bright sand can exceed 1.0, and 256 would wrap to 0 in the byte cache (cyan sand)
    for (let c = 0; c < 3; c++) { out[o + c] = Math.min(1, out[o + c]); cc[k4 + c] = Math.round(Math.sqrt(out[o + c]) * 255); }
    cc[k4 + 3] = 1;
  }

  /** Fill the colour cache in a worker (browser only). Resolves when done; edits made meanwhile win. */
  precomputeColors() {
    if (typeof Worker === 'undefined') return Promise.resolve();
    return new Promise((resolve) => {
      const w = new Worker(new URL('./TerrainColorWorker.js', import.meta.url), { type: 'module' });
      const version = this.version;
      w.onmessage = (ev) => {
        if (this.version === version) { this._cc = ev.data.cache; this._mc = ev.data.materials; }
        w.terminate();
        resolve();
      };
      w.onerror = () => { w.terminate(); resolve(); };
      w.postMessage({ size: this.size, res: this.res, seaLevel: this.seaLevel, heights: this.heights, material: this.material, rivers: this.rivers });
    });
  }

  invalidateColors(rect) {
    if (!this._cc) return;
    const i0 = Math.max(0, (rect?.i0 ?? 0) - 2), i1 = Math.min(this.res - 1, (rect?.i1 ?? this.res - 1) + 2);
    const j0 = Math.max(0, (rect?.j0 ?? 0) - 2), j1 = Math.min(this.res - 1, (rect?.j1 ?? this.res - 1) + 2);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this._cc[(j * this.res + i) * 4 + 3] = 0;
    if (this._mc) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this._mc[j * this.res + i] = 0;
  }

  _vertexColor(i, j, out, o) {
    const m = this.materialAt(i, j);
    const c = TERRAIN_MATERIALS[m].color;
    const x = this.wx(i), z = this.wz(j);
    const k = 0.93 + hash2(i, j, 11) * 0.08 + fbm(x / 23, z / 23, 2, 3) * 0.1 + fbm(x / 90, z / 90, 2, 5) * 0.08;
    let r = c[0] * k, g = c[1] * k, b = c[2] * k;
    // darken underwater ground slightly with depth (caustic-free cheap look)
    const h = this.heights[j * this.res + i];
    if (h < this.seaLevel) {
      const d = smoothstep(0, 25, this.seaLevel - h);
      r = lerp(r, r * 0.55, d); g = lerp(g, g * 0.7, d); b = lerp(b, b * 0.8, d);
    }
    // srgb-ish authoring -> linear
    out[o] = r * r; out[o + 1] = g * g; out[o + 2] = b * b;
  }

  // --- editing ------------------------------------------------------------------------------
  /** Iterate grid vertices within radius of (x, z): cb(i, j, weight 0..1, dist). Returns the dirty rect. */
  brush(x, z, radius, cb, falloff = 0.5) {
    const r = radius / this.cell;
    const ci = this.gx(x), cj = this.gz(z);
    const i0 = Math.max(0, Math.floor(ci - r)), i1 = Math.min(this.res - 1, Math.ceil(ci + r));
    const j0 = Math.max(0, Math.floor(cj - r)), j1 = Math.min(this.res - 1, Math.ceil(cj + r));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - ci, j - cj) / r;
        if (d > 1) continue;
        const w = d < 1 - falloff ? 1 : smoothstep(1, 1 - falloff, d);
        cb(i, j, w, d * radius);
      }
    }
    this.version++;
    this.invalidateColors({ i0, i1, j0, j1 });
    return { i0, i1, j0, j1 };
  }

  /** Sculpt ops used by the editor and the CLI. strength in metres (per application). */
  sculpt(op, x, z, radius, strength = 1, opts = {}) {
    const H = this.heights, res = this.res;
    switch (op) {
      case 'raise':
        return this.brush(x, z, radius, (i, j, w) => { H[j * res + i] += strength * w; }, opts.falloff);
      case 'lower':
        return this.brush(x, z, radius, (i, j, w) => { H[j * res + i] -= strength * w; }, opts.falloff);
      case 'flatten': {
        const target = opts.height ?? this.heightAt(x, z);
        const k = clamp(strength, 0, 1);
        return this.brush(x, z, radius, (i, j, w) => { const p = j * res + i; H[p] += (target - H[p]) * w * k; }, opts.falloff);
      }
      case 'smooth': {
        const k = clamp(strength, 0, 1);
        const copy = new Map();
        this.brush(x, z, radius, (i, j) => {
          const avg = (this.h(i - 1, j) + this.h(i + 1, j) + this.h(i, j - 1) + this.h(i, j + 1) + this.h(i, j) * 2) / 6;
          copy.set(j * res + i, avg);
        }, opts.falloff);
        return this.brush(x, z, radius, (i, j, w) => { const p = j * res + i; H[p] += (copy.get(p) - H[p]) * w * k; }, opts.falloff);
      }
      case 'noise':
        return this.brush(x, z, radius, (i, j, w) => {
          H[j * res + i] += fbm(this.wx(i) / 12, this.wz(j) / 12, 3, opts.seed ?? 1) * strength * w;
        }, opts.falloff);
      case 'paint': {
        const id = opts.material ?? 0;
        return this.brush(x, z, radius, (i, j, w) => { if (w > 0.35) this.material[j * res + i] = id; }, opts.falloff ?? 0.2);
      }
      default:
        throw new Error('unknown sculpt op ' + op);
    }
  }

  // --- serialization ------------------------------------------------------------------------
  /** { meta, heightBytes (Uint16 quantized), materialBytes } */
  encode() {
    let min = Infinity, max = -Infinity;
    for (const h of this.heights) { if (h < min) min = h; if (h > max) max = h; }
    min = Math.floor(min) - 1; max = Math.ceil(max) + 1;
    const q = new Uint16Array(this.heights.length);
    const k = 65535 / (max - min);
    for (let i = 0; i < q.length; i++) q[i] = Math.round((this.heights[i] - min) * k);
    return {
      meta: { size: this.size, res: this.res, seaLevel: this.seaLevel, minHeight: min, maxHeight: max, rivers: this.rivers },
      heightBytes: new Uint8Array(q.buffer),
      materialBytes: this.material,
    };
  }

  static decode(meta, heightBuf, materialBuf) {
    const t = new TerrainData({ size: meta.size, res: meta.res, seaLevel: meta.seaLevel ?? 0 });
    const q = new Uint16Array(heightBuf.buffer ? heightBuf.buffer.slice(heightBuf.byteOffset, heightBuf.byteOffset + heightBuf.byteLength) : heightBuf);
    const k = (meta.maxHeight - meta.minHeight) / 65535;
    for (let i = 0; i < q.length; i++) t.heights[i] = meta.minHeight + q[i] * k;
    if (materialBuf) t.material.set(new Uint8Array(materialBuf.buffer ? materialBuf.buffer.slice(materialBuf.byteOffset, materialBuf.byteOffset + materialBuf.byteLength) : materialBuf));
    t.rivers = meta.rivers ?? [];
    t.buildWaterGrid();
    return t;
  }
}
