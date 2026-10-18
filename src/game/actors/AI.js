// Enemy / civilian brains + the AI director (perception helpers, noise, alerts, path budget).
//
// States: idle | patrol | suspicious | investigate | combat | search | flee | follow | dead
// Detection is a meter (0..1+) filled while the player is seen (AIBrain._perceive: distance,
// focal / peripheral vision, body exposure, stance, movement, undergrowth, night, attention).
// At 0.35 the enemy gets suspicious and turns to look; at 1 it enters combat and, a moment
// later, alerts its group and neighbours (unless killed first). Noises (gunshots, explosions,
// sprinting) make enemies investigate or fight directly.
import * as THREE from 'three';
import { Nav } from './Nav.js';

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const FOCAL = (25 * Math.PI) / 180; // half-angle of focal vision
const PERIPHERAL_MAX = 0.6; // awareness reachable with peripheral vision only
const rand = (a, b) => a + Math.random() * (b - a);

export class AIBrain {
  constructor(actor, { civilian = false } = {}) {
    this.actor = actor;
    this.civilian = civilian;
    this.game = actor.game;
    const d = actor.data;
    this.home = new THREE.Vector3().copy(actor.pos);
    this.homeHeading = actor.heading;
    this.patrol = d.patrol ?? null;
    this.patrolIndex = 0;
    this.state = this.patrol ? 'patrol' : 'idle';
    this.awareness = 0;
    this.lastKnown = new THREE.Vector3();
    this.lastSeenT = -99;
    this.seeT = 0; // continuous sight time (accuracy ramps up)
    this.visible = false;
    this.thinkAcc = Math.random() * 0.2;
    this.sightAcc = Math.random() * 0.2;
    this.stateT = 0;
    this.path = null;
    this.pathIdx = 0;
    this.burstLeft = 0;
    this.fireCd = rand(0.5, 1.2);
    this.repositionT = 0;
    this.waitT = 0;
    this.sleeping = false;
    actor.idleAnim = d.pose === 'sit' ? 'Sitting_Idle_Loop' : d.pose === 'talk' ? 'Idle_Talking_Loop' : d.pose === 'work' ? 'Fixing_Kneeling' : d.pose === 'dance' ? 'Dance_Loop' : null;
    if (d.dormant) { this.dormant = true; actor.root.visible = false; }
  }

