// VR locomotion (Population: One style), run instead of the desktop look + move in Player.update:
//  - physical steps in the room move the body (the collider follows the head; a wall stops it and
//    the view is pushed back), the head's height crouches it (stealth, collider height);
//  - left stick walks toward where the head (or the off-hand controller) points, sprint on a stick
//    click; right stick snap turns (or smooth turns) about the head; A jumps;
//  - grips grab any surface within reach of the hand (walls, rocks, cliffs, trees, the ground):
//    the grabbing hand stays put and the body moves instead; letting go flings the body with the
//    hand's last motion (climb up a cliff, vault over a wall);
//  - falling with both arms spread out to the sides glides: a slow sink, forward speed, banking
//    the arms (one hand higher) turns.
// The rest (walking physics, swimming, ladders, slopes, fall damage, stamina) is Player.update's.
import * as THREE from 'three';

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _o = new THREE.Vector3(), _f = new THREE.Vector3();

export class VRLocomotion {
  constructor(vr) {
    this.vr = vr;
    this.game = vr.game;
    this.climb = null; // { hand, anchor } while a hand holds a surface
    this.flingVel = new THREE.Vector3();
    this.gliding = false;
    this.glideYaw = 0;
    this._eye = new THREE.Vector3();
    this.speed = 0; // view motion that isn't the user's own (stick, turns): comfort vignette
  }

  reset() {
    this.climb = null;
    this.gliding = false;
    this.game.player.flight = null;
  }

  update(dt, input) {
    const vr = this.vr, p = this.game.player, cfg = p.cfg, physics = this.game.world.physics;
    const head = vr.head;
    this.speed = 0;
    if (!p.alive) { p.update(dt, input); return; }
    this._turn(dt);
    // the body under the head: physical steps in the room (collided)
    _d.set(head.pos.x - p.pos.x, 0, head.pos.z - p.pos.z);
    if (_d.lengthSq() > 1e-8) {
      if (_d.lengthSq() > 4) _d.setLength(2); // tracking jump (recenter): no long slide through walls
      p.pos.add(_d);
      physics.collideCylinder(p.pos, cfg.radius, this._height(), cfg.stepHeight);
    }
    // crouch (stealth, collider, speed): the head low, or the toggle
    const eye = vr.eyeLocal;
    input.setVirtual('crouch', vr.crouchToggle || eye < vr.eyeHeight * vr.cfg.crouch);
    p.heightOverride = THREE.MathUtils.clamp(eye + 0.12, cfg.crouchHeight, cfg.height);
    p.eyeOverride = this._eye.copy(head.pos);
    if (this._climb(dt)) return;
    this._glide(dt);
    // walk toward the head's yaw (or the off hand's): Player.update moves along its yaw
    const move = vr.settings.move === 'hand' ? Math.atan2(-vr.off.rayDir.x, -vr.off.rayDir.z) : head.yaw;
    p.yaw = move;
    p.pitch = head.pitch; // swimming: look down to dive
    p.update(dt, input);
    p.yaw = head.yaw;
    if (input.moveX || input.moveY) this.speed = Math.max(this.speed, p.speed);
  }

  _height() { return this.game.player.heightOverride ?? this.game.player.cfg.height; }

  /** Snap turns (a flick past 0.7, again once the stick came back) or smooth turns. */
  _turn(dt) {
    const vr = this.vr, x = vr.ui.open ? 0 : vr.main.stick.x, s = vr.settings;
    if (s.turn === 'smooth') {
      if (Math.abs(x) > 0.05) { vr.turn(-x * s.turnSpeed * THREE.MathUtils.DEG2RAD * dt); this.speed = Math.max(this.speed, Math.abs(x) * 4); }
      return;
    }
    if (Math.abs(x) > 0.7 && !this._snapped) { this._snapped = true; vr.turn(-Math.sign(x) * s.snapAngle * THREE.MathUtils.DEG2RAD); }
    else if (Math.abs(x) < 0.3) this._snapped = false;
  }

