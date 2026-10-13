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
//
// Interior volumes (optional, `volumes` in gi/probes.json): boxes declared by assets (`gi.volumes`,
// docs/GI.md) and baked for every placed entity, each a small grid of probes at cell centres
// (`res` per axis). They are packed side by side in an atlas (aw x ah columns, ad layers; volume v
// at columns at[0].., rows at[1]..) laid out like the world field (probe = (y * ah + row) * aw +
// col), and stored after the world planes in the same plane encoding with their own amax. A point
// inside a box uses the volume (faded into the world field over `blend` m at the faces): the
// coarse world grid leaks the outdoor sky through walls, the volume doesn't.

export const GI_VERSION = 2;
export const GI_LAYERS = 4;
export const GI_H0 = 1.5;
export const GI_RATIO = 2.5;
export const GI_KEYS = 7;
const LOG2_RATIO = Math.log2(GI_RATIO);

export const GI_VOL_CELL = 2; // m: cells of the volume index (which volume covers a point)
export const GI_VOL_DEFAULTS = { spacing: 1.25, blend: 0.1, bias: 0.25 };
export const GI_VOL_MAX_PROBES = 2000; // per asset
const VOL_ATLAS_WIDTH = 256; // WebGL2 guarantees 3D textures up to 256

export const layerHeight = (l) => GI_H0 * GI_RATIO ** l;
export const planeCount = (keys) => 12 + keys * 6;
export const sliceCount = (keys) => 3 + keys * 2;

/** Fractional layer [0, GI_LAYERS - 1] of a point `t` metres above the column base. */
export function layerCoord(t) {
  const l = Math.log2(Math.max(t, GI_H0) / GI_H0) / LOG2_RATIO;
  return l < GI_LAYERS - 1 ? l : GI_LAYERS - 1;
}

// --- interior volumes ---------------------------------------------------------------------------
/** Probe counts per axis of an asset volume ({ size, spacing }). */
export function volumeRes(size, spacing = GI_VOL_DEFAULTS.spacing) {
  return size.map((s) => Math.max(1, Math.round(s / spacing)));
}

/** Errors of an asset's `gi` block ([] when fine). */
export function validateGIVolumes(gi) {
  if (gi == null) return [];
  const err = [];
  if (!Array.isArray(gi.volumes)) return ['gi.volumes must be an array'];
  let total = 0;
  gi.volumes.forEach((v, i) => {
    const ok3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    if (!ok3(v.size) || v.size.some((x) => x <= 0)) err.push(`gi.volumes[${i}]: size must be 3 positive numbers`);
    if (v.pos != null && !ok3(v.pos)) err.push(`gi.volumes[${i}]: pos must be 3 numbers`);
    if (v.rot != null && (!ok3(v.rot) || v.rot[0] || v.rot[2])) err.push(`gi.volumes[${i}]: rot is about Y only ([0, deg, 0])`);
    for (const k of ['spacing', 'blend', 'bias']) if (v[k] != null && !(v[k] >= 0)) err.push(`gi.volumes[${i}]: ${k} must be >= 0`);
    if (v.spacing === 0) err.push(`gi.volumes[${i}]: spacing must be > 0`);
    if (ok3(v.size)) total += volumeRes(v.size, v.spacing).reduce((a, b) => a * b, 1);
  });
  if (total > GI_VOL_MAX_PROBES) err.push(`gi.volumes: ${total} probes (max ${GI_VOL_MAX_PROBES}): raise spacing`);
  return err;
}

/**
 * World volume of an entity's asset volume. m = the entity's matrix elements (column major,
 * rotation about Y + scale, as entityMatrix), v = the asset volume. -> { c, yaw, size, res, blend, bias }
 */
