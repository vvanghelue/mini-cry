// VR weapons: the guns held, aimed, fired and reloaded with the hands (Weapons.js keeps the
// inventory, ammo, hitscan, projectiles, explosions; its view model and desktop input are off):
//  - the gun sits in the main hand, its barrel along the controller's pointing ray (aiming = pointing
//    the controller), the weapon asset's right grip (`hands.right`: wrist, fingers, thumb) on the
//    controller's grip, where the hand is drawn. The other hand closing on the foregrip
//    (`hands.left`) holds it with both hands: it then points from one fist to the other, steadier
//    (less spread, less recoil);
//  - the trigger fires down the barrel (Weapons.aim); the recoil kicks the gun up and back,
//    haptics in the hands holding it; the sight held in front of an eye = aiming down sights;
//  - physical reload: B ejects the magazine (its rounds go back to the reserve), the other hand
//    takes a new one from the belt pouch and pushes it into the magazine well (asset `magazine`
//    point); shotgun shells one at a time into the loading port, rockets into the muzzle;
//  - grenades: a grip at the chest takes one, letting go throws it with the hand's speed;
//  - machete: swung — the blade going fast through an enemy hits (takedown when unaware);
//  - X: next weapon. A grip on a wall with the main hand holsters the gun while climbing.
import * as THREE from 'three';
import { frameRotation } from '../player/ViewArms.js';

