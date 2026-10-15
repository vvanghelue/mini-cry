// Dust motes: specks floating in the air around the camera, drifting with the wind and wandering a
// little, lit by the sun only where it really shines (the vertex shader reads the sun cascades:
// they show in the beams through the canopy, not in the shade), much brighter against the light
// (forward scattering). One draw of additive points (FX layer: no shadow, no SSAO), wrapped in a
// box that follows the camera. Strength, count, size, box, drift: environment.json `motes`; on / off:
// player setting (Options menu, F2, `?motes=0`).
import * as THREE from 'three';
import { LAYERS } from './layers.js';
import { SUN_GLSL } from './SunShadows.js';

export const MOTES_DEFAULTS = {
  motes: {
    intensity: 1, // 0 = none
    count: 3000, // in the box
    size: 0.014, // m (drawn at least 1.5 px, dimmer)
    box: 10, // m: side of the box around the camera (faded out past ~a third of it)
    drift: 0.35, // m/s along the wind
  },
};

const MAX = 4000;

const VERT = /* glsl */ `
${SUN_GLSL}
attribute vec4 seed; // home in the box (xyz, 0..1), phase
uniform float uTime, moteBox, moteSize, moteGain, moteViewH;
uniform vec3 moteDrift;
varying vec3 vCol;
void main() {
  float B = moteBox;
  vec3 p = seed.xyz * B + moteDrift;
  float t = uTime * (0.2 + 0.25 * seed.w) + seed.w * 61.0;
  p += vec3(sin(t * 1.3 + seed.x * 17.0), 0.5 * sin(t * 0.7 + seed.y * 13.0), sin(t * 1.1 + seed.z * 11.0 + 1.6)) * 0.35;
  p = cameraPosition + mod(p - cameraPosition + 0.5 * B, B) - 0.5 * B; // wrapped around the camera
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(mv.xyz);
  float fwd = max(dot((p - cameraPosition) / max(d, 1e-3), sunDirW), 0.0);
  float f2 = fwd * fwd, f8 = f2 * f2; f8 *= f8;
  float phase = 0.12 + 0.4 * f2 + 2.4 * f8;
  float fade = smoothstep(0.5, 1.5, d) * (1.0 - smoothstep(B * 0.3, B * 0.5, d));
  float px = moteSize * projectionMatrix[1][1] * moteViewH * 0.5 / max(d, 0.1);
  float sz = max(px, 1.5);
  float twinkle = 0.55 + 0.45 * sin(uTime * (1.5 + 3.0 * seed.w) + seed.x * 40.0);
  float k = fade * phase * twinkle * moteGain * min(1.0, px * px / (sz * sz));
  if (k < 1e-3 || mv.z > -0.1) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; } // invisible: culled
  vCol = sunColor * (k * sunShadow(p, sunDirW, 1.0));
  gl_PointSize = sz;
}`;

const FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = max(1.0 - dot(c, c), 0.0);
  gl_FragColor = vec4(vCol * (a * a), 1.0);
}`;

export class Motes {
  constructor(lighting) {
    this.lighting = lighting;
    this.cfg = structuredClone(MOTES_DEFAULTS.motes);
    this.enabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('motes') !== '0';
    const seed = new Float32Array(MAX * 4);
    let s = 0x2f6b1d;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < seed.length; i++) seed[i] = rnd();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    this.uniforms = {
      ...lighting.sun.uniforms,
      uTime: lighting.uniforms.uTime,
      moteBox: { value: 16 },
      moteSize: { value: 0.012 },
      moteGain: { value: 0 },
      moteViewH: { value: 900 },
      moteDrift: { value: new THREE.Vector3() },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'Motes';
    this.points.frustumCulled = false;
    this.points.layers.set(LAYERS.FX);
    this.points.renderOrder = 10; // after the water
    const size = new THREE.Vector2();
    this.points.onBeforeRender = (r) => { this.uniforms.moteViewH.value = r.getDrawingBufferSize(size).y; };
    lighting.scene.add(this.points);
  }

  setConfig(cfg) {
    this.cfg = cfg;
    const u = this.uniforms;
    u.moteBox.value = Math.max(cfg.box, 2);
    u.moteSize.value = cfg.size;
    this.points.geometry.setDrawRange(0, Math.min(MAX, Math.round(cfg.count)));
    this.points.visible = this.enabled && cfg.intensity > 0 && cfg.count > 0;
  }

  /** Player setting: dust motes on / off. */
  setEnabled(v) {
    this.enabled = !!v;
    this.setConfig(this.cfg);
  }

  update(dt) {
    const c = this.cfg, L = this.lighting, w = L.uniforms.windDir.value, u = this.uniforms;
    // a sun-lit speck against the light ~ sunColor x 0.2 (display), x intensity
    u.moteGain.value = 0.12 * c.intensity;
    const k = c.drift * dt * (0.5 + L.uniforms.windStrength.value);
    const d = u.moteDrift.value, B = u.moteBox.value;
    d.set((d.x + w.x * k) % B, (d.y + Math.sin(L.time * 0.13) * 0.04 * dt) % B, (d.z + w.y * k) % B);
  }
}
