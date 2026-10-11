// Ray tracing for the GI baker. The terrain is traced as a heightfield (max-height pyramid:
// rays skip whole regions they pass above), everything else as instances (mesh + affine
// transform) of binned-SAH triangle BVHs under a top-level BVH. All data lives in flat typed
// arrays on SharedArrayBuffers (one copy for every worker thread) and the tracers allocate
// nothing: results go to the module-level HIT / HIT_N / HIT_C records.

const SAB = (bytes) => new SharedArrayBuffer(Math.max(4, bytes));

// --- BVH build -----------------------------------------------------------------------------------
// Node: 8 x 32-bit words, [minx miny minz maxx maxy maxz] then
//   inner: right child index, INNER | split axis (the left child is the next node)
//   leaf:  first primitive, count
const INNER = 0x80000000;
const BINS = 12;

/** BVH over primitive AABBs (Float32Array, 6 per primitive). Returns { nodes, order, nodeCount }. */
export function buildFromBounds(bounds, count, leafSize = 4) {
  const cen = new Float32Array(count * 3);
  for (let p = 0; p < count; p++) {
    const b = p * 6;
    cen[p * 3] = (bounds[b] + bounds[b + 3]) * 0.5;
    cen[p * 3 + 1] = (bounds[b + 1] + bounds[b + 4]) * 0.5;
    cen[p * 3 + 2] = (bounds[b + 2] + bounds[b + 5]) * 0.5;
  }
  const order = new Uint32Array(count);
  for (let p = 0; p < count; p++) order[p] = p;
  let cap = Math.max(16, Math.ceil((count / leafSize) * 2.5));
  let F = new Float32Array(cap * 8), U = new Uint32Array(F.buffer);
  let nNodes = 0;
  const binCount = new Int32Array(BINS), binB = new Float32Array(BINS * 6);
  const leftArea = new Float64Array(BINS), leftN = new Int32Array(BINS);
  const acc = new Float64Array(6);
  const area = () => {
    const dx = acc[3] - acc[0], dy = acc[4] - acc[1], dz = acc[5] - acc[2];
    return dx < 0 ? 0 : dx * dy + dy * dz + dz * dx;
  };
  const grow = (bb) => {
    for (let a = 0; a < 3; a++) { if (binB[bb + a] < acc[a]) acc[a] = binB[bb + a]; if (binB[bb + 3 + a] > acc[3 + a]) acc[3 + a] = binB[bb + 3 + a]; }
  };
  const stack = [[0, count, -1]]; // start, end, parent whose right child this is
  while (stack.length) {
    const [start, end, parent] = stack.pop();
    if (nNodes >= cap) {
      cap *= 2;
      const F2 = new Float32Array(cap * 8);
      F2.set(F);
      F = F2; U = new Uint32Array(F.buffer);
    }
    const node = nNodes++;
    if (parent >= 0) U[parent * 8 + 6] = node;
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    let cminx = Infinity, cminy = Infinity, cminz = Infinity, cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
    for (let k = start; k < end; k++) {
      const p = order[k], b = p * 6, c = p * 3;
      if (bounds[b] < minx) minx = bounds[b]; if (bounds[b + 1] < miny) miny = bounds[b + 1]; if (bounds[b + 2] < minz) minz = bounds[b + 2];
      if (bounds[b + 3] > maxx) maxx = bounds[b + 3]; if (bounds[b + 4] > maxy) maxy = bounds[b + 4]; if (bounds[b + 5] > maxz) maxz = bounds[b + 5];
      const x = cen[c], y = cen[c + 1], z = cen[c + 2];
      if (x < cminx) cminx = x; if (y < cminy) cminy = y; if (z < cminz) cminz = z;
      if (x > cmaxx) cmaxx = x; if (y > cmaxy) cmaxy = y; if (z > cmaxz) cmaxz = z;
    }
    const o = node * 8;
    F[o] = minx; F[o + 1] = miny; F[o + 2] = minz; F[o + 3] = maxx; F[o + 4] = maxy; F[o + 5] = maxz;
    const n = end - start;
    const ex = cmaxx - cminx, ey = cmaxy - cminy, ez = cmaxz - cminz;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const cmin = axis === 0 ? cminx : axis === 1 ? cminy : cminz;
    const ext = axis === 0 ? ex : axis === 1 ? ey : ez;
    if (n <= leafSize || ext <= 1e-9) {
      U[o + 6] = start; U[o + 7] = n;
      continue;
    }
    // binned SAH along the widest centroid axis
    binCount.fill(0);
    for (let q = 0; q < BINS; q++) { binB[q * 6] = binB[q * 6 + 1] = binB[q * 6 + 2] = Infinity; binB[q * 6 + 3] = binB[q * 6 + 4] = binB[q * 6 + 5] = -Infinity; }
    const scale = BINS / ext;
    for (let k = start; k < end; k++) {
      const p = order[k];
      let q = ((cen[p * 3 + axis] - cmin) * scale) | 0;
      if (q >= BINS) q = BINS - 1;
      binCount[q]++;
      const b = p * 6, bb = q * 6;
      if (bounds[b] < binB[bb]) binB[bb] = bounds[b]; if (bounds[b + 1] < binB[bb + 1]) binB[bb + 1] = bounds[b + 1]; if (bounds[b + 2] < binB[bb + 2]) binB[bb + 2] = bounds[b + 2];
      if (bounds[b + 3] > binB[bb + 3]) binB[bb + 3] = bounds[b + 3]; if (bounds[b + 4] > binB[bb + 4]) binB[bb + 4] = bounds[b + 4]; if (bounds[b + 5] > binB[bb + 5]) binB[bb + 5] = bounds[b + 5];
    }
    acc[0] = acc[1] = acc[2] = Infinity; acc[3] = acc[4] = acc[5] = -Infinity;
    let cnt = 0;
    for (let q = 0; q < BINS - 1; q++) {
      if (binCount[q]) grow(q * 6);
      cnt += binCount[q];
      leftArea[q] = cnt ? area() : 0; leftN[q] = cnt;
    }
    acc[0] = acc[1] = acc[2] = Infinity; acc[3] = acc[4] = acc[5] = -Infinity;
    cnt = 0;
    let best = Infinity, bestQ = -1;
    for (let q = BINS - 1; q > 0; q--) {
      if (binCount[q]) grow(q * 6);
      cnt += binCount[q];
      const ln = leftN[q - 1];
      if (!ln || !cnt) continue;
      const cost = leftArea[q - 1] * ln + area() * cnt;
      if (cost < best) { best = cost; bestQ = q; }
    }
    let mid = start + (n >> 1);
    if (bestQ >= 0) {
      let i = start, j = end - 1;
      while (i <= j) {
        const p = order[i];
        let q = ((cen[p * 3 + axis] - cmin) * scale) | 0;
        if (q >= BINS) q = BINS - 1;
        if (q < bestQ) i++;
        else { order[i] = order[j]; order[j] = p; j--; }
      }
      if (i > start && i < end) mid = i;
    }
    U[o + 7] = (INNER | axis) >>> 0;
    stack.push([mid, end, node], [start, mid, -1]); // left popped first -> node + 1
  }
  const out = new Float32Array(SAB(nNodes * 32));
  out.set(F.subarray(0, nNodes * 8));
  return { nodes: out.buffer, order, nodeCount: nNodes };
}

