// In-game HUD (DOM). Everything is created once; per-frame updates only touch styles / text that
// changed. Far Cry style: compass with markers, minimap, detection arrows around the crosshair,
// damage direction arcs, objective panel, radio subtitles, banners, interaction prompt.
// VR: the events are forwarded to the in-headset panels (game.vr.ui, vr/VRUI.js).
import * as THREE from 'three';

const el = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};
const _v = new THREE.Vector3();

export class HUD {
  constructor(game) {
    this.game = game;
    const root = (this.root = el('div', 'hud', document.body));
    // vignettes / overlays
    this.hurtEl = el('div', 'hud-hurt', root);
    this.waterEl = el('div', 'hud-water', root);
    this.scopeEl = el('div', 'hud-scope', root, '<div class="ring"></div><div class="h"></div><div class="v"></div>');
    this.binoEl = el('div', 'hud-bino', root, '<div class="lens l"></div><div class="lens r"></div><div class="bino-info"></div>');
    // crosshair + hit marker + detection arrows + damage arcs
    this.cross = el('div', 'hud-cross', root, '<i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="dot"></i>');
    this.hit = el('div', 'hud-hit', root, '<i></i><i></i><i></i><i></i>');
    this.arrows = el('div', 'hud-arrows', root);
    this.dmg = el('div', 'hud-dmg', root);
    // compass
    this.compass = el('div', 'hud-compass', root);
    this.compassStrip = el('div', 'strip', this.compass);
    for (let d = -360; d <= 720; d += 15) {
      const t = el('span', d % 90 === 0 ? 'card' : d % 45 === 0 ? 'mid' : 'tick', this.compassStrip, d % 90 === 0 ? ['N', 'E', 'S', 'W'][(((d / 90) % 4) + 4) % 4] : d % 45 === 0 ? ['NE', 'SE', 'SW', 'NW'][((((d - 45) / 90) % 4) + 4) % 4] : '');
      t.style.left = `${(d + 360) * 4}px`;
    }
    this.compassMarks = el('div', 'marks', this.compass);
    // objective panel
    this.obj = el('div', 'hud-obj', root, '<div class="mt"></div><div class="ot"></div><div class="od"></div>');
    // minimap
    this.mini = el('div', 'hud-mini', root);
    this.miniCanvas = el('canvas', '', this.mini);
    this.miniCanvas.width = this.miniCanvas.height = 180;
    el('div', 'mini-player', this.mini);
    // vitals
    this.vitals = el('div', 'hud-vitals', root, '<div class="bar hp"><i></i><span></span></div><div class="bar ar"><i></i></div><div class="bar st"><i></i></div><div class="bar br"><i></i></div>');
    // weapon
    this.weap = el('div', 'hud-weapon', root, '<div class="wn"></div><div class="wa"><b></b><span></span></div><div class="wg"></div>');
    // subtitles, banners, prompts, notifications
    this.subs = el('div', 'hud-subs', root);
    this.banner = el('div', 'hud-banner', root, '<div class="b1"></div><div class="b2"></div>');
    this.prompt = el('div', 'hud-prompt', root);
    this.notes = el('div', 'hud-notes', root);
    this.alertEl = el('div', 'hud-alert', root);
    this.grenadeEl = el('div', 'hud-grenade', root, '⚠');
    this.vehicleEl = el('div', 'hud-vehicle', root);
    this.noseEl = el('div', 'hud-nose', root); // plane: where the nose points (the crosshair = where to go)
    this.worldMarks = el('div', 'hud-wmarks', root);
    this.wmItems = new Map();
    this.hurts = [];
    this.detections = new Map();
    this.compassItems = new Map();
    this._last = {};
    this.visible = true;
  }

  setVisible(v) { this.visible = v; this.root.style.display = v ? '' : 'none'; }

