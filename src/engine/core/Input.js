// Keyboard / mouse / gamepad input with action bindings (KeyboardEvent.code = physical keys, so
// ZQSD on AZERTY maps to the same actions as WASD), pointer lock and per-frame edge detection.
// Call poll() at the start of each frame (gamepad) and endFrame() after the game read its input.
//
// Gamepad: the first connected pad (standard mapping: Xbox / PlayStation layout) is detected on
// its own. Its buttons press 'Pad:<button>' codes bound to actions like keys, the left stick drives
// move(), the right stick look(). The last device used is `device` ('kbm' | 'pad'): with the pad
// no pointer lock is needed (`active`), prompts show its buttons (label()), body gets `.gamepad`.
export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space', 'Pad:A'],
  sprint: ['ShiftLeft', 'ShiftRight', 'Pad:Sprint'], // pad: click the left stick, sprints until it is released
  crouch: ['ControlLeft', 'KeyC', 'Pad:Crouch'], // pad: B toggles
  fire: ['Mouse0', 'KeyT', 'Pad:RT'],
  aim: ['Mouse2', 'Pad:LT'],
  reload: ['KeyR', 'Pad:X'],
  use: ['KeyE', 'Pad:X'], // pad: X uses when a prompt shows, else reloads (Weapons)
  grenade: ['KeyG', 'Pad:LB'],
  melee: ['KeyV', 'Mouse3', 'Pad:RB', 'Pad:RS'],
  weapon1: ['Digit1'], weapon2: ['Digit2'], weapon3: ['Digit3'], weapon4: ['Digit4'], weapon5: ['Digit5'], weapon6: ['Digit6'],
  nextWeapon: ['WheelDown', 'KeyQ', 'Pad:Y', 'Pad:Right'], // KeyQ = A on AZERTY
  prevWeapon: ['WheelUp', 'Pad:Left'],
  binoculars: ['KeyB', 'Pad:Up'],
  map: ['KeyM', 'Tab', 'Pad:Back'],
  flashlight: ['KeyF', 'Pad:Down'],
  camera: ['KeyH'],
  pause: ['Escape', 'KeyP', 'Pad:Start'],
};

