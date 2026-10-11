// Visual effects with fixed pools (no allocation during play): particles (low-poly chunks:
// dust, debris, blood, sparks, fire, smoke), tracers, bullet decals, explosion fireballs.
// Everything is instanced: 4 draw calls in total, whatever happens on screen.
import * as THREE from 'three';
import { LAYERS } from '../../engine/render/layers.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();
const _z = new THREE.Vector3(0, 0, 1), _d = new THREE.Vector3();
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

class Pool {
  constructor(geo, mat, max, layer) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(layer);
    this.mesh.count = 0;
    this.max = max;
    this.items = [];
    this.next = 0;
  }
  alloc() {
    if (this.items.length < this.max) { const p = { i: this.items.length }; this.items.push(p); return p; }
    const p = this.items[this.next];
    this.next = (this.next + 1) % this.max;
    return p;
  }
}

export const MATERIAL_FX = {
  ground: { color: 0x6a5a3a, sound: 'bullet_impact_dirt' },
  sand: { color: 0xd8c89a, sound: 'bullet_impact_dirt' },
  wood: { color: 0x8a6a40, sound: 'bullet_impact_wood' },
  foliage: { color: 0x4a8a2a, sound: 'bullet_impact_wood' },
  metal: { color: 0xffd080, sound: 'bullet_impact_metal', sparks: true },
  stone: { color: 0x9a9690, sound: 'bullet_impact_dirt' },
  concrete: { color: 0xb0aca4, sound: 'bullet_impact_dirt' },
  cloth: { color: 0x7a7a6a, sound: 'bullet_impact_wood' },
  water: { color: 0xe8f6ff, sound: 'bullet_impact_dirt', splash: true },
  flesh: { color: 0x9a1010, sound: 'bullet_impact_flesh', blood: true },
};

