// NPC bodies: an animated character (+ held weapon), health / damage / death, loot,
// movement with collision, animation selection, and distance LODs (animation rate, visibility,
// sleeping AI far away). The brain lives in AI.js.
import * as THREE from 'three';
import { AIBrain } from './AI.js';
import { LAYERS } from '../../engine/render/layers.js';
import { archetypeModel } from '../../engine/anim/Characters.js';

const _v = new THREE.Vector3(), _ray = new THREE.Ray();
let actorSeq = 0;

export class Actor {
  constructor(game, data, arch) {
    this.game = game;
    this.data = data; // the entity (world.json) or a spawned definition
    this.id = data.id ?? `actor_${++actorSeq}`;
    this.arch = arch;
    this.group = data.group;
    this.team = arch.civilian ? 'civilian' : data.team ?? 'merc';
    const lib = game.characters;
    const model = data.model ?? archetypeModel(arch, this.id); // story NPCs pick theirs
    const tpl = arch.palette && game.data.archetypes.palettes?.[arch.palette] ? lib.variant(model, game.data.archetypes.palettes[arch.palette], arch.palette) : model;
    this.character = lib.create(tpl);
    this.root = this.character.root;
    if (arch.scale) this.character.model.scale.multiplyScalar(arch.scale);
    this.pos = this.root.position;
    // frozen actors skip the scene-wide matrix update entirely (three still recurses into children
    // when matrixWorldAutoUpdate is false); they refresh at their animation rate instead
    const baseUpdate = THREE.Object3D.prototype.updateMatrixWorld;
    this.frozen = false;
    this.root.updateMatrixWorld = (force) => { if (!this.frozen || this._thaw) baseUpdate.call(this.root, force); };
    this.pos.fromArray(data.pos ?? [0, 0, 0]);
    this.pos.y = game.world.physics.groundAt(this.pos.x, this.pos.z, 0.3, this.pos.y + 1);
    this.heading = ((data.rot?.[1] ?? 0) * Math.PI) / 180 + Math.PI; // the character models face +Z
    this.root.rotation.y = this.heading;
    this.vel = new THREE.Vector3();
    this.health = this.maxHealth = arch.health ?? 100;
    this.armor = arch.armor ?? 0;
    this.alive = true;
    this.radius = 0.35;
    this.moveTarget = null; // { x, z } to walk / run to
    this.moveSpeed = 0;
    this.faceTarget = null; // Vector3 to look at (overrides heading from movement)
    this.anim = 'Idle';
    this.aiming = false;
    this.crouching = false;
    this.flinchT = 0;
    this.deadT = 0;
    this.lodT = 0;
    this.visibleDist = 280;
    game.engine.scene.add(this.root);
    // held weapon
    this.weapon = arch.weapon ? game.data.weapons.weapons[arch.weapon] : null;
    if (this.weapon) this._attachWeapon();
    this.ai = arch.civilian ? new AIBrain(this, { civilian: true }) : new AIBrain(this);
    this.tagged = false;
  }

  _attachWeapon() {
    const assets = this.game.world.assets;
    const w = this.weapon;
    if (!assets.has(w.asset)) return;
    const b = assets.build(w.asset, { quality: 0.5 });
    const mesh = new THREE.Mesh(b.geometry, assets.material(b));
    const holder = this.character.attachToHand(mesh);
    if (!holder) return;
    holder.quaternion.copy(this.character.solveGrip('Pistol_Aim_Neutral'));
    holder.position.copy(this.character.grip.R);
    const def = assets.get(w.asset);
    this.muzzleLocal = new THREE.Vector3(...(def.muzzle ?? [0, 0.05, b.bounds.min.z]));
    this.weaponMesh = mesh;
    mesh.layers.set(LAYERS.DYNAMIC);
  }

