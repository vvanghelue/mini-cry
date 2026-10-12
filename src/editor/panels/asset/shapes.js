// Asset editor helpers: shape catalogue (labels, defaults, inspector fields), categories,
// templates for "New", JSON formatting in the compact one-part-per-line style of
// public/data/assets/*.json, and small immutable-update utilities.

export const CATEGORIES = [
  { value: 'prop', label: 'Prop' },
  { value: 'building', label: 'Building' },
  { value: 'vegetation', label: 'Vegetation' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'weapon', label: 'Weapon' },
  { value: 'pickup', label: 'Pickup' },
  { value: 'fx', label: 'Effect' },
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

export const MATERIALS = [
  { value: 'wood', label: 'Wood' },
  { value: 'metal', label: 'Metal' },
  { value: 'stone', label: 'Stone' },
  { value: 'concrete', label: 'Concrete' },
  { value: 'sand', label: 'Sand' },
  { value: 'foliage', label: 'Foliage' },
  { value: 'cloth', label: 'Cloth' },
  { value: 'water', label: 'Water' },
];

export const SHAPES = ['box', 'cylinder', 'cone', 'sphere', 'lump', 'limb', 'wedge', 'plane', 'frond', 'card', 'cards', 'tris', 'ref'];
export const SHAPE_LABEL = {
  box: 'Box', cylinder: 'Cylinder', cone: 'Cone', sphere: 'Sphere', lump: 'Noisy lump', limb: 'Tube',
  wedge: 'Prism', plane: 'Plane', frond: 'Frond', card: 'Card', cards: 'Cards', tris: 'Triangles', ref: 'Reference',
};
export const SHAPE_ICON = { box: '▣', cylinder: '⌭', cone: '▲', sphere: '●', lump: '☁', limb: '⟋', wedge: '⌂', plane: '▭', frond: '❧', card: '▯', cards: '❖', tris: '◺', ref: '⎘' };
export const SHAPE_HELP = {
  box: 'Box centered on pos (walls, planks, crates)',
  cylinder: 'Y-axis cylinder centered on pos (posts, barrels)',
  cone: 'Y-axis cone centered on pos',
  sphere: 'Icosphere (use the scale to flatten it)',
  lump: 'Noisy icosphere: rocks, foliage',
  limb: 'Tapered tube between two points (branches, ropes, pipes)',
  wedge: 'Triangular prism, ridge on top along Z: roofs',
  plane: 'Horizontal quad (rotate it)',
  frond: 'Drooping leaf strip (palm fronds, ferns); with a foliage surface: a textured strip',
  card: 'Upright textured quad, base at pos (leaf / grass cards: give it a foliage surface)',
  cards: 'Many textured quads [base xyz, tip dir xyz, width axis xyz, w, h] (leaf clusters)',
  tris: 'Raw triangles (positions x,y,z…)',
  ref: 'Inserts another asset',
};

/** Shape-specific defaults (also the values shown when a field is absent). */
export const SHAPE_DEFAULTS = {
  box: { size: [1, 1, 1] },
  cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1, segments: 8 },
  cone: { radius: 0.5, height: 1, segments: 8 },
  sphere: { radius: 0.5, detail: 1 },
  lump: { radius: 0.5, detail: 1, noise: 0.25, seed: 1 },
  limb: { from: [0, 0, 0], to: [0, 1, 0], r0: 0.1, r1: 0.05, segments: 6 },
  wedge: { size: [1, 1, 1] },
  plane: { size: [1, 1] },
  frond: { base: [0, 0, 0], yaw: 0, pitch: 20, length: 2, width: 0.4, droop: 0.8, segs: 6, fold: 0.3 },
  tris: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
  card: { size: [1, 1], surface: 'grass' },
  cards: { cards: [[0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1]], surface: 'leaves_broad' },
  ref: { asset: '' },
};
/** Position given to a freshly added part so it sits on the ground. */
export const SHAPE_NEW_POS = { box: [0, 0.5, 0], cylinder: [0, 0.5, 0], cone: [0, 0.5, 0], sphere: [0, 0.5, 0], lump: [0, 0.5, 0], plane: [0, 0.01, 0] };

