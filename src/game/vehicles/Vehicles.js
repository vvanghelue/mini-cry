// Drivable vehicles: an arcade jeep (wheels follow the ground, body pitches / rolls, slides on
// steep slopes, rams enemies) and a boat (floats on the water, beaches on sand). Chase camera.
import * as THREE from 'three';

const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
const SPEC = {
  jeep: { label: 'Jeep', latAccel: 9, accel: 9, maxSpeed: 26, reverse: 8, brake: 16, drag: 0.35, grip: 4.5, steer: 0.55, wheelbase: 2.5, halfW: 0.9, halfL: 1.9, seat: [0, 1.0, 0.1], hp: 500, sound: 'jeep_engine' },
  boat: { label: 'Bateau', latAccel: 6, accel: 7, maxSpeed: 20, reverse: 5, brake: 6, drag: 0.5, grip: 1.6, steer: 0.9, wheelbase: 3, halfW: 1.2, halfL: 2.8, seat: [0, 0.8, 1.2], hp: 400, sound: 'boat_engine' },
};

export class Vehicles {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.driving = null;
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
    this.list.push(v);
    const physics = this.game.world.physics;
    v.shape = physics.add({ type: 'box', x: v.pos.x, y: v.pos.y + 0.9, z: v.pos.z, hx: spec.halfW, hy: 0.8, hz: spec.halfL, yaw: v.heading, owner: e.id, material: 'metal' }, { dynamic: true });
    return { object, vehicle: v, onHit: (dmg) => this.damage(v, dmg * 0.2), onExplosionNear: (d) => this.damage(v, Math.max(0, 300 - d * 40)), dispose: () => { physics.remove(v.shape); this.list.splice(this.list.indexOf(v), 1); } };
  }

  nearby(p) {
    let best = null, bd = 3.2;
    for (const v of this.list) {
      if (!v.alive) continue;
      const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
      if (d < bd && Math.abs(v.pos.y - p.pos.y) < 2.5) { bd = d; best = v; }
    }
    return best;
  }

  enter(v) {
    const g = this.game, p = g.player;
    this.driving = v;
    p.inVehicle = v;
    g.weapons.vm.visible = false;
    v.engine = g.audio?.play(v.spec.sound, { position: v.pos, loop: true, volume: 0.7, priority: 2 });
    this.camYaw = v.heading;
    this.camPitch = -0.25;
  }

  exit() {
    const g = this.game, p = g.player, v = this.driving;
    if (!v) return;
    v.engine?.stop?.(0.3);
    this.driving = null;
    p.inVehicle = null;
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
      v.object.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color?.multiplyScalar(0.25); } });
    }
  }

  updateDriving(dt, inp) {
    const v = this.driving, g = this.game;
    if (!v) return;
    const l = inp.locked ? inp.look() : (inp.look(), { yaw: 0, pitch: 0 });
    this.camYaw += l.yaw;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + l.pitch, -0.9, 0.3);
    const thr = (inp.down('forward') ? 1 : 0) - (inp.down('back') ? 1 : 0);
    const st = (inp.down('left') ? 1 : 0) - (inp.down('right') ? 1 : 0);
    v.throttle = thr;
    v.steer += (st * v.spec.steer - v.steer) * Math.min(1, dt * 6);
    v.handbrake = inp.down('jump');
    // the player rides along
    const p = g.player;
    const c = Math.cos(v.heading), s = Math.sin(v.heading);
    const [sx, sy, sz] = v.spec.seat;
    p.pos.set(v.pos.x + sx * c + sz * s, v.pos.y + sy - 0.9, v.pos.z - sx * s + sz * c);
    p.vel.set(0, 0, 0);
    p.speed = 0;
    if (inp.hit('use')) { /* handled by Game._interact */ }
  }

  update(dt) {
    const g = this.game, T = g.world.terrain, phys = g.world.physics;
    for (const v of this.list) {
      if (!v.alive) continue;
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
    // chase camera; the look yaw is free but recentres behind the vehicle while driving
    if (Math.abs(v.speed) > 2 && Math.abs(this.game.input.mouseDX) < 1) {
      let d = v.heading - this.camYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw += d * Math.min(1, dt * 1.5);
    }
    const dist = 7.5, h = 2.6;
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
