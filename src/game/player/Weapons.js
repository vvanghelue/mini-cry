// Player weapons: inventory (slots), ammo, first-person view model (separate overlay pass),
// hitscan firing with spread / bloom / recoil, aiming down sights (scopes), reloads, melee
// (stealth takedowns), grenades and rockets (simulated projectiles), explosions.
// VR: `vr` (vr/VRWeapons.js) holds, aims, fires and reloads the guns with the hands; the view
// model and the desktop input are off.
import * as THREE from 'three';
import { LAYERS } from '../../engine/render/layers.js';
import { ViewArms } from './ViewArms.js';
import { ViewLight } from './ViewLight.js';
import { modelBounds } from './ViewModels.js';

const D2R = Math.PI / 180;
// left hand path during reloads (camera space): out of the view for a magazine, under the receiver for a shell
const RELOAD_MAG = new THREE.Vector3(-0.05, -0.35, 0.15), RELOAD_SHELL = new THREE.Vector3(0.03, -0.12, 0.1);
const _ray = new THREE.Ray(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();

export class Weapons {
  constructor(game, data) {
    this.game = game;
    this.data = data;
    this.defs = data.weapons;
    this.owned = new Set();
    this.ammo = {}; // reserve per ammo type
    this.clip = {}; // rounds in the magazine per weapon id
    this.grenades = 0;
    this.currentId = null;
    this.state = 'idle'; // idle | switching | reloading | firing | melee | throwing
    this.stateT = 0;
    this.fireCd = 0;
    this.bloom = 0;
    this.adsBlend = 0;
    this.kick = 0;
    this.projectiles = [];
    this.tools = new Set(); // binoculars...
    this._initViewModel();
  }

  get current() { return this.currentId ? this.defs[this.currentId] : null; }

  // --- inventory ---------------------------------------------------------------------------
  /** rounds: what a dropped weapon holds (fills its magazine first, the rest goes to the reserve). */
  give(id, { ammo = {}, rounds, select = true } = {}) {
    const d = this.defs[id];
    if (!d) return false;
    const isNew = !this.owned.has(id);
    // one weapon per slot (Far Cry 1 style swap): drop the other weapon of that slot
    if (isNew && d.slot >= 3) for (const o of [...this.owned]) if (o !== id && this.defs[o].slot === d.slot) this.owned.delete(o);
    this.owned.add(id);
    if (this.clip[id] === undefined) {
      this.clip[id] = rounds === undefined ? d.mag ?? 0 : Math.min(d.mag ?? 0, rounds);
      if (rounds) rounds -= this.clip[id];
    }
    if (rounds > 0 && d.ammo) this.addAmmo(d.ammo, rounds);
    for (const [t, n] of Object.entries(ammo)) this.addAmmo(t, n);
    if (isNew && select) this.select(id);
    this.game.hud?.refreshWeapon();
    return isNew;
  }

  addAmmo(type, n) {
    const max = this.data.ammoTypes[type]?.max ?? 999;
    this.ammo[type] = Math.min(max, (this.ammo[type] ?? 0) + n);
    this.game.hud?.refreshWeapon();
  }

  select(id) {
    if (!this.owned.has(id) || id === this.currentId && this.state !== 'switching') return;
    this.pendingId = id;
    this.state = 'switching';
    this.stateT = 0;
    this.reloading = false;
    this.game.audio?.play('weapon_switch', { volume: 0.4 });
  }

  _cycle(dir) {
    const list = [...this.owned].sort((a, b) => this.defs[a].slot - this.defs[b].slot);
    if (!list.length) return;
    const i = list.indexOf(this.pendingId ?? this.currentId);
    this.select(list[(i + dir + list.length) % list.length]);
  }

  // --- view model --------------------------------------------------------------------------
  _initViewModel() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.02, 10);
    camera.layers.enableAll();
    scene.add(camera);
    // world sun + shadows, probe GI and sky reflections (PBR weapons and arms, ViewLight.js); the
    // camera follows the world camera, so the view-model scene is in world space
    this.vmLight = new ViewLight(this.game.engine.renderer, scene, this.game.engine.lighting, camera);
    this.vmRoot = new THREE.Group();
    camera.add(this.vmRoot);
    this.vmWeapon = new THREE.Group();
    this.vmRoot.add(this.vmWeapon);
    this.vmMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.2 });
    this.vmMeshes = {};
    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), new THREE.MeshBasicMaterial({ color: 0xffc860, transparent: true, depthWrite: false, toneMapped: false }));
    this.flash.visible = false;
    this.vmWeapon.add(this.flash);
    this.vm = { scene, camera, visible: true, beforeRender: () => this.vmLight.follow() };
    // realistic arms (public/models/fp, posed by IK on the weapon grips); box arms as fallback
    const armsModel = this.game.app.vr ? null : this.game.viewModels?.arms; // VR: its own arms (VRHands)
    try { if (armsModel) this.arms = new ViewArms(armsModel, this.game.data.player?.arms, camera); } catch (e) { console.warn('view arms unavailable', e); }
    if (this.arms) { this.arms.visible = false; this.vmLight.patch(this.arms.root); }
    this.game.engine.overlay = this.vm;
    this.game.engine.on('resize', ({ w, h }) => { camera.aspect = w / h; camera.updateProjectionMatrix(); });
  }

  /** A low-poly forearm: hand box at `hand`, sleeve running toward `elbowDir` (view space). */
  _arm(hand, elbowDir, len = 0.42) {
    const sleeve = (this._sleeveMat ??= new THREE.MeshStandardMaterial({ color: 0x5d6a3a, flatShading: true, roughness: 0.9 }));
    const skin = (this._skinMat ??= new THREE.MeshStandardMaterial({ color: 0xc89a74, flatShading: true, roughness: 0.6 }));
    const g = new THREE.Group();
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, len).translate(0, 0, len / 2 + 0.05), sleeve);
    const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.078, 0.04).translate(0, 0, 0.06), sleeve);
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.07, 0.09), skin);
    g.add(s, cuff, h);
    g.position.copy(hand);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), elbowDir.clone().normalize());
    return g;
  }

  _vmFor(id) {
    if (this.vmMeshes[id]) return this.vmMeshes[id];
    const d = this.defs[id];
    const assets = this.game.world.assets;
    const g = new THREE.Group();
    let info = { muzzle: new THREE.Vector3(0, 0.04, -0.4), sight: new THREE.Vector3(0, 0.08, 0), front: new THREE.Vector3(0, -0.03, -0.25) };
    const real = this.game.viewModels?.weapons[d.asset];
    if (assets.has(d.asset)) {
      // the realistic model (public/models/fp, same weapon space as the asset) or the asset itself
      let bb;
      if (real) {
        g.add(real.scene);
        bb = modelBounds(real.scene);
      } else {
        const b = assets.build(d.asset, { quality: 1 });
        g.add(new THREE.Mesh(b.geometry, this.vmMat));
        bb = b.bounds;
      }
      const def = assets.get(d.asset);
      info = {
        muzzle: new THREE.Vector3(...(def.muzzle ?? [0, (bb.min.y + bb.max.y) / 2 + 0.02, bb.min.z])),
        sight: new THREE.Vector3(...(def.sight ?? [0, bb.max.y, 0])),
        front: new THREE.Vector3(...(def.magazine ?? [0, bb.min.y * 0.5, bb.min.z * 0.45])),
      };
      info.front.y = Math.min(info.front.y, -0.02);
      if (def.magazine) info.front.z = Math.min(info.front.z - 0.12, bb.min.z * 0.4);
    } else {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.4).translate(0, 0.02, -0.15), this.vmMat));
    }
    info.hands = assets.has(d.asset) ? assets.get(d.asset).hands : null;
    if (!this.arms || !info.hands) {
      // right hand on the grip, forearm going back / down / right (toward the camera's lower right)
      g.add(this._arm(new THREE.Vector3(0, -0.04, 0.02), new THREE.Vector3(0.25, -0.55, 0.8), 0.4));
      if (d.type !== 'melee' && d.slot !== 2) {
        // support hand under the front of the gun, elbow down / left / back
        g.add(this._arm(info.front.clone().add(new THREE.Vector3(0, -0.02, 0)), new THREE.Vector3(-0.45, -0.6, 0.65), 0.45));
      } else if (d.slot === 2) {
        g.add(this._arm(new THREE.Vector3(-0.03, -0.07, 0.01), new THREE.Vector3(-0.4, -0.55, 0.75), 0.4));
      }
    }
    g.traverse((o) => o.layers.set(LAYERS.VIEW));
    this.vmLight.patch(g);
    g.visible = false;
    this.vmWeapon.add(g);
    this.vmMeshes[id] = { group: g, info };
    return this.vmMeshes[id];
  }

  _showVM(id) {
    for (const [k, v] of Object.entries(this.vmMeshes)) v.group.visible = k === id;
    if (id) this._vmFor(id).group.visible = true;
    this.vmInfo = id ? this.vmMeshes[id].info : null;
    this.vmGroup = id ? this.vmMeshes[id].group : null;
    if (this.vmInfo) this.flash.position.copy(this.vmInfo.muzzle);
    if (this.arms) this.arms.visible = !!this.vmInfo?.hands;
  }

  // --- update ------------------------------------------------------------------------------
  update(dt, input) {
    const g = this.game, p = g.player;
    this.fireCd -= dt;
    this.stateT += dt;
    this.bloom = Math.max(0, this.bloom - dt * 4);
    this.kick = Math.max(0, this.kick - dt * 8);
    const canAct = p.alive && !p.inVehicle && !g.ui?.blocking;
    const w = this.current;
    if (this.vr) {
      // VR: the hands do the rest (VRWeapons.update, after the rig moved)
      if (this.state === 'switching') this._switch();
      this._updateProjectiles(dt);
      return;
    }

    // selection
    if (canAct) {
      for (let s = 1; s <= 6; s++) if (input.hit('weapon' + s)) { const id = [...this.owned].find((o) => this.defs[o].slot === s); if (id) this.select(id); }
      if (input.hit('nextWeapon')) this._cycle(1);
      if (input.hit('prevWeapon')) this._cycle(-1);
    }
    if (this.state === 'switching') this._switch();

    // aim down sights
    const wantAds = canAct && w && w.type !== 'melee' && input.down('aim') && !p.sprinting && this.state !== 'reloading' && this.state !== 'switching';
    const adsTime = w?.adsTime ?? 0.2;
    this.adsBlend = THREE.MathUtils.clamp(this.adsBlend + (wantAds ? dt : -dt) / adsTime, 0, 1);

    if (canAct && w && this.state === 'idle') {
      if (w.type === 'melee') {
        if (input.hit('fire') && this.fireCd <= 0) this._melee(w);
      } else {
        const trigger = w.auto ? input.down('fire') : input.hit('fire');
        if (trigger && this.fireCd <= 0 && !p.sprinting) {
          if ((this.clip[this.currentId] ?? 0) > 0) this._fire(w);
          else if (input.hit('fire')) { g.audio?.play('dry_fire', { volume: 0.5 }); this.fireCd = 0.25; this._reload(); }
        }
        if (input.hit('reload') && !(input.hit('use') && g.interactPrompt)) this._reload(); // pad: one button for both
      }
      if (input.hit('melee') && w.type !== 'melee' && this.fireCd <= 0) this._melee(this.defs.machete ?? w, true);
      if (input.hit('grenade') && this.grenades > 0) this._throwGrenade();
    }
    if (this.state === 'reloading') this._updateReload(dt);
    if (this.state === 'melee' && this.stateT > (this._meleeDur ?? 0.45)) this.state = 'idle';
    if (this.state === 'throwing' && this.stateT > 0.5) this.state = 'idle';

    this._updateProjectiles(dt);
    this._animateVM(dt);
  }

  _switch() {
    if (this.stateT > 0.22 && this.pendingId) {
      this.currentId = this.pendingId;
      this.pendingId = null;
      this._showVM(this.currentId);
      this.game.hud?.refreshWeapon();
    }
    if (this.stateT > 0.45) this.state = 'idle';
  }

  // --- firing ------------------------------------------------------------------------------
  /** Where shots go: { origin, dir, up, right, muzzle } (world). Desktop: the view; VR: the barrel. */
  aim() {
    if (this.vr) return this.vr.aim();
    const cam = this.game.engine.camera;
    cam.updateMatrixWorld();
    return {
      origin: cam.getWorldPosition(new THREE.Vector3()),
      dir: cam.getWorldDirection(new THREE.Vector3()),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion),
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion),
      muzzle: this._muzzleWorld(),
    };
  }

  _spreadDeg(w) {
    const p = this.game.player;
    const move = Math.min(1, p.speed / p.cfg.walkSpeed) + (p.onGround || p.swimming ? 0 : 1);
    let s = THREE.MathUtils.lerp(w.spreadHip, w.spreadAds, this.adsBlend) + (w.spreadMove ?? 1) * move * (1 - 0.6 * this.adsBlend) + this.bloom;
    if (p.crouched) s *= 0.7;
    return s;
  }

  _fire(w) {
    const g = this.game, p = g.player;
    const id = this.currentId;
    if (!g.cheats?.infiniteAmmo) this.clip[id]--;
    this.fireCd = 60 / w.rpm;
    const { origin, dir, up, right, muzzle: muzzleW } = this.aim();
    if (w.type === 'launcher') {
      this._spawnRocket(w, muzzleW, dir);
    } else {
      const pellets = w.pellets ?? 1;
      const spread = this._spreadDeg(w) * D2R;
      for (let i = 0; i < pellets; i++) {
        const d = dir.clone();
        if (spread > 0) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * Math.tan(spread);
          d.addScaledVector(up, Math.sin(a) * r).addScaledVector(right, Math.cos(a) * r).normalize();
        }
        const shotIndex = (this._shots = (this._shots ?? 0) + 1);
        this.hitscan(origin, d, w, { tracer: w.tracerEvery && shotIndex % w.tracerEvery === 0 ? muzzleW : null, attacker: 'player' });
      }
    }
    // feedback
    this.bloom = Math.min(6, this.bloom + (w.recoil ?? 1) * 0.35);
    const rk = (w.recoil ?? 1) * (1 - 0.45 * this.adsBlend) * (p.crouched ? 0.75 : 1);
    if (this.vr) this.vr.recoil(w, rk);
    else {
      p.recoilPitch += rk * 0.012;
      p.pitch += rk * 0.004; // a part of the recoil stays (you have to pull down)
      p.recoilYaw += (Math.random() - 0.5) * rk * 0.008;
      this.kick = Math.min(1, this.kick + 0.4 + rk * 0.1);
      this.flashT = 0.05;
      g.input.rumble(w.type === 'launcher' ? 0.9 : 0.12 * rk, 0.25 + 0.1 * rk, w.type === 'launcher' ? 250 : 70);
    }
    g.effects.muzzleFlash(muzzleW, dir, w.type === 'launcher' ? 0.4 : 0.16);
    g.audio?.play(w.sound, { volume: 0.9, priority: 2 });
    g.ai?.noise(p.pos, w.noise ?? 100, 'gunshot');
    g.stats.shots++;
    if (this.clip[id] <= 0 && (this.ammo[w.ammo] ?? 0) > 0 && !this.vr) setTimeout(() => this.state === 'idle' && this.currentId === id && this._reload(), 250);
    if (w.boltSound) setTimeout(() => g.audio?.play(w.boltSound, { volume: 0.5 }), 350);
    if (w.pumpSound) setTimeout(() => g.audio?.play(w.pumpSound, { volume: 0.5 }), 300);
    g.hud?.refreshWeapon();
  }

  /**
   * Resolve one bullet: nearest of actor hitboxes, vehicles, world shapes, terrain, water.
   * Used by the player and the AI. Returns { kind, point, actor?, part? } or null.
   */
  hitscan(origin, dir, w, { tracer = null, attacker = null, ignoreActor = null, damageMul = 1 } = {}) {
    const g = this.game;
    const range = w.range ?? 200;
    _ray.set(origin, dir);
    const world = g.world.physics.raycast(origin, dir, range, { water: true, ignore: ignoreActor?.id });
    let best = world ? world.dist : range;
    let hitActor = null;
    const ah = g.actors?.raycast(_ray, best, ignoreActor);
    if (ah) { best = ah.d; hitActor = ah; }
    let hitPlayer = false;
    if (attacker !== 'player' && g.player.alive) {
      const pd = g.player.alive ? rayPlayer(_ray, g.player, best) : -1;
      if (pd >= 0) { best = pd; hitPlayer = true; hitActor = null; }
    }
    if (attacker === 'player') g.birds?.shoot(_ray, best); // a bird in the way dies, the bullet goes on
    const point = origin.clone().addScaledVector(dir, best);
    // damage falloff
    const fo = w.falloff;
    const fall = fo ? THREE.MathUtils.lerp(1, fo[2], THREE.MathUtils.clamp((best - fo[0]) / (fo[1] - fo[0]), 0, 1)) : 1;
    let result = null;
    if (hitPlayer) {
      g.player.damage(w.damage * fall * damageMul, origin, 'bullet');
      result = { kind: 'player', point };
    } else if (hitActor) {
      const a = hitActor.actor;
      const mul = hitActor.part === 'head' ? (w.headshot ?? 2) : hitActor.part === 'limb' ? 0.75 : 1;
      a.damage(w.damage * fall * mul * damageMul, origin, { part: hitActor.part, attacker, point, dir });
      g.effects.impact(point, _v.copy(dir).negate(), 'flesh', { sound: attacker === 'player' });
      result = { kind: 'actor', actor: a, part: hitActor.part, point };
      if (attacker === 'player') g.hud?.hitMarker(!a.alive, hitActor.part === 'head');
    } else if (world) {
      const n = { x: world.nx, y: world.ny, z: world.nz };
      g.effects.impact(point, n, world.material ?? (world.kind === 'terrain' ? terrainFx(g, point) : 'wood'), { decal: world.kind !== 'water' });
      if (world.shape?.owner) g.onShapeHit?.(world.shape, w.damage * fall * damageMul, point, attacker);
      result = { kind: world.kind, point, shape: world.shape };
    }
    if (tracer) g.effects.tracer(tracer, point, { color: attacker === 'player' ? 0xfff0b0 : 0xffb070, width: 0.03 });
    // bullets passing near the player
    if (attacker !== 'player' && !hitPlayer && g.player.alive) {
      const e = g.player.eye;
      if (_ray.distanceSqToPoint(e) < 4 && Math.random() < 0.6) g.audio?.play('bullet_whizz', { position: e, volume: 0.6 });
    }
    return result;
  }

  _muzzleWorld() {
    // project the view-model muzzle onto the world: a point in front of the camera, slightly right/down
    const cam = this.game.engine.camera;
    const local = new THREE.Vector3(0.12 * (1 - this.adsBlend), -0.1 * (1 - this.adsBlend) - 0.03, -0.7);
    return local.applyMatrix4(cam.matrixWorld);
  }

  // --- reload ------------------------------------------------------------------------------
  _reload() {
    const w = this.current, id = this.currentId;
    if (!w || w.type === 'melee' || this.state === 'reloading') return;
    if (this.clip[id] >= w.mag || (this.ammo[w.ammo] ?? 0) <= 0) return;
    this.state = 'reloading';
    this.stateT = 0;
    this.reloadDur = w.reloadPerShell ? w.reload : w.reload;
    if (!w.reloadPerShell) this.game.audio?.play('reload_mag_out', { volume: 0.5 });
    this._magInPlayed = false;
    this._reloadFromEmpty = this.clip[id] <= 0; // shells: rack the pump once the last one is in
  }

  _updateReload() {
    const w = this.current, id = this.currentId;
    if (!w) { this.state = 'idle'; return; }
    if (!this._magInPlayed && this.stateT > this.reloadDur * 0.6) { this._magInPlayed = true; this.game.audio?.play(w.reloadPerShell ? 'shotgun_shell' : 'reload_mag_in', { volume: 0.5 }); }
    if (this.stateT < this.reloadDur) return;
    const need = w.mag - this.clip[id];
    const take = Math.min(w.reloadPerShell ? 1 : need, this.ammo[w.ammo] ?? 0);
    this.clip[id] += take;
    this.ammo[w.ammo] -= take;
    this.game.hud?.refreshWeapon();
    if (w.reloadPerShell && this.clip[id] < w.mag && this.ammo[w.ammo] > 0 && !this.game.input.down('fire')) {
      this.stateT = 0;
      this._magInPlayed = false;
      return;
    }
    if (w.reloadPerShell && this._reloadFromEmpty && w.pumpSound) this.game.audio?.play(w.pumpSound, { volume: 0.5 });
    this.state = 'idle';
  }

  // --- melee -------------------------------------------------------------------------------
  _melee(w, quick = false) {
    const g = this.game, p = g.player;
    this.state = 'melee';
    this.stateT = 0;
    this._meleeDur = quick ? 0.55 : w.rate ?? 0.5;
    this.fireCd = this._meleeDur;
    this.meleeSwing = 1;
    g.audio?.play(w.sound ?? 'machete_swing', { volume: 0.6 });
    setTimeout(() => {
      const fwd = p.forward();
      const eye = p.eye;
      let best = null, bd = (w.range ?? 2.2) + 0.4;
      for (const a of g.actors?.list ?? []) {
        if (!a.alive) continue;
        _v.set(a.pos.x - eye.x, 0, a.pos.z - eye.z);
        const d = _v.length();
        if (d > bd || Math.abs(a.pos.y + 1 - eye.y) > 1.8) continue;
        if (_v.normalize().dot(fwd) < 0.55) continue;
        best = a; bd = d;
      }
      if (best) this.meleeStrike(best, w, fwd, eye);
      else {
        // hit the world (plants, walls)
        const cam = g.engine.camera;
        const o = cam.getWorldPosition(new THREE.Vector3()), d = cam.getWorldDirection(new THREE.Vector3());
        const h = g.world.physics.raycast(o, d, w.range ?? 2.2);
        if (h) { g.effects.impact(new THREE.Vector3(h.x, h.y, h.z), { x: h.nx, y: h.ny, z: h.nz }, h.material ?? 'wood'); }
      }
      g.ai?.noise(p.pos, 6, 'melee');
    }, (w.hitDelay ?? 0.12) * 1000);
  }

  /** A melee hit on `target` coming along `fwd` from `from`: a takedown when it doesn't see us
   *  coming (not in combat, or hit from behind). */
  meleeStrike(target, w, fwd, from) {
    const g = this.game;
    const back = _v2.set(Math.sin(target.heading), 0, Math.cos(target.heading)).dot(fwd) > 0.3;
    const stealth = !target.ai || target.ai.state !== 'combat' || back;
    const dmg = stealth ? (w.stealthDamage ?? 999) : w.damage ?? 50;
    target.damage(dmg, from, { part: 'body', attacker: 'player', melee: true, stealth, dir: fwd });
    g.effects.impact(target.pos.clone().setY(target.pos.y + 1.3), _v.copy(fwd).negate(), 'flesh');
    g.audio?.play(w.hitSound ?? 'machete_hit', { volume: 0.7 });
    g.hud?.hitMarker(!target.alive, false);
    if (stealth && !target.alive) g.stats.takedowns++;
  }

  // --- grenades & rockets ------------------------------------------------------------------
  _throwGrenade() {
    const g = this.game, gd = this.data.grenade, cam = g.engine.camera;
    if (!g.cheats?.infiniteAmmo) this.grenades--;
    this.state = 'throwing';
    this.stateT = 0;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const pos = cam.getWorldPosition(new THREE.Vector3()).addScaledVector(dir, 0.5).add(new THREE.Vector3(0, -0.15, 0));
    const vel = dir.multiplyScalar(gd.throwSpeed).add(new THREE.Vector3(0, gd.lift, 0)).add(g.player.vel.clone().multiplyScalar(0.5));
    this.spawnGrenade(pos, vel, 'player');
    g.hud?.refreshWeapon();
  }

  spawnGrenade(pos, vel, owner, fuse) {
    const g = this.game, gd = this.data.grenade;
    const mesh = this._projectileMesh(gd.asset, 0.12);
    mesh.position.copy(pos);
    g.engine.scene.add(mesh);
    this.projectiles.push({ kind: 'grenade', mesh, pos: mesh.position, vel: vel.clone(), fuse: fuse ?? gd.fuse, owner, spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, 0) });
  }

  _spawnRocket(w, pos, dir) {
    const pr = w.projectile;
    const mesh = this._projectileMesh(pr.asset, 0.6);
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    this.game.engine.scene.add(mesh);
    this.projectiles.push({ kind: 'rocket', mesh, pos: mesh.position, vel: dir.clone().multiplyScalar(pr.speed), w, owner: 'player', life: pr.maxRange / pr.speed, gravity: pr.gravity ?? 0 });
  }

  /** AI rockets / grenades reuse the same simulation. */
  spawnRocketFrom(pos, dir, w, owner) {
    const pr = w.projectile;
    const mesh = this._projectileMesh(pr.asset, 0.6);
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    this.game.engine.scene.add(mesh);
    this.projectiles.push({ kind: 'rocket', mesh, pos: mesh.position, vel: dir.clone().multiplyScalar(pr.speed * 0.8), w, owner, life: pr.maxRange / pr.speed, gravity: pr.gravity ?? 0 });
  }

  _projectileMesh(asset, fallbackSize) {
    const assets = this.game.world.assets;
    let mesh;
    if (assets.has(asset)) {
      const b = assets.build(asset, { quality: 1 });
      mesh = new THREE.Mesh(b.geometry, assets.material(b));
    } else mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(fallbackSize / 2, 0), new THREE.MeshLambertMaterial({ color: 0x3a4a2a }));
    mesh.layers.set(LAYERS.DYNAMIC);
    return mesh;
  }

  _updateProjectiles(dt) {
    const g = this.game, phys = g.world.physics;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      let dead = false;
      if (pr.kind === 'grenade') {
        const gd = this.data.grenade;
        pr.fuse -= dt;
        pr.vel.y -= gd.gravity * dt;
        const len = pr.vel.length() * dt;
        if (len > 1e-5) {
          _v.copy(pr.vel).normalize();
          const h = phys.raycast(pr.pos, _v, len + 0.06);
          if (h) {
            pr.pos.set(h.x + h.nx * 0.07, h.y + h.ny * 0.07, h.z + h.nz * 0.07);
            const n = _v2.set(h.nx, h.ny, h.nz);
            const vn = pr.vel.dot(n);
            pr.vel.addScaledVector(n, -vn * (1 + gd.bounce)).multiplyScalar(0.7);
            if (Math.abs(vn) > 2) g.audio?.play('grenade_bounce', { position: pr.pos, volume: 0.5 });
            if (h.ny > 0.6 && pr.vel.length() < 1) pr.vel.multiplyScalar(0.5);
          } else pr.pos.addScaledVector(pr.vel, dt);
        }
        if (g.world.terrain.waterLevelAt(pr.pos.x, pr.pos.z) > pr.pos.y) pr.vel.multiplyScalar(1 - 3 * dt);
        pr.mesh.rotation.x += pr.spin.x * dt; pr.mesh.rotation.y += pr.spin.y * dt;
        if (pr.fuse <= 0) { this.explode(pr.pos.clone(), gd.radius, gd.damage, pr.owner); dead = true; }
      } else {
        pr.life -= dt;
        pr.vel.y -= pr.gravity * dt;
        const len = pr.vel.length() * dt;
        _v.copy(pr.vel).normalize();
        _ray.set(pr.pos, _v);
        const h = phys.raycast(pr.pos, _v, len, { water: true });
        const ah = g.actors?.raycast(_ray, h ? h.dist : len, null);
        let hitPlayer = false;
        if (pr.owner !== 'player' && g.player.alive) hitPlayer = rayPlayer(_ray, g.player, h ? h.dist : len) >= 0;
        if (h || ah || hitPlayer || pr.life <= 0) {
          const d = ah ? ah.d : h ? h.dist : len;
          const at = pr.pos.clone().addScaledVector(_v, Math.max(0, d - 0.2));
          this.explode(at, pr.w.radius, pr.w.damage, pr.owner);
          dead = true;
        } else {
          pr.pos.addScaledVector(pr.vel, dt);
          pr.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), _v);
          g.effects.burst(pr.pos, { count: 1, color: 0x8a8580, speed: 0.4, life: 0.9, size: 0.15, grow: 0.5, gravity: -0.5 });
          g.effects.fire(pr.pos, 0.4);
        }
      }
      if (dead) {
        pr.mesh.removeFromParent();
        this.projectiles.splice(i, 1);
      }
    }
  }

  /** Radial damage with line of sight, effects, AI noise, chain reactions (explosive props). */
  explode(pos, radius, damage, owner) {
    const g = this.game;
    g.effects.explosion(pos, radius);
    const camD = g.engine.camera.position.distanceTo(pos);
    g.audio?.play(camD > 120 ? 'explosion_far' : 'explosion', { position: pos, volume: 1, priority: 3 });
    g.ai?.noise(pos, 200, 'explosion');
    const phys = g.world.physics;
    const los = (target) => {
      _v.subVectors(target, pos);
      const d = _v.length();
      if (d < 0.5) return true;
      _v.divideScalar(d);
      return !phys.raycast(pos, _v, d - 0.3, { terrain: true });
    };
    for (const a of g.actors?.list ?? []) {
      if (!a.alive) continue;
      const c = a.pos.clone().setY(a.pos.y + 1);
      const d = c.distanceTo(pos);
      if (d > radius || !los(c)) continue;
      const k = 1 - d / radius;
      a.damage(damage * (0.15 + 0.85 * k), pos, { part: 'body', attacker: owner, explosion: true, dir: c.clone().sub(pos).normalize() });
      if (!a.alive && owner === 'player') g.hud?.hitMarker(true, false);
    }
    const p = g.player;
    if (p.alive) {
      const c = p.eye.clone().setY(p.pos.y + 1);
      const d = c.distanceTo(pos);
      if (d < radius && los(c)) {
        const k = 1 - d / radius;
        // enemy rockets / grenades never one-shot a healthy player (direct RPG hit = 78 on normal)
        p.damage(damage * (0.1 + 0.9 * k) * (owner === 'player' ? 0.5 : 0.3 * (g.difficulty?.aiDamage ?? 1)), pos, 'explosion');
        p.vel.add(c.sub(pos).normalize().multiplyScalar(6 * k)).setY(p.vel.y + 3 * k);
      }
    }
    g.onExplosion?.(pos, radius, owner);
  }

  // --- view model animation ----------------------------------------------------------------
  _animateVM(dt) {
    const g = this.game, p = g.player, w = this.current;
    const vm = this.vm;
    // match the world lighting
    this.vmLight.update();
    const showVM = p.alive && !p.inVehicle && !!w && !(w.scope && this.adsBlend > 0.85) && !g.binoculars?.active;
    vm.visible = showVM;
    // camera fov: ADS zoom, sprint widen
    const cam = g.engine.camera;
    const baseFov = p.sprinting ? p.cfg.sprintFov : p.cfg.fov;
    const fov = THREE.MathUtils.lerp(baseFov, w?.adsFov ?? baseFov, this.adsBlend * (w?.scope ? 1 : 0.7)) * (g.binoculars?.active ? 0.25 : 1);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 14); cam.updateProjectionMatrix(); }
    if (!w || !this.vmInfo) return;
    const view = w.view ?? { pos: [0.2, -0.25, -0.5], rot: [0, 0, 0] };
    const hip = _v.set(...view.pos);
    const ads = _v2.set(-this.vmInfo.sight.x, -this.vmInfo.sight.y, -(view.adsDist ?? 0.32));
    const t = this.adsBlend;
    const target = hip.lerp(ads, t * t * (3 - 2 * t));
    // bob & sway
    const bob = p.bobAmount * (1 - t * 0.85);
    target.x += Math.cos(p.bob) * 0.012 * bob;
    target.y += Math.abs(Math.sin(p.bob)) * 0.018 * bob - (p.sprinting ? 0.06 : 0);
    target.z += this.kick * 0.06;
    // switching: lower out / raise in
    let lower = 0;
    if (this.state === 'switching') lower = this.stateT < 0.22 ? this.stateT / 0.22 : 1 - (this.stateT - 0.22) / 0.23;
    if (this.state === 'throwing') lower = Math.sin(Math.min(1, this.stateT / 0.5) * Math.PI) * 0.8;
    target.y -= lower * 0.35;
    // reload dip / melee swing (part of the target: subtracting them from the eased position every
    // frame made the weapon sink out of the view at high frame rates)
    const reloadK = this.state === 'reloading' ? Math.sin(Math.min(1, this.stateT / this.reloadDur) * Math.PI) : 0;
    const meleeS = this.state === 'melee' ? Math.sin(Math.min(1, this.stateT / (this._meleeDur ?? 0.45)) * Math.PI) : 0;
    target.y -= reloadK * 0.04;
    target.x -= meleeS * 0.15;
    this.vmRoot.position.lerp(target, Math.min(1, dt * 18));
    // rotation: reload tilt, melee swing, recoil, sprint
    let rx = (view.rot[0] ?? 0) * D2R + this.kick * 0.12, ry = (view.rot[1] ?? 0) * D2R, rz = (view.rot[2] ?? 0) * D2R;
    rx -= reloadK * 0.22; rz += reloadK * 0.5;
    ry += meleeS * 1.1; rx -= meleeS * 0.6; rz -= meleeS * 0.4;
    if (p.sprinting) { ry += 0.5; rz += 0.25; rx -= 0.15; }
    ry *= 1 - t; rz *= 1 - t;
    this.vmRoot.rotation.x += (rx - this.vmRoot.rotation.x) * Math.min(1, dt * 16);
    this.vmRoot.rotation.y += (ry - this.vmRoot.rotation.y) * Math.min(1, dt * 16);
    this.vmRoot.rotation.z += (rz - this.vmRoot.rotation.z) * Math.min(1, dt * 16);
    // hands on the grips; reloads: the left hand leaves the weapon (new magazine / shell) and comes back
    if (this.arms?.visible && vm.visible) {
      let leftAway = 0;
      if (this.state === 'reloading') {
        const k = Math.min(1, this.stateT / this.reloadDur), ss = THREE.MathUtils.smoothstep;
        leftAway = w.reloadPerShell ? Math.sin(k * Math.PI) : ss(k, 0.05, 0.3) * (1 - ss(k, 0.65, 0.9));
      }
      vm.camera.updateMatrixWorld(true);
      this.arms.update(this.vmGroup, this.vmInfo.hands, { leftAway, awayOffset: w.reloadPerShell ? RELOAD_SHELL : RELOAD_MAG });
    }
    // muzzle flash
    this.flashT = Math.max(0, (this.flashT ?? 0) - dt);
    this.flash.visible = this.flashT > 0 && w.type !== 'melee';
    if (this.flash.visible) this.flash.scale.setScalar(0.7 + Math.random() * 0.8);
  }
}