/**
 * Triangle mesh BVH. pos: Float32Array 9 per triangle, colors: Float32Array 3 per triangle
 * (linear albedo). Triangles are stored reordered as (v0, e1, e2).
 */
export function buildMesh(pos, colors, { doubleSided = false, leafSize = 4 } = {}) {
  const n = pos.length / 9;
  const bounds = new Float32Array(n * 6);
  for (let t = 0; t < n; t++) {
    const p = t * 9, b = t * 6;
    for (let a = 0; a < 3; a++) {
      const v0 = pos[p + a], v1 = pos[p + 3 + a], v2 = pos[p + 6 + a];
      bounds[b + a] = Math.min(v0, v1, v2);
      bounds[b + 3 + a] = Math.max(v0, v1, v2);
    }
  }
  const { nodes, order, nodeCount } = buildFromBounds(bounds, n, leafSize);
  const tris = new Float32Array(SAB(n * 36));
  const col = new Float32Array(SAB(n * 12));
  for (let k = 0; k < n; k++) {
    const p = order[k] * 9, o = k * 9;
    tris[o] = pos[p]; tris[o + 1] = pos[p + 1]; tris[o + 2] = pos[p + 2];
    tris[o + 3] = pos[p + 3] - pos[p]; tris[o + 4] = pos[p + 4] - pos[p + 1]; tris[o + 5] = pos[p + 5] - pos[p + 2];
    tris[o + 6] = pos[p + 6] - pos[p]; tris[o + 7] = pos[p + 7] - pos[p + 1]; tris[o + 8] = pos[p + 8] - pos[p + 2];
    const c = order[k] * 3;
    col[k * 3] = colors[c]; col[k * 3 + 1] = colors[c + 1]; col[k * 3 + 2] = colors[c + 2];
  }
  return { nodes, tris: tris.buffer, colors: col.buffer, doubleSided, triCount: n, nodeCount };
}

