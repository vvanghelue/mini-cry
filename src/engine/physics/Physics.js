// Collision world: the heightfield + static shapes (yaw-oriented boxes, vertical cylinders,
// spheres) in a uniform spatial hash, plus a few dynamic shapes (vehicles, doors) checked
// linearly. Provides character collision (vertical cylinder vs world), "ground under me"
// queries (terrain or the top of a box you stand on) and raycasts (bullets, AI sight, camera).
//
// Shapes (world space):
//   { type: 'box', x, y, z, hx, hy, hz, yaw }   centre + half extents, rotated about Y
//   { type: 'cyl', x, z, y0, y1, r }
//   { type: 'sphere', x, y, z, r }
// Every shape may carry { owner, material } (owner: entity id / 'veg:<i>' ...).
const CELL = 8;
const D2R = Math.PI / 180;

export class Physics {
  constructor(terrain) {
    this.terrain = terrain;
    this.shapes = []; // id -> shape (null when removed)
    this.grid = new Map(); // cell key -> [ids]
    this.dynamic = new Set(); // ids not in the grid
    this.byOwner = new Map();
    this.queryId = 0;
    this.stamp = new Uint32Array(1024);
  }

  _key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }

  _bounds(s) {
    if (s.type === 'box') {
      const c = Math.abs(Math.cos(s.yaw ?? 0)), sn = Math.abs(Math.sin(s.yaw ?? 0));
      const ex = s.hx * c + s.hz * sn, ez = s.hx * sn + s.hz * c;
      return [s.x - ex, s.z - ez, s.x + ex, s.z + ez, s.y - s.hy, s.y + s.hy];
    }
    if (s.type === 'cyl') return [s.x - s.r, s.z - s.r, s.x + s.r, s.z + s.r, s.y0, s.y1];
    return [s.x - s.r, s.z - s.r, s.x + s.r, s.z + s.r, s.y - s.r, s.y + s.r];
  }

  add(shape, { dynamic = false } = {}) {
    const id = this.shapes.length;
    shape.id = id;
    const b = this._bounds(shape);
    shape.b = b;
    this.shapes.push(shape);
    if (id >= this.stamp.length) { const s = new Uint32Array(this.stamp.length * 2); s.set(this.stamp); this.stamp = s; }
    if (shape.owner !== undefined) {
      let l = this.byOwner.get(shape.owner);
      if (!l) this.byOwner.set(shape.owner, (l = []));
      l.push(id);
    }
    if (dynamic) { this.dynamic.add(id); return id; }
    for (let cx = Math.floor(b[0] / CELL); cx <= Math.floor(b[2] / CELL); cx++) {
      for (let cz = Math.floor(b[1] / CELL); cz <= Math.floor(b[3] / CELL); cz++) {
        const k = this._key(cx, cz);
        let l = this.grid.get(k);
        if (!l) this.grid.set(k, (l = []));
        l.push(id);
      }
    }
    return id;
  }

  /** Move a dynamic shape (vehicle...). */
  updateDynamic(id, props) {
    const s = this.shapes[id];
    Object.assign(s, props);
    s.b = this._bounds(s);
  }

  remove(id) {
    const s = this.shapes[id];
    if (!s) return;
    this.shapes[id] = null;
    this.dynamic.delete(id);
    if (!s.b) return;
    for (let cx = Math.floor(s.b[0] / CELL); cx <= Math.floor(s.b[2] / CELL); cx++) {
      for (let cz = Math.floor(s.b[1] / CELL); cz <= Math.floor(s.b[3] / CELL); cz++) {
        const l = this.grid.get(this._key(cx, cz));
        if (!l) continue;
        const i = l.indexOf(id);
        if (i >= 0) l.splice(i, 1);
      }
    }
  }

  removeOwner(owner) {
    for (const id of this.byOwner.get(owner) ?? []) this.remove(id);
    this.byOwner.delete(owner);
  }

  clearOwnersWithPrefix(prefix) {
    for (const o of [...this.byOwner.keys()]) if (String(o).startsWith(prefix)) this.removeOwner(o);
  }

  /**
   * Add the colliders of an asset placed with a transform. local shapes use the asset format:
   * { type: 'box', size: [w,h,d], pos }, { type: 'cylinder', radius, height, pos }, { type: 'sphere', radius, pos }
   */
  addLocal(local, { x, y, z, yaw = 0, scale = 1, owner, material, dynamic = false }) {
    const ids = [];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const L of local) {
      const p = L.pos ?? [0, 0, 0];
      // asset yaw: three.js rotation about Y maps local (x, z) -> (x c + z s, -x s + z c)
      const wx = x + (p[0] * c + p[2] * s) * scale, wz = z + (-p[0] * s + p[2] * c) * scale, wy = y + p[1] * scale;
      let shape;
      if (L.type === 'box') {
        const sz = L.size ?? [1, 1, 1];
        shape = { type: 'box', x: wx, y: wy, z: wz, hx: sz[0] * scale / 2, hy: sz[1] * scale / 2, hz: sz[2] * scale / 2, yaw: yaw + (L.rot?.[1] ?? 0) * D2R };
      } else if (L.type === 'cylinder') {
        const h = (L.height ?? 1) * scale;
        shape = { type: 'cyl', x: wx, z: wz, y0: wy - h / 2, y1: wy + h / 2, r: (L.radius ?? 0.5) * scale };
      } else if (L.type === 'sphere') {
        shape = { type: 'sphere', x: wx, y: wy, z: wz, r: (L.radius ?? 0.5) * scale };
      } else continue;
      shape.owner = owner;
      shape.material = L.material ?? material;
      if (L.walkable === false) shape.noStand = true;
      if (L.ladder) shape.ladder = true;
      ids.push(this.add(shape, { dynamic }));
    }
    return ids;
  }

  /** Visit shapes whose xz bounds overlap the rect (each once). */
  query(x0, z0, x1, z1, cb) {
    const q = ++this.queryId;
    const st = this.stamp, sh = this.shapes;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const l = this.grid.get(this._key(cx, cz));
        if (!l) continue;
        for (const id of l) {
          if (st[id] === q) continue;
          st[id] = q;
          const s = sh[id];
          if (s && s.b[2] >= x0 && s.b[0] <= x1 && s.b[3] >= z0 && s.b[1] <= z1) cb(s);
        }
      }
    }
    for (const id of this.dynamic) {
      const s = sh[id];
      if (s && !s.disabled && s.b[2] >= x0 && s.b[0] <= x1 && s.b[3] >= z0 && s.b[1] <= z1) cb(s);
    }
  }

  /** Top of the walkable surface under (x, z) at or below maxY (terrain or shape tops). */
  groundAt(x, z, radius = 0.3, maxY = Infinity) {
    let g = this.terrain.heightAt(x, z);
    this.query(x - radius, z - radius, x + radius, z + radius, (s) => {
      if (s.noStand || s.ghost) return;
      let top;
      if (s.type === 'box') {
        const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
        const dx = x - s.x, dz = z - s.z;
        const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
        if (Math.abs(lx) > s.hx + radius * 0.5 || Math.abs(lz) > s.hz + radius * 0.5) return;
        top = s.y + s.hy;
      } else if (s.type === 'cyl') {
        if ((x - s.x) ** 2 + (z - s.z) ** 2 > (s.r + radius * 0.5) ** 2) return;
        top = s.y1;
      } else {
        const d2 = (x - s.x) ** 2 + (z - s.z) ** 2;
        if (d2 > s.r * s.r) return;
        top = s.y + Math.sqrt(s.r * s.r - d2);
      }
      if (top <= maxY && top > g) g = top;
    });
    return g;
  }

  /**
   * Push a vertical cylinder (feet at pos, height h) out of the shapes it overlaps (xz only).
   * Shapes whose top is within `step` of the feet are ignored (you climb onto them).
   * Returns true if something was hit. pos is modified.
   */
  collideCylinder(pos, radius, height, step = 0.45) {
    let hit = false;
    for (let iter = 0; iter < 2; iter++) {
      this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius, (s) => {
        if (s.ghost) return;
        const feet = pos.y, head = pos.y + height;
        if (s.type === 'box') {
          const top = s.y + s.hy, bot = s.y - s.hy;
          if (head <= bot || feet >= top - step) return;
          const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
          const dx = pos.x - s.x, dz = pos.z - s.z;
          const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
          const px = Math.max(-s.hx, Math.min(s.hx, lx)), pz = Math.max(-s.hz, Math.min(s.hz, lz));
          let ox = lx - px, oz = lz - pz;
          const d2 = ox * ox + oz * oz;
          if (d2 >= radius * radius) return;
          let nx, nz, pen;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            nx = ox / d; nz = oz / d; pen = radius - d;
          } else {
            // centre inside the box: push out along the smallest axis
            const ex = s.hx - Math.abs(lx), ez = s.hz - Math.abs(lz);
            if (ex < ez) { nx = Math.sign(lx) || 1; nz = 0; pen = ex + radius; } else { nx = 0; nz = Math.sign(lz) || 1; pen = ez + radius; }
          }
          // back to world (inverse yaw rotation)
          const wx = nx * c + nz * sn, wz = -nx * sn + nz * c;
          pos.x += wx * pen; pos.z += wz * pen;
          hit = true;
        } else if (s.type === 'cyl') {
          if (head <= s.y0 || feet >= s.y1 - step) return;
          const dx = pos.x - s.x, dz = pos.z - s.z, rr = s.r + radius;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) return;
          const d = Math.sqrt(d2) || 1e-4;
          pos.x = s.x + (dx / d) * rr; pos.z = s.z + (dz / d) * rr;
          hit = true;
        } else {
          // sphere: horizontal radius at the closest height of the cylinder segment
          const cy = Math.max(feet, Math.min(head, s.y));
          const dy = cy - s.y;
          if (Math.abs(dy) >= s.r) return;
          const top = s.y + s.r;
          if (feet >= top - step) return;
          const hr = Math.sqrt(s.r * s.r - dy * dy) + radius;
          const dx = pos.x - s.x, dz = pos.z - s.z;
          const d2 = dx * dx + dz * dz;
          if (d2 >= hr * hr) return;
          const d = Math.sqrt(d2) || 1e-4;
          pos.x = s.x + (dx / d) * hr; pos.z = s.z + (dz / d) * hr;
          hit = true;
        }
      });
    }
    // world edge
    const T = this.terrain;
    pos.x = Math.max(T.x0 + 2, Math.min(T.x0 + T.size - 2, pos.x));
    pos.z = Math.max(T.z0 + 2, Math.min(T.z0 + T.size - 2, pos.z));
    return hit;
  }

  /**
   * Raycast. dir must be normalized. opts: { terrain = true, shapes = true, water = false, ignore: owner }
   * returns { dist, x, y, z, nx, ny, nz, kind: 'terrain' | 'shape' | 'water', shape } or null
   */
  raycast(o, d, maxDist = 500, opts = {}) {
    let best = maxDist, hit = null;
    if (opts.shapes !== false) {
      const r = this._raycastShapes(o, d, best, opts.ignore);
      if (r) { best = r.dist; hit = r; }
    }
    if (opts.terrain !== false) {
      const t = this._raycastTerrain(o, d, best);
      if (t !== null && t < best) {
        best = t;
        const x = o.x + d.x * t, z = o.z + d.z * t;
        const n = this.terrain.normalAt(x, z);
        hit = { dist: t, x, y: o.y + d.y * t, z, nx: n.x, ny: n.y, nz: n.z, kind: 'terrain', material: 'ground' };
      }
    }
    if (opts.water && d.y < 0) {
      const wl = this.terrain.seaLevel;
      if (o.y > wl) {
        const t = (wl - o.y) / d.y;
        if (t < best) hit = { dist: t, x: o.x + d.x * t, y: wl, z: o.z + d.z * t, nx: 0, ny: 1, nz: 0, kind: 'water', material: 'water' };
      }
    }
    return hit;
  }

  _raycastTerrain(o, d, maxDist) {
    const T = this.terrain;
    let t = 0;
    let prevT = 0, prevDy = o.y - T.heightAt(o.x, o.z);
    if (prevDy < 0) return 0;
    while (t < maxDist) {
      const step = Math.min(8, Math.max(0.3, prevDy * 0.35));
      t = Math.min(maxDist, t + step);
      const x = o.x + d.x * t, z = o.z + d.z * t;
      if (!T.inBounds(x, z)) return null;
      const dy = o.y + d.y * t - T.heightAt(x, z);
      if (dy < 0) {
        // bisection between prevT and t
        let a = prevT, b = t;
        for (let k = 0; k < 10; k++) {
          const m = (a + b) / 2;
          const mdy = o.y + d.y * m - T.heightAt(o.x + d.x * m, o.z + d.z * m);
          if (mdy < 0) b = m; else a = m;
        }
        return (a + b) / 2;
      }
      prevT = t;
      prevDy = dy;
      if (t >= maxDist) break;
    }
    return null;
  }

  _raycastShapes(o, d, maxDist, ignore) {
    // 2D DDA over the grid cells the ray crosses
    const q = ++this.queryId;
    const st = this.stamp, sh = this.shapes;
    let best = maxDist, hit = null;
    const test = (s) => {
      if (!s || s.ghost || (ignore !== undefined && s.owner === ignore)) return;
      const r = rayShape(o, d, s, best);
      if (r && r.dist < best) { best = r.dist; hit = r; }
    };
    for (const id of this.dynamic) { st[id] = q; test(sh[id]); }
    let cx = Math.floor(o.x / CELL), cz = Math.floor(o.z / CELL);
    const stepX = d.x > 0 ? 1 : -1, stepZ = d.z > 0 ? 1 : -1;
    const tdx = d.x !== 0 ? Math.abs(CELL / d.x) : Infinity, tdz = d.z !== 0 ? Math.abs(CELL / d.z) : Infinity;
    let tmx = d.x !== 0 ? ((d.x > 0 ? (cx + 1) * CELL - o.x : o.x - cx * CELL) / Math.abs(d.x)) : Infinity;
    let tmz = d.z !== 0 ? ((d.z > 0 ? (cz + 1) * CELL - o.z : o.z - cz * CELL) / Math.abs(d.z)) : Infinity;
    let tCell = 0;
    for (let guard = 0; guard < 4096; guard++) {
      const l = this.grid.get(this._key(cx, cz));
      if (l) for (const id of l) { if (st[id] === q) continue; st[id] = q; test(sh[id]); }
      if (tCell > best) break;
      if (tmx < tmz) { tCell = tmx; tmx += tdx; cx += stepX; } else { tCell = tmz; tmz += tdz; cz += stepZ; }
      if (tCell > maxDist) break;
    }
    return hit;
  }

  /** Line of sight between two points (shapes + terrain). */
  visible(a, b, ignore) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    const d = { x: dx / len, y: dy / len, z: dz / len };
    return !this.raycast(a, d, len - 0.05, { ignore });
  }
}

