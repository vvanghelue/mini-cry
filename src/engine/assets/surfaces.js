// Surface registry: the texture layers of public/data/textures.json by name, shared by the model
// builder (per-vertex `surface` id + UV scale), the materials (render/Surfaces.js) and the tools.
// Pure JS (browser + Node). Ids: 0..63 = opaque PBR surfaces (`surfaces` group), 64+ = alpha-cut
// foliage layers (`foliage` group).

export const FOLIAGE_BASE = 64;

// Default surface of a part from its asset's `material` (impact / footstep material).
export const MATERIAL_SURFACE = {
  wood: 'wood', metal: 'metal', stone: 'stone_block', concrete: 'concrete', sand: 'burlap',
  cloth: 'fabric', foliage: 'plain', water: 'plain',
};

let byName = new Map();
let manifest = null;

/** Register the layers (call once textures.json is loaded; ids follow the manifest order). */
export function setSurfaceManifest(m) {
  manifest = m;
  byName = new Map();
  (m?.surfaces?.layers ?? []).forEach((l, i) => byName.set(l.id, { id: i, scale: l.scale ?? 2, foliage: false }));
  (m?.foliage?.layers ?? []).forEach((l, i) => byName.set(l.id, { id: FOLIAGE_BASE + i, scale: 1, foliage: true }));
}

export const surfaceManifest = () => manifest;

/** { id, scale (m per texture repeat), foliage } for a surface name (unknown -> plain). */
export function surfaceInfo(name) {
  return byName.get(name) ?? byName.get('plain') ?? { id: 0, scale: 2, foliage: false };
}

export const surfaceNames = () => [...byName.keys()];
export const isFoliageSurface = (name) => !!byName.get(name)?.foliage;
