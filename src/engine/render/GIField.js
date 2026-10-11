// Probe GI field: data layout and math shared by the baker (tools/lib/gi, Node) and the runtime
// (render/GI.js: GPU relight + shading, CPU lookups for auto exposure). Pure JS, no three.js.
//
// Probes sit on a regular grid of columns (`cell` m) with GI_LAYERS layers that follow the
// ground: layer l is H0 * RATIO^l above the column base (ground or water surface, averaged over
// the cell): 1.5, 3.75, 9.4 and 23.4 m. A point maps to a fractional layer from its height above
// the bilinear base, so a lookup is one trilinear fetch.
//
// Each probe stores 1 + K "terms" of diffuse irradiance as L1 SH already convolved with the
// cosine lobe: per colour channel E(n) = A + B . n. Term 0 is the light from a uniform white sky
// of radiance 1 (with its bounces), full RGB (white from above, the ground's colour from below).
// Term 1 + k is the light bounced from a white sun of irradiance 1 coming from key direction k
// along the sun path (the path only depends on the time of day; the moon reuses the keys), with
// one direction for the three channels. The runtime relights:
//   E = sky * skyRadiance + mix(key[kA], key[kB], f) * sunColor
// so sky / sun colours and intensities change freely without a re-bake.
//
// File (gi/probes.bin, gzip): [base heights: float32 n*n] then byte planes of n*n*LAYERS
// ((layer, z, x) order, each row delta-coded): sky A,Bx,By,Bz for r, g, b (12 planes), then per
// key A.rgb, D.xyz (6 planes). A is sqrt(A / amax[term]); B (sky) is B / A per channel and D
// (keys) is B_luma / A_luma, both in [-2, 2] (|B| <= 2A for any positive radiance).
// GPU input (DataArrayTexture n x n*LAYERS, RGBA8): slices 0-2 = sky r/g/b (A, B/A), then per
// key two slices (A.r, A.g, A.b, D.x) (D.y, D.z, 0, 0).

export const GI_VERSION = 2;
export const GI_LAYERS = 4;
export const GI_H0 = 1.5;
export const GI_RATIO = 2.5;
export const GI_KEYS = 7;
const LOG2_RATIO = Math.log2(GI_RATIO);

export const layerHeight = (l) => GI_H0 * GI_RATIO ** l;
export const planeCount = (keys) => 12 + keys * 6;
export const sliceCount = (keys) => 3 + keys * 2;

/** Fractional layer [0, GI_LAYERS - 1] of a point `t` metres above the column base. */
export function layerCoord(t) {
  const l = Math.log2(Math.max(t, GI_H0) / GI_H0) / LOG2_RATIO;
  return l < GI_LAYERS - 1 ? l : GI_LAYERS - 1;
}

/** Arc parameter of a light direction on the sun path: 0 at sunrise (east, +x), PI at sunset. */
export const arcOf = (dirX) => Math.acos(Math.max(-1, Math.min(1, dirX)));

/** Key k direction on the sun path (Lighting.setTimeOfDay: a = 0 at 6h, PI at 18h). */
export function keyDir(k, keys, tilt) {
  const a = (Math.PI * (k + 0.5)) / keys;
  return [Math.cos(a), Math.sin(a) * Math.cos(tilt), Math.sin(a) * Math.sin(tilt)];
}

/** The two keys around a light direction and the blend factor: [kA, kB, f]. */
export function keyBlend(dirX, keys, out = [0, 0, 0]) {
  const u = (arcOf(dirX) * keys) / Math.PI - 0.5;
  const k = Math.max(0, Math.min(keys - 1, Math.floor(u)));
  out[0] = k;
  out[1] = Math.min(keys - 1, k + 1);
  out[2] = Math.max(0, Math.min(1, u - k));
  return out;
}

// --- byte encoding ------------------------------------------------------------------------------
export const encA = (A, amax) => Math.round(Math.sqrt(Math.min(1, Math.max(0, A) / amax)) * 255);
export const encR = (r) => Math.round((Math.max(-2, Math.min(2, r)) + 2) * (255 / 4));
const decR = (b) => b * (4 / 255) - 2;

