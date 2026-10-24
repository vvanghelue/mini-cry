// Lighting & atmosphere: time of day (sun / moon arc), sky dome with clouds, hemisphere ambient
// (replaced by baked probe GI where gi/probes.* exists, see GI.js), auto exposure, cascaded sun
// shadows, half-res SSAO, water reflections (SSR.js), sun lens flare (LensFlare.js), near haze +
// far fog (Haze.js), dust motes in the sunlight (Motes.js), wind, and the shared material factory
// (textured PBR sampling the texture arrays of Surfaces.js, or plain Lambert), as three.js node
// materials (TSL, WebGPU).
//
// Everything is driven by an "environment" object (public/data/environment.json, editable in the
// editor's Environment panel): call setEnvironment(env) and update(dt) every frame.
//
// Lit materials (material() / patch()) light with their own lights node instead of the scene's
// lights: the sun (a direct light whose colour carries the cascaded shadow and a share of the SSAO)
// and the probe light (GI irradiance in place of the hemisphere light, + sky reflections). The
// vertex work (wind, our instancing, LOD collapse, distance fade) is the material's position node,
// which the depth passes (sun cascades, SSAO pre-pass) inherit.
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, int, vec2, vec3, vec4, mat3, max, min, mix, clamp, sqrt, pow, sin, dot, normalize, reflect, length, distance, smoothstep, step, select,
  attribute, varying, lights, output, ambientOcclusion, roughness, diffuseColor, materialColor, materialEmissive, materialRoughness, materialMetalness,
  positionLocal, positionView, positionViewDirection, normalView, normalWorld, normalGeometry, normalLocal, normalViewGeometry, faceDirection, transformNormal,
  cameraViewMatrix, cameraWorldMatrix, cameraProjectionMatrix, modelViewMatrix, modelWorldMatrix, property,
} from 'three/tsl';
import { SunShadows } from './SunShadows.js';
import { SSAO } from './SSAO.js';
import { SSR, SSR_DEFAULTS } from './SSR.js';
import { GI, GI_DEFAULTS, giDbg } from './GI.js';
import { LAYERS } from './layers.js';
import { LensFlare, FLARE_DEFAULTS } from './LensFlare.js';
import { Haze, HAZE_DEFAULTS } from './Haze.js';
import { Motes, MOTES_DEFAULTS } from './Motes.js';
import { skyCloudsFn } from './clouds.js';
import { Surfaces } from './Surfaces.js';
import { U, isInstanced, instanceMatrix, instanceTint } from './tsl.js';
import { lodVisible } from './LodFade.js';
import { FOLIAGE_BASE } from '../assets/surfaces.js';

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
  // VR (Quest 3 class: a mobile GPU drawing two eyes at 72 Hz, WebGL 2 + multiview): one near
  // cascade, no SSAO, short draw distances; xrScale = eye buffer resolution x the headset's
  // recommended one, foveation = fixed foveated rendering 0..1 (Engine._xrQuality), pbr: false =
  // Lambert in place of the textured materials' GGX + sky reflections
  vr: { dpr: 1, cascades: [{ radius: 20, res: 1024, every: 2 }], shadowDistance: 30, shadowTaps: 1, drawScale: 0.2, grass: 0.15, ao: 0, pbr: false, xrScale: 0.8, foveation: 1 },
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
  fogDensity: 0.0008, // far fog (exp2); the near haze: `haze` (Haze.js)
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
  ...structuredClone(HAZE_DEFAULTS),
  ...structuredClone(MOTES_DEFAULTS),
};

const S = THREE.MathUtils.smoothstep;
const col = (hex) => new THREE.Color(hex);

// Fragment state of the lit materials (colour node -> normal / roughness / metalness / lights)
export const ST = {
  color: property('vec3', 'mcColor'),
  alpha: property('float', 'mcAlpha'),
  rough: property('float', 'mcRough'),
  metal: property('float', 'mcMetal'),
  normal: property('vec3', 'mcNormal'),
  leaf: property('float', 'mcLeaf'),
  specK: property('float', 'mcSpecK'), // sky reflection share (leaves 0.15, ground 0.35)
};

/** World position of the fragment, from the view position (no extra varying). */
export const fragWorldPos = () => cameraWorldMatrix.mul(vec4(positionView, 1.0)).xyz;