/** Keys common to every shape (kept when the shape changes). */
export const COMMON_KEYS = ['pos', 'rot', 'scale', 'color', 'surface', 'uvScale', 'smooth', 'jitter', 'wind', 'emissive', 'foliage', 'crown', 'clumpNormal', 'ao', 'minQuality', 'repeat', 'radial', 'doubleSided'];

const radTop = (p) => p.radiusTop ?? p.radius ?? 0.5;
const radBot = (p) => p.radiusBottom ?? p.radius ?? 0.5;
/** Inspector fields per shape: { k, type: num|int|vec3|vec2|bool|json|asset, label, def, step, min, max, get?, set? } */
export const SHAPE_FIELDS = {
  box: [
    { k: 'size', type: 'vec3', label: 'Size (w, h, d)', def: [1, 1, 1], step: 0.05 },
    { k: 'taper', type: 'num', label: 'Taper top', def: 1, step: 0.01, min: 0, max: 4, optional: true, title: 'x/z scale of the top face (1 = straight)' },
  ],
  cylinder: [
    { k: 'radiusTop', type: 'num', label: 'Top radius', step: 0.01, min: 0, get: radTop, set: (p, v) => cylRadius(p, v, radBot(p)) },
    { k: 'radiusBottom', type: 'num', label: 'Bottom radius', step: 0.01, min: 0, get: radBot, set: (p, v) => cylRadius(p, radTop(p), v) },
    { k: 'height', type: 'num', label: 'Height', def: 1, step: 0.05, min: 0 },
    { k: 'segments', type: 'int', label: 'Segments', def: 8, step: 0.2, min: 3, max: 32 },
    { k: 'open', type: 'bool', label: 'Open (no caps)' },
  ],
  cone: [
    { k: 'radius', type: 'num', label: 'Radius', def: 0.5, step: 0.01, min: 0 },
    { k: 'height', type: 'num', label: 'Height', def: 1, step: 0.05, min: 0 },
    { k: 'segments', type: 'int', label: 'Segments', def: 8, step: 0.2, min: 3, max: 32 },
  ],
  sphere: [
    { k: 'radius', type: 'num', label: 'Radius', def: 0.5, step: 0.01, min: 0 },
    { k: 'detail', type: 'int', label: 'Detail (0–2)', def: 1, step: 0.05, min: 0, max: 3 },
  ],
  lump: [
    { k: 'radius', type: 'num', label: 'Radius', def: 0.5, step: 0.01, min: 0 },
    { k: 'detail', type: 'int', label: 'Detail (0–2)', def: 1, step: 0.05, min: 0, max: 3 },
    { k: 'noise', type: 'num', label: 'Noise (0–0.4)', def: 0.25, step: 0.005, min: 0, max: 1 },
    { k: 'seed', type: 'int', label: 'Seed', def: 1, step: 0.2 },
  ],
  limb: [
    { k: 'from', type: 'vec3', label: 'Start', def: [0, 0, 0], step: 0.05 },
    { k: 'to', type: 'vec3', label: 'End', def: [0, 1, 0], step: 0.05 },
    { k: 'r0', type: 'num', label: 'Start radius', def: 0.1, step: 0.005, min: 0 },
    { k: 'r1', type: 'num', label: 'End radius', def: 0.05, step: 0.005, min: 0 },
    { k: 'segments', type: 'int', label: 'Segments', def: 6, step: 0.2, min: 3, max: 32 },
    { k: 'open', type: 'bool', label: 'Open', def: true },
  ],
  wedge: [{ k: 'size', type: 'vec3', label: 'Size (w, h, d)', def: [1, 1, 1], step: 0.05 }],
  plane: [
    { k: 'size', type: 'vec2', label: 'Size (w, d)', def: [1, 1], step: 0.05 },
    { k: 'doubleSided', type: 'bool', label: 'Double-sided' },
  ],
  frond: [
    { k: 'base', type: 'vec3', label: 'Base', def: [0, 0, 0], step: 0.05 },
    { k: 'yaw', type: 'num', label: 'Yaw (°)', def: 0, step: 1 },
    { k: 'pitch', type: 'num', label: 'Pitch (°)', def: 20, step: 1 },
    { k: 'length', type: 'num', label: 'Length', def: 2, step: 0.02, min: 0 },
    { k: 'width', type: 'num', label: 'Width', def: 0.4, step: 0.01, min: 0 },
    { k: 'droop', type: 'num', label: 'Droop', def: 0.8, step: 0.02 },
    { k: 'segs', type: 'int', label: 'Segments', def: 6, step: 0.2, min: 2, max: 24 },
    { k: 'fold', type: 'num', label: 'Fold', def: 0.3, step: 0.01 },
    { k: 'taper', type: 'num', label: 'Taper', def: 0.9, step: 0.01 },
    { k: 'pinnate', type: 'bool', label: 'Pinnate', title: 'One triangular leaflet per segment and per side (coconut palm fronds)' },
    { k: 'leafletBase', type: 'num', label: 'Leaflet base', def: 0.6, step: 0.01, min: 0.05, max: 1, optional: true, title: 'Share of the segment covered by the base of each leaflet (pinnate)' },
    { k: 'twist', type: 'num', label: 'Twist (°)', def: 0, step: 1, optional: true, title: 'Roll of a textured frond along its length' },
    { k: 'doubleSided', type: 'bool', label: 'Double-sided' },
  ],
  tris: [
    { k: 'positions', type: 'json', label: 'Positions', def: [] },
    { k: 'doubleSided', type: 'bool', label: 'Double-sided' },
  ],
  card: [{ k: 'size', type: 'vec2', label: 'Size (w, h)', def: [1, 1], step: 0.02 }],
  cards: [{ k: 'cards', type: 'json', label: 'Cards', def: [] }],
  ref: [{ k: 'asset', type: 'asset', label: 'Asset' }],
};

