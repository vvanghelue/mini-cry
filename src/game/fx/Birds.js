// Birds: ambient wildlife around the camera (game only; tuning in public/data/game/birds.json).
// A bird is in one of three states:
//   rest   in a tree crown (perch) or on the beach (ground), wings folded: looks around, walks,
//          pecks, stretches its wings
//   orbit  soaring in circles around an anchor (gulls over the coast, frigatebirds up high)
//   fly    a cubic Bezier between two of those (takeoff, landing, joining / leaving an orbit,
//          arriving from / leaving for beyond the simulated radius), its end tangents matched to
//          the states it links so the motion never jumps
// plus fall / dead once shot. Flocks spawn and despawn around the camera (rest flocks far away,
// soaring ones fly in from beyond the radius), startle at gunshots, explosions and the player
// coming close, and call now and then (sounds.json).
//
// Drawing: one InstancedMesh per species (a draw call each; FX layer: no shadow, not in the SSAO
// pre-pass) with the shared lit material patched to flap / fold the wings in the vertex shader
// from a per-instance (angle, fold) attribute: every vertex beyond the shoulder (|x| > `shoulder`,
// asset space) is a wing vertex, bent more toward the tip. The bird assets are regular asset
// JSON (assets/bird_*.json, category "animal"): keep the body and tail inside the shoulder width.
import * as THREE from 'three/webgpu';
import { If, float, max, abs, sign, sin, cos, attribute } from 'three/tsl';
import { LAYERS } from '../../engine/render/layers.js';
import { InstancedBatch } from '../../engine/render/Instancing.js';
import { U } from '../../engine/render/tsl.js';
import { MATERIAL_ID } from '../../engine/world/TerrainData.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _c = new THREE.Color(), _o = new THREE.Vector3();
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (r, d) => (Array.isArray(r) ? rand(r[0], r[1]) : r ?? d);
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };

const DEFAULTS = { max: 32, flocks: 2, flock: [2, 5], scale: [0.9, 1.1], speed: 9, wobble: 0.5, startle: 10, callsPerMinute: 2, hitRadius: 0.3, shoulder: 0.065 };
const FLAP = { rate: 4, amp: 0.8, dihedral: 0.08, glide: 0.5 };

/** Asset-space wing deformation (vertex stage): every vertex beyond the shoulder bends with the
 *  per-instance (angle, fold) attribute aWing, more toward the tip. wing: uniform (shoulder, half span). */
const wingDeform = (wing) => (p0) => {
  const p = p0.toVar();
  const aWing = attribute('aWing', 'vec2');
  const ax = abs(p.x);
  If(ax.greaterThan(wing.x), () => {
    const s = sign(p.x), len = max(wing.y.sub(wing.x), 1e-3);
    const d = ax.sub(wing.x).toVar(), k = d.div(len).toVar(), fold = aWing.y;
    // folded: the wing closes along the body (span shrinks, the tip swept back and down)
    p.z.addAssign(fold.mul(k).mul(len).mul(0.55));
    p.y.subAssign(fold.mul(k).mul(0.03));
    d.mulAssign(float(1.0).sub(fold.mul(0.93)));
    const a = aWing.x.mul(k.mul(0.8).add(0.6)); // the outer wing bends more
    p.x.assign(s.mul(wing.x.add(d.mul(cos(a)))));
    p.y.addAssign(d.mul(sin(a)));
  });
  return p;
};

function birdMaterial(lighting, wing) {
  const m = new THREE.MeshLambertNodeMaterial({ flatShading: true, vertexColors: true });
  m.mcWing = U(wing);
  return lighting.patch(m, { deform: wingDeform(m.mcWing) });
}

function bezier(a, b, c, d, t, out) {
  const u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return out.set(a.x * k0 + b.x * k1 + c.x * k2 + d.x * k3, a.y * k0 + b.y * k1 + c.y * k2 + d.y * k3, a.z * k0 + b.z * k1 + c.z * k2 + d.z * k3);
}

/** Point of an orbit (anchor, radius r, height h above the anchor, phase ph) at angle th. */
function orbitPos(A, r, h, ph, th, out) {
  const rr = r * (1 + 0.1 * Math.sin(2 * th + ph));
  return out.set(A.x + Math.cos(th) * rr, A.y + h + 1.2 * Math.sin(th * 2 + ph * 1.3), A.z + Math.sin(th) * rr);
}

/** Up to 16 points on top of a tree's crown (asset space): { pts: [x, y, z, ...], top }. */
function perchPoints(b) {
  const p = b.geometry.attributes.position.array, top = b.bounds.max.y, h = top - Math.max(0, b.bounds.min.y);
  // crown centre and radius: the top 30 % of the tree
  let n = 0, cx = 0, cz = 0, r = 0;
  for (let i = 0; i < p.length; i += 3) if (p[i + 1] > top - 0.3 * h) { cx += p[i]; cz += p[i + 2]; n++; }
  cx /= n || 1; cz /= n || 1;
  for (let i = 0; i < p.length; i += 3) if (p[i + 1] > top - 0.3 * h) r = Math.max(r, Math.hypot(p[i] - cx, p[i + 2] - cz));
  const pts = [];
  for (let tries = 0; tries < 48 && pts.length < 48; tries++) {
    const a = Math.random() * TAU, rr = Math.sqrt(Math.random()) * r * 0.6, x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    let y = -Infinity;
    for (let i = 0; i < p.length; i += 9) { // highest triangle under (x, z)
      const ax = p[i], az = p[i + 2], bx = p[i + 3], bz = p[i + 5], qx = p[i + 6], qz = p[i + 8];
      const det = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
      if (Math.abs(det) < 1e-8) continue;
      const u = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / det, v = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / det;
      if (u < 0 || v < 0 || u + v > 1) continue;
      y = Math.max(y, u * p[i + 1] + v * p[i + 4] + (1 - u - v) * p[i + 7]);
    }
    if (y > top - 0.35 * h) pts.push(x, y, z);
  }
  return { pts, top };
}

