// GI bake worker: traces the probes handed out through a shared job counter. Pass 0 computes the
// direct terms (sky seen through the gaps, first sun bounce per key, with shadow rays) and flags
// probes stuck inside geometry; pass >= 1 adds one more bounce by reading the previous field at
// every ray hit. Results go straight into shared Float32 fields (S = terms * 12 floats per probe).
import { parentPort, workerData } from 'node:worker_threads';
import { traceScene, hitSurface, meshView, heightfieldView, HIT, HIT_N, HIT_C } from './bvh.js';
import { GI_LAYERS, layerCoord, buildVolumeIndex, volumeAt } from '../../../src/engine/render/GIField.js';

const W = workerData;
const scene = { hf: heightfieldView(W.hf), F: new Float32Array(W.tlas), U: new Uint32Array(W.tlas), I: new Float32Array(W.inst), meshes: W.meshes.map(meshView) };
const probePos = new Float32Array(W.probePos);
const active = new Uint8Array(W.active);
const valid = new Uint8Array(W.valid);
const base = new Float32Array(W.base);
const job = new Int32Array(W.job);
const { n, cell, half, terms: T, rays: N, seaLevel, ocean, transmission: TAU } = W;
const S = T * 12;
// interior volumes: probes after the world grid (worldCount), atlas order (GIField.js)
const vols = W.vols?.length ? { list: W.vols, size: W.size, index: buildVolumeIndex(W.vols, W.size) } : null;
const atlas = W.atlas, PW = W.worldCount;
const VA = { v: null, f: [0, 0, 0], fade: 0 };
const EV = new Float64Array(T * 3);
const KEYS = W.keyDirs;
const K = KEYS.length;
const CHUNK = 64;
const INV_PI = 1 / Math.PI;
const W0 = Math.PI / N, W1 = (2 * Math.PI) / N; // SH L0 / L1 weights, cosine lobe folded in (see GIField)

// Fibonacci sphere directions
const fib = new Float64Array(N * 3);
for (let i = 0; i < N; i++) {
  const y = 1 - (2 * i + 1) / N, r = Math.sqrt(1 - y * y), phi = i * 2.399963229728653;
  fib[i * 3] = Math.cos(phi) * r; fib[i * 3 + 1] = y; fib[i * 3 + 2] = Math.sin(phi) * r;
}

const acc = new Float64Array(S);
const L = new Float64Array(T * 3); // radiance per term and channel for the current ray
const E = new Float64Array(T * 3);
const R = new Float64Array(9);

function rotation(p) {
  // uniform random rotation (Shoemake) from a hash of the probe index
  let h = (p * 2654435761) >>> 0;
  const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  const u1 = rnd(), u2 = rnd() * Math.PI * 2, u3 = rnd() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  const x = a * Math.sin(u2), y = a * Math.cos(u2), z = b * Math.sin(u3), w = b * Math.cos(u3);
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
  R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
  R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
}

/** Irradiance of every term / channel of `field` at a point for a normal -> E (clamped >= 0). */
function evalField(field, x, y, z, nx, ny, nz) {
  const fx = Math.max(0, Math.min(n - 1, (x + half) / cell - 0.5));
  const fz = Math.max(0, Math.min(n - 1, (z + half) / cell - 0.5));
  const i0 = Math.min(n - 2, Math.floor(fx)), j0 = Math.min(n - 2, Math.floor(fz));
  const u = fx - i0, v = fz - j0;
  const k = j0 * n + i0;
  const b = (base[k] * (1 - u) + base[k + 1] * u) * (1 - v) + (base[k + n] * (1 - u) + base[k + n + 1] * u) * v;
  const lc = layerCoord(y - b);
  const l0 = Math.min(GI_LAYERS - 2, Math.floor(lc)), s = lc - l0;
  E.fill(0);
  for (let c8 = 0; c8 < 8; c8++) {
    const di = c8 & 1, dj = (c8 >> 1) & 1, dl = c8 >> 2;
    const w = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dl ? s : 1 - s);
    if (w <= 0) continue;
    const o = (((l0 + dl) * n + j0 + dj) * n + i0 + di) * S;
    for (let q = 0, e = 0; q < S; q += 4, e++) E[e] += w * (field[o + q] + field[o + q + 1] * nx + field[o + q + 2] * ny + field[o + q + 3] * nz);
  }
  for (let e = 0; e < T * 3; e++) if (E[e] < 0) E[e] = 0;
  // inside an interior volume: its probes, faded into the world field at the box faces
  const a = volumeAt(vols, x, y, z, VA);
  if (!a) return;
  const vol = a.v, f = a.f;
  const x0 = Math.max(0, Math.min(vol.res[0] - 2, Math.floor(f[0]))), y0 = Math.max(0, Math.min(vol.res[1] - 2, Math.floor(f[1]))), z0 = Math.max(0, Math.min(vol.res[2] - 2, Math.floor(f[2])));
  const fu = f[0] - x0, ft = f[1] - y0, fs = f[2] - z0;
  EV.fill(0);
  for (let c8 = 0; c8 < 8; c8++) {
    const dx = c8 & 1, dy = (c8 >> 1) & 1, dz = c8 >> 2;
    const w = (dx ? fu : 1 - fu) * (dy ? ft : 1 - ft) * (dz ? fs : 1 - fs);
    if (w <= 0) continue;
    const xi = Math.min(vol.res[0] - 1, x0 + dx), yi = Math.min(vol.res[1] - 1, y0 + dy), zi = Math.min(vol.res[2] - 1, z0 + dz);
    const o = (PW + (yi * atlas.ah + vol.at[1] + zi) * atlas.aw + vol.at[0] + xi) * S;
    for (let q = 0, e = 0; q < S; q += 4, e++) EV[e] += w * (field[o + q] + field[o + q + 1] * nx + field[o + q + 2] * ny + field[o + q + 3] * nz);
  }
  for (let e = 0; e < T * 3; e++) E[e] += (Math.max(0, EV[e]) - E[e]) * a.fade;
}

