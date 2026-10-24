// VR mode: the game played in a headset (WebXR: Meta Quest...) with two motion controllers, in the
// spirit of Population: One — smooth locomotion on the stick, snap / smooth turns, physical crouch,
// climbing any surface with the grips, gliding with the arms spread, guns held in the hand (aimed
// for real, two-handed on the foregrip, reloaded with a magazine taken from the belt), grenades
// thrown by hand, the machete swung.
//
// Engine side (Engine.js `xr`): WebGL 2 + multiview, the frame loop driven by the session, the
// headset pose applied relative to engine.xrRig. Here the rig is the player: every frame
//   poll()  reads the headset and controller poses (reference space = rig space) and the buttons,
//           and turns them into world poses with the rig of the previous frame;
//   VRLocomotion moves the player (physical steps in the room, the stick, climbing, gliding);
//   place() puts the rig back under the player (the head right above the body's feet), or in a
//           vehicle's seat, and recomputes the world poses;
//   VRWeapons / VRHands / VRUI place the gun, the hands and the panels from those poses.
// Controls (right-handed, `settings.hand` mirrors them): left stick move (click: sprint), right
// stick turn (down: crouch toggle, click: flashlight), A jump, B eject the magazine, right trigger
// fire, grips grab (foregrip, belt pouch, chest grenades, any surface: climb), left trigger use,
// X next weapon, Y pause menu (laser pointer + trigger). In vehicles: right trigger throttle, left
// trigger brake / reverse, left stick steer, X get out; planes fly toward where the head looks.
//
// Tuning: game/player.json `vr` (arms, grip, climb, glide, pouches); player options (turn, hand,
// seated...) in the settings (`vr`), changed from the in-headset options panel.
import * as THREE from 'three';
import { VRLocomotion } from './VRLocomotion.js';
import { VRHands } from './VRHands.js';
import { VRWeapons } from './VRWeapons.js';
import { VRUI } from './VRUI.js';

/** game/player.json `vr` defaults */
export const VR_CONFIG = {
  fps: 72, // headset refresh rate asked for (the `vr` quality preset is tuned for it)
  arms: { shoulder: [0, -0.2, 0.08], pole: [0.45, -1, 0.35], reach: 0.6, yaw: 0 },
  // gun in the hand: fist centre from the wrist along the fingers (m), pitch tweak (deg)
  grip: { forward: 0.075, pitch: 0 },
  crouch: 0.78, // head below this x the standing eye height = crouched (stealth, collider)
  climb: { reach: 0.07, fling: 6 }, // grab distance beyond the hand (m), max release speed (m/s)
  glide: { speed: 13, sink: 2.4, fall: 3.5, span: 1.05, turn: 1.4 }, // m/s, m/s, falling speed to start, hands apart (m), bank turn rate
  throwBoost: 1.35, // grenade speed x the hand's
  // pouches (body space: x toward the off hand's side, y down from the eyes, z forward)
  pouch: { ammo: [0.17, -0.62, 0.06], grenade: [0, -0.4, 0.12], radius: 0.2 },
};

/** player options (settings.vr) */
export const VR_SETTINGS = { turn: 'snap', snapAngle: 30, turnSpeed: 150, vignette: true, hand: 'right', move: 'head', seated: false, seatedOffset: 0 };

const STICK_DEAD = 0.18;
const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _e = new THREE.Euler();

class Button {
  constructor() { this.value = 0; this.down = false; this.hit = false; this.up = false; this.touched = false; }
  set(b, analog) {
    const v = b ? b.value || (b.pressed ? 1 : 0) : 0;
    const was = this.down;
    this.value = v;
    this.down = analog ? (was ? v > 0.35 : v > 0.6) : !!b?.pressed;
    this.hit = this.down && !was;
    this.up = !this.down && was;
    this.touched = !!b?.touched;
  }
}

/** One motion controller: grip / ray poses (local = rig space, and world), buttons, stick, velocity. */
class Hand {
  constructor(side) {
    this.side = side;
    this.connected = false;
    this.source = null;
    this.gripLocal = new THREE.Matrix4();
    this.rayLocal = new THREE.Matrix4();
    this.world = new THREE.Matrix4();
    this.pos = new THREE.Vector3(); // grip (centre of the fist), world
    this.quat = new THREE.Quaternion();
    this.rayPos = new THREE.Vector3();
    this.rayDir = new THREE.Vector3(0, 0, -1);
    this.vel = new THREE.Vector3(); // world, m/s (smoothed)
    this._prev = new THREE.Vector3();
    this._hasPrev = false;
    this.btn = { trigger: new Button(), squeeze: new Button(), stick: new Button(), a: new Button(), b: new Button(), thumbrest: new Button() };
    this.stick = new THREE.Vector2();
  }

