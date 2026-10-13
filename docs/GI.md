# Global illumination (baked probes)

Diffuse indirect light from irradiance probes baked offline, relit at runtime for the time of day.
It replaces the flat hemisphere ambient: the jungle under the canopy and the inside of buildings
lose the sky they can't see, and shaded surfaces pick up the colour of what lights them (sand,
leaves, the ocean). Auto exposure meters the same probes at the camera.

## Workflow
```bash
npm run mc -- gi bake            # ~1.5 min on 10 cores (128 rays, 2 bounces) -> public/data/gi/probes.json + probes.bin
npm run mc -- gi info            # summary + `stale` (inputs changed since the bake)
npm run mc -- validate           # warns "gi: stale" / "gi: not baked"
npm run play -- --file tests/gi.play
```
Re-bake after changing the terrain, vegetation, static props (and entities drawn with an asset:
interactable, destructible, explosive, alarm), the assets they use, or `environment.sunTilt`.
Colours / intensities of the sky, sun, moon, ambient and exposure need no re-bake. Without a bake
(or with GI off) the game falls back to the hemisphere light. A stale bake still works; it just
lights the old world.

Bake options: `--rays 128` per probe, `--bounces 2` (after the direct pass), `--transmission 0.8`
(foliage lets light through: the green glow under the canopy), `--workers N`.

## How it works
- **Probes** (`src/engine/render/GIField.js`): columns every 8 m over the island (sea columns more
  than 40 m from land copy one open-sea column), 4 layers above the column base (ground or water,
  averaged over the cell) at 1.5, 3.75, 9.4, 23.4 m. A point maps to a fractional layer from its
  height above the bilinear base, so a lookup is a trilinear fetch.
- **Interior volumes**: assets can declare boxes of finer probes (`gi.volumes`, below), baked for
  every placed entity of a static asset type (prop, interactable, destructible, explosive, alarm).
  Each box holds a grid of probes at cell centres (`round(size / spacing)` per axis). A shaded point
  inside a box uses the box's probes instead of the world grid, faded into it over `blend` m at the
  faces (doorways, windows), so the 8 m world grid no longer leaks the outdoor sky through walls.
- **Terms**: each probe stores L1 SH irradiance (`E(n) = A + B.n` per channel) for a white sky of
  radiance 1 (RGB) and for a white sun of irradiance 1 from each of 7 key directions along the sun
  path (shared direction for the three channels). The moon reuses the keys (it is the sun 12 h
  later).
- **Bake** (`tools/lib/gi/`): Node worker threads trace the terrain heightfield (max-height
  pyramid) and instanced BVHs (props, trees, rocks; not ferns / flowers / small bushes) plus a sea
  plane. Pass 0: sky through the gaps + first sun bounce per key (shadow rays). Pass 1..N: one more
  bounce each, reading the previous field at every hit. Probes inside geometry (mostly back faces)
  take their neighbours' average.
- **Volumes in the bake**: their probes are traced with the world ones; a bounce that hits a point
  inside a box reads the box (indoor light is mostly bounced light). Probes inside walls / floors
  (box faces usually sit in them) are refilled from valid probes of the same box only. They are
  packed side by side in an atlas and stored after the world planes (`volumes` in probes.json).
- **Runtime** (`src/engine/render/GI.js`): the 8-bit terms sit in a texture array; `relight()` mixes
  sky x (hemi colour x intensity / PI) + the two nearest sun keys x sun colour into a half-float 3D
  texture (12 small draws, only when the light changed). Patched materials call `giIrradiance()`
  instead of the hemisphere light: 1 base-height fetch + 3 trilinear fetches per pixel. The open
  field matches the old hemisphere light by construction.
- **Auto exposure**: the CPU samples the field at the camera; `openness` = sky light reaching the
  eye from above / the same at the open-sea probe (~ visible sky, independent of the ground's
  brightness). Exposure target = `min(1, openness / reference)^-strength` clamped to [min, max],
  eased (fast towards bright, slow towards dark), snapped when the camera jumps > 30 m. The view
  model's hemisphere light takes the probe light at the eye.

## Interior volumes (asset JSON)
```json
"gi": {
  "volumes": [
    { "pos": [0, 1.925, 0], "size": [6.34, 3.05, 6.34], "rot": [0, 0, 0], "spacing": 1.25, "blend": 0.1, "bias": 0.25 }
  ]
}
```
- `pos` / `size` / `rot` (about Y only): asset space, like colliders. Put the box faces just
  outside the walls, floor and ceiling (outer surface + ~0.1 m): an outer wall pixel pushed out
  along its normal by `bias` must leave the box (world field), and an inner one, even in a corner,
  must sit deeper than `blend` inside it (wall thickness + margin > blend), or the room's edges
  fade to the leaky world light. Same for floors and ceilings: the bias of a wall pixel is
  horizontal, so the box must reach ~0.2 m below the floor top and above the ceiling (less under a
  raised floor whose underside is visible: that one, pushed down by `bias`, must leave the box).
- `spacing` (1.25 m): probe spacing; `blend` (0.1 m): fade into the world field at the faces;
  `bias` (0.25 m): normal offset of the lookup inside the box (smaller than the world `gi.bias`).
- At most 2000 probes per asset (`mc validate`, `mc asset validate`). Editing `gi` makes the bake
  stale (the asset JSON is hashed). F2 > GI > "interior volumes" (or `?givol=0`) switches them off
  for A/B; "show probes" draws them as small spheres.
- Examples: `house_wood`, `hut_ground`, `lab_building`. Auto placement in the asset editor is planned.

## Tuning (environment.json, editor ☀, F2 > Graphics > GI)
- `gi.intensity` (1): scales the probe light. `gi.floor` (0.12): part of the old flat ambient kept
  everywhere (artistic: nothing goes pitch black under the canopy). `gi.bias` (0.6 m): shading
  point pushed along the normal before the lookup (less self-shadowing from the probe behind a wall).
- `autoExposure`: `enabled`, `strength` (0.5), `reference` (0.85: openness of a usual outdoor
  spot, no compensation above it), `min` / `max` (0.85 / 2.2), `speedUp` / `speedDown` (0.8 / 3 per s).
- F2 "irradiance only view" shows the probe light alone (white albedo, no sun).
- F2 "show probes" draws a sphere at each probe around the camera, shaded by its irradiance
  (`render/GIProbeView.js`; radius, sphere size and layer filter next to it).

## Limits / next steps
- 8 m probes don't resolve small interiors (a 4 m hut sits between probes): buildings need
  interior volumes (above): house_wood, hut_ground, hut_stilt, shack_tin, bunker, lab_building and
  warehouse have one. The hangar is big enough for the world grid, the gate and the arch are open
  passages. A point in a 2 m index cell takes one
  volume (the one covering most of the cell): keep volumes of different buildings apart.
- Emissive lights (lamps, fires) are not baked yet.
- The whole island is rebaked each time (incremental per-sector bakes from the editor are planned).