/** The sun: a direct light whose colour carries the cascaded shadow (and a share of the SSAO). */
class SunLightNode extends THREE.LightingNode {
  constructor(lighting, { ao = true } = {}) {
    super();
    this.L = lighting;
    this.ao = ao;
  }

  setup(builder) {
    const L = this.L, su = L.sun.uniforms, m = builder.material;
    const lightDirection = normalize(cameraViewMatrix.mul(vec4(su.sunDirW, 0.0)).xyz);
    const N = normalWorld, ndl = dot(N, su.sunDirW);
    const c = vec3(0.0).toVar('sunCol');
    If(ndl.greaterThan(0.0), () => {
      let P = fragWorldPos();
      if (m.mcSunShift) P = P.add(su.sunDirW.mul(m.mcSunShift)); // in front of the receiver's own caster (impostor card)
      c.assign(su.sunColor.mul(L.sun.shadowFnFor(m.mcFarKind ?? 'any')(P, N, ndl)));
    });
    if (this.ao && m.aoNode) c.mulAssign(mix(1.0, ambientOcclusion, L.ao.uniforms.aoDirect));
    if (!m.mcLeaf) {
      builder.lightsNode.setupDirectLight(builder, this, { lightDirection, lightColor: c });
      return;
    }
    // leaves: no sun specular. Both sides share the outward (and upward-bent) normal, so against
    // the light it faces away from the eye and GGX at grazing turns their backs white
    const { lightingModel, reflectedLight } = builder.context;
    const spec = vec3(0.0).toVar('sunSpec');
    lightingModel.direct({ lightDirection, lightColor: c, lightNode: this, reflectedLight: { ...reflectedLight, directSpecular: spec } }, builder);
    reflectedLight.directSpecular.addAssign(spec.mul(float(1.0).sub(m.mcLeaf)));
  }
}

/** Ambient: the probe GI in place of the hemisphere light, and the sky reflections (PBR). */
class ProbeLightNode extends THREE.LightingNode {
  constructor(lighting) {
    super();
    this.L = lighting;
  }

  setup(builder) {
    const L = this.L, m = builder.material, ctx = builder.context;
    const amb = L.gi.ambientFn()(fragWorldPos(), normalWorld).toVar('giAmb');
    giDbg.assign(amb.rgb);
    ctx.irradiance.addAssign(amb.rgb);
    if (m.isMeshStandardNodeMaterial && ctx.radiance) {
      // indirect specular from the sky (no environment map): the sky gradient around the reflected
      // direction (blurred toward its average with roughness), scaled by the probe sky visibility
      // so nothing glows under a roof or in the jungle
      const sk = L.skyU;
      const rV = reflect(positionViewDirection.negate(), normalView);
      const rW = normalize(cameraWorldMatrix.mul(vec4(rV, 0.0)).xyz).toVar();
      const skyR = select(rW.y.greaterThan(0.0), mix(sk.horizon, sk.zenith, sqrt(max(rW.y, 0.0))), sk.horizon.mul(mix(0.45, 0.25, min(rW.y.negate().mul(4.0), 1.0))));
      const skyAvg = mix(sk.horizon, sk.zenith, 0.55).mul(0.8);
      const k = m.mcSpecK ?? float(1.0);
      ctx.radiance.addAssign(mix(skyR, skyAvg, roughness).mul(L.uniforms.skySpec).mul(amb.a).mul(k));
    }
  }
}