function cylRadius(p, top, bottom) {
  const n = { ...p, radiusTop: top, radiusBottom: bottom };
  delete n.radius;
  return n;
}

/** Change a part's shape, keeping the common fields (transform, colour, modifiers…). */
export function changeShape(p, shape) {
  const n = { shape };
  for (const k of COMMON_KEYS) if (p[k] !== undefined) n[k] = p[k];
  return { ...n, ...structuredClone(SHAPE_DEFAULTS[shape]) };
}

export function newPart(shape, from) {
  const p = { shape, ...structuredClone(SHAPE_DEFAULTS[shape]) };
  if (SHAPE_NEW_POS[shape]) p.pos = [...SHAPE_NEW_POS[shape]];
  p.color = from?.color ?? '#8a6a3a';
  if (shape === 'frond') { p.color = from?.color ?? '#3f7a1c'; p.wind = 1; }
  return p;
}

/** One-line summary of a part for the list. */
export function partSummary(p) {
  const f = (v) => (typeof v === 'number' ? +v.toFixed(2) : v);
  const v3 = (a) => (Array.isArray(a) ? a.map(f).join('×') : '');
  switch (p.shape) {
    case 'box': case 'wedge': case 'plane': return v3(p.size ?? SHAPE_DEFAULTS[p.shape].size);
    case 'cylinder': return `r ${f(radTop(p))}/${f(radBot(p))} h ${f(p.height ?? 1)}`;
    case 'cone': case 'sphere': case 'lump': return `r ${f(p.radius ?? 0.5)}`;
    case 'limb': {
      const a = p.from ?? [0, 0, 0], b = p.to ?? [0, 1, 0];
      return `L ${f(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))}`;
    }
    case 'frond': return `L ${f(p.length ?? 2)} · ${f(p.yaw ?? 0)}°`;
    case 'tris': return `${Math.floor((p.positions?.length ?? 0) / 9)} tri`;
    case 'ref': return p.asset || '?';
    default: return '';
  }
}

