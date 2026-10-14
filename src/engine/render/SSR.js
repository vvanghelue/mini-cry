// Screen-space reflections on the water (ocean + rivers). Their own setting, independent of the
// quality preset: off (default), ultra low, low, medium or high (SSR_LEVELS: steps per ray, depth range,
// longest ray), plus a blur (glossy reflections, wider the farther the hit).
//
// Built to cost as little as possible on top of what the frame already does:
//   - no extra geometry pass: the rays march through the half-res depth pre-pass of SSAO.js
//     (STATIC + DYNAMIC layers). While SSR is on, that pre-pass reaches `distance` metres instead
//     of stopping where the AO fades out, and it runs even when the AO itself is switched off;
//   - no extra colour pass: the reflected colour is the previous frame, copied from the canvas at
//     the very end of the frame (one copy, after the canvas pass is over, so the tile GPU doesn't
//     have to store and reload the multisampled buffers mid-frame), reprojected to this frame's
//     view with the previous view-projection matrix;
//   - only water pixels trace: the march lives in the water shader (Water.js), behind a uniform
//     switch, so the same program serves every quality preset (nothing compiles late) and the
//     rest of the frame pays nothing. Per pixel: `steps` depth fetches spread along the ray in
//     screen space (denser near the start, jittered per pixel), then a short binary refinement;
//     the level only changes uniforms (the loops break on them), so switching never recompiles.
// The copied frame is already tone mapped, so the water blends it in after its own tone mapping,
// in display space, in place of its sky reflection (Fresnel x hit confidence). A ray that leaves
// the screen, finds nothing within `ray` metres, or points back at the camera fades back to the
// sky reflection.
import * as THREE from 'three';

export const SSR_DEFAULTS = {
  // screen-space reflections on the water: strength, blur (0 = mirror .. 1 = very glossy)
  ssr: { intensity: 1, blur: 0.25 },
};

// steps / refine: depth fetches per ray; distance: depth range of the pre-pass (m), ray: longest ray (m)
export const SSR_LEVELS = {
  // ultra low: about the AO's own depth range (no extra pre-pass cost while the AO is on), no blur taps
  ultralow: { steps: 8, refine: 2, distance: 90, ray: 100, noBlur: true },
  low: { steps: 12, refine: 3, distance: 140, ray: 150 },
  medium: { steps: 20, refine: 4, distance: 220, ray: 230 },
  high: { steps: 32, refine: 6, distance: 300, ray: 320 },
};

const MAX_STEPS = 32;
const MAX_REFINE = 6;