/**
 * Encode a float field (S = (1 + keys) * 12 floats per probe: per term, per channel A,Bx,By,Bz)
 * into the delta-coded byte planes of the file.
 */
export function encodePlanes(F, count, n, keys, amax) {
  const S = (1 + keys) * 12, plane = count;
  const out = new Uint8Array(planeCount(keys) * plane);
  for (let p = 0; p < count; p++) {
    const o = p * S;
    for (let c = 0; c < 3; c++) {
      const s = o + c * 4, A = F[s], inv = A > 1e-7 ? 1 / A : 0;
      out[(c * 4) * plane + p] = encA(A, amax[0]);
      out[(c * 4 + 1) * plane + p] = encR(F[s + 1] * inv);
      out[(c * 4 + 2) * plane + p] = encR(F[s + 2] * inv);
      out[(c * 4 + 3) * plane + p] = encR(F[s + 3] * inv);
    }
    for (let k = 0; k < keys; k++) {
      const s = o + (1 + k) * 12, pl = 12 + k * 6;
      const ar = F[s], ag = F[s + 4], ab = F[s + 8];
      const lum = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab, inv = lum > 1e-7 ? 1 / lum : 0;
      const bx = 0.2126 * F[s + 1] + 0.7152 * F[s + 5] + 0.0722 * F[s + 9];
      const by = 0.2126 * F[s + 2] + 0.7152 * F[s + 6] + 0.0722 * F[s + 10];
      const bz = 0.2126 * F[s + 3] + 0.7152 * F[s + 7] + 0.0722 * F[s + 11];
      out[pl * plane + p] = encA(ar, amax[1 + k]);
      out[(pl + 1) * plane + p] = encA(ag, amax[1 + k]);
      out[(pl + 2) * plane + p] = encA(ab, amax[1 + k]);
      out[(pl + 3) * plane + p] = encR(bx * inv);
      out[(pl + 4) * plane + p] = encR(by * inv);
      out[(pl + 5) * plane + p] = encR(bz * inv);
    }
  }
  // delta along x (rows of n bytes): smooth fields compress much better
  for (let r = out.length / n - 1; r >= 0; r--) {
    const o = r * n;
    for (let i = n - 1; i > 0; i--) out[o + i] = (out[o + i] - out[o + i - 1]) & 255;
  }
  return out;
}

/** Undo the delta coding and lay the planes out as the GPU input (sliceCount(keys) RGBA slices). */
export function planesToTexels(planes, count, n, keys) {
  for (let r = 0, rows = planes.length / n; r < rows; r++) {
    const o = r * n;
    for (let i = 1; i < n; i++) planes[o + i] = (planes[o + i] + planes[o + i - 1]) & 255;
  }
  const tex = new Uint8Array(sliceCount(keys) * count * 4);
  const put = (slice, ch, pl) => {
    const src = pl * count, dst = slice * count * 4 + ch;
    for (let p = 0; p < count; p++) tex[dst + p * 4] = planes[src + p];
  };
  for (let c = 0; c < 3; c++) for (let q = 0; q < 4; q++) put(c, q, c * 4 + q);
  for (let k = 0; k < keys; k++) {
    const s = 3 + k * 2, pl = 12 + k * 6;
    put(s, 0, pl); put(s, 1, pl + 1); put(s, 2, pl + 2); put(s, 3, pl + 3);
    put(s + 1, 0, pl + 4); put(s + 1, 1, pl + 5);
  }
  return tex;
}

/**
 * Runtime field: meta = gi/probes.json, bytes = gunzipped gi/probes.bin. Holds the GPU input
 * texels and samples them on the CPU (auto exposure, view model light).
 */
