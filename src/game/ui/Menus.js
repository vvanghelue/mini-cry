// Menus: main menu, pause, settings, death screen, full-screen map (with fast travel), end screen.
import { FOG_STRENGTH } from '../../engine/render/Haze.js';

const h = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

// difficulty setting values (saved in the settings, keys of Game.js DIFFICULTY) -> displayed label
// Options → Antialiasing (WebGPU: 1 or 4 samples)
const aaOptions = (app) => [
  ['auto', app.mobile ? 'Auto (FXAA, MSAA 4x on high / ultra)' : 'Auto (MSAA 4x)'],
  ['msaa4', 'MSAA 4x'],
  ['fxaa', 'FXAA'], ['off', 'Off'],
];
const DIFFICULTY_LABELS = [['facile', 'Easy'], ['normal', 'Normal'], ['difficile', 'Hard']];

export class Menus {
  constructor(game) {
    this.game = game;
    this.root = h('div', 'menus', document.body);
    this.panel = h('div', 'menu-panel', this.root);
    this.mapEl = h('div', 'map-screen', document.body);
    this.mapCanvas = h('canvas', '', this.mapEl);
    this.mapInfo = h('div', 'map-info', this.mapEl);
    this.mapOpen = false;
    this.mapCanvas.addEventListener('click', (e) => this._mapClick(e));
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.mapOpen) { e.preventDefault(); this.toggleMap(); }
    });
    // controls help, prompts and the focused item follow the device in use (keyboard / gamepad)
    game.input.onDevice.add((d) => {
      const help = this.panel.querySelector('.help');
      if (help) help.innerHTML = this._help();
      if (d === 'pad' && this.open && !this.panel.contains(document.activeElement)) { this._padFirst()?.focus(); this._padWake = true; }
      if (this.mapOpen) this._drawMap();
    });
  }

  hideAll() { this.root.classList.remove('show'); }
  get open() { return this.root.classList.contains('show'); }

  _show(html, actions) {
    this.panel.innerHTML = html;
    for (const [sel, fn] of Object.entries(actions ?? {})) this.panel.querySelector(sel)?.addEventListener('click', (e) => { this.game.audio?.resume?.(); this.game.audio?.play('ui_click', { volume: 0.4 }); fn(e); });
    this.root.classList.add('show');
    if (this.game.input.device === 'pad') this._padFirst()?.focus();
  }

  _items() { return [...this.panel.querySelectorAll('button, input, select')]; }
  /** The item a gamepad starts on ([data-pad-focus], else the first). */
  _padFirst() { return this.panel.querySelector('[data-pad-focus]') ?? this._items()[0]; }

  /** Gamepad: D-pad / left stick move the focus, A activates, ◀ ▶ change a slider or a list, B goes back. */
  pad(inp) {
    if (this.mapOpen) return this._padMap(inp);
    if (!this.open) return;
    if (this._padWake) { this._padWake = false; return; } // the press that switched to the pad only focuses
    const items = this._items();
    if (!items.length) return;
    const a = inp.keyHit('Pad:A') || (!this.game.started && inp.keyHit('Pad:Start'));
    const i = items.indexOf(document.activeElement);
    if (i < 0) { if (a || inp.nav.x || inp.nav.y) this._padFirst().focus(); return; }
    const el = items[i];
    if (inp.nav.y) { items[(i + inp.nav.y + items.length) % items.length].focus(); return; }
    if (inp.nav.x && el.type === 'range') {
      const step = Math.max(Number(el.step) || 1, (el.max - el.min) / 40);
      el.value = Number(el.value) + inp.nav.x * step;
      el.dispatchEvent(new Event('input'));
    } else if ((inp.nav.x || a) && el.tagName === 'SELECT') {
      const n = el.options.length;
      el.selectedIndex = inp.nav.x ? Math.min(n - 1, Math.max(0, el.selectedIndex + inp.nav.x)) : (el.selectedIndex + 1) % n;
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    } else if (a) el.click(); // buttons, checkboxes
    if (inp.keyHit('Pad:B')) this.panel.querySelector('.b-back, .b-res')?.click();
  }

  /** Controls help line for the device in use. */
  _help() {
    const g = this.game, inp = g.input, L = (a) => inp.label(a);
    if (inp.device === 'pad') return `Left stick move (${L('sprint')} sprint) · Right stick look · ${L('fire')} fire · ${L('aim')} aim · ${L('reload')} reload / use · ${L('jump')} jump · ${L('crouch')} crouch · ${L('grenade')} grenade · ${inp.padLabel('RB')} / ${inp.padLabel('RS')} machete · ${L('nextWeapon')} / ${inp.padLabel('Left')} ${inp.padLabel('Right')} weapons · ${L('binoculars')} binoculars · ${L('flashlight')} flashlight · ${L('map')} map · ${L('pause')} pause`;
    if (g.app.mobile) return 'Left stick move (push to the edge to sprint) · Drag the right side to look · FIRE (drag it to aim while firing) · AIM / CROUCH toggle · USE when a prompt shows · ⇄ next weapon · R reload · G grenade · V machete';
    return 'WASD/ZQSD move · Mouse look · Click / T fire · Right-click aim · R reload · E use · G grenade · V machete strike · Shift sprint · Ctrl crouch · Space jump · B binoculars · M map · 1-5 / Q (A on AZERTY) / wheel weapons · Gamepad: press a button';
  }

  showMain() {
    const g = this.game;
    const cont = g.hasSave() || g.params.has('continue');
    if (g.params.has('continue')) { setTimeout(() => g.newGame({ fromCheckpoint: true }), 0); return; }
    this._show(`
      <div class="logo">MINI <span>CRY</span></div>
      <div class="tag">Isla Sombra — an open-world FPS</div>
      <button class="b-new">New game</button>
      ${cont ? '<button class="b-cont" data-pad-focus>Continue</button>' : ''}
      <button class="b-opt">Options</button>
      <button class="b-edit">Editor</button>
      <div class="help">${this._help()}</div>
      <div class="load">${g.loadMs ? `Loaded in ${(g.loadMs / 1000).toFixed(1)} s` : ''}</div>`, {
      '.b-new': () => { try { localStorage.removeItem('minicry.save.v1'); } catch { /* */ } g.newGame(); },
      '.b-cont': () => g.newGame({ fromCheckpoint: true }),
      '.b-opt': () => this.showSettings(() => this.showMain()),
      '.b-edit': () => (location.href = '/editor.html'),
    });
  }

  showPause() {
    const g = this.game;
    const s = g.stats;
    this._show(`
      <div class="title">PAUSE</div>
      <button class="b-res">Resume</button>
      <button class="b-map">Map</button>
      <button class="b-cp">Load last checkpoint</button>
      <button class="b-opt">Options</button>
      <button class="b-quit">Main menu</button>
      <div class="stats">Kills ${s.kills} · Stealth takedowns ${s.takedowns} · Accuracy ${s.shots ? Math.round((s.hits / s.shots) * 100) : 0}% · Outposts ${g.liberated.size}</div>`, {
      '.b-res': () => g.resume(),
      '.b-map': () => { this.hideAll(); this.toggleMap(); },
      '.b-cp': () => g.loadCheckpoint(),
      '.b-opt': () => this.showSettings(() => this.showPause()),
      '.b-quit': () => (location.href = location.pathname),
    });
  }

  showDeath() {
    const g = this.game;
    this._show(`
      <div class="title red">YOU DIED</div>
      <button class="b-cp">Restart from last checkpoint</button>
      <button class="b-quit">Main menu</button>`, {
      '.b-cp': () => (g.hasSave() ? g.loadCheckpoint() : location.reload()),
      '.b-quit': () => (location.href = location.pathname),
    });
  }

  showEnd(a = {}) {
    const g = this.game, s = g.stats;
    this._show(`
      <div class="title">${a.title ?? 'THE END'}</div>
      <div class="tag">${a.text ?? 'Isla Sombra is free.'}</div>
      <div class="stats">Time ${Math.round(s.playTime / 60)} min · Kills ${s.kills} · Headshots ${s.headshots} · Stealth takedowns ${s.takedowns} · Outposts ${g.liberated.size} · Relics ${g.collected.relic ?? 0}</div>
      <button class="b-free">Keep exploring</button>
      <button class="b-quit">Main menu</button>`, {
      '.b-free': () => { g.started = true; g.resume(); },
      '.b-quit': () => (location.href = location.pathname),
    });
  }

  showSettings(back) {
    const g = this.game, s = g.settings;
    this._show(`
      <div class="title">OPTIONS</div>
      <label>Quality <select name="quality">${['low', 'medium', 'high', 'ultra'].map((q) => `<option ${q === s.quality ? 'selected' : ''}>${q}</option>`).join('')}</select></label>
      <label>Antialiasing <select name="antialias">${aaOptions(g.app).map(([v, l]) => `<option value="${v}" ${v === (s.antialias === 'msaa' ? 'msaa4' : s.antialias ?? 'auto') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Ambient occlusion (SSAO) <input name="ao" type="checkbox" ${s.ao !== false ? 'checked' : ''}></label>
      <label>Sun lens flare <input name="flare" type="checkbox" ${s.flare !== false ? 'checked' : ''}></label>
      <label>Fog & haze <input name="fog" type="checkbox" ${s.fog !== false ? 'checked' : ''}></label>
      <label>Fog strength <input name="fogStrength" type="range" min="0" max="2" step="0.01" value="${s.fogStrength ?? FOG_STRENGTH}"></label>
      <label>Dust motes <input name="motes" type="checkbox" ${s.motes !== false ? 'checked' : ''}></label>
      <label>Water reflections (SSR) <select name="ssr">${[['off', 'off'], ['ultralow', 'ultra low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']].map(([q, l]) => `<option value="${q}" ${q === (s.ssr === true ? 'medium' : s.ssr || 'off') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Difficulty <select name="difficulty">${DIFFICULTY_LABELS.map(([q, l]) => `<option value="${q}" ${q === s.difficulty ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>${g.app.mobile || g.input.device === 'pad' ? 'Look sensitivity' : 'Mouse sensitivity'} <input name="sensitivity" type="range" min="0.3" max="2.5" step="0.05" value="${s.sensitivity}"></label>
      <label>Field of view <input name="fov" type="range" min="60" max="95" step="1" value="${s.fov}"></label>
      <label>Invert Y axis <input name="invertY" type="checkbox" ${s.invertY ? 'checked' : ''}></label>
      <label>Volume <input name="volume" type="range" min="0" max="1" step="0.05" value="${s.volume}"></label>
      <label>Music <input name="music" type="range" min="0" max="1" step="0.05" value="${s.music}"></label>
      <label>Dialogue voices <input name="voices" type="checkbox" ${s.voices ? 'checked' : ''}></label>
      <label>Voice volume <input name="voiceVolume" type="range" min="0" max="1.5" step="0.05" value="${s.voiceVolume ?? 1}"></label>
      <label class="perf-row">Show performance stats (F3) <input name="perf" type="checkbox" ${document.getElementById('perf')?.hidden === false ? 'checked' : ''}></label>
      <button class="b-back">Back</button>`, {
      '.b-back': () => back(),
    });
    this.panel.querySelectorAll('input, select').forEach((inp) => inp.addEventListener('input', () => {
      if (inp.name === 'perf') { g.app.perf?.setVisible(inp.checked); return; }
      const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? Number(inp.value) : inp.value;
      g.saveSettings({ [inp.name]: v });
    }));
  }

  // --- map ---------------------------------------------------------------------------------
  toggleMap() {
    const g = this.game;
    this.mapOpen = !this.mapOpen;
    this.mapEl.classList.toggle('show', this.mapOpen);
    if (this.mapOpen) {
      this.hideAll();
      this._padSel = -1;
      g.input.unlock();
      g.engine.timeScale = 0;
      this._drawMap();
    } else if (g.paused) {
      // opened from the pause menu: go back to it (Escape is not a user gesture, the pointer
      // lock the player released with Escape can't be taken back from it)
      this.showPause();
    } else if (g.started && g.player.alive) {
      g.engine.timeScale = g.cheats.timeScale;
      g.input.lock();
    }
  }

  _drawMap() {
    const g = this.game, T = g.world.terrain;
    const size = Math.min(innerWidth, innerHeight) * 0.86;
    const c = this.mapCanvas;
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.drawImage(g.hud.mapImage, 0, 0, size, size);
    const k = size / T.size;
    const px = (x) => (x - T.x0) * k, pz = (z) => (z - T.z0) * k;
    this._fast = [];
    // labels from markers with a map label
    ctx.font = 'bold 13px Trebuchet MS';
    ctx.textAlign = 'center';
    for (const e of g.world.entities.list) {
      if (e.type === 'marker' && e.label) { ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(e.label, px(e.pos[0]) + 1, pz(e.pos[2]) + 1); ctx.fillStyle = '#fff'; ctx.fillText(e.label, px(e.pos[0]), pz(e.pos[2])); }
      if (e.type === 'outpost') {
        const lib = g.liberated.has(e.id);
        ctx.fillStyle = lib ? '#3fb0ff' : '#e03030';
        ctx.beginPath(); ctx.arc(px(e.pos[0]), pz(e.pos[2]), 7, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#000'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillText(e.name ?? 'Outpost', px(e.pos[0]), pz(e.pos[2]) - 12);
        if (lib && e.fastTravel !== false) this._fast.push({ id: e.id, x: px(e.pos[0]), y: pz(e.pos[2]) });
      }
    }
    for (const m of g.missions.markers()) {
      ctx.fillStyle = '#ffd34d'; ctx.strokeStyle = '#000';
      const x = px(m.x), y = pz(m.z);
      ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    for (const a of g.actors.list) {
      if (!a.alive || !(a.tagged || a.ai?.state === 'combat')) continue;
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath(); ctx.arc(px(a.pos.x), pz(a.pos.z), 3, 0, Math.PI * 2); ctx.fill();
    }
    // player arrow
    const p = g.player;
    ctx.save();
    ctx.translate(px(p.pos.x), pz(p.pos.z));
    ctx.rotate(-p.yaw);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // gamepad: the fast travel destination picked with the D-pad
    const pad = g.input.device === 'pad', inp = g.input;
    const sel = pad && this._fast[this._padSel];
    if (sel) { ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sel.x, sel.y, 13, 0, Math.PI * 2); ctx.stroke(); }
    const how = pad ? `${inp.padLabel('Left')} ${inp.padLabel('Right')} pick a liberated outpost (blue), ${inp.padLabel('A')} to travel there.` : (g.app.mobile ? 'Tap' : 'Click') + ' a liberated outpost (blue) to travel there.';
    const close = pad ? `${inp.padLabel('B')} / ${inp.label('map')}` : g.app.mobile ? 'MAP' : 'M / Esc';
    const m = g.missions.focus && g.missions.defs.get(g.missions.focus);
    this.mapInfo.innerHTML = `<b>${m?.title ?? 'Free roam'}</b><br>${m ? (m.objectives[g.missions.state[m.id]?.obj]?.text ?? '') : ''}<br><small>${this._fast.length ? how : 'Liberate outposts to unlock fast travel.'} · ${close} to close</small>`;
  }

  _mapClick(e) {
    const r = this.mapCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const f = (this._fast ?? []).find((o) => Math.hypot(o.x - x, o.y - y) < 12);
    if (f) this._travel(f);
  }

  _padMap(inp) {
    if (inp.keyHit('Pad:B')) { this.toggleMap(); return; }
    const f = this._fast ?? [], step = inp.nav.x || inp.nav.y;
    if (!f.length) return;
    if (step) {
      this._padSel = this._padSel >= 0 ? (this._padSel + step + f.length) % f.length : step > 0 ? 0 : f.length - 1;
      this._drawMap();
    }
    if (inp.keyHit('Pad:A') && f[this._padSel]) this._travel(f[this._padSel]);
  }

  _travel(f) {
    this.toggleMap();
    this.game.fastTravel(f.id);
    if (this.game.paused) this.game.resume(); // a click is a user gesture: the pointer lock comes back
  }
}