/** Views over a shared mesh: { F, U, T, C, doubleSided }. */
export function meshView(m) {
  return { F: new Float32Array(m.nodes), U: new Uint32Array(m.nodes), T: new Float32Array(m.tris), C: new Float32Array(m.colors), doubleSided: m.doubleSided };
}

// --- tracing --------------------------------------------------------------------------------------

/** Last hit: t, instance (-1 = terrain), triangle, back face. */
export const HIT = { t: 0, inst: -1, tri: -1, back: false, i: 0, j: 0 };
export const HIT_N = new Float64Array(3), HIT_C = new Float64Array(3);

const _stack = new Int32Array(256);

/**
 * Closest (or any) hit of a ray against one mesh BVH, t in (tmin, tmax). Returns t or -1 and sets
 * HIT.tri / HIT.back. The direction need not be normalised (t is in its units).
 */
export function traceMesh(m, ox, oy, oz, dx, dy, dz, tmin, tmax, any) {
  const F = m.F, U = m.U, T = m.T;
  const ix = 1 / (dx || 1e-12), iy = 1 / (dy || 1e-12), iz = 1 / (dz || 1e-12);
  // near / far slab offsets per axis from the direction signs (min = +0, max = +3)
  const nx = ix < 0 ? 3 : 0, ny = iy < 0 ? 4 : 1, nz = iz < 0 ? 5 : 2;
  const fx = ix < 0 ? 0 : 3, fy = iy < 0 ? 1 : 4, fz = iz < 0 ? 2 : 5;
  let best = tmax, hitTri = -1, back = false;
  let sp = 0;
  _stack[sp++] = 0;
  while (sp > 0) {
    const node = _stack[--sp], o = node << 3;
    let t0 = (F[o + nx] - ox) * ix, t1 = (F[o + fx] - ox) * ix;
    let a = (F[o + ny] - oy) * iy, b = (F[o + fy] - oy) * iy;
    if (a > t0) t0 = a; if (b < t1) t1 = b;
    a = (F[o + nz] - oz) * iz; b = (F[o + fz] - oz) * iz;
    if (a > t0) t0 = a; if (b < t1) t1 = b;
    if (t0 > t1 || t1 < tmin || t0 > best) continue;
    const w = U[o + 7];
    if (w >= INNER) {
      // near child (along the split axis) popped first
      const axis = w & 3, d = axis === 0 ? dx : axis === 1 ? dy : dz;
      if (d >= 0) { _stack[sp++] = U[o + 6]; _stack[sp++] = node + 1; }
      else { _stack[sp++] = node + 1; _stack[sp++] = U[o + 6]; }
      continue;
    }
    const first = U[o + 6];
    for (let k = first, e = first + w; k < e; k++) {
      const q = k * 9;
      const e1x = T[q + 3], e1y = T[q + 4], e1z = T[q + 5], e2x = T[q + 6], e2y = T[q + 7], e2z = T[q + 8];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-14 && det < 1e-14) continue;
      const inv = 1 / det;
      const tx = ox - T[q], ty = oy - T[q + 1], tz = oz - T[q + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t <= tmin || t >= best) continue;
      best = t; hitTri = k; back = det < 0;
      if (any) { HIT.tri = k; HIT.back = back; return t; }
    }
  }
  if (hitTri < 0) return -1;
  HIT.tri = hitTri; HIT.back = back;
  return best;
}

