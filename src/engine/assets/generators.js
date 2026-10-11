// Procedural asset generators. Each one: { label, defaults, build(params, rng) -> parts[],
// collider?(params) -> colliders }. An asset uses one with { generator: { type, params } } and
// gets a different variant per seed. The editor can "bake" a generator into editable parts.
// Units: metres; angles in the produced parts: degrees.
import { mulberry32 } from '../math/random.js';

const R2D = 180 / Math.PI;
const lerp = (a, b, t) => a + (b - a) * t;
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const vary = (rng, v, k) => v * (1 + (rng() * 2 - 1) * k);

/** Tapered tube through a list of points, one 'limb' per segment. */
function tube(points, r0, r1, color, { segments = 6, wind = (t) => 0, colors = null } = {}) {
  const out = [];
  const n = points.length - 1;
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    out.push({
      shape: 'limb', from: points[k], to: points[k + 1], r0: lerp(r0, r1, t0), r1: lerp(r0, r1, t1), segments,
      color: colors ? colors[k % colors.length] : color, wind: [wind(t0), wind(t1)], open: k > 0, jitter: 0.05,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------- trees
// Trees are built from a structure (trunk, branches, leaf clumps, fronds) drawn ONCE from the rng,
// whatever the quality: the LOD only changes tessellation and drops small details, and the far
// LOD merges the leaf clumps into a few bigger ones covering the same crown. Every LOD of a
// variant thus keeps the same height, lean, crown envelope and colours. Leaves carry `foliage`
// + `crown` (smooth crown shading, ModelBuilder.js), so they also light the same at every LOD.

const D2R = Math.PI / 180;
const GOLDEN = 137.508; // deg
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Weighted average of '#rrggbb' colours. */
function mixHex(colors, weights) {
  let r = 0, g = 0, b = 0, w = 0;
  colors.forEach((c, i) => {
    const n = parseInt(c.slice(1), 16), k = weights?.[i] ?? 1;
    r += (n >> 16) * k; g += ((n >> 8) & 255) * k; b += (n & 255) * k; w += k;
  });
  const h = (v) => Math.round(v / w).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Point on the crown ellipsoid (centre C, radii rx ry rz) at azimuth a, elevation e (rad), shell s. */
const onCrown = (C, rx, ry, rz, a, e, s) => [C[0] + Math.cos(a) * Math.cos(e) * rx * s, C[1] + Math.sin(e) * ry * s, C[2] + Math.sin(a) * Math.cos(e) * rz * s];

/** Far LODs: k-means the clumps into k groups, each replaced by one ellipsoid around its members.
 *  Flowering clumps and leafy ones are merged apart (their colours must not average out). */
function mergeClumps(clumps, k, squash) {
  const fl = clumps.filter((c) => c.flower);
  if (fl.length && fl.length < clumps.length) {
    const kf = Math.max(1, Math.min(k - 1, Math.round((k * fl.length) / clumps.length)));
    return [...mergeGroup(clumps.filter((c) => !c.flower), k - kf, squash), ...mergeGroup(fl, kf, squash)];
  }
  return mergeGroup(clumps, k, squash);
}

function mergeGroup(clumps, k, squash) {
  const ell = (c) => ({ pos: c.pos, radii: [c.r, c.r * squash, c.r], color: c.color, seed: c.seed });
  if (clumps.length <= k) return clumps.map(ell);
  const w = (c) => c.r ** 3;
  const cent = [clumps.reduce((a, b) => (b.r > a.r ? b : a)).pos];
  while (cent.length < k) {
    let best = null, bd = -1;
    for (const c of clumps) { const d = Math.min(...cent.map((x) => dist2(x, c.pos))); if (d > bd) { bd = d; best = c.pos; } }
    cent.push(best);
  }
  let groups = [];
  for (let it = 0; it < 6; it++) {
    groups = cent.map(() => []);
    for (const c of clumps) {
      let bi = 0, bd = Infinity;
      cent.forEach((x, i) => { const d = dist2(x, c.pos); if (d < bd) { bd = d; bi = i; } });
      groups[bi].push(c);
    }
    groups.forEach((g, i) => {
      if (!g.length) return;
      const W = g.reduce((s, c) => s + w(c), 0);
      cent[i] = [0, 1, 2].map((ax) => g.reduce((s, c) => s + c.pos[ax] * w(c), 0) / W);
    });
  }
  return groups.filter((g) => g.length).map((g) => {
    if (g.length === 1) return ell(g[0]);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const c of g) {
      const rr = [c.r, c.r * squash, c.r];
      for (let ax = 0; ax < 3; ax++) { lo[ax] = Math.min(lo[ax], c.pos[ax] - rr[ax]); hi[ax] = Math.max(hi[ax], c.pos[ax] + rr[ax]); }
    }
    return { pos: [0, 1, 2].map((ax) => (lo[ax] + hi[ax]) / 2), radii: [0, 1, 2].map((ax) => (hi[ax] - lo[ax]) / 2), color: mixHex(g.map((c) => c.color), g.map((c) => c.r * c.r)), seed: g[0].seed };
  });
}

/** Limbs along a polyline with per-point radii (bark colours alternate per segment). */
function trunkLimbs(pts, radii, colors, segments, wind) {
  const out = [];
  for (let k = 0; k < pts.length - 1; k++) {
    out.push({ shape: 'limb', from: pts[k], to: pts[k + 1], r0: radii[k], r1: radii[k + 1], segments, open: k > 0, color: colors[k % colors.length], jitter: 0.05, wind: [wind(pts[k][1]), wind(pts[k + 1][1])] });
  }
  return out;
}

/** Leaf "scales" hanging over a clump's surface (shaggy, leafy silhouette up close), a bit lighter
 *  than the clump (younger outer leaves). Own rng from the clump seed: never shifts the structure. */
function leafFringe(c, squash, n, size, extra) {
  const lr = mulberry32(c.seed * 7919 + 13);
  const pos = [];
  for (let k = 0; k < n; k++) {
    // fibonacci directions over the clump, from the top down to well under the equator
    const yy = 0.92 - ((k + 0.5) / n) * 1.8, rr = Math.sqrt(Math.max(0, 1 - yy * yy)), az = k * 2.39996 + lr() * 0.8;
    const d = [Math.cos(az) * rr, yy, Math.sin(az) * rr];
    const P = [c.pos[0] + d[0] * c.r * 0.9, c.pos[1] + d[1] * c.r * squash * 0.9, c.pos[2] + d[2] * c.r * 0.9];
    // "down the surface" tangent (radial outward near the top), and the leaf's width axis
    let t = [d[0] * yy, yy * yy - 1, d[2] * yy];
    let tl = Math.hypot(...t);
    if (tl < 0.25) { t = [Math.cos(az), -0.2, Math.sin(az)]; tl = Math.hypot(...t); }
    t = t.map((x) => x / tl);
    const sd = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
    const w = size * (0.42 + lr() * 0.2), len = size * (0.9 + lr() * 0.45);
    const tip = [P[0] + t[0] * len * 0.85 + d[0] * len * 0.3, P[1] + t[1] * len * 0.85 + d[1] * len * 0.3, P[2] + t[2] * len * 0.85 + d[2] * len * 0.3];
    pos.push(P[0] - sd[0] * w, P[1] - sd[1] * w, P[2] - sd[2] * w, P[0] + sd[0] * w, P[1] + sd[1] * w, P[2] + sd[2] * w, ...tip);
  }
  return { shape: 'tris', positions: pos, color: mixHex([c.color, '#86b04a'], [3, 1]), wind: 0.35, jitter: 0.12, ...extra };
}

/** Buttress root: a thin fin, high against the trunk and sweeping down to the ground (concave). */
function buttressFin(r, a, hb, len, color) {
  const t = 0.1, x0 = r * 0.85;
  const A = [x0, hb, 0], M = [x0 + len * 0.3, hb * 0.22, 0], D = [x0 + len, 0, 0], B = [x0, 0, 0];
  const side = (p, s) => [p[0], p[1], p[2] + t * s * (1 - (p[0] - x0) / (len * 1.2))];
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  for (const s of [1, -1]) { tri(side(A, s), side(B, s), side(M, s)); tri(side(M, s), side(B, s), side(D, s)); }
  tri(side(A, 1), side(M, 1), side(M, -1)); tri(side(A, 1), side(M, -1), side(A, -1));
  tri(side(M, 1), side(D, 1), side(D, -1)); tri(side(M, 1), side(D, -1), side(M, -1));
  return { shape: 'tris', positions: pos, rot: [0, -a, 0], color, jitter: 0.08, minQuality: 0.4 };
}

const TREE_DEFAULTS = {
  height: 9, trunkRadius: 0.3, flare: 1.5, lean: 4, bend: 0.5, trunkTop: 0.6,
  crownBase: 0.35, crownRadius: 3.3, elevMin: -20, elevMax: 70, crownShell: 0.72,
  branches: 5, forks: 1, clumps: 10, clumpRadius: 1.5, clumpSquash: 0.75, clumpNoise: 0.22, clumpDetail: 0, leafFringe: 12, leafSize: 0.8, midClumps: 5, farClumps: 2, midBranches: 3, farBranches: 0,
  buttress: 0, lianas: 0, aerialRoots: 0, moss: 0,
  barkColor: '#6b5640', barkColor2: '#5c4a37', mossColor: '#55702c', lianaColor: '#3e4a20',
  leafColors: ['#3f6f22', '#4a7d28', '#36631d'], flowerColors: ['#d2401f', '#e2582a', '#c23417'], flowers: 0,
  foliage: 0.75, ao: 0.55,
};

/** Generic branching tree (broadleaf, jungle giant, flame tree... = parameter sets). */
function buildTree(p, R, q) {
  const h = vary(R, p.height, 0.14), r = vary(R, p.trunkRadius, 0.12);
  const lean = p.lean * D2R * (0.4 + R() * 0.9); // toward +x (the instance yaw turns it)
  const wob = [R() - 0.5, R() - 0.5, R() - 0.5, R() - 0.5];
  const trunkAt = (y) => {
    const t = y / h, s1 = Math.sin(Math.PI * t), s2 = Math.sin(2 * Math.PI * t) * 0.5;
    return [Math.sin(lean) * y + p.bend * (wob[0] * s1 + wob[1] * s2), y, p.bend * (wob[2] * s1 + wob[3] * s2)];
  };
  const y0 = h * p.crownBase, ry = (h - y0) / 2, cy = y0 + ry;
  const rx = vary(R, p.crownRadius, 0.14), rz = rx * (0.85 + R() * 0.3);
  const C = trunkAt(cy);
  const tTop = h * p.trunkTop;
  const crown = [C[0], C[1], C[2], rx * 1.15, ry * 1.25, rz * 1.15];
  const leaf = { foliage: p.foliage, crown, ao: p.ao };
  const leafClump = (pos, r) => {
    const flower = p.flowers > 0 && R() < p.flowers;
    return { pos, r, flower, color: pick(R, flower ? p.flowerColors : p.leafColors), seed: Math.floor(R() * 9999) };
  };

  // branches (primary + forks) end inside the crown shell; their tips carry the leaf clumps
  const a0 = R() * Math.PI * 2;
  const branches = [], clumps = [];
  for (let i = 0; i < p.branches; i++) {
    const u = R();
    const a = a0 + i * GOLDEN * D2R + (R() - 0.5) * 0.6;
    const e = lerp(p.elevMin, p.elevMax, clamp01(u * 0.6 + R() * 0.4)) * D2R;
    const S = trunkAt(lerp(Math.min(y0 * 0.95, tTop * 0.8), tTop, u));
    const T = onCrown(C, rx, ry, rz, a, e, p.crownShell * (0.9 + R() * 0.15));
    const M = mix3(S, T, 0.5);
    M[1] += Math.sqrt(dist2(S, T)) * 0.12;
    const br = r * lerp(0.55, 0.38, u);
    const forks = [];
    for (let f = 0; f < p.forks; f++) {
      const F = mix3(M, T, 0.25 * R());
      const T2 = onCrown(C, rx, ry, rz, a + (f % 2 ? 1 : -1) * (0.45 + R() * 0.4), e + (R() * 0.5 - 0.15), p.crownShell * (0.85 + R() * 0.2));
      forks.push({ F, T: T2, r0: br * 0.5 });
      clumps.push(leafClump(T2, vary(R, p.clumpRadius, 0.22) * 0.9));
    }
    branches.push({ S, M, T, r0: br, forks });
    clumps.push(leafClump(T, vary(R, p.clumpRadius, 0.22)));
  }
  // the crown top, then fill clumps where the crown is still empty (farthest point among random
  // candidates on the shell, distances measured in crown radii)
  clumps.push(leafClump([C[0], C[1] + ry * p.crownShell, C[2]], p.clumpRadius * vary(R, 1, 0.15)));
  const fill = Math.max(0, p.clumps - clumps.length);
  const sMin = Math.sin(p.elevMin * D2R), sMax = Math.sin(p.elevMax * D2R);
  const cands = Array.from({ length: fill * 6 }, () => onCrown(C, rx, ry, rz, R() * Math.PI * 2, Math.asin(lerp(sMin, sMax, R())), p.crownShell * (0.6 + R() * 0.35)));
  const nd = (a, b) => ((a[0] - b[0]) / rx) ** 2 + ((a[1] - b[1]) / ry) ** 2 + ((a[2] - b[2]) / rz) ** 2;
  for (let j = 0; j < fill; j++) {
    let best = 0, bd = -1;
    cands.forEach((c, i) => { const d = Math.min(...clumps.map((k) => nd(c, k.pos))); if (d > bd) { bd = d; best = i; } });
    clumps.push(leafClump(cands[best], vary(R, p.clumpRadius, 0.25) * 0.85));
  }
  const lianas = [];
  for (let i = 0; i < p.lianas; i++) {
    const b = branches[i % branches.length], from = mix3(b.M, b.T, R() * 0.6);
    lianas.push({ from, len: from[1] * lerp(0.45, 0.85, R()), dx: (R() - 0.5) * 0.8, dz: (R() - 0.5) * 0.8 });
  }
  const roots = [];
  for (let i = 0; i < p.aerialRoots; i++) {
    const b = branches[i % branches.length], from = mix3(b.S, b.M, 0.5 + R() * 0.5);
    roots.push({ from, to: [from[0] * 1.1 + (R() - 0.5), 0, from[2] * 1.1 + (R() - 0.5)] });
  }
  const butt = [];
  for (let i = 0; i < p.buttress; i++) butt.push((i / p.buttress) * 360 + R() * 30);

  // ---- emit for this quality. Mid LOD: clumps merged into midClumps volumes, the midBranches
  // thickest branches; far LOD: farClumps volumes, trunk + the farBranches thickest branches.
  const hi = q > 0.6, mid = q > 0.3 && !hi;
  const parts = [];
  const flareY = Math.min(h * 0.07, 1.6);
  const tw = (y) => (y / h) * 0.05;
  const rAt = (y) => lerp(r, r * 0.6, (y - flareY) / Math.max(0.01, tTop - flareY));
  // far: no branches but the farBranches thickest, so the trunk goes up into the crown
  const ys = hi ? [0, flareY, ...Array.from({ length: 5 }, (_, k) => lerp(flareY, tTop, (k + 1) / 5))] : mid ? [0, flareY, (flareY + tTop) / 2, tTop] : [0, Math.max(tTop, Math.min(...clumps.map((c) => c.pos[1])))];
  const trunk = trunkLimbs(ys.map(trunkAt), ys.map((y, k) => (k === 0 ? r * (hi || mid ? p.flare : (p.flare + 1) / 2) : rAt(y))), [p.barkColor, p.barkColor2], hi ? 7 : mid ? 4 : 3, tw);
  if (p.moss > 0 && (hi || mid)) trunk[0].color = mixHex([p.barkColor, p.mossColor], [1, p.moss]); // mossy foot (far: one segment = whole trunk)
  parts.push(...trunk);
  const thick = [...branches].sort((a, b) => b.r0 - a.r0);
  for (const b of branches) {
    if (hi) {
      parts.push({ shape: 'limb', from: b.S, to: b.M, r0: b.r0, r1: b.r0 * 0.6, segments: 5, color: p.barkColor, wind: [tw(b.S[1]), 0.05] });
      parts.push({ shape: 'limb', from: b.M, to: b.T, r0: b.r0 * 0.6, r1: b.r0 * 0.3, segments: 5, color: p.barkColor, wind: [0.05, 0.1] });
      for (const f of b.forks) parts.push({ shape: 'limb', from: f.F, to: f.T, r0: f.r0, r1: f.r0 * 0.4, segments: 4, color: p.barkColor2, wind: [0.06, 0.12] });
    } else if (thick.indexOf(b) < (mid ? p.midBranches : p.farBranches)) {
      parts.push({ shape: 'limb', from: b.S, to: mix3(b.M, b.T, 0.5), r0: b.r0, r1: b.r0 * 0.45, segments: 3, color: p.barkColor, wind: [tw(b.S[1]), 0.08] });
    }
  }
  const leafPart = (c, extra) => ({ shape: 'lump', noise: p.clumpNoise, seed: c.seed, pos: c.pos, color: c.color, wind: 0.12, jitter: 0.08, ...leaf, ...extra });
  if (hi) {
    for (const c of clumps) {
      parts.push(leafPart(c, { radius: c.r * (p.clumpDetail > 0 ? 1 : 1.1), detail: p.clumpDetail, scale: [1, p.clumpSquash, 1] }));
      if (p.leafFringe > 0) parts.push(leafFringe(c, p.clumpSquash, p.leafFringe, p.leafSize * Math.min(1.5, c.r / 1.5), leaf));
    }
  } else if (mid) {
    for (const c of mergeClumps(clumps, p.midClumps, p.clumpSquash)) parts.push(leafPart(c, { radius: 1, detail: 0, scale: c.radii.map((x) => x * 1.08) }));
  } else {
    for (const c of mergeClumps(clumps, p.farClumps, p.clumpSquash)) parts.push(leafPart(c, { radius: 1, detail: 0, noise: p.clumpNoise * 0.6, scale: c.radii.map((x) => x * 1.08), wind: 0.1 }));
  }
  for (const a of butt) parts.push(buttressFin(r, a, h * 0.17, r * 3.2, p.barkColor));
  for (const l of lianas) {
    parts.push({ shape: 'limb', from: l.from, to: [l.from[0] + l.dx, l.from[1] - l.len, l.from[2] + l.dz], r0: 0.05, r1: 0.035, segments: 3, color: p.lianaColor, wind: [0.35, 0.03], minQuality: 0.6 });
  }
  for (const rt of roots) parts.push({ shape: 'limb', from: rt.from, to: rt.to, r0: 0.07, r1: 0.11, segments: hi ? 4 : 3, color: p.barkColor2, wind: [0.02, 0], minQuality: 0.4 });
  return parts;
}

const treeCollider = (p) => {
  const hh = p.height * Math.min(0.7, p.trunkTop);
  return [{ type: 'cylinder', radius: p.trunkRadius * 1.2, height: hh, pos: [0, hh / 2, 0] }];
};

/** Coconut-type palm: curved trunk with a flared foot, crown of pinnate fronds of every age. */
function buildPalm(p, R, q) {
  const h = vary(R, p.height, 0.15), lean = vary(R, p.lean, 0.45) * D2R, curve = p.curve * (0.6 + R() * 0.8), wob = R() - 0.5;
  const r = vary(R, p.trunkRadius, 0.1);
  const at = (t) => [Math.sin(lean) * h * t + curve * h * 0.25 * t * t, h * t, wob * 0.5 * Math.sin(Math.PI * t)];
  const top = at(1);
  const L = p.frondLength;
  const leaf = { foliage: p.foliage, crown: [top[0], top[1] - 0.5, top[2], L * 0.95, L * 0.6, L * 0.95], ao: p.ao };
  const a0 = R() * 360;
  const fronds = [];
  for (let i = 0; i < p.fronds; i++) {
    const age = (i + R() * 0.8) / p.fronds; // 0 young, upright .. 1 old, drooping
    fronds.push({
      age,
      yaw: a0 + i * GOLDEN + (R() - 0.5) * 20,
      pitch: lerp(66, -28, Math.pow(age, 1.1)) + (R() - 0.5) * 14,
      length: L * (age < 0.2 ? lerp(0.6, 1, age / 0.2) : 1) * vary(R, 1, 0.1),
      droop: p.droop * lerp(0.35, 1.25, age) * vary(R, 1, 0.2),
      color: age > 0.86 ? p.oldColor : age < 0.14 ? p.youngColor : pick(R, p.frondColors),
      dy: -age * 0.3,
    });
  }
  const dead = Array.from({ length: p.dead }, () => ({ yaw: R() * 360, len: L * lerp(0.55, 0.75, R()) }));
  const nuts = Array.from({ length: p.coconuts }, () => ({ a: R() * Math.PI * 2, d: 0.22 + R() * 0.12, y: 0.25 + R() * 0.2, c: pick(R, ['#5b6b2a', '#6e5530', '#7a6a2c']) }));

  const hi = q > 0.6, mid = q > 0.3 && !hi;
  const parts = [];
  const segN = hi ? p.segments : mid ? 4 : 2;
  const ts = hi || mid ? [0, 0.035, ...Array.from({ length: segN }, (_, k) => lerp(0.035, 1, (k + 1) / segN))] : [0, 0.5, 1];
  const rad = (t) => (t === 0 ? r * (hi || mid ? p.flare : 1.3) : t < 0.035 ? r * p.flare : lerp(r * 1.1, r * 0.78, t));
  parts.push(...trunkLimbs(ts.map(at), ts.map(rad), [p.trunkColor, p.ringColor], hi ? 6 : mid ? 4 : 3, (y) => (y / h) ** 2 * 0.25));
  if (p.crownshaft) parts.push({ shape: 'cylinder', radiusTop: r * 0.95, radiusBottom: r * 1.12, height: 1.5, pos: [top[0], top[1] - 0.75, top[2]], segments: hi ? 6 : 4, color: p.crownshaft, jitter: 0.03, wind: 0.22, open: !hi });
  parts.push({ shape: 'sphere', radius: r * 1.5, detail: 0, pos: top, color: p.ringColor, wind: 0.25, minQuality: 0.4 });
  const segs = hi ? p.leaflets : mid ? 4 : 3;
  for (const f of fronds) {
    // the short upright spears and the oldest hanging fronds: little silhouette away from the tree
    if (mid && (f.age < 0.1 || f.age > 0.93)) continue;
    if (!hi && !mid && (f.age < 0.15 || f.age > 0.88)) continue;
    parts.push({ shape: 'frond', pinnate: true, base: [top[0], top[1] + f.dy, top[2]], yaw: f.yaw, pitch: f.pitch, length: f.length, width: p.frondWidth, droop: f.droop, segs: Math.round(segs / q), fold: p.fold, leafletBase: p.leafletBase, taper: 0.88, color: f.color, wind: 1, jitter: 0.07, ...leaf });
  }
  for (const d of dead) parts.push({ shape: 'frond', base: [top[0], top[1] - 0.25, top[2]], yaw: d.yaw, pitch: -72, length: d.len, width: p.frondWidth * 0.35, droop: 0.15, segs: 3, fold: 0.3, color: p.deadColor, wind: 0.5, minQuality: 0.6 });
  for (const n of nuts) parts.push({ shape: 'sphere', radius: 0.15, detail: 0, pos: [top[0] + Math.cos(n.a) * n.d, top[1] - n.y, top[2] + Math.sin(n.a) * n.d], color: n.c, wind: 0.25, minQuality: 0.6 });
  return parts;
}

/** Pandanus (screw pine): stilt roots, a forked trunk, spiralled rosettes of long stiff leaves. */
function buildPandanus(p, R, q) {
  const h = vary(R, p.height, 0.2), r = p.trunkRadius;
  const lean = (4 + R() * 12) * D2R;
  const forkY = h * lerp(0.42, 0.58, R());
  const rootTop = p.rootHeight * vary(R, 1, 0.2);
  const fork = [Math.sin(lean) * forkY, forkY, 0];
  const limbs = [{ from: [0, 0, 0], to: fork, r0: r * 1.1, r1: r * 0.9 }];
  const tips = [];
  const grow = (from, dir, len, rad, depth) => {
    const to = [from[0] + dir[0] * len, from[1] + dir[1] * len, from[2] + dir[2] * len];
    limbs.push({ from, to, r0: rad, r1: rad * 0.8 });
    const split = depth === 0 || (depth < p.forks && R() < 0.65);
    if (!split) { tips.push(to); return; }
    const az = R() * Math.PI * 2;
    for (const s of [0, Math.PI]) {
      const sp = (28 + R() * 18) * D2R;
      const d = [dir[0] + Math.cos(az + s) * Math.sin(sp) * 1.5, dir[1] * Math.cos(sp), dir[2] + Math.sin(az + s) * Math.sin(sp) * 1.5];
      const n = Math.hypot(...d);
      grow(to, d.map((x) => x / n), len * lerp(0.7, 0.85, R()), rad * 0.72, depth + 1);
    }
  };
  grow(fork, [Math.sin(lean) * 0.3, 1, 0].map((x, i, a) => x / Math.hypot(...a)), (h - forkY) * 0.55, r * 0.85, 0);
  const roots = Array.from({ length: p.roots }, (_, i) => {
    const a = (i / p.roots) * Math.PI * 2 + R() * 0.6, y = rootTop * lerp(0.45, 1, R()), d = p.rootSpread * lerp(0.7, 1.2, R());
    const from = [Math.sin(lean) * y, y, 0];
    return { from, mid: [from[0] + Math.cos(a) * d * 0.45, y * 0.55, from[2] + Math.sin(a) * d * 0.45], to: [from[0] + Math.cos(a) * d, 0, from[2] + Math.sin(a) * d] };
  });
  const L = p.leafLength;
  const rosettes = tips.map((t) => ({
    t,
    a0: R() * 360,
    leaves: Array.from({ length: p.leaves }, (_, k) => ({ k, len: L * vary(R, 1, 0.15), droop: lerp(0.15, 0.7, k / p.leaves) * vary(R, 1, 0.3), dp: (R() - 0.5) * 12, color: pick(R, p.leafColors) })),
  }));
  const fruit = p.fruits > 0 ? Math.floor(R() * tips.length) : -1;

  const hi = q > 0.6, mid = q > 0.3 && !hi;
  const parts = [];
  for (const l of limbs) parts.push({ shape: 'limb', from: l.from, to: l.to, r0: l.r0, r1: l.r1, segments: hi ? 5 : mid ? 4 : 3, color: p.barkColor, jitter: 0.06, wind: [l.from[1] / h * 0.1, l.to[1] / h * 0.15] });
  roots.forEach((rt, i) => {
    if (!hi && (!mid || i % 2)) return;
    parts.push({ shape: 'limb', from: rt.from, to: rt.mid, r0: r * 0.45, r1: r * 0.4, segments: hi ? 4 : 3, color: p.rootColor, jitter: 0.06 });
    parts.push({ shape: 'limb', from: rt.mid, to: rt.to, r0: r * 0.4, r1: r * 0.42, segments: hi ? 4 : 3, color: p.rootColor, jitter: 0.06, open: true });
  });
  // fewer leaves far away, picked along the spiral so the rosette stays round; a bit wider
  const keep = hi ? 1 : mid ? 2 : 4;
  for (const ro of rosettes) {
    const crown = [ro.t[0], ro.t[1] - L * 0.15, ro.t[2], L * 0.85, L * 0.6, L * 0.85];
    for (const lf of ro.leaves) {
      if (lf.k % keep) continue;
      parts.push({ shape: 'frond', base: ro.t, yaw: ro.a0 + lf.k * GOLDEN, pitch: lerp(62, -32, lf.k / p.leaves) + lf.dp, length: lf.len, width: p.leafWidth * (hi ? 1 : mid ? 1.25 : 1.7), droop: lf.droop, segs: 2 / q, fold: 0.45, taper: 0.55, color: lf.color, wind: 0.8, jitter: 0.08, foliage: p.foliage, crown, ao: p.ao });
    }
    parts.push({ shape: 'sphere', radius: 0.14, detail: 0, pos: ro.t, color: p.barkColor, minQuality: 0.4 });
  }
  if (fruit >= 0) { const t = tips[fruit]; parts.push({ shape: 'sphere', radius: 0.2, detail: 0, pos: [t[0] + 0.15, t[1] - 0.35, t[2]], scale: [1, 1.25, 1], color: p.fruitColor, wind: 0.2, minQuality: 0.6 }); }
  return parts;
}

export const GENERATORS = {
  palm: {
    label: 'Palmier',
    defaults: {
      height: 9, lean: 12, curve: 0.3, trunkRadius: 0.2, flare: 1.7, segments: 9, fronds: 15, frondLength: 3.9, frondWidth: 0.8, droop: 1.7, leaflets: 11, fold: 0.5, leafletBase: 0.9,
      coconuts: 4, dead: 2, crownshaft: '', trunkColor: '#8b7c66', ringColor: '#6f624f', frondColors: ['#4d7f24', '#5a8c2b', '#43741f'], youngColor: '#7ea83c', oldColor: '#9c8a3e', deadColor: '#8a6b3c',
      foliage: 0.65, ao: 0.4,
    },
    build: buildPalm,
    collider: (p) => [{ type: 'cylinder', radius: p.trunkRadius * 1.3, height: p.height * 0.8, pos: [0, p.height * 0.4, 0] }],
  },

  tree: {
    label: 'Arbre (générique)',
    defaults: TREE_DEFAULTS,
    build: buildTree,
    collider: treeCollider,
  },

  jungleTree: {
    label: 'Arbre géant de jungle',
    defaults: {
      ...TREE_DEFAULTS, height: 21, trunkRadius: 0.7, flare: 1.6, lean: 3, bend: 0.8, trunkTop: 0.68, crownBase: 0.6, crownRadius: 6.5, elevMin: -5, elevMax: 50, crownShell: 0.75,
      branches: 5, forks: 2, clumps: 14, clumpRadius: 2.2, clumpSquash: 0.6, midClumps: 9, farClumps: 4, midBranches: 5, farBranches: 3, buttress: 5, lianas: 5, moss: 1,
      barkColor: '#5f4c38', barkColor2: '#544332', leafColors: ['#2c5e1a', '#36691f', '#264f16'],
    },
    build: buildTree,
    collider: treeCollider,
  },

  broadleaf: {
    label: 'Feuillu',
    defaults: { ...TREE_DEFAULTS },
    build: buildTree,
    collider: treeCollider,
  },

  pandanus: {
    label: 'Pandanus',
    defaults: {
      height: 5, trunkRadius: 0.14, roots: 6, rootHeight: 1.3, rootSpread: 1.0, forks: 2, leaves: 12, leafLength: 1.7, leafWidth: 0.12, fruits: 1,
      barkColor: '#80705a', rootColor: '#8d7d64', leafColors: ['#5f8d3b', '#6c9a45', '#537f34'], fruitColor: '#d98a2b', foliage: 0.6, ao: 0.35,
    },
    build: buildPandanus,
    collider: () => [{ type: 'cylinder', radius: 0.4, height: 3, pos: [0, 1.5, 0] }],
  },

  bush: {
    label: 'Buisson',
    defaults: { radius: 1.1, blobs: 3, leaves: 9, leafColors: ['#3f8a22', '#4d9a2a', '#357a1c'], colors: ['#2f6a1c', '#3a7a22', '#285c17'], berries: 0, berryColor: '#c8302a' },
    build(p, rng, q = 1) {
      // a leafy core (a few faceted blobs) wrapped in arching broad leaves
      const parts = [];
      const nb = q <= 0.3 ? 1 : q <= 0.6 ? Math.min(2, p.blobs) : p.blobs;
      for (let i = 0; i < nb; i++) {
        const a = rng() * Math.PI * 2, d = i ? rng() * p.radius * 0.45 : 0;
        const r = vary(rng, p.radius, 0.2) * (i ? 0.55 : nb === 1 ? 0.9 : 0.7);
        parts.push({ shape: 'lump', radius: r, detail: 0, noise: 0.18, seed: Math.floor(rng() * 999), pos: [Math.cos(a) * d, r * 0.6, Math.sin(a) * d], scale: [1, 0.8, 1], color: pick(rng, p.colors), wind: [0.02, 0.18], jitter: 0.14 });
      }
      const nl = q <= 0.3 ? 0 : q <= 0.6 ? Math.ceil(p.leaves * 0.5) : p.leaves;
      for (let i = 0; i < nl; i++) {
        parts.push({
          shape: 'frond', base: [(rng() - 0.5) * 0.3, p.radius * (0.25 + rng() * 0.35), (rng() - 0.5) * 0.3], yaw: (i / nl) * 360 + rng() * 30, pitch: 25 + rng() * 30,
          length: vary(rng, p.radius * 1.15, 0.2), width: p.radius * 0.3, droop: p.radius * 0.75, segs: q <= 0.6 ? 2 : 3, fold: 0.2, taper: 0.8,
          color: pick(rng, p.leafColors), wind: 1, jitter: 0.1,
        });
      }
      for (let i = 0; i < (q <= 0.6 ? 0 : p.berries); i++) {
        const a = rng() * Math.PI * 2;
        parts.push({ shape: 'sphere', radius: 0.07, detail: 0, pos: [Math.cos(a) * p.radius * 0.6, p.radius * (0.5 + rng() * 0.5), Math.sin(a) * p.radius * 0.6], color: p.berryColor, wind: 0.1 });
      }
      return parts;
    },
  },

  fern: {
    label: 'Fougère',
    defaults: { fronds: 8, length: 1.3, width: 0.2, droop: 0.65, colors: ['#3d8a24', '#2e7419'] },
    build(p, rng, q = 1) {
      const parts = [];
      const nf = q <= 0.5 ? Math.ceil(p.fronds * 0.6) : p.fronds;
      for (let i = 0; i < nf; i++) {
        parts.push({ shape: 'frond', base: [0, 0.05, 0], yaw: (i / nf) * 360 + rng() * 30, pitch: 35 + rng() * 25, length: vary(rng, p.length, 0.2), width: p.width * (q <= 0.5 ? 1.3 : 1), droop: vary(rng, p.droop, 0.3), segs: q <= 0.5 ? 2 : 3, fold: 0.25, color: pick(rng, p.colors), wind: 1, jitter: 0.1 });
      }
      return parts;
    },
  },

  banana: {
    label: 'Bananier',
    defaults: { height: 2.4, leaves: 6, leafLength: 2.3, leafWidth: 0.55, stemColor: '#6b8a3a', leafColors: ['#4d9a2a', '#5aa834', '#3f8722'] },
    build(p, rng, q = 1) {
      const h = vary(rng, p.height, 0.2);
      if (q <= 0.5) p = { ...p, leaves: Math.ceil(p.leaves * 0.6) };
      const parts = [{ shape: 'cylinder', radiusTop: 0.1, radiusBottom: 0.16, height: h, pos: [0, h / 2, 0], segments: 6, color: p.stemColor, wind: [0, 0.15] }];
      for (let i = 0; i < p.leaves; i++) {
        parts.push({ shape: 'frond', base: [0, h * (0.85 + rng() * 0.15), 0], yaw: rng() * 360, pitch: 40 + rng() * 25, length: vary(rng, p.leafLength, 0.2), width: p.leafWidth, droop: 1.1, segs: 5, fold: 0.15, taper: 0.7, color: pick(rng, p.leafColors), wind: 1, jitter: 0.08 });
      }
      return parts;
    },
  },

  grass: {
    label: 'Touffe d\'herbe',
    defaults: { blades: 5, height: 0.55, width: 0.08, spread: 0.18, colors: ['#5d9a2c', '#6aa834', '#4f8a24'] },
    build(p, rng) {
      const pos = [];
      for (let i = 0; i < p.blades; i++) {
        const a = rng() * Math.PI * 2, d = rng() * p.spread;
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        const ya = rng() * Math.PI * 2, w = p.width * (0.7 + rng() * 0.6), h = p.height * (0.6 + rng() * 0.6);
        const lean = 0.15 + rng() * 0.25;
        const dx = Math.cos(ya) * w, dz = Math.sin(ya) * w;
        pos.push(x - dx, 0, z - dz, x + dx, 0, z + dz, x + Math.cos(a) * h * lean, h, z + Math.sin(a) * h * lean);
      }
      return [{ shape: 'tris', positions: pos, color: pick(rng, p.colors), wind: [0, 1], jitter: 0.12 }];
    },
  },

  flowers: {
    label: 'Fleurs',
    defaults: { count: 5, height: 0.45, colors: ['#e8473c', '#f2c53d', '#e86fb3', '#ffffff'], stemColor: '#4f8a24' },
    build(p, rng) {
      const parts = [];
      for (let i = 0; i < p.count; i++) {
        const a = rng() * Math.PI * 2, d = rng() * 0.35, h = vary(rng, p.height, 0.3);
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        parts.push({ shape: 'limb', from: [x, 0, z], to: [x, h, z], r0: 0.012, r1: 0.01, segments: 3, color: p.stemColor, wind: [0, 0.6] });
        parts.push({ shape: 'sphere', radius: 0.06, detail: 0, pos: [x, h, z], scale: [1, 0.5, 1], color: pick(rng, p.colors), wind: 0.6 });
      }
      return parts;
    },
  },

  rock: {
    label: 'Rocher',
    defaults: { radius: 1.4, detail: 1, noise: 0.28, squash: [1.1, 0.65, 1], colors: ['#7a756c', '#6b665e', '#86807a'], moss: 0.0, mossColor: '#4d6b25' },
    build(p, rng) {
      const parts = [{ shape: 'lump', radius: vary(rng, p.radius, 0.25), detail: p.detail, noise: p.noise, seed: Math.floor(rng() * 9999), scale: p.squash, pos: [0, p.radius * p.squash[1] * 0.45, 0], color: pick(rng, p.colors), jitter: 0.12 }];
      if (p.moss > 0) parts.push({ shape: 'lump', radius: p.radius * 0.75, detail: 1, noise: 0.2, seed: Math.floor(rng() * 999), scale: [p.squash[0] * 1.05, p.squash[1] * 0.4, p.squash[2] * 1.05], pos: [0, p.radius * p.squash[1] * 0.8, 0], color: p.mossColor, minQuality: 0.5 });
      return parts;
    },
    collider: (p) => [{ type: 'sphere', radius: p.radius * Math.max(p.squash[0], p.squash[2]) * 0.85, pos: [0, p.radius * p.squash[1] * 0.3, 0] }],
  },

  bamboo: {
    label: 'Bambous',
    defaults: { stalks: 7, height: 7, radius: 0.07, spread: 0.7, color: '#7d9a3a', nodeColor: '#5d7a2a', leafColor: '#4f9128' },
    build(p, rng) {
      const parts = [];
      for (let i = 0; i < p.stalks; i++) {
        const a = rng() * Math.PI * 2, d = rng() * p.spread;
        const x = Math.cos(a) * d, z = Math.sin(a) * d, h = vary(rng, p.height, 0.25);
        const tip = [x + (rng() - 0.5) * 1.2, h, z + (rng() - 0.5) * 1.2];
        const pts = [[x, 0, z], [lerp(x, tip[0], 0.33), h * 0.33, lerp(z, tip[2], 0.33)], [lerp(x, tip[0], 0.66), h * 0.66, lerp(z, tip[2], 0.66)], tip];
        parts.push(...tube(pts, p.radius, p.radius * 0.7, p.color, { segments: 5, colors: [p.color, p.nodeColor, p.color], wind: (t) => t * t * 0.6 }));
        for (let k = 0; k < 3; k++) parts.push({ shape: 'frond', base: [lerp(x, tip[0], 0.7 + k * 0.1), h * (0.7 + k * 0.1), lerp(z, tip[2], 0.7 + k * 0.1)], yaw: rng() * 360, pitch: 10, length: 0.8, width: 0.09, droop: 0.4, segs: 3, color: p.leafColor, wind: 1, minQuality: 0.5 });
      }
      return parts;
    },
    collider: (p) => [{ type: 'cylinder', radius: p.spread * 0.8, height: p.height * 0.5, pos: [0, p.height * 0.25, 0] }],
  },

  deadTree: {
    label: 'Arbre mort',
    defaults: { height: 6, trunkRadius: 0.25, branches: 4, color: '#7b6a58' },
    build(p, rng) {
      const h = vary(rng, p.height, 0.2);
      const parts = tube([[0, 0, 0], [(rng() - 0.5) * 0.5, h * 0.5, (rng() - 0.5) * 0.5], [(rng() - 0.5) * 0.8, h, (rng() - 0.5) * 0.8]], p.trunkRadius, p.trunkRadius * 0.4, p.color, { segments: 5 });
      for (let i = 0; i < p.branches; i++) {
        const y = h * lerp(0.4, 0.9, rng()), a = rng() * Math.PI * 2, l = h * 0.3;
        parts.push({ shape: 'limb', from: [0, y, 0], to: [Math.cos(a) * l, y + l * 0.6, Math.sin(a) * l], r0: p.trunkRadius * 0.35, r1: 0.02, segments: 4, color: p.color });
      }
      return parts;
    },
    collider: (p) => [{ type: 'cylinder', radius: p.trunkRadius * 1.2, height: p.height, pos: [0, p.height / 2, 0] }],
  },
};

export { R2D };
