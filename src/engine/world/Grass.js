// Near-camera grass: tufts generated on the fly (deterministic hash per 8 m tile, filtered by the
// painted / automatic terrain material and slope), only within `radius` of the camera, faded out
// with distance in the vertex shader. Never stored, never casts shadows.
import * as THREE from 'three';
import { hash2 } from '../math/random.js';
import { MATERIAL_ID } from './TerrainData.js';
import { LAYERS } from '../render/layers.js';
import { syncBlocks } from '../render/InstanceBlocks.js';
import { InstancedBatch } from '../render/Instancing.js';
import { cloneMaterial } from '../render/Lighting.js';
import { U } from '../render/tsl.js';

const TILE = 8;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _n = { x: 0, y: 1, z: 0 };

export class Grass {
  constructor(world, assets, def) {
    this.world = world;
    this.terrain = world.terrain;
    this.def = def;
    this.radius = def.radius ?? 40;
    this.density = def.density ?? 2; // tufts per m2 near the camera
    this.mats = new Set((def.materials ?? ['grass']).map((m) => MATERIAL_ID[m]));
    this.maxSlopeCos = Math.cos(((def.maxSlope ?? 35) * Math.PI) / 180);
    this.group = new THREE.Group();
    this.group.name = 'Grass';
    this.tiles = new Map(); // key -> Float32Array per variant
    this.variants = def.variants ?? 3;
    const lighting = world.lighting;
    // shrunk to nothing between 60 % and 100 % of the radius (vertex stage)
    this.fade = U(new THREE.Vector2(this.radius * 0.6, this.radius));
    this.meshes = [];
    for (let v = 0; v < this.variants; v++) {
      const b = assets.build(def.asset ?? 'grass_tuft', { quality: 1, variant: v });
      const base = assets.material(b);
      const mat = cloneMaterial(base);
      lighting.setupVertex(mat, { ...(base.mcOpts ?? {}), fadeRange: this.fade });
      const mesh = new InstancedBatch(b.geometry, mat, 4096);
      mesh.layers.set(LAYERS.DETAIL);
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    this._last = new THREE.Vector3(1e9, 0, 0);
    this.enabled = true;
  }

  setDensityScale(k) { this.scale = k; this.invalidate(); }

  _tile(tx, tz) {
    const key = tx + ',' + tz;
    let t = this.tiles.get(key);
    if (t) return t;
    const T = this.terrain;
    const per = Math.max(1, Math.round(TILE * TILE * this.density * (this.scale ?? 1)));
    const lists = Array.from({ length: this.variants }, () => []);
    for (let k = 0; k < per; k++) {
      const x = (tx + hash2(tx * 131 + k, tz, 17)) * TILE;
      const z = (tz + hash2(tx, tz * 131 + k, 29)) * TILE;
      if (!T.inBounds(x, z)) continue;
      if (!this.mats.has(T.materialAtWorld(x, z))) continue;
      const y = T.heightAt(x, z);
      if (T.waterLevelAt(x, z) > y - 0.1) continue;
      T.normalAt(x, z, _n);
      if (_n.y < this.maxSlopeCos) continue;
      const v = Math.floor(hash2(k, tx + tz, 5) * this.variants);
      _q.setFromAxisAngle(_up, hash2(tx, k, 3) * 6.283);
      _m.compose(_p.set(x, y - 0.03, z), _q, _s.setScalar(0.7 + hash2(k, tz, 9) * 0.7));
      for (let i = 0; i < 16; i++) lists[v].push(_m.elements[i]);
    }
    t = lists.map((l) => new Float32Array(l));
    if (this.tiles.size > 4000) this.tiles.clear();
    this.tiles.set(key, t);
    return t;
  }

  invalidate() { this.tiles.clear(); this._last.set(1e9, 0, 0); for (const m of this.meshes) m.userData.repack = true; }

  update(camera) {
    if (!this.enabled) { for (const m of this.meshes) m.visible = false; this._last.set(1e9, 0, 0); return; }
    const cp = camera.position;
    const ground = this.terrain.heightAt(cp.x, cp.z);
    const high = cp.y - ground > this.radius;
    if (high) { for (const m of this.meshes) m.visible = false; this._last.set(1e9, 0, 0); return; }
    if (cp.distanceToSquared(this._last) < 4) return; // re-gather every 2 m
    this._last.copy(cp);
    const r = this.radius, r2 = (r + TILE) * (r + TILE);
    const tx0 = Math.floor((cp.x - r) / TILE), tx1 = Math.floor((cp.x + r) / TILE);
    const tz0 = Math.floor((cp.z - r) / TILE), tz1 = Math.floor((cp.z + r) / TILE);
    // one block per 8 m tile: moving only uploads the tiles that entered the radius
    const wants = (this._wants ??= this.meshes.map(() => new Map()));
    for (const w of wants) w.clear();
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const cx = (tx + 0.5) * TILE - cp.x, cz = (tz + 0.5) * TILE - cp.z;
        if (cx * cx + cz * cz > r2) continue;
        const t = this._tile(tx, tz);
        const key = (tx + 4096) * 8192 + tz + 4096;
        for (let v = 0; v < t.length; v++) if (t[v].length) wants[v].set(key, t[v]);
      }
    }
    this.meshes.forEach((m, v) => {
      syncBlocks(m, wants[v], (k, a) => a.length / 16, (k, a, dst, at) => dst.set(a, at * 16));
      m.visible = m.instances > m.userData.holes;
    });
  }
}