// --- heightfield terrain ---------------------------------------------------------------------------
// Vertex grid res x res over [-size/2, size/2]; cell (i, j) holds two triangles split like
// TerrainData.heightAt: (i,j)(i,j+1)(i+1,j) and (i+1,j)(i,j+1)(i+1,j+1). The pyramid stores the
// max height of 2^level x 2^level cells (padded to a power of two).

/** heights: Float32Array res*res, colors: Float32Array res*res*3 (linear vertex albedo). */
export function buildHeightfield(heights, colors, res, size) {
  const q = res - 1;
  let top = 0;
  while ((1 << top) < q) top++;
  const dim = 1 << top;
  const offs = [];
  let total = 0;
  for (let l = 0; l <= top; l++) { offs.push(total); total += (dim >> l) ** 2; }
  const mip = new Float32Array(SAB(total * 4)).fill(-Infinity);
  for (let j = 0; j < q; j++) for (let i = 0; i < q; i++) {
    const k = j * res + i;
    mip[j * dim + i] = Math.max(heights[k], heights[k + 1], heights[k + res], heights[k + res + 1]);
  }
  for (let l = 1; l <= top; l++) {
    const w = dim >> l, pw = w * 2, o = offs[l], po = offs[l - 1];
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
      const c = po + j * 2 * pw + i * 2;
      mip[o + j * w + i] = Math.max(mip[c], mip[c + 1], mip[c + pw], mip[c + pw + 1]);
    }
  }
  const h = new Float32Array(SAB(heights.length * 4)); h.set(heights);
  const c = new Float32Array(SAB(colors.length * 4)); c.set(colors);
  return { heights: h.buffer, colors: c.buffer, mip: mip.buffer, offs, top, dim, res, size };
}

export function heightfieldView(t) {
  return { H: new Float32Array(t.heights), C: new Float32Array(t.colors), M: new Float32Array(t.mip), offs: t.offs, top: t.top, dim: t.dim, res: t.res, q: t.res - 1, cell: t.size / (t.res - 1), half: t.size / 2 };
}

let _hfI = 0, _hfJ = 0, _hfUpper = false, _hfBack = false;

/** Triangle (vertex indices) / ray test, MT. Returns t or -1. */
function triHF(H, res, cell, half, i0, j0, i1, j1, i2, j2, ox, oy, oz, dx, dy, dz, tmin, tmax) {
  const ax = i0 * cell - half, ay = H[j0 * res + i0], az = j0 * cell - half;
  const e1x = (i1 - i0) * cell, e1y = H[j1 * res + i1] - ay, e1z = (j1 - j0) * cell;
  const e2x = (i2 - i0) * cell, e2y = H[j2 * res + i2] - ay, e2z = (j2 - j0) * cell;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t <= tmin || t >= tmax) return -1;
  _hfBack = det < 0;
  return t;
}