  get eye() { return _v.set(this.pos.x, this.pos.y + (this.crouching ? 1.05 : 1.62), this.pos.z); }
  eyePos(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + (this.crouching ? 1.05 : 1.62), this.pos.z); }
  chest(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + (this.crouching ? 0.8 : 1.25), this.pos.z); }
  forward(out = new THREE.Vector3()) { return out.set(Math.sin(this.heading), 0, Math.cos(this.heading)); }

  muzzleWorld(out = new THREE.Vector3()) {
    if (this.weaponMesh && this.muzzleLocal) return out.copy(this.muzzleLocal).applyMatrix4(this.weaponMesh.matrixWorld);
    return this.chest(out).addScaledVector(this.forward(_v), 0.5);
  }

  damage(amount, from, info = {}) {
    if (!this.alive) return;
    const g = this.game;
    let dmg = amount * (1 - (info.explosion || info.melee ? 0 : this.armor));
    if (g.cheats?.oneShot && info.attacker === 'player') dmg = this.health;
    this.health -= dmg;
    this.lastHitT = g.time;
    if (info.attacker === 'player') g.stats.hits++;
    if (this.health <= 0) { this.die(info); return; }
    this.flinchT = 0.35;
    this.character.play(Math.random() < 0.5 ? 'HitRecieve' : 'HitRecieve_2', { once: true, fade: 0.06, speed: 1.4 });
    this.ai?.onDamaged(from, info);
  }

  die(info = {}) {
    if (!this.alive) return;
    const g = this.game;
    this.alive = false;
    this.health = 0;
    this.deadT = 0;
    this.character.setAimPitch?.(0, 1);
    if (this.character.aimUp) { this.character.aimUp.setEffectiveWeight(0); this.character.aimDown.setEffectiveWeight(0); }
    this.character.play('Death', { once: true, fade: 0.1 });
    // knockback on explosions
    if (info.explosion && info.dir) this.deathPush = info.dir.clone().multiplyScalar(4).setY(0);
    this.ai?.onDeath(info);
    g.audio?.play('body_fall', { position: this.pos, volume: 0.6 });
    g.onActorKilled?.(this, info);
    this._dropLoot();
  }

  _dropLoot() {
    const g = this.game;
    this._dropWeapon();
    for (const l of this.arch.loot ?? []) {
      if (Math.random() > l.chance) continue;
      const a = Math.random() * Math.PI * 2;
      g.spawnPickup?.(l.item, [this.pos.x + Math.cos(a) * 0.8, this.pos.y + 0.1, this.pos.z + Math.sin(a) * 0.8], { temporary: 90 });
    }
  }

  /** The held weapon always falls next to the body (Far Cry style), more or less loaded. */
  _dropWeapon() {
    const g = this.game, w = this.weapon, items = g.data.items.items;
    const itemId = w && Object.keys(items).find((k) => items[k].weapon === this.arch.weapon);
    if (!itemId) return;
    if (this.weaponMesh) this.weaponMesh.visible = false;
    // on the weapon-hand side, clear of the falling body
    if (this.weaponMesh) this.weaponMesh.getWorldPosition(_v).sub(this.pos).setY(0);
    else _v.set(0, 0, 0);
    if (_v.lengthSq() < 0.01) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    _v.normalize().multiplyScalar(0.9).add(this.pos);
    const y = g.world.physics.groundAt(_v.x, _v.z, 0.1, this.pos.y + 1);
    const rounds = w.mag ? Math.max(1, Math.round(w.mag * (0.3 + Math.random() * 0.7))) : 0;
    g.spawnPickup?.(itemId, [_v.x, y, _v.z], { temporary: 90, still: true, rounds, rot: [0, Math.random() * 360, 0] });
  }

  /** Movement + animation, called every frame (AI thinking is throttled inside the brain). */
  update(dt, distToCam) {
    const g = this.game;
    // distance LOD: far / dormant actors leave the scene graph (no matrix updates, no culling
    // work); mid-range ones only refresh their bone matrices when their animation ticks
    const far = distToCam > this.visibleDist || this.ai?.dormant;
    if (far && this.root.parent) this.root.removeFromParent();
    else if (!far && !this.root.parent) g.engine.scene.add(this.root);
    this.root.visible = !far;
    const autoMatrix = distToCam < 20 || !this.alive && this.deadT < 3 && distToCam < 60;
    this.frozen = !autoMatrix;
    if (!this.alive) {
      this.deadT += dt;
      if (this.deathPush) { this.pos.addScaledVector(this.deathPush, dt); this.deathPush.multiplyScalar(Math.max(0, 1 - 4 * dt)); }
      if (this.deadT < 3) this.character.update(dt);
      if (this.frozen && this.deadT < 3.5) this._refreshMatrices();
      if (this.deadT > 60 && distToCam > 40) this.removeMe = true;
      return;
    }
    const thinkDt = this.ai.update(dt, distToCam);
    void thinkDt;
    this.flinchT -= dt;
    // locomotion toward moveTarget
    let speed = 0;
    if (this.moveTarget && this.flinchT <= 0) {
      const dx = this.moveTarget.x - this.pos.x, dz = this.moveTarget.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.3) {
        speed = Math.min(this.moveSpeed, d * 3);
        this.vel.x += ((dx / d) * speed - this.vel.x) * Math.min(1, dt * 8);
        this.vel.z += ((dz / d) * speed - this.vel.z) * Math.min(1, dt * 8);
      } else { this.vel.x *= 0.5; this.vel.z *= 0.5; this.ai.onReached?.(); }
    } else { this.vel.x *= Math.max(0, 1 - dt * 10); this.vel.z *= Math.max(0, 1 - dt * 10); }
    const moved = Math.hypot(this.vel.x, this.vel.z);
    if (moved > 0.01) {
      const px = this.pos.x, pz = this.pos.z;
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      if (distToCam < 250) g.world.physics.collideCylinder(this.pos, this.radius, 1.7, 0.45);
      // other actors
      for (const o of g.actors.near(this.pos, 1.5)) {
        if (o === this || !o.alive) continue;
        const ox = this.pos.x - o.pos.x, oz = this.pos.z - o.pos.z, d2 = ox * ox + oz * oz;
        if (d2 < 0.49 && d2 > 1e-6) { const d = Math.sqrt(d2); this.pos.x += (ox / d) * (0.7 - d) * 0.5; this.pos.z += (oz / d) * (0.7 - d) * 0.5; }
      }
      this.stuck = Math.hypot(this.pos.x - px, this.pos.z - pz) < moved * dt * 0.25 ? (this.stuck ?? 0) + dt : 0;
      const ground = g.world.physics.groundAt(this.pos.x, this.pos.z, 0.25, this.pos.y + 0.6);
      this.pos.y += (ground - this.pos.y) * Math.min(1, dt * 15);
    }
    // facing
    let want = this.heading;
    if (this.faceTarget) want = Math.atan2(this.faceTarget.x - this.pos.x, this.faceTarget.z - this.pos.z);
    else if (moved > 0.3) want = Math.atan2(this.vel.x, this.vel.z);
    let dh = want - this.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.heading += dh * Math.min(1, dt * (this.faceTarget ? 8 : 5));
    this.root.rotation.y = this.heading;
    this.speed = moved;
    // animation (skipped when far: update the mixer at a lower rate)
    this._pickAnim(moved);
    this.lodT += dt;
    const rate = distToCam < 20 ? 0 : distToCam < 60 ? 1 / 30 : distToCam < 120 ? 1 / 15 : distToCam < 200 ? 1 / 8 : 1 / 4;
    if (!far && this.lodT >= rate) {
      if (this.aiming) {
        const tgt = this.faceTarget;
        const pitch = tgt ? Math.atan2(tgt.y - (this.pos.y + 1.4), Math.max(1.5, Math.hypot(tgt.x - this.pos.x, tgt.z - this.pos.z))) : 0;
        this.character.setAimPitch(THREE.MathUtils.clamp(pitch / (Math.PI / 2), -1, 1), this.lodT);
      } else if (this.character.aimUp) this.character.setAimPitch(0, this.lodT);
      this.character.update(this.lodT);
      this.lodT = 0;
      if (!autoMatrix) this._refreshMatrices();
    }
  }

  _refreshMatrices() {
    this._thaw = true;
    this.root.updateMatrixWorld(true);
    this._thaw = false;
  }

  _pickAnim(speed) {
    if (this.flinchT > 0) return;
    const c = this.character;
    const armed = !!this.weapon;
    let a;
    if (this.ai.swimming) a = speed > 0.5 ? 'Swim_Fwd_Loop' : 'Swim_Idle_Loop';
    else if (this.crouching) a = armed && this.aiming ? (speed > 0.4 ? 'Crouch_Fwd_Aim' : 'Crouch_Idle_Aim') : speed > 0.4 ? 'Crouch_Fwd_Loop' : 'Crouch_Idle_Loop';
    else if (speed > 3.2) a = armed && this.aiming ? 'Jog_Aim' : armed ? 'Run_Shoot' : 'Run';
    else if (speed > 0.4) a = armed && this.aiming ? 'Walk_Aim' : 'Walk';
    else if (armed && this.aiming) a = 'Pistol_Idle_Loop';
    else a = this.idleAnim ?? (armed ? 'Idle_Gun' : 'Idle');
    if (!c.actions[a]) a = 'Idle';
    const sp = speed > 0.4 && (a.startsWith('Walk') || a.startsWith('Jog') || a === 'Run' || a === 'Run_Shoot' || a.startsWith('Crouch_Fwd')) ? THREE.MathUtils.clamp(speed / (a.startsWith('Walk') ? 1.7 : a.startsWith('Crouch') ? 1.4 : 4.4), 0.6, 1.6) : 1;
    c.play(a, { fade: 0.2, speed: sp });
  }

  dispose() {
    this.character.dispose();
  }
}