export class GIFieldData {
  constructor(meta, bytes) {
    this.meta = meta;
    const n = meta.n;
    this.n = n;
    this.cell = meta.cell;
    this.half = meta.size / 2;
    this.keys = meta.keys;
    this.amax = meta.amax;
    this.count = n * n * GI_LAYERS;
    const baseBytes = n * n * 4;
    this.base = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + baseBytes));
    const planes = new Uint8Array(bytes.buffer, bytes.byteOffset + baseBytes, planeCount(this.keys) * this.count);
    this.texels = planesToTexels(planes, this.count, n, this.keys);
  }

  /** Column base height (bilinear, same as the GPU sampler). */
  baseAt(x, z) {
    const n = this.n;
    const fx = Math.max(0, Math.min(n - 1, (x + this.half) / this.cell - 0.5));
    const fz = Math.max(0, Math.min(n - 1, (z + this.half) / this.cell - 0.5));
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz));
    const u = fx - i, v = fz - j, b = this.base;
    const k = j * n + i;
    return (b[k] * (1 - u) + b[k + 1] * u) * (1 - v) + (b[k + n] * (1 - u) + b[k + n + 1] * u) * v;
  }

  /** Decoded relit SH of one probe into out (12 floats, added with weight cw). */
  _probe(p, w, cw, out) {
    const tx = this.texels, C = this.count, amax = this.amax;
    for (let c = 0; c < 3; c++) {
      const o = (c * C + p) * 4, A = (tx[o] / 255) ** 2 * amax[0] * w.sky[c] * cw, k = c * 4;
      out[k] += A; out[k + 1] += A * decR(tx[o + 1]); out[k + 2] += A * decR(tx[o + 2]); out[k + 3] += A * decR(tx[o + 3]);
    }
    for (let q = 0; q < 2; q++) {
      const key = q ? w.kB : w.kA, f = (q ? w.f : 1 - w.f) * cw;
      if (f <= 0) continue;
      const o0 = ((3 + key * 2) * C + p) * 4, o1 = ((4 + key * 2) * C + p) * 4;
      const dx = decR(tx[o0 + 3]), dy = decR(tx[o1]), dz = decR(tx[o1 + 1]), am = amax[1 + key];
      for (let c = 0; c < 3; c++) {
        const A = (tx[o0 + c] / 255) ** 2 * am * w.sun[c] * f, k = c * 4;
        out[k] += A; out[k + 1] += A * dx; out[k + 2] += A * dy; out[k + 3] += A * dz;
      }
    }
  }

  /**
   * Relit irradiance SH at a world point -> out (Float32Array(12): [A, Bx, By, Bz] x RGB).
   * w = { sky: [r, g, b], sun: [r, g, b], kA, kB, f } (GI.weights).
   */
  sample(x, y, z, w, out) {
    const n = this.n, L = GI_LAYERS;
    const fx = Math.max(0, Math.min(n - 1, (x + this.half) / this.cell - 0.5));
    const fz = Math.max(0, Math.min(n - 1, (z + this.half) / this.cell - 0.5));
    const i0 = Math.min(n - 2, Math.floor(fx)), j0 = Math.min(n - 2, Math.floor(fz));
    const u = fx - i0, v = fz - j0;
    const lc = layerCoord(y - this.baseAt(x, z));
    const l0 = Math.min(L - 2, Math.floor(lc)), s = lc - l0;
    out.fill(0);
    for (let corner = 0; corner < 8; corner++) {
      const di = corner & 1, dj = (corner >> 1) & 1, dl = corner >> 2;
      const cw = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dl ? s : 1 - s);
      if (cw > 0) this._probe(((l0 + dl) * n + j0 + dj) * n + i0 + di, w, cw, out);
    }
    return out;
  }

  /** Relit SH of one probe (column i, j, layer l) -> out. */
  probe(i, j, l, w, out) {
    out.fill(0);
    this._probe((l * this.n + j) * this.n + i, w, 1, out);
    return out;
  }
}

/** Irradiance of an SH sample (12 floats) for a normal (nx, ny, nz) -> [r, g, b]. */
export function evalSH(sh, nx, ny, nz, out = [0, 0, 0]) {
  for (let c = 0; c < 3; c++) {
    const k = c * 4;
    out[c] = Math.max(0, sh[k] + sh[k + 1] * nx + sh[k + 2] * ny + sh[k + 3] * nz);
  }
  return out;
}

/** Linear luminance. */
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
