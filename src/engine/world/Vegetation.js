// Vegetation: the placed instances of vegetation.bin (trees, bushes, ferns, rocks) drawn through
// an InstancedField (sector culling + LODs, see render/InstancedField.js). Edits (editor brushes,
// sculpting) change `data` and call rebuild().
import * as THREE from 'three';
import { InstancedField } from '../render/InstancedField.js';
import { decodeVegetation, encodeVegetation } from './VegetationScatter.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class Vegetation {
  constructor(world, assets, def, bytes) {
    this.world = world;
    this.terrain = world.terrain;
    this.assets = assets;
    this.def = def;
    this.data = decodeVegetation(bytes);
    // two fields: small plants (short draw distance) use fine 24 m sectors so their LOD / culling
    // follows the camera closely; trees and rocks use 64 m sectors (fewer sectors to walk)
    this.near = def.species.map((sp) => (sp.lods?.length ? sp.lods[sp.lods.length - 1].distance : 200) < 160);
    const kinds = def.species.map((sp) => ({ id: sp.id, asset: sp.asset, variants: sp.variants ?? 1, lods: sp.lods, castShadow: sp.castShadow, blend: sp.blend, shareVariantsFrom: sp.shareVariantsFrom, impostor: sp.impostor }));
    const mk = (name, sector, keep) => new InstancedField({ name, assets, lighting: world.lighting, worldSize: this.terrain.size, sector, kinds: kinds.map((k, i) => (keep(i) ? k : { ...k, lods: [{ distance: 0.001, quality: 0.25 }], castShadow: 0, empty: true })) });
    this.fieldNear = mk('VegetationNear', 24, (i) => this.near[i]);
    this.fieldFar = mk('VegetationFar', 64, (i) => !this.near[i]);
    this.group = new THREE.Group();
    this.group.name = 'Vegetation';
    this.group.add(this.fieldNear.group, this.fieldFar.group);
    this.field = this.fieldFar; // (compat)
    this.rebuild();
  }

  get stats() {
    const a = this.fieldNear.stats, b = this.fieldFar.stats;
    return { instances: a.instances + b.instances, meshes: a.meshes + b.meshes, triangles: a.triangles + b.triangles };
  }
  bakeImpostors(renderer) { this.fieldNear.bakeImpostors(renderer); this.fieldFar.bakeImpostors(renderer); }

  /** Per species / LOD draw statistics (InstancedField.lodStats), both fields. */
  lodStats(camera, viewHeight, tinyPx) { return [...this.fieldNear.lodStats(camera, viewHeight, tinyPx), ...this.fieldFar.lodStats(camera, viewHeight, tinyPx)]; }
  set drawScale(v) { this.fieldNear.drawScale = v; this.fieldFar.drawScale = v; }
  get drawScale() { return this.fieldFar.drawScale; }

  /** Re-place every instance on the ground (after sculpting / brush edits). */
  rebuild(bytes) {
    if (bytes) this.data = decodeVegetation(bytes);
    const d = this.data, T = this.terrain;
    this.fieldNear.clear();
    this.fieldFar.clear();
    for (let k = 0; k < d.n; k++) {
      const sp = d.species[k];
      if (sp >= this.near.length) continue;
      _q.setFromAxisAngle(_up, d.yaw[k]);
      _m.compose(_p.set(d.x[k], T.heightAt(d.x[k], d.z[k]) - 0.05, d.z[k]), _q, _s.setScalar(d.scale[k]));
      (this.near[sp] ? this.fieldNear : this.fieldFar).add(sp, d.variant[k], _m, k);
    }
  }

  encode() { return encodeVegetation(this.data); }

  /** Editor brush: remove instances within r of (x, z) (optionally one species index). Returns count. */
  erase(x, z, r, species = -1) {
    const d = this.data;
    const keep = [];
    for (let k = 0; k < d.n; k++) if (!((d.x[k] - x) ** 2 + (d.z[k] - z) ** 2 < r * r && (species < 0 || d.species[k] === species))) keep.push(k);
    const removed = d.n - keep.length;
    if (removed) this._select(keep);
    return removed;
  }

  /** Editor brush: add instances [{ species, variant, x, z, yaw, scale }]. */
  addInstances(list) {
    const d = this.data, n = d.n + list.length;
    const grow = (a, T) => { const b = new T(n); b.set(a); return b; };
    const out = { n, species: grow(d.species, Uint8Array), variant: grow(d.variant, Uint8Array), yaw: grow(d.yaw, Float32Array), scale: grow(d.scale, Float32Array), x: grow(d.x, Float32Array), z: grow(d.z, Float32Array) };
    list.forEach((it, i) => {
      const k = d.n + i;
      out.species[k] = it.species; out.variant[k] = it.variant ?? 0; out.yaw[k] = it.yaw ?? 0; out.scale[k] = it.scale ?? 1; out.x[k] = it.x; out.z[k] = it.z;
    });
    this.data = out;
  }

  _select(keep) {
    const d = this.data, n = keep.length;
    const pick = (a, T) => { const b = new T(n); keep.forEach((k, i) => (b[i] = a[k])); return b; };
    this.data = { n, species: pick(d.species, Uint8Array), variant: pick(d.variant, Uint8Array), yaw: pick(d.yaw, Float32Array), scale: pick(d.scale, Float32Array), x: pick(d.x, Float32Array), z: pick(d.z, Float32Array) };
  }

  update(camera) { this.fieldNear.update(camera); this.fieldFar.update(camera); }

  /** Static colliders of the species marked `collide` (trunks, rocks): cb(shape, x, y, z, yaw, scale, index). */
  forEachCollider(cb) {
    const d = this.data, T = this.terrain;
    // per (species, variant): generator forms can give variants different trunks
    const shapes = new Map();
    for (let k = 0; k < d.n; k++) {
      const sp = this.def.species[d.species[k]];
      if (!sp?.collide) continue;
      const key = d.species[k] * 256 + d.variant[k];
      let cl = shapes.get(key);
      if (!cl) shapes.set(key, (cl = this.assets.build(sp.asset, { quality: 0.25, variant: Math.min(d.variant[k], (sp.variants ?? 1) - 1) }).colliders));
      if (!cl?.length) continue;
      const y = T.heightAt(d.x[k], d.z[k]);
      for (const c of cl) cb(c, d.x[k], y, d.z[k], d.yaw[k], d.scale[k], k);
    }
  }

  dispose() { this.fieldNear.dispose(); this.fieldFar.dispose(); }
}
