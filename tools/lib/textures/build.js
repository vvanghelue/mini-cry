// Texture array builder (mc textures build). Reads the CC0 sources downloaded by `mc textures
// fetch` (.tex-cache/) and writes, per group of public/data/textures.json, one tall strip image
// per map (every layer stacked vertically, uploaded as a 2D texture array by
// src/engine/render/Surfaces.js):
//   terrain:  terrain_albedo.webp (RGB albedo with the AO baked in, A = height for height-blended
//             splatting, kept >= 40 / 255) + terrain_normal.jpg (RG = normal xy, B = roughness)
//   surfaces: surfaces_albedo.webp + surfaces_normal.jpg (same packing, A unused)
//   foliage:  foliage_albedo.webp (RGBA, A = opacity), atlases composed from ambientCG leaf /
//             grass scans: leaf clusters, a tiling leaf mass, palm frond, fern frond, grass tuft,
//             single leaves, flowers. Images are authored tip-up (base / stem at the bottom).
// Each layer gets its mean linear albedo (`mean`) and roughness written back into the manifest:
// the shaders divide by it, so the asset / terrain colours keep driving the look and the textures
// add the detail.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { mulberry32, hashString } from '../../../src/engine/math/random.js';
import { ROOT } from '../data.js';
import { CACHE } from '../texture-commands.js';

const OUT = path.join(ROOT, 'public', 'textures');
// degrees (clockwise) that turn a scan tip-up
const SCAN_ROTATE = { LeafSet023: -90, Foliage008: -90 };
const lerp = (a, b, t) => a + (b - a) * t;
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = Float32Array.from({ length: 256 }, (_, i) => toLin(i));

// ------------------------------------------------------------------------------------- helpers
async function rawRGB(file, w, h) {
  const { data } = await sharp(file).removeAlpha().toColourspace('srgb').resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  return data;
}
async function rawGrey(file, w, h) {
  const { data, info } = await sharp(file).resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return data;
  const out = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * info.channels];
  return out;
}
async function rawChannel(file, w, h, ch) {
  const { data, info } = await sharp(file).resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * info.channels + Math.min(ch, info.channels - 1)];
  return out;
}

/** Mean linear RGB (alpha-weighted when rgba) of a raw buffer. */
function meanLinear(buf, channels, alphaWeighted) {
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < buf.length; i += channels) {
    const k = alphaWeighted ? (buf[i + 3] > 127 ? 1 : 0) : 1;
    if (!k) continue;
    r += LIN[buf[i]]; g += LIN[buf[i + 1]]; b += LIN[buf[i + 2]]; w++;
  }
  w = Math.max(1, w);
  return [r / w, g / w, b / w].map((x) => +x.toFixed(4));
}

/** Pull-push: fill the RGB of transparent texels with the colour of the nearby opaque ones, so
 *  mipmaps (and bilinear filtering at cut-out edges) don't bleed black / white fringes. */
function bleedRGB(buf, S) {
  let lv = { w: S, h: S, c: new Float32Array(S * S * 3), a: new Float32Array(S * S) };
  for (let i = 0; i < S * S; i++) {
    const a = buf[i * 4 + 3] > 127 ? 1 : 0;
    lv.a[i] = a;
    for (let k = 0; k < 3; k++) lv.c[i * 3 + k] = buf[i * 4 + k] * a;
  }
  const levels = [lv];
  while (lv.w > 1) {
    const w = lv.w >> 1, h = lv.h >> 1, n = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0; const c = [0, 0, 0];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const j = (y * 2 + dy) * lv.w + x * 2 + dx;
        a += lv.a[j]; for (let k = 0; k < 3; k++) c[k] += lv.c[j * 3 + k];
      }
      const o = y * w + x;
      n.a[o] = a / 4; for (let k = 0; k < 3; k++) n.c[o * 3 + k] = c[k] / 4;
    }
    levels.push(n);
    lv = n;
  }
  // push: unnormalised premultiplied colour / coverage, coarse levels fill the holes of finer ones
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const o = y * f.w + x, co = Math.min(c.h - 1, y >> 1) * c.w + Math.min(c.w - 1, x >> 1);
      const ca = c.a[co];
      if (f.a[o] >= 0.999 || ca <= 0) continue;
      const k = 1 - f.a[o];
      for (let q = 0; q < 3; q++) f.c[o * 3 + q] += (c.c[co * 3 + q] / ca) * k;
      f.a[o] = 1;
    }
  }
  const top = levels[0];
  for (let i = 0; i < S * S; i++) {
    if (buf[i * 4 + 3] > 127) continue;
    for (let k = 0; k < 3; k++) buf[i * 4 + k] = Math.max(0, Math.min(255, Math.round(top.c[i * 3 + k] / Math.max(top.a[i], 1e-6))));
  }
}

