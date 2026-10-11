// Probe global illumination at runtime (data baked by `mc gi bake`, format in GIField.js).
//
//  - The baked terms (sky + one sun bounce per time-of-day key, 8 bits) live in a texture array.
//    relight() mixes them for the current sky / sun colours and sun position into a small 3D
//    texture (RGB L1 SH per probe, half float) with a few fullscreen draws — only when the light
//    changed (~10 x per second while the day advances).
//  - Patched materials replace the hemisphere light by the probe irradiance at the shaded point
//    (one base-height fetch + three trilinear 3D fetches), so props, terrain, vegetation and
//    characters all get sky occlusion and coloured bounce light.
//  - The CPU keeps the field to meter the light at the camera: auto exposure (brighter in the
//    jungle or a bunker, a bit) and the view model's light.
import * as THREE from 'three';
import { GIFieldData, GI_LAYERS, GI_H0, GI_RATIO, keyBlend, sliceCount, evalSH, luminance } from './GIField.js';

const SLICES = 3 * GI_LAYERS; // field 3D texture: channel r, g, b x layers

const GLSL_PARS = /* glsl */ `
uniform highp sampler3D giField;
uniform sampler2D giBase;
uniform vec4 giGrid;   // world -> uv: x, z offset, 1 / size; w = on
uniform vec4 giLayer;  // H0, 1 / log2(ratio), layers - 1, normal offset (m)
uniform float giDebug, giFloor;
vec3 giDbg = vec3(0.0);
vec3 giIrradiance(vec3 P, vec3 N) {
  P += N * giLayer.w;
  vec2 uv = (P.xz + giGrid.xy) * giGrid.z;
  float base = texture2D(giBase, uv).r;
  float lc = clamp(log2(max(P.y - base, giLayer.x) / giLayer.x) * giLayer.y, 0.0, giLayer.z);
  float w = (lc + 0.5) / ${SLICES}.0;
  vec4 r = texture(giField, vec3(uv, w));
  vec4 g = texture(giField, vec3(uv, w + ${GI_LAYERS}.0 / ${SLICES}.0));
  vec4 b = texture(giField, vec3(uv, w + ${2 * GI_LAYERS}.0 / ${SLICES}.0));
  vec4 k = vec4(1.0, N);
  return max(vec3(dot(r, k), dot(g, k), dot(b, k)), vec3(0.0));
}
vec3 giHemi(const in HemisphereLight hemi, const in vec3 normal, const in vec3 P, const in vec3 N) {
  vec3 h = getHemisphereLightIrradiance(hemi, normal);
  // floor: keep a part of the flat ambient so nothing goes pitch black (artistic)
  vec3 e = giGrid.w > 0.5 ? mix(giIrradiance(P, N), h, giFloor) : h;
  giDbg = e;
  return e;
}
`;

const HEMI_CALL = 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );';
const AMBIENT_LINE = 'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );';

