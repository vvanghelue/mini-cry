# VR mode (Meta Quest 3)

The game plays in a WebXR headset with two motion controllers, in the spirit of Population: One:
walking on the stick, real aiming, guns held with one or two hands, magazines reloaded by hand,
grenades thrown, any surface climbed, gliding with the arms spread.

## Running it

A headset's own browser (Meta Quest Browser, Pico, Wolvic: user agent) starts in VR mode; `?vr=1` /
`?vr=0` force it. A desktop browser with a PC headset (Quest Link, SteamVR) shows a "Play in VR"
button on the main menu. The page loads as usual (2D panel), then **ENTER VR** starts the session
(WebXR needs a click); the first frame of the session compiles the multiview pipelines (a few seconds
on a Quest, the headset shows its loading dots), then the main menu panel shows.

On the Quest (USB, developer mode on, "Allow USB debugging" accepted in the headset):

```bash
npm run quest -- setup     # adb forward / reverse (the game at http://localhost:5190 in the headset)
npm run quest -- open      # opens the game in the Quest browser, waits for the loading
npm run quest -- enter     # enters VR (as a user gesture over DevTools) and starts the game
npm run quest -- fps "now=0" "east=__mc.game.vr.turn(Math.PI/2)"
npm run quest -- shot      # screenshot of the headset (both eyes) -> shots/quest.png
npm run quest -- release   # gives the proximity sensor back (setup keeps the headset awake)
```

`setup` sends `com.oculus.vrpowermanager.prox_close` so the headset keeps rendering on a desk;
`release` undoes it. Everything else: `npm run quest -- help`.

Desktop without a headset: `?vr=1&xremu=1` installs IWER (Meta's WebXR runtime in JS, an emulated
Quest 3: `window.__xrDevice.controllers.right.position.set(...)`, `updateButtonValue('trigger', 1)`,
`updateAxes('thumbstick', x, y)`); `tests/vr.play` drives it.

## Controls (right-handed; Options → Gun hand: left mirrors them)

| | left controller | right controller |
|---|---|---|
| stick | walk (toward the head, Options: the left hand); click: sprint | turn (snap 30°/45°, or smooth); down: crouch toggle; click: flashlight |
| trigger | use (doors, talk, pick up, get in a vehicle) | fire |
| grip | the gun's foregrip (two hands), a magazine from the belt, a grenade from the chest, climb | climb (the gun holsters while the hand holds a wall) |
| lower button | X: next weapon | A: jump |
| upper button | Y: pause menu | B: eject the magazine |

- **Aiming**: the barrel follows the controller's pointing ray. The sight held in front of an eye
  (and aligned with the view) counts as aiming down sights; two hands steady the gun (less spread,
  less recoil, the barrel goes from one fist to the other).
- **Reload**: B drops the magazine (its rounds go back to the reserve), the left hand takes one at
  the belt (left hip) and pushes it into the magazine well; shotgun shells one at a time into the
  loading port, rockets into the RPG's muzzle. Inserting into a gun that still has a magazine swaps
  it.
- **Grenades**: grip at the chest, throw, let go (the release speed is the hand's).
- **Machete**: swing it; the blade going fast through a body hits (a takedown when unaware / from
  behind).
- **Climbing**: a free hand closing its grip on anything within reach (walls, rocks, trunks, cliffs,
  the ground) holds it: the body moves instead of the hand; letting go keeps the hand's last speed
  (vault over a wall, jump off a ledge).
- **Gliding**: falling, both arms spread to the sides: a slow sink and 13 m/s forward; one hand
  higher than the other banks toward the low one, the head pulls the course gently; no fall damage.
- **Crouching**: physical (the head below 78 % of the standing eye height), or the right stick down.
  Seated mode (Options) measures the eye height once and adds what is missing.
- **Vehicles**: the head lands on the seat's eye point when getting in (turning with the vehicle, a
  plane banks and pitches with it); right trigger throttle, left trigger brake / reverse, left
  stick steer, X gets out. Planes fly toward where the head looks.
- **Menus**: pointed at with either controller's laser, clicked with its trigger.

## How it works