// --- numbers / immutable helpers ---------------------------------------------------------------
export const rnd = (v, d = 3) => { const k = 10 ** d; const r = Math.round(v * k) / k; return Object.is(r, -0) ? 0 : r; };
/** Round every number of a JSON value (bake output, gizmo results). */
export function roundDeep(v, d = 4) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : rnd(v, d);
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, d));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = roundDeep(x, d);
    return o;
  }
  return v;
}
/** Shallow object update that deletes keys set to undefined. */
export function patchObj(o, patch) {
  const n = { ...o, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete n[k];
  return n;
}
export const move = (arr, i, j) => {
  if (j < 0 || j >= arr.length) return arr;
  const a = [...arr];
  const [x] = a.splice(i, 1);
  a.splice(j, 0, x);
  return a;
};

// --- JSON formatting (same compact style as the hand-written asset files) ------------------------
const KEY_ORDER = ['name', 'category', 'label', 'material', 'tags', 'doubleSided', 'lods', 'muzzle', 'sight', 'magazine', 'generator'];

export function compact(v) {
  if (Array.isArray(v)) return '[' + v.map(compact).join(', ') + ']';
  if (v && typeof v === 'object') {
    const e = Object.entries(v).filter(([, x]) => x !== undefined);
    return e.length ? '{ ' + e.map(([k, x]) => JSON.stringify(k) + ': ' + compact(x)).join(', ') + ' }' : '{}';
  }
  return JSON.stringify(v);
}

/** Asset definition -> file text: one key per line, parts / colliders one per line. */
export function formatAsset(def) {
  const keys = [...KEY_ORDER.filter((k) => k in def), ...Object.keys(def).filter((k) => !KEY_ORDER.includes(k) && k !== 'parts' && k !== 'collider'), ...['parts', 'collider'].filter((k) => k in def)];
  const lines = [];
  for (const k of keys) {
    const v = def[k];
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x)) && (k === 'parts' || k === 'collider' || v.length > 2)) {
      lines.push(`  ${JSON.stringify(k)}: [\n${v.map((x) => '    ' + compact(x)).join(',\n')}\n  ]`);
    } else lines.push(`  ${JSON.stringify(k)}: ${compact(v)}`);
  }
  return '{\n' + lines.join(',\n') + '\n}\n';
}