export function placeVolume(m, v) {
  const p = v.pos ?? [0, 0, 0];
  const c = [0, 1, 2].map((a) => m[a] * p[0] + m[4 + a] * p[1] + m[8 + a] * p[2] + m[12 + a]);
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  // yaw of the entity (x axis -> (cos, -sin) in x / z, like three's rotation about Y) + the volume's
  const yaw = Math.atan2(-m[2], m[0]) + ((v.rot?.[1] ?? 0) * Math.PI) / 180;
  return {
    c, yaw, size: [v.size[0] * sx, v.size[1] * sy, v.size[2] * sz], res: volumeRes(v.size, v.spacing),
    blend: v.blend ?? GI_VOL_DEFAULTS.blend, bias: v.bias ?? GI_VOL_DEFAULTS.bias,
  };
}

/** Shelf-pack volumes into the atlas: sets v.at = [col, row] and returns { aw, ah, ad }. */
export function packVolumes(list) {
  let x = 0, y = 0, shelf = 0, aw = 1, ad = 1;
  for (const v of list) {
    const [nx, ny, nz] = v.res;
    if (x + nx > VOL_ATLAS_WIDTH) { x = 0; y += shelf; shelf = 0; }
    v.at = [x, y];
    x += nx; shelf = Math.max(shelf, nz); aw = Math.max(aw, x); ad = Math.max(ad, ny);
  }
  return { aw, ah: Math.max(1, y + shelf), ad };
}

/** World position of probe (x, y, z) of a placed volume -> out [x, y, z]. */
export function volumeProbePos(v, x, y, z, out = [0, 0, 0]) {
  const lx = ((x + 0.5) / v.res[0] - 0.5) * v.size[0], ly = ((y + 0.5) / v.res[1] - 0.5) * v.size[1], lz = ((z + 0.5) / v.res[2] - 0.5) * v.size[2];
  const co = Math.cos(v.yaw), si = Math.sin(v.yaw);
  out[0] = v.c[0] + co * lx + si * lz; out[1] = v.c[1] + ly; out[2] = v.c[2] - si * lx + co * lz;
  return out;
}

/**
 * Index grid of the volumes (GI_VOL_CELL m cells over the island): volume index + 1, 0 = none.
 * A cell takes the volume that covers most of it.
 */
export function buildVolumeIndex(list, size) {
  const n = Math.ceil(size / GI_VOL_CELL), half = size / 2, idx = new Uint16Array(n * n), best = new Float32Array(n * n);
  list.forEach((v, k) => {
    const co = Math.cos(v.yaw), si = Math.sin(v.yaw), hx = v.size[0] / 2, hz = v.size[2] / 2;
    const ex = Math.abs(co) * hx + Math.abs(si) * hz, ez = Math.abs(si) * hx + Math.abs(co) * hz;
    const i0 = Math.max(0, Math.floor((v.c[0] - ex + half) / GI_VOL_CELL)), i1 = Math.min(n - 1, Math.floor((v.c[0] + ex + half) / GI_VOL_CELL));
    const j0 = Math.max(0, Math.floor((v.c[2] - ez + half) / GI_VOL_CELL)), j1 = Math.min(n - 1, Math.floor((v.c[2] + ez + half) / GI_VOL_CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // coverage: share of 4x4 samples of the cell inside the box footprint
      let cov = 0;
      for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
        const px = (i + (a + 0.5) / 4) * GI_VOL_CELL - half - v.c[0], pz = (j + (b + 0.5) / 4) * GI_VOL_CELL - half - v.c[2];
        if (Math.abs(co * px - si * pz) <= hx && Math.abs(si * px + co * pz) <= hz) cov++;
      }
      const q = j * n + i;
      if (cov > best[q]) { best[q] = cov; idx[q] = k + 1; }
    }
  });
  return { n, idx };
}

/**
 * Where a world point falls in a volume: null outside, else { v, f: [fx, fy, fz] (fractional probe
 * coordinates, clamped), fade (1 inside, -> 0 at the faces over `blend`) }.
 */
