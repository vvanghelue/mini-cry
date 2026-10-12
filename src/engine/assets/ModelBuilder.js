// Model builder: turns an asset definition (JSON, public/data/assets/<name>.json) into a single
// merged, non-indexed BufferGeometry with per-vertex normal, colour (tint), `uv` (metric: the
// surface's texture repeats every `scale` m), `surface` (texture layer id, assets/surfaces.js),
// `wind` (0 = rigid .. 1 = flexible leaf tip) and `emissive` attributes. Runs in the browser and in
// Node (CLI previews).
//
// Asset definition:
//   { name, category, parts: [Part], generator?: { type, params }, collider?: [Collider] | 'auto',
//     lods?: [{ distance, quality }], tags? }
// Part (all transforms are local to the asset; rot in DEGREES):
//   { shape: 'box', size: [w, h, d], pos, rot, scale, color, jitter, wind, emissive, taper }
//   { shape: 'cylinder', radiusTop, radiusBottom, height, segments, open }
//   { shape: 'cone', radius, height, segments }
//   { shape: 'sphere', radius, detail, squash: [sx, sy, sz] }     (icosphere)
//   { shape: 'lump', radius, detail, noise, seed, squash }        (noisy icosphere: rocks, canopies)
//   { shape: 'limb', from: [x,y,z], to: [x,y,z], r0, r1, segments } (tapered tube between 2 points)
//   { shape: 'frond', base, yaw, pitch, length, width, droop, segs, fold }  (deg angles)
//   { shape: 'wedge', size: [w, h, d] }                           (triangular prism: roofs)
//   { shape: 'plane', size: [w, d], doubleSided }
//   { shape: 'tris', positions: [x,y,z, ...], uvs?: [u,v, ...] }   (raw triangles)
//   { shape: 'card', size: [w, h] }                                (upright quad, base at y = 0: leaf cards)
//   { shape: 'cards', cards: [[x,y,z, dx,dy,dz, ux,uy,uz, w,h], ...] } (many quads: base point,
//      tip direction, width axis, size — crowns of leaf clusters)
//   { shape: 'ref', asset: 'name', pos, rot, scale }               (another asset, nested)
//   + modifiers: { repeat: { count, offset: [dx,dy,dz], rot: [deg...] } } or { radial: { count, radius, yaw0 } }
//   wind: number | [bottom, top] (gradient along the part's local height)
//   foliage: 0..1 — leaves: smooth shading normals bent from the facet toward a "crown" normal by
//     this weight (soft, volumetric canopies lit alike at every LOD; the weight goes to 1 at the
//     far LODs). With crown: [cx, cy, cz, r] or [cx, cy, cz, rx, ry, rz] (asset space) the normal
//     points out of that ellipsoid, mixed with the part's own sphere normal (lump / sphere) by
//     clumpNormal (0.35), and ao (0.5) darkens the vertices deep inside / under the crown.
//   surface: texture layer ('wood_planks', 'corrugated', 'leaves_broad'...; default: the asset's
//     `surface`, else from its `material`), uvScale: metres per texture repeat (default: the
//     layer's), smooth: smooth / faceted normals (default: smooth for round shapes)
// Leaf normals are stored with length 2 (the material tints / backlights leaves only).
import * as THREE from 'three';
import { mulberry32, hashString, fbm } from '../math/random.js';
import { GENERATORS } from './generators.js';
import { surfaceInfo, MATERIAL_SURFACE } from './surfaces.js';

// more segments than the original low-poly counts (round parts read round, smooth-shaded)
const TESS = 1.6;
const ROUND = new Set(['cylinder', 'cone', 'sphere', 'lump', 'limb', 'frond']);

const D2R = Math.PI / 180;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _v = new THREE.Vector3(), _c = new THREE.Color();

function partMatrix(p, out = new THREE.Matrix4()) {
  const pos = p.pos ?? [0, 0, 0];
  const rot = p.rot ?? [0, 0, 0];
  const sc = p.scale === undefined ? [1, 1, 1] : typeof p.scale === 'number' ? [p.scale, p.scale, p.scale] : p.scale;
  _e.set(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R, 'YXZ');
  _q.setFromEuler(_e);
  return out.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(sc[0], sc[1], sc[2]));
}

