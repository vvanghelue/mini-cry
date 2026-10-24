// Dust motes: specks floating in the air around the camera, drifting with the wind and wandering a
// little, lit by the sun only where it really shines (the vertex stage reads the sun cascades:
// they show in the beams through the canopy, not in the shade), much brighter against the light
// (forward scattering). One draw of additive sprites (instanced quads: WebGPU points are 1 px; FX
// layer: no shadow, no SSAO), wrapped in a box that follows the camera. Strength, count, size, box,
// drift: environment.json `motes`; on / off: player setting (Options menu, F2, `?motes=0`).
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, max, min, sin, mod, dot, length, smoothstep, select, attribute, varyingProperty, varying, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, positionGeometry } from 'three/tsl';
import { LAYERS } from './layers.js';
import { U } from './tsl.js';

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

export class Motes {
  constructor(lighting) {
    this.lighting = lighting;
    this.cfg = structuredClone(MOTES_DEFAULTS.motes);
    this.enabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('motes') !== '0';
    const seed = new Float32Array(MAX * 4);
    let s = 0x2f6b1d;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < seed.length; i++) seed[i] = rnd();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.instanceCount = 0;
    this.geometry = geo;
    const sun = lighting.sun;
    const u = (this.uniforms = {
      uTime: lighting.uniforms.uTime,
      moteBox: U(16),
      moteSize: U(0.012),
      moteGain: U(0),
      moteViewH: U(900),
      moteDrift: U(new THREE.Vector3()),
    });
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    m.toneMapped = false;
    m.mcRawOutput = true; // written as is, like the WebGL shader (no sRGB encoding)
    m.lights = false;
    const vCol = varyingProperty('vec3', 'vMoteCol'), shadow = sun.shadowVertexFn();
    m.vertexNode = Fn(() => {
      const sd = attribute('seed', 'vec4');
      const B = u.moteBox;
      const p = sd.xyz.mul(B).add(u.moteDrift).toVar();
      const t = u.uTime.mul(sd.w.mul(0.25).add(0.2)).add(sd.w.mul(61.0));
      p.addAssign(vec3(sin(t.mul(1.3).add(sd.x.mul(17.0))), sin(t.mul(0.7).add(sd.y.mul(13.0))).mul(0.5), sin(t.mul(1.1).add(sd.z.mul(11.0)).add(1.6))).mul(0.35));
      p.assign(cameraPosition.add(mod(p.sub(cameraPosition).add(B.mul(0.5)), B)).sub(B.mul(0.5))); // wrapped around the camera
      const mv = cameraViewMatrix.mul(vec4(p, 1.0)).toVar();
      const d = length(mv.xyz).toVar();
      const fwd = max(dot(p.sub(cameraPosition).div(max(d, 1e-3)), sun.uniforms.sunDirW), 0.0);
      const f2 = fwd.mul(fwd), f4 = f2.mul(f2), f8 = f4.mul(f4);
      const phase = float(0.12).add(f2.mul(0.4)).add(f8.mul(2.4));
      const fade = smoothstep(0.5, 1.5, d).mul(float(1.0).sub(smoothstep(B.mul(0.3), B.mul(0.5), d)));
      const px = u.moteSize.mul(cameraProjectionMatrix.element(1).y).mul(u.moteViewH).mul(0.5).div(max(d, 0.1)).toVar();
      const sz = max(px, 1.5);
      const twinkle = sin(u.uTime.mul(sd.w.mul(3.0).add(1.5)).add(sd.x.mul(40.0))).mul(0.45).add(0.55);
      const k = fade.mul(phase).mul(twinkle).mul(u.moteGain).mul(min(1.0, px.mul(px).div(sz.mul(sz)))).toVar();
      vCol.assign(sun.uniforms.sunColor.mul(k.mul(shadow(p))));
      const c = cameraProjectionMatrix.mul(mv).toVar();
      // a quad of sz pixels around the point
      c.xy.addAssign(positionGeometry.xy.mul(sz).div(vec2(u.moteViewH.mul(cameraProjectionMatrix.element(1).y.div(cameraProjectionMatrix.element(0).x)), u.moteViewH)).mul(c.w));
      // invisible: culled
      return select(k.lessThan(1e-3).or(mv.z.greaterThan(-0.1)), vec4(0.0, 0.0, 2.0, 1.0), c);
    })();
    const vUv = varying(positionGeometry.xy, 'vMoteUv');
    m.colorNode = Fn(() => {
      const a = max(float(1.0).sub(dot(vUv, vUv)), 0.0);
      return vec4(vCol.mul(a.mul(a)), 1.0);
    })();
    this.material = m;
    this.points = new THREE.Mesh(geo, m);
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
    this.geometry.instanceCount = Math.min(MAX, Math.round(cfg.count));
    this.points.visible = this.enabled && cfg.intensity > 0 && cfg.count > 0;
    // WebGL backend (VR): the vertex stage can't read the cascades' depth textures: out of the scene
    if (this.lighting.renderer.backend?.isWebGLBackend) this.points.removeFromParent();
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
