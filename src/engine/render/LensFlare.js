// Sun lens flare: glow, starburst, halo ring and a chain of aperture ghosts along the line from
// the sun through the centre of the screen, plus a little dazzle (exposure dip) while looking
// straight at the sun. Settings: environment.json `flare` (editor ☀, debug panel F2); on / off in
// the options menu.
//
// Visibility without reading anything back or adding a full-screen pass: right after the main
// scene (its depth buffer still holds the world; the view-model pass clears it afterwards), 16
// points spread over the sun disc are drawn just in front of the far plane with depth test, each
// in its own WebGL2 occlusion query (ANY_SAMPLES_PASSED_CONSERVATIVE). The results are polled,
// never waited for, a frame or two later: the share of points that passed is the visible share
// of the disc. Terrain, buildings, characters and leaves (dithered crowns let some points
// through) all count. Clouds write no depth, so each point evaluates the sky's cloud layer in its
// direction (clouds.js) and discards itself above its own threshold: a half-dense cloud hides
// about half of them. The visible share is smoothed over a few frames.
//
// The flare is one additive draw of a dozen screen-space quads with procedural shapes (no
// textures), skipped entirely while the sun is hidden or off screen.
import * as THREE from 'three';
import { CLOUDS_GLSL } from './clouds.js';

const N = 16; // probe points (= queries) per visibility sample
const SETS = 6; // query sets in flight at most (results take 2-3 frames with vsync)
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

const PROBE_VERT = /* glsl */ `
uniform vec3 sunDirW, tanU, tanV;
uniform float sunRadius;
varying vec3 vDir;
varying float vThreshold;
void main() {
  // position: x, y = offset on the unit disc, z = cloud threshold of this point
  vDir = normalize(sunDirW + (tanU * position.x + tanV * position.y) * sunRadius);
  vThreshold = position.z;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * vDir, 0.0);
  p.z = p.w * 0.999999; // just in front of the far plane: anything the scene drew hides it
  gl_Position = p;
  gl_PointSize = 1.0;
}`;

const PROBE_FRAG = /* glsl */ `
${CLOUDS_GLSL}
varying vec3 vDir;
varying float vThreshold;
void main() {
  if (skyClouds(vDir).x * 0.9 > vThreshold) discard;
  gl_FragColor = vec4(1.0);
}`;

const FLARE_VERT = /* glsl */ `
attribute vec4 el; // t along the sun -> centre line, half size, shape, gain group
attribute vec3 tint;
uniform vec2 sunPos;
uniform float aspect;
uniform vec3 gains, sunCol;
varying vec2 vUv;
varying vec3 vCol;
varying float vShape;
void main() {
  vec2 c = sunPos * (1.0 - el.x);
  gl_Position = vec4(c + position.xy * vec2(el.y / aspect, el.y), 0.0, 1.0);
  vUv = position.xy;
  vShape = el.z;
  vCol = tint * sunCol * (el.w < 0.5 ? gains.x : el.w < 1.5 ? gains.y : gains.z);
}`;

const FLARE_FRAG = /* glsl */ `
uniform float rot;
varying vec2 vUv;
varying vec3 vCol;
varying float vShape;
void main() {
  float r = length(vUv);
  vec3 col = vCol;
  float a;
  if (vShape < 0.5) { // glow: wide falloff + hot core, zero at the rim
    a = (exp(-r * r * 6.0) + exp(-r * 14.0) * 0.8) * max(1.0 - r * r, 0.0);
  } else if (vShape < 1.5) { // starburst: 6 long + 10 short rays
    float ang = atan(vUv.y, vUv.x) + rot;
    float rays = pow(abs(cos(ang * 3.0)), 80.0) + 0.5 * pow(abs(cos(ang * 5.0 + 0.7)), 120.0);
    a = rays * pow(max(1.0 - r, 0.0), 3.0);
  } else if (vShape < 2.5) { // thin ring with a spectral fringe
    float d = (r - 0.85) / 0.06;
    a = exp(-d * d);
    col *= mix(vec3(1.3, 0.75, 0.5), vec3(0.5, 0.8, 1.4), clamp(d * 0.4 + 0.5, 0.0, 1.0));
  } else if (vShape < 3.5) { // hexagonal aperture ghost, brighter rim
    vec2 p = abs(vUv);
    float hex = max(p.x * 0.866 + p.y * 0.5, p.y);
    a = smoothstep(1.0, 0.9, hex) * (0.5 + 0.5 * smoothstep(0.4, 0.95, hex));
  } else { // soft disc
    a = smoothstep(1.0, 0.55, r);
  }
  gl_FragColor = vec4(col * a, 1.0);
}`;