/** Primitive -> non-indexed geometry in part-local space (y up). q: quality 0..1 (LOD). */
function primitive(p, q, assets, depth) {
  const seg = (n, min = 3) => Math.max(min, Math.round((n ?? 6) * q * TESS));
  // round solids get one more subdivision up close (leaf clumps keep theirs: their normals are baked)
  const det = (d) => Math.min(4, Math.max(0, (d ?? 1) - (q <= 0.5 ? 1 : 0) - (q <= 0.25 ? 1 : 0) + (q > 0.6 && !p.foliage ? 1 : 0)));
  let g;
  switch (p.shape) {
    case 'box': {
      const [w, h, d] = p.size ?? [1, 1, 1];
      g = new THREE.BoxGeometry(w, h, d);
      if (p.taper !== undefined) { // shrink the top face (x/z) by taper
        const a = g.attributes.position;
        for (let i = 0; i < a.count; i++) if (a.getY(i) > 0) { a.setX(i, a.getX(i) * p.taper); a.setZ(i, a.getZ(i) * p.taper); }
      }
      break;
    }
    case 'cylinder':
      g = new THREE.CylinderGeometry(p.radiusTop ?? p.radius ?? 0.5, p.radiusBottom ?? p.radius ?? 0.5, p.height ?? 1, seg(p.segments ?? 8), 1, !!p.open);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, seg(p.segments ?? 8));
      break;
    case 'sphere':
      g = new THREE.IcosahedronGeometry(p.radius ?? 0.5, det(p.detail ?? 1));
      break;
    case 'lump': {
      g = new THREE.IcosahedronGeometry(p.radius ?? 0.5, det(p.detail ?? 1));
      const a = g.attributes.position;
      const seed = p.seed ?? 1, k = p.noise ?? 0.25, r = p.radius ?? 0.5;
      // displacement keyed on position so shared corners stay welded
      for (let i = 0; i < a.count; i++) {
        const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
        const n = 1 + fbm(x / r * 1.3 + seed * 1.7, z / r * 1.3 + y / r * 0.9, 2, seed) * k * 2;
        a.setXYZ(i, x * n, y * n, z * n);
      }
      break;
    }
    case 'limb': {
      const a = new THREE.Vector3(...(p.from ?? [0, 0, 0])), b = new THREE.Vector3(...(p.to ?? [0, 1, 0]));
      const d = b.clone().sub(a);
      const len = d.length() || 0.001;
      g = new THREE.CylinderGeometry(p.r1 ?? 0.05, p.r0 ?? 0.1, len, seg(p.segments ?? 6), 1, p.open ?? true);
      g.translate(0, len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
      g.translate(a.x, a.y, a.z);
      break;
    }
    case 'frond':
      g = frondGeometry(p, q);
      break;
    case 'wedge': {
      const [w, h, d] = p.size ?? [1, 1, 1];
      const x = w / 2, z = d / 2;
      const P = [
        -x, 0, z, x, 0, z, 0, h, z, // front
        x, 0, -z, -x, 0, -z, 0, h, -z, // back
        -x, 0, -z, -x, 0, z, 0, h, z, -x, 0, -z, 0, h, z, 0, h, -z, // left slope
        x, 0, z, x, 0, -z, 0, h, -z, x, 0, z, 0, h, -z, 0, h, z, // right slope
        -x, 0, -z, x, 0, -z, x, 0, z, -x, 0, -z, x, 0, z, -x, 0, z, // bottom
      ];
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      break;
    }
    case 'plane': {
      const [w, d] = p.size ?? [1, 1];
      g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
      if (p.doubleSided) g = doubleSide(g);
      break;
    }
    case 'tris': {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.positions ?? [], 3));
      if (p.uvs) { g.setAttribute('uv', new THREE.Float32BufferAttribute(p.uvs, 2)); g.userData.ownUv = true; }
      if (p.doubleSided) g = doubleSide(g);
      break;
    }
    case 'card': {
      const [w, h] = p.size ?? [1, 1];
      const P = [-w / 2, 0, 0, w / 2, 0, 0, w / 2, h, 0, -w / 2, 0, 0, w / 2, h, 0, -w / 2, h, 0];
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0], 2));
      g.userData.wind = new Float32Array([0, 0, 1, 0, 1, 1]);
      g.userData.ownUv = true;
      break;
    }
    case 'cards': {
      // [x,y,z (base), dx,dy,dz (to the tip, unit), ux,uy,uz (width axis, unit), w, h]
      const P = [], UV = [], WD = [];
      for (const c of p.cards ?? []) {
        const [x, y, z, dx, dy, dz, ux, uy, uz, w, h] = c;
        const v = (s, t) => [x + ux * w * s + dx * h * t, y + uy * w * s + dy * h * t, z + uz * w * s + dz * h * t];
        const a = v(-0.5, 0), b = v(0.5, 0), cc = v(0.5, 1), d = v(-0.5, 1);
        P.push(...a, ...b, ...cc, ...a, ...cc, ...d);
        UV.push(0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0);
        WD.push(0, 0, 1, 0, 1, 1);
      }
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
      g.userData.wind = new Float32Array(WD);
      g.userData.ownUv = true;
      break;
    }
    case 'ref': {
      const def = assets?.[p.asset];
      if (!def || depth > 6) return null;
      return buildParts(resolveParts(def, assets, undefined, q), q, assets, depth + 1, p.seed, defaultSurface(def));
    }
    default:
      throw new Error(`unknown part shape "${p.shape}"`);
  }
  if (g.index) g = g.toNonIndexed();
  return { geometry: g, part: p };
}