class Species {
  constructor(id, cfg, world) {
    this.id = id;
    this.cfg = cfg = { ...DEFAULTS, ...cfg, flap: { ...FLAP, ...cfg.flap } };
    const b = world.assets.build(cfg.asset);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', b.geometry.attributes.position);
    geo.setAttribute('color', b.geometry.attributes.color);
    this.max = cfg.max;
    this.wing = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const span = Math.max(-b.bounds.min.x, b.bounds.max.x);
    this.pivot = (b.bounds.min.y + b.bounds.max.y) / 2; // body centre (asset origin = feet)
    this.material = birdMaterial(world.lighting, new THREE.Vector2(cfg.shoulder, span));
    const mesh = (this.mesh = new InstancedBatch(geo, this.material, this.max));
    mesh.name = `Birds:${id}`;
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('iTint', this.tint);
    mesh.geometry.setAttribute('aWing', this.wing);
    mesh.layers.set(LAYERS.FX);
    this.feathers = new THREE.Color(cfg.feathers ?? '#e8e8e4').getHex();
    this.birds = [];
    this.trees = null; // vegetation species indices it perches in
  }
}

export class Birds {
  constructor(game, def = {}) {
    this.game = game;
    this.world = game.world;
    this.def = def;
    this.radius = def.radius ?? 260;
    this.despawn = def.despawn ?? 340;
    this.group = new THREE.Group();
    this.group.name = 'Birds';
    this.species = [];
    for (const [id, cfg] of Object.entries(def.species ?? {})) {
      if (!this.world.assets.has(cfg.asset)) { console.warn(`birds: ${id}: unknown asset ${cfg.asset}`); continue; }
      const sp = new Species(id, cfg, this.world);
      this.species.push(sp);
      this.group.add(sp.mesh);
    }
    game.engine.scene.add(this.group);
    this.flocks = [];
    this.time = 0;
    this._spawnT = 0;
    this._proxT = 0;
    this._first = true;
    this._lastCam = new THREE.Vector3();
    this._crowns = new Map();
    this._buildTreeIndex();
    this._enabled = game.params?.get('birds') !== '0';
    this.group.visible = this._enabled;
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.group.visible = this._enabled;
    if (!v) this.clear();
  }

  clear() {
    for (const sp of this.species) { sp.birds.length = 0; sp.mesh.instances = 0; }
    this.flocks.length = 0;
    this._first = true;
  }

  // --- per frame ---------------------------------------------------------------------------
  update(dt) {
    if (!this._enabled || !this.species.length) return;
    this.time += dt;
    const cam = this.game.engine.camera.position;
    this.night = this.world.lighting.night > 0.5;
    // teleport / fast travel: start over around the new place
    if (this._lastCam.distanceToSquared(cam) > 80 * 80) { this.clear(); this._spawnT = 0; }
    this._lastCam.copy(cam);
    if ((this._spawnT -= dt) <= 0) { this._spawnT = 0.4; this._manage(cam); }
    const prox = (this._proxT -= dt) <= 0;
    if (prox) this._proxT = 0.25;
    for (let i = this.flocks.length - 1; i >= 0; i--) this._updateFlock(this.flocks[i], dt, prox, cam);
    for (const sp of this.species) {
      for (let i = sp.birds.length - 1; i >= 0; i--) this._updateBird(sp.birds[i], dt, cam);
      this._upload(sp);
    }
  }

  _updateFlock(f, dt, prox, cam) {
    if (!f.birds.length) { this.flocks.splice(this.flocks.indexOf(f), 1); return; }
    const cfg = f.sp.cfg;
    f.timer -= dt;
    if (f.mode === 'fly') {
      let done = true;
      for (const b of f.birds) if (b.state === 'fly' || b.pending) { done = false; break; }
      if (done) { f.mode = f.next; f.timer = pick(f.mode === 'orbit' ? cfg.orbit?.time : f.where === 'tree' ? cfg.perch?.time : cfg.ground?.time, 60); }
    } else if (f.mode === 'rest') {
      if (prox && this._threatened(f, cam)) this.startle(f, cam);
      else if (f.timer <= 0 && !this.night) this._relocate(f);
    } else if (f.mode === 'orbit') {
      if (f.timer <= 0 || (this.night && cfg.day)) this._leaveOrbit(f, cam);
    }
    // calls (by day), from one of the birds
    if (cfg.call && f.mode !== 'fly' && (f.callT -= dt) <= 0) {
      f.callT = (60 / Math.max(0.01, cfg.callsPerMinute)) * rand(0.5, 1.5);
      const b = f.birds[Math.floor(Math.random() * f.birds.length)];
      if (!this.night && b.pos.distanceToSquared(cam) < 160 * 160) this.game.audio?.play(cfg.call, { position: b.pos, volume: 0.8 });
    }
  }

