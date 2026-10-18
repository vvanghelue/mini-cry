// Rule-based vegetation scattering (pure JS, used by the CLI and the editor's "Regenerate").
// Output: a compact instance list, stored as public/data/vegetation.bin:
//   per instance 12 bytes: u8 species index, u8 variant, u8 yaw (0..255 -> 0..2PI), u8 scale
//   (0..255 -> 0.25..2.5), f32 x, f32 z. The species order is the one of vegetation.json.
import { fbm, hash2, mulberry32, segDist } from '../math/random.js';
import { MATERIAL_ID } from './TerrainData.js';

export const VEG_RECORD = 12;
export const encodeScale = (s) => Math.max(0, Math.min(255, Math.round(((s - 0.25) / 2.25) * 255)));
export const decodeScale = (b) => 0.25 + (b / 255) * 2.25;

/** Distance (m) to the sea for every 8 m cell (chamfer distance transform). */
export function seaDistanceField(terrain, step = 8) {
  const n = Math.floor(terrain.size / step) + 1;
  const d = new Float32Array(n * n).fill(1e9);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = terrain.x0 + i * step, z = terrain.z0 + j * step;
    if (terrain.heightAt(x, z) < terrain.seaLevel) d[j * n + i] = 0;
  }
  const a = step, b = step * Math.SQRT2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let v = d[j * n + i];
    if (i > 0) v = Math.min(v, d[j * n + i - 1] + a);
    if (j > 0) v = Math.min(v, d[(j - 1) * n + i] + a);
    if (i > 0 && j > 0) v = Math.min(v, d[(j - 1) * n + i - 1] + b);
    if (i < n - 1 && j > 0) v = Math.min(v, d[(j - 1) * n + i + 1] + b);
    d[j * n + i] = v;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    let v = d[j * n + i];
    if (i < n - 1) v = Math.min(v, d[j * n + i + 1] + a);
    if (j < n - 1) v = Math.min(v, d[(j + 1) * n + i] + a);
    if (i < n - 1 && j < n - 1) v = Math.min(v, d[(j + 1) * n + i + 1] + b);
    if (i > 0 && j < n - 1) v = Math.min(v, d[(j + 1) * n + i - 1] + b);
    d[j * n + i] = v;
  }
  return { step, n, d, at(x, z) { const i = Math.round((x - terrain.x0) / step), j = Math.round((z - terrain.z0) / step); return i < 0 || j < 0 || i >= n || j >= n ? 0 : d[j * n + i]; } };
}

/**
 * exclusions: { circles: [{x, z, r}], paths: [{ points: [[x, z]...], width }] }
 * region: { x0, z0, x1, z1 }: scatter only there; with `existing`, every instance outside it is kept.
 * only: species ids to scatter; with `existing`, the instances of the other species are kept.
 * existing: decoded vegetation.bin; the kept instances' trunks / rocks stay clear of the new ones.
 * returns { count, bytes: Uint8Array, perSpecies: {id: n} }
 */
