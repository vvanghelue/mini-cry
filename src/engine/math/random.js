// Deterministic random + noise helpers. Pure JS (no DOM / three), shared by the runtime, the
// editor and the Node tools (terrain generation, vegetation scattering).

/** Seeded PRNG (mulberry32): returns () => float in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of 2 ints -> [0, 1). */
export function hash2(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** String -> 32-bit seed (FNV-1a). */
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Value noise in [0, 1). */
export function valueNoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

// 2D simplex noise (Gustavson), in [-1, 1]
const GRAD = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
export function simplex(x, y, seed = 0) {
  const s = (x + y) * F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t), y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  let n = 0;
  const corner = (cx, cy, xx, yy) => {
    let tt = 0.5 - xx * xx - yy * yy;
    if (tt < 0) return 0;
    const g = GRAD[Math.floor(hash2(cx, cy, seed) * 8)];
    tt *= tt;
    return tt * tt * (g[0] * xx + g[1] * yy);
  };
  n += corner(i, j, x0, y0);
  n += corner(i + i1, j + j1, x1, y1);
  n += corner(i + 1, j + 1, x2, y2);
  return 70 * n;
}

/** Fractal simplex in about [-1, 1]. */
export function fbm(x, y, octaves = 4, seed = 0, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += simplex(x * freq, y * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged fractal in [0, 1] (sharp crests: mountain ridges, karst). */
export function ridged(x, y, octaves = 4, seed = 0) {
  let sum = 0, amp = 0.5, freq = 1, prev = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(simplex(x * freq, y * freq, seed + o * 7919));
    n *= n;
    sum += n * amp * prev;
    prev = n;
    amp *= 0.5;
    freq *= 2;
  }
  return Math.min(1, sum);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Distance from p to segment ab (2D). */
export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  const x = ax + dx * t - px, z = az + dz * t - pz;
  return Math.sqrt(x * x + z * z);
}

/** Distance from p to a polyline [[x, z], ...] plus the parameter along it. */
export function polylineDist(px, pz, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segDist(px, pz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}