  get inCombat() { return this.state === 'combat'; }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
    this.path = null;
    const a = this.actor;
    a.moveTarget = null;
    a.faceTarget = null;
    a.aiming = false;
    a.crouching = false;
    if (s !== 'idle') a.idleAnim = null;
  }

  // --- events ----------------------------------------------------------------------------
  onDamaged(from) {
    if (this.civilian) { if (!this.actor.data.calm) this._flee(from); return; }
    const p = this.game.player;
    this.awareness = 1.2;
    this.lastKnown.copy(p.pos);
    this.lastSeenT = this.game.time;
    if (this.state !== 'combat') this.enterCombat();
    this.repositionT = Math.min(this.repositionT, 0.3);
  }

  onDeath(info = {}) {
    this.state = 'dead';
    const g = this.game;
    // nearby comrades notice: a silent takedown only makes them come and look
    for (const o of g.actors.near(this.actor.pos, 25)) if (o !== this.actor && o.alive && o.ai && !o.ai.civilian && o.pos.distanceTo(this.actor.pos) < 25) o.ai.hear(this.actor.pos.clone(), info.stealth ? 'body' : 'death');
  }

  hear(pos, kind) {
    if (this.state === 'dead' || this.dormant) return;
    if (this.civilian) { if (!this.actor.data.calm && (kind === 'gunshot' || kind === 'explosion')) this._flee(pos); return; }
    if (this.state === 'combat') { if (kind !== 'footstep') this.repositionT = Math.min(this.repositionT, 1); return; }
    const d = pos.distanceTo(this.actor.pos);
    const g = this.game;
    if (kind === 'body' && d > 14) return;
    if (kind === 'explosion' || (kind === 'gunshot' && d < 35) || kind === 'death' && d < 12) {
      // they know roughly where it came from, not exactly where the player stands
      const p = g.player.pos, err = Math.min(12, p.distanceTo(this.actor.pos) * 0.15), t = Math.random() * Math.PI * 2;
      this.lastKnown.set(p.x + Math.cos(t) * err, p.y, p.z + Math.sin(t) * err);
      this.awareness = Math.max(this.awareness, 0.9);
      this.enterCombat(true);
      return;
    }
    this.lastKnown.copy(pos);
    this.awareness = Math.max(this.awareness, 0.5);
    if (this.state !== 'investigate') { this.setState('investigate'); this.actor.faceTarget = this.lastKnown.clone(); this.waitT = rand(0.8, 1.6); }
  }

  enterCombat(quiet = false) {
    if (this.civilian || this.state === 'dead') return;
    const first = this.state !== 'combat';
    this.setState('combat');
    this.actor.aiming = true;
    if (first) {
      this.reactionT = this.actor.arch.reaction ?? 0.6;
      this.game.ai.onEnemyAlerted(this.actor, quiet);
    }
  }

  _flee(from) {
    if (this.state === 'flee') { this.stateT = 0; return; }
    this.setState('flee');
    const a = this.actor;
    _d.set(a.pos.x - (from?.x ?? a.pos.x + 1), 0, a.pos.z - (from?.z ?? a.pos.z)).normalize();
    this._goTo(a.pos.x + _d.x * 35, a.pos.z + _d.z * 35, a.arch.runSpeed ?? 4.2);
  }

  // --- movement helpers --------------------------------------------------------------------
  _goTo(x, z, speed) {
    const a = this.actor;
    this.goal = { x, z };
    this.goalSpeed = speed;
    if (Math.hypot(x - a.pos.x, z - a.pos.z) < 14) { this.path = [[x, z]]; this.pathIdx = 0; }
    else this.game.ai.requestPath(this, a.pos.x, a.pos.z, x, z);
    a.moveSpeed = speed;
  }

  setPath(pts) { this.path = pts; this.pathIdx = 0; }

  _followPath() {
    const a = this.actor;
    if (!this.path || this.pathIdx >= this.path.length) { a.moveTarget = null; return true; }
    const [x, z] = this.path[this.pathIdx];
    const d = Math.hypot(x - a.pos.x, z - a.pos.z);
    if (d < 1.2) { this.pathIdx++; if (this.pathIdx >= this.path.length) { a.moveTarget = null; return true; } }
    const [nx, nz] = this.path[this.pathIdx];
    a.moveTarget = { x: nx, z: nz };
    a.moveSpeed = this.goalSpeed ?? a.arch.walkSpeed;
    if (a.stuck > 1.2) {
      // stuck against something: sidestep and re-plan
      a.stuck = 0;
      this.pathIdx = Math.min(this.pathIdx + 1, this.path.length - 1);
      if (this.goal) this.game.ai.requestPath(this, a.pos.x, a.pos.z, this.goal.x, this.goal.z);
    }
    return false;
  }

  // --- perception --------------------------------------------------------------------------
  // Sight is sampled every 0.22 s (0.15 s in combat). While the player is seen, the awareness
  // meter fills at  rate = distance × view angle × body exposure × concealment × attention:
  // - distance: standing in plain view, ~0.45 s at 2 m, ~1.3 s at 20 m, ~3 s at 40 m, then very
  //   slow towards the edge of the vision range (much shorter at night)
  // - view angle: focal vision (±25°) counts fully; peripheral vision (up to fov / 2) is weak,
  //   mostly catches movement and can only make the enemy suspicious: he has to turn and look to
  //   recognise the player. Far above / below his eye line is seen less.
  // - exposure: share of the body (head / chest / legs) in line of sight, so peeking over cover
  //   is much safer than standing in the open
  // - concealment: stance, movement, night, flashlight (AIDirector.playerVisibility) and dense
  //   undergrowth around the player or right in front of him on the sight line
  // - attention: busy (sitting / talking / working) enemies notice less, investigating ones
  //   more, searching ones a lot more (a suspicious one stares but no faster: time to hide)
  // Calm enemies also forget at 0.08 / s (_idle / _patrol), so a faint enough signal (far away,
  // hidden, still) never builds up. In combat there is no meter: the enemy keeps track of the
  // player in a wide cone.
  _perceive(dt) {
    const g = this.game, a = this.actor, p = g.player;
    this.sightAcc -= dt;
    if (this.sightAcc > 0) return;
    const combat = this.state === 'combat';
    const interval = combat ? 0.15 : 0.22;
    const step = interval - this.sightAcc;
    this.sightAcc = interval;
    this.visible = false;
    const lose = (k) => { this.awareness = Math.max(0, this.awareness - step * k); };
    if (!p.alive || p.godInvisible || p.underwater) return lose(0.3);
    const arch = a.arch;
    const eye = a.eyePos(_a);
    const dist = eye.distanceTo(_e.set(p.pos.x, p.pos.y + p.height * 0.8, p.pos.z));
    // vision range (in a fight, muzzle flashes and alertness halve the effect of the night)
    const night = g.engine.lighting.night * (combat ? 0.5 : 1);
    const range = THREE.MathUtils.lerp(arch.vision ?? 60, arch.visionNight ?? 25, night) * (g.difficulty?.vision ?? 1) * (combat ? 1.5 : 1);
    if (dist > range) return lose(0.15);
    // view cone (horizontal); right behind him you are only "felt" when standing against him
    const dx = p.pos.x - eye.x, dz = p.pos.z - eye.z, flat = Math.hypot(dx, dz);
    const fwd = a.forward(_b);
    const ang = flat > 0.01 ? Math.acos(THREE.MathUtils.clamp((fwd.x * dx + fwd.z * dz) / flat, -1, 1)) : 0;
    const half = ((combat ? 200 : arch.fov ?? 120) * Math.PI) / 360;
    const felt = dist < 1.6 && !p.crouched;
    if (ang > half && !felt) return lose(0.12);
    const exposure = this._exposure(eye, p, combat);
    if (exposure <= 0) return lose(0.1);
    this.visible = true;
    if (combat) { this.awareness = 1.2; this.lastKnown.copy(p.pos); this.lastSeenT = g.time; return; }
    const r = dist / range;
    let rate = (0.5 * (1 - r)) / (0.22 + r);
    const focal = ang < FOCAL || felt;
    if (!focal) rate *= THREE.MathUtils.lerp(0.45, 0.15, (ang - FOCAL) / Math.max(0.01, half - FOCAL)) * (g.ai.playerMoving ? 1 : 0.4);
    const elev = Math.atan2(p.pos.y + 1 - eye.y, flat);
    if (elev > 0.45) rate *= THREE.MathUtils.lerp(1, 0.35, Math.min(1, (elev - 0.45) / 0.6));
    else if (elev < -0.6) rate *= THREE.MathUtils.lerp(1, 0.6, Math.min(1, (-elev - 0.6) / 0.6));
    rate *= exposure * g.ai.playerVisibility * this._undergrowth(p, eye, dist) * (g.difficulty?.detection ?? 1);
    if (this.state === 'search') rate *= 2.5;
    else if (this.state === 'investigate') rate *= 1.3;
    else if (a.idleAnim) rate *= 0.5;
    // peripheral vision alone stops at "suspicious"
    const cap = focal || this.state === 'search' ? Infinity : PERIPHERAL_MAX;
    if (this.awareness < cap) this.awareness = Math.min(cap, this.awareness + rate * step);
    this.lastKnown.copy(p.pos);
    this.lastSeenT = g.time;
  }

  /** Share of the player's body in line of sight from `eye` (head 0.4, chest 0.4, legs 0.2). */
  _exposure(eye, p, any) {
    const ph = this.game.world.physics, id = this.actor.id, x = p.pos.x, y = p.pos.y, z = p.pos.z;
    if (p.swimming) return ph.visible(eye, _v.set(x, y + 0.25, z), id) ? 0.4 : 0;
    const h = p.height;
    let e = ph.visible(eye, _v.set(x, y + h * 0.92, z), id) ? 0.4 : 0;
    if (any && e) return e;
    if (ph.visible(eye, _v.set(x, y + h * 0.6, z), id)) e += 0.4;
    if (any && e) return e;
    if (ph.visible(eye, _v.set(x, y + h * 0.25, z), id)) e += 0.2;
    return e;
  }

  /** Concealment factor (1 = none) of dense undergrowth around the player and 2-4 m in front of
   * him towards this enemy; works much better crouched, and not at point-blank range. */
  _undergrowth(p, eye, dist) {
    const ai = this.game.ai, x = p.pos.x, z = p.pos.z;
    const dx = eye.x - x, dz = eye.z - z, l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l;
    const f = ai.foliageAt(x, z) + 0.7 * ai.foliageAt(x + ux * 2, z + uz * 2) + 0.4 * ai.foliageAt(x + ux * 4, z + uz * 4);
    if (f <= 0) return 1;
    const hide = Math.min(p.crouched ? 0.85 : 0.45, f * (p.crouched ? 0.35 : 0.15));
    return 1 - hide * THREE.MathUtils.clamp((dist - 2) / 6, 0, 1);
  }

  // --- main update -------------------------------------------------------------------------
  update(dt, distToCam) {
    const g = this.game, a = this.actor;
    if (this.dormant) return 0;
    // far away and calm: think rarely
    const farCalm = distToCam > 220 && this.state !== 'combat';
    this.thinkAcc += dt;
    if (farCalm && this.thinkAcc < 0.5) return 0;
    const tdt = this.thinkAcc;
    this.thinkAcc = 0;
    this.stateT += tdt;
    if (!this.civilian && !farCalm) this._perceive(tdt);
    if (!this.civilian && this.state !== 'combat') {
      if (this.awareness >= 1) this.enterCombat();
      else if (this.awareness > 0.35 && this.state !== 'suspicious' && this.state !== 'investigate') { this.setState('suspicious'); a.faceTarget = this.lastKnown.clone(); }
    }
    g.hud?.detection?.(a, this.state === 'combat' ? 1 : Math.min(1, this.awareness), this.state);
    switch (this.state) {
      case 'idle': this._idle(tdt); break;
      case 'patrol': this._patrol(tdt); break;
      case 'suspicious': this._suspicious(tdt); break;
      case 'investigate': this._investigate(tdt); break;
      case 'combat': this._combat(tdt, dt); break;
      case 'search': this._search(tdt); break;
      case 'flee': this._fleeUpdate(tdt); break;
      case 'follow': this._follow(tdt); break;
      default: break;
    }
    return tdt;
  }

  _idle(dt) {
    const a = this.actor;
    // return to the post if displaced
    if (a.pos.distanceTo(this.home) > 2.5) {
      if (!this.path) this._goTo(this.home.x, this.home.z, a.arch.walkSpeed);
      if (this._followPath()) { this.path = null; a.moveTarget = null; }
      return;
    }
    a.moveTarget = null;
    this.lookT = (this.lookT ?? rand(3, 7)) - dt;
    if (this.lookT < 0) {
      this.lookT = rand(4, 9);
      const h = this.homeHeading + rand(-1.2, 1.2);
      a.faceTarget = new THREE.Vector3(a.pos.x + Math.sin(h) * 5, a.pos.y + 1.5, a.pos.z + Math.cos(h) * 5);
    }
    this.awareness = Math.max(0, this.awareness - dt * 0.08);
  }

  _patrol(dt) {
    const a = this.actor, g = this.game;
    const path = g.world.entities.handle(this.patrol);
    if (!path?.points?.length) { this.setState('idle'); return; }
    this.awareness = Math.max(0, this.awareness - dt * 0.08);
    if (this.waitT > 0) { this.waitT -= dt; a.moveTarget = null; return; }
    const pts = path.points;
    const tgt = pts[this.patrolIndex % pts.length];
    if (!this.path) this._goTo(tgt.x, tgt.z, a.arch.walkSpeed);
    if (this._followPath()) {
      this.path = null;
      this.waitT = path.data.wait ?? 2;
      const loop = path.data.loop !== false;
      if (loop) this.patrolIndex = (this.patrolIndex + 1) % pts.length;
      else {
        this.dir = this.dir ?? 1;
        if (this.patrolIndex + this.dir >= pts.length || this.patrolIndex + this.dir < 0) this.dir *= -1;
        this.patrolIndex += this.dir;
      }
    }
  }

  _suspicious(dt) {
    const a = this.actor;
    a.moveTarget = null;
    a.faceTarget = this.lastKnown.clone().setY(this.lastKnown.y + 1.2);
    if (this.stateT > 1.2 && this.awareness > 0.5) { this.setState('investigate'); this.waitT = 0; return; }
    this.awareness -= dt * (this.visible ? 0 : 0.12);
    if (this.awareness < 0.15) this.setState(this.patrol ? 'patrol' : 'idle');
  }

  _investigate(dt) {
    const a = this.actor;
    if (this.waitT > 0) { this.waitT -= dt; a.moveTarget = null; return; }
    a.faceTarget = null;
    if (!this.path) this._goTo(this.lastKnown.x, this.lastKnown.z, a.arch.walkSpeed * 1.3);
    if (this._followPath() || this.stateT > 25) {
      // look around, then go back
      this.path = null;
      this.searchLeft = (this.searchLeft ?? 3) - 1;
      if (this.searchLeft <= 0 || this.awareness < 0.2) { this.searchLeft = undefined; this.awareness = 0.2; this.setState(this.patrol ? 'patrol' : 'idle'); return; }
      const ang = Math.random() * Math.PI * 2;
      this.lastKnown.set(a.pos.x + Math.cos(ang) * 8, a.pos.y, a.pos.z + Math.sin(ang) * 8);
      this.waitT = rand(1.5, 3);
    }
    this.awareness = Math.max(0.36, this.awareness - dt * 0.03);
  }

  _search(dt) {
    const a = this.actor;
    a.aiming = true;
    if (this.waitT > 0) { this.waitT -= dt; a.moveTarget = null; return; }
    if (!this.path) {
      const r = this.stateT < 4 ? 0 : rand(5, 14), ang = Math.random() * Math.PI * 2;
      this._goTo(this.lastKnown.x + Math.cos(ang) * r, this.lastKnown.z + Math.sin(ang) * r, a.arch.walkSpeed * 1.6);
    }
    if (this._followPath()) { this.path = null; this.waitT = rand(1, 2.5); }
    if (this.stateT > 30) { this.awareness = 0.3; this.setState(this.patrol ? 'patrol' : 'idle'); }
  }

  _fleeUpdate() {
    const a = this.actor;
    a.crouching = false;
    if (this._followPath() || this.stateT > 12) { a.moveTarget = null; a.crouching = true; if (this.stateT > 25) { this.setState('idle'); a.crouching = false; } }
  }

  // Escort ('follow' action): walk straight to the player when nothing is in the way, otherwise
  // retrace the player's own footsteps (AIDirector.trail, walkable by construction): the nav grid
  // is too coarse for doors and interior walls (a hostage has to get out of the room she was in).
  _follow(dt) {
    const a = this.actor, p = this.game.player;
    const d = Math.hypot(p.pos.x - a.pos.x, p.pos.z - a.pos.z);
    if (d > 60) { this._catchUp(); return; }
    this.followT = (this.followT ?? 0) - dt;
    this.trailOnlyT = Math.max(0, (this.trailOnlyT ?? 0) - dt);
    let next = false; // move on to the trail point after the current one
    if (a.stuck > 0.8) { a.stuck = 0; this.followT = 0; this.trailOnlyT = 2; next = true; }
    const c = this.crumb;
    if (c && Math.hypot(c.x - a.pos.x, c.z - a.pos.z) < 0.8) { this.followT = 0; next = true; }
    if (this.followT <= 0) {
      this.followT = 0.3;
      this.crumb = this.trailOnlyT <= 0 && this._clearTo(p.pos) ? null : this._nextCrumb(next);
    }
    if (!this.crumb && d <= 4) { a.moveTarget = null; return; }
    const t = this.crumb ?? p.pos;
    a.moveTarget = { x: t.x, z: t.z };
    a.moveSpeed = d > 10 ? a.arch.runSpeed : a.arch.walkSpeed * 1.3;
  }

  /** Nothing blocks a straight walk from the actor to p (rays at knee and chest height). */
  _clearTo(p) {
    const a = this.actor, ph = this.game.world.physics;
    _a.set(a.pos.x, a.pos.y + 0.5, a.pos.z);
    _e.set(p.x, p.y + 0.5, p.z);
    if (!ph.visible(_a, _e, a.id)) return false;
    _a.y += 0.8; _e.y += 0.8;
    return ph.visible(_a, _e, a.id);
  }

  /** Trail point to walk to: the newest one within 25 m reachable straight (a few ray tests),
   * else the current one (or the one after it), else the nearest one to join the trail. */
  _nextCrumb(next) {
    const a = this.actor, trail = this.game.ai.trail;
    if (!trail.length) return null;
    const cur = this.crumb && this.crumb.n >= trail[0].n ? this.crumb.n - trail[0].n : -1;
    let tests = 0;
    for (let i = trail.length - 1; i > cur && tests < 6; i--) {
      const c = trail[i];
      if (Math.hypot(c.x - a.pos.x, c.z - a.pos.z) > 25) continue;
      tests++;
      if (this._clearTo(c)) return c;
    }
    if (cur >= 0) return trail[next ? Math.min(cur + 1, trail.length - 1) : cur];
    let best = null, bd = 12;
    for (const c of trail) { const dd = Math.hypot(c.x - a.pos.x, c.z - a.pos.z); if (dd < bd) { bd = dd; best = c; } }
    return best;
  }

  /** Far behind (the player drove off...): reappear on the trail a few metres behind him. */
  _catchUp() {
    const a = this.actor, p = this.game.player, trail = this.game.ai.trail;
    let c = null;
    for (let i = trail.length - 1; i >= 0; i--) {
      const dd = Math.hypot(trail[i].x - p.pos.x, trail[i].z - p.pos.z);
      if (dd > 4) { if (dd < 15) c = trail[i]; break; }
    }
    if (c) a.pos.set(c.x, c.y, c.z);
    else a.pos.set(p.pos.x - 2, p.pos.y, p.pos.z - 2);
    this.crumb = null;
  }

  _combat(dt, frameDt) {
    const g = this.game, a = this.actor, p = g.player, arch = a.arch;
    a.aiming = true;
    const seenAgo = g.time - this.lastSeenT;
    // lost the player for a while: search
    if (seenAgo > 9 || !p.alive) {
      this.seeT = 0;
      if (!p.alive) { this.setState('idle'); this.awareness = 0; return; }
      this.setState('search');
      return;
    }
    const target = this.visible ? p.pos : this.lastKnown;
    a.faceTarget = _v.set(target.x, target.y + 1.3, target.z).clone();
    this.seeT = this.visible ? this.seeT + dt : Math.max(0, this.seeT - dt * 2);
    // reposition (cover / strafe / approach) every few seconds
    this.repositionT -= dt;
    if (this.repositionT <= 0) {
      this.repositionT = rand(2.5, 5);
      this._pickCombatSpot(target);
    }
    if (this.path) this._followPath(); else a.moveTarget = null;
    a.crouching = !!this.inCover && !a.moveTarget && this.burstLeft === 0 ? true : !!this.inCover && !a.moveTarget;
    // shooting
    this.reactionT -= dt;
    this.fireCd -= dt;
    const w = a.weapon;
    if (!w || this.reactionT > 0) return;
    const dist = a.pos.distanceTo(p.pos);
    if (this.visible && dist < (w.range ?? 100) * 0.9) {
      if (this.burstLeft <= 0 && this.fireCd <= 0) {
        this.burstLeft = Math.round(rand(...(arch.burst ?? [3, 5])));
        this.pause = rand(...(arch.burstPause ?? [0.8, 1.5]));
        // only a few enemies really aim at the player at once (fire tokens); the others fire wide
        this.suppress = !g.ai.takeShotToken(this, (this.burstLeft * 60) / w.rpm + this.pause, dist);
        if (this.suppress && w.projectile) { this.burstLeft = 0; this.fireCd = rand(1, 2); }
      }
      if (this.burstLeft > 0 && this.fireCd <= 0) {
        this._shoot(w, dist, this.suppress);
        this.burstLeft--;
        this.fireCd = this.burstLeft > 0 ? 60 / w.rpm : this.pause;
      }
    } else if (!this.visible && seenAgo > 3 && seenAgo < 6 && dist < 28 && Math.random() < (arch.grenadeChance ?? 0) * dt * 2 && !this.thrownRecently) {
      this._throwGrenade(this.lastKnown);
    }
    void frameDt;
  }

  _pickCombatSpot(target) {
    const g = this.game, a = this.actor, arch = a.arch;
    const [r0, r1] = arch.range ?? [10, 30];
    const pref = (r0 + r1) / 2;
    const dist = Math.hypot(target.x - a.pos.x, target.z - a.pos.z);
    this.inCover = false;
    if (arch.holdPosition && dist < r1 * 1.5) { this.path = null; this.inCover = true; return; }
    const phys = g.world.physics;
    const chest = _b.set(target.x, target.y + 1.2, target.z);
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 10; k++) {
      const ang = Math.random() * Math.PI * 2, r = k === 0 ? 0 : rand(2.5, 11);
      const x = a.pos.x + Math.cos(ang) * r, z = a.pos.z + Math.sin(ang) * r;
      const [ci, cj] = g.ai.nav.cellOf(x, z);
      if (!g.ai.nav.walkable(ci, cj)) continue;
      const y = g.world.terrain.heightAt(x, z);
      const d = Math.hypot(target.x - x, target.z - z);
      if (d < 3) continue;
      // cover: a low ray toward the target is blocked close to the spot, a high one isn't
      _a.set(x, y + 0.8, z);
      _d.subVectors(chest, _a);
      const len = _d.length();
      _d.divideScalar(len);
      const low = phys.raycast(_a, _d, Math.min(len, 4), { terrain: true });
      const cover = low && low.dist < 3.5 ? 1 : 0;
      let score = cover * 4 - Math.abs(d - pref) * 0.15 - r * 0.12 + Math.random() * 0.8;
      if (d < r0) score -= (r0 - d) * 0.5;
      if (score > bestScore) { bestScore = score; best = { x, z, cover }; }
    }
    if (!best) {
      // strafe sideways
      const side = Math.random() < 0.5 ? 1 : -1;
      _d.set(target.x - a.pos.x, 0, target.z - a.pos.z).normalize();
      best = { x: a.pos.x - _d.z * side * 5 + _d.x * (dist - pref) * 0.3, z: a.pos.z + _d.x * side * 5 + _d.z * (dist - pref) * 0.3, cover: 0 };
    }
    this.inCover = !!best.cover;
    const speed = Math.hypot(best.x - a.pos.x, best.z - a.pos.z) > 4 ? a.arch.runSpeed * 0.85 : a.arch.walkSpeed * 1.4;
    this.goal = best;
    this.goalSpeed = speed;
    this.path = [[best.x, best.z]];
    this.pathIdx = 0;
    // too far from the target: real path toward it
    if (dist > r1 * 1.3) this._goTo(target.x, target.z, a.arch.runSpeed);
  }

  /** wide: suppressive fire without a fire token (aims 1.3-2.5 m beside the player, deals no damage). */
  _shoot(w, dist, wide = false) {
    const g = this.game, a = this.actor, p = g.player, arch = a.arch;
    const origin = a.eyePos(_a);
    const muzzle = a.muzzleWorld(new THREE.Vector3());
    const aimPoint = _b.set(p.pos.x, p.pos.y + (p.crouched ? 0.9 : 1.3), p.pos.z);
    if (wide) {
      const side = (Math.random() < 0.5 ? -1 : 1) * rand(1.3, 2.5) / Math.max(0.1, Math.hypot(p.pos.x - origin.x, p.pos.z - origin.z));
      aimPoint.x += (p.pos.z - origin.z) * side;
      aimPoint.z -= (p.pos.x - origin.x) * side;
      aimPoint.y += rand(-0.8, 1.2);
    }
    // accuracy: ramps up with continuous sight, worse against a moving / distant target
    const acc = arch.accuracy ?? 0.5;
    const ramp = THREE.MathUtils.clamp(this.seeT / 3.5, 0, 1);
    const spreadDeg = (1 - acc) * 7 * (1.9 - ramp) + p.speed * 0.35 + (p.crouched ? 0.6 : 0) + dist * 0.01;
    const spread = (spreadDeg * Math.PI) / 180 / (g.difficulty?.aiAccuracy ?? 1);
    _d.subVectors(aimPoint, origin).normalize();
    const pellets = w.pellets ?? 1;
    if (w.projectile) {
      g.weapons.spawnRocketFrom(muzzle, _d.clone().add(new THREE.Vector3(rand(-1, 1), rand(-0.5, 1), rand(-1, 1)).multiplyScalar(spread * 2)).normalize(), w, a.id);
    } else {
      for (let i = 0; i < pellets; i++) {
        const dir = _d.clone().add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(Math.tan(spread))).normalize();
        g.weapons.hitscan(origin, dir, w, { attacker: a.id, ignoreActor: a, damageMul: wide ? 0 : (arch.damageScale ?? 0.5) * (g.difficulty?.aiDamage ?? 1) / pellets * (pellets > 1 ? 1.6 : 1), tracer: Math.random() < 0.4 ? muzzle : null });
      }
    }
    g.effects.muzzleFlash(muzzle, _d, 0.14);
    g.audio?.play(w.sound, { position: muzzle, volume: 0.85, priority: 1 });
    g.ai.noise(a.pos, (w.noise ?? 100) * 0.6, 'gunshot', a);
  }

  _throwGrenade(at) {
    const g = this.game, a = this.actor;
    this.thrownRecently = true;
    setTimeout(() => (this.thrownRecently = false), 8000);
    const from = a.eyePos(new THREE.Vector3());
    const dx = at.x - from.x, dz = at.z - from.z, dist = Math.hypot(dx, dz);
    const t = THREE.MathUtils.clamp(dist / 14, 0.6, 1.6);
    const gr = g.data.weapons.grenade.gravity;
    const vel = new THREE.Vector3(dx / t, (at.y - from.y + 0.5 * gr * t * t) / t, dz / t);
    g.weapons.spawnGrenade(from, vel, a.id, g.data.weapons.grenade.fuse);
    g.hud?.grenadeWarning?.();
  }
}

