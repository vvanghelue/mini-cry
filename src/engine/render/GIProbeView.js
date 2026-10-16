// Debug view of the baked GI probes (F2 > Graphics > GI (probes) > show probes): a small
// sphere at each probe around the camera, shaded by the probe's relit irradiance alone (what a
// white diffuse ball would look like there, like "vue irradiance seule"). One instanced draw on
// the FX layer (no shadow, no SSAO), refilled only when the camera changes cell, the light changes
// or a setting changes. Add it as an engine system while shown.
import * as THREE from 'three/webgpu';
import { vec3, vec4, dot, max, attribute, varying, normalGeometry } from 'three/tsl';
import { GI_LAYERS, layerHeight, volumeProbePos } from './GIField.js';
import { LAYERS } from './layers.js';

const MAX_RADIUS = 128; // m

export class GIProbeView {
  /** gi = Lighting.gi, groundAt(x, z) = terrain height (probes are kept 0.25 m above it, as baked). */
  constructor(gi, scene, groundAt = null) {
    this.gi = gi;
    this.scene = scene;
    this.groundAt = groundAt;
    this.radius = 48; // m around the camera
    this.size = 0.4; // sphere radius (m)
    this.layer = -1; // -1 = every layer, else 0..GI_LAYERS-1
    this.mesh = null;
    this._key = new Float64Array(16).fill(NaN);
    this._sh = new Float32Array(12);
  }

  get visible() { return !!this.mesh?.visible; }

  setVisible(v) {
    if (v && !this.mesh) this._create();
    if (this.mesh) this.mesh.visible = !!v;
    this._key[0] = NaN; // refill on the next update
  }

  _create() {
    const cells = 2 * Math.ceil(MAX_RADIUS / 8) + 1, cap = cells * cells * GI_LAYERS + (this.gi.data?.vols?.count ?? 0);
    const geo = new THREE.IcosahedronGeometry(1, 2);
    this.attrs = ['giR', 'giG', 'giB'].map((name) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    });
    const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
    // colour = irradiance of the probe's L1 SH for the vertex normal / PI (instances are not rotated)
    const k = vec4(1.0, normalGeometry);
    const gi = max(vec3(dot(attribute('giR', 'vec4'), k), dot(attribute('giG', 'vec4'), k), dot(attribute('giB', 'vec4'), k)), 0.0).mul(1 / Math.PI);
    mat.colorNode = vec4(varying(gi, 'vGi'), 1.0);
    const mesh = (this.mesh = new THREE.InstancedMesh(geo, mat, cap));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.layers.set(LAYERS.FX);
    mesh.name = 'giProbeView';
    this.scene.add(mesh);
  }

  update(dt, engine) {
    const d = this.gi.data, mesh = this.mesh;
    if (!d || !mesh?.visible) return;
    const p = engine.camera.getWorldPosition((this._p ??= new THREE.Vector3()));
    const ci = Math.round((p.x + d.half) / d.cell - 0.5), cj = Math.round((p.z + d.half) / d.cell - 0.5);
    const w = this.gi.weights, k = this._key;
    const key = [ci, cj, this.radius, this.size, this.layer, w.kA, w.kB, w.f, ...w.sky, ...w.sun];
    let same = true;
    for (let i = 0; i < key.length; i++) if (k[i] !== key[i]) { same = false; k[i] = key[i]; }
    if (!same) this._fill(d, ci, cj, w);
  }

  _fill(d, ci, cj, w) {
    const n = d.n, cell = d.cell, R = Math.ceil(Math.min(this.radius, MAX_RADIUS) / cell), r2 = (this.radius / cell) ** 2;
    const m = this.mesh.instanceMatrix.array, [aR, aG, aB] = this.attrs, sh = this._sh, s = this.size;
    let c = 0;
    for (let j = Math.max(0, cj - R); j <= Math.min(n - 1, cj + R); j++) {
      for (let i = Math.max(0, ci - R); i <= Math.min(n - 1, ci + R); i++) {
        if ((i - ci) ** 2 + (j - cj) ** 2 > r2) continue;
        const x = (i + 0.5) * cell - d.half, z = (j + 0.5) * cell - d.half;
        const base = d.base[j * n + i], ground = this.groundAt ? this.groundAt(x, z) + 0.25 : -Infinity;
        for (let l = 0; l < GI_LAYERS; l++) {
          if (this.layer >= 0 && l !== this.layer) continue;
          d.probe(i, j, l, w, sh);
          const o = c * 16;
          m.fill(0, o, o + 16);
          m[o] = m[o + 5] = m[o + 10] = s;
          m[o + 12] = x; m[o + 13] = Math.max(base + layerHeight(l), ground); m[o + 14] = z; m[o + 15] = 1;
          aR.array.set(sh.subarray(0, 4), c * 4);
          aG.array.set(sh.subarray(4, 8), c * 4);
          aB.array.set(sh.subarray(8, 12), c * 4);
          c++;
        }
      }
    }
    // interior volumes (drawn smaller: their probes are closer together), every layer
    const V = d.vols, vp = (this._vp ??= [0, 0, 0]), cx = (ci + 0.5) * cell - d.half, cz = (cj + 0.5) * cell - d.half;
    for (const v of V?.list ?? []) {
      if ((v.c[0] - cx) ** 2 + (v.c[2] - cz) ** 2 > this.radius ** 2) continue;
      for (let y = 0; y < v.res[1]; y++) for (let z = 0; z < v.res[2]; z++) for (let x = 0; x < v.res[0]; x++) {
        if (c * 16 >= m.length) break;
        d.volumeProbe(v, x, y, z, w, sh);
        volumeProbePos(v, x, y, z, vp);
        const o = c * 16;
        m.fill(0, o, o + 16);
        m[o] = m[o + 5] = m[o + 10] = s * 0.5;
        m[o + 12] = vp[0]; m[o + 13] = vp[1]; m[o + 14] = vp[2]; m[o + 15] = 1;
        aR.array.set(sh.subarray(0, 4), c * 4);
        aG.array.set(sh.subarray(4, 8), c * 4);
        aB.array.set(sh.subarray(8, 12), c * 4);
        c++;
      }
    }
    this.mesh.count = c;
    for (const a of [this.mesh.instanceMatrix, aR, aG, aB]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, c * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh = null;
  }
}
