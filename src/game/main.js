// Game page entry. Modes (?mode=): play (default), view (free camera), asset (asset turntable),
// viewmodel (first-person weapon + arms).
import * as THREE from 'three';
import { Engine } from '../engine/core/Engine.js';
import { Input } from '../engine/core/Input.js';
import { World } from '../engine/world/World.js';
import { Live } from '../engine/core/Live.js';
import { startViewMode, startAssetMode, startViewModelMode } from './modes/viewer.js';
import { PerfOverlay } from './ui/PerfOverlay.js';
import { DebugPanel } from './ui/DebugPanel.js';
import { isMobile } from './ui/TouchControls.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'play';
// phones / tablets (?mobile=1 forces it): touch controls, landscape full screen, low quality, no debug / stats
const mobile = mode === 'play' && isMobile(params);
const engine = new Engine({ container: document.getElementById('app'), quality: params.get('quality') ?? (mobile ? 'low' : 'medium') });
const input = new Input(engine.canvas);
// debug mode (debug panel shown, settings not persisted): on by default, ?debug=0 turns it off,
// automated runs (?bot / ?bench / ?nohud) start without it
const debugFlag = params.get('debug');
const debugMode = debugFlag !== null ? debugFlag !== '0' : !(mobile || params.has('bot') || params.has('bench') || params.has('nohud'));
const app = { engine, input, THREE, mode, params, debugMode, mobile, ready: false };
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
if (params.get('nohud') === '1' || (mobile && params.get('stats') === null)) perf.hide();

if (mode === 'asset') {
  await startAssetMode(app, params);
} else if (mode === 'viewmodel') {
  await startViewModelMode(app, params);
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
if (!mobile || params.has('debug')) app.debug = new DebugPanel(app, perf); // F2, ?debug=0 hides it
