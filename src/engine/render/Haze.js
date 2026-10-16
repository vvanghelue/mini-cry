// Atmosphere: a near haze (exponential height fog, the air denser low down: valleys, the sea, the
// beach) on top of the far fog, so mid distances get some air without the horizon going white.
// Both are the scene's fog node (scene.fogNode: every material with `fog` gets it, the water calls
// the same function) and are applied before tone mapping, in the same linear space as the sky: the
// far fog is the sky's horizon colour + its sun glow, so distant silhouettes melt into the sky.
//
//  - haze: extinction `density` (per m) at `base` height, divided by e every `height` m above it,
//    integrated along the ray from `start` m out; its opacity rolls off toward `max` (past it the far
//    fog takes over). Colour: the horizon x `brightness`, + the sun's colour toward the sun
//    (`sun`: forward scattering, the bright veil against the light).
//  - it moves: drifting banks (value noise of size `scale` m, ± `variation` of the density and of
//    the max opacity), sampled around the camera (the air you stand in thickens and clears as you
//    walk) and where the ray ends (hazier / clearer stretches of the landscape), carried by the wind
//    at `drift` m/s, and a slow breathing of the whole density.
//  - time of day: x `morning` at sunrise (lower, ground-hugging mist), x `evening` at dusk, x `night`.
//  - the far fog: `fogDensity` (exp2 of the distance, as three.js's FogExp2).
//  - player settings on top of that look: on / off and a strength (x the optical depth of both),
//    Options menu, F2 → Fog & haze, `?fog=0` / `?fog=<strength>`.
//
// The haze's opacity is computed per vertex (the terrain is a 2 m grid near the camera, 32 m far away,
// where it barely changes across a triangle) and handed over in one float: on a tile GPU every
// varying component is paid per triangle (a vec4 cost ~1 ms of the frame). The far fog and the
// colours are per pixel, from the view position the lit materials pass anyway. Kept cheap: the
// banks are two fetches of a baked tiling noise texture, whatever depends on the camera alone (the
// air around it, the density at its height) is computed on the CPU, the sun glows are powers by
// squaring, and nothing is computed with the fog off.
import * as THREE from 'three/webgpu';
import { Fn, If, float, vec2, vec3, vec4, max, min, abs, exp, length, dot, select, texture, varying, output, cameraPosition, positionWorld, positionView, cameraWorldMatrix } from 'three/tsl';
import { U } from './tsl.js';

// player setting: x the optical depth of the haze and the far fog (Options menu, F2, ?fog=<strength>)
export const FOG_STRENGTH = 0.2;

export const HAZE_DEFAULTS = {
  haze: {
    density: 0.0045, // extinction per m at the base height (~19 % at 50 m)
    height: 40, // m: the density drops by e every `height` m above the base
    base: 0, // m (sea level)
    max: 0.42, // max opacity of the haze (the far fog takes over)
    start: 3, // m: clear around the camera
    brightness: 0.85, // colour = horizon colour x this
    sun: 0.7, // sun-coloured veil toward the sun (x cos^6 of the angle to it)
    variation: 0.5, // drifting banks: ± share of the density
    scale: 160, // m: size of the banks
    drift: 2.5, // m/s along the wind
    morning: 2.2, // density x at sunrise (and a lower mist), back to x1 by mid-morning
    evening: 1.3, // x at dusk
    night: 1.3, // x at night
  },
};

// tiling value noise baked into a small texture (the banks): NOISE_CELLS lattice cells, smoothstep
// between them, NOISE_TEXELS texels a side (linear filtering in between)
const NOISE_CELLS = 32, NOISE_TEXELS = 256;

function bakeNoise() {
  let seed = 0x6d2b79f5;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const C = NOISE_CELLS, N = NOISE_TEXELS, T = N / C;
  const lat = Float32Array.from({ length: C * C }, rnd);
  const at = (i, j) => lat[(j % C) * C + (i % C)];
  const sm = (x) => x * x * (3 - 2 * x);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / T, v = y / T, i = Math.floor(u), j = Math.floor(v), fx = sm(u - i), fy = sm(v - j);
      const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx, b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
      data[(y * N + x) * 4] = Math.round((a + (b - a) * fy) * 255);
    }
  }
  return data;
}

const S = THREE.MathUtils.smoothstep;
const TAU = Math.PI * 2;