  // --- minimap -----------------------------------------------------------------------------
  buildMapImage(size) {
    const T = this.game.world.terrain;
    size ??= Math.min(2048, Math.round(T.size * 0.375)); // ~2.7 m a pixel (the minimap's zoom)
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const col = new Float32Array(3), n = { x: 0, y: 1, z: 0 };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const wx = T.x0 + (x + 0.5) / size * T.size, wz = T.z0 + (y + 0.5) / size * T.size;
      const i = Math.round(T.gx(wx)), j = Math.round(T.gz(wz));
      T.vertexColor(Math.min(T.res - 1, i), Math.min(T.res - 1, j), col, 0);
      let r = Math.sqrt(col[0]), g = Math.sqrt(col[1]), b = Math.sqrt(col[2]);
      T.normalAt(wx, wz, n);
      const sh = Math.max(0.4, Math.min(1.25, 0.75 + (-n.x * 0.6 - n.z * 0.6 + n.y * 0.3) * 0.9));
      r *= sh; g *= sh; b *= sh;
      const h = T.heightAt(wx, wz), wl = T.waterLevelAt(wx, wz);
      if (h < wl) { const d = Math.min(1, (wl - h) / 18), a = 0.6 + d * 0.35; r = r * (1 - a) + (0.22 - d * 0.18) * a; g = g * (1 - a) + (0.72 - d * 0.42) * a; b = b * (1 - a) + (0.78 - d * 0.25) * a; }
      const o = (y * size + x) * 4;
      img.data[o] = r * 255; img.data[o + 1] = g * 255; img.data[o + 2] = b * 255; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // roads overlay is already in the terrain colours (painted dirt)
    this.mapImage = c;
    return c;
  }

  _drawMini() {
    const g = this.game, p = g.player, T = g.world.terrain;
    if (!this.mapImage) return;
    const ctx = this.miniCanvas.getContext('2d');
    const S = 180, range = 160; // metres shown across
    const scale = this.mapImage.width / T.size;
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ctx.clip();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(p.yaw);
    const k = S / range;
    ctx.scale(k / scale, k / scale);
    ctx.drawImage(this.mapImage, -(p.pos.x - T.x0) * scale, -(p.pos.z - T.z0) * scale);
    ctx.restore();
    // markers (rotated into view space)
    const toMini = (x, z) => {
      const dx = (x - p.pos.x) * k, dz = (z - p.pos.z) * k;
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      return [S / 2 + dx * c - dz * s, S / 2 + dx * s + dz * c];
    };
    for (const a of g.actors.list) {
      if (!a.alive || a.team === 'player') continue;
      const known = a.tagged || a.ai?.state === 'combat' || a.team === 'civilian' || a.team === 'ally';
      if (!known) continue;
      const [x, y] = toMini(a.pos.x, a.pos.z);
      if (Math.hypot(x - S / 2, y - S / 2) > S / 2 - 3) continue;
      ctx.fillStyle = a.team === 'civilian' || a.team === 'ally' ? '#7fd0ff' : a.ai?.state === 'combat' ? '#ff3b30' : '#ffb020';
      ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
    }
    for (const m of g.missions?.markers() ?? []) {
      let [x, y] = toMini(m.x, m.z);
      const d = Math.hypot(x - S / 2, y - S / 2);
      if (d > S / 2 - 6) { x = S / 2 + (x - S / 2) / d * (S / 2 - 6); y = S / 2 + (y - S / 2) / d * (S / 2 - 6); }
      ctx.fillStyle = '#ffd34d'; ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }

  // --- events ------------------------------------------------------------------------------
  hitMarker(kill, head) {
    this.game.vr?.ui.hitMarker(kill, head);
    this.hit.className = 'hud-hit';
    void this.hit.offsetWidth;
    this.hit.className = 'hud-hit show' + (kill ? ' kill' : '') + (head ? ' head' : '');
    this.game.audio?.play(kill ? 'kill_confirm' : 'hit_marker', { volume: 0.35 });
  }

  onPlayerHurt(dmg, from) {
    this.game.vr?.ui.onPlayerHurt(dmg, from);
    this._hurtFlash = Math.min(1, (this._hurtFlash ?? 0) + dmg / 30);
    if (!from) return;
    const arc = el('div', 'arc', this.dmg);
    arc.dataset.x = from.x; arc.dataset.z = from.z;
    arc.dataset.t = performance.now();
    this.hurts.push(arc);
    if (this.hurts.length > 6) this.hurts.shift().remove();
  }

  detection(actor, level, state) {
    let d = this.detections.get(actor);
    if (level < 0.05 && state !== 'combat') { if (d) { d.el.remove(); this.detections.delete(actor); } return; }
    if (!d) { d = { el: el('div', 'arrow', this.arrows, '<i></i>') }; this.detections.set(actor, d); }
    d.level = level; d.state = state;
  }

  onEnemyAlert() {
    this.alertEl.textContent = 'SPOTTED!';
    this.alertEl.className = 'hud-alert show';
    clearTimeout(this._alertT);
    this._alertT = setTimeout(() => (this.alertEl.className = 'hud-alert'), 1600);
  }

  grenadeWarning() {
    this.grenadeEl.classList.add('show');
    clearTimeout(this._grT);
    this._grT = setTimeout(() => this.grenadeEl.classList.remove('show'), 2500);
  }

  showBanner(title, sub = '', ms = 3500, cls = '') {
    this.game.vr?.ui.showBanner(title, sub, ms, cls);
    this.banner.className = 'hud-banner show ' + cls;
    this.banner.querySelector('.b1').textContent = title;
    this.banner.querySelector('.b2').textContent = sub;
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => (this.banner.className = 'hud-banner'), ms);
  }