// ------------------------------------------------------------------------------------- PBR layers
async function pbrLayer(L, S, NS, { height }) {
  const dir = path.join(CACHE, 'polyhaven', L.polyhaven);
  const f = (n) => path.join(dir, n + '.jpg');
  if (!fs.existsSync(f('diff'))) throw new Error(`missing ${L.polyhaven}: run \`npm run mc -- textures fetch\``);
  const rgb = await rawRGB(f('diff'), S, S);
  const ao = fs.existsSync(f('arm')) ? await rawChannel(f('arm'), S, S, 0) : null;
  const disp = height && fs.existsSync(f('disp')) ? await rawGrey(f('disp'), S, S) : null;
  let dmin = 255, dmax = 0;
  if (disp) for (const v of disp) { if (v < dmin) dmin = v; if (v > dmax) dmax = v; }
  const out = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const k = ao ? Math.sqrt(ao[i] / 255) * 0.6 + 0.4 : 1; // cavity AO, softened (the SSAO does the rest)
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(rgb[i * 3 + c] * k);
    out[i * 4 + 3] = disp ? Math.round(40 + 215 * ((disp[i] - dmin) / Math.max(1, dmax - dmin))) : 255;
  }
  const nrm = fs.existsSync(f('nor')) ? await rawRGB(f('nor'), NS, NS) : null;
  const rough = fs.existsSync(f('arm')) ? await rawChannel(f('arm'), NS, NS, 1) : null;
  const n = Buffer.alloc(NS * NS * 3);
  let rsum = 0;
  for (let i = 0; i < NS * NS; i++) {
    n[i * 3] = nrm ? nrm[i * 3] : 128;
    n[i * 3 + 1] = nrm ? nrm[i * 3 + 1] : 128;
    n[i * 3 + 2] = rough ? rough[i] : 200;
    rsum += n[i * 3 + 2];
  }
  return { albedo: out, normal: n, mean: meanLinear(out, 4, false), roughness: +(rsum / (NS * NS) / 255).toFixed(3) };
}

