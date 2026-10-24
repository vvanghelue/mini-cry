// Game page entry. Modes (?mode=): play (default), view (free camera), asset (asset turntable),
// viewmodel (first-person weapon + arms), characters (NPC bodies lineup).
// VR (?vr=1, or a headset's browser: Quest...): WebGL 2 + WebXR, the `vr` quality preset, the
// game played with the motion controllers (src/game/vr/); ?xremu=1 emulates a Quest 3 (IWER).
import * as THREE from 'three/webgpu';
import { Engine } from '../engine/core/Engine.js';
import { Input } from '../engine/core/Input.js';
import { World } from '../engine/world/World.js';
import { Live } from '../engine/core/Live.js';
import { startViewMode, startAssetMode, startViewModelMode, startCharactersMode } from './modes/viewer.js';
import { PerfOverlay } from './ui/PerfOverlay.js';
import { DebugPanel } from './ui/DebugPanel.js';
import { isMobile } from './ui/TouchControls.js';
import { isVRBrowser, installXREmulator, offerVR } from './vr/detect.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'play';
// VR headset browsers (?vr=1 / ?vr=0 force it): the game in the headset, motion controllers
const vr = mode === 'play' && isVRBrowser(params);
if (vr && params.get('xremu') === '1') await installXREmulator();
// phones / tablets (?mobile=1 forces it): touch controls, landscape full screen, low quality, no debug / stats
const mobile = mode === 'play' && !vr && isMobile(params);
// debug mode (debug panel shown, settings not persisted): on by default, ?debug=0 turns it off,
// automated runs (?bot / ?bench / ?nohud) and phones start without it
const debugFlag = params.get('debug');
const debugMode = debugFlag !== null ? debugFlag !== '0' : !(mobile || vr || params.has('bot') || params.has('bench') || params.has('nohud'));
// antialiasing is chosen when the renderer is created: ?aa=msaa4|msaa (= 4x)|fxaa|off (WebGPU: 1 or 4 samples)
// (0), else the saved setting (Options, applies on the next start), else 'auto': MSAA 4x on
// desktop; on phones / tablets FXAA (MSAA costs 20-30 % of the GPU frame), MSAA on high / ultra
const quality = params.get('quality') ?? (vr ? 'vr' : mobile ? 'low' : 'medium');
let saved = {};
if (!debugMode) try { saved = JSON.parse(localStorage.getItem('minicry.settings.v1') ?? '{}') ?? {}; } catch { /* */ }
const aaParam = params.get('aa');
const aaSetting = aaParam !== null ? (aaParam === '0' ? 'off' : aaParam) : saved.antialias ?? 'auto';
const antialias = aaSetting === 'auto' ? (!mobile || ['high', 'ultra'].includes(saved.quality ?? quality) ? 'msaa4' : 'fxaa') : aaSetting;
const engine = new Engine({ container: document.getElementById('app'), quality, antialias, xr: vr });
await engine.init(); // WebGPU device (WebGL 2 fallback, VR)
const input = new Input(engine.canvas);
const app = { engine, input, THREE, mode, params, debugMode, mobile, vr, ready: false };
// loading screen
const loading = document.createElement('div');
loading.id = 'loading';
loading.innerHTML = '<div class="logo">MINI <span>CRY</span></div><div class="bar"><i></i></div><div class="lbl">Loading…</div>';
if (mode !== 'asset' && params.get('nohud') !== '1') document.body.appendChild(loading);
const LABELS = { terrain: 'Terrain', 'terrain mesh': 'Terrain mesh', water: 'Water', assets: 'Models & textures', vegetation: 'Vegetation', physics: 'Collisions', entities: 'Entities', shaders: 'Compiling shaders', ready: 'Ready' };
app.onLoadProgress = (p, label) => {
  loading.querySelector('i').style.width = `${Math.round(p * 80)}%`;
  loading.querySelector('.lbl').textContent = `${LABELS[label] ?? label}…`;
};
window.__mc = app;
app.live = new Live('game', app);

const perf = (app.perf = new PerfOverlay(engine)); // F3, ?stats=0 hides it
if (params.get('nohud') === '1' || ((mobile || vr) && params.get('stats') === null)) perf.hide();

if (mode === 'asset') {
  await startAssetMode(app, params);
} else if (mode === 'viewmodel') {
  await startViewModelMode(app, params);
} else if (mode === 'characters') {
  await startCharactersMode(app, params);
} else {
  const world = new World(engine, { mode: 'game' });
  app.world = world;
  await world.load({ onProgress: (p, label) => app.onLoadProgress?.(p, label) });
  engine.addSystem(world);
  if (mode === 'view') await startViewMode(app, params);
  else {
    const { startGame } = await import('./Game.js');
    await startGame(app, params);
  }
}
// compile every shader variant now (no hitch the first time one shows up)
if (app.world) { app.onLoadProgress?.(0.98, 'shaders'); await app.world.warmUp(engine.camera, app.game?.warmUpExtras?.() ?? []); }
engine.start();
app.ready = true;
document.getElementById('loading')?.remove();
if (!(mobile || vr) || params.has('debug')) app.debug = new DebugPanel(app, perf); // F2, ?debug=0 hides it
if (app.game?.vr) app.game.vr.ready(); // the Enter VR button
else if (mode === 'play' && !params.has('bot') && !params.has('bench')) offerVR(params); // desktop + a headset: Play in VR