export class Lighting {
  constructor(renderer, scene, camera, { quality = 'medium' } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.qualityName = QUALITY[quality] ? quality : 'medium';
    this.Q = QUALITY[this.qualityName];
    this.pbr = this.Q.pbr !== false; // (fixed: the materials are built for it)
    this.env = structuredClone(DEFAULT_ENV);
    this.time = 0; // seconds since start (animation clock for wind, water, clouds)
    this.night = 0;
    this.dayness = 1;
    camera.layers.enableAll();
    camera.layers.disable(LAYERS.EDITOR);
    // shadow-only casters (impostor cards facing the sun) live on the cascade layers alone
    for (let i = 0; i < 3; i++) camera.layers.disable(LAYERS.CASCADE + i);

    // shared uniforms: every material references these nodes
    this.uniforms = {
      uTime: U(0),
      windDir: U(new THREE.Vector2(0.8, 0.6)),
      windStrength: U(0.35),
      windSpeed: U(1.3),
      camPosW: U(new THREE.Vector3()), // view camera, set by the distance-faded fields (InstancedField)
      foliageTransmission: U(DEFAULT_ENV.foliageTransmission),
      skySpec: U(1), // sky radiance scale for the reflections (hemisphere intensity / PI x env)
    };
    // texture arrays (terrain, surfaces, foliage) and their shader code; loaded by AssetLibrary / World
    this.surfaces = new Surfaces();
    this.sun = new SunShadows(renderer, scene, this.Q.cascades, { distance: this.Q.shadowDistance, taps: this.Q.shadowTaps ?? 4 });
    // alpha-cut leaves cast / occlude through their cut-out, not as cards
    this.sun.depthMat.maskNode = this.surfaces.leafMaskNode();
    this.sunDir = this.sun.dir;
    this.sunColor = new THREE.Color();
    // half-res SSAO on the ambient light (+ a little of the sun), see SSAO.js
    this.ao = new SSAO(renderer, scene, { samples: this.Q.ao });
    this.ao.depthMat = this.sun.depthMat;
    // screen-space reflections on the water (SSR.js; read by Water.js): their own setting, off
    // by default, `?ssr=low|medium|high` (the game's settings take over from there)
    this.ssr = new SSR(renderer, this.ao);
    if (typeof location !== 'undefined') this.ssr.setLevel(new URLSearchParams(location.search).get('ssr'));
    // baked probe GI (loaded by World when gi/probes.json exists) + auto exposure
    this.gi = new GI(renderer);
    this.baseExposure = 1;

    // the ambient of materials drawn without our lights (scene lights: hemisphere only)
    this.hemi = new THREE.HemisphereLight(0xbfdfff, 0x5b4a2e, 1);
    scene.add(this.hemi);
    this.fog = new THREE.FogExp2(0xb4dcf5, 0.0014); // colour / density of the far fog (data: Haze applies it)
    this._makeSky();
    // near haze + far fog: the scene's fog node, in every material with `fog` (Haze.js)
    this.haze = new Haze(this);
    scene.fogNode = this.haze.fogNode;
    // dust specks floating in the sunlit air around the camera
    this.motes = new Motes(this);
    // sun lens flare (occlusion queries in the main pass, drawn last; see LensFlare.js)
    this.flare = new LensFlare(renderer, this);
    this.materials = new Map();
    // the lights of the lit materials: the sun, the probes (+ sky reflections)
    this.lightsNode = lights([new SunLightNode(this), new ProbeLightNode(this)]);
    // the first-person view model: same lights without the SSAO (its buffer holds the world behind)
    this.viewLightsNode = lights([new SunLightNode(this, { ao: false }), new ProbeLightNode(this)]);
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
    this.env = { ...structuredClone(DEFAULT_ENV), ...env, sky: { ...DEFAULT_ENV.sky, ...env.sky }, ocean: { ...DEFAULT_ENV.ocean, ...env.ocean }, river: { ...DEFAULT_ENV.river, ...env.river }, wind: { ...DEFAULT_ENV.wind, ...env.wind }, clouds: { ...DEFAULT_ENV.clouds, ...env.clouds }, ao: { ...DEFAULT_ENV.ao, ...env.ao }, surface: { ...DEFAULT_ENV.surface, ...env.surface }, flare: { ...DEFAULT_ENV.flare, ...env.flare }, glows: { ...DEFAULT_ENV.glows, ...env.glows }, ssr: { ...DEFAULT_ENV.ssr, ...env.ssr }, haze: { ...DEFAULT_ENV.haze, ...env.haze }, motes: { ...DEFAULT_ENV.motes, ...env.motes }, gi: { ...DEFAULT_ENV.gi, ...env.gi }, autoExposure: { ...DEFAULT_ENV.autoExposure, ...env.autoExposure } };
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
    this.haze.setConfig(this.env);
    this.motes.setConfig(this.env.motes);
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
    this.gi.hemi.sky.value.copy(this.hemi.color).multiplyScalar(this.hemi.intensity);
    this.gi.hemi.ground.value.copy(this.hemi.groundColor).multiplyScalar(this.hemi.intensity);
    this.uniforms.skySpec.value = (this.hemi.intensity / Math.PI) * (env.surface?.skySpecular ?? 1);
    this.fog.color.copy(horizon); // its density: Haze._apply
    this.haze.fogDensity = env.fogDensity;
    // the near haze is lit like the scene: its colour follows the light (sun + sky) relative to noon
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const noon = env.sunIntensity * 0.95 + env.ambient * lum(col(sk.dayZenith).lerp(col(sk.dayHorizon), 0.5));
    this.haze.setTimeOfDay(h, this.night, (lum(this.sunColor) + lum(this.hemi.color) * this.hemi.intensity) / Math.max(noon, 1e-3));
    this.fog.density = this.haze.farDensity;
    this.baseExposure = env.exposure * THREE.MathUtils.lerp(1, env.nightExposure, this.night);
    this.renderer.toneMappingExposure = this.baseExposure * this.gi.exposure * (1 - (this.flare?.dazzle ?? 0));
    this.gi.setLight(this.hemi.color, this.hemi.intensity, this.sunColor, lightDir.x);
    this.fogColor = horizon;
  }