function plainLayer(L, S, NS, rng) {
  const out = Buffer.alloc(S * S * 4), n = Buffer.alloc(NS * NS * 3);
  // fine grain + soft blotches (keeps flat-coloured parts from looking like plastic)
  const blot = new Float32Array(16 * 16).map(() => rng());
  const at = (x, y) => {
    const fx = (x / S) * 16, fy = (y / S) * 16, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const g = (a, b) => blot[((b + 16) % 16) * 16 + ((a + 16) % 16)];
    return lerp(lerp(g(i, j), g(i + 1, j), u), lerp(g(i, j + 1), g(i + 1, j + 1), u), v);
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = Math.round(128 * (0.92 + at(x, y) * 0.12 + (rng() - 0.5) * 0.06));
    const i = (y * S + x) * 4;
    out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
  const r = Math.round((L.roughness ?? 0.6) * 255);
  for (let i = 0; i < NS * NS; i++) { n[i * 3] = 128; n[i * 3 + 1] = 128; n[i * 3 + 2] = r; }
  return { albedo: out, normal: n, mean: meanLinear(out, 4, false), roughness: L.roughness ?? 0.6 };
}

// ------------------------------------------------------------------------------------- leaf scans
const scanCache = new Map();
/** Individual leaves / blades of an ambientCG atlas: [{ data (RGBA), w, h, area }], tip-up. */
async function scanLeaves(id) {
  if (scanCache.has(id)) return scanCache.get(id);
  const dir = path.join(CACHE, 'ambientcg', id);
  if (!fs.existsSync(path.join(dir, 'color.png'))) throw new Error(`missing ${id}: run \`npm run mc -- textures fetch\``);
  const meta = await sharp(path.join(dir, 'color.png')).metadata();
  const W = meta.width, H = meta.height;
  const rgb = await rawRGB(path.join(dir, 'color.png'), W, H);
  const op = await rawGrey(path.join(dir, 'opacity.png'), W, H);
  let rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = op[i]; }
  let w = W, h = H;
  if (SCAN_ROTATE[id]) {
    const r = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).rotate(SCAN_ROTATE[id]).raw().toBuffer({ resolveWithObject: true });
    rgba = r.data; w = r.info.width; h = r.info.height;
  }
  // connected components on an 8x coarser coverage grid
  const F = 8, cw = Math.ceil(w / F), ch = Math.ceil(h / F);
  const cov = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4 + 3] > 100) cov[Math.floor(y / F) * cw + Math.floor(x / F)] = 1;
  const label = new Int32Array(cw * ch);
  const comps = [];
  for (let s = 0; s < cw * ch; s++) {
    if (!cov[s] || label[s]) continue;
    const id2 = comps.length + 1, stack = [s];
    label[s] = id2;
    const c = { id: id2, x0: cw, y0: ch, x1: 0, y1: 0, area: 0 };
    while (stack.length) {
      const p = stack.pop(), px = p % cw, py = (p - px) / cw;
      c.area++; c.x0 = Math.min(c.x0, px); c.x1 = Math.max(c.x1, px); c.y0 = Math.min(c.y0, py); c.y1 = Math.max(c.y1, py);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const q = ny * cw + nx;
        if (cov[q] && !label[q]) { label[q] = id2; stack.push(q); }
      }
    }
    comps.push(c);
  }
  const big = Math.max(...comps.map((c) => c.area));
  const leaves = [];
  for (const c of comps) {
    if (c.area < big * 0.08) continue; // specks
    const x0 = Math.max(0, (c.x0 - 1) * F), y0 = Math.max(0, (c.y0 - 1) * F), x1 = Math.min(w, (c.x1 + 2) * F), y1 = Math.min(h, (c.y1 + 2) * F);
    const lw = x1 - x0, lh = y1 - y0, data = Buffer.alloc(lw * lh * 4);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const sx = x0 + x, sy = y0 + y, si = (sy * w + sx) * 4, di = (y * lw + x) * 4;
      // keep the texels of this component (1 cell dilation), drop the neighbours' overlapping the box
      const gx = Math.floor(sx / F), gy = Math.floor(sy / F);
      let mine = false;
      for (let dy = -1; dy <= 1 && !mine; dy++) for (let dx = -1; dx <= 1 && !mine; dx++) {
        const qx = gx + dx, qy = gy + dy;
        if (qx >= 0 && qy >= 0 && qx < cw && qy < ch && label[qy * cw + qx] === c.id) mine = true;
      }
      if (!mine) continue;
      rgba.copy(data, di, si, si + 4);
    }
    leaves.push({ data, w: lw, h: lh, area: c.area });
  }
  leaves.sort((a, b) => b.area - a.area);
  scanCache.set(id, leaves);
  return leaves;
}

/** A leaf scaled to `len` px long, recoloured and turned by `deg` (clockwise): { input, left, top }
 *  placed so its stem (bottom centre before rotation) lands on (sx, sy). */
async function placeLeaf(leaf, len, deg, sx, sy, { brightness = 1, saturation = 1, hue = 0, aspect = 1 } = {}) {
  const hgt = Math.max(4, Math.round(len)), wid = Math.max(2, Math.round((leaf.w / leaf.h) * len * aspect));
  let img = sharp(leaf.data, { raw: { width: leaf.w, height: leaf.h, channels: 4 } }).resize(wid, hgt, { fit: 'fill' });
  if (brightness !== 1 || saturation !== 1 || hue) img = sharp(await img.raw().toBuffer(), { raw: { width: wid, height: hgt, channels: 4 } }).modulate({ brightness, saturation, hue: Math.round(hue) });
  const { data, info } = await sharp(await img.raw().toBuffer(), { raw: { width: wid, height: hgt, channels: 4 } }).rotate(deg, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).raw().toBuffer({ resolveWithObject: true });
  const t = (deg * Math.PI) / 180, hh = hgt / 2;
  const stemX = -hh * Math.sin(t), stemY = hh * Math.cos(t);
  return { input: data, raw: { width: info.width, height: info.height, channels: 4 }, left: Math.round(sx - info.width / 2 - stemX), top: Math.round(sy - info.height / 2 - stemY) };
}

/** Composite overlays on a padded transparent canvas and crop the S x S centre. */
async function compose(S, overlays, { pad = S, background = { r: 0, g: 0, b: 0, alpha: 0 }, svg } = {}) {
  const W = S + pad * 2;
  const list = [];
  if (svg) list.push({ input: Buffer.from(svg), left: 0, top: 0 });
  for (const o of overlays) {
    const left = o.left + pad, top = o.top + pad;
    if (left < 0 || top < 0 || left + o.raw.width > W || top + o.raw.height > W) continue;
    list.push({ ...o, left, top });
  }
  // (sharp extracts before compositing within one pipeline: two passes)
  const full = await sharp({ create: { width: W, height: W, channels: 4, background } }).composite(list).raw().toBuffer();
  return sharp(full, { raw: { width: W, height: W, channels: 4 } }).extract({ left: pad, top: pad, width: S, height: S }).raw().toBuffer();
}