/** Default surface of an asset's parts: its `surface`, else from its impact `material`. */
export function defaultSurface(def) {
  return def?.surface ?? MATERIAL_SURFACE[def?.material] ?? 'plain';
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n3 = new THREE.Vector3();

/** Normals averaged over coincident vertices (smooth shading of welded round shapes). */
function smoothNormals(g) {
  const P = g.attributes.position.array, n = P.length / 3;
  const acc = new Map(), keys = new Array(n);
  for (let t = 0; t < n; t += 3) {
    _a.set(P[t * 3 + 3] - P[t * 3], P[t * 3 + 4] - P[t * 3 + 1], P[t * 3 + 5] - P[t * 3 + 2]);
    _b.set(P[t * 3 + 6] - P[t * 3], P[t * 3 + 7] - P[t * 3 + 1], P[t * 3 + 8] - P[t * 3 + 2]);
    _n3.crossVectors(_a, _b); // area weighted
    for (let i = t; i < t + 3; i++) {
      const k = `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;
      keys[i] = k;
      let v = acc.get(k);
      if (!v) acc.set(k, (v = [0, 0, 0]));
      v[0] += _n3.x; v[1] += _n3.y; v[2] += _n3.z;
    }
  }
  const N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = acc.get(keys[i]);
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    N[i * 3] = v[0] / l; N[i * 3 + 1] = v[1] / l; N[i * 3 + 2] = v[2] / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
}

/** Metric texture coordinates in part space (sc: part scale), `tile` m per repeat. */
function partUVs(g, p, sc, tile) {
  const pa = g.attributes.position, n = pa.count;
  const out = new Float32Array(n * 2);
  const own = g.attributes.uv;
  const k = 1 / tile;
  if ((p.shape === 'cylinder' || p.shape === 'limb' || p.shape === 'cone') && own) {
    // three's cylinder uvs: around x along for the side, a disc for the caps
    const rt = p.shape === 'limb' ? p.r1 ?? 0.05 : p.shape === 'cone' ? 0 : p.radiusTop ?? p.radius ?? 0.5;
    const rb = p.shape === 'limb' ? p.r0 ?? 0.1 : p.radius ?? p.radiusBottom ?? 0.5;
    const len = p.shape === 'limb' ? Math.hypot(...(p.to ?? [0, 1, 0]).map((x, i) => x - (p.from ?? [0, 0, 0])[i])) : p.height ?? 1;
    const circ = Math.PI * (rt + rb) * Math.max(sc[0], sc[2]);
    const side = g.groups.length ? g.groups[0].count : n;
    for (let i = 0; i < n; i++) {
      if (i < side) { out[i * 2] = own.getX(i) * circ * k; out[i * 2 + 1] = own.getY(i) * len * sc[1] * k; }
      else { const d = 2 * Math.max(rt, rb) * Math.max(sc[0], sc[2]); out[i * 2] = (own.getX(i) - 0.5) * d * k; out[i * 2 + 1] = (own.getY(i) - 0.5) * d * k; }
    }
  } else if (p.shape === 'plane' && own) {
    const [w, d] = p.size ?? [1, 1];
    for (let i = 0; i < n; i++) { out[i * 2] = own.getX(i) * w * sc[0] * k; out[i * 2 + 1] = own.getY(i) * d * sc[2] * k; }
  } else {
    // box mapping: each triangle projected along its dominant axis
    const P = pa.array;
    for (let t = 0; t < n; t += 3) {
      _a.set((P[t * 3 + 3] - P[t * 3]) * sc[0], (P[t * 3 + 4] - P[t * 3 + 1]) * sc[1], (P[t * 3 + 5] - P[t * 3 + 2]) * sc[2]);
      _b.set((P[t * 3 + 6] - P[t * 3]) * sc[0], (P[t * 3 + 7] - P[t * 3 + 1]) * sc[1], (P[t * 3 + 8] - P[t * 3 + 2]) * sc[2]);
      _n3.crossVectors(_a, _b);
      const ax = Math.abs(_n3.x), ay = Math.abs(_n3.y), az = Math.abs(_n3.z);
      for (let i = t; i < t + 3; i++) {
        const x = P[i * 3] * sc[0], y = P[i * 3 + 1] * sc[1], z = P[i * 3 + 2] * sc[2];
        let u, v;
        if (ax >= ay && ax >= az) { u = _n3.x > 0 ? -z : z; v = y; }
        else if (ay >= az) { u = x; v = _n3.y > 0 ? z : -z; }
        else { u = _n3.z > 0 ? x : -x; v = y; }
        out[i * 2] = u * k; out[i * 2 + 1] = -v * k;
      }
    }
  }
  return out;
}

function doubleSide(g) {
  if (g.index) g = g.toNonIndexed();
  const a = g.attributes.position.array;
  const out = new Float32Array(a.length * 2);
  out.set(a);
  for (let i = 0; i < a.length; i += 9) {
    out.set(a.subarray(i, i + 3), a.length + i);
    out.set(a.subarray(i + 6, i + 9), a.length + i + 3);
    out.set(a.subarray(i + 3, i + 6), a.length + i + 6);
  }
  const g2 = new THREE.BufferGeometry();
  g2.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g2;
}

/** Drooping leaf strip (palm frond, fern, banana leaf); the per-vertex wind grows to the tip. */
function frondGeometry(p, q) {
  const cut = p.surface && surfaceInfo(p.surface).foliage;
  if (cut) return frondStrip(p, q);
  const base = p.base ?? [0, 0, 0];
  const yaw = (p.yaw ?? 0) * D2R, pitch = (p.pitch ?? 20) * D2R;
  const len = p.length ?? 2, width = p.width ?? 0.4, droop = p.droop ?? 0.8, fold = p.fold ?? 0.3;
  const segs = Math.max(2, Math.round((p.segs ?? 6) * q));
  const dx = Math.cos(yaw), dz = Math.sin(yaw), sx = -dz, sz = dx;
  const pos = [], wind = [];
  if (p.pinnate) {
    // pinnate (coconut-like) frond: one leaflet triangle per segment and side, hanging off the
    // rachis (fold) and slanted toward the tip. Fewer segments at low LODs = fewer, wider leaflets
    // covering the same envelope.
    const at = (t) => { const d = t * len; return [base[0] + dx * d * Math.cos(pitch), base[1] + Math.sin(pitch) * d - droop * t * t, base[2] + dz * d * Math.cos(pitch)]; };
    const t0 = p.pinnateStart ?? 0.1, gap = p.leafletBase ?? 0.6, reach = p.leafletReach ?? 0.45;
    for (let k = 0; k < segs; k++) {
      const ta = t0 + ((1 - t0) * k) / segs, dt = (1 - t0) / segs, tb = ta + dt * gap, tt = Math.min(1, ta + dt * (gap + reach));
      const a = at(ta), b = at(tb), c = at(tt);
      const w = width * Math.sin(Math.PI * Math.min(1, 0.12 + tt * (p.taper ?? 0.88)));
      for (const sd of [1, -1]) {
        pos.push(...a, ...b, c[0] + sx * w * sd, c[1] - w * fold, c[2] + sz * w * sd);
        wind.push(ta, tb, Math.min(1, tt + 0.15));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.userData.wind = new Float32Array(wind);
    return g;
  }
  let prev = null;
  for (let k = 0; k <= segs; k++) {
    const t = k / segs, d = t * len;
    const y = base[1] + Math.sin(pitch) * d - droop * t * t;
    const c = [base[0] + dx * d * Math.cos(pitch), y, base[2] + dz * d * Math.cos(pitch)];
    const w = width * Math.sin(Math.PI * Math.min(1, 0.12 + t * (p.taper ?? 0.9))) * (k === segs ? 0.15 : 1);
    const l = [c[0] + sx * w, c[1] - w * fold, c[2] + sz * w];
    const r = [c[0] - sx * w, c[1] - w * fold, c[2] - sz * w];
    if (prev) {
      const quad = (a, b, cc, dd, ta, tb) => {
        // two triangles, both faces
        for (const tri of (p.doubleSided ? [[a, b, cc], [b, dd, cc], [a, cc, b], [b, cc, dd]] : [[a, b, cc], [b, dd, cc]])) {
          for (const v of tri) { pos.push(...v); wind.push(v === a || v === b ? ta : tb); }
        }
      };
      quad(prev[0], prev[1], l, c, prev[3], t);
      quad(prev[1], prev[2], c, r, prev[3], t);
    }
    prev = [l, c, r, t];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.userData.wind = new Float32Array(wind);
  return g;
}

/** Textured frond (alpha-cut leaf layer): a strip of constant width along the drooping rachis,
 *  folded along its middle (V section), the leaf outline comes from the texture. u across the
 *  width, v from the base (image bottom, v = 1) to the tip (v = 0). */
function frondStrip(p, q) {
  const base = p.base ?? [0, 0, 0];
  const yaw = (p.yaw ?? 0) * D2R, pitch = (p.pitch ?? 20) * D2R;
  const len = p.length ?? 2, width = p.width ?? 0.4, droop = p.droop ?? 0.8, fold = p.fold ?? 0.3;
  const segs = Math.max(2, Math.round((p.segs ?? 6) * Math.max(q, 0.35)));
  const dx = Math.cos(yaw), dz = Math.sin(yaw), sx = -dz, sz = dx;
  const twist = (p.twist ?? 0) * D2R;
  const pos = [], uv = [], wind = [];
  let prev = null;
  for (let k = 0; k <= segs; k++) {
    const t = k / segs, d = t * len;
    const c = [base[0] + dx * d * Math.cos(pitch), base[1] + Math.sin(pitch) * d - droop * t * t, base[2] + dz * d * Math.cos(pitch)];
    // half width, a little narrower at the base; the leaflets hang down from the rachis (fold)
    const w = width * (0.55 + 0.45 * Math.min(1, t * 4));
    const tw = twist * t, cs = Math.cos(tw), sn = Math.sin(tw);
    const side = [sx * cs, sn, sz * cs];
    const l = [c[0] + side[0] * w, c[1] + side[1] * w - w * fold, c[2] + side[2] * w];
    const r = [c[0] - side[0] * w, c[1] - side[1] * w - w * fold, c[2] - side[2] * w];
    const row = [[l, 0], [c, 0.5], [r, 1]];
    if (prev) {
      for (let s = 0; s < 2; s++) {
        const [a, ua] = prev.row[s], [b, ub] = prev.row[s + 1], [cc, uc] = row[s + 1], [dd, ud] = row[s];
        for (const [v, u, vv, ww] of [[a, ua, prev.t, prev.t], [b, ub, prev.t, prev.t], [cc, uc, t, t], [a, ua, prev.t, prev.t], [cc, uc, t, t], [dd, ud, t, t]]) {
          pos.push(...v); uv.push(u, 1 - vv); wind.push(ww);
        }
      }
    }
    prev = { row, t };
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.userData.wind = new Float32Array(wind);
  g.userData.ownUv = true;
  return g;
}

/** Expand a part's repeat / radial modifiers into a list of plain parts. */
function expand(p) {
  if (p.repeat) {
    const { count = 2, offset = [1, 0, 0], rot = [0, 0, 0] } = p.repeat;
    const out = [];
    for (let i = 0; i < count; i++) {
      const pos = p.pos ?? [0, 0, 0], r = p.rot ?? [0, 0, 0];
      out.push({ ...p, repeat: undefined, pos: [pos[0] + offset[0] * i, pos[1] + offset[1] * i, pos[2] + offset[2] * i], rot: [r[0] + rot[0] * i, r[1] + rot[1] * i, r[2] + rot[2] * i] });
    }
    return out.flatMap(expand);
  }
  if (p.radial) {
    const { count = 6, radius = 0, yaw0 = 0 } = p.radial;
    const out = [];
    for (let i = 0; i < count; i++) {
      const a = yaw0 + (360 / count) * i;
      const pos = p.pos ?? [0, 0, 0], r = p.rot ?? [0, 0, 0];
      const ar = a * D2R;
      if (p.shape === 'frond') out.push({ ...p, radial: undefined, yaw: (p.yaw ?? 0) + a, base: [(p.base?.[0] ?? 0) + Math.cos(ar) * radius, p.base?.[1] ?? 0, (p.base?.[2] ?? 0) + Math.sin(ar) * radius] });
      else out.push({ ...p, radial: undefined, pos: [pos[0] + Math.cos(ar) * radius, pos[1], pos[2] + Math.sin(ar) * radius], rot: [r[0], r[1] - a, r[2]] });
    }
    return out.flatMap(expand);
  }
  return [p];
}

/** A generator's parameters for a variant seed: defaults < params < params.forms[(seed - 1) % n]
 *  (forms = sub-types of one asset, e.g. round / spreading / tall broadleaf trees). */
export function generatorParams(def, seed = 1) {
  const gen = GENERATORS[def.generator.type];
  const p = { ...gen.defaults, ...def.generator.params };
  const forms = p.forms;
  if (!Array.isArray(forms) || !forms.length) return p;
  const n = forms.length;
  return { ...p, ...forms[(((Math.round(seed) - 1) % n) + n) % n] };
}

/** The part list of an asset: explicit parts + generated ones. */
export function resolveParts(def, assets, seed, quality) {
  let parts = def.parts ? [...def.parts] : [];
  if (def.generator) {
    const gen = GENERATORS[def.generator.type];
    if (!gen) throw new Error(`unknown generator "${def.generator.type}"`);
    const sd = seed ?? def.generator.params?.seed ?? 1;
    const rng = mulberry32(sd + hashString(def.name ?? ''));
    parts = parts.concat(gen.build(generatorParams(def, sd), rng, quality ?? 1));
  }
  return parts;
}

const CLUMPS = new Set(['lump', 'sphere']);
const _nm = new THREE.Matrix3();

function buildParts(parts, q, assets, depth, seed, defSurf = 'plain') {
  const pieces = [], glows = [];
  const rng = mulberry32(seed ?? 7);
  for (const raw of parts.flatMap(expand)) {
    if (raw.glow) glows.push(partGlow(raw)); // kept at every LOD
    if (raw.minQuality !== undefined && q < raw.minQuality) continue; // dropped at low LODs
    const prim = primitive(raw, q, assets, depth);
    if (!prim) continue;
    if (prim.pieces) {
      // nested asset: transform its merged geometry (and light halos) by the ref part's matrix
      const m = partMatrix(raw);
      _nm.getNormalMatrix(m);
      for (const pc of prim.pieces) {
        pc.geometry.applyMatrix4(m);
        if (pc.normal) for (let i = 0; i < pc.normal.length; i += 3) { _v.fromArray(pc.normal, i); const l = _v.length(); _v.applyMatrix3(_nm).normalize().multiplyScalar(l).toArray(pc.normal, i); }
        pieces.push(pc);
      }
      const s = m.getMaxScaleOnAxis();
      for (const gw of prim.glows) glows.push({ ...gw, pos: _v.fromArray(gw.pos).applyMatrix4(m).toArray(), size: gw.size * s });
      continue;
    }
    const g = prim.geometry;
    const n = g.attributes.position.count;
    // local height range for wind gradients
    let minY = Infinity, maxY = -Infinity;
    const pa = g.attributes.position;
    for (let i = 0; i < n; i++) { const y = pa.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const wind = new Float32Array(n);
    if (g.userData.wind) wind.set(g.userData.wind);
    else if (Array.isArray(raw.wind)) for (let i = 0; i < n; i++) { const t = maxY > minY ? (pa.getY(i) - minY) / (maxY - minY) : 0; wind[i] = raw.wind[0] + (raw.wind[1] - raw.wind[0]) * t; }
    else wind.fill(raw.wind ?? 0);
    if (g.userData.wind && typeof raw.wind === 'number') for (let i = 0; i < n; i++) wind[i] *= raw.wind;
    else if (g.userData.wind && Array.isArray(raw.wind)) for (let i = 0; i < n; i++) wind[i] = raw.wind[0] + (raw.wind[1] - raw.wind[0]) * wind[i];
    // shading normals: smooth for round shapes (welded), facets for boxes, roofs, raw triangles
    const smooth = raw.smooth ?? ROUND.has(raw.shape);
    if (!smooth) g.computeVertexNormals();
    else if (raw.shape === 'lump' || raw.shape === 'frond' || (raw.shape === 'sphere' && !g.attributes.normal) || (raw.shape === 'sphere' && det0(raw, q))) smoothNormals(g);
    else if (!g.attributes.normal) g.computeVertexNormals();
    // texture layer + metric uvs (in part space, before the part transform)
    const surfName = raw.surface ?? defSurf;
    const sinfo = surfaceInfo(surfName);
    const sc = raw.scale === undefined ? [1, 1, 1] : typeof raw.scale === 'number' ? [raw.scale, raw.scale, raw.scale] : raw.scale;
    const uv = g.userData.ownUv ? Float32Array.from(g.attributes.uv.array) : partUVs(g, raw, sc, raw.uvScale ?? sinfo.scale);
    if (raw.uvOffset) for (let i = 0; i < n; i++) { uv[i * 2] += raw.uvOffset[0]; uv[i * 2 + 1] += raw.uvOffset[1]; }
    // clump normals (lump / sphere centred on the part origin), in part space
    const fol = raw.foliage > 0;
    const clump = fol && CLUMPS.has(raw.shape) ? new Float32Array(n * 3) : null;
    if (clump) for (let i = 0; i < n; i++) _v.fromBufferAttribute(pa, i).normalize().toArray(clump, i * 3);
    const pm = partMatrix(raw);
    g.applyMatrix4(pm);
    // colour: one brightness jitter per part (variety between planks, posts, leaves...)
    const color = new Float32Array(n * 3);
    _c.set(raw.color ?? '#888888');
    const k = 1 + (rng() - 0.5) * 2 * (raw.jitter ?? 0.06);
    for (let v = 0; v < n; v++) { color[v * 3] = _c.r * k; color[v * 3 + 1] = _c.g * k; color[v * 3 + 2] = _c.b * k; }
    const emissive = new Float32Array(n).fill(raw.emissive ?? 0);
    const surface = new Float32Array(n).fill(sinfo.id);
    const piece = { geometry: g, color, wind, emissive, uv, surface };
    if (fol) piece.normal = foliageShading(g, raw, clump, pm, color, q);
    pieces.push(piece);
  }
  return { pieces, glows };
}

/** Icosphere built at detail 0 (three gives it flat normals). */
const det0 = (p, q) => Math.max(0, (p.detail ?? 1) - (q <= 0.5 ? 1 : 0) - (q <= 0.25 ? 1 : 0) + (q > 0.6 && !p.foliage ? 1 : 0)) === 0;

/** A part's light halo (render/Glows.js), asset space: `glow: radius` or `{ size, color, intensity,
 *  flicker, blink, day, offset }`; colour defaults to the part's (display sRGB 0..1). */
function partGlow(raw) {
  const o = typeof raw.glow === 'number' ? { size: raw.glow } : raw.glow;
  const pm = partMatrix(raw);
  const color = _c.set(o.color ?? raw.color ?? '#ffffff').getRGB({}, THREE.SRGBColorSpace);
  return {
    pos: _v.fromArray(o.offset ?? [0, 0, 0]).applyMatrix4(pm).toArray(),
    size: (o.size ?? 1) * pm.getMaxScaleOnAxis(),
    color: [color.r, color.g, color.b],
    intensity: o.intensity ?? 1,
    flicker: o.flicker ?? 0,
    blink: o.blink ?? 0,
    day: o.day ?? 0,
  };
}

/** Per-vertex leaf shading normals (asset space, length 2 = leaf) — the facet normal turned to
 *  the outside of the crown, bent toward the crown / clump normal by the foliage weight (1 at the
 *  far LODs, whose coarser facets must not show) — and the crown occlusion baked into the colours.
 *  Same crown at every LOD = same lighting, whatever the tessellation. */
function foliageShading(g, raw, clump, pm, color, q) {
  const pa = g.attributes.position, n = pa.count;
  const normal = new Float32Array(n * 3);
  const w0 = Math.min(1, raw.foliage), w = q > 0.6 ? w0 : q > 0.3 ? w0 + (1 - w0) * 0.6 : 1;
  if (clump) {
    _nm.getNormalMatrix(pm);
    for (let i = 0; i < clump.length; i += 3) _v.fromArray(clump, i).applyMatrix3(_nm).normalize().toArray(clump, i);
  }
  const cr = raw.crown;
  let cx, cy, cz, rx, ry, rz;
  if (cr) [cx, cy, cz, rx, ry = rx, rz = rx] = cr;
  else {
    g.computeBoundingBox();
    const b = g.boundingBox;
    [cx, cy, cz] = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
    rx = Math.max(0.01, (b.max.x - b.min.x) / 2); ry = Math.max(0.01, (b.max.y - b.min.y) / 2); rz = Math.max(0.01, (b.max.z - b.min.z) / 2);
  }
  const k = cr ? (raw.clumpNormal ?? (clump ? 0.35 : 0)) : clump ? 1 : 0;
  const ao = cr ? (raw.ao ?? 0.5) : 0;
  for (let i = 0; i < n; i++) {
    const ex = (pa.getX(i) - cx) / rx, ey = (pa.getY(i) - cy) / ry, ez = (pa.getZ(i) - cz) / rz;
    _v.set(ex / rx, ey / ry, ez / rz);
    if (_v.lengthSq() < 1e-8) _v.set(0, 1, 0);
    _v.normalize().multiplyScalar(1 - k);
    if (k > 0) { _v.x += clump[i * 3] * k; _v.y += clump[i * 3 + 1] * k; _v.z += clump[i * 3 + 2] * k; }
    if (_v.lengthSq() < 1e-8) _v.set(0, 1, 0);
    _v.normalize().toArray(normal, i * 3);
    if (ao > 0) {
      // 1 on the upper shell of the crown, darker toward its core and its underside
      const d = Math.min(1, Math.sqrt(ex * ex + ey * ey + ez * ez));
      const occ = Math.min(1, Math.max(0, 0.3 + 0.7 * d + 0.25 * Math.max(-1, Math.min(1, ey))));
      const f = 1 - ao * (1 - occ);
      color[i * 3] *= f; color[i * 3 + 1] *= f; color[i * 3 + 2] *= f;
    }
  }
  // blend with the facet (turned to the crown's outside), length 2
  const P = pa.array;
  for (let t = 0; t < n; t += 3) {
    faceNormal(P, t, _f);
    for (let i = t; i < t + 3; i++) {
      _v.fromArray(normal, i * 3);
      const s = _f.dot(_v) < 0 ? -1 : 1;
      _v.multiplyScalar(w).addScaledVector(_f, s * (1 - w));
      if (_v.lengthSq() < 1e-8) _v.fromArray(normal, i * 3);
      _v.normalize().multiplyScalar(2).toArray(normal, i * 3);
    }
  }
  return normal;
}

const _f = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
/** Unit normal of the triangle starting at vertex t of a non-indexed position array. */
function faceNormal(P, t, out) {
  _e1.set(P[t * 3 + 3] - P[t * 3], P[t * 3 + 4] - P[t * 3 + 1], P[t * 3 + 5] - P[t * 3 + 2]);
  _e2.set(P[t * 3 + 6] - P[t * 3], P[t * 3 + 7] - P[t * 3 + 1], P[t * 3 + 8] - P[t * 3 + 2]);
  out.crossVectors(_e1, _e2);
  if (out.lengthSq() < 1e-20) out.set(0, 1, 0);
  return out.normalize();
}

/**
 * Build an asset: { geometry, bounds: Box3, triangles, colliders, glows }.
 * opts: { quality (LOD, 1 = full), seed (variant), assets (name -> def, for refs) }
 */
export function buildAsset(def, { quality = 1, seed, assets = {} } = {}) {
  const parts = resolveParts(def, assets, seed, quality);
  const { pieces, glows } = buildParts(parts, quality, assets, 0, seed, defaultSurface(def));
  let n = 0;
  for (const p of pieces) n += p.geometry.attributes.position.count;
  const hasFoliage = pieces.some((p) => p.normal);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), wind = new Float32Array(n), emis = new Float32Array(n);
  const nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), surf = new Float32Array(n);
  let o = 0;
  for (const p of pieces) {
    const a = p.geometry.attributes.position.array;
    const c = p.geometry.attributes.position.count;
    pos.set(a, o * 3);
    col.set(p.color, o * 3);
    wind.set(p.wind, o);
    emis.set(p.emissive, o);
    uv.set(p.uv, o * 2);
    surf.set(p.surface, o);
    if (p.normal) nrm.set(p.normal, o * 3);
    else if (p.geometry.attributes.normal) nrm.set(p.geometry.attributes.normal.array, o * 3);
    else for (let t = 0; t < c; t += 3) { faceNormal(a, t, _f); for (let i = t; i < t + 3; i++) _f.toArray(nrm, (o + i) * 3); }
    o += c;
    p.geometry.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('surface', new THREE.BufferAttribute(surf, 1));
  g.setAttribute('wind', new THREE.BufferAttribute(wind, 1));
  g.setAttribute('emissive', new THREE.BufferAttribute(emis, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const bounds = g.boundingBox.clone();
  const doubleSided = def.doubleSided ?? def.category === 'vegetation';
  const hasCutout = surf.some((s) => s >= 64);
  return { geometry: g, bounds, triangles: n / 3, colliders: resolveColliders(def, bounds, parts, seed), hasWind: wind.some((w) => w > 0), hasEmissive: emis.some((e) => e > 0), hasFoliage, hasCutout, doubleSided: doubleSided || hasCutout, glows };
}

/** Collision shapes in asset-local space: explicit list, 'auto' (bounding box) or from the generator. */
export function resolveColliders(def, bounds, parts, seed) {
  if (Array.isArray(def.collider)) return def.collider;
  if (def.collider === 'none') return [];
  if (def.collider === 'auto' || (!def.collider && def.category === 'prop')) {
    const s = bounds.getSize(new THREE.Vector3()), c = bounds.getCenter(new THREE.Vector3());
    return [{ type: 'box', size: [s.x, s.y, s.z], pos: [c.x, c.y, c.z] }];
  }
  if (def.generator) {
    const gen = GENERATORS[def.generator.type];
    const cl = gen?.collider?.(generatorParams(def, seed ?? def.generator.params?.seed ?? 1));
    if (cl) return cl;
  }
  void parts;
  return [];
}

/** Count triangles of an asset at a quality (for the editor stats / CLI). */
export function assetStats(def, assets) {
  const out = {};
  for (const q of [1, 0.5, 0.25]) {
    const b = buildAsset(def, { quality: q, assets });
    out[q] = b.triangles;
    b.geometry.dispose();
  }
  return out;
}