/** Closest hit against the heightfield (front to back, so the first hit is the closest). */
export function traceTerrain(hf, ox, oy, oz, dx, dy, dz, tmin, tmax) {
  const { H, M, offs, top, q, cell, half, res } = hf;
  const gx = (ox + half) / cell, gz = (oz + half) / cell, gdx = dx / cell, gdz = dz / cell;
  // clip to the grid (x, z in [0, q]) and below the highest point
  let t = tmin, tEnd = tmax;
  if (gdx > 1e-12 || gdx < -1e-12) {
    let a = -gx / gdx, b = (q - gx) / gdx;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t) t = a; if (b < tEnd) tEnd = b;
  } else if (gx < 0 || gx > q) return -1;
  if (gdz > 1e-12 || gdz < -1e-12) {
    let a = -gz / gdz, b = (q - gz) / gdz;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t) t = a; if (b < tEnd) tEnd = b;
  } else if (gz < 0 || gz > q) return -1;
  const ymax = M[offs[top]];
  if (dy >= 0) { if (oy + dy * t > ymax) return -1; if (dy > 1e-12) tEnd = Math.min(tEnd, (ymax - oy) / dy); }
  if (t > tEnd) return -1;
  let level = Math.min(top, 4);
  const sx = gdx >= 0, sz = gdz >= 0;
  const eps = 1e-5;
  for (let guard = 0; guard < 100000 && t <= tEnd; guard++) {
    const px = gx + gdx * (t + eps), pz = gz + gdz * (t + eps);
    const size = 1 << level, w = hf.dim >> level;
    let ci = Math.floor(px / size), cj = Math.floor(pz / size);
    if (ci < 0) ci = 0; else if (ci >= w) ci = w - 1;
    if (cj < 0) cj = 0; else if (cj >= w) cj = w - 1;
    const bx = sx ? (ci + 1) * size : ci * size, bz = sz ? (cj + 1) * size : cj * size;
    let tx = Math.abs(gdx) > 1e-12 ? (bx - gx) / gdx : Infinity, tz = Math.abs(gdz) > 1e-12 ? (bz - gz) / gdz : Infinity;
    let tc = tx < tz ? tx : tz;
    if (tc > tEnd) tc = tEnd;
    const y0 = oy + dy * t, y1 = oy + dy * tc;
    const ylo = y0 < y1 ? y0 : y1;
    if (ylo > M[offs[level] + cj * w + ci]) {
      t = tc + eps;
      if (level < top) level++;
      continue;
    }
    if (level > 0) { level--; continue; }
    if (ci < q && cj < q) {
      let best = -1;
      let th = triHF(H, res, cell, half, ci, cj, ci, cj + 1, ci + 1, cj, ox, oy, oz, dx, dy, dz, tmin, tmax);
      if (th > 0) { best = th; _hfUpper = false; }
      const b0 = _hfBack;
      th = triHF(H, res, cell, half, ci + 1, cj, ci, cj + 1, ci + 1, cj + 1, ox, oy, oz, dx, dy, dz, tmin, best > 0 ? best : tmax);
      if (th > 0) { best = th; _hfUpper = true; } else _hfBack = b0;
      if (best > 0) { _hfI = ci; _hfJ = cj; return best; }
    }
    t = tc + eps;
  }
  return -1;
}

// --- scene: terrain + instances of meshes under a top-level BVH ---------------------------------
// Instance record (Float32, 16): inverse affine 3x4 (row-major, 12), mesh index, 3 unused.

export const INST_STRIDE = 16;

/**
 * instances: [{ mesh, matrix: number[16] (column-major, three.js) }], meshBounds: per mesh local
 * AABB [6]. Returns { tlas, inst, count }.
 */
export function buildScene(instances, meshBounds) {
  const n = instances.length;
  const bounds = new Float32Array(n * 6);
  const rec = new Float32Array(n * INST_STRIDE);
  instances.forEach((it, k) => {
    const e = it.matrix;
    const b = meshBounds[it.mesh];
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? b[3] : b[0], y = c & 2 ? b[4] : b[1], z = c & 4 ? b[5] : b[2];
      const w = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
      for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], w[a]); mx[a] = Math.max(mx[a], w[a]); }
    }
    bounds.set([...mn, ...mx], k * 6);
    rec.set(invertAffine(e), k * INST_STRIDE);
    rec[k * INST_STRIDE + 12] = it.mesh;
  });
  const { nodes, order } = buildFromBounds(bounds, n, 2);
  const inst = new Float32Array(SAB(n * INST_STRIDE * 4));
  for (let k = 0; k < n; k++) inst.set(rec.subarray(order[k] * INST_STRIDE, order[k] * INST_STRIDE + INST_STRIDE), k * INST_STRIDE);
  return { tlas: nodes, inst: inst.buffer, count: n };
}

