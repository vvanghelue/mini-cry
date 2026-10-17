// Light halos (coronas) around lamps, fires and beacons: every asset part with a `glow`
// (docs/ASSETS.md) on a static prop gets a camera-facing additive sprite, all of them in one draw
// call (FX layer: no shadow, no SSAO). They fade in at dusk (a share stays by day: `day`),
// flicker (fires) or blink (beacons), keep a minimum size on screen so distant lights still read
// as points, and go through the fog better than the geometry. Strength / distance:
// environment.json `glows`.
//
// Occlusion is decided for the light, not per pixel of its halo (a halo depth-tested pixel by
// pixel gets cut by the ground in front of a campfire): within the SSAO range the vertex stage
// reads the SSAO pass's half-res view depth (SSAO.js, already rendered this frame) at five points
// around the light and fades the whole sprite by the share that sees it, then draws it over
// everything. Farther (or with SSAO off) the sprite, pulled toward the camera by its radius so the
// lamp itself doesn't cut it, is depth tested as usual: it is only a few pixels wide there.
import * as THREE from 'three/webgpu';
import { Fn, float, ivec2, vec2, vec4, max, min, exp, sin, fract, sqrt, length, mix, smoothstep, step, select, clamp, attribute, varying, varyingProperty, modelViewMatrix, cameraProjectionMatrix, positionLocal, dot } from 'three/tsl';
import { LAYERS } from './layers.js';
import { U } from './tsl.js';

const S = THREE.MathUtils.smoothstep;
const _p = new THREE.Vector3();

export class Glows {
  constructor(lighting) {
    this.lighting = lighting;
    this.count = 0;
    const ao = lighting.ao.uniforms;
    const u = (this.uniforms = {
      uTime: lighting.uniforms.uTime,
      glowNight: U(0),
      glowGain: U(1),
      glowFog: U(0),
      glowMaxDist: U(600),
      glowMinAngle: U(0.005),
    });
    const corner = attribute('corner', 'vec2'), glow = attribute('glow', 'vec4'), anim = attribute('anim', 'vec4');
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    m.toneMapped = false;
    m.mcRawOutput = true; // written as is, like the WebGL shader (no sRGB encoding)
    m.lights = false;
    const seen = (px, z) => step(z, ao.aoTex.load(ivec2(clamp(px, vec2(0.0), ao.aoSize.sub(1.0)))).g);
    const vCol = varyingProperty('vec3', 'vGlowCol');
    m.vertexNode = Fn(() => {
      const mv = modelViewMatrix.mul(vec4(positionLocal, 1.0)).toVar();
      const dist = length(mv.xyz).toVar(), r = glow.w, vz = mv.z.negate();
      const vis = float(1.0).toVar();
      const byDepth = ao.aoEnabled.greaterThan(0.5).and(vz.greaterThan(0.0)).and(vz.lessThan(ao.aoFar)).toVar();
      const c = cameraProjectionMatrix.mul(mv);
      // pixel of the light in the half-res AO buffer (rows run down)
      const ndc = c.xy.div(c.w);
      const px = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)).mul(ao.aoSize).toVar();
      const o = max(1.0, r.mul(0.2).mul(cameraProjectionMatrix.element(1).y).mul(ao.aoSize.y).mul(0.5).div(vz)); // a fifth of the radius, in texels
      const z = vz.sub(max(r.mul(0.5), 0.3)); // the lamp's own shade / glass doesn't hide it
      const v5 = seen(px, z).add(seen(px.add(vec2(o, 0.0)), z)).add(seen(px.sub(vec2(o, 0.0)), z)).add(seen(px.add(vec2(0.0, o)), z)).add(seen(px.sub(vec2(0.0, o)), z)).mul(0.2);
      vis.assign(select(byDepth, v5, float(1.0)));
      const size = max(r, dist.mul(u.glowMinAngle)).toVar(); // a few pixels at least: distant lights stay visible
      mv.xyz.mulAssign(max(dist.sub(min(r, dist.mul(0.5))), 0.05).div(dist));
      mv.xy.addAssign(corner.mul(size));
      const pos = cameraProjectionMatrix.mul(mv).toVar();
      // visibility decided above: no depth cut (just in front of the near plane)
      pos.z.assign(select(byDepth, pos.w.mul(0.0001), pos.z));
      const t = u.uTime.add(anim.w.mul(37.0));
      const flick = float(1.0).add(anim.x.mul(sin(t.mul(11.0)).mul(0.5).add(sin(t.mul(23.7).add(1.3)).mul(0.3)).add(sin(t.mul(41.0).add(2.1)).mul(0.2))));
      const ph = select(anim.y.greaterThan(0.0), fract(t.div(max(anim.y, 1e-3))), float(0.2));
      const blink = smoothstep(0.0, 0.04, ph).mul(float(1.0).sub(smoothstep(0.4, 0.46, ph)));
      const fog = exp(u.glowFog.mul(u.glowFog).mul(dist).mul(dist).negate());
      const fade = sqrt(fog).mul(float(1.0).sub(smoothstep(u.glowMaxDist.mul(0.7), u.glowMaxDist, dist)));
      vCol.assign(glow.rgb.mul(u.glowGain).mul(mix(anim.z, 1.0, u.glowNight)).mul(flick).mul(blink).mul(fade).mul(vis).mul(sqrt(r.div(size))));
      return pos;
    })();
    m.colorNode = Fn(() => {
      const uv = varying(corner, 'vGlowUv');
      const d2 = dot(uv, uv);
      const a = max(exp(d2.mul(-3.0)).sub(0.0498), 0.0).mul(0.8).add(exp(d2.mul(-40.0))); // halo (0 at the rim) + hot core
      return vec4(vCol.mul(a), 1.0);
    })();
    this.material = m;
    // a stand-in with the attributes of set()'s geometry (WebGPU: the shader is built for the
    // attributes of the first geometry it is drawn with)
    this.mesh = new THREE.Mesh(this._geometry(0), this.material);
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
    this.mesh.geometry.dispose();
    this.mesh.geometry = this._geometry(n, pos, corner, glow, anim, idx);
    this.mesh.visible = n > 0;
  }

  _geometry(n, pos, corner, glow, anim, idx) {
    const m = Math.max(n, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos ?? new Float32Array(m * 12), 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(corner ?? new Float32Array(m * 8), 2));
    geo.setAttribute('glow', new THREE.BufferAttribute(glow ?? new Float32Array(m * 16), 4));
    geo.setAttribute('anim', new THREE.BufferAttribute(anim ?? new Float32Array(m * 16), 4));
    geo.setIndex(new THREE.BufferAttribute(idx ?? new Uint16Array(m * 6), 1));
    return geo;
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
    u.glowFog.value = L.haze.farDensity ?? 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