export function volumeAt(vols, x, y, z, out = { v: null, f: [0, 0, 0], fade: 0 }) {
  if (!vols) return null;
  const half = vols.size / 2;
  const i = Math.floor((x + half) / GI_VOL_CELL), j = Math.floor((z + half) / GI_VOL_CELL);
  if (i < 0 || j < 0 || i >= vols.index.n || j >= vols.index.n) return null;
  const k = vols.index.idx[j * vols.index.n + i];
  if (!k) return null;
  const v = vols.list[k - 1];
  const px = x - v.c[0], py = y - v.c[1], pz = z - v.c[2];
  const co = Math.cos(v.yaw), si = Math.sin(v.yaw);
  const q = [co * px - si * pz, py, si * px + co * pz];
  let m = Infinity;
  for (let a = 0; a < 3; a++) {
    const h = v.size[a] / 2;
    m = Math.min(m, h - Math.abs(q[a]));
    out.f[a] = Math.max(0, Math.min(v.res[a] - 1, ((q[a] + h) / v.size[a]) * v.res[a] - 0.5));
  }
  if (m <= 0) return null;
  out.v = v;
  out.fade = v.blend > 0 ? Math.min(1, m / v.blend) : 1;
  return out;
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
    const planeBytes = planeCount(this.keys) * this.count;
    const planes = new Uint8Array(bytes.buffer, bytes.byteOffset + baseBytes, planeBytes);
    this.texels = planesToTexels(planes, this.count, n, this.keys);
    this.vols = null;
    const vm = meta.volumes;
    if (vm?.list?.length) {
      const count = vm.aw * vm.ah * vm.ad;
      const vp = new Uint8Array(bytes.buffer, bytes.byteOffset + baseBytes + planeBytes, planeCount(this.keys) * count);
      this.vols = { ...vm, size: meta.size, count, texels: planesToTexels(vp, count, vm.aw, this.keys), index: buildVolumeIndex(vm.list, meta.size) };
    }
    this._va = { v: null, f: [0, 0, 0], fade: 0 };
    this._vsh = new Float32Array(12);
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
  _probe(p, w, cw, out, tx = this.texels, C = this.count, amax = this.amax) {
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
    this._sampleWorld(x, y, z, w, out);
    const a = this.useVolumes === false ? null : volumeAt(this.vols, x, y, z, this._va);
    if (!a) return out;
    const V = this.vols, v = a.v, f = a.f, vs = this._vsh;
    const x0 = Math.min(v.res[0] - 2, Math.floor(f[0])), y0 = Math.min(v.res[1] - 2, Math.floor(f[1])), z0 = Math.min(v.res[2] - 2, Math.floor(f[2]));
    vs.fill(0);
    for (let corner = 0; corner < 8; corner++) {
      const dx = corner & 1, dy = (corner >> 1) & 1, dz = corner >> 2;
      // single-probe axes (res 1): both corners on the same probe
      const xi = Math.max(0, x0 + dx), yi = Math.max(0, y0 + dy), zi = Math.max(0, z0 + dz);
      const u = f[0] - Math.max(0, x0), t = f[1] - Math.max(0, y0), s = f[2] - Math.max(0, z0);
      const cw = (dx ? u : 1 - u) * (dy ? t : 1 - t) * (dz ? s : 1 - s);
      if (cw > 0) this._probe((yi * V.ah + v.at[1] + zi) * V.aw + v.at[0] + xi, w, cw, vs, V.texels, V.count, V.amax);
    }
    for (let k = 0; k < 12; k++) out[k] += (vs[k] - out[k]) * a.fade;
    return out;
  }

  _sampleWorld(x, y, z, w, out) {
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

  /** Relit SH of probe (x, y, z) of interior volume v (an entry of vols.list) -> out. */
  volumeProbe(v, x, y, z, w, out) {
    const V = this.vols;
    out.fill(0);
    this._probe((y * V.ah + v.at[1] + z) * V.aw + v.at[0] + x, w, 1, out, V.texels, V.count, V.amax);
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
