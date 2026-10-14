// GI probe bake (Node): places the terrain-following probe grid, traces it on worker threads
// and the interior volumes of the placed assets (`gi.volumes`), traces them on worker threads
// (direct pass + N bounce passes), fixes probes stuck in geometry, and writes
// public/data/gi/probes.json + probes.bin (gzip). Format: src/engine/render/GIField.js.
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import * as THREE from 'three';
import { GI_VERSION, GI_LAYERS, GI_H0, GI_RATIO, GI_KEYS, layerHeight, keyDir, encodePlanes, placeVolume, packVolumes, volumeProbePos } from '../../../src/engine/render/GIField.js';
import { entityMatrix } from '../../../src/engine/world/Entities.js';
import { readJSON, readBin, dataPath, DATA } from '../data.js';
import { loadTerrain } from '../terrain.js';
import { loadAssetDefs } from '../commands.js';
import { buildBakeScene, ASSET_TYPES } from './scene.js';

export const GI_META = 'gi/probes.json';
export const GI_BIN = 'gi/probes.bin';
const SEA_MARGIN = 40; // m: sea columns farther than this from land copy one traced open-sea column
const OCEAN_ALBEDO = [0.02, 0.06, 0.08];

/**
 * Hash of what the bake depends on (to tell when it is stale): terrain, vegetation, the entities
 * drawn with a static asset, the assets they and the vegetation use, and the sun path tilt.
 */
export function giInputsHash() {
  const h = crypto.createHash('sha1');
  for (const f of ['terrain/terrain.json', 'terrain/height.bin', 'terrain/material.bin', 'vegetation.bin']) {
    try { h.update(fs.readFileSync(dataPath(f))); } catch { h.update('-'); }
  }
  // only what the bake reads of the species (gi/scene.js): LOD distances, impostors, scatter rules
  // don't change the light
  const species = readJSON('vegetation.json', { species: [] }).species ?? [];
  h.update(JSON.stringify(species.map((s) => [s.asset, s.castShadow ?? 0, s.variants ?? 1])));
  const world = readJSON('world.json', { entities: [] });
  const used = new Set((readJSON('vegetation.json', { species: [] }).species ?? []).map((s) => s.asset));
  for (const e of world.entities ?? []) {
    if (!(e.type in ASSET_TYPES) || e.disabled) continue;
    const asset = e.asset ?? ASSET_TYPES[e.type];
    used.add(asset);
    h.update(JSON.stringify([e.type, asset, e.pos, e.rot, e.scale]));
  }
  const assets = loadAssetDefs();
  // assets can embed others (parts with "asset": "name"): follow the references
  for (const name of used) {
    for (const m of JSON.stringify(assets[name] ?? null).matchAll(/"asset"\s*:\s*"([^"]+)"/g)) used.add(m[1]);
  }
  // light halos (`glow`) are drawn on top of the lighting: they don't change the bake
  for (const name of [...used].sort()) h.update(JSON.stringify(assets[name] ?? null, (k, v) => (k === 'glow' ? undefined : v)));
  h.update(String(readJSON('environment.json', {}).sunTilt ?? 0.45));
  return h.digest('hex').slice(0, 16);
}

