# Mini Cry — asset format

Every 3D model of the game (except the rigged characters, which are Quaternius GLBs in
`public/models/`) is a JSON file in `public/data/assets/<name>.json`, built at load time by
`src/engine/assets/ModelBuilder.js` into one merged geometry with normals (smooth on round parts,
crisp on boxes), metric texture coordinates and a per-vertex texture layer (`surface`). Colour
comes from the parts, the material detail from photo textures (docs/TEXTURES.md): each texel is
divided by its layer's mean colour, so a part's `color` still sets its colour.

## Conventions

- Units: **metres**. +Y is up. The asset origin is at **ground level, centre** of the footprint
  (the lowest point of a building/prop sits at y = 0).
- The **front** of an asset faces **-Z** (three.js forward). Doors, ladders, gun barrels point to -Z.
- Rotations in parts are in **degrees** (`rot: [x, y, z]`, applied Y then X then Z).
- Weapons: origin at the **grip** (where the right hand holds it), barrel along **-Z**, sights
  along +Y. Real-world size (a pistol is ~0.2 m long, a rifle ~0.9 m).
- Keep triangle counts reasonable: props 20–600 tris, buildings 100–2500 tris. Cylinders 5–8
  segments (the builder adds ~60 % at LOD 0 and smooths them).
- Palette: natural, slightly dusty tropical colours, sRGB hex strings (`"#8a6a3a"`).
  Avoid pure black/white; vary tones between parts (planks alternate 2–3 browns). `jitter`
  (default 0.06) varies each part's brightness by ±jitter.
- Texture: give each part a `surface` that matches what it is made of (`wood_planks` walls,
  `corrugated` / `thatch` roofs, `burlap` sandbags, `stone_block` fort walls...). Without one, a
  part uses the asset's `surface`, else the default of its `material`.

## File structure

```json
{
  "name": "crate",               // = file name
  "category": "prop",            // prop | building | vegetation | vehicle | weapon | pickup | fx
  "label": "Wooden crate",       // display name (editor)
  "material": "wood",            // impact / footstep material: wood | metal | stone | concrete | sand | foliage | cloth | water
  "tags": ["cover", "camp"],     // free tags (editor filters)
  "parts": [ ... ],
  "collider": [ ... ] | "auto" | "none",   // default for props: "auto" (bounding box)
  "lods": [{ "distance": 150, "quality": 1 }, { "distance": 800, "quality": 0.5 }]  // optional
}
```

## Parts

All parts accept `pos: [x,y,z]`, `rot: [x,y,z]` (deg), `scale: n | [x,y,z]`, `color`,
`surface` (texture layer: `plain`, `wood_planks`, `wood`, `metal`, `metal_smooth`, `corrugated`,
`concrete`, `plaster`, `stone_block`, `stone_rubble`, `thatch`, `fabric`, `burlap`, `bark`,
`palm_bark`, `rock`; foliage: `leaves_broad`, `leaves_jungle`, `leaf_mass`, `palm_frond`, `fern`,
`grass`, `banana`, `strap`, `flowers`, `bush` — see `textures.json`), `uvScale` (metres per texture
repeat, default: the layer's), `smooth` (smooth / faceted normals, default smooth for round
shapes), `jitter`,
`wind` (0 rigid … 1 leaf tip, or `[bottom, top]` gradient), `emissive` (0..2, self-lit: bulbs,
fire, screens), `minQuality` (part kept only when the LOD quality >= minQuality; props switch to quality 0.5
at distance, so use `minQuality: 0.6` for details that should vanish there).

Lights take `glow`: a halo drawn around the part's origin on static props (`render/Glows.js`), faded
in at dusk, hidden by what stands between the light and the camera, still a point of light far
away. `"glow": 1.5` (radius in m) or `{ "size": 1.5, "color": "#ffd890" (default: the part's),
"intensity": 1, "flicker": 0.5 (fires), "blink": 1.6 (period in s: beacons), "day": 0.2 (share kept
by day), "offset": [x, y, z] (part space) }`. Give it to the bulb / flame part, not to the lamp.

