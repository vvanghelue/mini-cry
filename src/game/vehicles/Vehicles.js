// Drivable vehicles: an arcade jeep (wheels follow the ground, body pitches / rolls, slides on
// steep slopes, rams enemies), a boat (floats on the water, beaches on sand) and a bush plane
// (mouse-aim arcade flight: the plane steers toward where the camera looks; taxis, takes off and
// lands on its tricycle gear; crashes into terrain, trees, props and water). Chase camera.
import * as THREE from 'three';

const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const _a = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _cam = new THREE.Vector3(), _prev = new THREE.Vector3(), _dir = new THREE.Vector3(), _q2 = new THREE.Quaternion(), _I = new THREE.Quaternion();
// plane hull points tested for collisions (plane space, front = -z): nose, cabin, tail, wing tips, mid wings
const PLANE_POINTS = [[0, 1.3, -3.8], [0, 1.5, 0], [0, 1.8, 4.2], [5.6, 2.1, -1.05], [-5.6, 2.1, -1.05], [2.8, 2.1, -1.05], [-2.8, 2.1, -1.05]];
const _pts = PLANE_POINTS.map(() => new THREE.Vector3()), _ptsPrev = PLANE_POINTS.map(() => new THREE.Vector3());
const G = 9.8;
const SPEC = {
  jeep: { label: 'Jeep', latAccel: 9, accel: 9, maxSpeed: 26, reverse: 8, brake: 16, drag: 0.35, grip: 4.5, steer: 0.55, wheelbase: 2.5, halfW: 0.9, halfL: 1.9, seat: [0, 1.0, 0.1], cam: [4.8, 0.9], hp: 500, sound: 'jeep_engine' },
  boat: { label: 'Boat', latAccel: 6, accel: 7, maxSpeed: 20, reverse: 5, brake: 6, drag: 0.5, grip: 1.6, steer: 0.9, wheelbase: 3, halfW: 1.2, halfL: 2.8, seat: [0, 0.8, 1.2], cam: [7, 1.4], hp: 400, sound: 'boat_engine' },
  // flight: stall = speed (m/s) under which the wings stop flying; cruise = speed where they carry
  // the plane with a level nose (slower: lift ~ v², the nose must come up); thrust (m/s² at full power, fading
  // to nothing at thrustFade m/s); drag = quadratic coefficient (top speed ~58 m/s level), times
  // 1 + flaps at idle (steep approaches without speeding up); align = how fast the velocity turns
  // toward the nose; rates in rad/s; crashVy = hardest touchdown (m/s down)
  plane: {
    label: 'Plane', verb: 'Fly', maxSpeed: 58, halfW: 0.65, halfL: 3.9, enterRadius: 4.5, seat: [-0.28, 1.0, -1.35], cam: [13, 2.6], hp: 300, sound: 'plane_engine',
    flight: { stall: 22, cruise: 30, thrust: 6, thrustFade: 80, drag: 0.00049, flaps: 2, align: 2.5, pitchRate: 1.2, rollRate: 2.4, yawRate: 0.5, brake: 5, rolling: 0.25, steer: 0.6, wheelbase: 2.35, rotate: 0.2, crashVy: 7, ceiling: 450, span: 5.6 },
  },
};