/** Fragment code for the water shader: ssrTrace(view pos, view dir, jitter) -> (display rgb, confidence). */
export const SSR_GLSL = /* glsl */ `
uniform sampler2D ssrColor, ssrDepth;
uniform float ssrOn, ssrIntensity, ssrNear, ssrFar, ssrRay, ssrDebug, ssrSteps, ssrRefine, ssrBlur;
uniform vec2 ssrProjXY;
uniform mat4 ssrReproj; // this frame's view space -> previous frame's clip space
float ssrViewZ(float d) { return (ssrNear * ssrFar) / ((ssrFar - ssrNear) * d - ssrFar); }
vec2 ssrUv(vec3 p) { return p.xy / (-p.z * ssrProjXY) * 0.5 + 0.5; }
float ssrIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec4 ssrTrace(vec3 P, vec3 D, float jit) {
  if (-P.z > ssrFar) return vec4(0.0); // water past the depth range (most of the sea): no work
  float len = ssrRay;
  if (D.z > 0.0) len = min(len, (-P.z - ssrNear * 4.0) / D.z); // stop before the near plane
  if (len < 0.5) return vec4(0.0);
  vec3 E = P + D * len;
  vec2 s0 = ssrUv(P), s1 = ssrUv(E);
  float k0 = -1.0 / P.z, k1 = -1.0 / E.z; // 1/w is linear in screen space
  // clip the segment to the screen
  vec2 ds = s1 - s0;
  float tEnd = 1.0;
  if (ds.x > 1e-5) tEnd = min(tEnd, (1.0 - s0.x) / ds.x); else if (ds.x < -1e-5) tEnd = min(tEnd, -s0.x / ds.x);
  if (ds.y > 1e-5) tEnd = min(tEnd, (1.0 - s0.y) / ds.y); else if (ds.y < -1e-5) tEnd = min(tEnd, -s0.y / ds.y);
  float tPrev = 0.0, zPrev = P.z;
  for (int i = 1; i <= ${MAX_STEPS}; i++) {
    if (float(i) > ssrSteps) break;
    float f = (float(i) - jit) / ssrSteps;
    float t = tEnd * f * sqrt(f); // denser near the start: the base of what stands on the water
    float rz = -1.0 / mix(k0, k1, t);
    float d = texture2D(ssrDepth, mix(s0, s1, t)).x;
    float sz = d < 1.0 ? ssrViewZ(d) : -1e6;
    float behind = sz - rz; // > 0: the ray went behind the surface stored at this pixel
    // generous: a ray that slips behind a tree crown between two steps went through it
    float thick = abs(rz - zPrev) * 1.5 + 0.5 - rz * 0.06;
    if (behind > 0.0 && behind < thick) {
      // refine between the last point in front and this one
      float a = tPrev, b = t;
      for (int j = 0; j < ${MAX_REFINE}; j++) {
        if (float(j) >= ssrRefine) break;
        float m = 0.5 * (a + b);
        float mz = -1.0 / mix(k0, k1, m);
        float md = texture2D(ssrDepth, mix(s0, s1, m)).x;
        if (md < 1.0 && ssrViewZ(md) > mz) b = m; else a = m;
      }
      vec3 H = vec3(mix(s0, s1, b), -1.0 / mix(k0, k1, b));
      vec3 Hv = vec3((H.xy * 2.0 - 1.0) * ssrProjXY * -H.z, H.z);
      vec4 pc = ssrReproj * vec4(Hv, 1.0);
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      if (pc.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) return vec4(0.0);
      vec2 edge = smoothstep(vec2(0.0), vec2(0.07), puv) * smoothstep(vec2(0.0), vec2(0.07), 1.0 - puv);
      float conf = edge.x * edge.y;
      float hitDist = len * b * k1 / mix(k0, k1, b);
      conf *= 1.0 - smoothstep(0.6, 1.0, hitDist / ssrRay); // long rays fade out
      conf *= 1.0 - smoothstep(0.1, 0.6, D.z); // rays toward the camera: little on screen to hit
      vec3 col = texture2D(ssrColor, puv).rgb;
      if (ssrBlur > 0.0) {
        // glossy: 4 more taps around the hit (rotated per pixel), wider the farther the hit
        float rad = ssrBlur * (0.002 + 0.035 * clamp(hitDist / 60.0, 0.0, 1.0));
        vec2 ax = vec2(rad * ssrProjXY.y / ssrProjXY.x, rad);
        float a0 = jit * 6.2831853;
        for (int k = 0; k < 4; k++) {
          float a = a0 + float(k) * 1.5707963;
          col += texture2D(ssrColor, clamp(puv + vec2(cos(a), sin(a)) * ax, 0.0, 1.0)).rgb;
        }
        col *= 0.2;
      }
      return vec4(col, conf);
    }
    tPrev = t; zPrev = rz;
  }
  return vec4(0.0);
}
`;

