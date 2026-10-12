// Keyboard / mouse input with action bindings (KeyboardEvent.code = physical keys, so ZQSD on
// AZERTY maps to the same actions as WASD), pointer lock and per-frame edge detection.
// Call endFrame() once per frame after the game read its input.
export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'KeyC'],
  fire: ['Mouse0', 'KeyT'],
  aim: ['Mouse2'],
  reload: ['KeyR'],
  use: ['KeyE'],
  grenade: ['KeyG'],
  melee: ['KeyV', 'Mouse3'],
  weapon1: ['Digit1'], weapon2: ['Digit2'], weapon3: ['Digit3'], weapon4: ['Digit4'], weapon5: ['Digit5'], weapon6: ['Digit6'],
  nextWeapon: ['WheelDown', 'KeyQ'], // KeyQ = A on AZERTY
  prevWeapon: ['WheelUp'],
  binoculars: ['KeyB'],
  map: ['KeyM', 'Tab'],
  flashlight: ['KeyF'],
  camera: ['KeyH'],
  pause: ['Escape', 'KeyP'],
};

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
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.enabled = true;
    this.requireLock = true; // ignore mouse buttons unless the pointer is locked
    this.forceLocked = new URLSearchParams(location.search).has('bot'); // automated play tests
    const kd = (e) => {
      if (!this.enabled || e.repeat) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow') || (this.locked && e.code.startsWith('Control'))) e.preventDefault();
    };
    const ku = (e) => { this.keys.delete(e.code); this.released.add(e.code); };
    const md = (e) => {
      if (!this.enabled || (this.requireLock && !this.locked)) return;
      const c = 'Mouse' + e.button;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
    };
    const mu = (e) => { const c = 'Mouse' + e.button; this.keys.delete(c); this.released.add(c); };
    const mm = (e) => {
      if (!this.locked) return;
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
    this._h = { kd, ku, md, mu, mm, wh, blur, cm };
    addEventListener('keydown', kd);
    addEventListener('keyup', ku);
    addEventListener('mousedown', md);
    addEventListener('mouseup', mu);
    addEventListener('mousemove', mm);
    addEventListener('wheel', wh, { passive: true });
    addEventListener('blur', blur);
    addEventListener('contextmenu', cm);
  }

  get locked() { return this.forceLocked || document.pointerLockElement === this.target; }

  lock() {
    if (this.forceLocked) return;
    const p = this.target.requestPointerLock?.({ unadjustedMovement: true });
    p?.catch?.(() => this.target.requestPointerLock?.()?.catch?.(() => {}));
  }

  unlock() { if (this.locked) document.exitPointerLock(); }

  down(action) { return this.bindings[action]?.some((c) => this.keys.has(c)) ?? false; }
  hit(action) { return this.bindings[action]?.some((c) => this.pressed.has(c)) ?? false; }
  up(action) { return (this.bindings[action]?.some((c) => this.released.has(c)) ?? false) && !this.down(action); }
  keyHit(code) { return this.pressed.has(code); }
  keyDown(code) { return this.keys.has(code); }

  /** Mouse look delta in radians since the last frame. */
  look() {
    const s = this.sensitivity;
    const r = { yaw: -this.mouseDX * s, pitch: -this.mouseDY * s * (this.invertY ? -1 : 1) };
    this.mouseDX = this.mouseDY = 0;
    return r;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
  }

  clear() { this.keys.clear(); this.pressed.clear(); this.released.clear(); this.mouseDX = this.mouseDY = 0; }

  dispose() {
    const h = this._h;
    removeEventListener('keydown', h.kd); removeEventListener('keyup', h.ku);
    removeEventListener('mousedown', h.md); removeEventListener('mouseup', h.mu);
    removeEventListener('mousemove', h.mm); removeEventListener('wheel', h.wh);
    removeEventListener('blur', h.blur); removeEventListener('contextmenu', h.cm);
  }
}
