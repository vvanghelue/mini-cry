// Lighting & atmosphere: time of day (sun / moon arc), sky dome with clouds, hemisphere ambient
// (replaced by baked probe GI where gi/probes.* exists, see GI.js), auto exposure, cascaded sun
// shadows, half-res SSAO, sun lens flare (LensFlare.js), fog, wind, and the shared low-poly
// material factory.
//
// Everything is driven by an "environment" object (public/data/environment.json, editable in the
// editor's Environment panel): call setEnvironment(env) and update(dt) every frame.
import * as THREE from 'three';
import { SunShadows } from './SunShadows.js';
import { SSAO } from './SSAO.js';
import { GI, GI_DEFAULTS } from './GI.js';
import { LAYERS } from './layers.js';
import { patchLodDepth } from './LodFade.js';
import { LensFlare, FLARE_DEFAULTS } from './LensFlare.js';
import { CLOUDS_GLSL } from './clouds.js';
import { Surfaces } from './Surfaces.js';

// ao: SSAO samples per pixel (0 = off)
export const QUALITY = {
  low: { dpr: 0.75, cascades: [{ radius: 22, res: 1024, every: 1 }, { radius: 90, res: 1024, every: 3 }], drawScale: 0.65, grass: 0.5, ao: 6 },
  medium: { dpr: 1, cascades: [{ radius: 22, res: 2048, every: 1 }, { radius: 90, res: 1536, every: 3 }], drawScale: 0.8, grass: 0.8, ao: 8 },
  high: { dpr: 1, cascades: [{ radius: 20, res: 2048, every: 1 }, { radius: 80, res: 2048, every: 2 }, { radius: 260, res: 2048, every: 4 }], drawScale: 1, grass: 1, ao: 12 },
  ultra: { dpr: 2, cascades: [{ radius: 20, res: 4096, every: 1 }, { radius: 80, res: 4096, every: 1 }, { radius: 300, res: 4096, every: 2 }], drawScale: 1.25, grass: 1.3, ao: 12 },
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
};