let stats;

function traceProbe(p, pass, out, prev) {
  acc.fill(0);
  rotation(p);
  const ox = probePos[p * 3], oy = probePos[p * 3 + 1], oz = probePos[p * 3 + 2];
  let back = 0;
  for (let r = 0; r < N; r++) {
    const fx = fib[r * 3], fy = fib[r * 3 + 1], fz = fib[r * 3 + 2];
    const dx = R[0] * fx + R[1] * fy + R[2] * fz, dy = R[3] * fx + R[4] * fy + R[5] * fz, dz = R[6] * fx + R[7] * fy + R[8] * fz;
    let t = traceScene(scene, ox, oy, oz, dx, dy, dz, 1e-3, 5000, false);
    stats.rays++;
    let nx = 0, ny = 1, nz = 0, cr, cg, cb, leaf = false;
    // the open sea: a plane at sea level (terrain under it is never reached)
    const tw = dy < 0 && oy > seaLevel ? (seaLevel - oy) / dy : -1;
    if (tw > 0 && (t < 0 || tw < t)) {
      t = tw;
      cr = ocean[0]; cg = ocean[1]; cb = ocean[2];
    } else if (t < 0) {
      if (pass === 0 && dy > 0) {
        // sky term: uniform white sky of radiance 1
        acc[0] += W0; acc[1] += dx * W1; acc[2] += dy * W1; acc[3] += dz * W1;
        acc[4] += W0; acc[5] += dx * W1; acc[6] += dy * W1; acc[7] += dz * W1;
        acc[8] += W0; acc[9] += dx * W1; acc[10] += dy * W1; acc[11] += dz * W1;
      }
      continue;
    } else {
      const doubleSided = hitSurface(scene, dx, dy, dz);
      if (HIT.back && !doubleSided) { back++; continue; }
      nx = HIT_N[0]; ny = HIT_N[1]; nz = HIT_N[2];
      cr = HIT_C[0]; cg = HIT_C[1]; cb = HIT_C[2];
      // foliage (green, double sided) lets light through: what lights its other side shows here
      leaf = doubleSided && TAU > 0 && cg > cr * 1.3 && cg > cb;
    }
    const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
    L.fill(0);
    let lit = false;
    if (pass === 0) {
      // first sun bounce for each key direction
      for (let k = 0; k < K; k++) {
        const l = KEYS[k];
        const ndl = nx * l[0] + ny * l[1] + nz * l[2];
        if (ndl <= 0 && !(leaf && ndl < 0)) continue;
        const side = ndl > 0 ? 0.03 : -0.03;
        stats.shadow++;
        if (traceScene(scene, hx + nx * side, hy + ny * side, hz + nz * side, l[0], l[1], l[2], 1e-3, 3000, true) >= 0) continue;
        const f = (ndl > 0 ? ndl : -ndl * TAU) * INV_PI, o = (1 + k) * 3;
        L[o] = cr * f; L[o + 1] = cg * f; L[o + 2] = cb * f;
        lit = true;
      }
    } else {
      // one more bounce: what the previous field says lands on the hit surface
      evalField(prev, hx + nx * 0.05, hy + ny * 0.05, hz + nz * 0.05, nx, ny, nz);
      for (let q = 0; q < T * 3; q++) L[q] = E[q];
      if (leaf) {
        evalField(prev, hx - nx * 0.05, hy - ny * 0.05, hz - nz * 0.05, -nx, -ny, -nz);
        for (let q = 0; q < T * 3; q++) L[q] += E[q] * TAU;
      }
      for (let q = 0; q < T; q++) {
        const o = q * 3;
        L[o] *= cr * INV_PI; L[o + 1] *= cg * INV_PI; L[o + 2] *= cb * INV_PI;
      }
      lit = true;
    }
    if (!lit) continue;
    for (let q = 0; q < T; q++) {
      for (let c = 0; c < 3; c++) {
        const li = L[q * 3 + c];
        if (li === 0) continue;
        const o = q * 12 + c * 4;
        acc[o] += li * W0; acc[o + 1] += li * dx * W1; acc[o + 2] += li * dy * W1; acc[o + 3] += li * dz * W1;
      }
    }
  }
  const o = p * S;
  for (let q = 0; q < S; q++) out[o + q] = acc[q];
  if (pass === 0) valid[p] = back < N * 0.25 ? 1 : 0;
}

parentPort.on('message', ({ pass, out, prev }) => {
  const outF = new Float32Array(out), prevF = prev ? new Float32Array(prev) : null;
  const count = probePos.length / 3;
  stats = { rays: 0, shadow: 0, probes: 0 };
  for (;;) {
    const start = Atomics.add(job, 0, CHUNK);
    if (start >= count) break;
    const end = Math.min(count, start + CHUNK);
    for (let p = start; p < end; p++) {
      if (!active[p]) continue;
      traceProbe(p, pass, outF, prevF);
      stats.probes++;
    }
    Atomics.add(job, 1, end - start); // progress
  }
  parentPort.postMessage({ done: true, stats });
});
