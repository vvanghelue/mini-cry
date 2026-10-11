// Light halos (coronas) around lamps, fires and beacons: every asset part with a `glow`
// (docs/ASSETS.md) on a static prop gets a camera-facing additive sprite, all of them in one draw
// call (FX layer: no shadow, no SSAO). They fade in at dusk (a share stays by day: `day`),
// flicker (fires) or blink (beacons), keep a minimum size on screen so distant lights still read
// as points, and go through the fog better than the geometry. Strength / distance:
// environment.json `glows`.
//
// Occlusion is decided for the light, not per pixel of its halo (a halo depth-tested pixel by
// pixel gets cut by the ground in front of a campfire): within the SSAO range the vertex shader
// reads the SSAO pass's half-res view depth (SSAO.js, already rendered this frame) at five points
// around the light and fades the whole sprite by the share that sees it, then draws it over
// everything. Farther (or with SSAO off) the sprite, pulled toward the camera by its radius so the
// lamp itself doesn't cut it, is depth tested as usual: it is only a few pixels wide there.
import * as THREE from 'three';
import { LAYERS } from './layers.js';

const VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 glow; // rgb x intensity, radius (m)
attribute vec4 anim; // flicker, blink period (s, 0 = steady), share kept by day, phase
uniform float uTime, glowNight, glowGain, glowFog, glowMaxDist, glowMinAngle;
uniform sampler2D aoTex; // SSAO: g = view depth (m), half res
uniform vec2 aoSize;
uniform float aoEnabled, aoFar;
varying vec2 vUv;
varying vec3 vCol;
float seen(vec2 px, float z) {
  return step(z, texelFetch(aoTex, ivec2(clamp(px, vec2(0.0), aoSize - 1.0)), 0).g);
}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = length(mv.xyz), r = glow.w, vz = -mv.z;
  float vis = 1.0;
  bool byDepth = aoEnabled > 0.5 && vz > 0.0 && vz < aoFar;
  if (byDepth) {
    vec4 c = projectionMatrix * mv;
    vec2 px = (c.xy / c.w * 0.5 + 0.5) * aoSize;
    float o = max(1.0, r * 0.2 * projectionMatrix[1][1] * aoSize.y * 0.5 / vz); // a fifth of the radius, in texels
    float z = vz - max(r * 0.5, 0.3); // the lamp's own shade / glass doesn't hide it
    vis = (seen(px, z) + seen(px + vec2(o, 0.0), z) + seen(px - vec2(o, 0.0), z) + seen(px + vec2(0.0, o), z) + seen(px - vec2(0.0, o), z)) * 0.2;
  }
  float size = max(r, dist * glowMinAngle); // a few pixels at least: distant lights stay visible
  mv.xyz *= max(dist - min(r, dist * 0.5), 0.05) / dist;
  mv.xy += corner * size;
  gl_Position = projectionMatrix * mv;
  if (byDepth) gl_Position.z = -gl_Position.w * 0.9999; // visibility decided above: no depth cut
  vUv = corner;
  float t = uTime + anim.w * 37.0;
  float flick = 1.0 + anim.x * (0.5 * sin(t * 11.0) + 0.3 * sin(t * 23.7 + 1.3) + 0.2 * sin(t * 41.0 + 2.1));
  float ph = anim.y > 0.0 ? fract(t / anim.y) : 0.2;
  float blink = smoothstep(0.0, 0.04, ph) * (1.0 - smoothstep(0.4, 0.46, ph));
  float fog = exp(-glowFog * glowFog * dist * dist);
  float fade = sqrt(fog) * (1.0 - smoothstep(glowMaxDist * 0.7, glowMaxDist, dist));
  vCol = glow.rgb * glowGain * mix(anim.z, 1.0, glowNight) * flick * blink * fade * vis * sqrt(r / size);
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float d2 = dot(vUv, vUv);
  float a = max(exp(-d2 * 3.0) - 0.0498, 0.0) * 0.8 + exp(-d2 * 40.0); // halo (0 at the rim) + hot core
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

const S = THREE.MathUtils.smoothstep;
const _p = new THREE.Vector3();

export class Glows {
  constructor(lighting) {
    this.lighting = lighting;
    this.count = 0;
    const ao = lighting.ao.uniforms;
    this.uniforms = {
      uTime: lighting.uniforms.uTime,
      aoTex: ao.aoTex, aoSize: ao.aoSize, aoEnabled: ao.aoEnabled, aoFar: ao.aoFar,
      glowNight: { value: 0 },
      glowGain: { value: 1 },
      glowFog: { value: 0 },
      glowMaxDist: { value: 600 },
      glowMinAngle: { value: 0.005 },
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
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'Glows';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYERS.FX);
    this.mesh.visible = false;
    this.mesh.onBeforeRender = () => this._sync();
  }

  /**
   * Replace every halo. list: [{ pos: [x, y, z] (world), size (radius m), color: [r, g, b]
   * (display), intensity, flicker, blink (s), day }]
   */
  set(list) {
    const n = (this.count = list.length);
    const pos = new Float32Array(n * 12), corner = new Float32Array(n * 8), glow = new Float32Array(n * 16), anim = new Float32Array(n * 16);
    const idx = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);
    list.forEach((g, i) => {
      const k = g.intensity ?? 1, c = g.color;
      const phase = Math.abs(Math.sin(g.pos[0] * 12.9898 + g.pos[2] * 78.233)) % 1; // lights don't pulse in sync
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([x, y], j) => {
        const v = i * 4 + j;
        pos.set(g.pos, v * 3);
        corner.set([x, y], v * 2);
        glow.set([c[0] * k, c[1] * k, c[2] * k, g.size], v * 4);
        anim.set([g.flicker ?? 0, g.blink ?? 0, g.day ?? 0, phase], v * 4);
      });
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('glow', new THREE.BufferAttribute(glow, 4));
    geo.setAttribute('anim', new THREE.BufferAttribute(anim, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.mesh.visible = n > 0;
  }

  /** Glows of an asset build (asset space) placed with a matrix, appended to `out`. */
  static place(glows, matrix, out) {
    const s = matrix.getMaxScaleOnAxis();
    for (const g of glows ?? []) out.push({ ...g, pos: _p.fromArray(g.pos).applyMatrix4(matrix).toArray(), size: g.size * s });
    return out;
  }

  _sync() {
    const L = this.lighting, env = L.env.glows, u = this.uniforms;
    u.glowNight.value = S(L.night, 0.15, 0.75);
    u.glowGain.value = env.intensity;
    u.glowMaxDist.value = env.distance;
    u.glowFog.value = L.scene.fog?.density ?? 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