  // --- climbing ------------------------------------------------------------------------------
  /** A free hand closing its grip on a surface grabs it. Returns true while climbing (no walking). */
  _climb(dt) {
    const vr = this.vr, p = this.game.player, W = vr.weapons;
    for (const h of [vr.off, vr.main]) {
      if (h.btn.squeeze.hit && !W.claims(h) && this._touching(h)) {
        this.climb = { hand: h, anchor: h.pos.clone() };
        h.pulse(0.35, 30);
      }
    }
    const c = this.climb;
    if (c && (!c.hand.btn.squeeze.down || !c.hand.connected)) {
      // let go: the other hand may still hold on, else fling
      const other = c.hand === vr.main ? vr.off : vr.main;
      this.climb = other.btn.squeeze.down && this._touching(other) && !W.claims(other) ? { hand: other, anchor: other.pos.clone() } : null;
      if (!this.climb) {
        p.vel.copy(this.flingVel).clampLength(0, vr.cfg.climb.fling);
        p.onGround = false;
        p.fallStartY = p.pos.y;
      }
    }
    if (!this.climb) { this.flingVel.set(0, 0, 0); return false; }
    // keep the hand on its anchor: the body moves by what the hand moved
    const { hand, anchor } = this.climb;
    _d.subVectors(anchor, hand.pos);
    const prev = _o.copy(p.pos);
    p.pos.add(_d);
    this.game.world.physics.collideCylinder(p.pos, p.cfg.radius, this._height(), 0.05);
    const ground = this.game.world.physics.groundAt(p.pos.x, p.pos.z, p.cfg.radius * 0.7, p.pos.y + 0.05);
    if (p.pos.y < ground) p.pos.y = ground;
    if (dt > 0) this.flingVel.lerp(_v.subVectors(p.pos, prev).divideScalar(dt), Math.min(1, dt * 20));
    p.vel.set(0, 0, 0);
    p.onGround = false;
    p.fallStartY = null;
    p.speed = 0;
    p.yaw = vr.head.yaw;
    this.gliding = false;
    p.flight = null;
    return true;
  }

  /** Is there something to hold within reach of the hand: on the line from the eyes to the hand
   *  (the hand pushed into a wall / rock / trunk / the ground), or just past the fingers, or under
   *  the palm (a ledge from above)? */
  _touching(h) {
    const physics = this.game.world.physics, reach = this.vr.cfg.climb.reach;
    const eye = this.vr.head.pos;
    _d.subVectors(h.pos, eye);
    const len = _d.length();
    if (len > 0.05) {
      const hit = physics.raycast(eye, _d.divideScalar(len), len + reach);
      if (hit) return true;
    }
    h.fingers(_f);
    _o.copy(h.pos).addScaledVector(_f, -0.05);
    if (physics.raycast(_o, _f, 0.05 + 0.1 + reach)) return true;
    _o.copy(h.pos).y += 0.05;
    return !!physics.raycast(_o, _v.set(0, -1, 0), 0.12 + reach);
  }

  // --- gliding -------------------------------------------------------------------------------
  /** Arms spread while falling: glide (Player.update calls p.flight instead of its air physics). */
  _glide(dt) {
    const vr = this.vr, p = this.game.player, G = vr.cfg.glide, head = vr.head;
    const L = vr.hands.left.pos, R = vr.hands.right.pos;
    const span = Math.hypot(L.x - R.x, L.z - R.z);
    const level = (y) => y > head.pos.y - 0.75 && y < head.pos.y + 0.35;
    const spread = vr.hands.left.connected && vr.hands.right.connected && span > G.span && level(L.y) && level(R.y)
      && !vr.weapons.holding(vr.off) && this._outward(L, R);
    const air = !p.onGround && !p.swimming && !p.onLadder && !p.inVehicle;
    if (!this.gliding && spread && air && p.vel.y < -G.fall) {
      this.gliding = true;
      this.glideYaw = head.yaw;
      vr.main.pulse(0.3, 60); vr.off.pulse(0.3, 60);
    }
    if (this.gliding && (!spread || !air)) this.gliding = false;
    if (!this.gliding) { p.flight = null; return; }
    // one hand higher than the other banks toward the low one; the head pulls the course gently
    const bank = THREE.MathUtils.clamp((L.y - R.y) / Math.max(span, 0.5), -1, 1);
    let dy = head.yaw - this.glideYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.glideYaw += (-bank * G.turn + dy * 0.6) * dt;
    const yaw = this.glideYaw;
    p.flight = (fdt) => {
      const k = Math.min(1, fdt * 1.6);
      p.vel.x += (-Math.sin(yaw) * G.speed - p.vel.x) * k;
      p.vel.z += (-Math.cos(yaw) * G.speed - p.vel.z) * k;
      p.vel.y += (-G.sink - p.vel.y) * Math.min(1, fdt * 3);
    };
    this.speed = Math.max(this.speed, G.speed);
  }

  /** Both hands out to the sides of the body (not both in front). */
  _outward(L, R) {
    const h = this.vr.head.pos, yaw = this.vr.head.yaw;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw); // right of the head
    return (L.x - h.x) * rx + (L.z - h.z) * rz < -0.3 && (R.x - h.x) * rx + (R.z - h.z) * rz > 0.3;
  }
}