const svgDoc = (W, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">${body}</svg>`;

// ------------------------------------------------------------------------------------- composers
const COMPOSERS = {
  /** Leafy branch tips seen from outside the crown: a dense spray of overlapping leaves over a
   *  disc (darker toward the core), a few twigs showing between them; soft, leafy outline. */
  async cluster(L, S, rng) {
    const leaves = (await scanLeaves(L.from)).slice(0, 8);
    const n = L.leaves ?? 60, pad = S, rmax = S * 0.34;
    const items = [];
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, r = rmax * Math.sqrt(rng());
      items.push({ a, r, sx: S / 2 + Math.cos(a) * r, sy: S / 2 + Math.sin(a) * r });
    }
    let svg = '';
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + rng(), r = rmax * (0.6 + rng() * 0.3);
      svg += `<path d="M ${S / 2 + pad} ${S / 2 + pad} Q ${S / 2 + pad + Math.cos(a + 0.3) * r * 0.5} ${S / 2 + pad + Math.sin(a + 0.3) * r * 0.5} ${S / 2 + pad + Math.cos(a) * r} ${S / 2 + pad + Math.sin(a) * r}" stroke="${L.twig ?? '#5a4632'}" stroke-width="${(S * 0.007).toFixed(1)}" fill="none" stroke-linecap="round"/>`;
    }
    const over = [];
    items.forEach((it, i) => (it.order = i / n));
    for (const it of items) {
      const len = S * lerp(L.leafSize[0], L.leafSize[1], rng()) * (0.85 + 0.25 * (it.r / rmax));
      // outward near the rim, any direction near the middle (covers the core)
      const spread = it.r < rmax * 0.45 ? 360 : 120;
      const deg = (it.a * 180) / Math.PI + 90 + (rng() - 0.5) * spread;
      const leaf = leaves[Math.floor(rng() * leaves.length)];
      // drawn first = under the others: darker
      over.push(await placeLeaf(leaf, len, deg, it.sx, it.sy, { brightness: 0.62 + 0.4 * it.order + rng() * 0.1, saturation: 0.9 + rng() * 0.2, hue: (rng() - 0.5) * 10 }));
    }
    return compose(S, over, { pad, svg: svgDoc(S + pad * 2, svg) });
  },

  /** Opaque, tiling mass of overlapping leaves (canopy cores, hedges). */
  async mass(L, S, rng) {
    const sets = await Promise.all([L.from].flat().map(scanLeaves));
    const pad = S, over = [];
    const n = L.leaves ?? 300;
    for (let i = 0; i < n; i++) {
      const set = sets[i % sets.length], leaf = set[Math.floor(rng() * Math.min(6, set.length))];
      const x = rng() * S, y = rng() * S, len = S * lerp(L.leafSize[0], L.leafSize[1], rng()), deg = rng() * 360;
      const depth = i / n; // drawn later = closer to the light
      const o = await placeLeaf(leaf, len, deg, x, y, { brightness: 0.45 + 0.6 * depth + rng() * 0.1, saturation: 0.85 + rng() * 0.2, hue: (rng() - 0.5) * 12 });
      // wrapped copies so the texture tiles
      for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
        const l = o.left + dx, t = o.top + dy;
        if (l + o.raw.width < 0 || t + o.raw.height < 0 || l > S || t > S) continue;
        over.push({ ...o, left: l, top: t });
      }
    }
    const bg = parseInt((L.background ?? '#1d2e12').slice(1), 16);
    return compose(S, over, { pad, background: { r: bg >> 16, g: (bg >> 8) & 255, b: bg & 255, alpha: 1 } });
  },

  /** Pinnate palm frond: rachis up the middle (base at the bottom), leaflets both sides. */
  async frond(L, S, rng) {
    const blades = (await scanLeaves(L.from)).slice(0, 7);
    const n = L.leaflets ?? 28, over = [];
    const svg = `<path d="M ${S / 2 + S} ${S * 2} L ${S / 2 + S} ${S}" stroke="${L.rachis ?? '#8b8a4a'}" stroke-width="${(S * 0.016).toFixed(1)}" fill="none"/>`;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, y = S * (1 - 0.02 - t * 0.96);
      const reach = Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)) ** 0.6;
      for (const side of [-1, 1]) {
        const phi = lerp(62, 38, t) + (rng() - 0.5) * 10;
        const len = (S * 0.5 * reach) / Math.sin((phi * Math.PI) / 180) * (0.88 + rng() * 0.16);
        const blade = blades[Math.floor(rng() * blades.length)];
        over.push(await placeLeaf(blade, len, side * phi, S / 2 + side * S * 0.004, y + (rng() - 0.5) * S * 0.01, { brightness: 0.82 + rng() * 0.3, saturation: 0.95 + rng() * 0.15, hue: (rng() - 0.5) * 8, aspect: 1.25 }));
      }
    }
    return compose(S, over, { pad: S, svg: svgDoc(S * 3, svg) });
  },

  /** Fern frond: rachis + pinnae, longest a third of the way up, shrinking to the tip. */
  async fern(L, S, rng) {
    const pinnae = (await scanLeaves(L.from)).slice(0, 6);
    const n = L.pinnae ?? 16, over = [];
    const svg = `<path d="M ${S * 1.5} ${S * 2} Q ${S * 1.5 + S * 0.02} ${S * 1.5} ${S * 1.5} ${S}" stroke="${L.rachis ?? '#4c6a2a'}" stroke-width="${(S * 0.012).toFixed(1)}" fill="none"/>`;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, y = S * (1 - 0.03 - t * 0.94);
      const prof = Math.min(1, (t + 0.08) * 3.2) * (1 - t) ** 0.85;
      for (const side of [-1, 1]) {
        const phi = lerp(80, 55, t) + (rng() - 0.5) * 8;
        const len = S * 0.62 * prof * (0.9 + rng() * 0.15);
        if (len < S * 0.03) continue;
        const p = pinnae[Math.floor(rng() * pinnae.length)];
        over.push(await placeLeaf(p, len, side * phi, S / 2, y, { brightness: 0.8 + rng() * 0.25, aspect: 0.8 }));
      }
    }
    return compose(S, over, { pad: S, svg: svgDoc(S * 3, svg) });
  },

  /** Grass tuft: blades fanning out of the bottom middle. */
  async grass(L, S, rng) {
    const sets = await Promise.all([L.from].flat().map(scanLeaves));
    const blades = sets.flatMap((s) => s.slice(0, 10)).filter((b) => b.h > b.w * 4);
    const n = L.blades ?? 40, over = [];
    for (let i = 0; i < n; i++) {
      const b = blades[Math.floor(rng() * blades.length)];
      const off = (rng() - 0.5) * 0.55;
      const len = S * lerp(0.5, 0.97, rng() ** 0.7);
      const deg = off * 70 + (rng() - 0.5) * 30;
      over.push(await placeLeaf(b, len, deg, S / 2 + off * S * 0.6, S * 0.995, { brightness: 0.7 + rng() * 0.45, saturation: 0.9 + rng() * 0.25, hue: (rng() - 0.5) * 14, aspect: 1.3 }));
    }
    return compose(S, over, { pad: S });
  },

  /** One leaf filling the layer (stretched): banana leaves, straps. */
  async leaf(L, S, rng) {
    const leaf = (await scanLeaves(L.from))[L.pick ?? 0];
    void rng;
    const m = Math.round(S * 0.01);
    const { data } = await sharp(leaf.data, { raw: { width: leaf.w, height: leaf.h, channels: 4 } }).resize(S - 2 * m, S - 2 * m, { fit: 'fill' }).extend({ top: m, bottom: m, left: m, right: m, background: { r: 0, g: 0, b: 0, alpha: 0 } }).raw().toBuffer({ resolveWithObject: true });
    return data;
  },

  /** A few five-petal flowers (near white: the part colour tints them). */
  async flowers(L, S, rng) {
    let body = '<defs><radialGradient id="p" cx="0.5" cy="0.9" r="0.9"><stop offset="0" stop-color="#d8c8b8"/><stop offset="0.35" stop-color="#f6efe9"/><stop offset="1" stop-color="#ffffff"/></radialGradient></defs>';
    const n = L.count ?? 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng(), d = i ? S * (0.18 + rng() * 0.18) : 0;
      const cx = S / 2 + Math.cos(a) * d, cy = S / 2 + Math.sin(a) * d, r = S * (0.1 + rng() * 0.05), rot = rng() * 72;
      for (let p = 0; p < 5; p++) body += `<ellipse cx="${cx}" cy="${cy - r * 0.55}" rx="${r * 0.42}" ry="${r * 0.62}" fill="url(#p)" transform="rotate(${rot + p * 72} ${cx} ${cy})"/>`;
      body += `<circle cx="${cx}" cy="${cy}" r="${r * 0.16}" fill="#b89a3a"/>`;
      for (let s = 0; s < 6; s++) body += `<circle cx="${cx + Math.cos(s) * r * 0.22}" cy="${cy + Math.sin(s) * r * 0.22}" r="${r * 0.04}" fill="#7a5a20"/>`;
    }
    const { data } = await sharp(Buffer.from(svgDoc(S, body))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return data;
  },
};