export async function bakeGI({ rays = 128, bounces = 2, cell = 8, transmission = 0.8, workers = 0, log = () => {} } = {}) {
  const t0 = Date.now();
  const terrain = loadTerrain();
  const env = readJSON('environment.json', {});
  const tilt = env.sunTilt ?? 0.45;
  const world = readJSON('world.json', { entities: [] });
  const vegDef = readJSON('vegetation.json', { species: [] });
  let vegBytes = null;
  try { vegBytes = readBin('vegetation.bin'); } catch { /* none */ }
  const assets = loadAssetDefs();
  const scene = buildBakeScene({ terrain, assets, world, vegDef, vegBytes, log });
  const vols = collectVolumes(world, assets);

  // --- probe grid ----------------------------------------------------------------------------
  const size = terrain.size, half = size / 2, n = Math.round(size / cell);
  const PW = n * n * GI_LAYERS, T = 1 + GI_KEYS, S = T * 12;
  // interior volumes after the world grid, in atlas order (GIField.js)
  const atlas = packVolumes(vols);
  const VC = vols.length ? atlas.aw * atlas.ah * atlas.ad : 0, P = PW + VC;
  const sea = terrain.seaLevel;
  const base = new Float32Array(new SharedArrayBuffer(n * n * 4));
  const landy = new Uint8Array(n * n); // column has ground above the sea nearby
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
      let sum = 0, mx = -Infinity;
      for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
        const h = terrain.heightAt(x + (a * cell) / 5, z + (b * cell) / 5);
        sum += h; if (h > mx) mx = h;
      }
      base[j * n + i] = Math.max(sum / 25, terrain.waterLevelAt(x, z));
      landy[j * n + i] = mx > sea - 2 ? 1 : 0;
    }
  }
  // active columns: land, or sea within SEA_MARGIN of land (the rest is open sea)
  const R = Math.ceil(SEA_MARGIN / cell);
  const near = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (!landy[j * n + i]) continue;
    for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
      const x = i + a, y = j + b;
      if (x >= 0 && y >= 0 && x < n && y < n && a * a + b * b <= R * R) near[y * n + x] = 1;
    }
  }
  // reference open-sea column: fills the open sea and is the auto-exposure "open air" level
  let ref = null;
  for (let d = 0; d < n && !ref; d++) if (!near[d * n + d]) ref = { i: d, j: d };
  const probePos = new Float32Array(new SharedArrayBuffer(P * 12));
  const active = new Uint8Array(new SharedArrayBuffer(P));
  const valid = new Uint8Array(new SharedArrayBuffer(P));
  let activeCount = 0;
  for (let l = 0; l < GI_LAYERS; l++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const p = (l * n + j) * n + i;
        const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
        const y = Math.max(base[j * n + i] + layerHeight(l), terrain.heightAt(x, z) + 0.25);
        probePos[p * 3] = x; probePos[p * 3 + 1] = y; probePos[p * 3 + 2] = z;
        const on = near[j * n + i] || (ref && i === ref.i && j === ref.j);
        active[p] = on ? 1 : 0;
        valid[p] = 1;
        if (on) activeCount++;
      }
    }
  }
  let volProbes = 0;
  const vpos = [0, 0, 0];
  for (const v of vols) {
    for (let y = 0; y < v.res[1]; y++) for (let z = 0; z < v.res[2]; z++) for (let x = 0; x < v.res[0]; x++) {
      const p = PW + (y * atlas.ah + v.at[1] + z) * atlas.aw + v.at[0] + x;
      volumeProbePos(v, x, y, z, vpos);
      probePos.set(vpos, p * 3);
      active[p] = 1; valid[p] = 1;
      volProbes++;
    }
  }
  activeCount += volProbes;
  log(`probes: ${activeCount} traced of ${P} (${n}x${n}x${GI_LAYERS}, ${cell} m + ${vols.length} interior volumes: ${volProbes}), ${rays} rays, ${bounces} bounces`);

  // --- workers ---------------------------------------------------------------------------------
  const field = () => new SharedArrayBuffer(P * S * 4);
  const direct = field(), total = field(), bounce = field();
  const job = new Int32Array(new SharedArrayBuffer(8));
  const keyDirs = Array.from({ length: GI_KEYS }, (_, k) => keyDir(k, GI_KEYS, tilt));
  const nw = workers || Math.max(1, Math.min(16, (os.availableParallelism?.() ?? os.cpus().length) - 1));
  const data = { hf: scene.hf, tlas: scene.tlas, inst: scene.inst, meshes: scene.meshes, probePos: probePos.buffer, active: active.buffer, valid: valid.buffer, base: base.buffer, job: job.buffer, n, cell, half, size, vols, atlas, worldCount: PW, terms: T, rays, seaLevel: sea, ocean: OCEAN_ALBEDO, transmission, keyDirs };
  const pool = Array.from({ length: nw }, () => new Worker(new URL('./worker.js', import.meta.url), { workerData: data }));
  const runPass = async (pass, out, prev) => {
    const tp = Date.now();
    job[0] = 0; job[1] = 0;
    const timer = setInterval(() => log(`  pass ${pass}: ${Math.round((job[1] / P) * 100)}%`), 5000);
    const res = await Promise.all(pool.map((w) => new Promise((resolve, reject) => {
      w.once('message', resolve);
      w.once('error', reject);
      w.postMessage({ pass, out, prev });
    })));
    clearInterval(timer);
    const st = res.reduce((a, r) => ({ rays: a.rays + r.stats.rays, shadow: a.shadow + r.stats.shadow }), { rays: 0, shadow: 0 });
    const ms = Date.now() - tp;
    log(`pass ${pass}: ${ms} ms, ${(st.rays / 1e6).toFixed(1)} M rays + ${(st.shadow / 1e6).toFixed(1)} M shadow rays (${((st.rays + st.shadow) / ms / 1000).toFixed(1)} M/s)`);
    return { ms, ...st };
  };

  const passes = [];
  try {
    const D = new Float32Array(direct), TT = new Float32Array(total), B = new Float32Array(bounce);
    passes.push(await runPass(0, direct, null));
    let invalid = 0;
    for (let p = 0; p < P; p++) if (active[p] && !valid[p]) invalid++;
    const fix = () => {
      fixup(TT, { n, S, valid, active, ref });
      fixupVolumes(TT, { S, PW, vols, atlas, valid });
    };
    TT.set(D);
    fix();
    for (let b = 1; b <= bounces; b++) {
      passes.push(await runPass(b, bounce, total));
      for (let q = 0; q < TT.length; q++) TT[q] = D[q] + B[q];
      fix();
    }
    log(`probes inside geometry (refilled from neighbours): ${invalid}`);

    // --- encode + write -------------------------------------------------------------------------
    const amaxOf = (p0, p1) => {
      const amax = new Array(T).fill(1e-6);
      for (let p = p0; p < p1; p++) for (let t = 0; t < T; t++) for (let c = 0; c < 3; c++) amax[t] = Math.max(amax[t], TT[p * S + t * 12 + c * 4]);
      return amax.map((a) => +(a * 1.02).toFixed(5));
    };
    const amax = amaxOf(0, PW);
    const meta = { version: GI_VERSION, size, cell, n, layers: GI_LAYERS, h0: GI_H0, ratio: GI_RATIO, keys: GI_KEYS, sunTilt: tilt, amax, ref, rays, bounces, transmission };
    const planes = encodePlanes(TT, PW, n, GI_KEYS, amax);
    let vplanes = new Uint8Array(0);
    if (vols.length) {
      const vamax = amaxOf(PW, P);
      vplanes = encodePlanes(TT.subarray(PW * S), VC, atlas.aw, GI_KEYS, vamax);
      const r4 = (a) => a.map((x) => +x.toFixed(4));
      meta.volumes = { ...atlas, amax: vamax, list: vols.map((v) => ({ entity: v.entity, asset: v.asset, c: r4(v.c), yaw: +v.yaw.toFixed(5), size: r4(v.size), res: v.res, at: v.at, blend: v.blend, bias: v.bias })) };
    }
    const bytes = new Uint8Array(n * n * 4 + planes.length + vplanes.length);
    bytes.set(new Uint8Array(base.buffer.slice(0)), 0);
    bytes.set(planes, n * n * 4);
    bytes.set(vplanes, n * n * 4 + planes.length);
    const gz = zlib.gzipSync(bytes, { level: 9 });
    // derived data: written directly (no .mc-backup copy of a 10 MB file per bake)
    fs.mkdirSync(dataPath('gi'), { recursive: true });
    fs.writeFileSync(dataPath(GI_BIN), gz);
    const out = { ...meta, inputs: giInputsHash(), bakedAt: new Date().toISOString(), ms: Date.now() - t0, probes: activeCount, volumeProbes: volProbes, invalid, scene: scene.stats, passes, bytes: gz.length };
    fs.writeFileSync(dataPath(GI_META), JSON.stringify(out, null, 2) + '\n');
    void DATA;
    return out;
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
}

