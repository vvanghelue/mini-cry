// Sun lens flare: glow, starburst, halo ring and a chain of aperture ghosts along the line from
// the sun through the centre of the screen, plus a little dazzle (exposure dip) while looking
// straight at the sun. Settings: environment.json `flare` (editor ☀, debug panel F2); on / off in
// the options menu.
//
// Visibility without reading anything back synchronously or adding a pass: 16 points spread over
// the sun disc are drawn at the very end of the main pass (after the whole world, depth-tested
// just in front of the far plane), each one an occlusion-tested object (WebGPU occlusion queries,
// one per point). three.js resolves the queries asynchronously; the results describe the frame a
// frame or two back. The share of points that passed is the visible share of the disc. Terrain,
// buildings, characters and leaves (dithered crowns let some points through) all count. Clouds
// write no depth, so each point evaluates the sky's cloud layer in its direction (clouds.js) and
// discards itself above its own threshold: a half-dense cloud hides about half of them. The
// visible share is smoothed over a few frames.
//
// The flare is one additive draw of a dozen screen-space quads with procedural shapes (no
// textures), skipped entirely while the sun is hidden or off screen.
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, attribute, varying, vec2, vec3, vec4, float, normalize, length, exp, max, min, pow, abs, cos, atan, smoothstep, clamp, mix, select,
  positionGeometry, cameraProjectionMatrix, cameraViewMatrix, Discard,
} from 'three/tsl';
import { LAYERS } from './layers.js';
import { skyClouds } from './clouds.js';

const N = 16; // probe points (= occlusion queries) per visibility sample
const SUN_RADIUS = 0.03; // rad, the sky's sun disc
const GLOW = 0, STAR = 1, RING = 2, HEX = 3, DISC = 4; // shapes
const SUN = 0, VEIL = 1, GHOST = 2; // gain groups: env.flare intensity, glare, ghosts
const FRESH = 3; // frames after the probes reappear before their results describe the new view

// [t: 0 sun .. 1 screen centre .. 2 mirrored, half size (share of the screen height), shape, group, intensity, tint]
const ELEMENTS = [
  [0, 1.15, GLOW, VEIL, 0.18, [1, 0.9, 0.78]],
  [0, 0.17, GLOW, SUN, 0.7, [1, 0.96, 0.88]],
  [0, 0.4, STAR, SUN, 0.4, [1, 0.95, 0.85]],
  [0, 0.62, RING, GHOST, 0.04, [1, 1, 1]],
  [0.38, 0.04, HEX, GHOST, 0.22, [1, 0.5, 0.15]],
  [0.62, 0.085, HEX, GHOST, 0.1, [0.3, 1, 0.35]],
  [0.84, 0.022, DISC, GHOST, 0.3, [0.35, 0.6, 1]],
  [1.18, 0.055, HEX, GHOST, 0.14, [0.7, 0.3, 1]],
  [1.42, 0.13, DISC, GHOST, 0.06, [0.25, 1, 0.6]],
  [1.66, 0.045, HEX, GHOST, 0.18, [1, 0.4, 0.15]],
  [1.95, 0.22, RING, GHOST, 0.06, [0.35, 0.65, 1]],
  [2.2, 0.03, DISC, GHOST, 0.25, [1, 0.75, 0.35]],
];

export const FLARE_DEFAULTS = {
  // intensity: whole flare (0 = off), glare: veil over the screen, ghosts: reflections, dazzle: exposure dip
  flare: { intensity: 1, glare: 1, ghosts: 1, dazzle: 0.15 },
};

