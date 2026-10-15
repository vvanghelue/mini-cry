// Lighting & atmosphere: time of day (sun / moon arc), sky dome with clouds, hemisphere ambient
// (replaced by baked probe GI where gi/probes.* exists, see GI.js), auto exposure, cascaded sun
// shadows, half-res SSAO, water reflections (SSR.js), sun lens flare (LensFlare.js), fog,
// wind, and the shared material factory (render/WorldMaterial.js: textured PBR sampling the texture
// arrays of Surfaces.js, or plain Lambert, lit by the sun, the probes and the SSAO).
//
// Everything is driven by an "environment" object (public/data/environment.json, editable in the
// editor's Environment panel): call setEnvironment(env) and update(dt) every frame.
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, vec3, vec4, float, normalize, dot, max, min, mix, pow, smoothstep, length, fract, floor, varying, positionLocal, cameraProjectionMatrix, cameraViewMatrix, renderGroup,
} from 'three/tsl';
import { SunShadows } from './SunShadows.js';
import { SSAO } from './SSAO.js';
import { SSR, SSR_DEFAULTS } from './SSR.js';
import { GI, GI_DEFAULTS } from './GI.js';
import { LAYERS } from './layers.js';
import { LensFlare, FLARE_DEFAULTS } from './LensFlare.js';
import { skyClouds } from './clouds.js';
import { Surfaces } from './Surfaces.js';
import { exposure as exposureU, fogColor as fogColorU, fogDensity as fogDensityU } from './Output.js';
import { WorldStandardMaterial, WorldLambertMaterial, setupWorldNodes, convertMaterial } from './WorldMaterial.js';

// ao: SSAO samples per pixel (0 = off)
export const QUALITY = {
  // near / mid / far sun cascades: the near one every other frame (every frame while the camera
  // moves fast, SunShadows.js), the mid one every 4 frames, the far one every 8: cascade i renders
  // when (frame + i) % every == 0, so the mid and far ones never render together. shadowDistance:
  // shadows fade out over its last 20 % (lowered to where the trees turn into impostors); the far
  // cascade spans ~0.75 of it to each side so the whole fade ring in view is covered.
  low: { dpr: 0.75, cascades: [{ radius: 22, res: 1024, every: 2 }, { radius: 55, res: 1024, every: 4 }, { radius: 90, res: 1024, every: 8 }], shadowDistance: 110, drawScale: 0.65, grass: 0.5, ao: 6 },
  medium: { dpr: 1, cascades: [{ radius: 22, res: 2048, every: 2 }, { radius: 55, res: 1536, every: 4 }, { radius: 105, res: 1024, every: 8 }], shadowDistance: 140, drawScale: 0.8, grass: 0.8, ao: 8 },
  high: { dpr: 1, cascades: [{ radius: 20, res: 2048, every: 1 }, { radius: 60, res: 2048, every: 2 }, { radius: 130, res: 2048, every: 4 }], shadowDistance: 180, drawScale: 1, grass: 1, ao: 12 },
  ultra: { dpr: 2, cascades: [{ radius: 20, res: 4096, every: 1 }, { radius: 70, res: 4096, every: 1 }, { radius: 160, res: 4096, every: 2 }], shadowDistance: 220, drawScale: 1.25, grass: 1.3, ao: 12 },
};

export const DEFAULT_ENV = {
  timeOfDay: 10,
  dayLengthMinutes: 40,
  sunTilt: 0.45,
  sunIntensity: 2.8,
  moonIntensity: 0.4,
  ambient: 2.3,
  exposure: 1.0,
  nightExposure: 1.6,
  fogDensity: 0.0014,
  foliageTransmission: 0.3, // light through the leaves on the shaded side of crowns
  wind: { strength: 0.35, speed: 1.3, dir: [0.8, 0.6] },
  clouds: { coverage: 0.45, speed: 3, scale: 1 },
  // SSAO: strength, occluder range (m), share applied to the sun (0 = ambient only), fade-out distance (m)
  ao: { intensity: 3.5, radius: 1.5, direct: 0.3, distance: 80 },
  sky: {
    dayZenith: '#2d6ed8', dayHorizon: '#b4dcf5',
    sunsetZenith: '#3b4f8a', sunsetHorizon: '#f5a066',
    nightZenith: '#03060f', nightHorizon: '#0d1626',
    ground: '#5b4a2e',
  },
  ocean: { shallow: '#3ee6d2', deep: '#0b4c86', foam: '#f4fbff', murk: 0.08 },
  river: { shallow: '#6f9a6a', deep: '#21402c' },
  // light halos around lamps / fires (Glows.js): strength, distance (m) past which they fade out
  glows: { intensity: 1, distance: 600 },
  // textured PBR materials: sky reflections (x the probe sky visibility), normal map strength,
  // texture detail (0 = plain vertex colours)
  surface: { skySpecular: 1, normalScale: 1, detail: 1 },
  ...structuredClone(GI_DEFAULTS),
  ...structuredClone(FLARE_DEFAULTS),
  ...structuredClone(SSR_DEFAULTS),
};