  notify(text, ms = 3000) {
    this.game.vr?.ui.notify(text, ms);
    const n = el('div', 'note', this.notes, text);
    setTimeout(() => n.classList.add('out'), ms);
    setTimeout(() => n.remove(), ms + 600);
  }

  subtitle(speaker, text, ms) {
    this.game.vr?.ui.subtitle(speaker, text, ms);
    this.subs.innerHTML = speaker ? `<b>${speaker}:</b> ${text}` : text;
    this.subs.classList.add('show');
    clearTimeout(this._subT);
    this._subT = setTimeout(() => this.subs.classList.remove('show'), ms);
  }

  setPrompt(text) {
    if (this._last.prompt === text) return;
    this._last.prompt = text;
    this.game.vr?.ui.setPrompt(text);
    this.prompt.innerHTML = text ?? '';
    this.prompt.style.opacity = text ? 1 : 0;
  }

  refreshWeapon() {
    const w = this.game.weapons;
    const cur = w.current;
    const name = this.weap.querySelector('.wn'), b = this.weap.querySelector('.wa b'), s = this.weap.querySelector('.wa span');
    name.textContent = cur?.label ?? '';
    if (!cur || cur.type === 'melee') { b.textContent = ''; s.textContent = ''; }
    else { b.textContent = w.clip[w.currentId] ?? 0; s.textContent = ` / ${w.ammo[cur.ammo] ?? 0}`; }
    this.weap.querySelector('.wg').textContent = w.grenades > 0 ? `💣 × ${w.grenades}` : '';
  }

  setObjective(title, text) {
    this.game.vr?.ui.setObjective(title, text);
    this.obj.querySelector('.mt').textContent = title ?? '';
    this.obj.querySelector('.ot').textContent = text ?? '';
    this.obj.style.opacity = title || text ? 1 : 0;
  }