  /** Straight fingers' direction (grip -Y), world. */
  fingers(out = new THREE.Vector3()) { return out.set(0, -1, 0).applyQuaternion(this.quat); }
  /** Thumb side of the fist (grip -Z: along the closed fist), world. */
  thumb(out = new THREE.Vector3()) { return out.set(0, 0, -1).applyQuaternion(this.quat); }

  pulse(intensity, ms) {
    try { this.source?.gamepad?.hapticActuators?.[0]?.pulse?.(Math.min(1, intensity), ms); } catch { /* */ }
  }

  _read(src, frame, ref) {
    this.source = src;
    const g = frame.getPose(src.gripSpace ?? src.targetRaySpace, ref);
    if (g) this.gripLocal.fromArray(g.transform.matrix);
    const r = frame.getPose(src.targetRaySpace, ref);
    if (r) this.rayLocal.fromArray(r.transform.matrix);
    const b = src.gamepad.buttons, ax = src.gamepad.axes;
    this.btn.trigger.set(b[0], true);
    this.btn.squeeze.set(b[1], true);
    this.btn.stick.set(b[3]);
    this.btn.a.set(b[4]);
    this.btn.b.set(b[5]);
    this.btn.thumbrest.set(b[6]);
    const x = ax[2] ?? 0, y = -(ax[3] ?? 0), m = Math.hypot(x, y);
    const k = m < STICK_DEAD ? 0 : Math.min(1, (m - STICK_DEAD) / (1 - STICK_DEAD)) / m;
    this.stick.set(x * k, y * k); // x right, y forward
  }

  _release() {
    for (const b of Object.values(this.btn)) b.set(null, false);
    this.stick.set(0, 0);
  }

  _toWorld(rig, dt) {
    this.world.multiplyMatrices(rig, this.gripLocal);
    this.world.decompose(this.pos, this.quat, _v);
    _m.multiplyMatrices(rig, this.rayLocal);
    this.rayPos.setFromMatrixPosition(_m);
    this.rayDir.set(-_m.elements[8], -_m.elements[9], -_m.elements[10]).normalize();
    if (this._hasPrev && dt > 0) {
      _v.subVectors(this.pos, this._prev).divideScalar(dt);
      this.vel.lerp(_v, Math.min(1, dt * 30));
    }
    this._prev.copy(this.pos);
    this._hasPrev = true;
  }
}

export class VR {
  constructor(game) {
    this.game = game;
    this.engine = game.engine;
    this.renderer = game.engine.renderer;
    this.rig = game.engine.xrRig;
    const cfg = game.data.player.vr ?? {};
    this.cfg = { ...VR_CONFIG, ...cfg };
    for (const k of ['arms', 'grip', 'climb', 'glide', 'pouch']) this.cfg[k] = { ...VR_CONFIG[k], ...cfg[k] };
    this.settings = { ...VR_SETTINGS, ...game.settings.vr };
    this.yaw = 0; // rig yaw (turns)
    this.eyeHeight = game.data.player.eyeHeight; // standing eye height the game is tuned for
    this.head = { local: new THREE.Matrix4(), localPos: new THREE.Vector3(), pos: new THREE.Vector3(), quat: new THREE.Quaternion(), yaw: 0, pitch: 0, tracked: false };
    this.hands = { left: new Hand('left'), right: new Hand('right') };
    this.session = null;
    this.crouchToggle = false;
    this.input = game.input;
    this.input.xrLabels = {};
    this.locomotion = new VRLocomotion(this);
    this.weapons = new VRWeapons(this);
    this.visuals = new VRHands(this);
    this.ui = new VRUI(this);
    this._labels();
    this.renderer.xr.addEventListener('sessionstart', () => this._onStart());
    this.renderer.xr.addEventListener('sessionend', () => this._onEnd());
  }

  get presenting() { return this.renderer.xr.isPresenting; }
  /** The gun hand / the other one. */
  get main() { return this.hands[this.settings.hand === 'left' ? 'left' : 'right']; }
  get off() { return this.hands[this.settings.hand === 'left' ? 'right' : 'left']; }

