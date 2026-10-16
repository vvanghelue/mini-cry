// Sun lens flare: glow, starburst, halo ring and a chain of aperture ghosts along the line from
// the sun through the centre of the screen, plus a little dazzle (exposure dip) while looking
// straight at the sun. Settings: environment.json `flare` (editor ☀, debug panel F2); on / off in
// the options menu.
//
// Visibility without reading anything back or adding a pass: in the main pass, after the opaque
// world, 16 points spread over the sun disc are drawn just in front of the far plane with depth
// test, each with its own occlusion query (three.js `occlusionTest`, WebGPU occlusion query set).
// The results come back asynchronously, a frame or two later, and are never waited for: the share
// of points that passed is the visible share of the disc. Terrain, buildings, characters and
// leaves (dithered crowns let some points through) all count. Clouds write no depth, so each
// point evaluates the sky's cloud layer in its direction (clouds.js) and discards itself above its
// own threshold: a half-dense cloud hides about half of them. The visible share is smoothed over a
// few frames.
//
// The flare is one additive draw of a dozen screen-space quads with procedural shapes (no
// textures), skipped entirely while the sun is hidden or off screen.
import * as THREE from 'three/webgpu';
import { Fn, If, Discard, float, vec2, vec3, vec4, max, abs, exp, pow, cos, atan, length, mix, smoothstep, select, attribute, varying, cameraProjectionMatrix, cameraViewMatrix, mat3 } from 'three/tsl';
import { U } from './tsl.js';
import { LAYERS } from './layers.js';