  _makeSky() {
    const u = (this.skyU = {
      sunDir: U(new THREE.Vector3(0, 1, 0)),
      moonDir: U(new THREE.Vector3(0, -1, 0)),
      sunCol: U(new THREE.Color()),
      zenith: U(new THREE.Color()),
      horizon: U(new THREE.Color()),
      night: U(0),
      cloudCoverage: U(0.45),
      cloudSpeed: U(3),
      uTime: this.uniforms.uTime,
    });
    this.skyClouds = skyCloudsFn(u);
    const hash3 = Fn(([p0]) => {
      const p = p0.mul(0.3183099).add(0.1).fract().mul(17.0);
      return p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)).fract();
    });
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    mat.lights = false;
    // on the far plane (z = w): drawn after the opaque world, only where nothing covers the sky
    mat.vertexNode = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(positionLocal, 1.0))).xyww;
    const vDir = varying(positionLocal, 'vSkyDir');
    mat.colorNode = Fn(() => {
      const d = normalize(vDir).toVar();
      const h = d.y;
      const c = select(h.greaterThan(0.0), mix(u.horizon, u.zenith, pow(max(h, 0.0), 0.5)), mix(u.horizon, u.horizon.mul(0.6), min(h.negate().mul(3.0), 1.0))).toVar();
      const sd = max(dot(d, u.sunDir), 0.0);
      c.addAssign(u.sunCol.mul(pow(sd, 8.0).mul(0.18).add(pow(sd, 90.0).mul(0.5))));
      c.addAssign(u.sunCol.mul(smoothstep(0.9993, 0.9996, sd).mul(30.0)));
      // moon + stars
      If(u.night.greaterThan(0.0), () => {
        const md = max(dot(d, u.moonDir), 0.0);
        c.addAssign(vec3(0.8, 0.85, 1.0).mul(smoothstep(0.999, 0.9993, md).mul(2.5).mul(u.night)));
        c.addAssign(vec3(0.25, 0.3, 0.45).mul(pow(md, 40.0).mul(0.4).mul(u.night)));
        If(h.greaterThan(0.0), () => {
          const p = d.mul(260.0), cc = p.floor();
          const r = hash3(cc).toVar();
          If(r.greaterThan(0.986), () => {
            const s = smoothstep(0.14, 0.0, length(p.fract().sub(0.5)));
            c.addAssign(vec3(0.9, 0.92, 1.0).mul(s.mul(r.sub(0.986)).mul(180.0).mul(u.night).mul(smoothstep(0.0, 0.2, h))));
          });
        });
      });
      // clouds (clouds.js)
      If(h.greaterThan(0.0), () => {
        const cl = this.skyClouds(d).toVar();
        const lit = mix(u.horizon.mul(1.1), vec3(1.0), u.night.oneMinus().mul(0.6)).add(u.sunCol.mul(0.15)).toVar();
        lit.assign(mix(lit, lit.mul(0.7), cl.y.mul(0.5)));
        c.assign(mix(c, lit.mul(u.night.oneMinus().mul(0.8).add(0.2)), cl.x.mul(0.9)));
      });
      return vec4(c, 1.0);
    })();
    const geo = new THREE.SphereGeometry(1, 32, 16);
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 1e6; // last of the opaque world (depth test: only the pixels left empty)
    this.sky.layers.set(LAYERS.FX);
    this.sky.onBeforeRender = (r, s, cam) => { this.sky.position.copy(cam.position); this.sky.scale.setScalar(cam.far * 0.5); this.sky.updateMatrixWorld(); };
    this.scene.add(this.sky);
    this.sun.onBeforeShadow = () => (this.sky.visible = false);
    this.sun.onAfterShadow = () => (this.sky.visible = true);
  }

  /**
   * Shared lit material, cached by options.
   *  textured:  PBR (MeshStandardNodeMaterial) sampling the texture arrays by the per-vertex `uv` +
   *             `surface` attributes (render/Surfaces.js), normals from the geometry, sky reflections
   *  cutout:    alpha-cut foliage layers (alpha to coverage on the MSAA buffer)
   *  wind:      sway vertices by the `wind` attribute (0 = rigid, 1 = leaf tip)
   *  flatColor: one colour per triangle (no colour interpolation)
   *  emissive:  per-vertex `emissive` attribute adds self-illumination (lamps, fire)
   *  foliage:   assets with baked normals (assets/ModelBuilder.js: crown normals of length 2 on
   *             leaves): per-instance leaf tint, light through the leaves
   *  smooth:    smooth shading (characters) instead of faceted (untextured Lambert path)
   */
  material(opts = {}) {
    if (opts.textured) {
      // one shader for most assets: wind and the foliage look are per-vertex data (wind 0 = rigid,
      // crown normals of length 2 = leaves), so they don't split materials (pipelines, draws);
      // emissive stays an option (its varying costs on tile GPUs), cut-out / two sides are
      // pipeline state
      const cutout = !!opts.cutout;
      opts = { textured: true, cutout, doubleSided: !!opts.doubleSided || cutout, emissive: !!opts.emissive, wind: true, foliage: true, ...(opts.color !== undefined && { color: opts.color }), ...(opts.transparent && { transparent: true }), ...(opts.vertexColors === false && { vertexColors: false }) };
    }
    const key = JSON.stringify(opts);
    let m = this.materials.get(key);
    if (m) return m;
    const common = {
      vertexColors: opts.vertexColors !== false,
      side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      transparent: !!opts.transparent,
      color: opts.color ?? 0xffffff,
    };
    m = opts.textured && this.pbr
      ? new THREE.MeshStandardNodeMaterial({ ...common, roughness: 1, metalness: 0 })
      : new THREE.MeshLambertNodeMaterial({ ...common, flatShading: !opts.smooth && !opts.foliage });
    m.alphaToCoverage = !!opts.cutout;
    m = this.patch(m, opts);
    m.userData.opts = opts; // variants (e.g. a burnt vehicle: same opts + color) share the compiled program
    this.materials.set(key, m);
    return m;
  }

  /** Light a material like the world (sun + shadows + SSAO + probe GI + haze, + wind / flat colour /
   *  emissive / textures from opts). Plain three.js materials (glTF, Lambert...) are converted to
   *  node materials: use the returned material. view: the first-person view model (no SSAO). */
  patch(mat, opts = {}, { view = false } = {}) {
    if (!mat.isNodeMaterial) mat = toNodeMaterial(mat);
    mat.mcOpts = opts;
    // our colour node reads them (foliage tint folded in)
    const vertexColors = mat.mcVertexColors ??= mat.vertexColors;
    mat.vertexColors = false;
    mat.lightsNode = view ? this.viewLightsNode : this.lightsNode;
    if (!view) mat.aoNode = this.ao.aoNode();
    this.setupVertex(mat, opts);
    this.setupFragment(mat, opts, { vertexColors });
    mat.needsUpdate = true;
    return mat;
  }

  /** The vertex work, as the material's position node (the depth passes inherit it): distance
   *  fade (shrink), wind sway, our instancing and the LOD collapse (opts.lod, LodFade.js). */
  setupVertex(m, opts) {
    const U2 = this.uniforms, fade = opts.fadeRange ?? null;
    m.mcOpts = opts;
    m.mcFade = fade;
    m.positionNode = Fn((builder) => {
      const inst = isInstanced(builder), geo = builder.geometry;
      const p = positionLocal.toVar();
      const M = inst ? instanceMatrix().toVar() : null;
      const origin = inst ? modelWorldMatrix.mul(vec4(attribute('iM3', 'vec4').xyz, 1.0)).xyz : modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
      if (fade) p.mulAssign(float(1.0).sub(smoothstep(fade.x, fade.y, distance(origin, U2.camPosW))));
      if (opts.deform) p.assign(opts.deform(p, builder)); // asset-space deformation (bird wings)
      if (opts.wind && geo?.attributes?.wind) {
        const wind = attribute('wind', 'float');
        const ph = U2.uTime.mul(U2.windSpeed).add(dot(origin.xz, vec2(0.071, 0.093))).toVar();
        const gust = sin(U2.uTime.mul(0.37).add(origin.x.mul(0.01))).mul(0.35).add(0.65);
        const sway = sin(ph).mul(0.7).add(sin(ph.mul(2.31).add(1.7)).mul(0.3)).mul(U2.windStrength).mul(gust).mul(wind);
        p.xz.addAssign(U2.windDir.mul(sway));
        p.y.addAssign(sin(ph.mul(4.7).add(positionLocal.x.mul(2.0)).add(positionLocal.z.mul(2.0))).mul(0.04).mul(wind).mul(U2.windStrength));
      }
      if (!inst) return p;
      if (geo?.attributes?.normal) normalLocal.assign(transformNormal(normalLocal, M));
      const q = M.mul(vec4(p, 1.0)).xyz;
      // instances outside the LOD's range collapse to a point (nothing rasterized)
      return opts.lod ? select(lodVisible(U2.camPosW), q, vec3(0.0)) : q;
    })();
  }

  /** Colour / normal / roughness / metalness / emissive + the debug views. Textured assets
   *  (opts.textured) shade from the texture arrays (Surfaces.js); other materials keep three.js'
   *  own colour / normal / roughness maps (characters, glTF view models). */
  setupFragment(m, opts, { vertexColors = true } = {}) {
    const U2 = this.uniforms, surf = this.surfaces, sunU = this.sun.uniforms;
    const standard = m.isMeshStandardNodeMaterial;
    const doubleSided = m.side === THREE.DoubleSide;
    const a2c = !!m.alphaToCoverage;
    const iM3 = () => attribute('iM3', 'vec4').xyz;
    // per-vertex colour, the foliage tint and the light through the leaves folded in (one varying)
    const vColor = Fn((builder) => {
      const geo = builder.geometry;
      const c = (vertexColors && geo?.attributes?.color ? attribute('color', 'vec3') : vec3(1.0)).toVar();
      if (geo?.attributes?.iTint) c.mulAssign(attribute('iTint', 'vec3')); // per-instance tint
      if (opts.foliage && geo?.attributes?.normal) {
        const n = normalGeometry;
        If(dot(n, n).greaterThan(2.0), () => {
          let fnW;
          if (isInstanced(builder)) {
            c.mulAssign(instanceTint(iM3()));
            fnW = mat3(modelWorldMatrix).mul(mat3(instanceMatrix()).mul(n));
          } else fnW = mat3(modelWorldMatrix).mul(n);
          const back = clamp(float(0.25).sub(dot(normalize(fnW), sunU.sunDirW)), 0.0, 1.0).mul(step(0.0, sunU.sunDirW.y));
          c.mulAssign(vec3(1.9, 2.0, 1.2).mul(U2.foliageTransmission.mul(back)).add(1.0));
        });
      }
      return c;
    });
    const vc = varying(vColor(), 'vColor');
    if (opts.flatColor) vc.setInterpolation('flat');
    m.mcColorVarying = vc; // debug views
    if (!opts.textured) {
      const mc = vec4(materialColor);
      m.colorNode = vec4(mc.rgb.mul(vc), mc.a);
      // a leaf's both sides share the outward normal (no back-face flip)
      if (opts.foliage && doubleSided) m.normalNode = normalViewGeometry;
      m.mcSpecK = null;
      m.mcLeaf = null;
    } else {
      m.mcSpecK = ST.specK;
      m.mcLeaf = ST.leaf; // no sun specular on leaves (SunLightNode)
      m.colorNode = Fn((builder) => {
        ST.color.assign(materialColor.rgb.mul(vc));
        ST.alpha.assign(1.0);
        ST.rough.assign(materialRoughness);
        ST.metal.assign(materialMetalness);
        ST.leaf.assign(0.0);
        ST.specK.assign(1.0);
        // two-sided: flip the back faces' normal, but a leaf's both sides share the outward normal
        const hasSurf = !!builder.geometry?.attributes?.surface;
        const leaf = hasSurf ? surf.varyings().sId.greaterThan(FOLIAGE_BASE - 0.5) : null;
        ST.normal.assign(!doubleSided ? normalViewGeometry : leaf ? select(leaf, normalViewGeometry, normalViewGeometry.mul(faceDirection)) : normalViewGeometry.mul(faceDirection));
        if (hasSurf) surf.sample(ST, { alphaToCoverage: a2c, doubleSided });
        return vec4(ST.color, ST.alpha);
      })();
      m.normalNode = ST.normal;
      if (standard) {
        m.roughnessNode = ST.rough;
        m.metalnessNode = ST.metal;
      }
    }
    m.emissiveNode = Fn((builder) => {
      let e = materialEmissive;
      if (opts.emissive && builder.geometry?.attributes?.emissive) e = e.add(diffuseColor.rgb.mul(varying(attribute('emissive', 'float'), 'vEmis')).mul(3.0));
      return e;
    })();
    this.setupDebug(m);
  }

  /** Light a material that brings its own colour / vertex nodes (terrain, impostors): the world's
   *  lights, the SSAO and the debug views only. */
  light(m, { view = false, ao = true } = {}) {
    m.lightsNode = view ? this.viewLightsNode : this.lightsNode;
    if (ao && !view) m.aoNode = this.ao.aoNode();
    this.setupDebug(m);
    return m;
  }

  /** Debug views over the lit output (F2): GI irradiance alone, SSAO alone, sun cascades tint. */
  setupDebug(m, { gi = true, ao = true, sun = true } = {}) {
    const giU = this.gi.uniforms, aoU = this.ao.uniforms, sunU = this.sun.uniforms, tint = this.sun.tintFn;
    m.outputNode = Fn((builder) => {
      const o = vec4(output).toVar();
      if (gi) If(giU.giDebug.greaterThan(0.5), () => { o.rgb.assign(giDbg.mul(1 / Math.PI)); });
      if (ao && builder.material.aoNode) If(aoU.aoDebug.greaterThan(0.5).and(aoU.aoEnabled.greaterThan(0.5)), () => { o.rgb.assign(vec3(ambientOcclusion)); });
      if (sun) {
        // 1: cascades tint, 2: the sun's visibility alone (cascades + far shadows)
        If(sunU.sunDebug.greaterThan(1.5), () => { o.rgb.assign(vec3(this.sun.shadowFnFor(builder.material.mcFarKind ?? 'any')(fragWorldPos(), normalWorld, 1.0))); })
          .ElseIf(sunU.sunDebug.greaterThan(0.5), () => { o.rgb.mulAssign(tint(fragWorldPos())); });
      }
      return o;
    })();
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
    this.haze.update(dt);
    this.motes.update(dt);
    this.renderer.toneMappingExposure = this.baseExposure * this.gi.exposure * (1 - this.flare.dazzle);
  }

  /** GI relight + shadow cascades + SSAO (+ SSR depth) for this frame (call right before rendering the main view). */
  prepass(camera = this.camera) {
    this.gi.relight();
    this.sun.update(camera);
    this.ssr.beforeDepth();
    this.ao.render(camera);
    this.ssr.update(camera);
  }
}