/** 3x4 row-major inverse of a column-major affine 4x4. */
function invertAffine(e) {
  const a = e[0], b = e[4], c = e[8], d = e[1], f = e[5], g = e[9], h = e[2], i = e[6], j = e[10];
  const det = a * (f * j - g * i) - b * (d * j - g * h) + c * (d * i - f * h);
  const id = 1 / det;
  const m = [
    (f * j - g * i) * id, (c * i - b * j) * id, (b * g - c * f) * id,
    (g * h - d * j) * id, (a * j - c * h) * id, (c * d - a * g) * id,
    (d * i - f * h) * id, (b * h - a * i) * id, (a * f - b * d) * id,
  ];
  const tx = e[12], ty = e[13], tz = e[14];
  return [
    m[0], m[1], m[2], -(m[0] * tx + m[1] * ty + m[2] * tz),
    m[3], m[4], m[5], -(m[3] * tx + m[4] * ty + m[5] * tz),
    m[6], m[7], m[8], -(m[6] * tx + m[7] * ty + m[8] * tz),
  ];
}

const _tstack = new Int32Array(128);

/**
 * Closest (or any) hit in the scene = { hf (heightfieldView), F, U (TLAS), I (instances),
 * meshes: [meshView] }. Returns t or -1; on a hit sets HIT (inst -1 = terrain).
 */
export function traceScene(scene, ox, oy, oz, dx, dy, dz, tmin, tmax, any) {
  let best = tmax, bInst = -2, bTri = -1, bBack = false;
  const th = traceTerrain(scene.hf, ox, oy, oz, dx, dy, dz, tmin, tmax);
  if (th > 0) {
    if (any) { HIT.t = th; HIT.inst = -1; return th; }
    best = th; bInst = -1; bBack = _hfBack;
  }
  const F = scene.F, U = scene.U, I = scene.I;
  const ix = 1 / (dx || 1e-12), iy = 1 / (dy || 1e-12), iz = 1 / (dz || 1e-12);
  const nx = ix < 0 ? 3 : 0, ny = iy < 0 ? 4 : 1, nz = iz < 0 ? 5 : 2;
  const fx = ix < 0 ? 0 : 3, fy = iy < 0 ? 1 : 4, fz = iz < 0 ? 2 : 5;
  let sp = 0;
  _tstack[sp++] = 0;
  while (sp > 0) {
    const node = _tstack[--sp], o = node << 3;
    let t0 = (F[o + nx] - ox) * ix, t1 = (F[o + fx] - ox) * ix;
    let a = (F[o + ny] - oy) * iy, b = (F[o + fy] - oy) * iy;
    if (a > t0) t0 = a; if (b < t1) t1 = b;
    a = (F[o + nz] - oz) * iz; b = (F[o + fz] - oz) * iz;
    if (a > t0) t0 = a; if (b < t1) t1 = b;
    if (t0 > t1 || t1 < tmin || t0 > best) continue;
    const w = U[o + 7];
    if (w >= INNER) {
      const axis = w & 3, d = axis === 0 ? dx : axis === 1 ? dy : dz;
      if (d >= 0) { _tstack[sp++] = U[o + 6]; _tstack[sp++] = node + 1; }
      else { _tstack[sp++] = node + 1; _tstack[sp++] = U[o + 6]; }
      continue;
    }
    const first = U[o + 6];
    for (let k = first, e = first + w; k < e; k++) {
      const r = k * INST_STRIDE;
      const lox = I[r] * ox + I[r + 1] * oy + I[r + 2] * oz + I[r + 3];
      const loy = I[r + 4] * ox + I[r + 5] * oy + I[r + 6] * oz + I[r + 7];
      const loz = I[r + 8] * ox + I[r + 9] * oy + I[r + 10] * oz + I[r + 11];
      const ldx = I[r] * dx + I[r + 1] * dy + I[r + 2] * dz;
      const ldy = I[r + 4] * dx + I[r + 5] * dy + I[r + 6] * dz;
      const ldz = I[r + 8] * dx + I[r + 9] * dy + I[r + 10] * dz;
      const t = traceMesh(scene.meshes[I[r + 12]], lox, loy, loz, ldx, ldy, ldz, tmin, best, any);
      if (t < 0) continue;
      best = t; bInst = k; bTri = HIT.tri; bBack = HIT.back;
      if (any) { HIT.t = t; HIT.inst = k; return t; }
    }
  }
  if (bInst === -2) return -1;
  HIT.t = best; HIT.inst = bInst; HIT.tri = bTri; HIT.back = bBack;
  if (bInst === -1) { HIT.tri = _hfUpper ? 1 : 0; HIT.i = _hfI; HIT.j = _hfJ; }
  return best;
}