export function scatterVegetation(terrain, veg, exclusions = {}, { region = null, only = null, existing = null } = {}) {
  const seed = veg.seed ?? 1;
  const sea = seaDistanceField(terrain);
  const circles = exclusions.circles ?? [];
  const paths = (exclusions.paths ?? []).map((p) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const q of p.points) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minZ = Math.min(minZ, q[1]); maxZ = Math.max(maxZ, q[1]); }
    const m = p.width / 2 + (veg.clearRoads ?? 4);
    return { ...p, minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m, clear: m };
  });
  const excluded = (x, z, pad = 0) => {
    for (const c of circles) if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + pad) ** 2) return true;
    for (const p of paths) {
      if (x < p.minX - pad || x > p.maxX + pad || z < p.minZ - pad || z > p.maxZ + pad) continue;
      for (let k = 0; k < p.points.length - 1; k++) {
        if (segDist(x, z, p.points[k][0], p.points[k][1], p.points[k + 1][0], p.points[k + 1][1]) < p.clear + pad) return true;
      }
    }
    return false;
  };
  const records = [];
  const perSpecies = {};
  const occupied = new Set(); // 2 m cells taken by trunks / rocks (keeps undergrowth out of them)
  const inRegion = (x, z) => !region || (x >= region.x0 && x < region.x1 && z >= region.z0 && z < region.z1);
  if (existing && (only || region)) {
    for (let k = 0; k < existing.n; k++) {
      const sp = veg.species[existing.species[k]];
      if (!sp || ((!only || only.has(sp.id)) && inRegion(existing.x[k], existing.z[k]))) continue;
      records.push(existing.species[k], existing.variant[k], Math.round((existing.yaw[k] / (Math.PI * 2)) * 256) & 255, encodeScale(existing.scale[k]), existing.x[k], existing.z[k]);
      perSpecies[sp.id] = (perSpecies[sp.id] ?? 0) + 1;
      if (sp.collide) occupied.add(`${Math.floor(existing.x[k] / 2)},${Math.floor(existing.z[k] / 2)}`);
    }
  }
  const X0 = terrain.x0, Z0 = terrain.z0, X1 = X0 + terrain.size, Z1 = Z0 + terrain.size;
  const n = { x: 0, y: 1, z: 0 };
  veg.species.forEach((sp, si) => {
    const sc = sp.scatter;
    if (!sc || (only && !only.has(sp.id))) return;
    const mats = new Set((sc.materials ?? []).map((m) => MATERIAL_ID[m]));
    const spacing = sc.spacing ?? 6;
    const p = Math.min(1, ((sc.density ?? 1) * spacing * spacing) / 100);
    const maxSlopeCos = Math.cos(((sc.maxSlope ?? 30) * Math.PI) / 180);
    const rng = mulberry32(seed * 31 + si * 977);
    let count = 0;
    const x0 = Math.max(X0, region?.x0 ?? X0), x1 = Math.min(X1, region?.x1 ?? X1), z0 = Math.max(Z0, region?.z0 ?? Z0), z1 = Math.min(Z1, region?.z1 ?? Z1);
    const gi0 = Math.floor(x0 / spacing), gi1 = Math.ceil(x1 / spacing), gj0 = Math.floor(z0 / spacing), gj1 = Math.ceil(z1 / spacing);
    for (let gj = gj0; gj < gj1; gj++) {
      for (let gi = gi0; gi < gi1; gi++) {
        if (hash2(gi, gj, seed + si * 101) > p) continue;
        const x = (gi + hash2(gi, gj, seed + si * 7 + 1)) * spacing;
        const z = (gj + hash2(gi, gj, seed + si * 7 + 2)) * spacing;
        if (x < X0 + 4 || x > X1 - 4 || z < Z0 + 4 || z > Z1 - 4 || !inRegion(x, z)) continue;
        if (fbm(x / (sc.noiseScale ?? 100), z / (sc.noiseScale ?? 100), 3, seed + si * 13) < (sc.noiseMin ?? -1)) continue;
        const h = terrain.heightAt(x, z);
        if (h < (sc.minHeight ?? 0) || h > (sc.maxHeight ?? 1e9)) continue;
        if (terrain.waterLevelAt(x, z) > h - 0.25) continue;
        if (mats.size && !mats.has(terrain.materialAtWorld(x, z))) continue;
        terrain.normalAt(x, z, n);
        if (n.y < maxSlopeCos) continue;
        if (sc.coastBand && sea.at(x, z) > sc.coastBand) continue;
        if (excluded(x, z, sp.collide ? 1.5 : 0)) continue;
        const cell = `${Math.floor(x / 2)},${Math.floor(z / 2)}`;
        if (occupied.has(cell)) continue;
        if (sp.collide) occupied.add(cell);
        const [s0, s1] = sc.scale ?? [0.8, 1.2];
        records.push(si, Math.floor(rng() * (sp.variants ?? 1)), Math.floor(rng() * 256), encodeScale(s0 + rng() * (s1 - s0)), x, z);
        count++;
      }
    }
    perSpecies[sp.id] = (perSpecies[sp.id] ?? 0) + count;
  });
  return { count: records.length / 6, bytes: encodeRecords(records), perSpecies };
}

export function encodeRecords(records) {
  const n = records.length / 6;
  const buf = new ArrayBuffer(n * VEG_RECORD);
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  for (let k = 0; k < n; k++) {
    const o = k * VEG_RECORD, r = k * 6;
    u8[o] = records[r]; u8[o + 1] = records[r + 1]; u8[o + 2] = records[r + 2]; u8[o + 3] = records[r + 3];
    dv.setFloat32(o + 4, records[r + 4], true);
    dv.setFloat32(o + 8, records[r + 5], true);
  }
  return u8;
}

/** Decode to plain arrays: { n, species: Uint8Array, variant, yaw (rad), scale, x, z } */
export function decodeVegetation(bytes) {
  const n = Math.floor(bytes.byteLength / VEG_RECORD);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { n, species: new Uint8Array(n), variant: new Uint8Array(n), yaw: new Float32Array(n), scale: new Float32Array(n), x: new Float32Array(n), z: new Float32Array(n) };
  for (let k = 0; k < n; k++) {
    const o = k * VEG_RECORD;
    out.species[k] = bytes[o]; out.variant[k] = bytes[o + 1];
    out.yaw[k] = (bytes[o + 2] / 256) * Math.PI * 2; out.scale[k] = decodeScale(bytes[o + 3]);
    out.x[k] = dv.getFloat32(o + 4, true); out.z[k] = dv.getFloat32(o + 8, true);
  }
  return out;
}

/** Re-encode decoded arrays (after editor brush edits). */
export function encodeVegetation(v) {
  const records = [];
  for (let k = 0; k < v.n; k++) records.push(v.species[k], v.variant[k], Math.round((v.yaw[k] / (Math.PI * 2)) * 256) & 255, encodeScale(v.scale[k]), v.x[k], v.z[k]);
  return encodeRecords(records);
}
