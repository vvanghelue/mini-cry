// First-person player controller: walk / sprint / crouch / jump, swimming & diving, ladders,
// steep-slope sliding, fall damage, stamina, breath, health + armor with partial regeneration.
// The body is a vertical cylinder (feet at `pos`) collided against the static world.
import * as THREE from 'three';

const _wish = new THREE.Vector3(), _n = { x: 0, y: 1, z: 0 };
const UP = new THREE.Vector3(0, 1, 0);

export class Player {
  constructor(game, cfg) {
    this.game = game;
    this.cfg = cfg;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0; // added on top of pitch, recovers over time
    this.recoilYaw = 0;
    this.health = cfg.health;
    this.maxHealth = cfg.health;
    this.armor = cfg.armor ?? 0;
    this.stamina = 1;
    this.breath = 1;
    this.crouch = 0; // 0 standing .. 1 crouched (smoothed)
    this.crouched = false;
    this.onGround = true;
    this.swimming = false;
    this.underwater = false;
    this.onLadder = false;
    this.sprinting = false;
    this.alive = true;
    this.lastHurt = -99;
    this.fallStartY = null;
    this.bob = 0;
    this.bobAmount = 0;
    this.stepDist = 0;
    this.noise = 0; // how loud the player is right now (AI hearing), metres of audibility
    this.inVehicle = null;
    // VR (vr/VRLocomotion.js): the headset's eye position, the collider height from the head's,
    // and the gliding velocity (in place of the air physics)
    this.eyeOverride = null;
    this.heightOverride = null;
    this.flight = null;
    this.godMode = false;
    this.noclip = false;
    this.speed = 0;
    this.time = 0;
  }

  get eye() {
    if (this.eyeOverride) return this.eyeOverride.clone();
    const h = THREE.MathUtils.lerp(this.cfg.eyeHeight, this.cfg.crouchEyeHeight, this.crouch);
    return new THREE.Vector3(this.pos.x, this.pos.y + (this.swimming ? 0.25 : h), this.pos.z);
  }

  get height() { return this.heightOverride ?? THREE.MathUtils.lerp(this.cfg.height, this.cfg.crouchHeight, this.crouch); }

  forward(out = new THREE.Vector3()) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

  teleport(p, yaw) {
    this.pos.set(p[0] ?? p.x, p[1] ?? p.y, p[2] ?? p.z);
    const g = this.game.world.physics.groundAt(this.pos.x, this.pos.z, 0.3, this.pos.y + 1.5);
    this.pos.y = Math.max(this.pos.y, g);
    this.vel.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
    this.pitch = 0;
    this.fallStartY = null;
  }

  look(input, sensMul = 1) {
    const l = input.look();
    this.yaw += l.yaw * sensMul * (this.cfg.mouseSensitivity / 0.0022);
    this.pitch = THREE.MathUtils.clamp(this.pitch + l.pitch * sensMul * (this.cfg.mouseSensitivity / 0.0022), -1.5, 1.5);
  }

