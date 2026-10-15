# Working on Mini Cry (guide for AI agents)

Open-world FPS (Far Cry 1 style) with a realistic, textured look (CC0 photo textures, PBR, alpha-cut
foliage) + engine + editor, Three.js r186 (WebGPURenderer, every material a TSL node material; WebGL 2 fallback through the same
renderer, `?renderer=webgl`) + Vite, plain JS ES
modules (editor UI: Preact + @preact/signals, `.jsx`). Everything is in English (code, comments, game
and editor UI, docs) except the story content in `public/data/`: missions, dialogue, voices, place and
character names stay French.

## Ground rules
- **Data first.** Game content lives in `public/data/` (JSON / small binaries). Prefer editing data
  (via `npm run mc`) over code. Every write through `mc` or the editor keeps a backup in
  `.mc-backup/`.
- **Look at what you change.** After a visual change: `npm run mc -- asset shot <name>` (assets;
  `--lineup` = every variant at every LOD side by side; first-person weapons + arms: `npm run mc -- viewmodel shot <weapon> [--ads 1]`;
  NPC bodies: `npm run mc -- character shot <body|archetype,…> [--clip Walk_Aim] [--face 140 --yaw 140]`),
  `npm run shot -- --cam x,y,z,yaw,pitch` or `--at <entityId>` (world), `npm run play -- ...` (gameplay).
  Read the PNGs with the Read tool. Check `errors` in the JSON the tools print.
- **Validate.** `npm run mc -- validate` must report `ok: true` (it checks assets, entity schemas,
  every mission / dialogue / entity reference).
- **Regression tests.** `npm test` runs every `tests/*.play` scenario headless on the production
  build (opening, full story fast-forwarded, shooting, stealth takedown, detection, hostage escort, driving, flying the plane (take-off, turn, crash) and landing it, AI fight, enemy lethality on normal, NPC bodies (every soldier body: hitboxes, death, LODs), birds, water reflections (SSR levels), first-person models (every weapon's realistic model, both wrists on its grips),
  frame pacing while driving / flying fast). Add a scenario with `expect <js>` assertions when you add
  gameplay. Each report has `lateShaders` (render pipelines created after the loading warm-up = hitches):
  keep it at 0 — if a new material / object type shows up late, make `World.warmUp` cover it.
- **Performance budget**: 120 fps on a MacBook Air M1 ≈ 8.3 ms per frame. Check with
  `npm run bench -- --mode play --prod --m1 --repeat 3 --fresh` (CPU throttled 2x, GPU time x1.9,
  median of 3, new page per view: every view must say OK / worst ≥ 120; the low-poly version made
  ≥ 164, the textured one 21, 52 after the GPU work of 2026-10-14) and `npm run profile -- --spawn x,y,z`. Break a slow
  view down with `--views <name> --breakdown`: GPU ms each system costs, measured by switching it
  off and on in pairs (`--only a,b`; `--veg` = per vegetation LOD / species; `res 50%` tells
  fill-rate from geometry cost) and `--veg-stats` (instances, screen height, triangles per
  vegetation species / LOD, `Vegetation.lodStats`). `profile`: `--by file`, `--callers <fn>`,
  `--size 480x300` (with the GPU saturated, the JS waits in a native GPU call such as
  `GPUQueue.submit` / `writeBuffer`: that is GPU backpressure, not JS work), `--load`. GPU ms are
  WebGPU timestamp queries around each render pass (`trackTimestamp`, summed by `Perf.js`; Chrome
  rounds them to 0.1 ms); `?gpu=0` turns them off. Never time passes with one WebGL timer query
  each on the `?renderer=webgl` fallback: on ANGLE / Metal a query adds ~3 ms. The F3 / bench triangle count sums every
  pass (cascades, SSAO pre-pass) and the instances the LOD shader collapses. For hitches use
  `node tools/trace-flight.mjs --prod` (long frames with GC / JS / GPU-sync breakdown). Instance
  buffers must stay incremental (`render/InstanceBlocks.js`: one block per sector / tile, only
  changed blocks uploaded) — never re-upload a whole instance buffer every frame. Instanced vegetation / grass / birds are
  `render/FieldMesh.js` meshes (instanced attributes `iM0..iM3` + optional `iColor`, `drawCount`),
  not `THREE.InstancedMesh`: three's WebGPU InstancedMesh keys its shader per object and caps
  instances in a uniform array. GPU timer queries are inflated when other apps use the GPU: always
  use --repeat. Watch draw calls (static props are batched per sector;
  small-plant far LODs share one mesh per species — `shareVariantsFrom`; trees don't, so each
  variant keeps its own silhouette at every LOD; the big trees' last LOD is an impostor —
  species `impostor: { cell }` in vegetation.json, `render/Impostors.js`: every variant baked at
  load from 8x8 hemisphere views into albedo / normal atlases, one lit camera-facing quad per tree;
  vegetation geometry is drawn indexed). Vegetation shaders may discard (LOD dithering),
  which turns off the tile GPU's hidden surface removal (near LODs are drawn first so hidden far
  ones fail the depth test). Measured 2026-10-14, after impostors / indexing: vegetation ≈ 45 % of
  the GPU frame (near / mid LOD crowns, ~2.3 shaded layers per covered pixel), terrain ~20 %,
  SSAO ~17 %, shadows ~12 % (WebGL measurements, before the WebGPU port). On Apple GPUs per-pixel
  loops over local arrays or over uniform arrays / samplers picked by index compile badly (on ANGLE
  the terrain splat loop alone cost ~4.5 ms) — write such code out (TerrainMaterial.js,
  SunShadows.js).
