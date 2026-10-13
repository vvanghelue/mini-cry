// Screen-space ambient occlusion (ported from three-rigged-game/src/lighting/ao.js), tuned for
// speed and a clean (noise-free, halo-free) result.
//
// Everything runs at half resolution:
//   1. depth pre-pass of the STATIC + DYNAMIC layers (no grass, water, FX) through a copy of the
//      main camera whose far plane stops where the AO has faded out (fadeFar), so the distant
//      world is frustum-culled and costs nothing. Same depth material as the shadow cascades:
//      the programs are shared, nothing new compiles;
//   2. AO pass: view-space position rebuilt from depth, normal rebuilt from depth (picking the
//      smaller neighbour delta so edges don't smear), N samples on a golden-angle spiral rotated
//      by a 4x4 interleaved pattern. A range falloff kills occluders far away from the receiver,
//      so there is no dark halo around foreground objects;
//   3. one 4x4 depth-aware blur: every 4x4 window contains all 16 rotations of the pattern, so it
//      removes the pattern noise completely (no temporal accumulation, no ghosting).
// The result (AO + linear depth) is read back in the lit materials (Lighting.patch) with a
// depth-aware bilateral upsample and applied to the indirect (hemisphere) light, plus a small
// share of the direct sun. Surfaces missing from the pre-pass (grass) take the AO of the closest
// depth around them, i.e. the ground they stand on.
// The water's screen-space reflections (SSR.js) march through the same depth: while they are on,
// the pre-pass reaches `depthFar` and runs even with the AO switched off.
import * as THREE from 'three';
import { LAYERS } from './layers.js';

const DEPTH_LAYERS = (1 << LAYERS.STATIC) | (1 << LAYERS.DYNAMIC);

const QUAD_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const AO_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tDepth;
uniform vec2 size;
uniform vec2 projXY;
uniform float cNear, cFar;
uniform float radius, intensity, projScale, maxPx, fadeFar;
out vec4 o;
#define SAMPLES %SAMPLES%