export class SSR {
  /** @param ao the SSAO instance whose depth pre-pass the rays march through */
  constructor(renderer, ao) {
    this.renderer = renderer;
    this.ao = ao;
    this.level = 'off'; // off | ultralow | low | medium | high (settings, debug panel, ?ssr=<level>)
    this.distance = 0;
    this.blur = SSR_DEFAULTS.ssr.blur;
    this.camera = null;
    this.valid = false; // a previous frame exists in colorTex
    this.colorTex = new THREE.FramebufferTexture(1, 1);
    this.colorTex.minFilter = this.colorTex.magFilter = THREE.LinearFilter;
    this.colorTex.generateMipmaps = false;
    this._full = new THREE.Vector2();
    this._prevViewProj = new THREE.Matrix4();
    this.uniforms = {
      ssrColor: { value: this.colorTex },
      ssrDepth: { value: ao.depthRT.depthTexture },
      ssrOn: { value: 0 },
      ssrIntensity: { value: 1 },
      ssrNear: { value: 0.1 },
      ssrFar: { value: 100 },
      ssrRay: { value: 100 },
      ssrSteps: { value: 1 },
      ssrRefine: { value: 0 },
      ssrBlur: { value: SSR_DEFAULTS.ssr.blur },
      ssrDebug: { value: 0 }, // 1: water shows the reflection colour x confidence only
      ssrProjXY: { value: new THREE.Vector2(1, 1) },
      ssrReproj: { value: new THREE.Matrix4() },
    };
  }

  get active() { return this.level !== 'off'; }

  /** 'off' | 'ultralow' | 'low' | 'medium' | 'high' (anything else = off; true = medium for old settings). */
  setLevel(name) {
    if (name === true) name = 'medium';
    const L = SSR_LEVELS[name];
    this.level = L ? name : 'off';
    if (!L) { this.valid = false; return; }
    const u = this.uniforms;
    u.ssrSteps.value = L.steps;
    u.ssrRefine.value = L.refine;
    u.ssrRay.value = L.ray;
    u.ssrBlur.value = L.noBlur ? 0 : this.blur;
    this.distance = L.distance;
  }

  /** Tuning (environment.json `ssr`): { intensity, blur (0..1) }; distance / ray (m) override the level's until the next setLevel. */
  set({ intensity, blur, distance, ray } = {}) {
    if (intensity != null) this.uniforms.ssrIntensity.value = intensity;
    if (blur != null) { this.blur = blur; this.uniforms.ssrBlur.value = SSR_LEVELS[this.level]?.noBlur ? 0 : blur; }
    if (distance != null) this.distance = distance;
    if (ray != null) this.uniforms.ssrRay.value = ray;
  }

  /** Before the SSAO pre-pass: how far its depth must reach for the rays. */
  beforeDepth() { this.ao.depthFar = this.active ? this.distance : 0; }

  /** After the SSAO pre-pass (this frame's depth is ready), before the main view. */
  update(camera) {
    const u = this.uniforms;
    const on = this.active && this.valid && this.ao.depthReady && camera.isPerspectiveCamera;
    u.ssrOn.value = on ? 1 : 0;
    if (!on) return;
    const c = this.ao.cam, pm = c.projectionMatrix.elements;
    u.ssrNear.value = c.near;
    u.ssrFar.value = c.far;
    u.ssrProjXY.value.set(1 / pm[0], 1 / pm[5]);
    u.ssrReproj.value.multiplyMatrices(this._prevViewProj, camera.matrixWorld);
  }

  /** End of the frame (everything drawn): keep the canvas for the next frame's reflections. */
  grab(camera) {
    if (!this.active || !camera.isPerspectiveCamera) { this.valid = false; return; }
    const r = this.renderer;
    if (r.getRenderTarget() !== null) return;
    const full = r.getDrawingBufferSize(this._full);
    const img = this.colorTex.image;
    if (img.width !== full.x || img.height !== full.y) {
      // a FramebufferTexture is allocated once at its size: resizing needs a new one
      this.colorTex.dispose();
      this.colorTex = new THREE.FramebufferTexture(full.x, full.y);
      this.colorTex.minFilter = this.colorTex.magFilter = THREE.LinearFilter;
      this.colorTex.generateMipmaps = false;
      this.uniforms.ssrColor.value = this.colorTex;
    }
    r.copyFramebufferToTexture(this.colorTex);
    this._prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.valid = true;
  }

  dispose() { this.colorTex.dispose(); }
}