const BLEND_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BLEND_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray terms;
uniform int chan, layer, n, kA, kB;
uniform vec3 wSky, wA, wB;
uniform float amSky, amA, amB;
out vec4 color;
vec4 key(ivec2 q, int k, float am) {
  vec4 a = texelFetch(terms, ivec3(q, 3 + 2 * k), 0), b = texelFetch(terms, ivec3(q, 4 + 2 * k), 0);
  float A = a[chan] * a[chan] * am;
  return vec4(A, A * (vec3(a.w, b.x, b.y) * 4.0 - 2.0));
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  q.y += layer * n;
  vec4 s = texelFetch(terms, ivec3(q, chan), 0);
  float A = s.x * s.x * amSky;
  color = vec4(A, A * (s.yzw * 4.0 - 2.0)) * wSky[chan] + key(q, kA, amA) * wA[chan] + key(q, kB, amB) * wB[chan];
}`;

export const GI_DEFAULTS = {
  gi: { enabled: true, intensity: 1, bias: 0.6, floor: 0.12 },
  autoExposure: { enabled: true, strength: 0.5, reference: 0.85, min: 0.85, max: 2.2, speedUp: 0.8, speedDown: 3 },
};

export class GI {
  constructor(renderer) {
    this.renderer = renderer;
    this.data = null;
    this.enabled = true;
    this.cfg = structuredClone(GI_DEFAULTS.gi);
    this.ae = structuredClone(GI_DEFAULTS.autoExposure);
    this.exposure = 1; // auto exposure multiplier
    this.openness = 1; // ambient light at the camera / open air (0..~1.2)
    this.cameraSH = new Float32Array(12);
    this.weights = { sky: [0, 0, 0], sun: [0, 0, 0], kA: 0, kB: 0, f: 0 };
    this._dirty = true;
    this._ref = new Float32Array(12);
    const d3 = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
    d3.needsUpdate = true;
    const d2 = new THREE.DataTexture(new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType);
    d2.needsUpdate = true;
    this.uniforms = {
      giField: { value: d3 },
      giBase: { value: d2 },
      giGrid: { value: new THREE.Vector4(0, 0, 1, 0) },
      giLayer: { value: new THREE.Vector4(GI_H0, 1 / Math.log2(GI_RATIO), GI_LAYERS - 1, this.cfg.bias) },
      giDebug: { value: 0 },
      giFloor: { value: this.cfg.floor },
    };
  }

  get loaded() { return !!this.data; }
  get active() { return !!this.data && this.enabled && this.cfg.enabled !== false; }

  /** Settings from environment.json ({ gi, autoExposure }). */
  setConfig(env) {
    Object.assign(this.cfg, GI_DEFAULTS.gi, env?.gi);
    Object.assign(this.ae, GI_DEFAULTS.autoExposure, env?.autoExposure);
    this.uniforms.giLayer.value.w = this.cfg.bias;
    this.uniforms.giFloor.value = this.cfg.floor ?? 0;
    this._sync();
  }

  setEnabled(v) { this.enabled = !!v; this._sync(); }

  _sync() {
    this.uniforms.giGrid.value.w = this.active ? 1 : 0;
    this._dirty = true;
  }

  /** meta = gi/probes.json, bytes = gi/probes.bin (gzip or raw). */
  async load(meta, bytes) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    const d = new GIFieldData(meta, bytes);
    this.data = d;
    const n = d.n;
    const terms = new THREE.DataArrayTexture(d.texels, n, n * GI_LAYERS, sliceCount(d.keys));
    terms.format = THREE.RGBAFormat;
    terms.type = THREE.UnsignedByteType;
    terms.minFilter = terms.magFilter = THREE.NearestFilter;
    terms.generateMipmaps = false;
    terms.needsUpdate = true;
    const base = new THREE.DataTexture(THREE.DataUtils ? toHalf(d.base) : d.base, n, n, THREE.RedFormat, THREE.HalfFloatType);
    base.minFilter = base.magFilter = THREE.LinearFilter;
    base.wrapS = base.wrapT = THREE.ClampToEdgeWrapping;
    base.needsUpdate = true;
    const rt = new THREE.WebGL3DRenderTarget(n, n, SLICES, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.dispose();
    this.termsTex = terms;
    this.baseTex = base;
    this.rt = rt;
    const U = this.uniforms;
    U.giField.value = rt.texture;
    U.giBase.value = base;
    U.giGrid.value.set(meta.size / 2, meta.size / 2, 1 / meta.size, 0);
    this.blendMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BLEND_VERT,
      fragmentShader: BLEND_FRAG,
      uniforms: {
        terms: { value: terms }, chan: { value: 0 }, layer: { value: 0 }, n: { value: n }, kA: { value: 0 }, kB: { value: 0 },
        wSky: { value: new THREE.Vector3() }, wA: { value: new THREE.Vector3() }, wB: { value: new THREE.Vector3() },
        amSky: { value: meta.amax[0] }, amA: { value: 1 }, amB: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.Camera();
    this._sync();
    return this;
  }

  /**
   * Current light (Lighting.setTimeOfDay): sky radiance = hemi colour x intensity / PI (so open
   * ground matches the hemisphere light), sun = shadow light colour x intensity and direction.
   */
  setLight(skyColor, skyIntensity, sunColor, lightDirX) {
    const w = this.weights, k = (this.cfg.intensity ?? 1);
    const s = (skyIntensity / Math.PI) * k;
    w.sky[0] = skyColor.r * s; w.sky[1] = skyColor.g * s; w.sky[2] = skyColor.b * s;
    w.sun[0] = sunColor.r * k; w.sun[1] = sunColor.g * k; w.sun[2] = sunColor.b * k;
    const kb = keyBlend(lightDirX, this.data?.keys ?? 7, this._kb ??= [0, 0, 0]);
    w.kA = kb[0]; w.kB = kb[1]; w.f = kb[2];
    this._dirty = true;
  }

  /** Re-mix the field for the current light (GPU, only when it changed). Call before rendering. */
  relight() {
    if (!this._dirty || !this.data || !this.active) return;
    this._dirty = false;
    const r = this.renderer, u = this.blendMat.uniforms, w = this.weights, am = this.data.amax;
    u.wSky.value.fromArray(w.sky);
    u.wA.value.fromArray(w.sun).multiplyScalar(1 - w.f);
    u.wB.value.fromArray(w.sun).multiplyScalar(w.f);
    u.kA.value = w.kA; u.kB.value = w.kB;
    u.amA.value = am[1 + w.kA]; u.amB.value = am[1 + w.kB];
    const prev = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevMip = r.getActiveMipmapLevel();
    const autoClear = r.autoClear;
    r.autoClear = false;
    for (let c = 0; c < 3; c++) {
      for (let l = 0; l < GI_LAYERS; l++) {
        u.chan.value = c; u.layer.value = l;
        r.setRenderTarget(this.rt, c * GI_LAYERS + l);
        r.render(this.quadScene, this.quadCam);
      }
    }
    r.setRenderTarget(prev, prevFace, prevMip);
    r.autoClear = autoClear;
  }

  /** Meter the light at the camera: auto exposure multiplier + openness. */
  update(dt, pos) {
    let target = 1;
    if (this.active) {
      const d = this.data, w = this.weights;
      d.sample(pos.x, pos.y, pos.z, w, this.cameraSH);
      // openness = sky light reaching the eye from above / the same in open air (open-sea probe):
      // ~ how much sky is visible, independent of how bright the ground around is
      const ws = (this._wSky ??= { sky: null, sun: [0, 0, 0], kA: 0, kB: 0, f: 0 });
      ws.sky = w.sky;
      const sky = d.sample(pos.x, pos.y, pos.z, ws, (this._skySH ??= new Float32Array(12)));
      const ref = d.meta.ref, R = ref ? d.probe(ref.i, ref.j, 0, ws, this._ref) : null;
      const up = (s) => luminance(s[0] + s[2], s[4] + s[6], s[8] + s[10]);
      const lc = up(sky), lr = R ? up(R) : lc;
      this.openness = lr > 1e-6 ? Math.min(1.2, lc / lr) : 1;
      // a usual outdoor spot (a few trees around) sees ~`reference` of the sky: no compensation there
      if (this.ae.enabled) target = Math.min(this.ae.max, Math.max(this.ae.min, Math.min(1, Math.max(this.openness, 0.02) / (this.ae.reference || 1)) ** -this.ae.strength));
    } else this.openness = 1;
    // a jump of the camera (teleport, respawn, cut) snaps instead of easing
    const last = (this._lastPos ??= { x: pos.x, y: pos.y, z: pos.z });
    const jump = (pos.x - last.x) ** 2 + (pos.y - last.y) ** 2 + (pos.z - last.z) ** 2 > 30 * 30;
    last.x = pos.x; last.y = pos.y; last.z = pos.z;
    const speed = target > this.exposure ? this.ae.speedUp : this.ae.speedDown;
    const a = dt > 0 && !jump ? 1 - Math.exp(-dt * speed) : 1;
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * a);
  }

  /** Jump the exposure to its target (teleports, cuts). */
  snapExposure(pos) { this.update(0, pos); }

  /** Irradiance at the camera for a world normal -> [r, g, b] (view model light), floor included. */
  cameraIrradiance(nx, ny, nz, out, hemi) {
    evalSH(this.cameraSH, nx, ny, nz, out);
    const f = this.cfg.floor ?? 0;
    if (hemi && f > 0) {
      const t = 0.5 * ny + 0.5, k = hemi.intensity;
      out[0] += f * ((hemi.groundColor.r + (hemi.color.r - hemi.groundColor.r) * t) * k - out[0]);
      out[1] += f * ((hemi.groundColor.g + (hemi.color.g - hemi.groundColor.g) * t) * k - out[1]);
      out[2] += f * ((hemi.groundColor.b + (hemi.color.b - hemi.groundColor.b) * t) * k - out[2]);
    }
    return out;
  }

  /** Inject the probe irradiance (in place of the hemisphere light) into a lit material's shader. */
  inject(sh) {
    Object.assign(sh.uniforms, this.uniforms);
    const chunk = THREE.ShaderChunk.lights_fragment_begin
      .replace(AMBIENT_LINE, `${AMBIENT_LINE}
        vec3 giP = (vec4(-vViewPosition, 0.0) * viewMatrix).xyz + cameraPosition;
        vec3 giN = normalize((vec4(geometryNormal, 0.0) * viewMatrix).xyz);`)
      .replace(HEMI_CALL, 'irradiance += giHemi( hemisphereLights[ i ], geometryNormal, giP, giN );');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_pars_begin>', () => '#include <lights_pars_begin>\n' + GLSL_PARS)
      .replace('#include <lights_fragment_begin>', () => chunk)
      .replace('#include <opaque_fragment>', () => '#include <opaque_fragment>\nif (giDebug > 0.5) gl_FragColor.rgb = giDbg * RECIPROCAL_PI;');
  }

  dispose() {
    this.termsTex?.dispose();
    this.baseTex?.dispose();
    this.rt?.dispose();
    this.blendMat?.dispose();
    this.quad?.geometry.dispose();
  }
}

function toHalf(f32) {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = THREE.DataUtils.toHalfFloat(f32[i]);
  return out;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const zlib = await import(/* @vite-ignore */ 'node:zlib');
  return new Uint8Array(zlib.gunzipSync(bytes));
}