  _updateBird(b, dt, cam) {
    const sp = b.sp;
    if (b.pending && (b.delay -= dt) <= 0) this._startFly(b);
    switch (b.state) {
      case 'rest': this._rest(b, dt); break;
      case 'orbit': b.theta += b.w * dt; orbitPos(b.anchor, b.r, b.h, b.ph, b.theta, b.pos); break;
      case 'fly': {
        b.t = Math.min(1, b.t + dt / b.dur);
        bezier(b.b0, b.b1, b.b2, b.b3, b.t, b.pos);
        const env = Math.sin(Math.PI * b.t) * sp.cfg.wobble;
        b.pos.addScaledVector(b.side, Math.sin(this.time * 1.7 + b.ph) * env);
        b.pos.y += Math.sin(this.time * 1.1 + b.ph * 2) * env * 0.5;
        if (b.t >= 1) this._arrive(b);
        break;
      }
      case 'fall': this._fall(b, dt); break;
      // 'wait': spawned beyond the radius, about to fly in
      case 'dead': if ((b.life -= dt) <= 0 || b.pos.distanceToSquared(cam) > this.despawn * this.despawn) this._remove(b); break;
    }
    if (b.removed) return;
    this._orient(b, dt);
    this._flap(b, dt);
  }

  _rest(b, dt) {
    if ((b.idleT -= dt) <= 0) {
      b.idleT = rand(1.5, 6);
      const r = Math.random();
      if (r < 0.15) b.flick = rand(0.4, 0.9); // stretch / shake the wings
      else if (b.ground && r < 0.55) { // a few steps around its spot
        const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * 1.5;
        b.walkTo.set(b.spot.x + Math.cos(a) * d, 0, b.spot.z + Math.sin(a) * d);
        b.walking = this.world.terrain.heightAt(b.walkTo.x, b.walkTo.z) > 0.15;
      } else if (b.ground && r < 0.8) b.peck = rand(0.3, 0.6);
      else b.restYaw += rand(-1.2, 1.2);
    }
    b.flick -= dt;
    b.peck -= dt;
    if (b.walking) {
      _v.set(b.walkTo.x - b.pos.x, 0, b.walkTo.z - b.pos.z);
      const d = _v.length(), step = 0.45 * b.scale * dt;
      if (d <= step) b.walking = false;
      else {
        b.pos.addScaledVector(_v, step / d);
        b.restYaw = Math.atan2(-_v.x, -_v.z);
      }
      b.pos.y = this.world.terrain.heightAt(b.pos.x, b.pos.z) + b.sp.pivot * b.scale;
    }
  }

  _fall(b, dt) {
    b.vel.y -= 9.8 * dt;
    b.vel.multiplyScalar(Math.max(0, 1 - 0.4 * dt));
    b.pos.addScaledVector(b.vel, dt);
    const T = this.world.terrain, sea = T.seaLevel;
    const g = this.world.physics.groundAt(b.pos.x, b.pos.z, 0.1, b.pos.y + 0.5);
    if (b.pos.y < sea && g < sea) {
      this.game.effects?.burst(_v.set(b.pos.x, sea, b.pos.z), { count: 8, color: 0xe8f6ff, speed: 2.5, up: 3, spread: 0.3, life: 0.5, size: 0.05 });
      this._remove(b);
    } else if (b.pos.y - b.sp.pivot * b.scale * 0.4 <= g) {
      b.state = 'dead';
      b.pos.y = g + b.sp.pivot * b.scale * 0.4;
      b.pitch = rand(-0.2, 0.2);
      b.roll = Math.sign(b.roll || 1) * rand(1.1, 1.5); // on its side
      b.life = 30;
    }
  }

  /** Heading / pitch from the velocity, bank from the turn rate (smoothed). */
  _orient(b, dt) {
    if (dt <= 0) return;
    b.vel.subVectors(b.pos, b.prev).divideScalar(dt);
    b.prev.copy(b.pos);
    if (b.state === 'dead') return;
    if (b.state === 'fall') { b.roll += b.spinR * dt; b.pitch += b.spinP * dt; return; }
    const k = Math.min(1, dt * 8);
    if (b.state === 'rest') {
      b.yaw += angDiff(b.restYaw, b.yaw) * Math.min(1, dt * 5);
      b.pitch += ((b.peck > 0 ? -0.6 : b.restPitch) - b.pitch) * k;
      b.roll -= b.roll * k;
      return;
    }
    const v = b.vel, hs = Math.hypot(v.x, v.z);
    if (hs + Math.abs(v.y) < 0.3) return;
    const dy = angDiff(Math.atan2(-v.x, -v.z), b.yaw) * k;
    b.yaw += dy;
    b.pitch += (THREE.MathUtils.clamp(Math.atan2(v.y, hs), -0.8, 0.8) * 0.8 - b.pitch) * k;
    const roll = THREE.MathUtils.clamp(Math.atan(((dy / dt) * hs) / 9.8), -1, 1);
    b.roll += (roll - b.roll) * Math.min(1, dt * 4);
  }

