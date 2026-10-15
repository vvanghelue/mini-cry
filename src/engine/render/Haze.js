// Atmosphere: a near haze (exponential height fog, the air denser low down: valleys, the sea, the
// beach) on top of the far fog, so mid distances get some air without the horizon going white.
// Both are computed per vertex in every lit material (Lighting.patch replaces three.js's fog
// chunks, the water shader calls the same function) and applied before tone mapping, in the same
// linear space as the sky: the far fog is the sky's horizon colour + its sun glow, so distant
// silhouettes melt into the sky.
//
//  - haze: extinction `density` (per m) at `base` height, divided by e every `height` m above it,
//    integrated along the ray from `start` m out; its opacity rolls off toward `max` (past it the far
//    fog takes over). Colour: the horizon x `brightness`, + the sun's colour toward the sun
//    (`sun`, `sunPower`: forward scattering, the bright veil against the light).
//  - it moves: drifting banks (value noise of size `scale` m, ± `variation` of the density and of
//    the max opacity), sampled around the camera (the air you stand in thickens and clears as you
//    walk) and where the ray ends (hazier / clearer stretches of the landscape), carried by the wind
//    at `drift` m/s, and a slow breathing of the whole density.
//  - time of day: x `morning` at sunrise (lower, ground-hugging mist), x `evening` at dusk, x `night`.
//  - the far fog: `fogDensity` (exp2 of the distance, as three.js's FogExp2).
//  - player settings on top of that look: on / off and a strength (x the optical depth of both),
//    Options menu, F2 → Fog & haze, `?fog=0` / `?fog=<strength>`.
//
// Per vertex: one varying, ~free on the GPU (the fragment does one multiply-add). The terrain is a
// 2 m grid near the camera (32 m far away, where the fog barely changes across a triangle).
import * as THREE from 'three';

export const HAZE_DEFAULTS = {
  haze: {
    density: 0.0045, // extinction per m at the base height (~19 % at 50 m)
    height: 40, // m: the density drops by e every `height` m above the base
    base: 0, // m (sea level)
    max: 0.42, // max opacity of the haze (the far fog takes over)
    start: 3, // m: clear around the camera
    brightness: 0.85, // colour = horizon colour x this
    sun: 0.7, // sun-coloured veil toward the sun
    sunPower: 6,
    variation: 0.5, // drifting banks: ± share of the density
    scale: 160, // m: size of the banks
    drift: 2.5, // m/s along the wind
    morning: 2.2, // density x at sunrise (and a lower mist), back to x1 by mid-morning
    evening: 1.3, // x at dusk
    night: 1.3, // x at night
  },
};

/** Vertex code: `hazeVertex(mvPosition.xyz)` fills vHaze (rgb: light scattered in, a: transmittance). */
export const HAZE_VERT_GLSL = /* glsl */ `
uniform vec4 hazeA; // density (time of day, breathing), 1 / height, base, max opacity
uniform vec4 hazeB; // start (m), far fog density, variation, 1 / bank size
uniform vec4 hazeDrift; // the two noise octaves' offsets (wind)
uniform vec3 hazeCol, hazeFogCol, hazeSunCol, hazeSunDir;
uniform vec2 hazeSun; // strength, power
varying vec4 vHaze;
float hazeHash(vec2 p) { vec3 q = fract(p.xyx * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float hazeNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hazeHash(i), hazeHash(i + vec2(1.0, 0.0)), f.x), mix(hazeHash(i + vec2(0.0, 1.0)), hazeHash(i + 1.0), f.x), f.y);
}
void hazeVertex(vec3 mv) {
  vec3 rel = (vec4(mv, 0.0) * viewMatrix).xyz; // camera -> vertex, world space
  float d = length(rel);
  vec3 rd = rel / max(d, 1e-4);
  // drifting banks: the air around the camera (sampled part way along the ray, ~100 m out at
  // most) and at the vertex (far away: hazier and clearer stretches of the landscape)
  vec2 qn = (cameraPosition.xz + rd.xz * (min(d, 160.0) * 0.6)) * hazeB.w;
  vec2 qf = (cameraPosition.xz + rd.xz * min(d, 2000.0)) * hazeB.w;
  float nn = hazeNoise(qn + hazeDrift.xy) * 0.65 + hazeNoise(qn * 2.3 + hazeDrift.zw) * 0.35;
  float nf = hazeNoise(qf + hazeDrift.xy) * 0.65 + hazeNoise(qf * 2.3 + hazeDrift.zw) * 0.35;
  float v = hazeB.z * 1.6;
  float dens = hazeA.x * max(1.0 + v * (nn + nf - 1.0), 0.0);
  float mx = min(hazeA.w * max(1.0 + v * 0.7 * (nf * 2.0 - 1.0), 0.2), 0.95);
  // exponential height fog integrated along the ray, past the start distance
  float s = min(d, hazeB.x), t = d - s;
  float y0 = cameraPosition.y + rd.y * s - hazeA.z;
  float k = max(hazeA.y * rd.y * t, -20.0);
  float od = dens * exp(-hazeA.y * max(y0, -30.0)) * t * (abs(k) > 1e-3 ? (1.0 - exp(-k)) / k : 1.0 - 0.5 * k);
  float haze = mx * (1.0 - exp(-od / max(mx, 1e-3)));
  float far = 1.0 - exp(-hazeB.y * hazeB.y * d * d);
  // colours: the far fog is the sky at the horizon (Lighting.js sky: horizon + the sun's glow)
  float sd = max(dot(rd, hazeSunDir), 0.0);
  float s2 = sd * sd, s8 = s2 * s2; s8 *= s8;
  vec3 fogC = hazeFogCol + hazeSunCol * (s8 * 0.18 + pow(sd, 90.0) * 0.5);
  vec3 hzC = hazeCol + hazeSunCol * (hazeSun.x * pow(sd, hazeSun.y));
  vHaze = vec4(hzC * (haze * (1.0 - far)) + fogC * far, (1.0 - haze) * (1.0 - far));
}
`;

