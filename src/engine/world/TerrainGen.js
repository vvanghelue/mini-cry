// Procedural island generator. Input: a layout (public/data/terrain/layout.json) describing
// islands, mountains, plateaus, lagoons, rivers, roads and flattened building sites; output: a
// TerrainData. Deterministic for a given layout + seed. Pure JS: used by the CLI
// (`npm run mc -- terrain generate`) and by the editor ("Regenerate").
import { TerrainData, MATERIAL_ID } from './TerrainData.js';
import { fbm, ridged, smoothstep, clamp, lerp } from '../math/random.js';

/** Distance to a polyline with the interpolated parameter: { d, s (0..1 along the path), seg, t }. */
function polyParam(px, pz, pts, cum, total) {
  let best = Infinity, bs = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
    const d = Math.hypot(ax + dx * t - px, az + dz * t - pz);
    if (d < best) { best = d; bs = (cum[k] + Math.sqrt(l2) * t) / total; }
  }
  return { d: best, s: bs };
}

function cumulative(pts) {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  return { cum, total: cum[cum.length - 1] || 1 };
}

/** Catmull-Rom resample of a polyline so rivers / roads curve smoothly. */
export function smoothPath(pts, step = 12) {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
  const out = [];
  const P = (k) => pts[clamp(k, 0, pts.length - 1)];
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < n; s++) {
      const t = s / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([...pts[pts.length - 1]]);
  return out;
}