- **Shaders are TSL** (`three/tsl`, no GLSL / `onBeforeCompile`). Don't `setLayout` a `Fn` that
  reads a uniform, a texture or a builtin (`screenCoordinate`, `positionView`…): layout functions
  are emitted as separate WGSL / GLSL functions that can't see the material's uniforms and
  builtins (unresolved names, or another build's uniform) — only pure helpers get a layout. A
  value read in several `If` branches (or in a branch and after it) must be made a variable
  first (`.toVar()`): otherwise TSL computes it inside the first branch that reads it and the
  others read garbage. Data passes (signed values, data in alpha: the GI relight) write through
  `fragmentNode`: the colour path clamps the output to >= 0 and forces alpha to 1 on opaque
  materials (or set `blending = NoBlending` when only the alpha matters). Screen / render-target
  uvs run top-down (WebGPU convention; three flips them for the WebGL fallback). Constants baked
  into a shader (a JS number) make one pipeline per value: per-variant data goes in uniforms
  (`Impostors.js`). Shadow / SSAO / SSR depth passes draw the scene with one override material
  (`Lighting.depthMaterial`, `mcDepth`) that branches at build time on the source material
  (`positionNode` is copied: wind, LOD fades and alpha cuts stay). A render object keeps the
  pipeline of its first draw: hide meshes until their real geometry exists.
- The dev server (`npm run dev`, port 5190) hot-reloads pages on any source change; tools start it
  if needed. Use `--prod` for stable benchmarks (builds + serves `dist/` on 5191).

## Map of the code
- `src/engine/core/Engine.js` WebGPURenderer (`await engine.init()` before the first frame; `backend` = `webgpu` / `webgl`) + frame loop (systems in order; `maxFps` cap: auto = uncapped by default, 60 in debug mode, F2 → Graphics → FPS limit, `?fps=N` overrides; antialiasing `msaa` / `fxaa` (the frame goes to a target, then one FXAA pass to the canvas; SSR also renders through a target, it reads the previous frame) / `off`, fixed at renderer creation: `?aa=`, Options → Antialiasing, auto = FXAA on low / medium (MSAA costs 20-30 % of the GPU frame), MSAA on high / ultra), `Perf.js`, `Input.js` (`?bot` forces pointer lock for tests), `Live.js` (commands from `mc live`).
- `src/engine/render/Lighting.js` time of day, sky, fog, wind, `material(opts)` = shared world material (`textured`: PBR standard node material sampling the texture arrays, sky reflections; else Lambert), `patch(mat)` = a world material copying a plain three material (imported models, view models, birds); `WorldMaterial.js` the world node materials: vertex (wind, instancing, LOD fades), surface colour / normal, and the lighting model (sun + cascaded shadows, probe GI, SSAO, sky reflections; one shader for every light, no three.js lights); `Output.js` tone mapping (AgX) + grade + fog, written inline at the end of every material that draws to the screen (`renderer.contextNode` getOutput: no HDR target / output pass; `mcRaw` = additive light written as is, `mcOutput(rgb)` = custom); `nodes.js` shared TSL helpers; `Surfaces.js` texture arrays (terrain / surfaces / foliage, one strip image each) + the surface shader code + alpha-cut depth passes, docs/TEXTURES.md; `TerrainMaterial.js` terrain splatting (material-id texture, height blend, triplanar slopes); `SunShadows.js` near / mid / far cascades (blend band at each border, radial fade at the preset's `shadowDistance`; on the ground in front of the camera and grown with its height above it, so planes get far shadows; vegetation casts per cascade: species `castShadow` (m) = up to the first cascade that wide, each LOD mesh only into the cascades it can reach, `InstancedField._castLayers`, `layers.js` CASCADE; far trees cast through sun-facing impostor cards in the last cascade only, which alone shades past where trees turn impostor; F2 → Graphics → Sun shadows for live tuning + cascades view); `SSAO.js` half-res SSAO (depth pre-pass of STATIC + DYNAMIC within 80 m → AO → 4x4 blur, applied to the ambient light in the patched materials; toggle in the options menu, F2, quality presets); `GI.js` + `GIField.js` baked probe GI (replaces the hemisphere ambient, relit for the time of day; finer interior volumes declared by assets, `gi.volumes`) + auto exposure, docs/GI.md; `LensFlare.js` sun lens flare (16 occlusion queries on the sun disc right after the main pass, clouds included, read back 2-3 frames later without stalling; one additive draw, skipped when the sun is hidden; options menu, F2, `?flare=0`); `SSR.js` screen-space reflections on the water, their own setting: off (default) / ultra low / low / medium / high (`SSR_LEVELS`: steps, depth range, ray length) + `blur`, independent of the quality preset (rays march in the water shader through the SSAO depth pre-pass, stretched to `ssr.distance`; reflected colour = the previous frame (two frame targets used in turn, no copy), reprojected; options menu, F2, `?ssr=<level>`); `Glows.js` light halos of asset parts with `glow` (lamps, fires, beacons: one draw, faded in at dusk, occluded through the SSAO depth); `layers.js` (STATIC/DYNAMIC cast shadows, DETAIL/FX don't, EDITOR only in the editor).
- `src/engine/world/` terrain (data, generator, chunk renderer), `Water.js`, `Vegetation.js` + `VegetationScatter.js` (drawn by `render/InstancedField.js`: sector culling, shader LOD cross-fades `LodFade.js`, far impostors `Impostors.js`), `Grass.js`, `Entities.js` (entity registry + manager; props → `render/StaticBatch.js`), `World.js` (loads everything).
- `src/engine/physics/Physics.js` shapes + grid; `collideCylinder`, `groundAt`, `raycast`, `visible`.
- `src/engine/assets/ModelBuilder.js` (asset JSON → geometry with normals, metric uvs, per-vertex `surface`; format in docs/ASSETS.md), `generators.js` (textured trees / palms / plants: leaf cards, frond strips), `surfaces.js` (surface name → layer id, shared with the Node tools).
- `src/engine/anim/Characters.js` NPC bodies: realistic Rocketbox bodies of `public/models/characters` (built by `mc character build` from `characters.json`: one skinned mesh on the game rig, photo atlas, distance LODs = index ranges, `setLodDistance`) and the older flat-coloured Quaternius models (merged mesh); UAL retargeting (once per rig, shared), clip aliases, hitboxes, palettes (part tints), weapon grip. Archetypes pick `model` / `models` (one per actor), entities can set `model`.
- `src/game/Game.js` game rules + live commands; `player/` (Player, Weapons, ViewModels = loads the realistic first-person weapons / arms of `public/models/fp` (built by `mc viewmodel build` from `viewmodels.json`), ViewArms = realistic skinned arms (Rocketbox) on the weapon grips by two-bone IK, grips = weapon asset `hands`, config `player.json` `arms`, ViewLight = light of the view-model pass: its camera follows the world camera, the materials get the world sun + cascaded shadows and the probe GI, a procedural sky PMREM for reflections; no SSAO), `actors/` (Actors, AI, Nav), `missions/` (Missions runtime, Dialogue), `entities/index.js` (game entity types & schemas), `vehicles/`, `fx/Effects.js`, `fx/Birds.js` (flocks around the camera: perched on tree crowns / beaches, soaring, Bezier flights between the two; startled by gunshots and the player, can be shot; wings flapped in the vertex shader; `?birds=0` off), `ui/` (HUD, Menus, PerfOverlay = stats graphs bottom right, F3; DebugPanel = lil-gui cheats / toggles, F2; both on by default, `?stats=0` / `?debug=0` hide them, off with `?bot` / `?bench` / `?nohud`; in debug mode settings are never read from / written to localStorage, so a reload restores the defaults).
- `src/editor/core.js` editor logic (signals `S`, selection, gizmo, brushes, undo, save, live commands), `ui/`, `panels/`.

## Data files
| file | content | edit with |
|---|---|---|
| `terrain/layout.json` | islands, mountains, plateaus, lagoons, rivers, roads, flat sites | `mc data set`, editor ⛰ Island, then `mc terrain generate` |
| `terrain/height.bin, material.bin, terrain.json` | heightfield (u16) + painted materials | `mc terrain sculpt`, editor brushes |
| `vegetation.json` / `vegetation.bin` | species rules / placed instances (the .bin has hand edits: add a species with `mc vegetation generate --species <id>`, which keeps every other instance) | `mc vegetation generate|clear`, editor 🌴 brush |
| `assets/*.json` (+ `index.json`) | models: parts with colours + texture `surface`s (docs/ASSETS.md; the guns are CC0 Quaternius GLBs converted by `mc asset import`) | write JSON, `mc asset validate|shot|reindex|bake|import` |
| `textures.json` + `public/textures/*` | texture layers (Poly Haven / ambientCG CC0 sources, scales, means) and the packed arrays (docs/TEXTURES.md) | edit JSON, `mc textures fetch|build|info` |
| `world.json` | player start + entities (props, enemies, npcs, pickups, outposts, alarms, zones, markers, paths, vehicles…) | `mc entity list|add|set|move|remove|types` |
| `game/missions.json`, `game/dialogue.json` | story (docs/MISSIONS.md) | `mc mission list|show`, `mc data set`, editor 🎯 / 💬 |
| `game/weapons.json`, `archetypes.json`, `items.json`, `player.json`, `birds.json` | gameplay tuning (archetypes: body `model` / `models`, palette, stats; birds: species → asset, flight, habitat, flocks, calls) | `mc data get|set`, editor 📊 |
| `characters.json` + `public/models/characters/*.glb` | NPC bodies: Rocketbox avatars (MIT, credits in `models/characters/CREDITS.md`), texture scales, LODs, camouflage `recolor`, insignia `erase` | `mc character fetch|build|shot|list` (docs/ASSETS.md) |
| `viewmodels.json` + `public/models/fp/*.glb` | first-person arms (Rocketbox, MIT) and realistic weapons (CC0 / CC-BY, credits in `models/fp/CREDITS.md`): sources, import parameters; the weapon points (`muzzle`, `sight`, `hands`) stay in the weapon assets | `mc viewmodel fetch|build|shot|list` (docs/ASSETS.md) |
| `environment.json` | time of day, light, SSAO (`ao`), GI / auto exposure (`gi`, `autoExposure`), lens flare (`flare`), light halos (`glows`), water reflections (`ssr`), fog, sky / ocean colours | `mc data set`, editor ☀ |
| `gi/probes.json` + `gi/probes.bin` | baked GI probes (derived: re-bake after terrain / vegetation / prop / asset / sunTilt edits; `mc validate` warns when stale) | `mc gi bake|info` (docs/GI.md) |
| `sounds.json` | sound recipes: procedural layers + `sample` layers (docs/AUDIO.md) | `mc sound list|render|check`, editor 🔊 |
| `sfx/*.wav` + `sfx/CREDITS.md` | recorded weapon sounds (CC0, Freesound): shots, reloads, pump, RPG | cut / faded 16-bit mono 44.1 kHz WAVs, played by `sample` layers |
| `voice/*.mp3` + `voice/manifest.json` | recorded dialogue voices (TTS via OpenRouter, key in `.env`; casting = `speakers.*.tts.voice`, acting = line `spoken` with `[tags]`, docs/MISSIONS.md) | `mc voice list|generate|say|check`, editor 💬 |

`tools/content/seed-world.mjs` generated the initial world, missions and dialogue; it is kept for
reference — re-running it with `--force` overwrites hand edits.

## Typical loops
```bash
# add a camp of 3 mercenaries with a tent and check it
npm run mc -- entity add prop --at 120,340 --asset tent --yaw 30
npm run mc -- entity add enemy --at 124,343 --archetype merc_rifle --group camp_x
npm run mc -- validate
npm run shot -- --at 120,340 --dist 20 --tod 15

# first-person view of a weapon (arms on its grips), aiming, seen from outside with the grip targets
npm run mc -- viewmodel shot rifle_ak
npm run mc -- viewmodel shot rifle_ak --ads 1
npm run mc -- viewmodel shot rifle_ak --orbit 270,15,0.8 --grips

# NPC bodies: rebuild after editing characters.json, then look at them (armed archetypes, a clip)
npm run mc -- character build soldier_cap
npm run mc -- character shot merc_rifle,merc_heavy --face 140 --yaw 140
npm run mc -- character shot merc_rocket --clip Walk_Aim --time 0.4 --yaw 230 --face 140

# play-test a mission headless
npm run play -- --mission m03 --steps "live teleport {\"to\":\"mk_antenna\"}; wait 3; state; shot antenna"

# change a line, then re-record its voice (only the stale clips are regenerated, ~$0.04 / 1000 chars)
npm run mc -- voice list --missing
npm run mc -- voice generate

# drive a running editor (open /editor.html in a browser first)
npm run mc -- live state --target editor
npm run mc -- live focus '{"id":"outpost_river"}' --target editor
npm run mc -- live screenshot --target editor --out shots/editor.png
```
Headless shots run on the real GPU on macOS (WebGPU on Metal); on Linux without Chrome / a GPU the tools
use the bundled Chromium headless shell with WebGPU on SwiftShader through Vulkan (the compositor must
run on Vulkan too or the canvas never reaches the screenshot; `tools/lib/browser.js`): correct pixels,
a few seconds per frame: keep shots small, `--frames` low; the real-time gameplay tests and the
benches are not meaningful there.

Live game commands: state, teleport, give, god, noclip, setTime, startMission, completeObjective,
spawn, killAll, start, look, birds. Live editor commands: state, select, get, add, set, patch, remove,
camera, focus, setEnv, sculpt, save, undo, panel, materials (+ eval, screenshot, commands everywhere).