/**
 * World normal (facing the ray origin) and albedo of the last closest hit into HIT_N / HIT_C.
 * Returns whether the surface is double sided.
 */
export function hitSurface(scene, dx, dy, dz) {
  let wx, wy, wz, ds = false;
  if (HIT.inst === -1) {
    const { H, C, res, cell } = scene.hf;
    const i = HIT.i, j = HIT.j;
    let i0, j0, i1, j1, i2, j2, ci;
    if (HIT.tri) { i0 = i + 1; j0 = j; i1 = i; j1 = j + 1; i2 = i + 1; j2 = j + 1; ci = (j + 1) * res + i + 1; }
    else { i0 = i; j0 = j; i1 = i; j1 = j + 1; i2 = i + 1; j2 = j; ci = j * res + i; }
    const ay = H[j0 * res + i0];
    const e1x = (i1 - i0) * cell, e1y = H[j1 * res + i1] - ay, e1z = (j1 - j0) * cell;
    const e2x = (i2 - i0) * cell, e2y = H[j2 * res + i2] - ay, e2z = (j2 - j0) * cell;
    wx = e1y * e2z - e1z * e2y; wy = e1z * e2x - e1x * e2z; wz = e1x * e2y - e1y * e2x;
    HIT_C[0] = C[ci * 3]; HIT_C[1] = C[ci * 3 + 1]; HIT_C[2] = C[ci * 3 + 2];
  } else {
    const I = scene.I, r = HIT.inst * INST_STRIDE;
    const m = scene.meshes[I[r + 12]];
    const T = m.T, q = HIT.tri * 9;
    const nx = T[q + 4] * T[q + 8] - T[q + 5] * T[q + 7];
    const ny = T[q + 5] * T[q + 6] - T[q + 3] * T[q + 8];
    const nz = T[q + 3] * T[q + 7] - T[q + 4] * T[q + 6];
    // to world with the inverse transpose
    wx = I[r] * nx + I[r + 4] * ny + I[r + 8] * nz;
    wy = I[r + 1] * nx + I[r + 5] * ny + I[r + 9] * nz;
    wz = I[r + 2] * nx + I[r + 6] * ny + I[r + 10] * nz;
    const C = m.C, c = HIT.tri * 3;
    HIT_C[0] = C[c]; HIT_C[1] = C[c + 1]; HIT_C[2] = C[c + 2];
    ds = m.doubleSided;
  }
  let l = Math.hypot(wx, wy, wz) || 1;
  if (wx * dx + wy * dy + wz * dz > 0) l = -l;
  HIT_N[0] = wx / l; HIT_N[1] = wy / l; HIT_N[2] = wz / l;
  return ds;
}