export class Effects {
  constructor(game) {
    this.game = game;
    const scene = game.engine.scene;
    const lighting = game.engine.lighting;
    this.group = new THREE.Group();
    this.group.name = 'Effects';
    scene.add(this.group);
    // lit chunks: dust, debris, smoke, blood
    const chunkGeo = new THREE.IcosahedronGeometry(0.5, 0);
    const litMat = new THREE.MeshLambertMaterial({ flatShading: true, transparent: false });
    lighting.patch(litMat);
    this.lit = new Pool(chunkGeo, litMat, 1500, LAYERS.FX);
    // glowing: sparks, fire, muzzle flashes, fireballs (unlit, additive-ish)
    const glowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
    this.glow = new Pool(new THREE.IcosahedronGeometry(0.5, 0), glowMat, 800, LAYERS.FX);
    // tracers: unit box stretched along +Z
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    const tracerMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.tracers = new Pool(tracerGeo, tracerMat, 96, LAYERS.FX);
    // decals: small dark discs on walls / ground
    const decalGeo = new THREE.CircleGeometry(0.5, 6);
    const decalMat = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false, transparent: true, opacity: 0.85 });
    this.decals = new Pool(decalGeo, decalMat, 160, LAYERS.FX);
    for (const p of [this.lit, this.glow, this.tracers, this.decals]) this.group.add(p.mesh);
    this.shake = 0;
  }

  // --- particles -------------------------------------------------------------------------
  _spawn(pool, pos, vel, { color, life = 0.6, size = 0.1, grow = 0, gravity = 9.8, drag = 1, spin = 6 }) {
    const p = pool.alloc();
    p.pos = (p.pos ?? new THREE.Vector3()).copy(pos);
    p.vel = (p.vel ?? new THREE.Vector3()).copy(vel);
    p.life = p.max = life;
    p.size = size; p.grow = grow; p.gravity = gravity; p.drag = drag;
    p.rot = (p.rot ?? new THREE.Euler()).set(Math.random() * 6, Math.random() * 6, 0);
    p.spin = spin;
    p.alive = true;
    _c.set(color);
    pool.mesh.instanceColor.setXYZ(p.i, _c.r, _c.g, _c.b);
    pool.mesh.instanceColor.needsUpdate = true;
    pool.mesh.count = Math.max(pool.mesh.count, p.i + 1);
    return p;
  }

  burst(pos, { count = 8, color = 0x888888, speed = 3, up = 1, life = 0.6, size = 0.08, gravity = 9.8, glow = false, spread = 1, dir = null, grow = 0, drag = 1 } = {}) {
    const pool = glow ? this.glow : this.lit;
    for (let i = 0; i < count; i++) {
      _d.set((Math.random() - 0.5) * 2 * spread, Math.random() * up, (Math.random() - 0.5) * 2 * spread);
      if (dir) _d.add(dir);
      _d.normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      this._spawn(pool, pos, _d, { color, life: life * (0.6 + Math.random() * 0.6), size: size * (0.6 + Math.random() * 0.8), gravity, grow, drag });
    }
  }

  /** Bullet impact on a surface material (see MATERIAL_FX). n: surface normal. */
  impact(pos, n, material = 'ground', { decal = true, sound = true } = {}) {
    const fx = MATERIAL_FX[material] ?? MATERIAL_FX.ground;
    const dir = _p.set(n.x, n.y, n.z);
    if (fx.blood) {
      this.burst(pos, { count: 7, color: 0x8a0a0a, speed: 2.5, dir, spread: 0.6, life: 0.45, size: 0.06 });
      this.burst(pos, { count: 2, color: 0x5a0606, speed: 0.6, dir, life: 0.6, size: 0.18, grow: 0.25, gravity: 1 });
    } else if (fx.splash) {
      this.burst(pos, { count: 10, color: 0xe8f6ff, speed: 3.5, up: 3, spread: 0.3, life: 0.6, size: 0.07 });
    } else {
      this.burst(pos, { count: 6, color: fx.color, speed: 3, dir, spread: 0.7, life: 0.5, size: 0.05 });
      this.burst(pos, { count: 2, color: fx.color, speed: 0.6, dir, life: 0.9, size: 0.12, grow: 0.5, gravity: -0.3, drag: 2 });
      if (fx.sparks) this.burst(pos, { count: 5, color: 0xffd070, speed: 6, dir, spread: 0.8, life: 0.18, size: 0.025, glow: true });
      if (decal) this.decal(pos, n, material === 'metal' ? 0x2a2a2a : 0x1a1612, 0.07);
    }
    if (sound) this.game.audio?.play(fx.sound, { position: pos, volume: 0.6 });
  }

  decal(pos, n, color = 0x1a1612, size = 0.07) {
    const p = this.decals.alloc();
    _d.set(n.x, n.y, n.z).normalize();
    _q.setFromUnitVectors(_z, _d);
    _p.copy(pos).addScaledVector(_d, 0.01);
    _m.compose(_p, _q, _s.setScalar(size * (0.8 + Math.random() * 0.4) * 2));
    this.decals.mesh.setMatrixAt(p.i, _m);
    _c.set(color);
    this.decals.mesh.instanceColor.setXYZ(p.i, _c.r, _c.g, _c.b);
    this.decals.mesh.instanceColor.needsUpdate = true;
    this.decals.mesh.instanceMatrix.needsUpdate = true;
    this.decals.mesh.count = Math.max(this.decals.mesh.count, p.i + 1);
  }

  tracer(from, to, { color = 0xfff0b0, width = 0.025, life = 0.07, speed = 0 } = {}) {
    const p = this.tracers.alloc();
    p.from = (p.from ?? new THREE.Vector3()).copy(from);
    p.to = (p.to ?? new THREE.Vector3()).copy(to);
    p.life = p.max = life;
    p.width = width;
    p.alive = true;
    _c.set(color);
    this.tracers.mesh.instanceColor.setXYZ(p.i, _c.r, _c.g, _c.b);
    this.tracers.mesh.instanceColor.needsUpdate = true;
    this.tracers.mesh.count = Math.max(this.tracers.mesh.count, p.i + 1);
    void speed;
  }

  muzzleFlash(pos, dir, size = 0.18) {
    this._spawn(this.glow, pos, _d.copy(dir).multiplyScalar(2), { color: 0xffc860, life: 0.05, size, gravity: 0, spin: 0 });
    this._spawn(this.glow, pos, _d.copy(dir).multiplyScalar(5), { color: 0xff9030, life: 0.04, size: size * 0.6, gravity: 0, spin: 0 });
  }

  explosion(pos, radius = 6) {
    const g = this.glow, l = this.lit;
    for (let i = 0; i < 14; i++) {
      _d.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(radius * (0.6 + Math.random()));
      this._spawn(g, pos, _d, { color: i % 3 ? 0xff8a20 : 0xffd060, life: 0.35 + Math.random() * 0.25, size: radius * 0.18, grow: radius * 0.4, gravity: -2, drag: 4 });
    }
    this.burst(pos, { count: 26, color: 0xffb040, speed: radius * 3, up: 1.5, life: 0.6, size: 0.06, glow: true, gravity: 12 });
    this.burst(pos, { count: 16, color: 0x2a2622, speed: radius * 1.6, up: 1.5, life: 1.4, size: 0.18 });
    for (let i = 0; i < 10; i++) {
      _d.set(Math.random() - 0.5, 0.6 + Math.random(), Math.random() - 0.5).multiplyScalar(2.5);
      this._spawn(l, _p.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * radius * 0.5, 0.5, (Math.random() - 0.5) * radius * 0.5)), _d, { color: i % 2 ? 0x3a3632 : 0x55504a, life: 2.2 + Math.random(), size: radius * 0.18, grow: radius * 0.35, gravity: -1.2, drag: 1.5, spin: 1 });
    }
    const cam = this.game.engine.camera.position;
    const d = cam.distanceTo(pos);
    this.shake = Math.max(this.shake, THREE.MathUtils.clamp(1.2 - d / (radius * 5), 0, 1));
  }

  fire(pos, scale = 1) {
    this._spawn(this.glow, pos, _d.set((Math.random() - 0.5) * 0.4, 1.4 + Math.random(), (Math.random() - 0.5) * 0.4).multiplyScalar(scale), { color: Math.random() < 0.5 ? 0xff8a20 : 0xffc040, life: 0.5, size: 0.25 * scale, grow: -0.3 * scale, gravity: -1, drag: 1 });
  }

  update(dt) {
    for (const pool of [this.lit, this.glow]) {
      const mesh = pool.mesh;
      let any = false;
      for (const p of pool.items) {
        if (!p.alive) continue;
        p.life -= dt;
        if (p.life <= 0) { p.alive = false; mesh.setMatrixAt(p.i, HIDE); any = true; continue; }
        p.vel.y -= p.gravity * dt;
        p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
        p.pos.addScaledVector(p.vel, dt);
        const t = p.life / p.max;
        p.rot.x += p.spin * dt; p.rot.y += p.spin * 0.7 * dt;
        const size = Math.max(0.001, (p.size + p.grow * (1 - t)) * (pool === this.glow ? Math.min(1, t * 2.5) : Math.min(1, t * 4)));
        _q.setFromEuler(p.rot);
        _m.compose(p.pos, _q, _s.setScalar(size));
        mesh.setMatrixAt(p.i, _m);
        any = true;
      }
      if (any) mesh.instanceMatrix.needsUpdate = true;
    }
    const tm = this.tracers.mesh;
    let anyT = false;
    for (const p of this.tracers.items) {
      if (!p.alive) continue;
      p.life -= dt;
      anyT = true;
      if (p.life <= 0) { p.alive = false; tm.setMatrixAt(p.i, HIDE); continue; }
      _d.subVectors(p.to, p.from);
      const len = _d.length();
      _q.setFromUnitVectors(_z, _d.normalize());
      _m.compose(p.from, _q, _s.set(p.width, p.width, len));
      tm.setMatrixAt(p.i, _m);
    }
    if (anyT) tm.instanceMatrix.needsUpdate = true;
    this.shake = Math.max(0, this.shake - dt * 1.6);
  }
}