async function foliageLayer(L, S) {
  const rng = mulberry32(hashString(L.id) ^ 0x5bd1e995);
  const c = COMPOSERS[L.compose];
  if (!c) throw new Error(`unknown foliage composer "${L.compose}"`);
  const rgba = await c(L, S, rng);
  bleedRGB(rgba, S);
  return { albedo: rgba, mean: meanLinear(rgba, 4, true), roughness: L.roughness ?? 0.65 };
}

// ------------------------------------------------------------------------------------- packing
async function writeStrip(file, layers, S, channels, opts) {
  if (S * layers.length > 16383 && file.endsWith('.webp')) throw new Error(`${file}: ${layers.length} layers of ${S} px exceed the WebP height limit`);
  const buf = Buffer.concat(layers);
  let img = sharp(buf, { raw: { width: S, height: S * layers.length, channels } });
  img = file.endsWith('.jpg') ? img.jpeg({ quality: opts.quality + 6, chromaSubsampling: '4:4:4', mozjpeg: true }) : img.webp({ quality: opts.quality, alphaQuality: opts.alphaQuality ?? 100, effort: 5, smartSubsample: true });
  fs.mkdirSync(OUT, { recursive: true });
  await img.toFile(path.join(OUT, file));
  return fs.statSync(path.join(OUT, file)).size;
}