const D2R = Math.PI / 180;
const DEFAULT_RIGHT = { pos: [0.022, 0.03, 0.1], fingers: [0, -0.3, -0.95], thumb: [0, 0.95, -0.3], curl: [[25, 40, 30], 65, 70, 75], thumbCurl: [10, 20, 20], thumbFold: 30 };
const FIST = { curl: [70, 75, 80, 85], thumbCurl: [20, 30, 30], thumbFold: 40 };
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export class VRWeapons {
  constructor(vr) {
    this.vr = vr;
    this.game = vr.game;
    const W = (this.W = vr.game.weapons);
    W.vr = this;
    const scene = vr.game.engine.scene;
    // the weapon models leave the overlay pass for the world (VRWeapons places them each frame)
    vr.game.engine.overlay = null;
    this.gun = new THREE.Group();
    this.gun.name = 'VRGun';
    scene.add(this.gun);
    this.specs = {};
    this.twoHand = false;
    this.ads = 0;
    this.kick = 0;
    this.holstered = false;
    this.held = new Map(); // hand -> { kind: 'ammo' | 'grenade', mesh }
    this.drops = []; // ejected / dropped magazines falling
    this.melee = { cd: 0, tip: new THREE.Vector3(), has: false };
    this._items = this._itemMeshes(scene);
  }

  /** Meshes of what a hand can hold: magazine, shell, rocket, grenade (pooled, one per kind). */
  _itemMeshes(scene) {
    const L = this.game.engine.lighting, assets = this.game.world.assets;
    const metal = L.material({ color: 0x2b2d2f, vertexColors: false });
    const brass = L.material({ color: 0xb08a3a, vertexColors: false });
    const mk = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.visible = false; scene.add(m); return m; };
    const grenade = assets.has(this.W.data.grenade?.asset) ? (() => { const b = assets.build(this.W.data.grenade.asset, { quality: 1 }); return mk(b.geometry, assets.material(b)); })() : mk(new THREE.IcosahedronGeometry(0.045, 1), metal);
    return {
      mag: mk(new THREE.BoxGeometry(0.03, 0.14, 0.06).translate(0, -0.05, 0), metal),
      shell: mk(new THREE.CylinderGeometry(0.011, 0.011, 0.07, 8), brass),
      rocket: mk(new THREE.ConeGeometry(0.045, 0.3, 10).rotateX(-Math.PI / 2), L.material({ color: 0x4b5a32, vertexColors: false })),
      grenade,
    };
  }

  get current() { return this.W.current; }

  /** What the gun needs from the grips of weapon `id` (weapon space), cached. */
  _spec(id) {
    if (this.specs[id]) return this.specs[id];
    const W = this.W, d = W.defs[id], vm = W._vmFor(id), info = vm.info, cfg = this.vr.cfg.grip;
    const assets = this.game.world.assets, def = assets.has(d.asset) ? assets.get(d.asset) : {};
    const mx = this.vr.settings.hand === 'left' ? -1 : 1; // left-handed: the right grip mirrored
    const vec = (a) => new THREE.Vector3(a[0] * mx, a[1], a[2]);
    const right = info.hands?.right ?? DEFAULT_RIGHT;
    const f = vec(right.fingers).normalize();
    // weapon space -> pointing ray space: the barrel (-Z) along the ray, tilted by cfg.pitch
    const R = new THREE.Quaternion().setFromAxisAngle(X, (cfg.pitch ?? 0) * D2R);
    const fist = vec(right.pos).addScaledVector(f, cfg.forward);
    const left = info.hands?.left;
    const leftFist = left ? vec(left.pos).addScaledVector(vec(left.fingers).normalize(), cfg.forward) : fist.clone().add(new THREE.Vector3(0, 0.02, -0.28));
    const s = {
      id, d, vm, info, right, left, R, fist, leftFist, mx,
      muzzle: info.muzzle.clone(), sight: info.sight.clone(),
      well: def.magazine ? new THREE.Vector3(...def.magazine) : info.front.clone(),
      bore: new THREE.Vector3(0, info.muzzle.y, fist.z), // on the barrel's axis, above the hand
    };
    return (this.specs[id] = s);
  }

  // --- per frame -----------------------------------------------------------------------------
  update(dt) {
    const W = this.W, g = this.game, p = g.player, vr = this.vr;
    const w = W.current, id = W.currentId;
    const canAct = p.alive && !p.inVehicle && !vr.ui.open;
    const s = id ? this._spec(id) : null;
    // the model of the current weapon in the gun group
    for (const [k, v] of Object.entries(W.vmMeshes)) {
      if (v.group.parent !== this.gun) this.gun.add(v.group);
      v.group.visible = k === id && W.state !== 'switching';
    }
    this.holstered = vr.locomotion.climb?.hand === vr.main;
    this.gun.visible = !!s && canAct && !this.holstered && vr.main.connected;
    if (canAct && !this._holding(vr.off) && vr.off.btn.a.hit) W._cycle(1);
    this._twoHand(s);
    this.kick = Math.max(0, this.kick - dt * (w?.recoilRecover ?? 8) * 0.6);
    if (this.gun.visible) this._pose(s);
    // aiming down sights: the sight close in front of an eye, along the view
    let ads = 0;
    if (this.gun.visible && w?.type !== 'melee') {
      const sight = this.gun.localToWorld(_a.copy(s.sight));
      const fwd = _b.set(0, 0, -1).applyQuaternion(this.gun.quaternion), view = _c.set(0, 0, -1).applyQuaternion(vr.head.quat);
      if (sight.distanceTo(vr.head.pos) < 0.16 && fwd.dot(view) > 0.97) ads = 1;
    }
    this.ads += ((ads ? 1 : 0) - this.ads) * Math.min(1, dt * 12);
    // spread / recoil: two hands or the sight at the eye steady the gun (Weapons reads adsBlend)
    W.adsBlend = Math.max(this.ads, this.twoHand ? 0.8 : w?.slot === 2 ? 0.55 : 0.15);
    if (canAct && w && this.gun.visible && W.state !== 'switching') {
      if (w.type === 'melee') this._swing(w, s, dt);
      else this._trigger(w, id);
    }
    if (canAct && w && w.type !== 'melee') this._reload(w, id, s);
    this._grenades(canAct);
    this._drops(dt);
  }

  /** The gun's world pose from the main hand (+ the other on the foregrip), recoil applied. */
  _pose(s) {
    const m = this.vr.main, o = this.vr.off;
    _q.copy(m.rayQuat).multiply(s.R); // weapon -> world
    if (this.twoHand) {
      // the axis between the fists points the gun; the main hand keeps the roll
      _a.subVectors(s.leftFist, s.fist);
      _b.subVectors(o.pos, m.pos);
      _c.copy(Y).applyQuaternion(_q);
      frameRotation(_a, Y, _b, _c, _q2);
      _q.copy(_q2);
    }
    // recoil: the muzzle up about the fist, the gun pushed back
    const k = this.kick * (this.twoHand ? 0.45 : 1);
    _q.multiply(_q2.setFromAxisAngle(X, k * 0.16));
    this.gun.quaternion.copy(_q);
    this.gun.position.copy(m.pos).sub(_a.copy(s.fist).applyQuaternion(_q)).addScaledVector(_b.set(0, 0, 1).applyQuaternion(_q), k * 0.035);
    this.gun.updateMatrixWorld(true);
  }

  /** Weapons.aim(): down the barrel. */
  aim() {
    const s = this._spec(this.W.currentId), gun = this.gun;
    return {
      origin: gun.localToWorld(_d.copy(s.bore)),
      dir: new THREE.Vector3(0, 0, -1).applyQuaternion(gun.quaternion),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(gun.quaternion),
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(gun.quaternion),
      muzzle: gun.localToWorld(s.muzzle.clone()),
    };
  }

  /** Weapons._fire feedback: the gun kicks, the hands holding it buzz. */
  recoil(w, rk) {
    this.kick = Math.min(1.6, this.kick + 0.35 + rk * 0.12);
    const launcher = w.type === 'launcher';
    this.vr.main.pulse(launcher ? 1 : 0.35 + rk * 0.08, launcher ? 120 : 35);
    if (this.twoHand) this.vr.off.pulse(launcher ? 0.8 : 0.25 + rk * 0.05, launcher ? 100 : 30);
  }

  _trigger(w, id) {
    const W = this.W, t = this.vr.main.btn.trigger;
    if (W.fireCd > 0 || !(w.auto ? t.down : t.hit)) return;
    if ((W.clip[id] ?? 0) > 0) W._fire(w);
    else if (t.hit) { this.game.audio?.play('dry_fire', { volume: 0.5 }); W.fireCd = 0.25; this.vr.main.pulse(0.1, 15); }
  }

  /** The other hand on the foregrip: grip close to it to take it, open to let go. */
  _twoHand(s) {
    const o = this.vr.off;
    if (!s || !this.gun.visible || s.d.type === 'melee' || !o.connected || this._holding(o)) { this.twoHand = false; return; }
    if (this.twoHand && !o.btn.squeeze.down) this.twoHand = false;
    if (!this.twoHand && o.btn.squeeze.hit && this._nearForegrip(o, s)) { this.twoHand = true; o.pulse(0.25, 25); }
  }

  _nearForegrip(h, s) {
    if (!s || !this.gun.visible || s.d.type === 'melee') return false;
    return h.pos.distanceTo(this.gun.localToWorld(_a.copy(s.leftFist))) < 0.14;
  }

  /** A pouch's world position (body space offsets, x toward the off hand's side). */
  _pouch(which, out) {
    const head = this.vr.head, P = this.vr.cfg.pouch[which], side = this.vr.settings.hand === 'left' ? 1 : -1;
    const c = Math.cos(head.yaw), sn = Math.sin(head.yaw);
    const x = P[0] * side, z = -P[2]; // body space: +x right, -z forward
    return out.set(head.pos.x + x * c + z * sn, head.pos.y + P[1], head.pos.z - x * sn + z * c);
  }

  /** Does this hand's grip go to the gun / a pouch / the item it holds (not climbing)? */
  claims(h) {
    if (this._holding(h) || (h === this.vr.off && this.twoHand)) return true;
    if (h !== this.vr.off) return false;
    const s = this.W.currentId ? this._spec(this.W.currentId) : null;
    const r = this.vr.cfg.pouch.radius;
    return this._nearForegrip(h, s) || h.pos.distanceTo(this._pouch('ammo', _c)) < r || h.pos.distanceTo(this._pouch('grenade', _c)) < r;
  }

  _holding(h) { return this.held.has(h); }
  holding(h) { return this._holding(h) || (h === this.vr.off && this.twoHand); }

  // --- reload --------------------------------------------------------------------------------
  _reload(w, id, s) {
    const W = this.W, m = this.vr.main, o = this.vr.off, g = this.game;
    const kind = w.type === 'launcher' ? 'rocket' : w.reloadPerShell ? 'shell' : 'mag';
    // B: magazine out (the rounds left in it go back to the reserve)
    if (kind === 'mag' && m.btn.b.hit && this.gun.visible && (W.clip[id] ?? 0) > 0) {
      W.ammo[w.ammo] = (W.ammo[w.ammo] ?? 0) + W.clip[id];
      W.clip[id] = 0;
      this._drop('mag', this.gun.localToWorld(_a.copy(s.well)), this.gun.quaternion, m.vel);
      g.audio?.play('reload_mag_out', { volume: 0.5 });
      m.pulse(0.3, 30);
    }
    // a new one from the belt
    if (o.btn.squeeze.hit && !this._holding(o) && !this.twoHand && (W.ammo[w.ammo] ?? 0) > 0 && o.pos.distanceTo(this._pouch('ammo', _a)) < this.vr.cfg.pouch.radius) {
      this.held.set(o, { kind, mesh: this._items[kind] });
      o.pulse(0.2, 20);
      g.audio?.play('pickup_item', { volume: 0.25 });
    }
    const held = this.held.get(o);
    if (!held || held.kind === 'grenade') return;
    if (!o.btn.squeeze.down) { this.held.delete(o); this._drop(held.kind, o.pos, o.quat, o.vel); return; }
    // pushed into the well (rockets: the muzzle)
    const port = this.gun.localToWorld(_b.copy(kind === 'rocket' ? s.muzzle : s.well));
    if (!this.gun.visible || o.pos.distanceTo(port) > 0.1) return;
    if (held.kind !== kind || (W.clip[id] ?? 0) >= w.mag) return;
    if (kind === 'mag' && W.clip[id] > 0) { W.ammo[w.ammo] += W.clip[id]; W.clip[id] = 0; this._drop('mag', port, this.gun.quaternion, m.vel); }
    const take = Math.min(kind === 'mag' ? w.mag : 1, W.ammo[w.ammo] ?? 0);
    W.clip[id] = (W.clip[id] ?? 0) + take;
    W.ammo[w.ammo] -= take;
    this.held.delete(o);
    g.audio?.play(kind === 'shell' ? 'shotgun_shell' : 'reload_mag_in', { volume: 0.6 });
    o.pulse(0.5, 40); m.pulse(0.4, 40);
  }

  // --- grenades ------------------------------------------------------------------------------
  _grenades(canAct) {
    const W = this.W, g = this.game;
    for (const h of [this.vr.off, this.vr.main]) {
      const held = this.held.get(h);
      if (!held && canAct && h.btn.squeeze.hit && W.grenades > 0 && !(h === this.vr.off && this.twoHand) && (h === this.vr.off || this.holstered || !this.gun.visible)
        && h.pos.distanceTo(this._pouch('grenade', _a)) < this.vr.cfg.pouch.radius) {
        this.held.set(h, { kind: 'grenade', mesh: this._items.grenade });
        h.pulse(0.2, 20);
      } else if (held?.kind === 'grenade' && !h.btn.squeeze.down) {
        this.held.delete(h);
        if (!g.cheats?.infiniteAmmo) W.grenades--;
        W.spawnGrenade(h.pos.clone(), h.throwVelocity().multiplyScalar(this.vr.cfg.throwBoost), 'player');
        g.hud?.refreshWeapon();
      }
    }
  }

  // --- machete -------------------------------------------------------------------------------
  /** The blade's tip moving fast through an enemy's body hits it (once per swing). */
  _swing(w, s, dt) {
    const g = this.game, M = this.melee;
    M.cd -= dt;
    const tip = this.gun.localToWorld(_a.set(0, 0.02, -0.5));
    const speed = M.has && dt > 0 ? tip.distanceTo(M.tip) / dt : 0;
    M.tip.copy(tip);
    M.has = true;
    if (speed < 3.5 || M.cd > 0) return;
    const mid = this.gun.localToWorld(_b.set(0, 0.02, -0.25));
    let best = null, bd = 0.45;
    for (const a of g.actors?.list ?? []) {
      if (!a.alive || a.pos.distanceToSquared(tip) > 9) continue;
      for (const q of [tip, mid]) {
        const y = THREE.MathUtils.clamp(q.y, a.pos.y + 0.2, a.pos.y + 1.8);
        const d = Math.hypot(q.x - a.pos.x, q.y - y, q.z - a.pos.z);
        if (d < bd) { bd = d; best = a; }
      }
    }
    if (!best) return;
    M.cd = 0.4;
    const dir = _c.subVectors(best.pos, this.vr.head.pos).setY(0).normalize();
    this.W.meleeStrike(best, w, dir.clone(), this.vr.head.pos.clone());
    this.vr.main.pulse(0.8, 60);
  }

  // --- held / dropped items ------------------------------------------------------------------
  _drop(kind, pos, quat, vel) {
    const src = this._items[kind];
    const m = new THREE.Mesh(src.geometry, src.material);
    m.position.copy(pos);
    m.quaternion.copy(quat);
    this.game.engine.scene.add(m);
    this.drops.push({ mesh: m, vel: vel.clone(), t: 0 });
    if (this.drops.length > 8) this.drops.shift().mesh.removeFromParent();
  }

  _drops(dt) {
    const T = this.game.world.terrain, physics = this.game.world.physics;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.t += dt;
      if (d.t > 8) { d.mesh.removeFromParent(); this.drops.splice(i, 1); continue; }
      if (d.rest) continue;
      d.vel.y -= 9.8 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      const p = d.mesh.position;
      const ground = Math.max(T.heightAt(p.x, p.z), physics.groundAt(p.x, p.z, 0.05, p.y + 0.3));
      if (p.y < ground + 0.02) { p.y = ground + 0.02; d.rest = true; }
    }
  }

  /** Held items follow their hand (VRHands calls this after placing the hands). */
  placeHeld() {
    for (const it of Object.values(this._items)) it.visible = false;
    for (const [h, held] of this.held) {
      const m = held.mesh;
      m.visible = h.connected;
      m.position.copy(h.pos);
      m.quaternion.copy(h.quat);
    }
  }

  /** Hand pose for VRHands: on the gun's grips, closed on a held item, or null (free). */
  handPose(h, out) {
    const s = this.W.currentId ? this._spec(this.W.currentId) : null;
    if (h === this.vr.main && this.gun.visible && s) return this._gripPose(s.right, s.mx, out);
    if (h === this.vr.off && this.twoHand && s?.left) return this._gripPose(s.left, s.mx, out);
    if (this.held.has(h)) { out.grip = FIST; return null; }
    out.grip = null;
    return null;
  }

  _gripPose(gr, mx, out) {
    const gun = this.gun;
    out.wrist.set(gr.pos[0] * mx, gr.pos[1], gr.pos[2]).applyMatrix4(gun.matrixWorld);
    out.fingers.set(gr.fingers[0] * mx, gr.fingers[1], gr.fingers[2]).applyQuaternion(gun.quaternion).normalize();
    out.thumb.set(gr.thumb[0] * mx, gr.thumb[1], gr.thumb[2]).applyQuaternion(gun.quaternion);
    out.grip = gr;
    return out;
  }
}
