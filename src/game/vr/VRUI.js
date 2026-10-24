// VR interface: the DOM HUD and menus don't exist in the headset, so their content is drawn on
// panels in the world (2D canvases as textures, redrawn only when what they show changes):
//  - menus (main, pause, death, end, options): a panel in front of the head, pointed at with the
//    controllers' laser and clicked with the trigger;
//  - a lazy head-locked panel below the line of sight: banners, notifications, the speaker's
//    subtitles, the interaction prompt;
//  - a watch on the off-hand wrist: health, armour, grenades, the objective and its distance;
//  - the ammo counter on the gun; the objective marker over its target (with the distance);
//  - a vignette around the view: comfort (narrows while the stick / turns move the view) and the
//    red flash when hurt.
// The HUD forwards its events here (HUD.js: game.vr?.ui.<event>).
import * as THREE from 'three/webgpu';
import { Fn, vec4, length, smoothstep, positionLocal } from 'three/tsl';
import { U } from '../../engine/render/tsl.js';
import { LAYERS } from '../../engine/render/layers.js';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _p = new THREE.Plane(), _r = new THREE.Ray();
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/** A flat panel showing a 2D canvas, `w` x `h` metres. */
class Panel {
  constructor(w, h, px, { depthTest = false, order = 20 } = {}) {
    this.w = w; this.h = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = px;
    this.canvas.height = Math.round((px * h) / w);
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new THREE.MeshBasicNodeMaterial({ map: this.tex, transparent: true, depthTest, depthWrite: false, fog: false });
    mat.toneMapped = false;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    this.mesh.renderOrder = order;
    this.mesh.layers.set(LAYERS.FX);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.key = null;
  }

  /** Redraw when `key` changed: fn(ctx, width px, height px). */
  draw(key, fn) {
    if (key === this.key) return;
    this.key = key;
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    fn(c, W, H);
    this.tex.needsUpdate = true;
  }
}