export async function buildTextures(manifest, { only, quality = 82, log = () => {} } = {}) {
  const sizes = {};
  for (const group of ['terrain', 'surfaces', 'foliage']) {
    if (only && only !== group) continue;
    if (!manifest[group]) continue;
    const G = manifest[group];
    const S = G.size, NS = G.normalSize ?? S;
    const albedo = [], normal = [];
    for (const L of G.layers) {
      log(`${group}/${L.id}`);
      const rng = mulberry32(hashString(L.id));
      const r = group === 'foliage' ? await foliageLayer(L, S) : L.generate === 'plain' ? plainLayer(L, S, NS, rng) : await pbrLayer(L, S, NS, { height: group === 'terrain' });
      albedo.push(r.albedo);
      if (r.normal) normal.push(r.normal);
      L.mean = r.mean;
      L.roughness = r.roughness;
    }
    G.files = { albedo: `textures/${group}_albedo.webp` };
    sizes[G.files.albedo] = await writeStrip(`${group}_albedo.webp`, albedo, S, 4, { quality, alphaQuality: group === 'terrain' ? 50 : 100 });
    if (normal.length) {
      G.files.normal = `textures/${group}_normal.jpg`;
      sizes[G.files.normal] = await writeStrip(`${group}_normal.jpg`, normal, NS, 3, { quality });
    }
  }
  // water ripples: one tiling normal map
  const wn = manifest.water?.normal;
  if (wn && (!only || only === 'water')) {
    const src = path.join(CACHE, 'water', 'normal.jpg');
    if (!fs.existsSync(src)) throw new Error('missing water normal map: run `npm run mc -- textures fetch`');
    await sharp(src).resize(wn.size ?? 512, wn.size ?? 512).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(path.join(OUT, 'water_normal.jpg'));
    manifest.water.files = { normal: 'textures/water_normal.jpg' };
    sizes['textures/water_normal.jpg'] = fs.statSync(path.join(OUT, 'water_normal.jpg')).size;
  }
  // cache-busting version from the packed files
  const h = crypto.createHash('sha1');
  for (const g of ['terrain', 'surfaces', 'foliage', 'water']) for (const f of Object.values(manifest[g]?.files ?? {})) if (fs.existsSync(path.join(ROOT, 'public', f))) h.update(fs.readFileSync(path.join(ROOT, 'public', f)));
  manifest.version = h.digest('hex').slice(0, 10);
  return { ok: true, version: manifest.version, bytes: sizes };
}