/** Ray vs the player's body (capsule, feet -> head). */
function rayPlayer(ray, p, maxD) {
  const a = new THREE.Vector3(p.pos.x, p.pos.y + 0.35, p.pos.z), b = new THREE.Vector3(p.pos.x, p.pos.y + p.height - 0.2, p.pos.z);
  const d = capsuleHit(ray.origin, ray.direction, a, b, 0.38);
  return d >= 0 && d < maxD ? d : -1;
}

const _ba = new THREE.Vector3(), _oa = new THREE.Vector3(), _oc = new THREE.Vector3();
function capsuleHit(ro, rd, pa, pb, r) {
  _ba.subVectors(pb, pa); _oa.subVectors(ro, pa);
  const baba = _ba.dot(_ba), bard = _ba.dot(rd), baoa = _ba.dot(_oa), rdoa = rd.dot(_oa), oaoa = _oa.dot(_oa);
  const a = baba - bard * bard;
  if (a > 1e-9) {
    const b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - r * r * baba;
    const h = b * b - a * c;
    if (h < 0) return -1;
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t;
    _oc.copy(y <= 0 ? _oa : _oc.subVectors(ro, pb));
  } else _oc.copy(baoa <= 0 ? _oa : _oc.subVectors(ro, pb));
  const b = rd.dot(_oc), c = _oc.dot(_oc) - r * r, h = b * b - c;
  return h > 0 ? -b - Math.sqrt(h) : -1;
}

function terrainFx(g, p) {
  const m = g.world.terrain.materialAtWorld(p.x, p.z);
  return { 1: 'sand', 2: 'sand', 9: 'sand', 6: 'stone', 7: 'stone', 13: 'concrete' }[m] ?? 'ground';
}
void _q;