/**
 * After a pass: probes stuck inside geometry take the average of their valid neighbours (a few
 * dilation rounds), and the open-sea tiles copy the reference column.
 */
function fixup(F, { n, S, valid, active, ref }) {
  const L = GI_LAYERS, P = n * n * L;
  const ok = new Uint8Array(P);
  for (let p = 0; p < P; p++) ok[p] = active[p] && valid[p] ? 1 : 0;
  for (let round = 0; round < 6; round++) {
    const next = ok.slice();
    let left = 0;
    for (let l = 0; l < L; l++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const p = (l * n + j) * n + i;
      if (ok[p] || !active[p]) continue;
      let w = 0;
      const tmp = new Float64Array(S);
      for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        const ll = l + c, jj = j + b, ii = i + a;
        if (ll < 0 || jj < 0 || ii < 0 || ll >= L || jj >= n || ii >= n) continue;
        const q = (ll * n + jj) * n + ii;
        if (!ok[q]) continue;
        const wq = c === 0 ? 2 : 1; // prefer the same layer
        for (let s = 0; s < S; s++) tmp[s] += F[q * S + s] * wq;
        w += wq;
      }
      if (!w) { left++; continue; }
      for (let s = 0; s < S; s++) F[p * S + s] = tmp[s] / w;
      next[p] = 1;
    }
    ok.set(next);
    if (!left) break;
  }
  if (!ref) return;
  for (let l = 0; l < L; l++) {
    const r = ((l * n + ref.j) * n + ref.i) * S;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const p = (l * n + j) * n + i;
      if (active[p]) continue;
      F.copyWithin(p * S, r, r + S);
    }
  }
}