// --- templates -----------------------------------------------------------------------------------
export const TEMPLATES = [
  { id: 'empty', label: 'Empty', help: 'No parts', make: () => ({ category: 'prop', label: 'New prop', material: 'wood', tags: [], parts: [], collider: 'auto' }) },
  {
    id: 'box', label: 'Crate (prop)', help: 'A box sitting on the ground', make: () => ({
      category: 'prop', label: 'New crate', material: 'wood', tags: ['cover'],
      parts: [
        { shape: 'box', size: [1, 1, 1], pos: [0, 0.5, 0], color: '#9a7446', jitter: 0.07 },
        { shape: 'box', size: [1.04, 0.1, 1.04], pos: [0, 0.05, 0], color: '#6e5030', repeat: { count: 2, offset: [0, 0.9, 0] } },
      ],
      collider: 'auto',
    }),
  },
  {
    id: 'barrel', label: 'Barrel (prop)', help: 'Cylinder with hoops', make: () => ({
      category: 'prop', label: 'New barrel', material: 'metal', tags: ['cover'],
      parts: [
        { shape: 'cylinder', radius: 0.3, height: 0.9, segments: 8, pos: [0, 0.45, 0], color: '#4f6a3a' },
        { shape: 'cylinder', radius: 0.315, height: 0.05, segments: 8, pos: [0, 0.15, 0], color: '#3d5230', repeat: { count: 2, offset: [0, 0.6, 0] } },
      ],
      collider: [{ type: 'cylinder', radius: 0.3, height: 0.9, pos: [0, 0.45, 0] }],
    }),
  },
  {
    id: 'building', label: 'Building (shell)', help: 'Slab, 4 walls with a door at the front (-Z), roof, colliders', make: () => ({
      category: 'building', label: 'New building', material: 'wood', tags: ['building'],
      parts: [
        { shape: 'box', size: [5.2, 0.2, 4.2], pos: [0, 0.1, 0], color: '#8f877a' },
        { shape: 'box', size: [5, 2.8, 0.2], pos: [0, 1.6, 1.9], color: '#c9b48a' },
        { shape: 'box', size: [0.2, 2.8, 3.6], pos: [-2.4, 1.6, 0], color: '#c2ad84' },
        { shape: 'box', size: [0.2, 2.8, 3.6], pos: [2.4, 1.6, 0], color: '#c2ad84' },
        { shape: 'box', size: [1.8, 2.8, 0.2], pos: [-1.6, 1.6, -1.9], color: '#cbb68c' },
        { shape: 'box', size: [1.8, 2.8, 0.2], pos: [1.6, 1.6, -1.9], color: '#cbb68c' },
        { shape: 'box', size: [1.4, 0.6, 0.2], pos: [0, 2.7, -1.9], color: '#b9a37a' },
        { shape: 'box', size: [0.06, 0.8, 1], pos: [-2.51, 1.7, 0], color: '#33424c', minQuality: 0.5 },
        { shape: 'wedge', size: [5.8, 1.4, 4.8], pos: [0, 3, 0], color: '#7a5a3a' },
      ],
      collider: [
        { type: 'box', size: [5.2, 0.2, 4.2], pos: [0, 0.1, 0] },
        { type: 'box', size: [5, 2.8, 0.2], pos: [0, 1.6, 1.9] },
        { type: 'box', size: [0.2, 2.8, 3.6], pos: [-2.4, 1.6, 0] },
        { type: 'box', size: [0.2, 2.8, 3.6], pos: [2.4, 1.6, 0] },
        { type: 'box', size: [1.8, 2.8, 0.2], pos: [-1.6, 1.6, -1.9] },
        { type: 'box', size: [1.8, 2.8, 0.2], pos: [1.6, 1.6, -1.9] },
        { type: 'box', size: [1.4, 0.6, 0.2], pos: [0, 2.7, -1.9] },
        { type: 'box', size: [5.8, 0.4, 4.8], pos: [0, 3.2, 0], walkable: false },
      ],
    }),
  },
  { id: 'tree', label: 'Tree (generator)', help: 'Procedural broadleaf tree, one variant per seed', make: () => ({ category: 'vegetation', label: 'New tree', material: 'foliage', generator: { type: 'broadleaf', params: {} } }) },
  { id: 'palm', label: 'Palm (generator)', help: 'Procedural palm tree', make: () => ({ category: 'vegetation', label: 'New palm', material: 'foliage', generator: { type: 'palm', params: {} } }) },
  { id: 'rock', label: 'Rock (generator)', help: 'Procedural rock', make: () => ({ category: 'vegetation', label: 'New rock', material: 'stone', generator: { type: 'rock', params: {} } }) },
  {
    id: 'weapon', label: 'Weapon (rifle)', help: 'Origin at the grip, barrel toward -Z, muzzle / sight / magazine points', make: () => ({
      category: 'weapon', label: 'New weapon', material: 'metal', tags: ['weapon'],
      muzzle: [0, 0.075, -0.74], sight: [0, 0.135, -0.1], magazine: [0, -0.04, -0.13],
      parts: [
        { shape: 'box', size: [0.06, 0.09, 0.42], pos: [0, 0.06, -0.12], color: '#3a3d40' },
        { shape: 'cylinder', radius: 0.013, height: 0.36, segments: 6, pos: [0, 0.075, -0.55], rot: [90, 0, 0], color: '#2b2d30' },
        { shape: 'box', size: [0.056, 0.06, 0.22], pos: [0, 0.055, -0.42], color: '#6b4e2e' },
        { shape: 'box', size: [0.05, 0.1, 0.26], pos: [0, 0.035, 0.21], color: '#6b4e2e', taper: 0.9 },
        { shape: 'box', size: [0.035, 0.11, 0.05], pos: [0, -0.03, 0.02], rot: [-15, 0, 0], color: '#2b2d30' },
        { shape: 'box', size: [0.03, 0.14, 0.06], pos: [0, -0.04, -0.13], rot: [-10, 0, 0], color: '#3a3d40' },
        { shape: 'box', size: [0.012, 0.035, 0.012], pos: [0, 0.11, -0.7], color: '#2b2d30', minQuality: 0.5 },
        { shape: 'box', size: [0.03, 0.025, 0.04], pos: [0, 0.115, -0.08], color: '#2b2d30', minQuality: 0.5 },
      ],
      collider: 'none',
    }),
  },
];

/** Named 3D points shown as markers (weapons: muzzle / sight / magazine; vehicles: wheels / seats). */
export const POINT_KEYS = [
  { k: 'muzzle', label: 'Muzzle', color: 0xff5a4d },
  { k: 'sight', label: 'Sight', color: 0x4fe0ff },
  { k: 'magazine', label: 'Magazine', color: 0xffa64d },
];
export const POINT_LIST_KEYS = [
  { k: 'wheels', label: 'Wheels', color: 0xc77dff },
  { k: 'seats', label: 'Seats', color: 0x7dff9a },
];
