// Navigation for the AI over the open world: a 4 m grid evaluated lazily (walkable = not too
// steep, not deep water, not inside a big obstacle), A* with an expansion budget, then string
// pulling so paths are straight lines where possible. Small obstacles (tree trunks, crates)
// are not in the grid: actors slide around them with the collision step.
const CELL = 4;
const SQ2 = Math.SQRT2;

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

export class Nav {
  constructor(world) {
    this.world = world;
    this.T = world.terrain;
    this.n = Math.floor(this.T.size / CELL);
    this.half = this.T.half;
    this.walk = new Int8Array(this.n * this.n).fill(-1); // -1 unknown, 0 blocked, 1 ok
    this.cost = new Float32Array(this.n * this.n);
    this.stats = { searches: 0, expanded: 0 };
  }

  cellOf(x, z) { return [Math.floor((x + this.half) / CELL), Math.floor((z + this.half) / CELL)]; }
  center(i, j) { return [(i + 0.5) * CELL - this.half, (j + 0.5) * CELL - this.half]; }

  /** Forget cached walkability around (x, z) (after the editor moved something). */
  invalidate(x, z, r) {
    const [i0, j0] = this.cellOf(x - r, z - r), [i1, j1] = this.cellOf(x + r, z + r);
    for (let j = Math.max(0, j0); j <= Math.min(this.n - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(this.n - 1, i1); i++) this.walk[j * this.n + i] = -1;
  }

  walkable(i, j) {
    if (i < 1 || j < 1 || i >= this.n - 1 || j >= this.n - 1) return false;
    const k = j * this.n + i;
    let w = this.walk[k];
    if (w >= 0) return w === 1;
    const [x, z] = this.center(i, j);
    const T = this.T;
    const h = T.heightAt(x, z);
    const n = T.normalAt(x, z);
    w = 1;
    let cost = 1;
    if (n.y < 0.78) w = 0;
    else cost += (1 - n.y) * 6;
    const depth = T.waterLevelAt(x, z) - h;
    if (depth > 0.9) w = 0; else if (depth > 0.2) cost += 2;
    if (w) {
      // big obstacles covering the cell centre
      this.world.physics.query(x - 0.6, z - 0.6, x + 0.6, z + 0.6, (s) => {
        if (!w || s.ladder) return;
        if (s.type === 'box') {
          if (s.y + s.hy < h + 0.6 || s.y - s.hy > h + 1.8) return;
          if (Math.min(s.hx, s.hz) < 0.45) return; // thin wall: let collision handle it
          const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
          const dx = x - s.x, dz = z - s.z;
          const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
          if (Math.abs(lx) < s.hx + 0.3 && Math.abs(lz) < s.hz + 0.3) w = 0;
        } else if (s.r > 1.1) {
          const top = s.type === 'cyl' ? s.y1 : s.y + s.r;
          if (top < h + 0.6) return;
          if ((x - s.x) ** 2 + (z - s.z) ** 2 < (s.r + 0.3) ** 2) w = 0;
        }
      });
    }
    this.walk[k] = w;
    this.cost[k] = cost;
    return w === 1;
  }

  /** Straight walkable line between two cells (grid DDA). */
  lineClear(i0, j0, i1, j1) {
    let di = Math.abs(i1 - i0), dj = Math.abs(j1 - j0);
    const si = i0 < i1 ? 1 : -1, sj = j0 < j1 ? 1 : -1;
    let err = di - dj, i = i0, j = j0;
    for (let guard = 0; guard < 400; guard++) {
      if (!this.walkable(i, j)) return false;
      if (i === i1 && j === j1) return true;
      const e2 = 2 * err;
      if (e2 > -dj) { err -= dj; i += si; }
      if (e2 < di) { err += di; j += sj; }
    }
    return false;
  }

  /** Nearest walkable cell to (x, z) within a few cells. */
  nearestWalkable(i, j, r = 3) {
    if (this.walkable(i, j)) return [i, j];
    for (let d = 1; d <= r; d++) for (let a = -d; a <= d; a++) for (const [ii, jj] of [[i + a, j - d], [i + a, j + d], [i - d, j + a], [i + d, j + a]]) if (this.walkable(ii, jj)) return [ii, jj];
    return null;
  }

  /**
   * Path from a to b: array of [x, z] world points (excluding the start), or null.
   * maxExpand bounds the work (~6000 cells ≈ a 300 m detour).
   */
  findPath(ax, az, bx, bz, maxExpand = 6000) {
    this.stats.searches++;
    let [si, sj] = this.cellOf(ax, az), [ti, tj] = this.cellOf(bx, bz);
    const s = this.nearestWalkable(si, sj), t = this.nearestWalkable(ti, tj);
    if (!s || !t) return null;
    [si, sj] = s; [ti, tj] = t;
    if (si === ti && sj === tj) return [[bx, bz]];
    if (this.lineClear(si, sj, ti, tj)) return [[bx, bz]];
    const n = this.n;
    const g = new Map(), from = new Map();
    const open = new Heap();
    const start = sj * n + si, goal = tj * n + ti;
    const hfn = (i, j) => { const dx = Math.abs(i - ti), dz = Math.abs(j - tj); return (dx + dz + (SQ2 - 2) * Math.min(dx, dz)) * 1.1; };
    g.set(start, 0);
    open.push(start, hfn(si, sj));
    let expanded = 0, found = false, bestK = start, bestH = Infinity;
    const closed = new Set();
    while (open.size && expanded < maxExpand) {
      const k = open.pop();
      if (closed.has(k)) continue;
      closed.add(k);
      expanded++;
      if (k === goal) { found = true; break; }
      const i = k % n, j = (k / n) | 0;
      const hk = hfn(i, j);
      if (hk < bestH) { bestH = hk; bestK = k; }
      const gk = g.get(k);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (!this.walkable(ni, nj)) continue;
          if (di && dj && (!this.walkable(i + di, j) || !this.walkable(i, j + dj))) continue; // no corner cutting
          const nk = nj * n + ni;
          if (closed.has(nk)) continue;
          const step = (di && dj ? SQ2 : 1) * this.cost[nk];
          const ng = gk + step;
          if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); from.set(nk, k); open.push(nk, ng + hfn(ni, nj)); }
        }
      }
    }
    this.stats.expanded += expanded;
    const end = found ? goal : bestK;
    if (end === start) return null;
    const cells = [];
    for (let k = end; k !== undefined && k !== start; k = from.get(k)) cells.push(k);
    cells.reverse();
    // string pulling
    const pts = [];
    let ci = si, cj = sj;
    let idx = 0;
    while (idx < cells.length) {
      let far = idx;
      for (let m = cells.length - 1; m > idx; m--) {
        const k = cells[m];
        if (this.lineClear(ci, cj, k % n, (k / n) | 0)) { far = m; break; }
      }
      const k = cells[far];
      ci = k % n; cj = (k / n) | 0;
      pts.push(this.center(ci, cj));
      idx = far + 1;
    }
    if (found) pts[pts.length - 1] = [bx, bz];
    return pts;
  }
}