  /** Wing angle and fold: flap bursts and glides, hard flapping at takeoff / landing / climbing. */
  _flap(b, dt) {
    const F = b.sp.cfg.flap;
    let want = 0, fold = 0, rate = F.rate;
    if (b.state === 'rest') { want = b.flick > 0 ? 1 : 0; fold = b.flick > 0 ? 0.15 : 1; rate *= 1.2; }
    else if (b.state === 'fall') { want = 0.4; fold = 0.35; rate *= 1.6; }
    else if (b.state === 'dead') { fold = 0.55; }
    else {
      if ((b.burst -= dt) <= 0) {
        b.bursting = !b.bursting;
        const d = rand(0.5, 1.6);
        b.burst = b.bursting ? d : Math.min(10, (d * F.glide) / Math.max(0.05, 1 - F.glide));
      }
      want = b.bursting ? 1 : 0;
      if (b.state === 'fly' && ((b.fromRest && b.t < 0.3) || (b.toRest && b.t > 0.75))) { want = 1; rate *= 1.35; }
      if (b.vel.y > 1.2) want = 1;
    }
    b.flapW += (want - b.flapW) * Math.min(1, dt * 5);
    b.fold += (fold - b.fold) * Math.min(1, dt * (fold > b.fold ? 4 : 10));
    b.flapPhase += dt * TAU * rate;
    b.angle = (F.dihedral + b.flapW * F.amp * Math.sin(b.flapPhase)) * (1 - b.fold);
  }

  _upload(sp) {
    const mesh = sp.mesh, n = sp.birds.length, wing = sp.wing.array;
    if (!n && !mesh.instances) return;
    for (let i = 0; i < n; i++) {
      const b = sp.birds[i];
      _q.setFromEuler(_e.set(b.pitch, b.yaw, b.roll));
      _o.set(0, sp.pivot * b.scale, 0).applyQuaternion(_q); // rotate about the body centre
      mesh.setMatrixAt(i, _m.compose(_w.copy(b.pos).sub(_o), _q, _s.setScalar(b.scale)));
      wing[i * 2] = b.angle;
      wing[i * 2 + 1] = b.fold;
      if (b.slot !== i) { b.slot = i; sp.tint.setXYZ(i, b.tint, b.tint, b.tint); sp.colorsDirty = true; }
    }
    mesh.instances = n;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    sp.wing.clearUpdateRanges();
    sp.wing.addUpdateRange(0, n * 2);
    sp.wing.needsUpdate = true;
    if (sp.colorsDirty) { sp.tint.needsUpdate = true; sp.colorsDirty = false; }
  }

  // --- flock decisions ---------------------------------------------------------------------
  _threatened(f, cam) {
    const p = this.game.player;
    const r = f.sp.cfg.startle * (p?.crouched ? 0.55 : 1) * (p?.inVehicle ? 2.5 : 1);
    for (const b of f.birds) if (b.pos.distanceToSquared(cam) < r * r) return true;
    return false;
  }

  /** Something scared the flock (a noise or the player at `from`): resting birds take off. */
  startle(f, from) {
    const sp = f.sp, cfg = sp.cfg, c = this._center(f, new THREE.Vector3());
    if (f.mode === 'fly') return;
    const away = _d.set(c.x - from.x, 0, c.z - from.z);
    if (away.lengthSq() < 1e-4) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    away.normalize();
    if (f.mode === 'orbit') { this._newOrbit(f, c.addScaledVector(away, 70)); return; }
    this.game.audio?.play('bird_takeoff', { position: c, volume: Math.min(1, 0.45 + 0.1 * f.birds.length) });
    if (cfg.call && !this.night) setTimeout(() => this.game.audio?.play(cfg.call, { position: c, volume: 0.9 }), 150 + Math.random() * 300);
    if (f.where === 'tree') {
      const k = this._treeToward(sp, c, away, 70, 180);
      if (k >= 0) this._toTree(f, k, { delay: [0, 0.5], speed: 1.3, away });
      else this._exit(f, c, away, { delay: [0, 0.5], speed: 1.3 });
    } else {
      // ground birds circle above, a bit further from the threat
      const A = c.clone().addScaledVector(away, 25);
      this._joinOrbit(f, A, { delay: [0, 0.5], speed: 1.2, away });
    }
  }

  /** Calm move: a perched flock hops to another tree, a ground flock goes for a flight. */
  _relocate(f) {
    const sp = f.sp, c = this._center(f, new THREE.Vector3());
    if (f.where === 'tree') {
      const hop = sp.cfg.perch?.hop ?? [40, 140];
      const dir = _d.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      const k = this._treeToward(sp, c, dir, hop[0], hop[1]);
      if (k >= 0) this._toTree(f, k, { delay: [0, 1.5] });
      else f.timer = pick(sp.cfg.perch?.time, 60);
    } else if (sp.cfg.orbit) {
      this._joinOrbit(f, c.clone().add(_d.set(rand(-20, 20), 0, rand(-20, 20))), { delay: [0, 1.2] });
    } else f.timer = 60;
  }

  _leaveOrbit(f, cam) {
    const sp = f.sp, c = this._center(f, new THREE.Vector3());
    const spot = sp.cfg.ground ? this._findGround(sp, c, 0, 140, 12) : null;
    if (spot && (this.night || Math.random() < 0.6)) this._toGround(f, spot);
    else if (this.night && sp.cfg.day) this._exit(f, c, _d.set(c.x - cam.x, 0, c.z - cam.z).normalize(), {});
    else this._newOrbit(f, c.add(_d.set(rand(-1, 1), 0, rand(-1, 1)).normalize().multiplyScalar(rand(60, 140))));
  }