  /** Gamepad aim slowdown: the stick turns the view slower while the crosshair is close to an enemy. */
  _aimFriction() {
    const acts = this.game.actors?.list;
    if (!acts) return 1;
    const e = this.eye, cp = Math.cos(this.pitch);
    const fx = -Math.sin(this.yaw) * cp, fy = Math.sin(this.pitch), fz = -Math.cos(this.yaw) * cp;
    let best = 0;
    for (const a of acts) {
      if (!a.alive || a.team !== 'merc') continue;
      const dx = a.pos.x - e.x, dy = a.pos.y + (a.crouching ? 0.9 : 1.3) - e.y, dz = a.pos.z - e.z;
      const along = dx * fx + dy * fy + dz * fz;
      if (along < 1 || along > 120) continue;
      const off = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along)); // chest to the aim ray, m
      best = Math.max(best, 1 - THREE.MathUtils.smoothstep(off, 0.6 + along * 0.004, 1.6 + along * 0.012));
    }
    return 1 - 0.5 * best;
  }

  update(dt, input) {
    this.time += dt;
    const cfg = this.cfg, g = this.game;
    const physics = g.world.physics, T = g.world.terrain;
    if (!this.alive || this.inVehicle) { this.vel.set(0, 0, 0); return; }
    const sensMul = g.weapons?.adsBlend > 0.5 ? cfg.adsSensitivity * (g.weapons.current?.scope ? 0.45 : 1) : 1;
    if (input.active) this.look(input, sensMul * (input.device === 'pad' ? this._aimFriction() : 1)); else input.look();

    // recoil recovery
    const rr = Math.min(1, dt * (g.weapons?.current?.recoilRecover ?? 8));
    this.recoilPitch -= this.recoilPitch * rr;
    this.recoilYaw -= this.recoilYaw * rr;

    if (this.noclip) return this._noclip(dt, input);

    const { f, s } = input.move();
    const fwd = this.forward();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    _wish.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
    const moving = _wish.lengthSq() > 0;
    if (moving) _wish.multiplyScalar(Math.min(1, _wish.length()) / _wish.length()); // keys: unit length; analog stick: its tilt

    // water
    const wl = T.waterLevelAt(this.pos.x, this.pos.z);
    const depth = wl - this.pos.y;
    const wasSwimming = this.swimming;
    this.swimming = depth > 1.25 || (wasSwimming && depth > 1.05);
    if (this.swimming && !wasSwimming) input.unlatch('crouch'); // a crouch toggled on the pad would dive
    this.underwater = this.eye.y < wl - 0.05 && this.swimming;
    this.wading = !this.swimming && depth > 0.2 ? depth : 0;

    // stance
    const wantCrouch = input.down('crouch') && !this.swimming;
    if (wantCrouch) this.crouched = true;
    else if (this.crouched) {
      // stand up only if there is head room
      const up = physics.raycast({ x: this.pos.x, y: this.pos.y + 0.5, z: this.pos.z }, UP, cfg.height - 0.4, { terrain: false });
      if (!up) this.crouched = false;
    }
    this.crouch += ((this.crouched ? 1 : 0) - this.crouch) * Math.min(1, dt * 10);

    // sprint & stamina
    const ads = g.weapons?.adsBlend > 0.3;
    this.sprinting = input.down('sprint') && moving && f > 0 && !this.crouched && !ads && this.stamina > 0.02 && (this.onGround || this.swimming);
    if (this.sprinting) this.stamina = Math.max(0, this.stamina - dt / cfg.staminaSeconds);
    else this.stamina = Math.min(1, this.stamina + dt * cfg.staminaRegen / cfg.staminaSeconds * (moving ? 0.6 : 1));
    if (this.stamina <= 0.02) this.exhausted = true;
    if (this.exhausted && this.stamina > 0.3) this.exhausted = false;
    if (this.exhausted) this.sprinting = false;

    // ladders: walking into a ladder volume climbs
    this.onLadder = false;
    physics.query(this.pos.x - cfg.radius - 0.1, this.pos.z - cfg.radius - 0.1, this.pos.x + cfg.radius + 0.1, this.pos.z + cfg.radius + 0.1, (sh) => {
      if (!sh.ladder || sh.type !== 'box') return;
      if (this.pos.y > sh.y + sh.hy + 0.2 || this.pos.y + 1.6 < sh.y - sh.hy) return;
      const c = Math.cos(sh.yaw), sn = Math.sin(sh.yaw);
      const dx = this.pos.x - sh.x, dz = this.pos.z - sh.z;
      const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      if (Math.abs(lx) < sh.hx + cfg.radius + 0.15 && Math.abs(lz) < sh.hz + cfg.radius + 0.15) this.onLadder = true;
    });

    let speed;
    if (this.swimming) speed = this.sprinting ? cfg.swimSprintSpeed : cfg.swimSpeed;
    else if (this.crouched) speed = cfg.crouchSpeed;
    else if (ads) speed = cfg.adsSpeed;
    else speed = this.sprinting ? cfg.sprintSpeed : cfg.walkSpeed;
    if (this.wading) speed *= 1 - 0.45 * THREE.MathUtils.smoothstep(this.wading, 0.2, 1.2);

    if (this.onLadder && !this.swimming) {
      // climb: forward/back moves up/down, look direction irrelevant
      this.vel.set(_wish.x * 1.5, (f !== 0 ? f : 0) * cfg.ladderSpeed, _wish.z * 1.5);
      if (input.hit('jump')) { this.vel.addScaledVector(fwd, -3); this.vel.y = 3; this.onLadder = false; }
      this.fallStartY = null;
    } else if (this.swimming) {
      // swim: horizontal + vertical from pitch while moving forward; float toward the surface
      const swimDir = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      const target = new THREE.Vector3().addScaledVector(swimDir, f * speed).addScaledVector(right, s * speed);
      if (input.down('jump')) target.y = Math.max(target.y, 2.2);
      if (input.down('crouch')) target.y = Math.min(target.y, -2.2);
      const surface = wl - 1.45; // feet height when floating with the head out
      if (!input.down('crouch') && f <= 0.01 && this.pos.y < surface) target.y = Math.max(target.y, 1.4);
      if (this.pos.y > surface && target.y > 0) target.y = Math.min(target.y, (surface - this.pos.y) * 4);
      this.vel.lerp(target, Math.min(1, dt * 4));
      this.fallStartY = null;
    } else if (this.flight && !this.onGround) {
      this.flight(dt);
      this.fallStartY = null;
    } else {
      // ground / air
      const accel = this.onGround ? cfg.acceleration : cfg.acceleration * cfg.airControl;
      const tx = _wish.x * speed, tz = _wish.z * speed;
      const k = Math.min(1, accel * dt / Math.max(speed, 1));
      this.vel.x += (tx - this.vel.x) * k;
      this.vel.z += (tz - this.vel.z) * k;
      if (this.onGround && input.hit('jump') && !this.crouched) {
        this.vel.y = cfg.jumpSpeed;
        this.onGround = false;
        g.audio?.play('jump_land', { volume: 0.25, pitch: 1.3 });
      }
      this.vel.y -= cfg.gravity * dt;
    }

    // integrate + collide
    const prevY = this.pos.y;
    this.pos.addScaledVector(this.vel, dt);
    physics.collideCylinder(this.pos, cfg.radius, this.height, cfg.stepHeight);
    for (const a of g.actors?.list ?? []) {
      if (!a.alive || a.civilianRagdoll) continue;
      const dx = this.pos.x - a.pos.x, dz = this.pos.z - a.pos.z, rr2 = cfg.radius + 0.35;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr2 * rr2 && Math.abs(this.pos.y - a.pos.y) < 1.6 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        this.pos.x = a.pos.x + (dx / d) * rr2; this.pos.z = a.pos.z + (dz / d) * rr2;
      }
    }
    // ground
    const ground = physics.groundAt(this.pos.x, this.pos.z, cfg.radius * 0.7, Math.max(this.pos.y, prevY) + cfg.stepHeight);
    if (this.swimming) {
      if (this.pos.y < ground) { this.pos.y = ground; this.vel.y = Math.max(0, this.vel.y); }
      this.onGround = false;
    } else if (this.pos.y <= ground + 0.02 && this.vel.y <= 0.01) {
      // landed / walking
      if (!this.onGround) this._land(ground);
      this.pos.y = ground;
      this.vel.y = 0;
      this.onGround = true;
      // slope: slide down steep terrain
      if (ground - T.heightAt(this.pos.x, this.pos.z) < 0.05) {
        T.normalAt(this.pos.x, this.pos.z, _n);
        if (_n.y < 0.68) {
          this.vel.x += _n.x * 18 * dt; this.vel.z += _n.z * 18 * dt;
          this.onGround = _n.y > 0.55;
        }
      }
    } else if (this.onGround && this.pos.y - ground < cfg.stepHeight && this.vel.y <= 0) {
      // walking down a slope / steps: stick to the ground
      this.pos.y = ground;
      this.vel.y = 0;
    } else {
      if (this.onGround) this.fallStartY = this.pos.y;
      this.onGround = false;
      if (this.fallStartY === null || this.pos.y > this.fallStartY) this.fallStartY = this.pos.y;
    }
    if (this.onLadder) { this.onGround = true; this.fallStartY = null; }

    // breath
    if (this.underwater) {
      this.breath = Math.max(0, this.breath - dt / cfg.breath.seconds);
      if (this.breath <= 0) { this._drownT = (this._drownT ?? 0) + dt; if (this._drownT > 1) { this._drownT = 0; this.damage(cfg.breath.drownDamage, null, 'drown'); } }
    } else this.breath = Math.min(1, this.breath + dt * 0.5);

    // heartbeat loop when badly hurt
    const low = this.health > 0 && this.health < 30;
    if (low && !this._lowSnd) this._lowSnd = g.audio?.play('low_health_loop', { loop: true, volume: 0.6 });
    else if (!low && this._lowSnd) { this._lowSnd.stop?.(0.6); this._lowSnd = null; }
    // regen (up to regen.max) after a delay without damage
    if (this.time - this.lastHurt > cfg.regen.delay && this.health < cfg.regen.max && this.health > 0) this.health = Math.min(cfg.regen.max, this.health + cfg.regen.rate * dt);

    // speed, head bob, footsteps, noise
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    const bobTarget = this.onGround && this.speed > 0.5 ? Math.min(1, this.speed / cfg.walkSpeed) : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * Math.min(1, dt * 8);
    this.bob += dt * (this.sprinting ? 13 : 9.5) * Math.min(1.3, this.speed / cfg.walkSpeed + 0.2);
    if (this.onGround || this.swimming) {
      this.stepDist += this.speed * dt;
      const stride = this.swimming ? 2.2 : this.sprinting ? 2.4 : this.crouched ? 1.4 : 1.9;
      if (this.stepDist > stride) { this.stepDist = 0; this._footstep(); }
    }
    this.noise = this.sprinting ? 14 : this.crouched ? 1.5 : this.speed > 0.5 ? 6 : 0;
  }

  _noclip(dt, input) {
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw)).negate();
    const { f, s } = input.move();
    const sp = input.down('sprint') ? 60 : 15;
    this.pos.addScaledVector(fwd, f * sp * dt).addScaledVector(right, s * sp * dt);
    this.vel.set(0, 0, 0);
    this.onGround = true;
    this.speed = 0;
  }

  _land(ground) {
    const fall = this.fallStartY !== null ? this.fallStartY - ground : 0;
    this.fallStartY = null;
    const fd = this.cfg.fallDamage;
    if (fall > fd.minHeight && !this.wading) this.damage((fall - fd.minHeight) * fd.perMeter, null, 'fall');
    if (fall > 1.2) {
      this.game.audio?.play('jump_land', { volume: Math.min(1, fall / 4) });
      this.landKick = Math.min(1, fall / 6);
      this.noise = Math.max(this.noise, 10);
    }
  }

  surfaceMaterial() {
    const g = this.game;
    if (this.wading || this.swimming) return 'water';
    const T = g.world.terrain;
    const th = T.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y - th > 0.15) {
      let mat = 'wood';
      g.world.physics.query(this.pos.x - 0.2, this.pos.z - 0.2, this.pos.x + 0.2, this.pos.z + 0.2, (s) => { if (s.material) mat = s.material; });
      return mat;
    }
    const m = T.materialAtWorld(this.pos.x, this.pos.z);
    return { 1: 'sand', 2: 'sand', 5: 'dirt', 6: 'stone', 7: 'stone', 9: 'sand', 13: 'stone' }[m] ?? 'grass';
  }

  _footstep() {
    const m = this.surfaceMaterial();
    const name = { water: 'footstep_water', sand: 'footstep_sand', dirt: 'footstep_grass', wood: 'footstep_wood', metal: 'footstep_metal', stone: 'footstep_stone', concrete: 'footstep_stone' }[m] ?? 'footstep_grass';
    const vol = this.sprinting ? 0.55 : this.crouched ? 0.12 : 0.32;
    this.game.audio?.play(this.swimming ? 'swim_stroke' : name, { volume: vol });
  }

  /** Damage from `from` (Vector3 or null). Returns the damage actually taken. */
  damage(amount, from, kind = 'bullet') {
    if (!this.alive || this.godMode || amount <= 0) return 0;
    const g = this.game;
    let dmg = amount * (g.difficulty?.damageTaken ?? 1);
    if (this.armor > 0 && kind !== 'fall' && kind !== 'drown') {
      const absorbed = Math.min(this.armor, dmg * 0.6);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health -= dmg;
    this.lastHurt = this.time;
    g.hud?.onPlayerHurt(dmg, from, kind);
    g.input.rumble(Math.min(1, 0.25 + dmg / 40), 0.4, 160);
    g.audio?.play('player_hurt', { volume: Math.min(1, 0.3 + dmg / 40) });
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      g.onPlayerDeath?.(kind);
    }
    return dmg;
  }

  heal(n) { this.health = Math.min(this.maxHealth, this.health + n); }
  addArmor(n) { this.armor = Math.min(this.cfg.maxArmor, this.armor + n); }

  /** Camera pose: eye position + yaw/pitch (+ recoil, landing kick, head bob). */
  applyCamera(camera, dt) {
    const e = this.eye;
    const bobY = Math.sin(this.bob * 2) * this.cfg.headBob * this.bobAmount;
    const bobX = Math.cos(this.bob) * this.cfg.headBob * 0.6 * this.bobAmount;
    this.landKick = Math.max(0, (this.landKick ?? 0) - dt * 3);
    camera.position.set(e.x, e.y + bobY - this.landKick * 0.15, e.z);
    camera.position.addScaledVector(new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), bobX);
    if (this.swimming) camera.position.y += Math.sin(this.time * 1.7) * 0.05;
    camera.rotation.set(this.pitch + this.recoilPitch - this.landKick * 0.05, this.yaw + this.recoilYaw, 0, 'YXZ');
  }
}