Leaves also take `foliage` (0..1): their shading normal is bent from the facet toward a smooth
crown normal by that weight (baked at build time; weight 1 at the far LODs so their coarser facets
don't show), which gives soft, volumetric canopies lit alike at every LOD, plus a per-instance
tint and some light through the leaves on the shaded side of the crown (`environment.json`
`foliageTransmission`). `crown: [cx, cy, cz, r]` or `[cx, cy, cz, rx, ry, rz]` (asset space) is the
ellipsoid the normals point out of — give every leaf part of a tree the same crown, at every
LOD — mixed with the part's own sphere normal for `lump` / `sphere` (`clumpNormal`, default 0.35);
`ao` (default 0.5) darkens the leaves deep inside and under the crown. Without `crown`, a lump
uses its own sphere normal. An asset with foliage is drawn smooth-shaded from baked normals
(facet normals for its other parts, so they still look faceted).

| shape | fields | notes |
|---|---|---|
| `box` | `size: [w,h,d]`, `taper` (0..1 top face scale) | centred on `pos` |
| `cylinder` | `radiusTop`, `radiusBottom` (or `radius`), `height`, `segments`, `open` | centred on `pos`, axis Y |
| `cone` | `radius`, `height`, `segments` | centred on `pos` |
| `sphere` | `radius`, `detail` (0–2, icosphere) | use `scale` to squash |
| `lump` | `radius`, `detail`, `noise` (0..0.4), `seed` | noisy icosphere: rocks, foliage blobs |
| `limb` | `from: [x,y,z]`, `to: [x,y,z]`, `r0`, `r1`, `segments` | tapered tube between two points (posts, ropes, pipes, branches) |
| `wedge` | `size: [w,h,d]` | triangular prism, ridge along Z at the top: roofs |
| `plane` | `size: [w,d]`, `doubleSided` | horizontal quad (rotate it) |
| `frond` | `base`, `yaw`, `pitch` (deg), `length`, `width`, `droop`, `segs`, `fold`, `taper`, `pinnate`, `twist` | drooping leaf strip; with a foliage `surface` (palm_frond, fern, banana, strap): a V-folded strip of constant half-width `width`, the leaf outline from the texture (u across, base at the bottom of the image). Untextured: `pinnate: true` = one leaflet triangle per segment and side |
| `card` | `size: [w, h]` | upright quad, base centred on `pos`, uv 0..1 (leaf / grass cards) |
| `cards` | `cards: [[x,y,z, dx,dy,dz, ux,uy,uz, w, h], ...]` | many quads in one part: base point, unit direction to the tip, unit width axis, size (tree crowns: generators emit them) |
| `tris` | `positions: [x,y,z, ...]` | raw triangles (CCW = front) |
| `ref` | `asset`, `pos`, `rot`, `scale` | embeds another asset |

Modifiers on any part:
- `"repeat": { "count": 8, "offset": [0.3, 0, 0], "rot": [0, 0, 0] }` — planks, fence posts, steps.
- `"radial": { "count": 6, "radius": 1.2, "yaw0": 0 }` — copies around the Y axis.

Generators (`"generator": { "type": "palm", "params": {...} }`, see `src/engine/assets/generators.js`):
palm, tree (generic branching tree; jungleTree and broadleaf are presets of it), pandanus, bush,
fern, banana, grass, flowers, rock, bamboo, deadTree. They texture their parts themselves: bark /
palm bark trunks, fronds and leaves as alpha-cut textured strips and cards, tree crowns as a core
in the `leaf_mass` layer wrapped in leaf-cluster cards (`leafTexture`, `leafCards` per clump),
grass as crossed cards. Each seed gives a variant (the world uses
seed = variant + 1). `params.forms: [{...}, ...]` gives one asset several sub-types: variant v uses
the params merged with `forms[v % forms.length]` (e.g. round / spreading / tall broadleaf trees,
coconut / royal / young palms).

Tree generators keep their LODs coherent: the structure (trunk, lean toward +X, branches, leaf
clumps, fronds, colours) is drawn once from the seed whatever the quality; quality only changes
tessellation and drops small details (lianas, coconuts), and the mid / far LODs merge the leaf
clumps into a few ellipsoids covering the same crown (fewer, bigger leaf cards). Keep that rule when
writing a generator: never branch on quality before all random numbers are drawn. Check with
`mc asset shot <name> --lineup` (every variant at qualities 1 / 0.5 / 0.25 side by side).

## Vehicles

Vehicle bodies (category `vehicle`, listed in `VEHICLE_KINDS` of `src/game/entities/index.js`;
driving / flight specs in `src/game/vehicles/Vehicles.js`): origin at ground level under the
wheels, front toward -Z, `"collider": "none"` (the game adds a box). Moving parts are separate
assets placed by the entity: `wheels: [[x, y, z], ...]` (wheel centres, front first: they steer;
the jeep) and `propeller: [x, y, z]` (hub of the `plane_propeller` asset, spun about Z; the plane).
`seats: [[x, y, z], ...]` are the occupants' hips.

## Colliders

Collision shapes in asset space (same transform conventions):
```json
"collider": [
  { "type": "box", "size": [4, 0.2, 4], "pos": [0, 1.6, 0] },        // a floor you can walk on
  { "type": "box", "size": [0.6, 2.8, 0.3], "pos": [0, 1.4, -2.2], "ladder": true },  // climbable ladder volume
  { "type": "cylinder", "radius": 0.15, "height": 1.6, "pos": [1.8, 0.8, 1.8] },
  { "type": "sphere", "radius": 1.2, "pos": [0, 0.8, 0] }
]
```
- Characters walk on top of boxes and step up ≤ 0.45 m: **stairs = stacked boxes, ≤ 0.35 m rise
  each**. Floors of raised buildings are boxes; walls are thin boxes. Leave door openings (≥ 1.2 m
  wide, ≥ 2.1 m high) free of colliders so the player and AI can enter.
- Box colliders can be rotated about Y only (`rot: [0, deg, 0]`).
- `"ladder": true` boxes let the player climb by walking into them.
- `"walkable": false` on a box prevents standing on top (e.g. roofs with a steep pitch).
- Bullets use the same shapes: keep cover objects (sandbags, crates, walls) with solid colliders.

## Tools

```bash
npm run mc -- asset list [--category prop]     # names, tris per LOD
npm run mc -- asset validate [name]            # builds, reports errors
npm run mc -- asset shot <name> [--yaw 35] [--variant 0] [--quality 1]   # PNG in shots/ to look at it
npm run mc -- asset shot <name> --lineup [variants]  # every variant x LOD quality side by side
npm run mc -- asset bake <name> --as <new>     # generator -> editable parts
npm run mc -- asset reindex                    # refresh assets/index.json (run after adding files)
```