const S = THREE.MathUtils.smoothstep;
const col = (hex) => new THREE.Color(hex);

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

    // shared uniforms: every patched material references these objects
    this.uniforms = {
      uTime: { value: 0 },
      windDir: { value: new THREE.Vector2(0.8, 0.6) },
      windStrength: { value: 0.35 },
      windSpeed: { value: 1.3 },
      camPosW: { value: new THREE.Vector3() }, // view camera, set by the distance-faded fields (InstancedField)
      foliageTransmission: { value: DEFAULT_ENV.foliageTransmission },
      skySpec: { value: 1 }, // sky radiance scale for the reflections (hemisphere intensity / PI x env)
    };
    // texture arrays (terrain, surfaces, foliage) and their shader code; loaded by AssetLibrary / World
    this.surfaces = new Surfaces();
    this.sun = new SunShadows(renderer, scene, this.Q.cascades);
    this.sunDir = this.sun.dir;
    this.sunColor = new THREE.Color();
    // half-res SSAO on the ambient light (+ a little of the sun), see SSAO.js
    this.ao = new SSAO(renderer, scene, { samples: this.Q.ao });
    // baked probe GI (loaded by World when gi/probes.json exists) + auto exposure
    this.gi = new GI(renderer);
    this.baseExposure = 1;
    // LOD'd instanced fields cast and occlude with one LOD per instance (render/LodFade.js)
    patchLodDepth(this.sun.depthMatDouble, this.uniforms);
    patchLodDepth(this.ao.depthMat, this.uniforms);
    // alpha-cut leaves cast / occlude through their cut-out, not as cards
    this.surfaces.patchDepth(this.sun.depthMatDouble);
    this.surfaces.patchDepth(this.ao.depthMat);

    this.hemi = new THREE.HemisphereLight(0xbfdfff, 0x5b4a2e, 1);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xb4dcf5, 0.0014);
    this._makeSky();
    // sun lens flare (occlusion queries after the main scene, drawn last; see LensFlare.js)
    this.flare = new LensFlare(renderer, this);
    this.materials = new Map();
    this.setEnvironment(this.env);
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.qualityName = name;
    this.Q = QUALITY[name];
    this.sun.setCascades(this.Q.cascades);
    this.ao.setSamples(this.Q.ao);
  }

  setEnvironment(env) {
    this.env = { ...structuredClone(DEFAULT_ENV), ...env, sky: { ...DEFAULT_ENV.sky, ...env.sky }, ocean: { ...DEFAULT_ENV.ocean, ...env.ocean }, river: { ...DEFAULT_ENV.river, ...env.river }, wind: { ...DEFAULT_ENV.wind, ...env.wind }, clouds: { ...DEFAULT_ENV.clouds, ...env.clouds }, ao: { ...DEFAULT_ENV.ao, ...env.ao }, surface: { ...DEFAULT_ENV.surface, ...env.surface }, flare: { ...DEFAULT_ENV.flare, ...env.flare }, glows: { ...DEFAULT_ENV.glows, ...env.glows }, gi: { ...DEFAULT_ENV.gi, ...env.gi }, autoExposure: { ...DEFAULT_ENV.autoExposure, ...env.autoExposure } };
    this.gi.setConfig(this.env);
    const w = this.env.wind;
    this.uniforms.windDir.value.set(w.dir[0], w.dir[1]).normalize();
    this.uniforms.windStrength.value = w.strength;
    this.uniforms.windSpeed.value = w.speed;
    this.uniforms.foliageTransmission.value = this.env.foliageTransmission;
    this.skyU.cloudCoverage.value = this.env.clouds.coverage;
    this.skyU.cloudSpeed.value = this.env.clouds.speed;
    this.ao.set(this.env.ao);
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
    this.scene.fog.color.copy(horizon);
    this.scene.fog.density = env.fogDensity * (1 + this.night * 0.6);
    this.baseExposure = env.exposure * THREE.MathUtils.lerp(1, env.nightExposure, this.night);
    this.renderer.toneMappingExposure = this.baseExposure * this.gi.exposure * (1 - (this.flare?.dazzle ?? 0));
    this.gi.setLight(this.hemi.color, this.hemi.intensity, this.sunColor, lightDir.x);
    this.fogColor = horizon;
  }

  _makeSky() {
    const u = (this.skyU = {
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      moonDir: { value: new THREE.Vector3(0, -1, 0) },
      sunCol: { value: new THREE.Color() },
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      night: { value: 0 },
      cloudCoverage: { value: 0.45 },
      cloudSpeed: { value: 3 },
      uTime: this.uniforms.uTime,
    });
    const geo = new THREE.SphereGeometry(1, 32, 16);
    this.sky = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: u,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // on the far plane
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 sunDir, moonDir, sunCol, zenith, horizon;
        uniform float night;
        varying vec3 vDir;
        ${CLOUDS_GLSL}
        float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.5)) : mix(horizon, horizon * 0.6, min(-h * 3.0, 1.0));
          float sd = max(dot(d, sunDir), 0.0);
          col += sunCol * (pow(sd, 8.0) * 0.18 + pow(sd, 90.0) * 0.5);
          col += sunCol * smoothstep(0.9993, 0.9996, sd) * 30.0;
          // moon + stars
          if (night > 0.0) {
            float md = max(dot(d, moonDir), 0.0);
            col += vec3(0.8, 0.85, 1.0) * smoothstep(0.9990, 0.9993, md) * 2.5 * night;
            col += vec3(0.25, 0.3, 0.45) * pow(md, 40.0) * 0.4 * night;
            if (h > 0.0) {
              vec3 p = d * 260.0, c = floor(p);
              float r = hash3(c);
              if (r > 0.986) {
                float s = smoothstep(0.14, 0.0, length(fract(p) - 0.5));
                col += vec3(0.9, 0.92, 1.0) * s * (r - 0.986) * 180.0 * night * smoothstep(0.0, 0.2, h);
              }
            }
          }
          // clouds (clouds.js)
          if (h > 0.0) {
            vec2 c = skyClouds(d);
            vec3 cloudLit = mix(horizon * 1.1, vec3(1.0), 0.6 * (1.0 - night)) + sunCol * 0.15;
            cloudLit = mix(cloudLit, cloudLit * 0.7, c.y * 0.5);
            col = mix(col, cloudLit * (0.2 + 0.8 * (1.0 - night)), c.x * 0.9);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.sky.layers.set(LAYERS.FX);
    this.sky.onBeforeRender = (r, s, cam) => { this.sky.position.copy(cam.position); this.sky.scale.setScalar(cam.far * 0.95); this.sky.updateMatrixWorld(); };
    this.scene.add(this.sky);
    this.sun.onBeforeShadow = () => (this.sky.visible = false);
    this.sun.onAfterShadow = () => (this.sky.visible = true);
  }

  /**
   * Shared lit material, cached by options.
   *  textured:  PBR (MeshStandardMaterial) sampling the texture arrays by the per-vertex `uv` +
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
    const key = JSON.stringify(opts);
    let m = this.materials.get(key);
    if (m) return m;
    const common = {
      vertexColors: opts.vertexColors !== false,
      side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      transparent: !!opts.transparent,
      color: opts.color ?? 0xffffff,
    };
    m = opts.textured
      ? new THREE.MeshStandardMaterial({ ...common, roughness: 1, metalness: 0, alphaToCoverage: !!opts.cutout })
      : new THREE.MeshLambertMaterial({ ...common, flatShading: !opts.smooth && !opts.foliage });
    this.patch(m, opts);
    this.materials.set(key, m);
    return m;
  }

  /** Inject sun + shadows + SSAO + probe GI (+ wind / flat colour / emissive) into a Lambert / Standard material. */
  patch(mat, opts = {}) {
    const sun = this.sun, ao = this.ao, gi = this.gi, U = this.uniforms, surf = this.surfaces, skyU = this.skyU;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      Object.assign(sh.uniforms, U);
      sun.inject(sh);
      ao.inject(sh);
      gi.inject(sh);
      if (opts.textured) surf.inject(sh);
      if (mat.isMeshStandardMaterial) skyReflections(sh, skyU);
      if (opts.wind) {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>
            attribute float wind;
            uniform float uTime, windStrength, windSpeed;
            uniform vec2 windDir;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            {
              #ifdef USE_INSTANCING
                vec3 wO = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              #else
                vec3 wO = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              #endif
              float ph = uTime * windSpeed + dot(wO.xz, vec2(0.071, 0.093));
              float gust = 0.65 + 0.35 * sin(uTime * 0.37 + wO.x * 0.01);
              float sway = (sin(ph) * 0.7 + sin(ph * 2.31 + 1.7) * 0.3) * windStrength * gust * wind;
              transformed.xz += windDir * sway;
              transformed.y += sin(ph * 4.7 + position.x * 2.0 + position.z * 2.0) * 0.04 * wind * windStrength;
            }`);
      }
      if (opts.foliage) {
        // smooth shading from the baked normals (facets for wood, crown normals of length 2 for
        // leaves); per vertex, leaves get the per-instance tint and the light coming through them
        // on the shaded side of the crown — folded into the colour: no extra varying
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>
            uniform vec3 sunDirW;
            uniform float foliageTransmission;`)
          .replace('#include <color_vertex>', `#include <color_vertex>
            #ifdef USE_COLOR
            if (dot(normal, normal) > 2.0) {
              #ifdef USE_INSTANCING
                uvec2 hq = uvec2(ivec2(floor(instanceMatrix[3].xz * 4.0)) + 1048576);
                uint hh = hq.x * 1597334677u ^ hq.y * 3812015801u;
                hh = hh * 747796405u + 2891336453u; hh ^= hh >> 16u; hh *= 2246822519u; hh ^= hh >> 13u;
                float h1 = float(hh & 1023u) / 1023.0, h2 = float((hh >> 10u) & 1023u) / 1023.0;
                vColor.xyz *= (0.86 + 0.28 * h1) * mix(vec3(1.07, 1.03, 0.8), vec3(0.9, 1.0, 1.1), h2);
                vec3 fnW = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
              #else
                vec3 fnW = mat3(modelMatrix) * normal;
              #endif
              float back = clamp(0.25 - dot(normalize(fnW), sunDirW), 0.0, 1.0) * step(0.0, sunDirW.y);
              vColor.xyz *= 1.0 + vec3(1.9, 2.0, 1.2) * (foliageTransmission * back);
            }
            #endif`);
        // a leaf's both sides share the outward normal (no back-face flip)
        sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          #ifdef DOUBLE_SIDED
            normal *= faceDirection;
          #endif`);
      }
      if (opts.flatColor) {
        sh.vertexShader = sh.vertexShader.replace('#include <color_pars_vertex>', '#if defined(USE_COLOR) || defined(USE_COLOR_ALPHA) || defined(USE_INSTANCING_COLOR) || defined(USE_BATCHING_COLOR)\nflat varying vec4 vColor;\n#endif');
        sh.fragmentShader = sh.fragmentShader.replace('#include <color_pars_fragment>', '#if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)\nflat varying vec4 vColor;\n#endif');
      }
      if (opts.emissive) {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float emissive;\nvarying float vEmis;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmis = emissive;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vEmis;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vEmis * 3.0;');
      }
    };
    const prevKey = mat.customProgramCacheKey?.bind(mat);
    mat.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|mc|${opts.wind ? 'w' : ''}${opts.flatColor ? 'f' : ''}${opts.emissive ? 'e' : ''}${opts.foliage ? 'l' : ''}${opts.textured ? 't' : ''}${opts.cutout ? 'c' : ''}`;
    mat.needsUpdate = true;
    return mat;
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
    this.renderer.toneMappingExposure = this.baseExposure * this.gi.exposure * (1 - this.flare.dazzle);
  }

  /** GI relight + shadow cascades + SSAO for this frame (call right before rendering the main view). */
  prepass(camera = this.camera) {
    this.gi.relight();
    this.sun.update(camera);
    this.ao.render(camera);
  }
}

/** Indirect specular from the sky (no environment map): the sky gradient around the reflected
 *  direction (blurred toward its average with roughness), scaled by the probe sky visibility
 *  (GI.js giOcc) so nothing glows under a roof or in the jungle. */
export function skyReflections(sh, skyU) {
  sh.uniforms.skyZen = skyU.zenith;
  sh.uniforms.skyHor = skyU.horizon;
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 skyZen, skyHor;\nuniform float skySpec;\nfloat surfSpecK = 1.0; // leaves: 0.15 (Surfaces.js)')
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
      #if defined( RE_IndirectSpecular )
      {
        vec3 rW = normalize((vec4(reflect(-geometryViewDir, geometryNormal), 0.0) * viewMatrix).xyz);
        vec3 skyR = rW.y > 0.0 ? mix(skyHor, skyZen, sqrt(rW.y)) : skyHor * mix(0.45, 0.25, min(-rW.y * 4.0, 1.0));
        vec3 skyAvg = mix(skyHor, skyZen, 0.55) * 0.8;
        radiance += mix(skyR, skyAvg, material.roughness) * skySpec * giOcc * surfSpecK;
      }
      #endif`);
}