const S = THREE.MathUtils.smoothstep;
const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class LensFlare {
  constructor(renderer, lighting) {
    this.renderer = renderer;
    this.lighting = lighting;
    // user toggle (options menu, debug panel); ?flare=0 for A/B benches
    this.enabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('flare') !== '0';
    this.visible = 0; // smoothed visible share of the sun disc (occluders x clouds)
    this.dazzle = 0; // exposure dip (Lighting multiplies the exposure by 1 - dazzle)
    this.elevation = 0; // fades the flare as the sun sets
    this.onScreen = false;
    this.sunNdc = new THREE.Vector2();
    this._target = 0;
    this._fresh = 0; // frames the probes have been drawn in a row

    // probes: Vogel spiral over the disc, cloud thresholds shuffled between neighbours
    const sky = lighting.skyU;
    this.u = {
      sunDirW: uniform(new THREE.Vector3(0, 1, 0)),
      tanU: uniform(new THREE.Vector3(1, 0, 0)),
      tanV: uniform(new THREE.Vector3(0, 0, 1)),
    };
    const pm = new THREE.NodeMaterial();
    pm.colorWrite = false;
    pm.depthWrite = false;
    pm.mcRaw = true;
    const vDir = varying(normalize(this.u.sunDirW.add(this.u.tanU.mul(positionGeometry.x).add(this.u.tanV.mul(positionGeometry.y)).mul(SUN_RADIUS))), 'vFlareDir');
    // just in front of the far plane: anything the scene drew hides it
    pm.vertexNode = Fn(() => {
      const p = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(vDir, 0)).xyz, 0)).toVar();
      return vec4(p.xy, p.w.mul(0.999999), p.w);
    })();
    const clouds = skyClouds(sky);
    const threshold = varying(positionGeometry.z, 'vFlareThreshold');
    pm.colorNode = Fn(() => {
      If(clouds(vDir).x.mul(0.9).greaterThan(threshold), () => { Discard(); });
      return vec4(1);
    })();
    pm.name = 'flareProbe';
    this.probeMat = pm;
    this.probes = [];
    this.probeGroup = new THREE.Group();
    this.probeGroup.name = 'FlareProbes';
    for (let i = 0; i < N; i++) {
      const r = Math.sqrt((i + 0.5) / N), a = i * 2.3999632;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([Math.cos(a) * r, Math.sin(a) * r, (((i * 7) % N) + 0.5) / N]), 3));
      const p = new THREE.Points(g, pm);
      p.occlusionTest = true;
      p.frustumCulled = false;
      p.renderOrder = 1e9; // after the world
      p.layers.set(LAYERS.FX);
      p.visible = false;
      p.name = `flareProbe${i}`;
      this.probes.push(p);
      this.probeGroup.add(p);
    }
    // the first probe drawn polls the (asynchronous) results of the previous ones
    this.probes[0].onBeforeRender = (r) => this._poll(r);
    lighting.scene.add(this.probeGroup);

    // flare quads
    const n = ELEMENTS.length;
    const pos = new Float32Array(n * 12), el = new Float32Array(n * 16), tint = new Float32Array(n * 12), idx = [];
    ELEMENTS.forEach(([t, size, shape, group, k, c], i) => {
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([x, y], j) => {
        const v = i * 4 + j;
        pos.set([x, y, 0], v * 3);
        el.set([t, size, shape, group], v * 4);
        tint.set([c[0] * k, c[1] * k, c[2] * k], v * 3);
      });
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fg.setAttribute('el', new THREE.BufferAttribute(el, 4));
    fg.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    fg.setIndex(idx);
    const fu = (this.fu = {
      sunPos: uniform(this.sunNdc),
      aspect: uniform(1),
      rot: uniform(0),
      gains: uniform(new THREE.Vector3()),
    });
    const fm = new THREE.NodeMaterial();
    fm.transparent = true;
    fm.blending = THREE.AdditiveBlending;
    fm.depthTest = fm.depthWrite = false;
    fm.mcRaw = true; // raw additive light, as the WebGL version wrote it
    const elA = attribute('el', 'vec4');
    fm.vertexNode = Fn(() => {
      const c = fu.sunPos.mul(float(1).sub(elA.x));
      return vec4(c.add(positionGeometry.xy.mul(vec2(elA.y.div(fu.aspect), elA.y))), 0, 1);
    })();
    const vUv = varying(positionGeometry.xy, 'vFlareUv');
    const vShape = varying(elA.z, 'vFlareShape');
    const gain = select(elA.w.lessThan(0.5), fu.gains.x, select(elA.w.lessThan(1.5), fu.gains.y, fu.gains.z));
    const vCol = varying(attribute('tint', 'vec3').mul(sky.sunCol).mul(gain), 'vFlareCol');
    fm.colorNode = Fn(() => {
      // (toVar: computed here, not inside the first branch that reads it)
      const r = length(vUv).toVar();
      const c = vec3(vCol).toVar();
      const a = float(0).toVar();
      If(vShape.lessThan(0.5), () => { // glow: wide falloff + hot core, zero at the rim
        a.assign(exp(r.mul(r).mul(-6)).add(exp(r.mul(-14)).mul(0.8)).mul(max(float(1).sub(r.mul(r)), 0)));
      }).ElseIf(vShape.lessThan(1.5), () => { // starburst: 6 long + 10 short rays
        const ang = atan(vUv.y, vUv.x).add(fu.rot);
        const rays = pow(abs(cos(ang.mul(3))), 80).add(pow(abs(cos(ang.mul(5).add(0.7))), 120).mul(0.5));
        a.assign(rays.mul(pow(max(float(1).sub(r), 0), 3)));
      }).ElseIf(vShape.lessThan(2.5), () => { // thin ring with a spectral fringe
        const d = r.sub(0.85).div(0.06);
        a.assign(exp(d.mul(d).negate()));
        c.mulAssign(mix(vec3(1.3, 0.75, 0.5), vec3(0.5, 0.8, 1.4), clamp(d.mul(0.4).add(0.5), 0, 1)));
      }).ElseIf(vShape.lessThan(3.5), () => { // hexagonal aperture ghost, brighter rim
        const p = abs(vUv);
        const hex = max(p.x.mul(0.866).add(p.y.mul(0.5)), p.y);
        a.assign(smoothstep(1, 0.9, hex).mul(smoothstep(0.4, 0.95, hex).mul(0.5).add(0.5)));
      }).Else(() => { // soft disc
        a.assign(smoothstep(1, 0.55, r));
      });
      return vec4(c.mul(a), 1);
    })();
    fm.name = 'flare';
    this.flareMat = fm;
    this.flare = new THREE.Mesh(fg, fm);
    this.flare.frustumCulled = false;
    this.flareScene = new THREE.Scene();
    this.flareScene.add(this.flare);
    // shader warm-up (World.warmUp): drawn only when the sun shows
    this.scenes = [this.flareScene];
  }

  get env() { return this.lighting.env.flare; }

  /** Before rendering: smooth the visibility, ease the dazzle, show the probes if the sun is in view. */
  update(dt, camera) {
    this.visible += (this._target - this.visible) * (1 - Math.exp(-dt * 14));
    let dz = 0;
    if (this.onScreen && this.enabled) {
      const d = Math.hypot(this.sunNdc.x * camera.aspect, this.sunNdc.y); // from the centre, in half screen heights
      dz = this.env.dazzle * this.env.intensity * this.visible * this.elevation * (1 - S(d, 0.15, 1.1));
    }
    this.dazzle += (Math.min(dz, 0.6) - this.dazzle) * (1 - Math.exp(-dt * 3));
    this._place(camera);
  }

  /** Sun on screen? Shows / hides the probes of this frame's main pass. */
  _place(camera) {
    const was = this.onScreen;
    this.onScreen = false;
    const sun = this.lighting.realSunDir;
    this.elevation = S(sun.y, -0.03, 0.1);
    let show = this.enabled && this.elevation > 0 && this.env.intensity > 0;
    if (show) {
      camera.updateMatrixWorld();
      _v.copy(sun).transformDirection(camera.matrixWorldInverse);
      const e = camera.projectionMatrix.elements;
      const x = (e[0] * _v.x + e[8] * _v.z) / -_v.z, y = (e[5] * _v.y + e[9] * _v.z) / -_v.z;
      show = _v.z <= -0.02 && Math.abs(x) <= 1.25 && Math.abs(y) <= 1.25; // in front, near the screen
      if (show) this.sunNdc.set(x, y);
    }
    this.onScreen = show;
    for (const p of this.probes) p.visible = show;
    if (!show) { this._target = 0; this._fresh = 0; return; }
    if (!was) this._fresh = 0;
    const u = this.u;
    u.sunDirW.value.copy(sun);
    u.tanU.value.crossVectors(sun, Math.abs(sun.y) > 0.99 ? _v.set(1, 0, 0) : _up).normalize();
    u.tanV.value.crossVectors(u.tanU.value, sun);
  }

  /** Inside the main pass: the share of the probes that passed in the last resolved queries. */
  _poll(renderer) {
    if (++this._fresh <= FRESH) return; // results still describe an older view
    let n = 0;
    for (const p of this.probes) if (!renderer.isOccluded(p)) n++;
    this._target = n / N;
  }

  /** Last thing drawn in the frame (over the view model too). */
  render(camera) {
    if (!this.onScreen) return;
    const env = this.env, { x, y } = this.sunNdc;
    const edge = 1 - S(Math.max(Math.abs(x), Math.abs(y)), 0.8, 1.2);
    const s = this.visible * this.elevation * edge * env.intensity;
    if (s < 0.004) return;
    const u = this.fu;
    u.aspect.value = camera.aspect;
    u.rot.value = (x + y) * 0.6;
    u.gains.value.set(s, s * env.glare, s * env.ghosts);
    const r = this.renderer, autoClear = r.autoClear;
    r.autoClear = false;
    r.render(this.flareScene, camera);
    r.autoClear = autoClear;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!v) { this._target = 0; this._fresh = 0; for (const p of this.probes) p.visible = false; }
  }

  dispose() {
    for (const p of this.probes) p.geometry.dispose();
    this.probeGroup.removeFromParent();
    this.flare.geometry.dispose();
    this.probeMat.dispose();
    this.flareMat.dispose();
  }
}
