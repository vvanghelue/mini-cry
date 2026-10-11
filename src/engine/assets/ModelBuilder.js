// Low-poly model builder: turns an asset definition (JSON, public/data/assets/<name>.json) into a
// single merged, non-indexed BufferGeometry with per-vertex colour, `wind` (0 = rigid .. 1 =
// flexible leaf tip) and `emissive` attributes. Runs in the browser and in Node (CLI previews).
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
//   { shape: 'tris', positions: [x,y,z, ...] }                     (raw triangles)
//   { shape: 'ref', asset: 'name', pos, rot, scale }               (another asset, nested)
//   + modifiers: { repeat: { count, offset: [dx,dy,dz], rot: [deg...] } } or { radial: { count, radius, yaw0 } }
//   wind: number | [bottom, top] (gradient along the part's local height)
//   foliage: 0..1 — leaves: smooth shading normals bent from the facet toward a "crown" normal by
//     this weight (soft, volumetric canopies lit alike at every LOD; the weight goes to 1 at the
//     far LODs). With crown: [cx, cy, cz, r] or [cx, cy, cz, rx, ry, rz] (asset space) the normal
//     points out of that ellipsoid, mixed with the part's own sphere normal (lump / sphere) by
//     clumpNormal (0.35), and ao (0.5) darkens the vertices deep inside / under the crown.
// When any part has foliage the geometry gets a `normal` attribute: facet normals for the other
// parts, leaf normals stored with length 2 (the material tints / backlights leaves only).
import * as THREE from 'three';
import { mulberry32, hashString, fbm } from '../math/random.js';
import { GENERATORS } from './generators.js';

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
  const seg = (n, min = 3) => Math.max(min, Math.round((n ?? 6) * q));
  const det = (d) => Math.max(0, (d ?? 1) - (q <= 0.5 ? 1 : 0) - (q <= 0.25 ? 1 : 0));
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
      if (p.doubleSided) g = doubleSide(g);
      break;
    }
    case 'ref': {
      const def = assets?.[p.asset];
      if (!def || depth > 6) return null;
      return buildParts(resolveParts(def, assets, undefined, q), q, assets, depth + 1, p.seed);
    }
    default:
      throw new Error(`unknown part shape "${p.shape}"`);
  }
  if (g.index) g = g.toNonIndexed();
  return { geometry: g, part: p };
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

function buildParts(parts, q, assets, depth, seed) {
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
    // clump normals (lump / sphere centred on the part origin), in part space
    const fol = raw.foliage > 0;
    const clump = fol && CLUMPS.has(raw.shape) ? new Float32Array(n * 3) : null;
    if (clump) for (let i = 0; i < n; i++) _v.fromBufferAttribute(pa, i).normalize().toArray(clump, i * 3);
    const pm = partMatrix(raw);
    g.applyMatrix4(pm);
    // colour per face with optional jitter (faceted variety)
    const color = new Float32Array(n * 3);
    _c.set(raw.color ?? '#888888');
    const jit = raw.jitter ?? 0.06;
    for (let f = 0; f < n; f += 3) {
      const k = 1 + (rng() - 0.5) * 2 * jit;
      for (let v = f; v < f + 3 && v < n; v++) { color[v * 3] = _c.r * k; color[v * 3 + 1] = _c.g * k; color[v * 3 + 2] = _c.b * k; }
    }
    const emissive = new Float32Array(n).fill(raw.emissive ?? 0);
    const piece = { geometry: g, color, wind, emissive };
    if (fol) piece.normal = foliageShading(g, raw, clump, pm, color, q);
    pieces.push(piece);
  }
  return { pieces, glows };
}

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
  const { pieces, glows } = buildParts(parts, quality, assets, 0, seed);
  let n = 0;
  for (const p of pieces) n += p.geometry.attributes.position.count;
  const hasFoliage = pieces.some((p) => p.normal);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), wind = new Float32Array(n), emis = new Float32Array(n);
  const nrm = hasFoliage ? new Float32Array(n * 3) : null;
  let o = 0;
  for (const p of pieces) {
    const a = p.geometry.attributes.position.array;
    const c = p.geometry.attributes.position.count;
    pos.set(a, o * 3);
    col.set(p.color, o * 3);
    wind.set(p.wind, o);
    emis.set(p.emissive, o);
    if (hasFoliage) {
      if (p.normal) nrm.set(p.normal, o * 3);
      else for (let t = 0; t < c; t += 3) { faceNormal(a, t, _f); for (let i = t; i < t + 3; i++) _f.toArray(nrm, (o + i) * 3); } // smooth-shaded material: facets
    }
    o += c;
    p.geometry.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('wind', new THREE.BufferAttribute(wind, 1));
  g.setAttribute('emissive', new THREE.BufferAttribute(emis, 1));
  if (hasFoliage) g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const bounds = g.boundingBox.clone();
  const doubleSided = def.doubleSided ?? def.category === 'vegetation';
  return { geometry: g, bounds, triangles: n / 3, colliders: resolveColliders(def, bounds, parts, seed), hasWind: wind.some((w) => w > 0), hasEmissive: emis.some((e) => e > 0), hasFoliage, doubleSided, glows };
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