/** Interior volumes of every placed static asset entity (asset `gi.volumes`), in world space. */
export function collectVolumes(world, assets) {
  const out = [], m4 = new THREE.Matrix4();
  for (const e of world.entities ?? []) {
    if (!(e.type in ASSET_TYPES) || e.disabled) continue;
    const name = e.asset ?? ASSET_TYPES[e.type];
    const list = assets[name]?.gi?.volumes;
    if (!list?.length) continue;
    const m = entityMatrix(e, m4).elements;
    for (const v of list) out.push({ entity: e.id ?? null, asset: name, ...placeVolume(m, v) });
  }
  return out;
}

/**
 * Volume probes stuck inside geometry (walls, floors: the box faces sit in them) take the average
 * of their valid neighbours in the same volume, never the world grid (it leaks the outdoor sky).
 */
function fixupVolumes(F, { S, PW, vols, atlas, valid }) {
  const tmp = new Float64Array(S);
  for (const v of vols) {
    const [nx, ny, nz] = v.res;
    const at = (x, y, z) => PW + (y * atlas.ah + v.at[1] + z) * atlas.aw + v.at[0] + x;
    const ok = new Uint8Array(nx * ny * nz);
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) ok[(y * nz + z) * nx + x] = valid[at(x, y, z)];
    if (!ok.some(Boolean)) continue; // a volume entirely inside geometry: left as traced
    for (let round = 0, left = 1; left && round < nx + ny + nz; round++) {
      const next = ok.slice();
      left = 0;
      for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const k = (y * nz + z) * nx + x;
        if (ok[k]) continue;
        tmp.fill(0);
        let w = 0;
        for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
          const xx = x + a, yy = y + c, zz = z + b;
          if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz || !ok[(yy * nz + zz) * nx + xx]) continue;
          const wq = 1 / (a * a + b * b + c * c), q = at(xx, yy, zz) * S;
          for (let s = 0; s < S; s++) tmp[s] += F[q + s] * wq;
          w += wq;
        }
        if (!w) { left++; continue; }
        const o = at(x, y, z) * S;
        for (let s = 0; s < S; s++) F[o + s] = tmp[s] / w;
        next[k] = 1;
      }
      ok.set(next);
    }
  }
}
