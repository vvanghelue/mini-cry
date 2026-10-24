# Working on Mini Cry (guide for AI agents)

Open-world FPS (Far Cry 1 style) with a realistic, textured look (CC0 photo textures, PBR, alpha-cut
foliage) + engine + editor, Three.js r186 (WebGPURenderer + TSL node materials, WebGL 2 fallback:
`?webgl=1`; see "WebGPU" below; VR mode on a Meta Quest 3: WebXR on the WebGL backend, docs/VR.md) + Vite, plain JS ES
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
  `npm run shot -- --cam x,y,z,yaw,pitch` or `--at <entityId>` (world), `npm run play -- ...` (gameplay),
  `npm run quest -- shot` (the Quest headset's screen, VR: docs/VR.md).
  Read the PNGs with the Read tool. Check `errors` in the JSON the tools print.
- **Validate.** `npm run mc -- validate` must report `ok: true` (it checks assets, entity schemas,
  every mission / dialogue / entity reference).
- **Regression tests.** `npm test` runs every `tests/*.play` scenario headless on the production
  build (opening, full story fast-forwarded, shooting, stealth takedown, detection, hostage escort, driving, flying the plane (take-off, turn, crash) and landing it, AI fight, enemy lethality on normal, NPC bodies (every soldier body: hitboxes, death, LODs), birds, water reflections (SSR levels), first-person models (every weapon's realistic model, both wrists on its grips),
  frame pacing while driving / flying fast, gamepad (simulated pad: play, menus, driving), VR (a Quest 3 emulated by IWER: session, gun in hand, two hands, magazine reload, grenade throw, stick walk / snap turn, menu laser, climbing, gliding)). Add a scenario with `expect <js>` assertions when you add
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
  `--size 480x300` (with the GPU saturated, the JS waits in a WebGPU call such as
  `setVertexBuffer` / `createCommandEncoder`: that is GPU backpressure, not JS work; the tools run
  Chrome without vsync, so a GPU-bound page runs ahead until WebGPU's command buffer fills, then
  stalls ~20 ms every few dozen frames — with vsync the frames are even), `--load`. GPU time = WebGPU
  timestamp queries around every render pass, summed per frame (`Perf.js`). The F3 / bench triangle count sums every
  pass (cascades, SSAO pre-pass) and the instances the LOD shader collapses. For hitches use
  `node tools/trace-flight.mjs --prod` (long frames with GC / JS / GPU-sync breakdown). Instance
  buffers must stay incremental (`render/InstanceBlocks.js`: one block per sector / tile, only
  changed blocks uploaded) — never re-upload a whole InstancedMesh every frame. GPU timer queries are inflated when other apps use the GPU: always
  use --repeat. Watch draw calls (static props are batched per sector;
  small-plant far LODs share one mesh per species — `shareVariantsFrom`; trees don't, so each
  variant keeps its own silhouette at every LOD; the big trees' last LOD is an impostor —
  species `impostor: { cell }` in vegetation.json, `render/Impostors.js`: every variant baked at
  load from 8x8 hemisphere views into albedo / normal atlases (mipmapped: without mips far trees
  sparkle), one lit camera-facing quad per tree,
  shrunk to that view's silhouette rectangle (`Impostors._rects`: fewer discarded fragments);
  vegetation geometry is drawn indexed). Vegetation shaders may discard (LOD dithering),
  which turns off the tile GPU's hidden surface removal (near LODs are drawn first so hidden far
  ones fail the depth test). Measured 2026-10-14, after impostors / indexing: vegetation ≈ 45 % of
  the GPU frame (near / mid LOD crowns, ~2.3 shaded layers per covered pixel), terrain ~20 %,
  SSAO ~17 %, shadows ~12 %. On Apple GPUs (Metal) per-pixel loops over local arrays or
  over uniform arrays / samplers picked by index compile badly: the terrain splat loop alone cost
  ~4.5 ms — write such code out (TerrainMaterial.js, SunShadows.js). Measured 2026-10-17: what
  makes vegetation expensive is its per-pixel lighting (~1.6-2.6 ms: cascades, probe GI, SSAO),
  not overdraw — a vegetation depth pre-pass (lit pass with an EQUAL test) gained nothing on the
  GPU and its extra draws cost ~3 ms of CPU; per-vertex GI on leaves gained nothing either. The mid
  LOD (55-220 m) costs most. Each draw costs ~10-25 µs of CPU in three's WebGPU renderer: count
  draw calls. The machine drifts (thermal, other apps: ±1 ms GPU between runs minutes apart):
  compare builds interleaved, never against a number measured earlier.
  VR (Quest 3, 72 Hz): the renderer's main thread runs the JS and the WebXR submission (~2-3 ms):
  keep the JS under ~8 ms and the GPU under ~13 ms (`npm run quest -- fps|breakdown|calls|profile|trace`
  on the real headset over USB; numbers depend on where the headset looks); each draw costs ~70 µs
  of JS in three's WebGL backend. The `vr` quality preset holds the trade-offs (docs/VR.md).
- The dev server (`npm run dev`, port 5190) hot-reloads pages on any source change; tools start it
  if needed. Use `--prod` for stable benchmarks (builds + serves `dist/` on 5191).

## Map of the code
- `src/engine/core/Engine.js` frame loop (systems in order; `maxFps` cap: auto = uncapped by default, 60 in debug mode, F2 → Graphics → FPS limit, `?fps=N` overrides; frame pacing: at most `maxFramesInFlight` (4, `?inflight=N`) frames queued for the GPU, else the frame is drawn when the GPU catches up — without it a GPU-bound page without vsync stalls ~25 ms every few dozen frames; antialiasing `msaa` (MSAA 4x on the canvas; WebGPU offers 1 or 4 samples: `msaa2` / `msaa8` mean 4x) / `fxaa` (post pass on the final image) / `off`, fixed at context creation: `?aa=`, Options → Antialiasing, auto = MSAA 4x on desktop, on mobile FXAA (MSAA costs 20-30 % of the GPU frame) unless high / ultra), `Perf.js`, `Input.js` (keyboard / mouse / gamepad: action bindings, `?bot` forces pointer lock for tests; a gamepad (standard mapping) is picked up on its first press: `device` = last device used, `poll()` each frame, `Pad:<button>` codes in the bindings, left stick = `move()`, right stick = `look()`, no pointer lock needed (`active`), `label(action)` = key / button name for prompts, B toggles crouch, L3 sprint latch, X = use on a prompt else reload, rumble; menus / map driven with the D-pad / A / B, Start pauses, `Menus.pad`), `Live.js` (commands from `mc live`).
- `src/engine/render/Lighting.js` time of day, sky, fog, wind, `material(opts)` = shared node material (`textured`: MeshStandardNodeMaterial sampling the texture arrays, sky reflections; else Lambert; our own lights: sun + cascaded shadow, probe GI); `Surfaces.js` texture arrays (terrain / surfaces / foliage, one strip image each) + the surface shader code + alpha-cut depth passes, docs/TEXTURES.md; `TerrainMaterial.js` terrain splatting (material-id texture, height blend, triplanar slopes; past ~2 km, `terFar`, the layers' mean colours = their 1x1 mips, no splatting); `Grade.js` AgX tone mapping + grade; `SunShadows.js` near / mid / far cascades (blend band at each border, radial fade at the preset's `shadowDistance`; on the ground in front of the camera and grown with its height above it, so planes get far shadows; vegetation casts per cascade: species `castShadow` (m) = up to the first cascade that wide, each LOD mesh only into the cascades it can reach, `InstancedField._castLayers`, `layers.js` CASCADE; far trees cast through sun-facing impostor cards in the last cascade only, which alone shades past where trees turn impostor; F2 → Graphics → Sun shadows for live tuning + cascades view + sun visibility view); `FarShadows.js` the shadows past the cascades, across the whole island: the terrain's shadow from a horizon sweep on the GPU (compute: one thread per line along the sun's azimuth, the horizon height carried along it = how high above the ground the terrain's shadow reaches, any receiver height; also min-ed into the cascades: a mountain out of their box), the trees' from an island-wide sun shadow map of their impostor silhouettes (`Impostors.islandCasterMaterials`, every instance); re-baked every ~0.03° of sun motion over 8 frames, the two last terrain bakes blended; the water reads them too; receivers say what they are (`mcFarKind`: terrain 'ground', impostors 'crown', else 'any'); WebGPU only, `?farshadow=0`; `SSAO.js` half-res SSAO (depth pre-pass of STATIC + DYNAMIC within 80 m → AO → 4x4 blur, applied to the ambient light in the patched materials; toggle in the options menu, F2, quality presets); `GI.js` + `GIField.js` baked probe GI (replaces the hemisphere ambient, relit for the time of day; finer interior volumes declared by assets, `gi.volumes`) + auto exposure, docs/GI.md; `LensFlare.js` sun lens flare (16 occlusion queries on the sun disc right after the main pass, clouds included, read back 2-3 frames later without stalling; one additive draw, skipped when the sun is hidden; options menu, F2, `?flare=0`); `SSR.js` screen-space reflections on the water, their own setting: off (default) / ultra low / low / medium / high (`SSR_LEVELS`: steps, depth range, ray length) + `blur`, independent of the quality preset (rays march in the water shader through the SSAO depth pre-pass, stretched to `ssr.distance`; reflected colour = previous frame copied at the end of the frame and reprojected; options menu, F2, `?ssr=<level>`); `Glows.js` light halos of asset parts with `glow` (lamps, fires, beacons: one draw, faded in at dusk, occluded through the SSAO depth); `Haze.js` the fog: near exponential height haze (denser low down, max opacity, drifting noise banks carried by the wind, thicker at sunrise / dusk / night, coloured by the light + a sun glow) + far exp2 fog matching the sky's horizon, in every engine material (`Lighting.patch` / `setupFragment`; the water calls the same `hazeVertex` / `hazeFrag`): the haze's opacity per vertex, handed over in ONE float varying (on Apple's tile GPUs every varying component costs per triangle: a vec4 cost ~1 ms), the far fog and the colours per pixel from `vViewPosition`, applied before tone mapping (environment.json `haze`, `fogDensity`; F2 → Fog & haze; player on / off + strength: Options menu, `?fog=0` / `?fog=<strength>`, `live fog`); `Motes.js` dust specks around the camera (one draw of points, lit only where the sun cascades say the air is sunlit, bright against the light; `motes`; `?motes=0`); `layers.js` (STATIC/DYNAMIC cast shadows, DETAIL/FX don't, EDITOR only in the editor).
- `src/engine/world/` terrain (data, generator; `TerrainData` covers a square from its corner `x0`, `z0` (= `center` - size / 2): grid / sector / texture math goes through `x0` / `z0`, never `-size / 2`), `TerrainRenderer.js` CDLOD (a quadtree selected on the CPU every frame, every patch an instance of one 8x8 grid in ONE draw; vertices morph onto the next level's grid near the end of their range: no cracks, skirts or pops; heights / normals / tint are textures, the normals sampled per pixel at every LOD; level 0 = the heightfield split like `heightAt()`; a second, distance-only selection casts into the cascades: `shadowMesh`; level 0's range from the draw scale, ≥ ~4 node sizes), `Water.js` (ocean: a polar grid around the camera, out to the far plane; opaque over water deeper than 6 m past ~2 km, `DEEP_SEA`, where `TerrainRenderer` skips the seabed: from a plane the sea floor to the horizon was lit for nothing), `Vegetation.js` + `VegetationScatter.js` (drawn by `render/InstancedField.js`: sector culling + 16 m sub-cells for the near LODs' rings (`sub`: out-of-range instances still run the whole vertex shader, in every pass), shader LOD cross-fades `LodFade.js`, far impostors `Impostors.js`; the big trees' impostors reach ~2.5-3 km: the whole island; F2 → Graphics → Display → vegetation LODs shows / hides each LOD level, `Vegetation.setLodVisible`), `Grass.js`, `Entities.js` (entity registry + manager; props → `render/StaticBatch.js`), `World.js` (loads everything; camera far plane = the world square's diagonal (~2.9 km; ~11.6 km for the 8 km world): the whole map is drawn, the fog hides it past ~3 km).
- `src/engine/physics/Physics.js` shapes + grid; `collideCylinder`, `groundAt`, `raycast`, `visible`.
- `src/engine/assets/ModelBuilder.js` (asset JSON → geometry with normals, metric uvs, per-vertex `surface`; format in docs/ASSETS.md), `generators.js` (textured trees / palms / plants: leaf cards, frond strips), `surfaces.js` (surface name → layer id, shared with the Node tools).
- `src/engine/anim/Characters.js` NPC bodies: realistic Rocketbox bodies of `public/models/characters` (built by `mc character build` from `characters.json`: one skinned mesh on the game rig, photo atlas, distance LODs = index ranges, `setLodDistance`) and the older flat-coloured Quaternius models (merged mesh); UAL retargeting (once per rig, shared), clip aliases, hitboxes, palettes (part tints), weapon grip. Archetypes pick `model` / `models` (one per actor), entities can set `model`.
- `src/game/Game.js` game rules + live commands; `player/` (Player, Weapons, ViewModels = loads the realistic first-person weapons / arms of `public/models/fp` (built by `mc viewmodel build` from `viewmodels.json`), ViewArms = realistic skinned arms (Rocketbox) on the weapon grips by two-bone IK, grips = weapon asset `hands`, config `player.json` `arms`, ViewLight = light of the view-model pass: its camera follows the world camera, the materials get the world sun + cascaded shadows and the probe GI, a procedural sky PMREM for reflections; no SSAO), `actors/` (Actors, AI, Nav), `missions/` (Missions runtime, Dialogue), `entities/index.js` (game entity types & schemas), `vehicles/`, `fx/Effects.js`, `fx/Birds.js` (flocks around the camera: perched on tree crowns / beaches, soaring, Bezier flights between the two; startled by gunshots and the player, can be shot; wings flapped in the vertex shader; `?birds=0` off), `ui/` (HUD, Menus, PerfOverlay = stats graphs bottom right, F3; DebugPanel = lil-gui cheats / toggles, F2; both on by default, `?stats=0` / `?debug=0` hide them, off with `?bot` / `?bench` / `?nohud`; in debug mode settings are never read from / written to localStorage, so a reload restores the defaults).
- `src/game/vr/` VR mode (docs/VR.md): `VR.js` session, controllers, rig (`engine.xrRig`: the headset
  pose is relative to it; the camera keeps the head's world pose), controls → game actions, XR
  warm-up; `VRLocomotion.js` (room-scale, stick, snap turns, climbing, gliding), `VRWeapons.js`
  (guns held / aimed along the controller ray / two hands / physical reload, grenades, machete),
  `VRHands.js` (forearms + hands by IK), `VRUI.js` (world-space menus with a laser, head-locked
  toasts, wrist watch, ammo counter, objective marker, vignette); `detect.js` (headset browsers,
  `?vr=1`, `?xremu=1` = IWER's emulated Quest 3). Engine: `xr` (WebGL 2 + multiview, session loop).
- `src/editor/core.js` editor logic (signals `S`, selection, gizmo, brushes, undo, save, live commands), `ui/`, `panels/`.

## WebGPU (three.js WebGPURenderer, TSL)
- Shaders are TSL node graphs (`three/tsl`), no GLSL. Engine materials come from
  `Lighting.material()` / `patch()`; full-screen passes are `NodeMaterial`s with a `fragmentNode`.
- Output: no HDR buffer / output pass. `renderer.contextNode` (`Grade.js` `outputContext`) tone maps
  + sRGB-encodes inside every material drawn to the canvas (or a target flagged `mcOutput`);
  `material.mcRawOutput` writes as is (additive glows, flare, motes); `toneMapped: false` = encode only.
- `render/tsl.js`: `U(v)` = uniform shared per render (renderGroup, stable name: `.value` like the old
  uniform objects, so the debug panel / editor / tools keep writing `uniforms.x.value`); `tex(t)` /
  `T(node, name)` = texture nodes without per-object uv-matrix uniforms (otherwise uploaded with each
  draw; tsl.js patches TextureNode.clone so `.sample()` / `.level()` clones keep that off: three
  turned it back on for every sample); `Fn().setLayout()` functions are real WGSL functions (much faster shader builds than inlined
  code); tsl.js patches three so their code is generated per shader (three caches it per backend and
  would lose the uniforms / textures they read). A function called inside a varying made in a
  fragment-stage setup (lights) is generated for the fragment stage (textureSample, unbound
  textures in the vertex shader): do vertex-stage work in the position node (varyingProperty).
  `patch` is a reserved WGSL word (attribute names).
- Instancing: `render/Instancing.js` `InstancedBatch` (instance matrix attributes `iM0..iM3`, applied
  in the materials' vertex node), not THREE.InstancedMesh (three builds its shaders per InstancedMesh).
  Buffers are static usage + update ranges: a DynamicDrawUsage attribute is re-uploaded whole at every draw.
- A shader is built for the attribute set of the first geometry an object draws and kept when the
  mesh gets another geometry: give meshes filled later a placeholder geometry with the same
  attributes (TerrainRenderer, Glows, the editor asset preview).
- Screen space: texture / framebuffer origin top-left (`ndcToUv`), depth 0..1. Compare (shadow)
  sampling only in fragment shaders (`SunShadows.shadowVertexFn` loads texels in the vertex stage).
- Pipelines: `World.warmUp` compiles every material x object type (`compileAsync`) and draws one
  frame with everything visible; `lateShaders` = pipelines created after that. `compileAsync`
  yields to the main thread between pipelines: no rAF loop may run during the loading (without
  vsync it starves the warm-up) — per-frame UI updates go through `engine.addSystem`.
- Timing tests (`*_smooth.play`, `plane.play`) check the CPU time of the rendered frames
  (`perf.onFrame`), not rAF intervals: without vsync Chrome presents WebGPU canvases in bursts
  (fast frames, then a ~18 ms wait on the Metal queue). With vsync frames are even.
- `?webgl=1` (WebGPURenderer's WebGL 2 backend, VR) runs: the sun cascades' matrices map clip z
  -1..1 to 0..1 there; no dust motes (the vertex stage can't read the cascades), FarShadows / SSR are
  WebGPU only. `render/tsl.js` patches three's WebGL backend: texture v-flips decided at build time
  (not a per-object uniform), render-group uniform arrays sharing one GPU buffer per node (not a
  bufferData per draw). Nested `select()`s inside a Fn can break the GLSL builder (GI.js). The Quest
  browser hands out WebGL contexts in zero-to-one clip depth while three's projections are -1..1:
  `Engine._clipControl` sets -1..1 (else the near half of the sun cascades' depth range was clipped:
  no tree / vehicle shadows, a band where the terrain was cut).

## Data files
| file | content | edit with |
|---|---|---|
| `terrain/layout.json` | the world square (`size`, `res`: 2 m cells, `center`: 2 × 2 km around the origin, x / z -1024..1024 — Isla Sombra, where the story is, and its islets; the 8 × 8 km world with Isla Grande and Isla Mayor is kept on the `big-islands` branch (slow to load during development); the editor's Regenerate can't change the size: grow it with `mc terrain generate` and reload), islands (`warp` / `warpScale`: a coarse coastline warp of their own, for big ones), mountains (`ridgeScale`; `noiseScale` / `noise`: wavelength (m) / amplitude (× r) of the outline noise, default 120 / 0.18 — longer and weaker for big ones, else spires), plateaus, lagoons, rivers, roads, flat sites | `mc data set`, editor ⛰ Island, then `mc terrain generate` (+ `mc vegetation generate --region x0,z0,x1,z1` for new land) |
| `terrain/height.bin, material.bin, terrain.json` | heightfield (u16) + painted materials | `mc terrain sculpt`, editor brushes |
| `vegetation.json` / `vegetation.bin` | species rules / placed instances (the .bin has hand edits: add a species with `mc vegetation generate --species <id>`, which keeps every other instance) | `mc vegetation generate|clear`, editor 🌴 brush |
| `assets/*.json` (+ `index.json`) | models: parts with colours + texture `surface`s (docs/ASSETS.md; the guns are CC0 Quaternius GLBs converted by `mc asset import`) | write JSON, `mc asset validate|shot|reindex|bake|import` |
| `textures.json` + `public/textures/*` | texture layers (Poly Haven / ambientCG CC0 sources, scales, means) and the packed arrays (docs/TEXTURES.md) | edit JSON, `mc textures fetch|build|info` |
| `world.json` | player start + entities (props, enemies, npcs, pickups, outposts, alarms, zones, markers, paths, vehicles…) | `mc entity list|add|set|move|remove|types` |
| `game/missions.json`, `game/dialogue.json` | story (docs/MISSIONS.md) | `mc mission list|show`, `mc data set`, editor 🎯 / 💬 |
| `game/weapons.json`, `archetypes.json`, `items.json`, `player.json`, `birds.json` | gameplay tuning (archetypes: body `model` / `models`, palette, stats; birds: species → asset, flight, habitat, flocks, calls; player `vr`: VR arms, grip, climb, glide, pouches) | `mc data get|set`, editor 📊 |
| `characters.json` + `public/models/characters/*.glb` | NPC bodies: Rocketbox avatars (MIT, credits in `models/characters/CREDITS.md`), texture scales, LODs, camouflage `recolor`, insignia `erase` | `mc character fetch|build|shot|list` (docs/ASSETS.md) |
| `viewmodels.json` + `public/models/fp/*.glb` | first-person arms (Rocketbox, MIT) and realistic weapons (CC0 / CC-BY, credits in `models/fp/CREDITS.md`): sources, import parameters; the weapon points (`muzzle`, `sight`, `hands`) stay in the weapon assets | `mc viewmodel fetch|build|shot|list` (docs/ASSETS.md) |
| `environment.json` | time of day, light, SSAO (`ao`), GI / auto exposure (`gi`, `autoExposure`), lens flare (`flare`), light halos (`glows`), water reflections (`ssr`), far fog (`fogDensity`), near haze (`haze`), dust motes (`motes`), sky / ocean colours | `mc data set`, editor ☀ |
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
Headless shots run on the real GPU on macOS; on Linux without Chrome / a GPU the tools use the bundled
Chromium with SwiftShader (correct pixels, a few seconds per frame: keep shots small, `--frames` low;
the real-time gameplay tests and the benches are not meaningful there).

Live game commands: state, teleport, give, god, noclip, setTime, startMission, completeObjective,
spawn, killAll, start, look, birds, fog. Live editor commands: state, select, get, add, set, patch, remove,
camera, focus, setEnv, sculpt, save, undo, panel, materials (+ eval, screenshot, commands everywhere).