export class Haze {
  constructor(lighting) {
    this.lighting = lighting;
    const skyU = lighting.skyU;
    // shared by every material (and the water)
    this.uniforms = {
      hazeA: U(new THREE.Vector4()), // density (time of day, breathing, strength), 1 / height, base, max opacity
      hazeB: U(new THREE.Vector4()), // start (m), far fog density, variation x 1.6, 1 / bank size
      hazeC: U(new THREE.Vector4()), // sun glow, density factor at the camera's height, the banks around the camera
      hazeDrift: U(new THREE.Vector4()), // the two noise octaves' offsets (wind)
      hazeCol: U(new THREE.Color()),
      hazeFogCol: skyU.horizon,
      hazeSunCol: skyU.sunCol,
      hazeSunDir: skyU.sunDir,
      hazeNoise: null,
    };
    const rgba = bakeNoise();
    this.noise = rgba.filter((_, i) => i % 4 === 0);
    const tex = new THREE.DataTexture(rgba, NOISE_TEXELS, NOISE_TEXELS, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.uniforms.hazeNoise = texture(tex);
    this.cfg = structuredClone(HAZE_DEFAULTS.haze);
    this.time = 0;
    this.factor = 1; // time of day multiplier of the density (debug / tools)
    this.enabled = true;
    this.strength = FOG_STRENGTH;
    const p = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('fog') : null;
    if (p !== null) { this.enabled = p !== '0'; if (+p > 0) this.strength = +p; }
    this.vertexFn = this._vertexFn();
    this.fragFn = this._fragFn();
    // the scene's fog: the haze over everything drawn with `fog` (lit materials, decals, the water)
    this.fogNode = this.node();
  }

  /** Player setting: fog (haze + far fog) on / off. */
  setEnabled(v) { this.enabled = !!v; this._apply(); }

  /** Player setting: x the optical depth of the haze and of the far fog (1 = environment.json at full). */
  setStrength(v) { this.strength = Math.max(0, Number(v) || 0); this._apply(); }

  setConfig(env) {
    this.cfg = env.haze;
    this.fogDensity = env.fogDensity;
    this._apply();
  }

  /** Re-light (Lighting.setTimeOfDay): colours + the time of day's mist. light: sun + sky light
   *  now / at noon (the far fog is the sky's horizon, but the near air is lit like the ground). */
  setTimeOfDay(h, night, light = 1) {
    const c = this.cfg;
    const morning = S(h, 4.5, 6.2) * (1 - S(h, 7.5, 10.5)); // sunrise mist, burnt off by mid-morning
    const evening = S(h, 16.5, 18.5) * (1 - S(h, 19.5, 21));
    this.mist = morning;
    this.factor = Math.max(1 + (c.morning - 1) * morning, 1 + (c.evening - 1) * evening, 1 + (c.night - 1) * night);
    this.night = night;
    this.light = light;
    this.uniforms.hazeCol.value.copy(this.lighting.skyU.horizon.value).multiplyScalar(c.brightness * Math.min(light, 1));
    this._apply();
  }

  _apply() {
    const c = this.cfg, u = this.uniforms;
    // a slow breathing of the whole haze (minutes)
    const t = this.time;
    const breath = 1 + Math.min(c.variation, 1) * 0.35 * (0.6 * Math.sin((t * TAU) / 170) + 0.4 * Math.sin((t * TAU) / 67 + 1.3));
    const height = Math.max(c.height * (1 - 0.45 * (this.mist ?? 0)), 1);
    const k = this.enabled ? this.strength : 0;
    // x k optical depth also where the haze is capped: transmittance (1 - max) ^ k
    u.hazeA.value.set(c.density * this.factor * breath * k, 1 / height, c.base, 1 - (1 - Math.min(c.max, 0.95)) ** k);
    // exp2: the density scales the distance, so x sqrt(k) = x k optical depth
    const far = (this.fogDensity ?? 0) * (1 + (this.night ?? 0) * 0.6) * Math.sqrt(k);
    this.farDensity = far;
    const V = c.variation * 1.6, inv = 1 / Math.max(c.scale, 1);
    u.hazeB.value.set(c.start, far, V, inv);
    // what depends on the camera alone: the density at its height, the banks around it
    const cam = this.lighting.camera.position, dr = u.hazeDrift.value;
    const x = (cam.x * inv) / NOISE_CELLS, z = (cam.z * inv) / NOISE_CELLS;
    const n = this._noise(x + dr.x, z + dr.y) * 0.65 + this._noise(x * 2.3 + dr.z, z * 2.3 + dr.w) * 0.35 - 0.5;
    u.hazeC.value.set(c.sun, Math.exp(-Math.max(cam.y - c.base, -30) / height), V * n, 0);
  }

  /** The noise texture as the GPU filters it (uv in texture repeats). */
  _noise(u, v) {
    const N = NOISE_TEXELS, x = u * N - 0.5, y = v * N - 0.5, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const at = (a, b) => this.noise[(((b % N) + N) % N) * N + (((a % N) + N) % N)] / 255;
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx, b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return a + (b - a) * fy;
  }

  /** Drift the banks with the wind, breathe. */
  update(dt) {
    this.time += dt;
    const c = this.cfg, w = this.lighting.uniforms.windDir.value, k = (c.drift * dt) / Math.max(c.scale, 1) / NOISE_CELLS;
    const d = this.uniforms.hazeDrift.value;
    // in texture repeats (the noise tiles every one); the fine octave drifts a little faster and
    // across: the banks change shape as they move
    d.x = (d.x - w.x * k) % 1;
    d.y = (d.y - w.y * k) % 1;
    d.z = (d.z - (w.x * 1.6 - w.y * 0.5) * k * 2.3) % 1;
    d.w = (d.w - (w.y * 1.6 + w.x * 0.5) * k * 2.3) % 1;
    this._apply();
  }

  /** Vertex stage: fn(rel = camera -> vertex, world) -> the haze's opacity. */
  _vertexFn() {
    const u = this.uniforms;
    return Fn(([rel]) => {
      const out = float(0.0).toVar();
      If(u.hazeA.x.greaterThan(0.0), () => {
        const d = length(rel).toVar();
        const rd = rel.div(max(d, 1e-4)).toVar();
        // drifting banks where the ray ends (hazier / clearer stretches of the landscape); those around
        // the camera (the air you stand in) come from the CPU: hazeC.z
        const q = cameraPosition.xz.add(rd.xz.mul(min(d, 2000.0))).mul(u.hazeB.w.mul(1 / NOISE_CELLS)).toVar();
        const n = u.hazeNoise.sample(q.add(u.hazeDrift.xy)).level(0).r.mul(0.65).add(u.hazeNoise.sample(q.mul(2.3).add(u.hazeDrift.zw)).level(0).r.mul(0.35)).sub(0.5).toVar();
        const dens = u.hazeA.x.mul(max(float(1.0).add(u.hazeC.z).add(u.hazeB.z.mul(n)), 0.0));
        const mx = min(u.hazeA.w.mul(max(float(1.0).add(u.hazeB.z.mul(1.4).mul(n)), 0.2)), 0.95).toVar();
        // exponential height fog integrated along the ray, past the start distance (hazeC.y: the
        // density factor at the camera's height)
        const t = max(d.sub(u.hazeB.x), 0.0);
        const k = max(u.hazeA.y.mul(rd.y).mul(t), -20.0).toVar();
        const od = dens.mul(u.hazeC.y).mul(t).mul(select(abs(k).greaterThan(1e-3), float(1.0).sub(exp(k.negate())).div(k), float(1.0).sub(k.mul(0.5))));
        out.assign(mx.mul(float(1.0).sub(exp(od.negate().div(max(mx, 1e-3))))));
      });
      return out;
    });
  }

  /** Fragment: fn(rel = camera -> point, world; haze opacity) -> vec4(light scattered in,
   *  transmittance): the haze + the far fog, coloured toward the sun, per pixel. */
  _fragFn() {
    const u = this.uniforms;
    return Fn(([rel, vHaze]) => {
      const res = vec4(0.0, 0.0, 0.0, 1.0).toVar();
      If(u.hazeA.x.greaterThan(0.0).or(u.hazeB.y.greaterThan(0.0)), () => {
        const d = length(rel).toVar();
        const fd = u.hazeB.y.mul(d);
        const far = float(1.0).sub(exp(fd.mul(fd).negate())).toVar();
        // colours: the far fog is the sky at the horizon (Lighting.js sky: horizon + the sun's glow,
        // cos^8 and cos^90), the haze's glow cos^6
        const s1 = max(dot(rel, u.hazeSunDir).div(max(d, 1e-4)), 0.0);
        const s2 = s1.mul(s1), s4 = s2.mul(s2), s6 = s4.mul(s2), s8 = s4.mul(s4), s16 = s8.mul(s8), s32 = s16.mul(s16), s64 = s32.mul(s32);
        const fogC = u.hazeFogCol.add(u.hazeSunCol.mul(s8.mul(0.18).add(s64.mul(s16).mul(s8).mul(s2).mul(0.5))));
        const hzC = u.hazeCol.add(u.hazeSunCol.mul(u.hazeC.x.mul(s6)));
        res.assign(vec4(hzC.mul(vHaze.mul(far.oneMinus())).add(fogC.mul(far)), vHaze.oneMinus().mul(far.oneMinus())));
      });
      return res;
    });
  }

  /** Camera -> fragment (world), from the view position the lit materials already pass. */
  relFrag() { return cameraWorldMatrix.mul(vec4(positionView, 0.0)).xyz; }

  /** The fog node: output.rgb x transmittance + scattered light. */
  node() {
    return Fn(() => {
      const vHaze = varying(this.vertexFn(positionWorld.sub(cameraPosition)), 'vHaze');
      const hz = this.fragFn(this.relFrag(), vHaze);
      return vec4(output.rgb.mul(hz.a).add(hz.rgb), output.a);
    })();
  }
}

export { vec2, vec3 };
