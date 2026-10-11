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
- **Terms**: each probe stores L1 SH irradiance (`E(n) = A + B.n` per channel) for a white sky of
  radiance 1 (RGB) and for a white sun of irradiance 1 from each of 7 key directions along the sun
  path (shared direction for the three channels). The moon reuses the keys (it is the sun 12 h
  later).
- **Bake** (`tools/lib/gi/`): Node worker threads trace the terrain heightfield (max-height
  pyramid) and instanced BVHs (props, trees, rocks; not ferns / flowers / small bushes) plus a sea
  plane. Pass 0: sky through the gaps + first sun bounce per key (shadow rays). Pass 1..N: one more
  bounce each, reading the previous field at every hit. Probes inside geometry (mostly back faces)
  take their neighbours' average.
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

## Tuning (environment.json, editor ☀, F2 > Graphismes > GI)
- `gi.intensity` (1): scales the probe light. `gi.floor` (0.12): part of the old flat ambient kept
  everywhere (artistic: nothing goes pitch black under the canopy). `gi.bias` (0.6 m): shading
  point pushed along the normal before the lookup (less self-shadowing from the probe behind a wall).
- `autoExposure`: `enabled`, `strength` (0.5), `reference` (0.85: openness of a usual outdoor
  spot, no compensation above it), `min` / `max` (0.85 / 2.2), `speedUp` / `speedDown` (0.8 / 3 per s).
- F2 "vue irradiance seule" shows the probe light alone (white albedo, no sun).
- F2 "voir les probes" draws a sphere at each probe around the camera, shaded by its irradiance
  (`render/GIProbeView.js`; radius, sphere size and layer filter next to it).

## Limits / next steps
- 8 m probes don't resolve small interiors (a 4 m hut sits between probes): fine volumes inside
  enterable buildings + DDGI-style visibility are the next step.
- Emissive lights (lamps, fires) are not baked yet.
- The whole island is rebaked each time (incremental per-sector bakes from the editor are planned).