const S = THREE.MathUtils.smoothstep;
const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class LensFlare {
  constructor(renderer, lighting) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.lighting = lighting;
    // user toggle (options menu, debug panel); ?flare=0 for A/B benches
    this.enabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('flare') !== '0';
    this.visible = 0; // smoothed visible share of the sun disc (occluders x clouds)
    this.dazzle = 0; // exposure dip (Lighting multiplies the exposure by 1 - dazzle)
    this.elevation = 0; // fades the flare as the sun sets
    this.onScreen = false;
    this.sunNdc = new THREE.Vector2();
    this._target = 0;
    this._sets = []; // { q: [WebGLQuery x N], pending, seq }
    this._set = null;
    this._seq = 0;
    this._accepted = 0; // newest set whose result was used (older ones in flight are stale)

    // probes: Vogel spiral over the disc, cloud thresholds shuffled between neighbours
    const pts = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = Math.sqrt((i + 0.5) / N), a = i * 2.3999632;
      pts.set([Math.cos(a) * r, Math.sin(a) * r, (((i * 7) % N) + 0.5) / N], i * 3);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    pg.setDrawRange(0, 1); // three draws point 0, onAfterRender the other ones (one query each)
    const sky = lighting.skyU;
    this.probeMat = new THREE.ShaderMaterial({
      uniforms: {
        sunDirW: { value: new THREE.Vector3(0, 1, 0) },
        tanU: { value: new THREE.Vector3(1, 0, 0) },
        tanV: { value: new THREE.Vector3(0, 0, 1) },
        sunRadius: { value: SUN_RADIUS },
        cloudCoverage: sky.cloudCoverage, cloudSpeed: sky.cloudSpeed, uTime: sky.uTime,
      },
      vertexShader: PROBE_VERT,
      fragmentShader: PROBE_FRAG,
      colorWrite: false,
      depthWrite: false,
      toneMapped: false,
    });
    const gl = this.gl, T = gl.ANY_SAMPLES_PASSED_CONSERVATIVE;
    this.probes = new THREE.Points(pg, this.probeMat);
    this.probes.frustumCulled = false;
    this.probes.onBeforeRender = () => gl.beginQuery(T, this._set.q[0]);
    this.probes.onAfterRender = () => {
      gl.endQuery(T);
      // same program, buffers and state as the point three just drew
      for (let i = 1; i < N; i++) {
        gl.beginQuery(T, this._set.q[i]);
        gl.drawArrays(gl.POINTS, i, 1);
        gl.endQuery(T);
      }
    };
    this.probeScene = new THREE.Scene();
    this.probeScene.add(this.probes);

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
    this.flareMat = new THREE.ShaderMaterial({
      uniforms: {
        sunPos: { value: this.sunNdc },
        aspect: { value: 1 },
        rot: { value: 0 },
        gains: { value: new THREE.Vector3() },
        sunCol: sky.sunCol,
      },
      vertexShader: FLARE_VERT,
      fragmentShader: FLARE_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.flare = new THREE.Mesh(fg, this.flareMat);
    this.flare.frustumCulled = false;
    this.flareScene = new THREE.Scene();
    this.flareScene.add(this.flare);
    // shader warm-up (World.warmUp)
    this.scenes = [this.probeScene, this.flareScene];
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

  /** Right after the main scene, before anything clears its depth: issue this frame's queries. */
  occlude(camera) {
    this.onScreen = false;
    const sun = this.lighting.realSunDir;
    this.elevation = S(sun.y, -0.03, 0.1);
    if (!this.enabled || this.elevation <= 0 || !(this.env.intensity > 0)) return this._hidden();
    _v.copy(sun).transformDirection(camera.matrixWorldInverse);
    if (_v.z > -0.02) return this._hidden(); // behind the camera
    const e = camera.projectionMatrix.elements;
    const x = (e[0] * _v.x + e[8] * _v.z) / -_v.z, y = (e[5] * _v.y + e[9] * _v.z) / -_v.z;
    if (Math.abs(x) > 1.25 || Math.abs(y) > 1.25) return this._hidden();
    this.sunNdc.set(x, y);
    this.onScreen = true;

    let s = null;
    for (const q of this._sets) if (!q.pending) { s = q; break; }
    if (!s) {
      if (this._sets.length >= SETS) return; // results late: keep the last visibility
      s = { q: Array.from({ length: N }, () => this.gl.createQuery()), pending: false, seq: 0 };
      this._sets.push(s);
    }
    const u = this.probeMat.uniforms;
    u.sunDirW.value.copy(sun);
    u.tanU.value.crossVectors(sun, Math.abs(sun.y) > 0.99 ? _v.set(1, 0, 0) : _up).normalize();
    u.tanV.value.crossVectors(u.tanU.value, sun);
    this._set = s;
    const r = this.renderer, autoClear = r.autoClear;
    r.autoClear = false;
    r.render(this.probeScene, camera);
    r.autoClear = autoClear;
    s.pending = true;
    s.seq = ++this._seq;
  }

  /** Last thing drawn in the frame (over the view model too). */
  render(camera) {
    if (!this.onScreen) return;
    const env = this.env, { x, y } = this.sunNdc;
    const edge = 1 - S(Math.max(Math.abs(x), Math.abs(y)), 0.8, 1.2);
    const s = this.visible * this.elevation * edge * env.intensity;
    if (s < 0.004) return;
    const u = this.flareMat.uniforms;
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
    this._accepted = this._seq; // results still in flight describe an older view
  }

  _poll() {
    const gl = this.gl;
    for (const s of this._sets) {
      if (!s.pending || !gl.getQueryParameter(s.q[N - 1], gl.QUERY_RESULT_AVAILABLE)) continue;
      let ready = true, n = 0;
      for (const q of s.q) if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { ready = false; break; }
      if (!ready) continue;
      for (const q of s.q) if (gl.getQueryParameter(q, gl.QUERY_RESULT)) n++;
      s.pending = false;
      if (s.seq > this._accepted) { this._accepted = s.seq; this._target = n / N; }
    }
  }

  dispose() {
    for (const s of this._sets) for (const q of s.q) this.gl.deleteQuery(q);
    this._sets = [];
    this.probes.geometry.dispose();
    this.flare.geometry.dispose();
    this.probeMat.dispose();
    this.flareMat.dispose();
  }
}