const roundRect = (c, x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, w, h, r); };
const text = (c, s, x, y, size, color = '#fff', align = 'left', weight = 600) => {
  c.font = `${weight} ${size}px ${FONT}`;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
};
/** Text wrapped to `maxW`, at most `lines` lines; returns the height used. */
const wrapped = (c, s, x, y, maxW, size, color, lines = 3, align = 'center') => {
  c.font = `500 ${size}px ${FONT}`;
  const words = String(s).split(/\s+/), out = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (c.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  out.slice(0, lines).forEach((l, i) => text(c, l, x, y + i * size * 1.25, size, color, align, 500));
  return Math.min(out.length, lines) * size * 1.25;
};
const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export class VRUI {
  constructor(vr) {
    this.vr = vr;
    this.game = vr.game;
    const scene = vr.game.engine.scene;
    this.root = new THREE.Group();
    this.root.name = 'VRUI';
    scene.add(this.root);
    this.menu = new Panel(1.1, 0.8, 1100, { order: 30 });
    this.toast = new Panel(1.0, 0.42, 1000, { order: 25 });
    this.wrist = new Panel(0.11, 0.075, 440, { depthTest: true, order: 21 });
    this.ammo = new Panel(0.07, 0.035, 280, { depthTest: true, order: 21 });
    this.marker = new Panel(0.5, 0.32, 300, { order: 22 });
    for (const p of [this.menu, this.toast, this.wrist, this.ammo, this.marker]) this.root.add(p.mesh);
    this._pointer(scene);
    this._vignette(scene);
    this.items = []; // menu buttons: { label, y, h, fn }
    this.hover = -1;
    this.page = null;
    this.notes = [];
    this.banner = null;
    this.sub = null;
    this.prompt = null;
    this.objective = { title: '', text: '' };
    this.hurt = 0;
    this.toastPos = new THREE.Vector3();
    this.toastYaw = 0;
    this._t = 0;
  }

  get open() { return !!this.page; }

  // --- HUD events ----------------------------------------------------------------------------
  showBanner(title, sub = '', ms = 3500, cls = '') { this.banner = { title, sub, until: this._t + ms / 1000, red: cls === 'fail' }; }
  notify(t, ms = 3000) { this.notes.push({ text: strip(t), until: this._t + ms / 1000 }); if (this.notes.length > 3) this.notes.shift(); }
  subtitle(speaker, t, ms) { this.sub = { speaker, text: strip(t), until: this._t + ms / 1000 }; }
  setPrompt(t) { this.prompt = t ? strip(t.replace(/<kbd>[^<]*<\/kbd>/, '')) : null; }
  setObjective(title, t) { this.objective = { title: title ?? '', text: t ?? '' }; }
  hitMarker(kill) { this.vr.main.pulse(kill ? 0.6 : 0.25, kill ? 60 : 20); }
  onPlayerHurt(dmg) { this.hurt = Math.min(1, this.hurt + dmg / 30); }

  // --- menus ---------------------------------------------------------------------------------
  showMain() {
    const g = this.game;
    this._open('MINI CRY', [
      ...(g.hasSave() ? [['Continue', () => g.newGame({ fromCheckpoint: true })]] : []),
      ['New game', () => { try { localStorage.removeItem('minicry.save.v1'); } catch { /* */ } g.newGame(); }],
      ['Options', () => this.showOptions(() => this.showMain())],
      ['Exit VR', () => this.vr.exit()],
    ], 'Left stick move · right stick turn · grips climb / hold · trigger fire');
  }

  showPause() {
    const g = this.game, s = g.stats;
    this._open('PAUSE', [
      ['Resume', () => g.resume()],
      ['Load last checkpoint', () => g.loadCheckpoint()],
      ['Options', () => this.showOptions(() => this.showPause())],
      ['Exit VR', () => this.vr.exit()],
    ], `Kills ${s.kills} · Takedowns ${s.takedowns} · Outposts ${g.liberated.size}`);
  }

  showDeath() {
    const g = this.game;
    this._open('YOU DIED', [
      ['Restart from last checkpoint', () => (g.hasSave() ? g.loadCheckpoint() : location.reload())],
      ['Exit VR', () => this.vr.exit()],
    ], '', true);
  }

  showEnd(a = {}) {
    const g = this.game;
    this._open(a.title ?? 'THE END', [
      ['Keep exploring', () => { g.started = true; g.resume(); }],
      ['Exit VR', () => this.vr.exit()],
    ], a.text ?? 'Isla Sombra is free.');
  }

  showOptions(back) {
    const vr = this.vr, s = vr.settings, g = this.game;
    const set = (o) => { vr.saveSettings(o); this.showOptions(back); };
    this._open('OPTIONS', [
      [`Turn: ${s.turn === 'snap' ? `snap ${s.snapAngle}°` : 'smooth'}`, () => set(s.turn === 'smooth' ? { turn: 'snap', snapAngle: 30 } : s.snapAngle === 30 ? { snapAngle: 45 } : { turn: 'smooth' })],
      [`Comfort vignette: ${s.vignette ? 'on' : 'off'}`, () => set({ vignette: !s.vignette })],
      [`Walk toward: ${s.move === 'hand' ? 'the left hand' : 'the head'}`, () => set({ move: s.move === 'hand' ? 'head' : 'hand' })],
      [`Gun hand: ${s.hand}`, () => { vr.weapons.specs = {}; set({ hand: s.hand === 'left' ? 'right' : 'left' }); }],
      [`Seated mode: ${s.seated ? 'on' : 'off'}`, () => { if (!s.seated) { vr.settings.seated = true; vr.recenterHeight(); } else vr.saveSettings({ seated: false }); this.showOptions(back); }],
      [`Difficulty: ${g.settings.difficulty}`, () => { const d = ['facile', 'normal', 'difficile']; g.saveSettings({ difficulty: d[(d.indexOf(g.settings.difficulty) + 1) % 3] }); this.showOptions(back); }],
      [`Volume: ${Math.round(g.settings.volume * 100)} %`, () => { g.saveSettings({ volume: Math.round(((g.settings.volume + 0.2) % 1.2) * 10) / 10 }); this.showOptions(back); }],
      ['Back', back],
    ], s.seated ? 'Seated: sit straight, then toggle seated mode to measure the height again' : '');
  }

  _open(title, buttons, footer = '', red = false) {
    const vr = this.vr, head = vr.head;
    this.page = title;
    this.items = buttons.map(([label, fn]) => ({ label, fn }));
    this.hover = -1;
    this.menu.key = null;
    this._menuDraw = { title, footer, red };
    // in front of the head, at its height, facing it
    const yaw = head.yaw;
    this.menu.mesh.position.set(head.pos.x - Math.sin(yaw) * 1.3, head.pos.y - 0.1, head.pos.z - Math.cos(yaw) * 1.3);
    this.menu.mesh.rotation.set(0, yaw, 0);
    this.menu.mesh.updateMatrixWorld();
    this.menu.mesh.visible = true;
  }

  hide() {
    this.page = null;
    this.menu.mesh.visible = false;
    this.laser.visible = false;
  }

  _drawMenu() {
    const d = this._menuDraw, n = this.items.length;
    this.menu.draw(`${this.page}|${this.hover}|${this.items.map((i) => i.label).join('|')}|${d.footer}`, (c, W, H) => {
      roundRect(c, 4, 4, W - 8, H - 8, 36);
      c.fillStyle = 'rgba(12, 16, 14, 0.86)';
      c.fill();
      c.lineWidth = 4;
      c.strokeStyle = 'rgba(255, 196, 80, 0.5)';
      c.stroke();
      text(c, d.title, W / 2, 95, 78, d.red ? '#ff5a4a' : '#ffc450', 'center', 800);
      const top = 190, bh = Math.min(84, (H - top - 110) / n);
      this.items.forEach((it, i) => {
        it.y = top + i * bh; it.h = bh - 12;
        roundRect(c, 150, it.y, W - 300, it.h, 18);
        c.fillStyle = i === this.hover ? 'rgba(255, 196, 80, 0.92)' : 'rgba(255, 255, 255, 0.1)';
        c.fill();
        text(c, it.label, W / 2, it.y + it.h / 2, 40, i === this.hover ? '#111' : '#fff', 'center', 650);
      });
      if (d.footer) wrapped(c, d.footer, W / 2, H - 70, W - 120, 30, 'rgba(255,255,255,0.7)', 2);
    });
  }

  /** Laser pointers: the controller ray on the menu panel; the trigger clicks. */
  _point() {
    const m = this.menu.mesh, H = this.menu.canvas.height, W = this.menu.canvas.width;
    let hover = -1, from = null, hitP = null;
    for (const h of [this.vr.main, this.vr.off]) {
      if (!h.connected) continue;
      _p.setFromNormalAndCoplanarPoint(_v.set(0, 0, 1).applyQuaternion(m.quaternion), m.position);
      _r.set(h.rayPos, h.rayDir);
      const hit = _r.intersectPlane(_p, new THREE.Vector3());
      if (!hit || hit.distanceTo(h.rayPos) > 6) continue;
      const local = m.worldToLocal(hit.clone());
      const px = (local.x / this.menu.w + 0.5) * W, py = (0.5 - local.y / this.menu.h) * H;
      if (px < 0 || px > W || py < 0 || py > H) continue;
      const i = this.items.findIndex((it) => py >= it.y && py <= it.y + it.h && px > 150 && px < W - 150);
      if (!from || i >= 0 || h === this.lastHand) { from = h; hitP = hit; hover = i; }
      if (h.btn.trigger.hit) {
        this.lastHand = h;
        if (i >= 0) {
          h.pulse(0.3, 20);
          this.game.audio?.resume?.();
          this.game.audio?.play('ui_click', { volume: 0.4 });
          this.items[i].fn();
          return;
        }
      }
    }
    if (hover !== this.hover && hover >= 0) from?.pulse(0.1, 8);
    this.hover = hover;
    const l = this.laser;
    l.visible = !!from;
    if (from) {
      const len = hitP.distanceTo(from.rayPos);
      l.position.copy(from.rayPos);
      l.quaternion.setFromUnitVectors(_v.set(0, 0, -1), from.rayDir);
      l.scale.set(1, 1, len);
    }
  }

  _pointer(scene) {
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0xffc450, transparent: true, opacity: 0.8, depthWrite: false, fog: false });
    mat.toneMapped = false;
    this.laser = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 1).translate(0, 0, -0.5), mat);
    this.laser.layers.set(LAYERS.FX);
    this.laser.renderOrder = 31;
    this.laser.visible = false;
    scene.add(this.laser);
  }

  // --- vignette ------------------------------------------------------------------------------
  /** A ring around the line of sight, drawn only where it shows: black for comfort, red when hurt. */
  _vignette(scene) {
    const u = (this.vigU = { color: U(new THREE.Color(0, 0, 0)), amount: U(0), inner: U(0.2) });
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false });
    mat.toneMapped = false;
    mat.colorNode = Fn(() => {
      const r = length(positionLocal.xy);
      return vec4(u.color, smoothstep(u.inner, u.inner.add(0.12), r).mul(u.amount));
    })();
    this.vig = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.6, 48, 1), mat);
    this.vig.layers.set(LAYERS.FX);
    this.vig.renderOrder = 40;
    this.vig.frustumCulled = false;
    this.vig.visible = false;
    scene.add(this.vig);
  }

  // --- per frame -----------------------------------------------------------------------------
  update(dt) {
    const vr = this.vr, g = this.game, head = vr.head;
    this._t += dt || 0.014;
    const on = vr.presenting;
    this.root.visible = on;
    if (!on) return;
    if (this.page) { this._drawMenu(); this._point(); } else this.laser.visible = false;
    // a menu asked by the game (pause, death, end) while the panel shows something else
    if (g.started && g.paused && !this.page && g.player.alive) this.showPause();
    if (!g.paused && this.page === 'PAUSE') this.hide();
    const playing = g.started && !g.paused;
    this._toast(dt, playing);
    this._wrist(playing);
    this._ammo(playing);
    this._marker(playing);
    // vignette: comfort (view moved by the stick / turns) + hurt
    this.hurt = Math.max(0, this.hurt - dt * 1.5);
    const p = g.player, low = p.alive && p.health < 30 ? 0.25 * (1 - p.health / 30) : 0;
    const comfort = vr.settings.vignette && playing ? THREE.MathUtils.clamp((vr.locomotion.speed - 1) / 5, 0, 1) * 0.85 : 0;
    const red = Math.max(this.hurt * 0.7, low);
    const amount = Math.max(comfort, red);
    this._vig = (this._vig ?? 0) + (amount - (this._vig ?? 0)) * Math.min(1, dt * 10);
    this.vig.visible = this._vig > 0.02;
    if (this.vig.visible) {
      this.vigU.amount.value = this._vig;
      this.vigU.color.value.setRGB(red > comfort ? 0.5 : 0, 0, 0);
      this.vigU.inner.value = red > comfort ? 0.12 : THREE.MathUtils.lerp(0.22, 0.1, comfort);
      this.vig.position.copy(head.pos).addScaledVector(_v.set(0, 0, -1).applyQuaternion(head.quat), 0.2);
      this.vig.quaternion.copy(head.quat);
    }
  }

  /** Banner, notifications, subtitles, prompt: below the line of sight, following the head lazily. */
  _toast(dt, playing) {
    const head = this.vr.head, t = this._t;
    if (this.banner && t > this.banner.until) this.banner = null;
    if (this.sub && t > this.sub.until) this.sub = null;
    this.notes = this.notes.filter((n) => t < n.until);
    const b = this.banner, s = this.sub, pr = playing ? this.prompt : null;
    const show = !!(b || s || pr || this.notes.length);
    this.toast.mesh.visible = show && !this.page;
    if (!this.toast.mesh.visible) return;
    let dy = head.yaw - this.toastYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    if (Math.abs(dy) > 0.5 || !this._toastOn) this.toastYaw = head.yaw;
    else this.toastYaw += dy * Math.min(1, dt * 2.5);
    this._toastOn = true;
    const yaw = this.toastYaw;
    _v.set(head.pos.x - Math.sin(yaw) * 1.4, head.pos.y - 0.42, head.pos.z - Math.cos(yaw) * 1.4);
    this.toastPos.lerp(_v, this.toastPos.lengthSq() ? Math.min(1, dt * 6) : 1);
    const m = this.toast.mesh;
    m.position.copy(this.toastPos);
    m.lookAt(head.pos);
    const key = `${b?.title}|${b?.sub}|${s?.speaker}|${s?.text}|${pr}|${this.notes.map((n) => n.text).join('|')}`;
    this.toast.draw(key, (c, W, H) => {
      let y = 40;
      if (b) {
        text(c, b.title, W / 2, y + 20, 64, b.red ? '#ff5a4a' : '#ffc450', 'center', 800);
        y += 70;
        if (b.sub) { text(c, b.sub, W / 2, y + 10, 34, '#fff', 'center', 500); y += 50; }
      }
      for (const n of this.notes) { text(c, n.text, W / 2, y + 12, 30, '#e8f0e0', 'center', 600); y += 40; }
      if (pr) {
        c.font = `700 34px ${FONT}`;
        const tw = c.measureText(pr).width + 60;
        roundRect(c, W / 2 - tw / 2, y + 6, tw, 56, 28);
        c.fillStyle = 'rgba(0,0,0,0.55)';
        c.fill();
        text(c, pr, W / 2, y + 34, 34, '#fff', 'center', 700);
        y += 72;
      }
      if (s) {
        const lines = s.speaker ? `${s.speaker}: ${s.text}` : s.text;
        roundRect(c, 40, H - 150, W - 80, 136, 20);
        c.fillStyle = 'rgba(0,0,0,0.6)';
        c.fill();
        wrapped(c, lines, W / 2, H - 112, W - 140, 32, '#fff', 3);
      }
    });
  }

  /** The watch on the off-hand wrist (back of the wrist, facing up when the palm turns down). */
  _wrist(playing) {
    const vr = this.vr, h = vr.off, m = this.wrist.mesh, g = this.game, p = g.player;
    m.visible = playing && h.connected && !p.inVehicle;
    if (!m.visible) return;
    // grip frame: +X out of the back of the hand (right hand: to the right) -> the watch face
    const side = h === vr.hands.left ? -1 : 1;
    m.quaternion.copy(h.quat).multiply(_q.setFromEuler(_e.set(0, side * Math.PI / 2, side * Math.PI / 2)));
    m.position.copy(h.pos).add(_v.set(side * 0.04, 0.02, 0.12).applyQuaternion(h.quat));
    const W = g.weapons, d = g.missions?.markers()?.[0];
    const dist = d ? Math.round(Math.hypot(d.x - p.pos.x, d.z - p.pos.z)) : null;
    const key = `${Math.ceil(p.health)}|${Math.round(p.armor)}|${W.grenades}|${this.objective.title}|${this.objective.text}|${dist}`;
    this.wrist.draw(key, (c, Wd, H) => {
      roundRect(c, 4, 4, Wd - 8, H - 8, 26);
      c.fillStyle = 'rgba(10, 14, 12, 0.88)';
      c.fill();
      const bar = (y, v, col) => {
        roundRect(c, 24, y, Wd - 48, 22, 11); c.fillStyle = 'rgba(255,255,255,0.15)'; c.fill();
        roundRect(c, 24, y, Math.max(22, (Wd - 48) * v), 22, 11); c.fillStyle = col; c.fill();
      };
      text(c, `${Math.ceil(p.health)}`, 24, 42, 42, '#fff', 'left', 800);
      text(c, `💣 ${W.grenades}`, Wd - 24, 42, 34, '#fff', 'right', 700);
      bar(74, p.health / p.maxHealth, p.health < 30 ? '#ff5a4a' : '#7ed957');
      bar(104, p.armor / p.cfg.maxArmor, '#5ab4ff');
      const o = this.objective;
      if (o.title || o.text) wrapped(c, o.text || o.title, 24, 160, Wd - 48, 26, '#ffc450', 3, 'left');
      if (dist !== null) text(c, `${dist} m`, Wd - 24, H - 28, 28, '#fff', 'right', 700);
    });
  }

  /** Rounds in the gun / in reserve, on the gun's back end. */
  _ammo(playing) {
    const W = this.game.weapons, w = W.current, V = this.vr.weapons, m = this.ammo.mesh;
    m.visible = playing && !!w && w.type !== 'melee' && V.gun.visible;
    if (!m.visible) return;
    const s = V._spec(W.currentId);
    m.position.copy(V.gun.localToWorld(_v.set(0, s.sight.y + 0.035, s.fist.z + 0.03)));
    m.quaternion.copy(V.gun.quaternion);
    const clip = W.clip[W.currentId] ?? 0, res = W.ammo[w.ammo] ?? 0;
    this.ammo.draw(`${clip}|${res}`, (c, Wd, H) => {
      roundRect(c, 2, 2, Wd - 4, H - 4, 18);
      c.fillStyle = 'rgba(0,0,0,0.6)';
      c.fill();
      text(c, `${clip}`, Wd / 2 - 10, H / 2 + 2, 84, clip === 0 ? '#ff5a4a' : '#fff', 'right', 800);
      text(c, `/ ${res}`, Wd / 2, H / 2 + 6, 46, 'rgba(255,255,255,0.75)', 'left', 600);
    });
  }

  /** The objective marker over its target, about the same size whatever the distance. */
  _marker(playing) {
    const g = this.game, p = g.player, m = this.marker.mesh, d = playing ? g.missions?.markers()?.[0] : null;
    const dist = d ? Math.hypot(d.x - p.pos.x, d.z - p.pos.z) : 0;
    m.visible = !!d && dist > 6;
    if (!m.visible) return;
    const head = this.vr.head;
    _v.set(d.x, d.y + 2, d.z).sub(head.pos);
    const far = _v.length();
    // drawn at 20 m at most (far ones would be clipped / tiny), scaled to keep their angular size
    const at = Math.min(far, 20);
    m.position.copy(head.pos).addScaledVector(_v.normalize(), at);
    m.scale.setScalar(at / 10);
    m.lookAt(head.pos);
    const key = `${Math.round(dist)}`;
    this.marker.draw(key, (c, W, H) => {
      c.save();
      c.translate(W / 2, 70);
      c.rotate(Math.PI / 4);
      c.fillStyle = '#ffc450';
      c.fillRect(-36, -36, 72, 72);
      c.restore();
      text(c, `${Math.round(dist)} m`, W / 2, 160, 52, '#fff', 'center', 800);
    });
  }
}

const _e = new THREE.Euler();