/** Clone of a lit material, with our own properties (mc*: options, specular share...). */
export function cloneMaterial(base) {
  const m = base.clone();
  for (const k of Object.keys(base)) if (k.startsWith('mc')) m[k] = base[k];
  return m;
}

/** A node material with the properties of a plain three.js material (glTF imports, Lambert / Standard
 *  materials made in code). */
export function toNodeMaterial(mat) {
  const C = mat.isMeshStandardMaterial ? THREE.MeshStandardNodeMaterial : mat.isMeshLambertMaterial ? THREE.MeshLambertNodeMaterial : mat.isMeshPhongMaterial ? THREE.MeshPhongNodeMaterial : THREE.MeshBasicNodeMaterial;
  const n = new C();
  for (const k of ['name', 'side', 'transparent', 'opacity', 'alphaTest', 'alphaToCoverage', 'depthWrite', 'depthTest', 'blending', 'flatShading', 'toneMapped', 'fog', 'visible', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'roughness', 'metalness', 'envMapIntensity', 'wireframe']) {
    if (mat[k] !== undefined && k in n) n[k] = mat[k];
  }
  for (const k of ['color', 'emissive', 'normalScale']) if (mat[k] && n[k]) n[k].copy(mat[k]);
  n.vertexColors = mat.vertexColors;
  n.userData = mat.userData;
  return n;
}