const N = 16; // probe points (= queries) per visibility sample
const SUN_RADIUS = 0.03; // rad, the sky's sun disc
const GLOW = 0, STAR = 1, RING = 2, HEX = 3, DISC = 4; // shapes
const SUN = 0, VEIL = 1, GHOST = 2; // gain groups: env.flare intensity, glare, ghosts

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
    this._ctx = null; // the main pass' render context (occlusion results live there)

    // probes: Vogel spiral over the disc, cloud thresholds shuffled between neighbours
    const sky = lighting.skyU;
    this.pu = { sunDirW: U(new THREE.Vector3(0, 1, 0)), tanU: U(new THREE.Vector3(1, 0, 0)), tanV: U(new THREE.Vector3(0, 0, 1)) };
    const probeMat = new THREE.PointsNodeMaterial({ depthWrite: false, colorWrite: false, fog: false, transparent: false });
    probeMat.toneMapped = false;
    const pu = this.pu;
    const dir = () => {
      const p = attribute('position', 'vec3');
      return pu.sunDirW.add(pu.tanU.mul(p.x).add(pu.tanV.mul(p.y)).mul(SUN_RADIUS)).normalize();
    };
    probeMat.vertexNode = Fn(() => {
      // just in front of the far plane: anything the scene drew hides it
      const c = cameraProjectionMatrix.mul(vec4(mat3(cameraViewMatrix).mul(dir()), 0.0)).toVar();
      c.z.assign(c.w.mul(0.999999));
      return c;
    })();
    const vDir = varying(dir(), 'vProbeDir'), vThreshold = varying(attribute('position', 'vec3').z, 'vThreshold');
    probeMat.colorNode = Fn(() => {
      If(lighting.skyClouds(vDir).x.mul(0.9).greaterThan(vThreshold), () => { Discard(); });
      return vec4(1.0);
    })();
    this.probes = [];
    for (let i = 0; i < N; i++) {
      const r = Math.sqrt((i + 0.5) / N), a = i * 2.3999632;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([Math.cos(a) * r, Math.sin(a) * r, (((i * 7) % N) + 0.5) / N]), 3));
      const p = new THREE.Points(g, probeMat);
      p.frustumCulled = false;
      p.occlusionTest = true;
      p.renderOrder = 1e6 + 1; // after the opaque world and the sky
      p.layers.set(LAYERS.FX); // the main view only
      p.visible = false;
      this.probes.push(p);
      lighting.scene.add(p);
    }
    this.probes[0].onBeforeRender = (r) => { this._ctx = r._currentRenderContext; };

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
    const fu = (this.fu = { sunPos: U(this.sunNdc), aspect: U(1), rot: U(0), gains: U(new THREE.Vector3()) });
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false });
    mat.toneMapped = false;
    mat.mcRawOutput = true; // written as is, like the WebGL shader (no sRGB encoding)
    mat.lights = false;
    const E = attribute('el', 'vec4'), P = attribute('position', 'vec3');
    mat.vertexNode = Fn(() => {
      const c = fu.sunPos.mul(float(1.0).sub(E.x));
      return vec4(c.add(P.xy.mul(vec2(E.y.div(fu.aspect), E.y))), 0.5, 1.0);
    })();
    const vUv = varying(P.xy, 'vUv');
    const vShape = varying(E.z, 'vShape');
    const vCol = varying(attribute('tint', 'vec3').mul(sky.sunCol).mul(select(E.w.lessThan(0.5), fu.gains.x, select(E.w.lessThan(1.5), fu.gains.y, fu.gains.z))), 'vCol');
    mat.colorNode = Fn(() => {
      const r = length(vUv).toVar();
      const col = vec3(vCol).toVar();
      const a = float(0.0).toVar();
      If(vShape.lessThan(0.5), () => { // glow: wide falloff + hot core, zero at the rim
        a.assign(exp(r.mul(r).mul(-6.0)).add(exp(r.mul(-14.0)).mul(0.8)).mul(max(float(1.0).sub(r.mul(r)), 0.0)));
      }).ElseIf(vShape.lessThan(1.5), () => { // starburst: 6 long + 10 short rays
        const ang = atan(vUv.y, vUv.x).add(fu.rot);
        const rays = pow(abs(cos(ang.mul(3.0))), 80.0).add(pow(abs(cos(ang.mul(5.0).add(0.7))), 120.0).mul(0.5));
        a.assign(rays.mul(pow(max(float(1.0).sub(r), 0.0), 3.0)));
      }).ElseIf(vShape.lessThan(2.5), () => { // thin ring with a spectral fringe
        const d = r.sub(0.85).div(0.06).toVar();
        a.assign(exp(d.mul(d).negate()));
        col.mulAssign(mix(vec3(1.3, 0.75, 0.5), vec3(0.5, 0.8, 1.4), d.mul(0.4).add(0.5).clamp(0.0, 1.0)));
      }).ElseIf(vShape.lessThan(3.5), () => { // hexagonal aperture ghost, brighter rim
        const p = abs(vUv);
        const hex = max(p.x.mul(0.866).add(p.y.mul(0.5)), p.y);
        a.assign(smoothstep(1.0, 0.9, hex).mul(smoothstep(0.4, 0.95, hex).mul(0.5).add(0.5)));
      }).Else(() => { // soft disc
        a.assign(smoothstep(1.0, 0.55, r));
      });
      return vec4(col.mul(a), 1.0);
    })();
    this.flare = new THREE.Mesh(fg, mat);
    this.flare.frustumCulled = false;
    this.flareScene = new THREE.Scene();
    this.flareScene.add(this.flare);
    // shader warm-up (World.warmUp)
    this.scenes = [this.flareScene];
  }

  get env() { return this.lighting.env.flare; }

  /** Before rendering: collect query results, smooth the visibility, ease the dazzle. */
  update(dt, camera) {
    this._poll();
    this.visible += (this._target - this.visible) * (1 - Math.exp(-dt * 14));
    let dz = 0;
    if (this.onScreen && this.enabled) {
      const d = Math.hypot(this.sunNdc.x * camera.aspect, this.sunNdc.y); // from the centre, in half screen heights
      dz = this.env.dazzle * this.env.intensity * this.visible * this.elevation * (1 - S(d, 0.15, 1.1));
    }
    this.dazzle += (Math.min(dz, 0.6) - this.dazzle) * (1 - Math.exp(-dt * 3));
  }

  /** Before the main pass: aim the probes at the sun (drawn and queried within that pass). */
  beforeRender(camera) {
    this.onScreen = false;
    const sun = this.lighting.realSunDir;
    this.elevation = S(sun.y, -0.03, 0.1);
    let show = this.enabled && this.elevation > 0 && this.env.intensity > 0;
    if (show) {
      _v.copy(sun).transformDirection(camera.matrixWorldInverse);
      show = _v.z <= -0.02; // in front of the camera
    }
    if (show) {
      const e = camera.projectionMatrix.elements;
      const x = (e[0] * _v.x + e[8] * _v.z) / -_v.z, y = (e[5] * _v.y + e[9] * _v.z) / -_v.z;
      show = Math.abs(x) <= 1.25 && Math.abs(y) <= 1.25;
      if (show) this.sunNdc.set(x, y);
    }
    for (const p of this.probes) p.visible = show;
    if (!show) return this._hidden();
    this.onScreen = true;
    const u = this.pu;
    u.sunDirW.value.copy(sun);
    u.tanU.value.crossVectors(sun, Math.abs(sun.y) > 0.99 ? _v.set(1, 0, 0) : _up).normalize();
    u.tanV.value.crossVectors(u.tanU.value, sun);
    this._shown = (this._shown ?? 0) + 1; // frames in a row the probes were drawn
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
    if (!v) this._hidden();
  }

  _hidden() {
    this._target = 0;
    this._shown = 0;
  }

  /** The latest query results (a frame or two old): the share of probes that passed. */
  _poll() {
    // results lag 1-3 frames: older ones describe a view without the probes
    if (!(this._shown > 3) || !this._ctx) return;
    const b = this.renderer.backend;
    if (!b.isOccluded) return;
    let n = 0;
    for (const p of this.probes) if (!b.isOccluded(this._ctx, p)) n++;
    this._target = n / N;
  }

  dispose() {
    for (const p of this.probes) { p.geometry.dispose(); p.removeFromParent(); }
    this.probes[0].material.dispose();
    this.flare.geometry.dispose();
    this.flare.material.dispose();
  }
}