  // --- per frame ---------------------------------------------------------------------------
  update(dt) {
    if (!this.visible) return;
    const g = this.game, p = g.player, cam = g.engine.camera, w = g.weapons;
    // vitals
    const hp = p.health / p.maxHealth;
    this._bar('hp', hp, `${Math.ceil(p.health)}`);
    this._bar('ar', p.armor / p.cfg.maxArmor);
    this._bar('st', p.stamina, null, p.stamina > 0.98);
    this._bar('br', p.breath, null, p.breath > 0.98);
    // hurt vignette (+ low health pulse)
    this._hurtFlash = Math.max(0, (this._hurtFlash ?? 0) - dt * 1.5);
    const low = hp < 0.3 ? (0.35 + 0.25 * Math.sin(performance.now() / 180)) * (1 - hp / 0.3) : 0;
    this._style(this.hurtEl, 'opacity', Math.min(1, this._hurtFlash * 0.8 + low).toFixed(2));
    this._style(this.waterEl, 'opacity', p.underwater ? '1' : '0');
    // crosshair spread
    const ads = w.adsBlend;
    const cur = w.current;
    const gap = cur && cur.type !== 'melee' ? 6 + w._spreadDeg(cur) * 6 : 4;
    this._style(this.cross, '--gap', `${gap.toFixed(1)}px`);
    this._style(this.cross, 'opacity', ads > 0.6 || !p.alive || g.binoculars?.active ? '0' : '1');
    this._style(this.scopeEl, 'opacity', cur?.scope && ads > 0.85 ? '1' : '0');
    this._style(this.binoEl, 'opacity', g.binoculars?.active ? '1' : '0');
    // compass
    const yawDeg = ((-p.yaw * 180) / Math.PI % 360 + 360) % 360; // 0 = north (-z), clockwise
    this._style(this.compassStrip, 'transform', `translateX(${(-(yawDeg + 360) * 4 + 210).toFixed(1)}px)`);
    this._compassMarkers(yawDeg);
    // objective distance
    const mk = g.missions?.markers()?.[0];
    const od = this.obj.querySelector('.od');
    const dtxt = mk ? `${Math.round(Math.hypot(mk.x - p.pos.x, mk.z - p.pos.z))} m` : '';
    if (this._last.od !== dtxt) { od.textContent = dtxt; this._last.od = dtxt; }
    // detection arrows around the crosshair
    const fwdYaw = p.yaw;
    for (const [actor, d] of this.detections) {
      if (!actor.alive) { d.el.remove(); this.detections.delete(actor); continue; }
      const ang = Math.atan2(actor.pos.x - p.pos.x, actor.pos.z - p.pos.z); // 0 = +z
      const rel = -(ang - (fwdYaw + Math.PI)); // screen angle, 0 = up
      const col = d.state === 'combat' ? '#ff3b30' : d.level > 0.35 ? '#ffb020' : '#ffffff';
      d.el.style.transform = `rotate(${rel}rad) translateY(-70px)`;
      d.el.style.setProperty('--fill', `${Math.round(d.level * 100)}%`);
      d.el.style.setProperty('--col', col);
    }
    // damage arcs
    const now = performance.now();
    for (let i = this.hurts.length - 1; i >= 0; i--) {
      const a = this.hurts[i];
      const age = (now - a.dataset.t) / 1000;
      if (age > 1.6) { a.remove(); this.hurts.splice(i, 1); continue; }
      const ang = Math.atan2(+a.dataset.x - p.pos.x, +a.dataset.z - p.pos.z);
      const rel = -(ang - (fwdYaw + Math.PI));
      a.style.transform = `rotate(${rel}rad) translateY(-120px)`;
      a.style.opacity = (1 - age / 1.6).toFixed(2);
    }
    this._worldMarkers();
    // minimap at 15 Hz
    this._miniT = (this._miniT ?? 0) - dt;
    if (this._miniT <= 0) { this._miniT = 1 / 15; this._drawMini(); }
    // vehicle
    const veh = p.inVehicle;
    this._style(this.vehicleEl, 'opacity', veh ? '1' : '0');
    const plane = veh?.kind === 'plane';
    if (veh) {
      const kmh = `${Math.round(Math.abs(veh.speed ?? 0) * 3.6)} km/h`;
      const t = plane ? `${kmh}   ALT ${Math.round(veh.pos.y)} m   PWR ${Math.round(veh.power * 100)}%` : kmh;
      if (this._last.veh !== t) { this.vehicleEl.textContent = t; this._last.veh = t; }
    }
    this._style(this.noseEl, 'opacity', plane ? '1' : '0');
    if (plane) {
      _v.set(0, 0, -300).applyQuaternion(veh.object.quaternion).add(veh.pos).project(cam);
      const x = (_v.x * 0.5 + 0.5) * innerWidth, y = (-_v.y * 0.5 + 0.5) * innerHeight;
      this._style(this.noseEl, 'transform', _v.z < 1 ? `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)` : 'translate(-99px, -99px)');
    }
    void cam;
  }

