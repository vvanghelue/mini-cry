# Mini Cry — low-poly asset format

Every 3D model of the game (except the rigged characters, which are Quaternius GLBs in
`public/models/`) is a JSON file in `public/data/assets/<name>.json`, built at load time by
`src/engine/assets/ModelBuilder.js` into one merged, flat-shaded, vertex-coloured geometry.
No textures: colour comes from the parts, the faceted look from flat shading. Flat-coloured
GLB models (e.g. the CC0 Quaternius guns) are converted to this format by `mc asset import`:
one `tris` part per material colour, plus a `source` block (URL, author, licence, import
parameters) so the import can be redone.

## Conventions

- Units: **metres**. +Y is up. The asset origin is at **ground level, centre** of the footprint
  (the lowest point of a building/prop sits at y = 0).
- The **front** of an asset faces **-Z** (three.js forward). Doors, ladders, gun barrels point to -Z.
- Rotations in parts are in **degrees** (`rot: [x, y, z]`, applied Y then X then Z).
- Weapons: origin at the **grip** (where the right hand holds it), barrel along **-Z**, sights
  along +Y. Real-world size (a pistol is ~0.2 m long, a rifle ~0.9 m). See *Weapons* below for
  `muzzle`, `sight`, `magazine` and the first-person `hands`.
- Keep triangle counts low: props 20–400 tris, buildings 100–1500 tris. Cylinders 5–8 segments.
- Palette: saturated but slightly dusty tropical colours, sRGB hex strings (`"#8a6a3a"`).
  Avoid pure black/white; vary tones between parts (planks alternate 2–3 browns). `jitter`
  (default 0.06) randomises each face's brightness by ±jitter for the faceted look.

## File structure

```json
{
  "name": "crate",               // = file name
  "category": "prop",            // prop | building | vegetation | vehicle | weapon | pickup | fx | animal
  "label": "Wooden crate",       // display name (editor)
  "material": "wood",            // impact / footstep material: wood | metal | stone | concrete | sand | foliage | cloth | water
  "tags": ["cover", "camp"],     // free tags (editor filters)
  "parts": [ ... ],
  "collider": [ ... ] | "auto" | "none",   // default for props: "auto" (bounding box)
  "lods": [{ "distance": 150, "quality": 1 }, { "distance": 800, "quality": 0.5 }]  // optional
}
```

## Parts

All parts accept `pos: [x,y,z]`, `rot: [x,y,z]` (deg), `scale: n | [x,y,z]`, `color`, `jitter`,
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
| `frond` | `base`, `yaw`, `pitch` (deg), `length`, `width`, `droop`, `segs`, `fold`, `taper`, `pinnate` | drooping leaf strip; `pinnate: true` = one leaflet triangle per segment and side (coconut fronds: `leafletBase` 0..1 share of the segment the leaflet base covers, `leafletReach`, `pinnateStart`) |
| `tris` | `positions: [x,y,z, ...]` | raw triangles (CCW = front) |
| `ref` | `asset`, `pos`, `rot`, `scale` | embeds another asset |

Modifiers on any part:
- `"repeat": { "count": 8, "offset": [0.3, 0, 0], "rot": [0, 0, 0] }` — planks, fence posts, steps.
- `"radial": { "count": 6, "radius": 1.2, "yaw0": 0 }` — copies around the Y axis.

Generators (`"generator": { "type": "palm", "params": {...} }`, see `src/engine/assets/generators.js`):
palm, tree (generic branching tree; jungleTree and broadleaf are presets of it), pandanus, bush,
fern, banana, grass, flowers, rock, bamboo, deadTree. Each seed gives a variant (the world uses
seed = variant + 1). `params.forms: [{...}, ...]` gives one asset several sub-types: variant v uses
the params merged with `forms[v % forms.length]` (e.g. round / spreading / tall broadleaf trees,
coconut / royal / young palms).

Tree generators keep their LODs coherent: the structure (trunk, lean toward +X, branches, leaf
clumps, fronds, colours) is drawn once from the seed whatever the quality; quality only changes
tessellation and drops small details (lianas, leaf fringe, coconuts), and the far LOD (quality
≤ 0.3) merges the leaf clumps into a few ellipsoids covering the same crown. Keep that rule when
writing a generator: never branch on quality before all random numbers are drawn. Check with
`mc asset shot <name> --lineup` (every variant at qualities 1 / 0.5 / 0.25 side by side).

## Birds

`bird_*.json` (category `animal`, used by `game/birds.json`, drawn by `src/game/fx/Birds.js`):
real size, origin at the feet, head toward -Z, wings spread along ±X at rest. The wings are
animated in the vertex shader with no rig: every vertex farther than the species' `shoulder`
from the body axis (|x| > shoulder) is a wing vertex, flapped about the shoulder and bent more
toward the tip, and folded along the body when the bird lands. So keep the body, head, beak, tail
and legs narrower than the shoulder, and give the wings intermediate vertices (elbow, wrist) to
bend. Wings are flat `tris`: two single-sided layers for different colours above and below
(the gull), or `doubleSided`.

## Weapons

Weapon assets (category `weapon`, used by `game/weapons.json`) carry points in asset space:
`muzzle` (flash, tracers, NPC shots), `sight` (aiming down sights puts it on the eye line;
`weapons.json` `view.adsDist` = its distance, default 0.32 m) and `magazine`. `hands` places the
first-person arms (`src/game/player/ViewArms.js`: the arms of a Quaternius character, two-bone
IK, config in `game/player.json` `arms`):
```json
"hands": {
  "right": { "pos": [0.03, 0.064, 0.1],        // wrist
             "fingers": [0, -0.53, -0.85],     // direction of the straight fingers
             "thumb": [0, 0.85, -0.53],        // direction of the thumb
             "curl": [[25, 40, 30], 65, 70, 75],  // index, middle, ring, pinky: deg per joint
             "thumbCurl": [10, 20, 20], "thumbFold": 30 },
  "left": { ... }                              // no left grip: that arm hangs out of view
}
```
The palm faces away from the thumb side (right hand: palm toward -X when the thumb is up and the
fingers forward). Check with a first-person shot of the weapon (hip and aiming).

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
npm run mc -- asset import model.glb --as <name> --rot 0,90,0 --length 0.88 --origin 0,0.125,0.165
                                               # flat-coloured GLB -> asset (rotate so the front is -Z,
                                               # scale to --length along Z, --origin becomes the origin)
npm run mc -- asset reindex                    # refresh assets/index.json (run after adding files)
```