// ---------------------------------------------------------------------------------------------
export class AIDirector {
  constructor(game) {
    this.game = game;
    this.nav = new Nav(game.world);
    this.queue = [];
    this.playerVisibility = 1;
    this.playerMoving = false;
    this.trail = []; // the player's last footsteps on foot, { x, y, z, n } every metre (escorts retrace them)
    this.trailN = 0;
    this.combatLevel = 0;
    this.shooters = new Map(); // brain -> { until, dist }: fire tokens (enemies allowed to hit the player)
    this._buildFoliage();
  }

  /**
   * Fire token for a burst + its pause: at most difficulty.maxShooters enemies aim at the player
   * at once, so a big group doesn't melt them in a second. A much closer enemy takes the slot of
   * the farthest holder. Returns false = suppressive fire only.
   */
  takeShotToken(brain, hold, dist) {
    const t = this.game.time, max = this.game.difficulty?.maxShooters ?? 3;
    let far = null, farS = null;
    for (const [b, s] of this.shooters) {
      if (s.until < t || b.state !== 'combat' || !b.actor.alive) { this.shooters.delete(b); continue; }
      if (b !== brain && (!farS || s.dist > farS.dist)) { far = b; farS = s; }
    }
    if (!this.shooters.has(brain) && this.shooters.size >= max) {
      if (!far || dist > farS.dist * 0.6) return false;
      this.shooters.delete(far);
    }
    this.shooters.set(brain, { until: t + hold, dist });
    return true;
  }