export class Vehicles {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.driving = null;
    this._crowns = new Map(); // vegetation species|variant -> canopy (plane collisions)
    game.createVehicle = (e, object) => this._create(e, object);
  }

  _create(e, object) {
    const spec = SPEC[e.vehicle] ?? SPEC.jeep;
    const v = {
      id: e.id, kind: e.vehicle ?? 'jeep', spec, label: spec.label, object,
      pos: object.position, heading: (e.rot?.[1] ?? 0) * Math.PI / 180, speed: 0, vy: 0, steer: 0,
      hp: spec.hp, alive: true, wheels: object.children.filter((c) => c.name === 'wheel'), wheelRot: 0,
    };
    object.rotation.order = 'YXZ';
    if (v.kind === 'plane') Object.assign(v, { vel: new THREE.Vector3(), power: 0, onGround: true, rotate: 0, input: { pitch: 0, roll: 0, yaw: 0, steer: 0, brake: 0 }, ctl: { pitch: 0, roll: 0, yaw: 0 }, prop: object.getObjectByName('propeller') });
    this.list.push(v);
    const physics = this.game.world.physics;
    v.shape = physics.add({ type: 'box', x: v.pos.x, y: v.pos.y + 0.9, z: v.pos.z, hx: spec.halfW, hy: 0.8, hz: spec.halfL, yaw: v.heading, owner: e.id, material: 'metal' }, { dynamic: true });
    return { object, vehicle: v, onHit: (dmg) => this.damage(v, dmg * 0.2), onExplosionNear: (d) => this.damage(v, Math.max(0, 300 - d * 40)), dispose: () => { physics.remove(v.shape); this.list.splice(this.list.indexOf(v), 1); } };
  }

  nearby(p) {
    let best = null, bd = Infinity;
    for (const v of this.list) {
      if (!v.alive) continue;
      const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
      if (d < (v.spec.enterRadius ?? 3.2) && d < bd && Math.abs(v.pos.y - p.pos.y) < 2.5) { bd = d; best = v; }
    }
    return best;
  }

  /** A plane can only be left once it stands still on the ground. */
  canExit() {
    const v = this.driving;
    return !!v && (v.kind !== 'plane' || (v.onGround && v.vel.length() < 3));
  }

  enter(v) {
    const g = this.game, p = g.player;
    this.driving = v;
    p.inVehicle = v;
    g.weapons.vm.visible = false;
    v.engine = g.audio?.play(v.spec.sound, { position: v.pos, loop: true, volume: 0.7, priority: 2 });
    this.camYaw = v.heading;
    this.camPitch = -0.25;
    if (v.kind === 'plane') {
      // mouse aim: the camera looks where the plane should go
      this.aimYaw = v.heading;
      this.aimPitch = 0;
      this._camOffset = null;
      if (!this._flightHint) { this._flightHint = true; g.hud?.notify('Plane: W / S throttle, mouse to steer, A / D roll, Space brakes. Look up past 80 km/h to take off', 9000); }
    }
  }

  exit() {
    const g = this.game, p = g.player, v = this.driving;
    if (!v) return;
    v.engine?.stop?.(0.3);
    v.engine = null;
    this.driving = null;
    p.inVehicle = null;
    if (v.kind === 'plane') { v.power = 0; this.camYaw = this.aimYaw; }
    // step out on the left side, or behind
    const c = Math.cos(v.heading), s = Math.sin(v.heading);
    const tries = [[-v.spec.halfW - 1.1, 0], [v.spec.halfW + 1.1, 0], [0, v.spec.halfL + 1.4]];
    for (const [lx, lz] of tries) {
      const x = v.pos.x + lx * c + lz * s, z = v.pos.z - lx * s + lz * c;
      const wl = g.world.terrain.waterLevelAt(x, z), gh = g.world.physics.groundAt(x, z, 0.3, v.pos.y + 3);
      if (v.kind === 'boat' || gh > wl - 1) { p.teleport([x, Math.max(gh, v.pos.y) + 0.2, z], v.heading + Math.PI); break; }
    }
    p.yaw = this.camYaw ?? p.yaw;
  }

  damage(v, dmg) {
    if (!v.alive || dmg <= 0) return;
    v.hp -= dmg;
    if (v.hp <= 0) {
      v.alive = false;
      const g = this.game;
      if (this.driving === v) { this.exit(); g.player.damage(80, v.pos, 'explosion'); }
      g.weapons.explode(v.pos.clone().setY(v.pos.y + 1), 7, 200, 'vehicle');
      // burnt: the same patched material with a dark tint (no new shader program mid-game)
      const L = g.world.lighting;
      v.object.traverse((o) => { if (o.isMesh && o.material.userData.opts) o.material = L.material({ ...o.material.userData.opts, color: 0x898989 }); });
      if (v.kind === 'plane') { v.power = 0; v.falling = !v.onGround; } // shot down: the wreck falls
    }
  }

  updateDriving(dt, inp) {
    const v = this.driving, g = this.game;
    if (!v) return;
    const l = inp.locked ? inp.look() : (inp.look(), { yaw: 0, pitch: 0 });
    const thr = (inp.down('forward') ? 1 : 0) - (inp.down('back') ? 1 : 0);
    const st = (inp.down('left') ? 1 : 0) - (inp.down('right') ? 1 : 0);
    const p = g.player;
    if (v.kind === 'plane') this._pilot(v, dt, inp, l, thr, st);
    else {
      this.camYaw += l.yaw;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch + l.pitch, -0.9, 0.3);
      v.throttle = thr;
      v.steer += (st * v.spec.steer - v.steer) * Math.min(1, dt * 6);
      v.handbrake = inp.down('jump');
    }
    // the player rides along
    const [sx, sy, sz] = v.spec.seat;
    p.pos.set(sx, sy, sz).applyQuaternion(v.object.quaternion).add(v.pos);
    p.pos.y -= 0.9;
    p.vel.set(0, 0, 0);
    p.speed = 0;
    if (inp.hit('use')) { /* handled by Game._interact */ }
  }

  /** Plane controls: W / S power, mouse = aim (autopilot steers toward it), A / D roll (steer on the ground), Space brakes. */
  _pilot(v, dt, inp, look, thr, st) {
    const F = v.spec.flight, T = this.game.world.terrain;
    this.aimYaw += look.yaw;
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch + look.pitch, -1.45, 1.45);
    // past the edge of the map: turn back toward the island
    const lim = T.half - 120;
    if (Math.abs(v.pos.x) > lim || Math.abs(v.pos.z) > lim) {
      let d = Math.atan2(v.pos.x, v.pos.z) - this.aimYaw; // yaw looking at the centre: forward = (-sin, -cos)
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.aimYaw += d * Math.min(1, dt * 1.5);
    }
    v.power = THREE.MathUtils.clamp(v.power + thr * dt * (thr > 0 ? 0.6 : 0.8), 0, 1);
    v.throttle = v.power;
    const inp2 = v.input;
    inp2.brake = inp.down('jump') || (thr < 0 && v.power === 0) ? 1 : 0;
    // aim direction in plane space (x right, y up, -z forward)
    _t.set(-Math.sin(this.aimYaw) * Math.cos(this.aimPitch), Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * Math.cos(this.aimPitch));
    _q.copy(v.object.quaternion).invert();
    const lt = _t.applyQuaternion(_q);
    const k = 4; // sensitivity
    const off = Math.acos(THREE.MathUtils.clamp(-lt.z, -1, 1));
    let pitch = THREE.MathUtils.clamp(lt.y * k, -1, 1), yaw = THREE.MathUtils.clamp(lt.x * k, -1, 1);
    if (lt.z > 0) { pitch = 1; yaw = Math.sign(lt.x) || 1; } // target behind: hard turn
    // bank toward the target when it is off the nose, level the wings when it is close to it
    _r.set(1, 0, 0).applyQuaternion(v.object.quaternion);
    const level = THREE.MathUtils.clamp(_r.y * 3, -1, 1);
    const aggressive = THREE.MathUtils.clamp(lt.x * k, -1, 1);
    let roll = THREE.MathUtils.lerp(level, aggressive, THREE.MathUtils.smoothstep(off, 0, 0.2));
    if (st) roll = -st; // keyboard roll overrides the autopilot (left = +1)
    inp2.pitch = pitch; inp2.yaw = yaw; inp2.roll = roll;
    // on the ground: nose wheel steering (keys, else toward the aim)
    inp2.steer = st ? st * F.steer : THREE.MathUtils.clamp(-yaw, -1, 1) * F.steer;
  }

  _updatePlane(v, dt) {
    const g = this.game, T = g.world.terrain, phys = g.world.physics, F = v.spec.flight;
    const driven = this.driving === v;
    if (v.parked && !driven) return; // standing still on the ground, nobody aboard
    const q = v.object.quaternion, vel = v.vel, inp = v.input;
    if (!driven) { inp.pitch = inp.roll = inp.yaw = inp.steer = 0; inp.brake = 1; v.power = 0; }
    const speed = vel.length();
    _f.set(0, 0, -1).applyQuaternion(q);
    const vf = vel.dot(_f);
    // authority of the controls / wings: nothing at a standstill, full above the stall speed
    const auth = THREE.MathUtils.smoothstep(vf, F.stall * 0.55, F.stall);
    // control inputs reach the surfaces smoothly
    const c = v.ctl, kk = Math.min(1, dt * 6);
    c.pitch += (inp.pitch - c.pitch) * kk; c.roll += (inp.roll - c.roll) * kk; c.yaw += (inp.yaw - c.yaw) * kk;
    if (!v.onGround) {
      const a = (0.25 + 0.75 * auth) * dt;
      _e.set(c.pitch * F.pitchRate * a, -c.yaw * F.yawRate * a, -c.roll * F.rollRate * a);
      q.multiply(_q.setFromEuler(_e));
      // weathervane: a slow (stalled) plane noses down into its own velocity
      if (speed > 2) {
        _dir.copy(vel).divideScalar(speed);
        _q.setFromUnitVectors(_f, _dir);
        const w = Math.min(1, dt * ((1 - auth) * 1.5 + 0.15));
        q.premultiply(_q2.slerpQuaternions(_I, _q, w));
      }
      q.normalize();
      _f.set(0, 0, -1).applyQuaternion(q);
    }
    // forces: gravity, thrust, drag, lift (cancels gravity across the nose at cruise speed and above)
    // and the wings turning the velocity toward the nose (lift from the angle of attack)
    const ceiling = THREE.MathUtils.clamp((F.ceiling - v.pos.y) / 150, 0, 1);
    const thrust = v.power * F.thrust * Math.max(0.15, 1 - Math.max(0, vf) / F.thrustFade) * ceiling;
    _a.set(0, -G, 0).addScaledVector(_f, thrust).addScaledVector(vel, -F.drag * (1 + F.flaps * (1 - v.power)) * speed);
    const lift = auth * Math.min(1, (Math.max(0, vf) / F.cruise) ** 2);
    _a.y += G * lift;
    _a.addScaledVector(_f, -G * lift * _f.y);
    if (vf > 0) { _v.copy(vel).addScaledVector(_f, -vf); _a.addScaledVector(_v, -F.align * auth); }
    vel.addScaledVector(_a, dt);
    // on the ground: wheels (grip, rolling resistance, brakes, nose wheel steering)
    if (v.onGround) {
      _f.set(-Math.sin(v.heading), 0, -Math.cos(v.heading));
      let fwd = vel.x * _f.x + vel.z * _f.z;
      const decel = (F.rolling + inp.brake * F.brake) * dt;
      fwd = Math.abs(fwd) <= decel ? 0 : fwd - Math.sign(fwd) * decel;
      if (!driven && Math.abs(fwd) < 0.3) fwd = 0;
      vel.x = _f.x * fwd; vel.z = _f.z * fwd; // no sideways slip
      const steer = inp.steer / (1 + Math.abs(fwd) / 8);
      v.heading += (fwd / F.wheelbase) * Math.tan(steer) * dt;
      // take-off rotation: the nose comes up once the wings bite
      const want = auth > 0.6 ? Math.max(0, inp.pitch) * F.rotate : 0;
      v.rotate += (want - v.rotate) * Math.min(1, dt * 2);
    }
    _prev.copy(v.pos);
    v.pos.addScaledVector(vel, dt);
    // ground under the gear (nose wheel, main wheels)
    const ch = Math.cos(v.heading), sh = Math.sin(v.heading);
    const gearH = (lx, lz) => phys.groundAt(v.pos.x + lx * ch + lz * sh, v.pos.z - lx * sh + lz * ch, 0.2, v.pos.y + 0.6);
    phys.shapes[v.shape] && (phys.shapes[v.shape].ghost = true);
    const hn = gearH(0, -2.85), hl = gearH(-1.33, -0.5), hr = gearH(1.33, -0.5);
    const ground = Math.max((hl + hr) / 2, hn - 0.3);
    const gPitch = Math.atan2(hn - (hl + hr) / 2, 2.35), gRoll = Math.atan2(hr - hl, 2.66);
    // on the wheels (sticks over small dips while rolling), else flying
    if (v.pos.y <= ground + 0.02 || (v.onGround && v.pos.y < ground + 0.3 && vel.y <= 0.5)) {
      if (!v.onGround) {
        // touchdown: too hard, banked or nose first = crash
        _e.setFromQuaternion(q, 'YXZ');
        if (-vel.y > F.crashVy || Math.abs(_e.z - gRoll) > 0.45 || _e.x - gPitch < -0.12) { phys.shapes[v.shape] && (phys.shapes[v.shape].ghost = false); v.crashCause = 'touchdown'; this._crash(v); return; }
        v.onGround = true;
        v.heading = _e.y;
        v.rotate = Math.max(0, _e.x - gPitch);
      }
      v.pos.y = ground;
      vel.y = Math.max(0, vel.y);
    } else v.onGround = false;
    if (v.onGround) q.setFromEuler(_e.set(gPitch + v.rotate, v.heading, gRoll, 'YXZ'));
    else { _f.set(0, 0, -1).applyQuaternion(q); v.heading = Math.atan2(-_f.x, -_f.z); }
    // collisions: nose and wing tips against the terrain, props / trunks along the move, tree crowns, water
    const hit = this._planeHits(v);
    phys.shapes[v.shape] && (phys.shapes[v.shape].ghost = false);
    if (hit && v.onGround && speed < 8) { v.pos.copy(_prev); vel.multiplyScalar(-0.2); } // taxied into something: bump
    else if (hit) { v.crashCause = hit; this._crash(v); return; }
    // ram actors on the runway (propeller, fuselage)
    if (speed > 6 && v.pos.y - T.heightAt(v.pos.x, v.pos.z) < 4) {
      for (const a of g.actors.near(v.pos, 5)) {
        if (!a.alive) continue;
        _v.copy(a.pos).sub(v.pos).applyQuaternion(_q.copy(q).invert());
        if (Math.abs(_v.x) < 1.3 && Math.abs(_v.z) < 4.2 && _v.y > -2 && _v.y < 1.5) a.damage(speed * 12, v.pos, { attacker: driven ? 'player' : 'vehicle', explosion: true, dir: vel.clone().normalize() });
      }
    }
    v.speed = vel.length();
    if (v.prop) v.prop.rotation.z += dt * (v.alive && (driven || v.power > 0) ? 14 + v.power * 46 : 0);
    phys.updateDynamic(v.shape, { x: v.pos.x, y: v.pos.y + 0.9, z: v.pos.z, yaw: v.heading });
    if (v.engine) { v.engine.setPosition?.(v.pos); v.engine.setPitch?.(0.55 + v.power * 0.6 + Math.min(1, v.speed / v.spec.maxSpeed) * 0.35); }
    v.object.updateMatrixWorld();
    v.parked = !driven && v.onGround && v.speed === 0;
  }

  /** What the plane hits this frame ('ground' | 'water' | 'obstacle' | 'tree'), else null (uses _prev -> pos). */
  _planeHits(v) {
    const g = this.game, T = g.world.terrain, phys = g.world.physics, F = v.spec.flight, q = v.object.quaternion;
    _f.set(0, 0, -1).applyQuaternion(q); _r.set(1, 0, 0).applyQuaternion(q); _u.set(0, 1, 0).applyQuaternion(q);
    const pts = PLANE_POINTS, n = pts.length;
    // hull points (nose, cabin, tail, wing) now and one frame ago
    for (let i = 0; i < n; i++) {
      const [x, y, z] = pts[i];
      _pts[i].copy(v.pos).addScaledVector(_r, x).addScaledVector(_u, y).addScaledVector(_f, -z);
      _ptsPrev[i].copy(_pts[i]).sub(v.pos).add(_prev);
      if (_pts[i].y < T.heightAt(_pts[i].x, _pts[i].z) - 0.05) return 'ground';
    }
    if (v.pos.y + 0.3 < T.waterLevelAt(v.pos.x, v.pos.z)) return 'water';
    // props, buildings, trunks: sweep every hull point along the move (no tunnelling at speed)
    _dir.copy(v.pos).sub(_prev);
    const len = _dir.length();
    if (len > 1e-3) {
      _dir.divideScalar(len);
      for (let i = 0; i < n; i++) if (phys.raycast(_ptsPrev[i], _dir, len + 0.3, { terrain: false, ignore: v.id })) return 'obstacle';
    }
    // tree crowns (the colliders are only the trunks): found through the trunk shapes nearby
    const V = g.world.vegetation;
    if (!V || (v.onGround && v.speed < 8)) return null;
    let hit = false;
    const R = F.span + 8;
    phys.query(v.pos.x - R, v.pos.z - R, v.pos.x + R, v.pos.z + R, (s) => {
      if (hit || typeof s.owner !== 'string' || !s.owner.startsWith('veg:')) return;
      const k = +s.owner.slice(4), c = this._crown(V, k);
      if (!c) return;
      const d = V.data, sc = d.scale[k], cs = Math.cos(d.yaw[k]), sn = Math.sin(d.yaw[k]);
      const cx = d.x[k] + (c.cx * cs + c.cz * sn) * sc, cz = d.z[k] + (-c.cx * sn + c.cz * cs) * sc;
      const y = T.heightAt(d.x[k], d.z[k]), y0 = y + c.bottom * sc, y1 = y + c.top * sc, rr = (c.r * sc) ** 2;
      for (let i = 0; i < n && !hit; i++) {
        const p = _pts[i];
        if (p.y > y0 && p.y < y1 && (p.x - cx) ** 2 + (p.z - cz) ** 2 < rr) hit = true;
      }
    });
    return hit ? 'tree' : null;
  }

  /** Canopy of a vegetation instance's species / variant in asset space: { cx, cz, r, bottom, top } or null (no canopy). */
  _crown(V, k) {
    const d = V.data, sp = V.def.species[d.species[k]], key = d.species[k] * 256 + d.variant[k];
    let c = this._crowns.get(key);
    if (c !== undefined) return c;
    c = null;
    if (sp?.collide) {
      const b = V.assets.build(sp.asset, { quality: 0.25, variant: Math.min(d.variant[k], (sp.variants ?? 1) - 1) });
      const size = b.bounds.getSize(new THREE.Vector3()), mid = b.bounds.getCenter(new THREE.Vector3());
      const trunk = Math.max(0, ...(b.colliders ?? []).filter((l) => l.type === 'cylinder').map((l) => (l.pos?.[1] ?? 0) + (l.height ?? 1) / 2));
      // trees only (rocks have no trunk); the crown keeps 70 % of its half width: grazing a leaf is fine
      if (trunk > 2 && size.y > trunk + 1) c = { cx: mid.x, cz: mid.z, r: 0.35 * Math.max(size.x, size.z), bottom: trunk, top: b.bounds.max.y - 0.3 };
    }
    this._crowns.set(key, c);
    return c;
  }

  _crash(v) {
    v.vel.multiplyScalar(0.2);
    this.damage(v, v.hp + 1);
    v.falling = v.pos.y > this.game.world.terrain.heightAt(v.pos.x, v.pos.z) + 1;
  }

  /** A destroyed plane falls until it hits the ground or the water. */
  _fallWreck(v, dt) {
    const T = this.game.world.terrain;
    v.vel.y -= G * dt;
    v.vel.multiplyScalar(1 - dt * 0.3);
    v.pos.addScaledVector(v.vel, dt);
    v.object.rotateX(-dt * 0.6);
    v.object.rotateZ(dt * 0.9);
    const floor = Math.max(T.heightAt(v.pos.x, v.pos.z), T.waterLevelAt(v.pos.x, v.pos.z) - 1.5);
    if (v.pos.y <= floor) {
      v.pos.y = floor;
      v.falling = false;
      this.game.effects.burst(v.pos.clone().setY(floor + 1), { count: 14, color: 0x3a3632, speed: 4, up: 3, life: 2.2, size: 0.8, grow: 1.5, gravity: -0.4 });
    }
    this.game.world.physics.updateDynamic(v.shape, { x: v.pos.x, y: v.pos.y + 0.9, z: v.pos.z, yaw: v.heading });
    v.object.updateMatrixWorld();
  }

  update(dt) {
    const g = this.game, T = g.world.terrain, phys = g.world.physics;
    for (const v of this.list) {
      if (!v.alive) { if (v.falling) this._fallWreck(v, dt); continue; }
      if (v.kind === 'plane') { this._updatePlane(v, dt); continue; }
      const sp = v.spec;
      const driven = this.driving === v;
      const thr = driven ? v.throttle : 0;
      // longitudinal
      if (thr > 0) v.speed += (v.speed < 0 ? sp.brake : sp.accel) * thr * dt;
      else if (thr < 0) v.speed += (v.speed > 0 ? -sp.brake : -sp.accel * 0.6) * -thr * dt * (v.speed > 0 ? 1 : 1);
      v.speed -= v.speed * sp.drag * dt + Math.sign(v.speed) * (driven && v.handbrake ? sp.brake * dt : 0);
      if (!driven) v.speed *= Math.max(0, 1 - dt * 1.5);
      v.speed = THREE.MathUtils.clamp(v.speed, -sp.reverse, sp.maxSpeed);
      // turning (bicycle model)
      const steer = driven ? v.steer : 0;
      // bicycle model, yaw rate capped by the max lateral acceleration (no spinning at speed)
      let yawRate = (v.speed / sp.wheelbase) * Math.tan(steer);
      const maxRate = (sp.latAccel ?? 8) / Math.max(3, Math.abs(v.speed));
      yawRate = Math.max(-maxRate, Math.min(maxRate, yawRate));
      v.heading += yawRate * dt;
      _f.set(Math.sin(v.heading), 0, Math.cos(v.heading)).multiplyScalar(-1); // vehicle front = -Z
      const nx = v.pos.x + _f.x * v.speed * dt, nz = v.pos.z + _f.z * v.speed * dt;
      if (v.kind === 'boat') {
        const wl = T.waterLevelAt(nx, nz);
        const ground = T.heightAt(nx, nz);
        if (ground > wl - 0.35) { v.speed *= -0.2; } // beached
        else { v.pos.x = nx; v.pos.z = nz; }
        v.pos.y = T.waterLevelAt(v.pos.x, v.pos.z) + Math.sin(g.time * 1.6 + v.pos.x) * 0.06;
        v.object.rotation.set(Math.sin(g.time * 1.3) * 0.03 - v.speed * 0.004, v.heading, Math.sin(g.time * 1.1) * 0.03 + steer * v.speed * 0.01);
        if (Math.abs(v.speed) > 3) g.effects.burst(v.pos.clone().addScaledVector(_f, -sp.halfL), { count: 1, color: 0xf0fbff, speed: 1.5, up: 1, life: 0.6, size: 0.12 });
      } else {
        // collide the body footprint (front + back circles) against static shapes
        const prevX = v.pos.x, prevZ = v.pos.z;
        v.pos.x = nx; v.pos.z = nz;
        let hit = false;
        for (const k of [-1, 1]) {
          _v.set(v.pos.x + _f.x * sp.halfL * 0.6 * k, v.pos.y + 0.3, v.pos.z + _f.z * sp.halfL * 0.6 * k);
          const bx = _v.x, bz = _v.z;
          phys.shapes[v.shape] && (phys.shapes[v.shape].ghost = true);
          if (phys.collideCylinder(_v, sp.halfW + 0.1, 1.2, 0.6)) { hit = true; v.pos.x += _v.x - bx; v.pos.z += _v.z - bz; }
          phys.shapes[v.shape] && (phys.shapes[v.shape].ghost = false);
        }
        if (hit) {
          const impact = Math.abs(v.speed);
          if (impact > 8 && driven) g.player.damage((impact - 8) * 2, null, 'fall');
          v.speed *= -0.25;
          if (Math.hypot(v.pos.x - prevX, v.pos.z - prevZ) > 1) { v.pos.x = prevX; v.pos.z = prevZ; }
        }
        // ground: four wheel heights -> height, pitch, roll
        _r.set(Math.cos(v.heading), 0, -Math.sin(v.heading));
        const hgt = (fx, rx) => phys.groundAt(v.pos.x + _f.x * fx + _r.x * rx, v.pos.z + _f.z * fx + _r.z * rx, 0.2, v.pos.y + 1.2);
        const fl = hgt(sp.halfL * 0.65, -sp.halfW), fr = hgt(sp.halfL * 0.65, sp.halfW), bl = hgt(-sp.halfL * 0.65, -sp.halfW), br = hgt(-sp.halfL * 0.65, sp.halfW);
        const ground = (fl + fr + bl + br) / 4;
        if (v.pos.y > ground + 0.05) { v.vy -= 20 * dt; v.pos.y += v.vy * dt; if (v.pos.y < ground) { v.pos.y = ground; v.vy = 0; } }
        else { v.pos.y = ground; v.vy = 0; }
        const pitch = Math.atan2((fl + fr) / 2 - (bl + br) / 2, sp.halfL * 1.3);
        const roll = Math.atan2((fr + br) / 2 - (fl + bl) / 2, sp.halfW * 2);
        v.object.rotation.set(pitch, v.heading, roll); // YXZ, front = -Z: +X rotation lifts the nose
        // slopes: gravity along the hill, can't climb cliffs
        const slope = Math.sin(pitch);
        v.speed -= slope * 9.8 * dt;
        // water: engine drowns
        const depth = T.waterLevelAt(v.pos.x, v.pos.z) - v.pos.y;
        if (depth > 0.9) { v.speed *= Math.max(0, 1 - dt * 3); }
        // wheels spin + steer
        v.wheelRot += (v.speed / 0.38) * dt;
        v.wheels.forEach((w, i) => { w.rotation.set(v.wheelRot, i < 2 ? steer : 0, 0, 'YXZ'); });
        // ram actors
        if (Math.abs(v.speed) > 5) {
          for (const a of g.actors.near(v.pos, 3)) {
            if (!a.alive) continue;
            if (Math.hypot(a.pos.x - v.pos.x, a.pos.z - v.pos.z) < sp.halfL) a.damage(Math.abs(v.speed) * 12, v.pos, { attacker: driven ? 'player' : 'vehicle', explosion: true, dir: _f.clone() });
          }
        }
        if (Math.abs(v.speed) > 6 && driven) g.effects.burst(v.pos.clone().addScaledVector(_f, -sp.halfL), { count: 1, color: 0x9a8a6a, speed: 1, up: 0.6, life: 0.8, size: 0.15, grow: 0.4, gravity: -0.3 });
      }
      phys.updateDynamic(v.shape, { x: v.pos.x, y: v.pos.y + 0.9, z: v.pos.z, yaw: v.heading });
      if (v.engine) { v.engine.setPosition?.(v.pos); v.engine.setPitch?.(0.6 + Math.abs(v.speed) / sp.maxSpeed * 1.2 + (v.throttle ? 0.15 : 0)); }
      v.object.updateMatrixWorld();
    }
  }

  applyCamera(camera, dt) {
    const v = this.driving;
    if (!v) return;
    const T = this.game.world.terrain;
    if (v.kind === 'plane') {
      // mouse-aim camera: looks along the aim from behind and above the plane (the plane flies
      // toward the crosshair); only the offset is smoothed so the camera never trails at speed
      const [d0, h] = v.spec.cam;
      const dist = d0 + Math.min(v.speed, 60) * 0.05;
      _t.set(-Math.sin(this.aimYaw) * Math.cos(this.aimPitch), Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * Math.cos(this.aimPitch));
      _cam.copy(_t).multiplyScalar(-dist);
      _cam.y += h;
      if (!this._camOffset) this._camOffset = _cam.clone();
      else this._camOffset.lerp(_cam, Math.min(1, dt * 8));
      camera.position.copy(v.pos).add(this._camOffset);
      camera.position.y += 1.4;
      const cx = camera.position.x, cz = camera.position.z;
      camera.position.y = Math.max(camera.position.y, T.heightAt(cx, cz) + 1, T.waterLevelAt(cx, cz) + 0.8);
      camera.lookAt(_v.copy(camera.position).add(_t));
      this.game.player.yaw = this.aimYaw;
      return;
    }
    // chase camera; the look yaw is free but recentres behind the vehicle while driving
    if (Math.abs(v.speed) > 2 && Math.abs(this.game.input.mouseDX) < 1) {
      let d = v.heading - this.camYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw += d * Math.min(1, dt * 1.5);
    }
    const [dist, h] = v.spec.cam; // distance to the look target, extra height
    const target = _v.set(v.pos.x, v.pos.y + 1.6, v.pos.z);
    const cx = target.x + Math.sin(this.camYaw) * dist * Math.cos(this.camPitch);
    const cz = target.z + Math.cos(this.camYaw) * dist * Math.cos(this.camPitch);
    let cy = target.y + h - Math.sin(this.camPitch) * dist;
    cy = Math.max(cy, T.heightAt(cx, cz) + 0.8, T.waterLevelAt(cx, cz) + 0.6);
    camera.position.lerp(new THREE.Vector3(cx, cy, cz), Math.min(1, dt * 10));
    camera.lookAt(target);
    this.game.player.yaw = this.camYaw;
  }

  onExplosion(pos, radius) {
    for (const v of this.list) {
      const d = v.pos.distanceTo(pos);
      if (d < radius) this.damage(v, (1 - d / radius) * 350);
    }
  }
}