- **Renderer** (`Engine.js`, `xr: true`): three's WebGPURenderer on its **WebGL 2 backend** (the
  Quest browser has WebGPU but no WebXR binding for it), multiview (both eyes in one pass,
  `OVR_multiview2`), MSAA 4x, WebXR projection layers with fixed foveation. The frame loop is three's
  animation loop (the session's once presenting). The headset pose is applied relative to
  `engine.xrRig`; the camera stays in the scene root and holds the head's world pose after each
  frame, so every system keeps reading `camera.position` as world.
- **`src/game/vr/`**:
  - `VR.js`: session, controllers (grip / ray poses, buttons with hysteresis, velocity), the rig
    (`place()`: the head right above the body's feet, or in a vehicle's seat; `turn()` about the
    head), the controller → game action mapping (the stick → `input.moveX/Y`, buttons →
    `input.setVirtual`), the XR warm-up.
  - `VRLocomotion.js`: in place of the desktop look + move: room-scale steps move the collider (walls
    push the view back), the head's height crouches, snap / smooth turns, climbing, gliding
    (`player.flight`); the rest is `Player.update`.
  - `VRWeapons.js`: the gun's pose, two hands, trigger, recoil + haptics, aiming, physical reload,
    grenades, machete; `Weapons.js` keeps the inventory, hitscan (`Weapons.aim()`), projectiles.
  - `VRHands.js`: the first-person arms model (ViewArms, two-bone IK) cut at the elbows, wrists on
    the controllers or on the gun's grips (weapon asset `hands`), fingers curled by the buttons.
  - `VRUI.js`: canvas panels in the world (menus + laser pointer; a lazy head-locked panel for
    banners / notifications / subtitles / prompts; the left-wrist watch: health, armour, grenades,
    objective; the ammo counter on the gun; the objective marker) and the comfort / hurt vignette.
    The HUD forwards its events (`game.vr?.ui.*`).
- **Tuning**: `game/player.json` `vr` (refresh rate, arms, grip offset and pitch, crouch ratio, climb
  reach / fling, glide, throw boost, pouch positions); player options in the settings (`vr`: turn,
  snap angle, vignette, gun hand, walk direction, seated mode).

## Performance (Quest 3, 72 Hz)

The budget is ~13.9 ms per frame on both sides, and on the CPU side the renderer process' main
thread runs the JS **and** the WebXR frame submission (~2–3 ms): the JS must stay under ~8 ms or a
frame misses its vsync and the rate halves. Measured on the start beach (four directions, headset on
a desk): 58–73 fps, GPU 7–12 ms, JS 6.7–7.5 ms, 38–60 draws.

What it took (in order of gain):
1. **Uniform buffers** (`render/tsl.js`): three's WebGL backend gave every material / object its own
   copy of the render group's uniform arrays (with multiview: the camera matrices of both eyes) and
   re-specified each with `bufferData` at every draw. They share one buffer per node, uploaded when
   their bytes change: 42–60 fps became 63–71 in the same views, GPU time down too (buffer
   orphaning).
2. **Texture v-flips** (`render/tsl.js`): three's GLSL path gives every texture sample a flip
   uniform updated per object per draw; the flip is decided when the shader is built (the 2D page's
   frame on the Quest went from 30 to 15 ms of CPU).
3. **Shading** (`QUALITY.vr`): Lambert in place of GGX + sky reflections (`pbr: false`), a filmic
   curve straight to display values in place of AgX + grade + sRGB (`Grade.js`), the probe GI per
   vertex (`vertexGI`), one shadow cascade with one hardware 2x2 compare and no selection logic,
   re-rendered every 6 frames. Leaves' lighting was ~4.5 ms of GPU on the beach.
4. **Draws**: one variant per vegetation species (`vegVariants`), vegetation at 0.2 of its desktop
   distances (`drawScale`), props at 0.6 (`propScale`), effect pools drawn only once used, no lens
   flare, no dust motes (WebGL can't read the cascades in a vertex shader), no SSAO / SSR.
5. **Eye buffers** 0.75 of the recommended size (1260 × 1320 per eye) with fixed foveation 1; MSAA 4x
   stays (cheap on a tiled GPU).
6. **XR warm-up**: multiview pipelines differ from the 2D page's; the session's first frame draws
   everything (`World.warmUpShow`) instead of ~140 compiles hitching the first minute of play.

`npm run quest -- breakdown` measures each system's GPU ms (toggled on / off five times, VrApi
`App=`), `calls` the draws per group + WebGL calls per frame, `profile` the JS, `trace` each thread's
busy time per frame. Each draw still costs ~70 µs of JS in three's WebGL backend: the draw count is
the main CPU lever.

## Not done yet

- Scopes don't magnify (the sniper's scope is a sight); binoculars and the full-screen map have no
  VR version.
- Hands on the steering wheel / the plane's stick; vehicles are only checked in the emulator.
- Hand tracking (controllers only).
- The busiest places (jungle outposts with many enemies) are not measured yet; a dynamic resolution
  (`xr.setFramebufferScaleFactor` between sessions, or per-frame viewport scaling) would be the next
  lever on the GPU side.