float viewZ(float d) { return (cNear * cFar) / ((cFar - cNear) * d - cFar); }
vec3 viewPos(ivec2 p, float d) {
  vec2 uv = (vec2(p) + 0.5) / size;
  float z = viewZ(d);
  return vec3((uv * 2.0 - 1.0) * projXY * -z, z);
}
vec3 fetchPos(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(size) - 1);
  return viewPos(p, texelFetch(tDepth, p, 0).x);
}
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float d = texelFetch(tDepth, ip, 0).x;
  if (d >= 1.0) { o = vec4(1.0, cFar, 0.0, 1.0); return; }
  vec3 P = viewPos(ip, d);
  float dist = -P.z;
  float rPx = radius * projScale / dist;
  float fade = 1.0 - smoothstep(fadeFar * 0.6, fadeFar, dist);
  if (rPx < 1.0 || fade <= 0.0) { o = vec4(1.0, dist, 0.0, 1.0); return; }
  rPx = min(rPx, maxPx);

  vec3 pr = fetchPos(ip + ivec2(1, 0)), pl = fetchPos(ip - ivec2(1, 0));
  vec3 pu = fetchPos(ip + ivec2(0, 1)), pd = fetchPos(ip - ivec2(0, 1));
  ivec2 last = ivec2(size) - 1;
  bool useR = ip.x == 0 || (ip.x < last.x && abs(pr.z - P.z) < abs(P.z - pl.z));
  bool useU = ip.y == 0 || (ip.y < last.y && abs(pu.z - P.z) < abs(P.z - pd.z));
  vec3 dx = useR ? pr - P : P - pl;
  vec3 dy = useU ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));

  // 4x4 interleaved rotation (Bayer order so neighbours differ a lot)
  const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  int bayer = BAYER[(ip.x & 3) + ((ip.y & 3) << 2)];
  float ang = float(bayer) * (6.2831853 / 16.0);
  float jit = float(bayer) / 16.0;

  float r2 = radius * radius;
  float occ = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) + jit) / float(SAMPLES);
    float a = ang + float(i) * 2.3999632;
    vec2 off = vec2(cos(a), sin(a)) * (rPx * pow(t, 1.5) + 1.0);
    vec3 Q = fetchPos(ip + ivec2(round(off)));
    vec3 v = Q - P;
    float vv = dot(v, v);
    float cosT = dot(v, N) * inversesqrt(vv + 1e-6);
    float fall = max(1.0 - vv / r2, 0.0);
    occ += max(cosT - 0.12, 0.0) * fall;
  }
  float ao = clamp(1.0 - intensity * occ / float(SAMPLES), 0.0, 1.0);
  o = vec4(mix(1.0, ao, fade), dist, 0.0, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tAO;
uniform vec2 size;
out vec4 o;
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 c = texelFetch(tAO, ip, 0).rg;
  float tol = c.y * 0.06 + 0.02;
  float s = 0.0, w = 0.0;
  for (int y = -2; y <= 1; y++)
    for (int x = -2; x <= 1; x++) {
      ivec2 q = clamp(ip + ivec2(x, y), ivec2(0), ivec2(size) - 1);
      vec2 t = texelFetch(tAO, q, 0).rg;
      float k = max(1.0 - abs(t.y - c.y) / tol, 0.0);
      s += t.x * k; w += k;
    }
  o = vec4(w > 1e-4 ? s / w : c.x, c.y, 0.0, 1.0);
}
`;

export const AO_GLSL = /* glsl */ `
uniform sampler2D aoTex;
uniform vec2 aoScale;
uniform vec2 aoSize;
uniform float aoEnabled;
uniform float aoFar;
uniform float aoDirect;
uniform float aoDebug;
float ssaoSample(float z) {
  vec2 hp = gl_FragCoord.xy * aoScale - 0.5;
  vec2 fb = floor(hp);
  vec2 f = hp - fb;
  ivec2 b = ivec2(fb);
  ivec2 mx = ivec2(aoSize) - 1;
  float s = 0.0, w = 0.0, best = 1.0, bestD = 1e9;
  float tol = z * 0.05 + 0.02;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec2 t = texelFetch(aoTex, clamp(b + o, ivec2(0), mx), 0).rg;
    vec2 bl = mix(1.0 - f, f, vec2(o));
    float dd = abs(t.y - z);
    float wt = bl.x * bl.y * max(1.0 - dd / tol, 0.0);
    s += t.x * wt; w += wt;
    if (dd < bestD) { bestD = dd; best = t.x; }
  }
  return w > 1e-4 ? s / w : best;
}
`;

export class SSAO {
  constructor(renderer, scene, { samples = 8, radius = 1.0, intensity = 2.6, direct = 0.2, maxPx = 48, fadeFar = 80 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.enabled = true; // user toggle (settings, debug panel)
    this.samples = samples; // quality preset, 0 = off
    this._compiled = Math.max(1, samples);
    this.rendered = false; // the materials only read the AO once a first frame exists
    this.depthFar = 0; // depth range another user (SSR) needs this frame, 0 = none
    this.depthReady = false; // the depth pre-pass ran this frame
    this.size = new THREE.Vector2(1, 1);
    this._full = new THREE.Vector2(-1, -1);
    // copy of the main camera with a short far plane (see the header)
    this.cam = new THREE.PerspectiveCamera();
    this.cam.matrixWorldAutoUpdate = false; // matrixWorld(Inverse) copied from the main camera

    this.depthRT = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      generateMipmaps: false,
    });
    this.depthRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.depthRT.depthTexture.format = THREE.DepthFormat;
    const rtOpts = {
      format: THREE.RGFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    };
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.blurRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    // same parameters as SunShadows.depthMatDouble: double-sided (leaves, open props), no fog
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

    this.aoMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: AO_FRAG.replace('%SAMPLES%', String(this._compiled)),
      uniforms: {
        tDepth: { value: this.depthRT.depthTexture },
        size: { value: this.size },
        projXY: { value: new THREE.Vector2() },
        cNear: { value: 0.1 },
        cFar: { value: 1000 },
        radius: { value: radius },
        intensity: { value: intensity },
        projScale: { value: 1 },
        maxPx: { value: maxPx },
        fadeFar: { value: fadeFar },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: { tAO: { value: this.aoRT.texture }, size: { value: this.size } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.aoMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.uniforms = {
      aoTex: { value: this.blurRT.texture },
      aoScale: { value: new THREE.Vector2(0.5, 0.5) },
      aoSize: { value: this.size },
      aoEnabled: { value: 0 },
      aoFar: this.aoMat.uniforms.fadeFar, // AO is 1 past this distance: no lookup
      aoDirect: { value: direct },
      aoDebug: { value: 0 }, // 1: show the AO term only
    };
  }

  /** Half the drawing buffer; called by render() whenever the canvas or the pixel ratio changes. */
  resize() {
    const full = this.renderer.getDrawingBufferSize(this._full);
    const w = Math.max(1, Math.round(full.x / 2)), h = Math.max(1, Math.round(full.y / 2));
    this.size.set(w, h);
    this.uniforms.aoScale.value.set(w / full.x, h / full.y);
    this.depthRT.setSize(w, h);
    this.aoRT.setSize(w, h);
    this.blurRT.setSize(w, h);
  }

  get active() { return this.enabled && this.samples > 0; }

  /** Tuning (environment.json `ao`): { intensity, radius (m), direct (0..1), distance (m) } */
  set({ intensity, radius, direct, distance } = {}) {
    const u = this.aoMat.uniforms;
    if (intensity != null) u.intensity.value = intensity;
    if (radius != null) u.radius.value = radius;
    if (distance != null) u.fadeFar.value = distance;
    if (direct != null) this.uniforms.aoDirect.value = direct;
  }

  setEnabled(on) {
    this.enabled = on;
    this._sync();
  }

  /** Samples per pixel (quality presets); 0 turns the AO off. */
  setSamples(n) {
    this.samples = n;
    if (n > 0 && n !== this._compiled) {
      this._compiled = n;
      this.aoMat.fragmentShader = AO_FRAG.replace('%SAMPLES%', String(n));
      this.aoMat.needsUpdate = true;
    }
    this._sync();
  }

  _sync() { this.uniforms.aoEnabled.value = this.active && this.rendered ? 1 : 0; }

  /** Render the AO for `camera` (right before the main view; world matrices up to date). */
  render(camera) {
    this.depthReady = false;
    if (!(this.active || this.depthFar > 0) || !camera.isPerspectiveCamera) return;
    const r = this.renderer, scene = this.scene;
    const full = r.getDrawingBufferSize(_v2);
    if (full.x !== this._full.x || full.y !== this._full.y) this.resize();

    // same view and projection as the main camera, short far plane
    const cam = this.cam;
    if (camera.parent === null) camera.updateMatrixWorld();
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.near = camera.near;
    cam.zoom = camera.zoom;
    cam.view = camera.view;
    cam.filmGauge = camera.filmGauge;
    cam.filmOffset = camera.filmOffset;
    cam.far = Math.min(camera.far, Math.max(this.active ? this.aoMat.uniforms.fadeFar.value * 1.1 : 0, this.depthFar));
    cam.updateProjectionMatrix();
    cam.matrixWorld.copy(camera.matrixWorld);
    cam.matrixWorldInverse.copy(camera.matrixWorldInverse);
    cam.layers.mask = camera.layers.mask & DEPTH_LAYERS;

    const prevTarget = r.getRenderTarget();
    const prevOverride = scene.overrideMaterial, prevFog = scene.fog, prevBg = scene.background;
    const autoClear = r.autoClear;
    r.autoClear = false;

    // 1. half-res depth pre-pass
    scene.overrideMaterial = this.depthMat;
    scene.fog = null;
    scene.background = null;
    r.setRenderTarget(this.depthRT);
    r.clear(true, true, false);
    r.render(scene, cam);
    scene.overrideMaterial = prevOverride;
    scene.fog = prevFog;
    scene.background = prevBg;
    this.depthReady = true;
    if (!this.active) {
      r.autoClear = autoClear;
      r.setRenderTarget(prevTarget);
      return;
    }

    // 2. AO
    const u = this.aoMat.uniforms;
    const pm = cam.projectionMatrix.elements;
    u.projXY.value.set(1 / pm[0], 1 / pm[5]);
    u.cNear.value = cam.near;
    u.cFar.value = cam.far;
    u.projScale.value = pm[5] * this.size.y * 0.5;
    this.quad.material = this.aoMat;
    r.setRenderTarget(this.aoRT);
    r.render(this.quadScene, this.quadCam);

    // 3. depth-aware 4x4 blur
    this.quad.material = this.blurMat;
    r.setRenderTarget(this.blurRT);
    r.render(this.quadScene, this.quadCam);

    r.autoClear = autoClear;
    r.setRenderTarget(prevTarget);
    if (!this.rendered) { this.rendered = true; this._sync(); }
  }

  /** Apply the (upsampled) AO to a built-in lit material. Call from onBeforeCompile. */
  inject(sh) {
    Object.assign(sh.uniforms, this.uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + AO_GLSL)
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        if (aoEnabled > 0.5) {
          float ssao = vViewPosition.z < aoFar ? ssaoSample(vViewPosition.z) : 1.0;
          reflectedLight.indirectDiffuse *= ssao;
          reflectedLight.indirectSpecular *= ssao;
          float ssaoD = mix(1.0, ssao, aoDirect);
          reflectedLight.directDiffuse *= ssaoD;
          reflectedLight.directSpecular *= ssaoD;
          if (aoDebug > 0.5) {
            reflectedLight.directDiffuse = vec3(ssao);
            reflectedLight.directSpecular = reflectedLight.indirectDiffuse = reflectedLight.indirectSpecular = vec3(0.0);
            totalEmissiveRadiance = vec3(0.0);
          }
        }`,
      );
  }

  dispose() {
    this.depthRT.dispose();
    this.aoRT.dispose();
    this.blurRT.dispose();
    this.depthMat.dispose();
    this.aoMat.dispose();
    this.blurMat.dispose();
    this.quad.geometry.dispose();
  }
}

const _v2 = new THREE.Vector2();