export class ActorManager {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.byId = new Map();
    this.grid = new Map(); // 16 m buckets rebuilt each frame (neighbour queries)
  }

  spawn(data, archName) {
    const arch = this.game.data.archetypes.archetypes[archName ?? data.archetype];
    if (!arch) { console.warn('unknown archetype', archName ?? data.archetype); return null; }
    const a = new Actor(this.game, data, arch);
    this.list.push(a);
    this.byId.set(a.id, a);
    return a;
  }

  remove(a) {
    const i = this.list.indexOf(a);
    if (i >= 0) this.list.splice(i, 1);
    this.byId.delete(a.id);
    a.dispose();
  }

  get(id) { return this.byId.get(id); }
  byGroup(group) { return this.list.filter((a) => a.group === group); }
  aliveInGroup(group) { return this.list.filter((a) => a.group === group && a.alive); }

  near(p, r) {
    const out = [];
    const c0 = Math.floor((p.x - r) / 16), c1 = Math.floor((p.x + r) / 16), d0 = Math.floor((p.z - r) / 16), d1 = Math.floor((p.z + r) / 16);
    for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) { const l = this.grid.get(cx * 4096 + cz); if (l) out.push(...l); }
    return out;
  }

  /** Nearest actor hitbox hit by a ray: { actor, part, d } */
  raycast(ray, maxD = Infinity, ignore = null) {
    let best = null;
    for (const a of this.list) {
      if (!a.alive || a === ignore || !a.root.visible) continue;
      _v.copy(a.pos).y += 0.9;
      const t = _v.clone().sub(ray.origin).dot(ray.direction);
      if (t < -1.5 || t > maxD + 1.5) continue;
      if (ray.distanceSqToPoint(_v) > 1.5 * 1.5) continue;
      // hitboxes use the bone matrices of the last rendered frame (what the shooter saw): no
      // forced skeleton update per bullet
      const h = a.character.raycastHitboxes(ray, 0, best ? best.d : maxD);
      if (h) best = { actor: a, part: h.part, d: h.d };
    }
    return best;
  }

  update(dt) {
    const cam = this.game.engine.camera.position;
    this.grid.clear();
    for (const a of this.list) {
      const k = Math.floor(a.pos.x / 16) * 4096 + Math.floor(a.pos.z / 16);
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(a);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i];
      a.update(dt, a.pos.distanceTo(cam));
      if (a.removeMe) this.remove(a);
    }
  }

  clear() { for (const a of [...this.list]) this.remove(a); }
}
void _ray;