  /** Loading done: the Enter VR button (WebXR sessions start from a user gesture). */
  ready() {
    const b = (this.enterBtn = document.createElement('button'));
    b.className = 'vr-enter';
    b.textContent = 'ENTER VR';
    b.onclick = () => this.enter();
    document.body.appendChild(b);
    if (!navigator.xr) { b.disabled = true; b.textContent = 'WebXR unavailable'; }
  }

  async enter() {
    if (this.session || !navigator.xr) return;
    try {
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'layers'] });
      this.session = session;
      await this.renderer.xr.setSession(session);
      if (session.supportedFrameRates?.includes?.(this.cfg.fps)) session.updateTargetFrameRate(this.cfg.fps).catch(() => {});
    } catch (e) {
      console.warn('VR session', e);
      this.session = null;
      this.game.hud?.notify(`VR: ${e.message ?? e}`, 6000);
    }
  }

  exit() { this.session?.end().catch(() => {}); }

  _onStart() {
    const g = this.game;
    this.enterBtn?.classList.add('hide');
    this.input.device = 'xr';
    g.hud.setVisible(false); // the DOM HUD doesn't show in the headset: its panels do (VRUI)
    this.locomotion.reset();
    if (!g.started) this.ui.showMain();
    else if (g.paused) this.ui.showPause();
  }

  _onEnd() {
    const g = this.game;
    this.session = null;
    this.enterBtn?.classList.remove('hide');
    this.input.device = 'kbm';
    this.ui.hide();
    if (g.started) { g.hud.setVisible(true); if (!g.paused && g.player.alive) g.pause(); }
  }

  saveSettings(s) {
    Object.assign(this.settings, s);
    this.game.saveSettings({ vr: { ...this.settings } });
    this._labels();
  }

  /** Prompt labels ('use' shows as "L trigger"...). */
  _labels() {
    const o = this.settings.hand === 'left' ? 'R' : 'L', mn = this.settings.hand === 'left' ? 'L' : 'R';
    const lo = this.settings.hand === 'left' ? 'A' : 'X', hi = this.settings.hand === 'left' ? 'B' : 'Y';
    const mlo = this.settings.hand === 'left' ? 'X' : 'A', mhi = this.settings.hand === 'left' ? 'Y' : 'B';
    Object.assign(this.input.xrLabels, { use: `${o} trigger`, jump: mlo, fire: `${mn} trigger`, reload: mhi, nextWeapon: lo, pause: hi, exitVehicle: lo });
  }

  // --- per frame -----------------------------------------------------------------------------
  /** Headset + controllers for this frame (call first: menus run on it too). */
  poll(dt) {
    const xr = this.renderer.xr, frame = xr.getFrame?.(), ref = xr.getReferenceSpace?.();
    if (!frame || !ref || !this.session) { this.head.tracked = false; return; }
    const vp = frame.getViewerPose(ref);
    if (vp) {
      this.head.local.fromArray(vp.transform.matrix);
      this.head.localPos.setFromMatrixPosition(this.head.local);
      this.head.tracked = true;
    }
    const seen = new Set();
    for (const src of this.session.inputSources) {
      const h = this.hands[src.handedness];
      if (!h || !src.gamepad || seen.has(h)) continue;
      seen.add(h);
      h._read(src, frame, ref);
    }
    for (const h of Object.values(this.hands)) { h.connected = seen.has(h); if (!h.connected) h._release(); }
    this._toWorld(dt);
    this._input();
  }

  /** World poses (head, hands) with the rig as it is now; the camera follows the head. */
  _toWorld(dt = 0) {
    const rig = this.rig, h = this.head, cam = this.engine.camera;
    rig.updateMatrixWorld();
    _m.multiplyMatrices(rig.matrixWorld, h.local);
    _m.decompose(h.pos, h.quat, _v);
    _e.setFromQuaternion(h.quat, 'YXZ');
    h.yaw = _e.y;
    h.pitch = _e.x;
    cam.position.copy(h.pos);
    cam.quaternion.copy(h.quat);
    cam.updateMatrixWorld();
    for (const hand of Object.values(this.hands)) hand._toWorld(rig.matrixWorld, dt);
  }

  /** Controller buttons -> the game's actions (Player, Game._interact, Vehicles read them). */
  _input() {
    const inp = this.input, m = this.main, o = this.off, p = this.game.player;
    const ui = this.ui.open;
    const veh = !!p.inVehicle;
    // left stick: walking (the stick's own axes; the player's yaw sets its frame, VRLocomotion)
    inp.moveX = ui ? 0 : o.stick.x;
    inp.moveY = ui ? 0 : o.stick.y;
    inp.setVirtual('jump', !ui && m.btn.a.down);
    inp.setVirtual('use', !ui && (veh ? o.btn.a.down : o.btn.trigger.down));
    // sprint: click the stick, lasts while it is pushed
    if (o.btn.stick.hit && !ui) this._sprint = true;
    if (o.stick.lengthSq() < 0.04) this._sprint = false;
    inp.setVirtual('sprint', !!this._sprint);
    // crouch: physical (the head low) or toggled with the right stick down
    if (!ui && m.stick.y < -0.8 && !this._stickDown) { this.crouchToggle = !this.crouchToggle; this._stickDown = true; }
    if (m.stick.y > -0.4) this._stickDown = false;
    // vehicles: triggers = throttle / brake (Vehicles reads the gamepad triggers)
    inp.padRT = veh && !ui ? m.btn.trigger.value : 0;
    inp.padLT = veh && !ui ? o.btn.trigger.value : 0;
    if (m.btn.stick.hit && !ui && !veh) this.game.toggleFlashlight();
    // planes fly toward where the head looks
    if (p.inVehicle?.kind === 'plane') { this.game.vehicles.aimYaw = this.head.yaw; this.game.vehicles.aimPitch = this.head.pitch; }
    if (o.btn.b.hit && this.game.started && p.alive) { if (this.game.paused) this.game.resume(); else this.game.pause(); }
  }

  /** Standing eye height above the floor the user has now (seated mode adds its offset). */
  get eyeLocal() { return this.head.localPos.y + (this.settings.seated ? this.settings.seatedOffset : 0); }

  /** Seated mode: the eye height now becomes the standing one. */
  recenterHeight() {
    this.saveSettings({ seatedOffset: Math.max(0, this.eyeHeight - this.head.localPos.y) });
  }

  /** Rig under the player (head above the feet) or in the vehicle's seat; world poses again. */
  place() {
    const p = this.game.player, rig = this.rig, h = this.head;
    const v = p.inVehicle ? this.game.vehicles.driving : null;
    const crouch = this.crouchToggle && !v ? this.eyeHeight - p.cfg.crouchEyeHeight : 0;
    const off = (this.settings.seated ? this.settings.seatedOffset : 0) - crouch;
    if (v) {
      // seated in the vehicle: the head where it was when getting in lands on the seat's eye point,
      // the rig turning with the vehicle (yaw only, planes bank and pitch with it) + the user's turns
      if (this._seat?.v !== v) this._seat = { v, local: h.localPos.clone() };
      const qv = v.kind === 'plane' ? _q.copy(v.object.quaternion) : _q.setFromAxisAngle(UP, v.heading ?? 0);
      rig.quaternion.copy(qv).multiply(_q2.setFromAxisAngle(UP, this.yaw));
      const [sx, sy, sz] = v.spec.seat;
      _v.set(sx, sy + 0.75, sz).applyQuaternion(qv).add(v.pos);
      rig.position.copy(_v).sub(_w.copy(this._seat.local).applyQuaternion(rig.quaternion));
    } else {
      this._seat = null;
      rig.quaternion.setFromAxisAngle(UP, this.yaw);
      _v.set(h.localPos.x, 0, h.localPos.z).applyQuaternion(rig.quaternion);
      rig.position.set(p.pos.x - _v.x, p.pos.y + off, p.pos.z - _v.z);
    }
    this._toWorld();
  }

  /** Turn the view about the head (snap / smooth turns). */
  turn(angle) {
    const h = this.head;
    this.yaw += angle;
    this.rig.quaternion.setFromAxisAngle(UP, this.yaw);
    _v.set(h.localPos.x, 0, h.localPos.z).applyQuaternion(this.rig.quaternion);
    this.rig.position.x = h.pos.x - _v.x;
    this.rig.position.z = h.pos.z - _v.z;
    this._toWorld();
  }

  /** Per frame while the game runs (Game.update, after the player moved). */
  update(dt) {
    this.weapons.update(dt);
    this.visuals.update(dt);
    this.ui.update(dt);
  }

  /** Paused / menus: the rig stays, the hands and the pointer still move. */
  idle(dt) {
    this.place();
    this.visuals.update(dt);
    this.ui.update(dt);
  }
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _w = new THREE.Vector3();