  /** 2 m grid counting dense undergrowth (bush / fern / banana / bamboo) for player concealment. */
  _buildFoliage() {
    const veg = this.game.world.vegetation;
    const T = this.game.world.terrain;
    const n = Math.floor(T.size / 2);
    this.foliage = new Uint8Array(n * n);
    this.fn = n;
    if (!veg) return;
    const dense = new Set(veg.def.species.map((s, i) => (/bush|fern|banana|bamboo/.test(s.id) ? i : -1)).filter((i) => i >= 0));
    const d = veg.data;
    for (let k = 0; k < d.n; k++) {
      if (!dense.has(d.species[k])) continue;
      const r = Math.max(1, Math.round(d.scale[k] * 0.7));
      const ci = Math.floor((d.x[k] - T.x0) / 2), cj = Math.floor((d.z[k] - T.z0) / 2);
      for (let j = cj - r + 1; j < cj + r; j++) for (let i = ci - r + 1; i < ci + r; i++) if (i >= 0 && j >= 0 && i < n && j < n) this.foliage[j * n + i] = Math.min(255, this.foliage[j * n + i] + 1);
    }
  }

  foliageAt(x, z) {
    const T = this.game.world.terrain;
    const i = Math.floor((x - T.x0) / 2), j = Math.floor((z - T.z0) / 2);
    return i < 0 || j < 0 || i >= this.fn || j >= this.fn ? 0 : this.foliage[j * this.fn + i];
  }