  _newOrbit(f, A, opts = {}) {
    const o = f.sp.cfg.orbit ?? {};
    if (o.where === 'coast') { const p = this._coastNear(A.x, A.z); if (p) A.set(p.x, 0, p.z); }
    this._joinOrbit(f, A, opts);
  }

  // --- moves (one Bezier per bird, see _startFly) -------------------------------------------
  _flockFly(f, next, target, { delay = [0, 0.6], speed = 1, away = null } = {}) {
    f.mode = 'fly';
    f.next = next;
    f.birds.forEach((b, j) => {
      b.pending = target(b, j);
      b.pending.speed = speed;
      b.pending.away = away ? away.clone() : null;
      b.delay = rand(delay[0], delay[1]);
    });
  }

  _toTree(f, k, opts) {
    const cr = this._crown(k), sp = f.sp;
    f.where = 'tree';
    this._flockFly(f, 'rest', (b) => ({ pos: this._perchSpot(cr, sp, b, new THREE.Vector3()), then: { kind: 'rest', pitch: sp.cfg.perch?.pitch ?? 0.3, ground: false } }), opts);
  }

  _toGround(f, spot, opts) {
    const sp = f.sp, spread = sp.cfg.ground?.spread ?? 4, T = this.world.terrain;
    f.where = 'ground';
    this._flockFly(f, 'rest', (b) => {
      const p = new THREE.Vector3();
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * spread;
        p.set(spot.x + Math.cos(a) * d, 0, spot.z + Math.sin(a) * d);
        if (T.heightAt(p.x, p.z) > 0.2) break;
        p.set(spot.x, 0, spot.z);
      }
      p.y = T.heightAt(p.x, p.z) + sp.pivot * b.scale;
      return { pos: p, then: { kind: 'rest', pitch: 0, ground: true } };
    }, { delay: [0, 1.5], ...opts });
  }

  /** Every bird of the flock joins an orbit around A (A.y is set to the orbit's base altitude). */
  _joinOrbit(f, A, opts) {
    const sp = f.sp, o = sp.cfg.orbit ?? { radius: [20, 40], height: [12, 30] };
    const R = pick(o.radius, 30);
    A.y = this._orbitBase(A.x, A.z, R * 1.2);
    const w = (Math.random() < 0.5 ? -1 : 1) * (sp.cfg.speed / R);
    f.anchor = A;
    this._flockFly(f, 'orbit', (b) => {
      const th = Math.atan2(b.pos.z - A.z, b.pos.x - A.x) + Math.sign(w) * rand(0.4, 1);
      const r = R * rand(0.8, 1.2), h = pick(o.height, 20);
      return { pos: orbitPos(A, r, h, b.ph, th, new THREE.Vector3()), tangent: new THREE.Vector3(-Math.sin(th), 0, Math.cos(th)).multiplyScalar(Math.sign(w)), then: { kind: 'orbit', theta: th, r, h, w, anchor: A } };
    }, opts);
  }

  /** Fly out beyond the despawn radius and disappear. */
  _exit(f, c, dir, opts) {
    const cam = this.game.engine.camera.position;
    const d = this.despawn + 40 - Math.hypot(c.x - cam.x, c.z - cam.z);
    this._flockFly(f, 'gone', (b) => ({ pos: b.pos.clone().addScaledVector(dir, Math.max(60, d)).add(_v.set(rand(-8, 8), rand(10, 25), rand(-8, 8))), then: { kind: 'gone' } }), opts);
  }

  _startFly(b) {
    const p = b.pending, sp = b.sp, T = this.world.terrain;
    b.pending = null;
    const fromRest = b.state === 'rest';
    b.b0.copy(b.pos);
    b.b3.copy(p.pos);
    const L = Math.max(1, b.b0.distanceTo(b.b3));
    const dir = _d.set(b.b3.x - b.b0.x, 0, b.b3.z - b.b0.z);
    if (dir.lengthSq() < 1e-6) dir.set(-Math.sin(b.yaw), 0, -Math.cos(b.yaw));
    dir.normalize();
    if (fromRest) b.b1.copy(b.b0).addScaledVector(p.away ?? dir, 0.12 * L).addScaledVector(UP, Math.max(2, 0.2 * L)); // up and away
    else if (b.vel.lengthSq() > 0.01) b.b1.copy(b.b0).addScaledVector(_v.copy(b.vel).normalize(), L / 3); // keep its heading
    else b.b1.copy(b.b0).addScaledVector(dir, L / 3);
    if (p.then.kind === 'rest') b.b2.copy(b.b3).addScaledVector(dir, -0.12 * L).addScaledVector(UP, Math.max(2, 0.18 * L)); // drop in from above
    else if (p.tangent) b.b2.copy(b.b3).addScaledVector(p.tangent, -L / 3); // merge into the orbit
    else b.b2.copy(b.b3).addScaledVector(dir, -L / 3);
    if (L > 30) { // long flights stay above the canopy / ridges
      const g = Math.max(T.heightAt((b.b0.x + b.b3.x) / 2, (b.b0.z + b.b3.z) / 2), T.seaLevel) + 18;
      b.b1.y = Math.max(b.b1.y, g);
      b.b2.y = Math.max(b.b2.y, g);
    }
    const len = (b.b0.distanceTo(b.b1) + b.b1.distanceTo(b.b2) + b.b2.distanceTo(b.b3) + L) / 2;
    b.dur = len / (sp.cfg.speed * b.speedMul * (p.speed ?? 1));
    b.t = 0;
    b.state = 'fly';
    b.then = p.then;
    b.fromRest = fromRest;
    b.toRest = p.then.kind === 'rest';
    b.walking = false;
    b.side.set(-dir.z, 0, dir.x);
  }

  _arrive(b) {
    const t = b.then;
    if (t.kind === 'gone') { this._remove(b); return; }
    if (t.kind === 'orbit') {
      b.state = 'orbit';
      b.theta = t.theta; b.r = t.r; b.h = t.h; b.w = t.w; b.anchor = t.anchor;
      return;
    }
    b.state = 'rest';
    b.spot.copy(b.pos);
    b.restYaw = b.yaw;
    b.restPitch = t.pitch;
    b.ground = t.ground;
    b.idleT = rand(0.5, 3);
    b.prev.copy(b.pos);
  }

  // --- birds -------------------------------------------------------------------------------
  _newFlock(sp, mode, where) {
    const f = { sp, mode, where, next: mode, birds: [], anchor: null, timer: 60, callT: rand(2, 20) };
    const n = Math.min(Math.round(pick(sp.cfg.flock, 3)), sp.max - sp.birds.length);
    for (let i = 0; i < n; i++) this._newBird(sp, f);
    this.flocks.push(f);
    return f;
  }

  _newBird(sp, f) {
    const V = () => new THREE.Vector3();
    const b = {
      sp, flock: f, state: 'rest', removed: false, slot: -1, tint: rand(0.9, 1.04),
      pos: V(), prev: V(), vel: V(), spot: V(), walkTo: V(), side: V(), b0: V(), b1: V(), b2: V(), b3: V(),
      yaw: Math.random() * TAU, pitch: 0, roll: 0, restYaw: 0, restPitch: 0, scale: pick(sp.cfg.scale, 1), speedMul: rand(0.92, 1.08),
      t: 0, dur: 1, delay: 0, pending: null, then: null, fromRest: false, toRest: false,
      theta: 0, r: 0, h: 0, w: 0, anchor: null, ph: Math.random() * TAU,
      flapPhase: Math.random() * TAU, flapW: 0, fold: 1, angle: 0, burst: Math.random(), bursting: false,
      flick: 0, peck: 0, walking: false, ground: false, idleT: rand(0.5, 4), life: 0, spinR: 0, spinP: 0,
    };
    b.restYaw = b.yaw;
    sp.birds.push(b);
    f.birds.push(b);
    return b;
  }

  _remove(b) {
    const list = b.sp.birds, i = list.indexOf(b);
    if (i >= 0) { list[i] = list[list.length - 1]; list.pop(); }
    if (b.flock) { const j = b.flock.birds.indexOf(b); if (j >= 0) b.flock.birds.splice(j, 1); b.flock = null; }
    b.removed = true;
  }

  _center(f, out) {
    out.set(0, 0, 0);
    for (const b of f.birds) out.add(b.pos);
    return out.divideScalar(Math.max(1, f.birds.length));
  }

  /** Bullet from the player: the nearest bird within its hit radius of the ray dies (the bullet goes on). */
  shoot(ray, maxDist) {
    if (!this._enabled) return null;
    let best = null, bd = maxDist;
    for (const sp of this.species) {
      const r = sp.cfg.hitRadius;
      for (const b of sp.birds) {
        if (b.state === 'fall' || b.state === 'dead') continue;
        _v.subVectors(b.pos, ray.origin);
        const t = _v.dot(ray.direction);
        if (t <= 0 || t >= bd || _v.lengthSq() - t * t > (r * b.scale) ** 2) continue;
        bd = t;
        best = b;
      }
    }
    if (best) this.kill(best, ray.direction);
    return best;
  }

  kill(b, dir) {
    const f = b.flock, fx = this.game.effects;
    if (f) { f.birds.splice(f.birds.indexOf(b), 1); b.flock = null; if (f.birds.length) this.startle(f, b.pos); }
    b.state = 'fall';
    b.pending = null;
    b.vel.addScaledVector(dir, 3).y += 1.5;
    b.spinR = rand(-8, 8);
    b.spinP = rand(-4, 4);
    fx?.burst(b.pos, { count: 14, color: b.sp.feathers, speed: 2.2, up: 1.2, life: 1.6, size: 0.035, gravity: 1.5, drag: 2.5 });
    fx?.burst(b.pos, { count: 4, color: 0x8a0a0a, speed: 1.5, life: 0.4, size: 0.03 });
    this.game.audio?.play('bullet_impact_flesh', { position: b.pos, volume: 0.5 });
  }

  /** A noise at pos (AIDirector.noise): gunshots and explosions scare the flocks within range. */
  noise(pos, radius, kind) {
    if (!this._enabled || (kind !== 'gunshot' && kind !== 'explosion')) return;
    const R = Math.min(radius, 160) * (kind === 'explosion' ? 1.5 : 1);
    for (const f of this.flocks) {
      if (f.mode === 'fly' || !f.birds.length) continue;
      const r = R * (f.mode === 'orbit' ? 0.4 : 1);
      if (this._center(f, _w).distanceToSquared(pos) < r * r) this.startle(f, pos);
    }
  }

  // --- spawning ----------------------------------------------------------------------------
  _manage(cam) {
    // despawn the flocks left behind (an empty flock goes in _updateFlock)
    const D2 = this.despawn * this.despawn;
    for (const f of this.flocks) {
      if (f.mode === 'fly') continue;
      let far = true;
      for (const b of f.birds) if (b.pos.distanceToSquared(cam) <= D2) { far = false; break; }
      if (far) for (let i = f.birds.length - 1; i >= 0; i--) this._remove(f.birds[i]);
    }
    // spawn (one flock per species per call; the first call fills the area)
    const first = this._first;
    this._first = false;
    for (const sp of this.species) {
      const cfg = sp.cfg;
      for (let tries = first ? cfg.flocks : 1; tries > 0; tries--) {
        let n = 0;
        for (const f of this.flocks) if (f.sp === sp) n++;
        if (n >= cfg.flocks || sp.birds.length + pick(cfg.flock, 3) > sp.max) break;
        this._spawn(sp, cam, first);
      }
    }
  }

  _spawn(sp, cam, first) {
    const cfg = sp.cfg, dmin = first ? 30 : this.radius * 0.5;
    const ways = [];
    if (cfg.perch && sp.trees) ways.push('tree');
    if (cfg.ground && Math.random() < (cfg.ground.share ?? 0.5)) ways.unshift('ground');
    if (cfg.orbit && !(this.night && cfg.day)) ways.push('orbit');
    if (cfg.ground && !ways.includes('ground')) ways.push('ground');
    for (const way of ways) {
      if (way === 'tree') {
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * TAU, d = rand(dmin, this.radius);
          const k = this._nearestTree(sp, cam.x + Math.cos(a) * d, cam.z + Math.sin(a) * d, 25);
          if (k < 0) continue;
          const cr = this._crown(k), f = this._newFlock(sp, 'rest', 'tree');
          for (const b of f.birds) { this._perchSpot(cr, sp, b, b.pos); this._arrive(Object.assign(b, { then: { kind: 'rest', pitch: cfg.perch.pitch ?? 0.3, ground: false } })); }
          f.timer = pick(cfg.perch.time, 60);
          return f;
        }
      } else if (way === 'ground') {
        const spot = this._findGround(sp, cam, dmin, this.radius, 10);
        if (!spot) continue;
        const f = this._newFlock(sp, 'rest', 'ground');
        this._toGround(f, spot);
        for (const b of f.birds) { b.pos.copy(b.pending.pos); b.pending = null; b.yaw = b.restYaw = Math.random() * TAU; this._arrive(Object.assign(b, { then: { kind: 'rest', pitch: 0, ground: true } })); }
        f.mode = 'rest';
        f.timer = pick(cfg.ground.time, 60);
        return f;
      } else if (way === 'orbit') {
        const A = this._orbitAnchor(sp, cam, first ? 20 : this.radius * 0.3, this.radius * 0.85);
        if (!A) continue;
        const f = this._newFlock(sp, 'fly', null);
        // arrive from beyond the radius (no pop), or start circling right away on the first fill
        const dir = _d.set(A.x - cam.x, 0, A.z - cam.z).normalize();
        for (const b of f.birds) {
          b.state = 'wait';
          b.pos.set(cam.x, 0, cam.z).addScaledVector(dir, this.despawn * 0.92).add(_v.set(rand(-15, 15), 0, rand(-15, 15)));
          b.pos.y = this._orbitBase(b.pos.x, b.pos.z, 10) + pick(cfg.orbit.height, 20);
          b.vel.copy(dir).multiplyScalar(-cfg.speed);
          b.prev.copy(b.pos);
          b.fold = 0;
        }
        this._joinOrbit(f, A, { delay: [0, 2] });
        if (first) for (const b of f.birds) { this._startFly(b); b.t = 1; bezier(b.b0, b.b1, b.b2, b.b3, 1, b.pos); this._arrive(b); b.prev.copy(b.pos); }
        f.timer = pick(cfg.orbit.time, 60);
        return f;
      }
    }
    return null;
  }

  _orbitAnchor(sp, cam, dmin, dmax) {
    const where = sp.cfg.orbit.where ?? 'any';
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU, d = rand(dmin, dmax), x = cam.x + Math.cos(a) * d, z = cam.z + Math.sin(a) * d;
      if (!this.world.terrain.inBounds(x, z)) continue;
      if (where === 'coast') { const p = this._coastNear(x, z); if (p) return new THREE.Vector3(p.x, 0, p.z); }
      else return new THREE.Vector3(x, 0, z);
    }
    return null;
  }

  /** (x, z) itself if over the shallow sea / beach with land within ~120 m, else null. */
  _coastNear(x, z) {
    const T = this.world.terrain, h = T.heightAt(x, z);
    if (h > 3 || h < T.seaLevel - 30) return null;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      for (let d = 40; d <= 120; d += 40) if (T.heightAt(x + Math.cos(a) * d, z + Math.sin(a) * d) > 2) return { x, z };
    }
    return null;
  }

  /** Altitude an orbit of radius R around (x, z) is measured from: the highest ground under it. */
  _orbitBase(x, z, R) {
    const T = this.world.terrain;
    let h = Math.max(T.heightAt(x, z), T.seaLevel);
    for (let k = 0; k < 8; k++) h = Math.max(h, T.heightAt(x + Math.cos((k / 8) * TAU) * R, z + Math.sin((k / 8) * TAU) * R));
    return h;
  }

  /** A clear, flat beach spot (species ground.materials) between dmin and dmax of c, or null. */
  _findGround(sp, c, dmin, dmax, tries) {
    const T = this.world.terrain, g = sp.cfg.ground;
    const mats = (sp._mats ??= new Set((g.materials ?? ['sand']).map((m) => MATERIAL_ID[m])));
    for (let i = 0; i < tries; i++) {
      const a = Math.random() * TAU, d = rand(dmin, dmax), x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      if (!T.inBounds(x, z) || !mats.has(T.materialAtWorld(x, z))) continue;
      const h = T.heightAt(x, z);
      if (h < 0.3 || h > 5 || T.normalAt(x, z).y < 0.92) continue;
      if (this.world.physics.raycast(_v.set(x, h + 12, z), DOWN, 14, { terrain: false })) continue; // under a roof / dock
      return new THREE.Vector3(x, h, z);
    }
    return null;
  }

  // --- trees -------------------------------------------------------------------------------
  /** Grid (32 m cells) of the vegetation instances birds perch in. */
  _buildTreeIndex() {
    const V = this.world.vegetation;
    if (!V) return;
    const defs = V.def.species;
    const used = new Set();
    for (const sp of this.species) {
      const ids = sp.cfg.perch?.trees;
      if (!ids) continue;
      sp.trees = new Set(ids.map((id) => defs.findIndex((s) => s.id === id)).filter((i) => i >= 0));
      for (const i of sp.trees) used.add(i);
    }
    if (!used.size) return;
    const d = V.data, T = this.world.terrain, cell = 32, n = Math.ceil(T.size / cell);
    const cells = new Map();
    for (let k = 0; k < d.n; k++) {
      if (!used.has(d.species[k])) continue;
      const key = Math.floor((d.z[k] + T.half) / cell) * n + Math.floor((d.x[k] + T.half) / cell);
      let a = cells.get(key);
      if (!a) cells.set(key, (a = []));
      a.push(k);
    }
    this.trees = { cell, n, cells };
  }

  _nearestTree(sp, x, z, r) {
    const G = this.trees, d = this.world.vegetation?.data;
    if (!G || !sp.trees) return -1;
    const h = this.world.terrain.half;
    const i0 = Math.floor((x - r + h) / G.cell), i1 = Math.floor((x + r + h) / G.cell);
    const j0 = Math.floor((z - r + h) / G.cell), j1 = Math.floor((z + r + h) / G.cell);
    let best = -1, bd = r * r;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      for (const k of G.cells.get(j * G.n + i) ?? []) {
        if (!sp.trees.has(d.species[k])) continue;
        const dd = (d.x[k] - x) ** 2 + (d.z[k] - z) ** 2;
        if (dd < bd) { bd = dd; best = k; }
      }
    }
    return best;
  }

  /** A tree dmin..dmax from c, roughly along dir (±60°), or -1. */
  _treeToward(sp, c, dir, dmin, dmax) {
    const base = Math.atan2(dir.z, dir.x);
    for (let i = 0; i < 8; i++) {
      const a = base + rand(-1, 1) * (Math.PI / 3), d = rand(dmin, dmax);
      const k = this._nearestTree(sp, c.x + Math.cos(a) * d, c.z + Math.sin(a) * d, 20);
      if (k >= 0) return k;
    }
    return -1;
  }

  /**
   * Crown of vegetation instance k: its world transform and perch points on top of the leaves
   * (asset space, from the near LOD built for every variant: vertical rays onto the highest
   * triangle within the upper crown), cached per asset variant.
   */
  _crown(k) {
    const V = this.world.vegetation, d = V.data, T = this.world.terrain;
    const asset = V.def.species[d.species[k]].asset, variant = d.variant[k], key = `${asset}|${variant}`;
    let c = this._crowns.get(key);
    if (!c) this._crowns.set(key, (c = perchPoints(this.world.assets.build(asset, { quality: 1, variant }))));
    const s = d.scale[k], yaw = d.yaw[k];
    return { ...c, x0: d.x[k], y0: T.heightAt(d.x[k], d.z[k]) - 0.05, z0: d.z[k], s, cs: Math.cos(yaw), sn: Math.sin(yaw) };
  }

  _perchSpot(cr, sp, b, out) {
    const p = cr.pts, i = Math.floor(Math.random() * (p.length / 3)) * 3;
    if (!p.length) return out.set(cr.x0, cr.y0 + cr.top * cr.s, cr.z0);
    const x = p[i], z = p[i + 2];
    return out.set(cr.x0 + (x * cr.cs + z * cr.sn) * cr.s, cr.y0 + p[i + 1] * cr.s + (sp.pivot - 0.03) * b.scale, cr.z0 + (-x * cr.sn + z * cr.cs) * cr.s);
  }

  /** Debug / live: flocks and birds. */
  stats() {
    const cam = this.game.engine.camera.position;
    return {
      enabled: this._enabled,
      birds: Object.fromEntries(this.species.map((sp) => [sp.id, sp.birds.length])),
      flocks: this.flocks.map((f) => ({ species: f.sp.id, mode: f.mode, where: f.where, n: f.birds.length, dist: Math.round(this._center(f, _v).distanceTo(cam)) })),
    };
  }
}