const S = THREE.MathUtils.smoothstep;
const TAU = Math.PI * 2;

export class Haze {
  constructor(lighting) {
    this.lighting = lighting;
    const skyU = lighting.skyU;
    // shared by every patched material (and the water)
    this.uniforms = {
      hazeA: { value: new THREE.Vector4() },
      hazeB: { value: new THREE.Vector4() },
      hazeDrift: { value: new THREE.Vector4() },
      hazeCol: { value: new THREE.Color() },
      hazeFogCol: skyU.horizon,
      hazeSunCol: skyU.sunCol,
      hazeSunDir: skyU.sunDir,
      hazeSun: { value: new THREE.Vector2() },
    };
    this.cfg = structuredClone(HAZE_DEFAULTS.haze);
    this.time = 0;
    this.factor = 1; // time of day multiplier of the density (debug / tools)
    this.enabled = true;
    this.strength = 1;
    const p = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('fog') : null;
    if (p !== null) { this.enabled = p !== '0'; if (+p > 0) this.strength = +p; }
  }

  /** Player setting: fog (haze + far fog) on / off. */
  setEnabled(v) { this.enabled = !!v; this._apply(); }

  /** Player setting: x the optical depth of the haze and of the far fog (1 = the environment's look). */
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
    u.hazeB.value.set(c.start, far, c.variation, 1 / Math.max(c.scale, 1));
    u.hazeSun.value.set(c.sun, c.sunPower);
    // the few unpatched materials (tracers) and the light halos' fade read three.js's fog
    if (this.lighting.scene.fog) this.lighting.scene.fog.density = far;
  }

  /** Drift the banks with the wind, breathe. */
  update(dt) {
    this.time += dt;
    const c = this.cfg, w = this.lighting.uniforms.windDir.value, k = (c.drift * dt) / Math.max(c.scale, 1);
    const d = this.uniforms.hazeDrift.value;
    // the fine octave drifts a little faster and across: the banks change shape as they move (no
    // wrap: the noise isn't periodic; a whole day of play stays in the thousands, fine in float32)
    d.x -= w.x * k;
    d.y -= w.y * k;
    d.z -= (w.x * 1.6 - w.y * 0.5) * k * 2.3;
    d.w -= (w.y * 1.6 + w.x * 0.5) * k * 2.3;
    this._apply();
  }

  /** Replace three.js's fog with the haze in a material's shader (onBeforeCompile). */
  inject(sh) {
    Object.assign(sh.uniforms, this.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <fog_pars_vertex>', `#ifdef USE_FOG\n${HAZE_VERT_GLSL}\n#endif`)
      .replace('#include <fog_vertex>', '#ifdef USE_FOG\nhazeVertex(mvPosition.xyz);\n#endif');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <fog_pars_fragment>', '#ifdef USE_FOG\nvarying vec4 vHaze;\n#endif')
      .replace('#include <fog_fragment>', '')
      // linear, before tone mapping (the sky's space)
      .replace('#include <tonemapping_fragment>', '#ifdef USE_FOG\ngl_FragColor.rgb = gl_FragColor.rgb * vHaze.a + vHaze.rgb;\n#endif\n#include <tonemapping_fragment>');
  }

  /** The haze on an unlit (MeshBasic) material, e.g. decals. */
  patch(mat) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => { prev?.call(mat, sh, r); this.inject(sh); };
    const pk = mat.customProgramCacheKey?.bind(mat);
    mat.customProgramCacheKey = () => (pk ? pk() : '') + '|haze';
    mat.needsUpdate = true;
    return mat;
  }
}
