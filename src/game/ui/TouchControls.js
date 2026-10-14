// Touch controls for phones / tablets (landscape, full screen): a floating move stick on the left
// half, drag anywhere on the right half to look, buttons for the main actions. They drive the same
// Input as the keyboard: analog move axes (Input.moveX / moveY), mouse-look deltas and virtual
// 'Touch:<action>' keys (Input.setVirtual). The pointer is treated as always locked on touch devices.
// ?mobile=1 forces the mobile mode on a desktop (headless shots), ?mobile=0 turns it off.

/** Touch-first device (coarse primary pointer, no hover), or forced with ?mobile=1 / off with ?mobile=0. */
export function isMobile(params = new URLSearchParams(location.search)) {
  const f = params.get('mobile');
  if (f !== null) return f !== '0';
  return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches;
}

const LOOK_SCALE = 1.7; // touch px -> mouse px (a 1/3 screen swipe ≈ 1 radian at the default sensitivity)
const STICK_R = 56; // stick travel radius (px)
const SPRINT_AT = 0.92; // stick tilt (mostly forward) that sprints

const h = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

// keeps a touch's events on the control it started on (synthetic test events have no active pointer)
const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* */ } };

/** Full screen + landscape lock (both need a user gesture; iOS Safari has neither on iPhone: no-op). */
export function enterFullscreen() {
  const d = document, el = d.documentElement;
  if (d.fullscreenElement || d.webkitFullscreenElement) return;
  const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
  try {
    Promise.resolve(req?.({ navigationUI: 'hide' }))
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {});
  } catch { /* not allowed */ }
}

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.input = game.input;
    this.input.forceLocked = true; // no pointer lock on touch screens: look / buttons always active
    document.body.classList.add('mobile');
    const root = (this.root = h('div', 'touch', document.body));
    this.moveZone = h('div', 'tc-zone tc-move', root);
    this.lookZone = h('div', 'tc-zone tc-look', root);
    this.stick = h('div', 'tc-stick', root, '<i></i>');
    this.knob = this.stick.firstChild;
    this.buttons = {};
    // [action, label, class, kind]: hold = down while touched, tap = one press, toggle = on / off
    const defs = [
      ['fire', 'FIRE', 'b-fire', 'hold'],
      ['aim', 'AIM', 'b-aim', 'toggle'],
      ['jump', 'JUMP', 'b-jump', 'hold'],
      ['crouch', 'CROUCH', 'b-crouch', 'toggle'],
      ['reload', 'R', 'b-reload', 'tap'],
      ['nextWeapon', '⇄', 'b-swap', 'tap'],
      ['grenade', 'G', 'b-grenade', 'tap'],
      ['melee', 'V', 'b-melee', 'tap'],
      ['use', 'USE', 'b-use', 'tap'],
      ['binoculars', '◎', 'b-bino', 'tap'],
      ['map', 'MAP', 'b-map', 'tap'],
      ['pause', 'II', 'b-pause', 'tap'],
    ];
    for (const [action, label, cls, kind] of defs) {
      const b = h('div', `tc-btn ${cls}`, root, label);
      b.dataset.action = action;
      this.buttons[action] = { el: b, kind, on: false };
      this._bindButton(b, action, kind);
    }
    this._move = null; // { id, x0, y0 }
    this._looks = new Map(); // pointer id -> last { x, y }
    this._bindMove();
    this._bindLook(this.lookZone);
    // rotate prompt (portrait)
    h('div', 'rotate-hint', document.body, '<div class="ph">📱</div><div>Turn your phone sideways to play</div>');
    // full screen on the first taps (each tap retries until it sticks: menus, game)
    document.addEventListener('touchend', () => enterFullscreen(), { passive: true });
    document.addEventListener('click', () => enterFullscreen());
    // no page scroll / zoom / long-press menu while playing
    for (const ev of ['touchmove', 'gesturestart']) document.addEventListener(ev, (e) => { if (!e.target.closest?.('.menus select, .menus input, .menu-panel')) e.preventDefault(); }, { passive: false });
    addEventListener('contextmenu', (e) => e.preventDefault());
    this._visible = null;
    const tick = () => { this._update(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  _bindButton(b, action, kind) {
    const inp = this.input, st = this.buttons[action];
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      capture(b, e.pointerId);
      if (action === 'pause') { this.game.pause(); return; }
      if (action === 'map') { this.game.menus.toggleMap(); return; }
      if (kind === 'toggle') { st.on = !st.on; inp.setVirtual(action, st.on); b.classList.toggle('on', st.on); return; }
      inp.setVirtual(action, true);
      b.classList.add('on');
      if (action === 'fire') this._looks.set(e.pointerId, { x: e.clientX, y: e.clientY }); // drag the fire button to aim
    });
    const up = (e) => {
      if (kind === 'toggle' || action === 'pause' || action === 'map') return;
      inp.setVirtual(action, false);
      b.classList.remove('on');
      this._looks.delete(e.pointerId);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    if (action === 'fire') b.addEventListener('pointermove', (e) => this._lookMove(e));
  }

  _bindMove() {
    const z = this.moveZone, inp = this.input;
    z.addEventListener('pointerdown', (e) => {
      if (this._move) return;
      e.preventDefault();
      capture(z, e.pointerId);
      this._move = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.stick.classList.add('active');
    });
    z.addEventListener('pointermove', (e) => {
      const m = this._move;
      if (!m || m.id !== e.pointerId) return;
      let dx = e.clientX - m.x0, dy = e.clientY - m.y0;
      const d = Math.hypot(dx, dy);
      if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const x = dx / STICK_R, y = -dy / STICK_R;
      const t = Math.hypot(x, y), dz = 0.12; // dead zone, then rescaled to 0..1
      const k = t > dz ? (t - dz) / (1 - dz) / t : 0;
      inp.moveX = x * k;
      inp.moveY = y * k;
      inp.setVirtual('sprint', t >= SPRINT_AT && y > 0.75);
    });
    const end = (e) => {
      if (!this._move || this._move.id !== e.pointerId) return;
      this._releaseMove();
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  }

  _releaseMove() {
    this._move = null;
    this.input.moveX = this.input.moveY = 0;
    this.input.setVirtual('sprint', false);
    this.knob.style.transform = '';
    this.stick.classList.remove('active');
    this.stick.style.left = this.stick.style.top = '';
  }

  _bindLook(z) {
    z.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(z, e.pointerId);
      this._looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    z.addEventListener('pointermove', (e) => this._lookMove(e));
    const end = (e) => this._looks.delete(e.pointerId);
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  }

  _lookMove(e) {
    const l = this._looks.get(e.pointerId);
    if (!l) return;
    this.input.mouseDX += (e.clientX - l.x) * LOOK_SCALE;
    this.input.mouseDY += (e.clientY - l.y) * LOOK_SCALE;
    l.x = e.clientX; l.y = e.clientY;
  }

  /** Releases every held control (pause, menus, death). */
  reset() {
    this._releaseMove();
    this._looks.clear();
    for (const [action, st] of Object.entries(this.buttons)) {
      if (st.kind === 'toggle' && st.on) { st.on = false; st.el.classList.remove('on'); }
      this.input.setVirtual(action, false);
      if (st.kind !== 'toggle') st.el.classList.remove('on');
    }
  }

  _update() {
    const g = this.game;
    const visible = !!(g.started && !g.paused && g.player?.alive);
    if (visible !== this._visible) {
      this._visible = visible;
      this.root.classList.toggle('show', visible);
      if (!visible) this.reset();
    }
    if (!visible) return;
    this.root.classList.toggle('map-open', !!g.menus?.mapOpen);
    const inVehicle = !!g.player.inVehicle;
    this.root.classList.toggle('vehicle', inVehicle);
    this.buttons.jump.el.textContent = inVehicle ? 'BRAKE' : 'JUMP';
    this.buttons.use.el.classList.toggle('hint', !!g.hud?._last?.prompt);
    this.buttons.binoculars.el.hidden = !(g.inventory?.has('binoculars') || g.params?.has('cheats'));
  }
}