  /** Objective diamonds projected on screen (clamped to the edges), with the distance. */
  _worldMarkers() {
    const g = this.game, cam = g.engine.camera, p = g.player;
    const seen = new Set();
    const W = innerWidth, H = innerHeight;
    for (const m of g.missions?.markers() ?? []) {
      seen.add(m.id);
      let e = this.wmItems.get(m.id);
      if (!e) { e = el('div', 'wm', this.worldMarks, '<i></i><span></span>'); this.wmItems.set(m.id, e); }
      _v.set(m.x, m.y + 1.6, m.z).project(cam);
      const behind = _v.z > 1;
      let x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
      if (behind) { x = W - x; y = H - 40; }
      x = Math.max(30, Math.min(W - 30, x)); y = Math.max(60, Math.min(H - 60, y));
      const d = Math.round(Math.hypot(m.x - p.pos.x, m.z - p.pos.z));
      e.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
      const t = d > 2 ? `${d} m` : '';
      if (e._t !== t) { e.lastChild.textContent = t; e._t = t; }
      e.style.opacity = d < 4 ? '0' : '1';
    }
    for (const [k, e] of this.wmItems) if (!seen.has(k)) { e.remove(); this.wmItems.delete(k); }
  }

  _compassMarkers(yawDeg) {
    const g = this.game, p = g.player;
    const items = [];
    for (const m of g.missions?.markers() ?? []) items.push({ key: 'obj' + m.id, x: m.x, z: m.z, cls: 'obj' });
    for (const a of g.actors.list) if (a.alive && (a.tagged || a.ai?.state === 'combat') && a.team === 'merc' && a.pos.distanceTo(p.pos) < 150) items.push({ key: a.id, x: a.pos.x, z: a.pos.z, cls: a.ai?.state === 'combat' ? 'enemy alert' : 'enemy' });
    const seen = new Set();
    for (const it of items) {
      seen.add(it.key);
      let e = this.compassItems.get(it.key);
      if (!e) { e = el('i', 'cm ' + it.cls, this.compassMarks); this.compassItems.set(it.key, e); }
      const bearing = (Math.atan2(it.x - p.pos.x, -(it.z - p.pos.z)) * 180) / Math.PI; // 0 = north, clockwise
      let rel = ((bearing - yawDeg + 540) % 360) - 180;
      const vis = Math.abs(rel) < 52;
      e.style.opacity = vis ? 1 : 0;
      e.style.transform = `translateX(${(210 + rel * 4).toFixed(1)}px)`;
      if (e.className !== 'cm ' + it.cls) e.className = 'cm ' + it.cls;
    }
    for (const [k, e] of this.compassItems) if (!seen.has(k)) { e.remove(); this.compassItems.delete(k); }
  }

  _bar(name, v, text, hide) {
    const b = this.vitals.querySelector('.' + name);
    const pct = `${Math.max(0, Math.min(1, v)) * 100}%`;
    if (this._last[name] !== pct) { b.firstChild.style.width = pct; this._last[name] = pct; }
    if (text !== undefined && text !== null && this._last[name + 't'] !== text) { b.querySelector('span').textContent = text; this._last[name + 't'] = text; }
    const op = hide ? '0' : '1';
    if (this._last[name + 'o'] !== op) { b.style.opacity = op; this._last[name + 'o'] = op; }
  }

  _style(e, prop, val) {
    const k = '__' + prop;
    if (e[k] === val) return;
    e[k] = val;
    if (prop.startsWith('--')) e.style.setProperty(prop, val); else e.style[prop] = val;
  }

  dispose() { this.root.remove(); }
}
void _v;