export function generateTerrain(layout, { onProgress } = {}) {
  const seed = layout.seed ?? 1;
  const t = new TerrainData({ size: layout.size ?? 2048, res: layout.res ?? 1025, seaLevel: layout.seaLevel ?? 0, center: layout.center ?? [0, 0] });
  const H = t.heights, M = t.material, res = t.res;
  const islands = layout.islands ?? [], mountains = layout.mountains ?? [], plateaus = layout.plateaus ?? [];
  const lagoons = layout.lagoons ?? [];

  // 1-2. islands (warped ellipses), rolling hills, mountains, plateaus, lagoons
  for (let j = 0; j < res; j++) {
    const z = t.wz(j);
    for (let i = 0; i < res; i++) {
      const x = t.wx(i);
      // domain warp for organic coastlines
      const wx = x + fbm(x / 260, z / 260, 3, seed + 1) * 90;
      const wz = z + fbm(x / 260 + 5.2, z / 260 + 1.3, 3, seed + 2) * 90;
      let mask = -Infinity, landH = 0;
      for (const isl of islands) {
        const c = Math.cos(isl.rot ?? 0), s = Math.sin(isl.rot ?? 0);
        let dx = wx - isl.x, dz = wz - isl.z;
        if (isl.warp) {
          // big islands: a coarser warp of their own (bays and capes), skipped far from them
          const reach = Math.max(isl.rx, isl.rz) + isl.warp * 2;
          if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
          const ws = isl.warpScale ?? 600;
          dx += fbm(x / ws + 17.3, z / ws + 4.1, 3, seed + 13) * isl.warp;
          dz += fbm(x / ws + 2.9, z / ws + 23.7, 3, seed + 14) * isl.warp;
        }
        const lx = (dx * c - dz * s) / isl.rx, lz = (dx * s + dz * c) / isl.rz;
        const d = Math.hypot(lx, lz);
        const m = 1 - d; // 0 at the coast, 1 at the centre
        if (m > mask) { mask = m; landH = isl.height ?? 30; }
      }
      let h;
      const coastNoise = fbm(x / 70, z / 70, 3, seed + 3) * 0.04;
      const m = mask + coastNoise;
      if (m > 0) {
        // land: beach shelf, then rolling inland hills
        const inland = smoothstep(0.0, 0.35, m);
        const hills = (fbm(x / 180, z / 180, 5, seed + 4) * 0.5 + 0.5) * landH;
        h = 1.2 + inland * hills + smoothstep(0, 0.05, m) * 1.4;
        h += fbm(x / 35, z / 35, 3, seed + 5) * 2.2 * inland;
      } else {
        // sea floor dropping away from the coast
        h = lerp(0.6, -38, smoothstep(0, 0.35, -m)) + fbm(x / 90, z / 90, 3, seed + 6) * 3;
      }
      for (const mt of mountains) {
        const d = Math.hypot(x - mt.x, z - mt.z) / mt.r;
        if (d >= 1.2) continue;
        // outline noise (relative to r: a big mountain wants a longer wavelength, else spires)
        const ns = mt.noiseScale ?? 120;
        const prof = Math.pow(smoothstep(1.15, 0.0, d + fbm(x / ns, z / ns, 3, seed + 7) * (mt.noise ?? 0.18)), 1.6);
        const rs = mt.ridgeScale ?? 160;
        const rid = ridged(x / rs, z / rs, 4, seed + 8);
        let add = mt.height * prof * (1 - (mt.ridged ?? 0.35) + (mt.ridged ?? 0.35) * rid);
        if (mt.crater) {
          const dc = Math.hypot(x - mt.x, z - mt.z);
          add -= smoothstep(mt.crater * 1.5, mt.crater * 0.4, dc) * mt.height * 0.32;
        }
        h += add;
      }
      for (const p of plateaus) {
        const d = Math.hypot(x - p.x, z - p.z) / p.r + fbm(x / 60, z / 60, 2, seed + 9) * 0.12;
        const k = smoothstep(1.15, 0.92, d);
        h = Math.max(h, lerp(h, p.height + fbm(x / 25, z / 25, 2, seed + 10) * 0.8, k));
      }
      for (const lg of lagoons) {
        const d = Math.hypot(x - lg.x, z - lg.z) / lg.r;
        if (d < 1 && h < -lg.depth) {
          const k = smoothstep(1, 0.6, d);
          h = lerp(h, -lg.depth + fbm(x / 20, z / 20, 2, seed + 11) * 0.9, k);
        }
      }
      H[j * res + i] = h;
    }
    if (onProgress && j % 64 === 0) onProgress(j / res * 0.6);
  }

  // 3. rivers: carve a valley along the path, water surface sloping from source to the sea
  t.rivers = [];
  for (const rv of layout.rivers ?? []) {
    const pts = smoothPath(rv.points, 10);
    const { cum, total } = cumulative(pts);
    const src = rv.source ?? 20, mouth = rv.mouth ?? 0.15;
    const surfAt = (s) => lerp(src, mouth, Math.pow(s, rv.curve ?? 0.8));
    const half = rv.width / 2, bank = rv.bank ?? 26, depth = rv.depth ?? 2;
    const reach = half + bank;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const i0 = Math.max(0, Math.floor(t.gx(minX - reach))), i1 = Math.min(res - 1, Math.ceil(t.gx(maxX + reach)));
    const j0 = Math.max(0, Math.floor(t.gz(minZ - reach))), j1 = Math.min(res - 1, Math.ceil(t.gz(maxZ + reach)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = t.wx(i), z = t.wz(j);
        const wob = fbm(x / 30, z / 30, 2, seed + 12) * 2.5;
        const { d: d0, s } = polyParam(x, z, pts, cum, total);
        const d = Math.max(0, d0 + wob);
        if (d > reach) continue;
        const surf = surfAt(s);
        const p = j * res + i;
        if (d < half) {
          const bed = surf - depth * (1 - Math.pow(d / half, 2) * 0.7);
          H[p] = Math.min(H[p], bed);
          if (H[p] > t.seaLevel - 0.2) M[p] = MATERIAL_ID.mud;
        } else {
          const k = smoothstep(half, reach, d);
          const bankH = surf + 0.6 + (d - half) * 0.08;
          H[p] = Math.min(H[p], lerp(bankH, H[p], k * k));
        }
      }
    }
    t.rivers.push({ name: rv.name ?? 'river', width: rv.width, points: pts.map((p, k) => [p[0], p[1], surfAt(cum[k] / total)]) });
  }
  onProgress?.(0.7);

  // 4. roads: follow a smoothed height profile, painted dirt
  for (const rd of layout.roads ?? []) {
    const pts = smoothPath(rd.points, 6);
    const { cum, total } = cumulative(pts);
    // height profile: sampled terrain, smoothed, never below the beach
    let prof = pts.map((p) => t.heightAt(p[0], p[1]));
    for (let pass = 0; pass < 12; pass++) prof = prof.map((h, k) => (prof[Math.max(0, k - 1)] + h * 2 + prof[Math.min(prof.length - 1, k + 1)]) / 4);
    prof = prof.map((h) => Math.max(h, t.seaLevel + 1.1));
    if (rd.bridgeOver) prof = prof.map((h) => Math.max(h, rd.bridgeOver));
    const half = rd.width / 2, shoulder = rd.shoulder ?? 7;
    const reach = half + shoulder;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const i0 = Math.max(0, Math.floor(t.gx(minX - reach))), i1 = Math.min(res - 1, Math.ceil(t.gx(maxX + reach)));
    const j0 = Math.max(0, Math.floor(t.gz(minZ - reach))), j1 = Math.min(res - 1, Math.ceil(t.gz(maxZ + reach)));
    const profAt = (s) => {
      const f = s * (prof.length - 1), k = Math.floor(f);
      return lerp(prof[k], prof[Math.min(prof.length - 1, k + 1)], f - k);
    };
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = t.wx(i), z = t.wz(j);
        const { d, s } = polyParam(x, z, pts, cum, total);
        if (d > reach) continue;
        const p = j * res + i;
        if (rd.skipWater && t.rivers.some(() => false)) continue;
        const target = profAt(s);
        const k = smoothstep(half, reach, d);
        H[p] = lerp(target, H[p], k);
        if (d < half * 0.85) M[p] = MATERIAL_ID[rd.material ?? 'dirt'];
      }
    }
  }
  onProgress?.(0.85);

  // 5. building sites: flattened discs (outposts, villages, helipads...)
  for (const f of layout.flats ?? []) {
    const target = f.height ?? t.heightAt(f.x, f.z);
    const r = f.r, margin = f.margin ?? 12;
    t.brush(f.x, f.z, r + margin, (i, j, w, dist) => {
      const p = j * res + i;
      const k = smoothstep(r + margin, r, dist);
      H[p] = lerp(H[p], target, k);
      if (f.material && dist < r * 0.95) M[p] = MATERIAL_ID[f.material];
    }, 0);
  }

  t.buildWaterGrid();
  onProgress?.(1);
  return t;
}