// standard mapping button order; LT / RT are analog (pressed past TRIGGER_ON)
const PAD_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right'];
const PAD_LABELS = {
  xbox: { Back: 'View', Start: 'Menu', LS: 'L3', RS: 'R3', Up: '▲', Down: '▼', Left: '◀', Right: '▶', Sprint: 'L3', Crouch: 'B' },
  ps: { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', Back: 'Share', Start: 'Options', LS: 'L3', RS: 'R3', Up: '▲', Down: '▼', Left: '◀', Right: '▶', Sprint: 'L3', Crouch: '○' },
};
const KEY_LABELS = { Mouse0: 'Click', Mouse2: 'Right-click', Mouse3: 'Mouse 4', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', Escape: 'Esc', WheelDown: 'Wheel', WheelUp: 'Wheel' };
const STICK_DEAD = 0.15; // radial dead zone
const TRIGGER_ON = 0.35;
const LOOK_YAW = 3.2, LOOK_PITCH = 2.2; // right stick fully pushed, rad/s at sensitivity 1
const TURN_BOOST = 1.8; // yaw x this after holding the stick at the edge for a moment (turning around)

export class Input {
  constructor(target, bindings = DEFAULT_BINDINGS) {
    this.target = target;
    this.bindings = structuredClone(bindings);
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    // analog move axes from a virtual stick (touch controls), -1..1: x = right, y = forward
    this.moveX = 0;
    this.moveY = 0;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.enabled = true;
    this.requireLock = true; // ignore mouse buttons unless the pointer is locked
    this.forceLocked = new URLSearchParams(location.search).has('bot'); // automated play tests
    // gamepad
    this.device = 'kbm';
    this.onDevice = new Set(); // callbacks (device) when the device in use changes
    this.pad = null; // the polled Gamepad, null if none
    this.padLayout = 'xbox';
    this.padX = this.padY = 0; // left stick after the dead zone: x = right, y = forward
    this.padLT = this.padRT = 0; // triggers 0..1
    this.padSensitivity = 1;
    this.nav = { x: 0, y: 0 }; // menu navigation this frame (D-pad / left stick: one step, then auto-repeat)
    this._padLook = { yaw: 0, pitch: 0 };
    this._padT = 0;
    this._edgeT = 0;
    this._nav = { x: 0, y: 0, t: 0 };
    this._padPrev = new Uint8Array(PAD_BUTTONS.length); // raw button states: a button held through clear() is no new press
    const kd = (e) => {
      if (!this.enabled || e.repeat) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      this._setDevice('kbm');
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow') || (this.locked && e.code.startsWith('Control'))) e.preventDefault();
    };
    const ku = (e) => { this.keys.delete(e.code); this.released.add(e.code); };
    const md = (e) => {
      this._setDevice('kbm');
      if (!this.enabled || (this.requireLock && !this.locked)) return;
      const c = 'Mouse' + e.button;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
    };
    const mu = (e) => { const c = 'Mouse' + e.button; this.keys.delete(c); this.released.add(c); };
    const mm = (e) => {
      if (!this.locked) return;
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 3) this._setDevice('kbm');
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    };
    const wh = (e) => {
      if (!this.locked) return;
      const now = performance.now();
      if (Math.abs(e.deltaY) < 1 || now - (this._wheelT ?? 0) < 120) return;
      this._wheelT = now;
      this.pressed.add(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
    };
    const blur = () => this.keys.clear();
    const cm = (e) => { if (this.locked) e.preventDefault(); };
    // Chrome / Safari expose a pad once one of its buttons is pressed on the page
    const gc = () => this._setDevice('pad');
    const gd = () => { if (!this._gamepad()) this._padGone(); };
    this._h = { kd, ku, md, mu, mm, wh, blur, cm, gc, gd };
    addEventListener('keydown', kd);
    addEventListener('keyup', ku);
    addEventListener('mousedown', md);
    addEventListener('mouseup', mu);
    addEventListener('mousemove', mm);
    addEventListener('wheel', wh, { passive: true });
    addEventListener('blur', blur);
    addEventListener('contextmenu', cm);
    addEventListener('gamepadconnected', gc);
    addEventListener('gamepaddisconnected', gd);
  }

  get locked() { return this.forceLocked || document.pointerLockElement === this.target; }
  /** Look / mouse buttons are live: pointer locked, or playing with the gamepad (no lock needed). */
  get active() { return this.locked || this.device === 'pad'; }

  lock() {
    if (this.forceLocked || this.device === 'pad') return;
    const p = this.target.requestPointerLock?.({ unadjustedMovement: true });
    p?.catch?.(() => this.target.requestPointerLock?.()?.catch?.(() => {}));
  }

  unlock() { if (this.locked) document.exitPointerLock(); }

  down(action) { return this.bindings[action]?.some((c) => this.keys.has(c)) ?? false; }
  hit(action) { return this.bindings[action]?.some((c) => this.pressed.has(c)) ?? false; }
  up(action) { return (this.bindings[action]?.some((c) => this.released.has(c)) ?? false) && !this.down(action); }
  /** Move axes { f: forward, s: right }, -1..1: keys, else the touch stick, else the gamepad's left stick. */
  move() {
    const f = (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0);
    const s = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    if (f || s) return { f, s };
    if (this.moveX || this.moveY) return { f: this.moveY, s: this.moveX };
    return { f: this.padY, s: this.padX };
  }

  /** Name of the key / button bound to an action, for the device in use ('E', 'X', '□'...). */
  label(action) {
    if (this.device === 'xr') return this.xrLabels?.[action] ?? ''; // VR controllers (vr/VR.js)
    const b = this.bindings[action] ?? [];
    if (this.device === 'pad') {
      const c = b.find((c) => c.startsWith('Pad:'));
      if (c) return this.padLabel(c.slice(4));
    }
    const c = b.find((c) => !c.startsWith('Pad:') && !c.startsWith('Touch:'));
    return c ? KEY_LABELS[c] ?? c.replace(/^(Key|Digit)/, '') : '';
  }

  /** A gamepad button's name on the connected pad's layout ('A' → '✕' on a PlayStation pad). */
  padLabel(button) { return PAD_LABELS[this.padLayout][button] ?? button; }

  /** Gamepad rumble (strong / weak motor 0..1), only while the pad is the device in use. */
  rumble(strong, weak = strong, ms = 100) {
    if (this.device !== 'pad') return;
    this.pad?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) })?.catch?.(() => {});
  }

  /** Crouch toggled with the pad stays on until it is pressed again: drop it (e.g. when swimming). */
  unlatch(action) {
    const c = { crouch: 'Pad:Crouch', sprint: 'Pad:Sprint' }[action];
    if (c) this._set(c, false);
  }

  /** Read the gamepad (once per frame, before the game reads its input). ui: a menu has the input (no sprint / crouch toggles). */
  poll(ui = false) {
    const now = performance.now(), dt = Math.min(0.1, (now - (this._padT || now)) / 1000);
    this._padT = now;
    const gp = this._gamepad();
    if (!gp) { if (this.pad) this._padGone(); this.nav.x = this.nav.y = 0; return; }
    if (!this.pad || this.pad.index !== gp.index) this.padLayout = /054c|playstation|dualsense|dualshock/i.test(gp.id) ? 'ps' : 'xbox';
    this.pad = gp;
    const btn = (i) => { const b = gp.buttons[i]; return !!b && (i === 6 || i === 7 ? b.value > TRIGGER_ON : b.pressed); };
    let used = false;
    for (let i = 0; i < PAD_BUTTONS.length; i++) {
      const on = this.enabled && btn(i);
      used ||= on;
      if (on !== !!this._padPrev[i]) { this._padPrev[i] = on; this._set('Pad:' + PAD_BUTTONS[i], on); }
    }
    const ax = (i) => gp.axes[i] ?? 0;
    const dz = (x, y) => {
      const m = Math.hypot(x, y);
      if (m < STICK_DEAD) return [0, 0, 0];
      const k = Math.min(1, (m - STICK_DEAD) / (1 - STICK_DEAD));
      return [(x / m) * k, (y / m) * k, k];
    };
    const [lx, ly, lm] = dz(ax(0), -ax(1));
    const [rx, ry, rm] = dz(ax(2), ax(3));
    used ||= lm > 0.5 || rm > 0.5;
    if (used) this._setDevice('pad');
    const on = this.enabled ? 1 : 0;
    this.padX = lx * on; this.padY = ly * on;
    this.padLT = (gp.buttons[6]?.value ?? 0) * on; this.padRT = (gp.buttons[7]?.value ?? 0) * on;
    // sprint: from a click of the left stick until it is let go; crouch: B toggles (jump / sprint stand up)
    if (this.pressed.has('Pad:LS') && !ui) { this._set('Pad:Sprint', true); this._set('Pad:Crouch', false); }
    else if (lm < 0.2) this._set('Pad:Sprint', false);
    if (this.pressed.has('Pad:B') && !ui) this._set('Pad:Crouch', !this.keys.has('Pad:Crouch'));
    if (this.pressed.has('Pad:A') && !ui) this._set('Pad:Crouch', false);
    // look: squared response (fine aim near the centre), faster turns after holding the stick at the edge
    this._edgeT = rm > 0.95 && Math.abs(rx) > 0.7 ? this._edgeT + dt : 0;
    const boost = 1 + (TURN_BOOST - 1) * Math.min(1, Math.max(0, (this._edgeT - 0.25) / 0.3));
    const k = ui ? 0 : rm * this.padSensitivity * dt * on; // no turning behind a menu / the map
    this._padLook.yaw -= rx * k * LOOK_YAW * boost;
    this._padLook.pitch -= ry * k * LOOK_PITCH;
    // menu navigation: one step when pushed, then auto-repeat
    const nx = (btn(15) - btn(14)) || (lx > 0.6 ? 1 : lx < -0.6 ? -1 : 0);
    const ny = (btn(13) - btn(12)) || (ly < -0.6 ? 1 : ly > 0.6 ? -1 : 0);
    const n = this._nav;
    if (nx !== n.x || ny !== n.y) { n.x = nx; n.y = ny; n.t = 0.4; this.nav.x = nx; this.nav.y = ny; }
    else if ((nx || ny) && (n.t -= dt) <= 0) { n.t = 0.11; this.nav.x = nx; this.nav.y = ny; }
    else this.nav.x = this.nav.y = 0;
  }

  _gamepad() {
    let first = null;
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp?.connected) continue;
      if (gp.mapping === 'standard') return gp;
      first ??= gp;
    }
    return first;
  }

  _padGone() {
    for (const c of [...this.keys]) if (c.startsWith('Pad:')) this._set(c, false);
    this._padPrev.fill(0);
    this.pad = null;
    this.padX = this.padY = this.padLT = this.padRT = 0;
    this._padLook.yaw = this._padLook.pitch = 0;
    this._setDevice('kbm');
  }

  _set(code, on) {
    if (on) { if (!this.keys.has(code)) { this.pressed.add(code); this.keys.add(code); } }
    else if (this.keys.has(code)) { this.keys.delete(code); this.released.add(code); }
  }

  _setDevice(d) {
    if (this.device === d) return;
    this.device = d;
    document.body.classList.toggle('gamepad', d === 'pad');
    for (const f of this.onDevice) f(d);
  }

  /** Virtual button (touch controls): presses / releases the 'Touch:<action>' code bound to an action. */
  setVirtual(action, on) {
    const c = 'Touch:' + action;
    const b = this.bindings[action];
    if (b && !b.includes(c)) b.push(c);
    if (on) { if (!this.keys.has(c)) this.pressed.add(c); this.keys.add(c); }
    else if (this.keys.has(c)) { this.keys.delete(c); this.released.add(c); }
  }

  keyHit(code) { return this.pressed.has(code); }
  keyDown(code) { return this.keys.has(code); }

  /** Look delta in radians since the last frame (mouse + gamepad right stick). */
  look() {
    const s = this.sensitivity, pl = this._padLook;
    const r = { yaw: -this.mouseDX * s + pl.yaw, pitch: (-this.mouseDY * s + pl.pitch) * (this.invertY ? -1 : 1) };
    this.mouseDX = this.mouseDY = 0;
    pl.yaw = pl.pitch = 0;
    return r;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
  }

  clear() { this.keys.clear(); this.pressed.clear(); this.released.clear(); this.mouseDX = this.mouseDY = 0; this.moveX = this.moveY = 0; this._padLook.yaw = this._padLook.pitch = 0; }

  dispose() {
    const h = this._h;
    removeEventListener('keydown', h.kd); removeEventListener('keyup', h.ku);
    removeEventListener('mousedown', h.md); removeEventListener('mouseup', h.mu);
    removeEventListener('mousemove', h.mm); removeEventListener('wheel', h.wh);
    removeEventListener('blur', h.blur); removeEventListener('contextmenu', h.cm);
    removeEventListener('gamepadconnected', h.gc); removeEventListener('gamepaddisconnected', h.gd);
  }
}