const S = THREE.MathUtils.smoothstep;
const col = (hex) => new THREE.Color(hex);
const g = (n) => n.setGroup(renderGroup);

export class Lighting {
  constructor(renderer, scene, camera, { quality = 'medium' } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.qualityName = QUALITY[quality] ? quality : 'medium';
    this.Q = QUALITY[this.qualityName];
    this.env = structuredClone(DEFAULT_ENV);
    this.time = 0; // seconds since start (animation clock for wind, water, clouds)
    this.night = 0;
    this.dayness = 1;
    camera.layers.enableAll();
    camera.layers.disable(LAYERS.EDITOR);
    // shadow-only casters (impostor cards facing the sun) live on the cascade layers alone
    for (let i = 0; i < 3; i++) camera.layers.disable(LAYERS.CASCADE + i);

    // shared uniforms (TSL nodes, `.value` updated in place) read by every world material
    this.uniforms = {
      uTime: g(uniform(0)),
      windDir: g(uniform(new THREE.Vector2(0.8, 0.6))),
      windStrength: g(uniform(0.35)),
      windSpeed: g(uniform(1.3)),
      camPosW: g(uniform(new THREE.Vector3())), // view camera, set by the distance-faded fields (InstancedField)
      foliageTransmission: g(uniform(DEFAULT_ENV.foliageTransmission)),
      skySpec: g(uniform(1)), // sky radiance scale for the reflections (hemisphere intensity / PI x env)
    };
    // texture arrays (terrain, surfaces, foliage) and their shader code; loaded by AssetLibrary / World
    this.surfaces = new Surfaces();
    // depth-only override of the sun cascades and the SSAO pre-pass: double-sided, LOD meshes
    // switch at the middle of their bands (their positionNode, copied by the renderer, reads
    // `mcDepth`), alpha-cut leaves cast / occlude through their cut-out, not as cards
    const depthMat = (this.depthMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, colorWrite: false, fog: false }));
    depthMat.mcDepth = true;
    depthMat.blending = THREE.NoBlending; // the renderer copies `transparent` from the drawn object's material
    depthMat.colorNode = Fn((builder) => { this.surfaces.depthCut(builder); return vec4(0, 0, 0, 1); })();
    depthMat.name = 'depth';
    this.sun = new SunShadows(renderer, scene, this.Q.cascades, { distance: this.Q.shadowDistance, depthMaterial: depthMat });
    this.sunDir = this.sun.dir;
    this.sunColor = new THREE.Color();
    // half-res SSAO on the ambient light (+ a little of the sun), see SSAO.js
    this.ao = new SSAO(renderer, scene, { samples: this.Q.ao, depthMaterial: depthMat });
    // screen-space reflections on the water (SSR.js; read by Water.js): their own setting, off
    // by default, `?ssr=low|medium|high` (the game's settings take over from there)
    this.ssr = new SSR(renderer, this.ao);
    if (typeof location !== 'undefined') this.ssr.setLevel(new URLSearchParams(location.search).get('ssr'));
    // baked probe GI (loaded by World when gi/probes.json exists) + auto exposure
    this.gi = new GI(renderer);
    this.baseExposure = 1;

    // hemisphere ambient: the probes' fallback and floor (GI.js reads its colours); also lights
    // plain three.js materials that were not converted
    this.hemi = new THREE.HemisphereLight(0xbfdfff, 0x5b4a2e, 1);
    scene.add(this.hemi);
    // exp2 fog, applied by the materials' output (render/Output.js) in display space: not set as
    // scene.fog, three's own (linear) fog would apply it a second time
    this.fog = new THREE.FogExp2(0xb4dcf5, 0.0014);
    scene.userData.mcFog = true;
    this._makeSky();
    // sun lens flare (occlusion queries at the end of the main pass, drawn last; see LensFlare.js)
    this.flare = new LensFlare(renderer, this);
    this.materials = new Map();
    this.setEnvironment(this.env);
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.qualityName = name;
    this.Q = QUALITY[name];
    this.sun.setCascades(this.Q.cascades, { distance: this.Q.shadowDistance });
    this.ao.setSamples(this.Q.ao);
  }

  setEnvironment(env) {
    this.env = { ...structuredClone(DEFAULT_ENV), ...env, sky: { ...DEFAULT_ENV.sky, ...env.sky }, ocean: { ...DEFAULT_ENV.ocean, ...env.ocean }, river: { ...DEFAULT_ENV.river, ...env.river }, wind: { ...DEFAULT_ENV.wind, ...env.wind }, clouds: { ...DEFAULT_ENV.clouds, ...env.clouds }, ao: { ...DEFAULT_ENV.ao, ...env.ao }, surface: { ...DEFAULT_ENV.surface, ...env.surface }, flare: { ...DEFAULT_ENV.flare, ...env.flare }, glows: { ...DEFAULT_ENV.glows, ...env.glows }, ssr: { ...DEFAULT_ENV.ssr, ...env.ssr }, gi: { ...DEFAULT_ENV.gi, ...env.gi }, autoExposure: { ...DEFAULT_ENV.autoExposure, ...env.autoExposure } };
    this.gi.setConfig(this.env);
    const w = this.env.wind;
    this.uniforms.windDir.value.set(w.dir[0], w.dir[1]).normalize();
    this.uniforms.windStrength.value = w.strength;
    this.uniforms.windSpeed.value = w.speed;
    this.uniforms.foliageTransmission.value = this.env.foliageTransmission;
    this.skyU.cloudCoverage.value = this.env.clouds.coverage;
    this.skyU.cloudSpeed.value = this.env.clouds.speed;
    this.ao.set(this.env.ao);
    this.ssr.set(this.env.ssr);
    const su = this.surfaces.uniforms;
    su.surfNormalScale.value = this.env.surface.normalScale;
    su.surfDetail.value = this.env.surface.detail;
    this.setTimeOfDay(this.env.timeOfDay);
    this.onEnvironment?.(this.env);
  }

  get timeOfDay() { return this.env.timeOfDay; }

  /** hours in [0, 24) */
  setTimeOfDay(h) {
    h = ((h % 24) + 24) % 24;
    this.env.timeOfDay = h;
    const env = this.env;
    const a = ((h - 6) / 12) * Math.PI; // 0 at 6h (east), PI at 18h (west)
    const tilt = env.sunTilt;
    const sun = new THREE.Vector3(Math.cos(a), Math.sin(a) * Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).normalize();
    const sy = sun.y;
    const day = S(sy, -0.12, 0.2); // 0 night .. 1 day
    const low = 1 - S(Math.abs(sy), 0.0, 0.35); // golden hours near the horizon
    this.dayness = day;
    this.night = 1 - day;
    const sk = env.sky;
    const zenith = col(sk.nightZenith).lerp(col(sk.dayZenith), day).lerp(col(sk.sunsetZenith), low * day * 0.5);
    const horizon = col(sk.nightHorizon).lerp(col(sk.dayHorizon), day).lerp(col(sk.sunsetHorizon), low * S(sy, -0.15, 0.05) * 0.9);

    // the shadow-casting light is the sun by day, the moon (opposite side) by night
    let lightDir, lightCol, lightI;
    if (sy > -0.04) {
      lightDir = sun;
      lightCol = new THREE.Color(1.0, 0.5, 0.25).lerp(new THREE.Color(1.0, 0.95, 0.86), S(sy, 0.0, 0.45));
      lightI = env.sunIntensity * S(sy, -0.04, 0.12);
    } else {
      lightDir = sun.clone().negate();
      lightDir.y = Math.max(lightDir.y, 0.15);
      lightDir.normalize();
      lightCol = new THREE.Color(0.55, 0.68, 1.0);
      lightI = env.moonIntensity * S(-sy, 0.04, 0.2);
    }
    this.sun.setSun(lightDir, lightCol, lightI);
    this.sunColor.copy(lightCol).multiplyScalar(lightI);
    this.realSunDir = sun;

    const u = this.skyU;
    u.sunDir.value.copy(sun);
    u.sunCol.value.copy(lightCol).multiplyScalar(sy > -0.04 ? 1 : 0);
    u.zenith.value.copy(zenith);
    u.horizon.value.copy(horizon);
    u.night.value = this.night;
    u.moonDir.value.copy(sun).negate();

    // ambient: sky above, ground bounce below
    this.hemi.color.copy(zenith).lerp(horizon, 0.5).multiplyScalar(1.0);
    this.hemi.groundColor.copy(col(sk.ground)).multiplyScalar(0.35 + 0.65 * day);
    this.hemi.intensity = env.ambient * (0.35 + 0.65 * day) + this.night * 0.6;
    this.uniforms.skySpec.value = (this.hemi.intensity / Math.PI) * (env.surface?.skySpecular ?? 1);
    this.fog.color.copy(horizon);
    this.fog.density = env.fogDensity * (1 + this.night * 0.6);
    // the materials mix the fog in display space (as three's WebGL fog did on the canvas)
    this.fog.color.getRGB(fogColorU.value, THREE.SRGBColorSpace);
    fogDensityU.value = this.fog.density;
    this.baseExposure = env.exposure * THREE.MathUtils.lerp(1, env.nightExposure, this.night);
    exposureU.value = this.baseExposure * this.gi.exposure * (1 - (this.flare?.dazzle ?? 0));
    this.gi.setHemisphere(this.hemi);
    this.gi.setLight(this.hemi.color, this.hemi.intensity, this.sunColor, lightDir.x);
    this.fogColor = horizon;
  }

  /** Tone mapping exposure (Output.js): base x auto exposure x sun dazzle. */
  get exposure() { return exposureU.value; }

  _makeSky() {
    const u = (this.skyU = {
      sunDir: g(uniform(new THREE.Vector3(0, 1, 0))),
      moonDir: g(uniform(new THREE.Vector3(0, -1, 0))),
      sunCol: g(uniform(new THREE.Color())),
      zenith: g(uniform(new THREE.Color())),
      horizon: g(uniform(new THREE.Color())),
      night: g(uniform(0)),
      cloudCoverage: g(uniform(0.45)),
      cloudSpeed: g(uniform(3)),
      uTime: this.uniforms.uTime,
    });
    const clouds = skyClouds(u);
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
    // a unit sphere around the camera (view rotation only), on the far plane
    m.vertexNode = Fn(() => {
      const p = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(positionLocal, 0)).xyz, 1));
      return vec4(p.xy, p.w, p.w);
    })();
    const vDir = varying(positionLocal, 'vSkyDir');
    const hash3 = (p0) => {
      const p = fract(p0.mul(0.3183099).add(0.1)).mul(17).toVar();
      return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
    };
    m.colorNode = Fn(() => {
      const d = normalize(vDir).toVar();
      const h = d.y;
      const c = vec3(0).toVar();
      If(h.greaterThan(0), () => { c.assign(mix(u.horizon, u.zenith, pow(h, 0.5))); })
        .Else(() => { c.assign(mix(u.horizon, u.horizon.mul(0.6), min(h.negate().mul(3), 1))); });
      const sd = max(dot(d, u.sunDir), 0);
      c.addAssign(u.sunCol.mul(pow(sd, 8).mul(0.18).add(pow(sd, 90).mul(0.5))));
      c.addAssign(u.sunCol.mul(smoothstep(0.9993, 0.9996, sd)).mul(30));
      // moon + stars
      If(u.night.greaterThan(0), () => {
        const md = max(dot(d, u.moonDir), 0);
        c.addAssign(vec3(0.8, 0.85, 1.0).mul(smoothstep(0.999, 0.9993, md)).mul(2.5).mul(u.night));
        c.addAssign(vec3(0.25, 0.3, 0.45).mul(pow(md, 40)).mul(0.4).mul(u.night));
        If(h.greaterThan(0), () => {
          const p = d.mul(260), cell = floor(p);
          const r = hash3(cell);
          If(r.greaterThan(0.986), () => {
            const s = smoothstep(0.14, 0, length(fract(p).sub(0.5)));
            c.addAssign(vec3(0.9, 0.92, 1.0).mul(s).mul(r.sub(0.986)).mul(180).mul(u.night).mul(smoothstep(0, 0.2, h)));
          });
        });
      });
      // clouds (clouds.js)
      If(h.greaterThan(0), () => {
        const cl = clouds(d);
        const lit = mix(u.horizon.mul(1.1), vec3(1), float(0.6).mul(u.night.oneMinus())).add(u.sunCol.mul(0.15)).toVar();
        lit.assign(mix(lit, lit.mul(0.7), cl.y.mul(0.5)));
        c.assign(mix(c, lit.mul(float(0.2).add(u.night.oneMinus().mul(0.8))), cl.x.mul(0.9)));
      });
      return c;
    })();
    m.name = 'sky';
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), m);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.sky.layers.set(LAYERS.FX);
    this.sky.name = 'Sky';
    this.scene.add(this.sky);
    this.sun.onBeforeShadow = () => (this.sky.visible = false);
    this.sun.onAfterShadow = () => (this.sky.visible = true);
  }

  /**
   * Shared lit material (render/WorldMaterial.js), cached by options.
   *  textured:  PBR sampling the texture arrays by the per-vertex `uv` + `surface` attributes
   *             (render/Surfaces.js), normals from the geometry, sky reflections
   *  cutout:    alpha-cut foliage layers (alpha to coverage on a multisampled target)
   *  wind:      sway vertices by the `wind` attribute (0 = rigid, 1 = leaf tip)
   *  flatColor: one colour per triangle (no colour interpolation)
   *  emissive:  per-vertex `emissive` attribute adds self-illumination (lamps, fire)
   *  foliage:   assets with baked normals (assets/ModelBuilder.js: crown normals of length 2 on
   *             leaves): per-instance leaf tint, light through the leaves
   *  smooth:    smooth shading (characters) instead of faceted (untextured Lambert path)
   */
  material(opts = {}) {
    const key = JSON.stringify(opts);
    let m = this.materials.get(key);
    if (m) return m;
    const physical = !!opts.textured;
    const params = {
      side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      transparent: !!opts.transparent,
      color: opts.color ?? 0xffffff,
      flatShading: !physical && !opts.smooth && !opts.foliage,
    };
    m = physical
      ? new WorldStandardMaterial(this, { ao: true, sky: true, env: null }, { ...params, roughness: 1, metalness: 0 })
      : new WorldLambertMaterial(this, { ao: true, sky: false, env: null }, params);
    m.alphaToCoverage = physical && !!opts.cutout;
    setupWorldNodes(m, this, opts);
    m.userData.opts = opts; // variants (e.g. a burnt vehicle: same opts + color) share the program
    this.materials.set(key, m);
    return m;
  }

  /** A three.js lit material (MeshStandardMaterial / MeshLambertMaterial, glTF models,
   *  characters, effects) as a world material: same maps, lit by the sun, cascades, SSAO and
   *  probe GI. Returns the new material (the source is left as is). opts.vertex: extra vertex
   *  options (WorldMaterial.js mcVertex, e.g. bird wings). */
  patch(mat, opts = {}) {
    return convertMaterial(this, mat, opts);
  }

  /** Advance the clock (and the day cycle when env.dayLengthMinutes > 0). */
  update(dt, { advanceDay = true } = {}) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    const len = this.env.dayLengthMinutes;
    if (advanceDay && len > 0) {
      this._todAcc = (this._todAcc ?? 0) + (dt * 24) / (len * 60);
      // re-light at most ~10x per second (cheap, but no need every frame)
      if (Math.abs(this._todAcc) > 0.003) {
        this.setTimeOfDay(this.env.timeOfDay + this._todAcc);
        this._todAcc = 0;
      }
    }
    // auto exposure from the probe light at the camera (eases between bright and dark places),
    // dipped a little while staring at the sun
    this.gi.update(dt, this.camera.position);
    this.flare.update(dt, this.camera);
    exposureU.value = this.baseExposure * this.gi.exposure * (1 - this.flare.dazzle);
  }

  /** GI relight + shadow cascades + SSAO (+ SSR depth) for this frame (call right before rendering the main view). */
  prepass(camera = this.camera) {
    // the output uniforms are shared by every renderer of the page (editor previews have their
    // own Lighting): set this one's right before it draws
    this.fog.color.getRGB(fogColorU.value, THREE.SRGBColorSpace);
    fogDensityU.value = this.fog.density;
    exposureU.value = this.baseExposure * this.gi.exposure * (1 - this.flare.dazzle);
    this.gi.relight();
    this.sun.update(camera);
    this.ssr.beforeDepth();
    this.ao.render(camera);
    this.ssr.update(camera);
  }
}