/** Ray vs one shape: { dist, x, y, z, nx, ny, nz, kind: 'shape', shape } or null. */
export function rayShape(o, d, s, maxDist) {
  if (s.type === 'box') {
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    const ox = o.x - s.x, oz = o.z - s.z;
    const lox = ox * c - oz * sn, loz = ox * sn + oz * c, loy = o.y - s.y;
    const ldx = d.x * c - d.z * sn, ldz = d.x * sn + d.z * c, ldy = d.y;
    let t0 = -Infinity, t1 = Infinity, axis = 0, sign = 1;
    const slab = (oo, dd, h, ax) => {
      if (Math.abs(dd) < 1e-9) return oo >= -h && oo <= h;
      let a = (-h - oo) / dd, b = (h - oo) / dd, sg = -1;
      if (a > b) { const tmp = a; a = b; b = tmp; sg = 1; }
      if (a > t0) { t0 = a; axis = ax; sign = sg; }
      if (b < t1) t1 = b;
      return t0 <= t1;
    };
    if (!slab(lox, ldx, s.hx, 0) || !slab(loy, ldy, s.hy, 1) || !slab(loz, ldz, s.hz, 2)) return null;
    if (t1 < 0 || t0 > maxDist) return null;
    const t = Math.max(0, t0);
    let nx = 0, ny = 0, nz = 0;
    if (axis === 0) nx = sign; else if (axis === 1) ny = sign; else nz = sign;
    // local normal -> world
    const wnx = nx * c + nz * sn, wnz = -nx * sn + nz * c;
    return { dist: t, x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t, nx: wnx, ny, nz: wnz, kind: 'shape', shape: s, material: s.material };
  }
  if (s.type === 'cyl') {
    const ox = o.x - s.x, oz = o.z - s.z;
    const a = d.x * d.x + d.z * d.z;
    let t = -1, nx = 0, ny = 0, nz = 0;
    if (a > 1e-9) {
      const b = ox * d.x + oz * d.z, cc = ox * ox + oz * oz - s.r * s.r;
      const h = b * b - a * cc;
      if (h >= 0) {
        const tt = (-b - Math.sqrt(h)) / a;
        const y = o.y + d.y * tt;
        if (tt >= 0 && y >= s.y0 && y <= s.y1) { t = tt; nx = (ox + d.x * tt) / s.r; nz = (oz + d.z * tt) / s.r; }
      }
    }
    // caps
    if (Math.abs(d.y) > 1e-9) {
      for (const [y, ny0] of [[s.y1, 1], [s.y0, -1]]) {
        const tt = (y - o.y) / d.y;
        if (tt < 0 || (t >= 0 && tt >= t)) continue;
        const px = ox + d.x * tt, pz = oz + d.z * tt;
        if (px * px + pz * pz <= s.r * s.r) { t = tt; nx = 0; ny = ny0; nz = 0; }
      }
    }
    if (t < 0 || t > maxDist) return null;
    return { dist: t, x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t, nx, ny, nz, kind: 'shape', shape: s, material: s.material };
  }
  // sphere
  const ox = o.x - s.x, oy = o.y - s.y, oz = o.z - s.z;
  const b = ox * d.x + oy * d.y + oz * d.z, c = ox * ox + oy * oy + oz * oz - s.r * s.r;
  const h = b * b - c;
  if (h < 0) return null;
  const t = -b - Math.sqrt(h);
  if (t < 0 || t > maxDist) return null;
  const px = ox + d.x * t, py = oy + d.y * t, pz = oz + d.z * t;
  return { dist: t, x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t, nx: px / s.r, ny: py / s.r, nz: pz / s.r, kind: 'shape', shape: s, material: s.material };
}