  requestPath(brain, ax, az, bx, bz) {
    this.queue = this.queue.filter((q) => q.brain !== brain);
    this.queue.push({ brain, ax, az, bx, bz });
    brain.path = [[bx, bz]]; // move straight while waiting
    brain.pathIdx = 0;
  }

  /** A noise at pos audible within radius (m). kind: gunshot | explosion | footstep | melee | death */
  noise(pos, radius, kind, source) {
    this.game.birds?.noise(pos, radius, kind);
    for (const a of this.game.actors.list) {
      if (!a.alive || a === source || !a.ai) continue;
      const d = a.pos.distanceTo(pos);
      if (d < radius * (a.arch.hearing ?? 1)) a.ai.hear(pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z), kind);
    }
  }

  onEnemyAlerted(actor, quiet) {
    const g = this.game;
    if (!quiet) g.audio?.play('enemy_alert', { volume: 0.5 });
    g.hud?.onEnemyAlert?.(actor);
    // he shouts / radios after a short delay: squad + neighbours within earshot join the fight,
    // knowing where he last saw the player (not where the player is now). Killed before that,
    // he warns no one (and nobody runs to the alarm).
    setTimeout(() => {
      if (!actor.alive) return;
      const seen = actor.ai.lastKnown;
      for (const o of g.actors.list) {
        if (o === actor || !o.alive || !o.ai || o.ai.civilian || o.ai.dormant || o.ai.state === 'combat') continue;
        const same = actor.group && o.group === actor.group;
        if (same || o.pos.distanceTo(actor.pos) < 30) {
          o.ai.lastKnown.copy(seen);
          o.ai.lastSeenT = g.time - 2;
          o.ai.awareness = 1;
          o.ai.enterCombat(true);
        }
      }
      g.onAlert?.(actor);
    }, 600 + Math.random() * 900);
  }

  update(dt) {
    const g = this.game, p = g.player;
    // player concealment factor shared by all enemies this frame (undergrowth depends on where
    // each enemy looks from: AIBrain._undergrowth); night also shortens the vision range
    let v = 1;
    this.playerMoving = p.speed >= 0.3;
    if (p.crouched) v *= 0.55;
    if (p.sprinting) v *= 1.5; else if (!this.playerMoving) v *= 0.6;
    if (p.swimming) v *= 0.6;
    v *= THREE.MathUtils.lerp(1, 0.75, g.engine.lighting.night);
    if (g.flashlight?.on) v *= 1.8;
    this.playerVisibility = v;
    // footstep noise
    if (p.noise > 0 && p.onGround) this._stepNoiseT = (this._stepNoiseT ?? 0) - dt;
    if (p.noise > 2 && (this._stepNoiseT ?? 0) <= 0) { this._stepNoiseT = 0.5; this.noise(p.pos, p.noise, 'footstep'); }
    // player trail (a jump of more than 6 m = teleport: the old trail no longer connects)
    if (p.onGround && !p.swimming && !p.inVehicle) {
      const last = this.trail[this.trail.length - 1];
      const step = last ? Math.hypot(p.pos.x - last.x, p.pos.z - last.z) : Infinity;
      if (step > 6) this.trail.length = 0;
      if (step >= 1) {
        this.trail.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z, n: this.trailN++ });
        if (this.trail.length > 150) this.trail.shift();
      }
    }
    // path budget: a few A* per frame
    let budget = 3;
    while (this.queue.length && budget-- > 0) {
      const q = this.queue.shift();
      const path = this.nav.findPath(q.ax, q.az, q.bx, q.bz);
      if (path && q.brain.state !== 'dead') q.brain.setPath(path);
    }
    // combat intensity (music, HUD)
    let c = 0;
    for (const a of g.actors.list) if (a.alive && a.ai?.state === 'combat' && a.pos.distanceTo(p.pos) < 120) c++;
    this.combatLevel += ((c > 0 ? Math.min(1, 0.5 + c * 0.1) : 0) - this.combatLevel) * Math.min(1, dt * (c ? 2 : 0.3));
  }
}
