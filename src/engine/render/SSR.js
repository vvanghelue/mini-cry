// Screen-space reflections on the water (ocean + rivers). Their own setting, independent of the
// quality preset: off (default), ultra low, low, medium or high (SSR_LEVELS: steps per ray, depth range,
// longest ray), plus a blur (glossy reflections, wider the farther the hit).
//
// Built to cost as little as possible on top of what the frame already does:
//   - no extra geometry pass: the rays march through the half-res depth pre-pass of SSAO.js
//     (STATIC + DYNAMIC layers). While SSR is on, that pre-pass reaches `distance` metres instead
//     of stopping where the AO fades out, and it runs even when the AO itself is switched off;
//   - no extra colour pass: the reflected colour is the previous frame, copied from the canvas at
//     the very end of the frame, reprojected to this frame's view with the previous
//     view-projection matrix;
//   - only water pixels trace: the march lives in the water shader (Water.js), behind a uniform
//     switch, so the same program serves every quality preset (nothing compiles late) and the
//     rest of the frame pays nothing. Per pixel: `steps` depth fetches spread along the ray in
//     screen space (denser near the start, jittered per pixel), then a short binary refinement;
//     the level only changes uniforms (the loops break on them), so switching never recompiles.
// The copied frame is already tone mapped, so the water blends it in after its own tone mapping,
// in display space, in place of its sky reflection (Fresnel x hit confidence). A ray that leaves
// the screen, finds nothing within `ray` metres, or points back at the camera fades back to the
// sky reflection.
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, Break, float, int, ivec2, vec2, vec3, vec4, min, sqrt, mix, cos, sin, fract, dot, clamp, smoothstep, texture, select } from 'three/tsl';
import { U, ndcToUv, tex } from './tsl.js';

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
    this.colorTex = this._colorTex(1, 1);
    this._full = new THREE.Vector2();
    this._prevViewProj = new THREE.Matrix4();
    this.uniforms = {
      ssrColor: tex(this.colorTex),
      ssrDepth: tex(ao.depthRT.depthTexture),
      ssrDepthSize: ao.u.size,
      ssrOn: U(0),
      ssrIntensity: U(1),
      ssrNear: U(0.1),
      ssrFar: U(100),
      ssrRay: U(100),
      ssrSteps: U(1),
      ssrRefine: U(0),
      ssrBlur: U(SSR_DEFAULTS.ssr.blur),
      ssrDebug: U(0), // 1: water shows the reflection colour x confidence only
      ssrProjXY: U(new THREE.Vector2(1, 1)),
      ssrReproj: U(new THREE.Matrix4()), // this frame's view space -> previous frame's clip space
    };
    this.traceFn = this._traceFn();
  }

  _colorTex(w, h) {
    const t = new THREE.FramebufferTexture(w, h);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
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

  /** End of the frame (everything drawn): keep the frame for the next frame's reflections. target:
   *  the render target the frame went to (FXAA), else the canvas. */
  grab(camera, target = null) {
    if (!this.active || !camera.isPerspectiveCamera) { this.valid = false; return; }
    const r = this.renderer;
    const full = target ? _v2.set(target.width, target.height) : r.getDrawingBufferSize(this._full);
    const img = this.colorTex.image;
    if (img.width !== full.x || img.height !== full.y) {
      // a FramebufferTexture is allocated once at its size: resizing needs a new one
      this.colorTex.dispose();
      this.colorTex = this._colorTex(full.x, full.y);
      this.uniforms.ssrColor.value = this.colorTex;
    }
    if (target) {
      r.setRenderTarget(target);
      r.copyFramebufferToTexture(this.colorTex);
    } else {
      // the canvas, after its last pass: three only copies inside a render context, so straight
      // from the backend (WebGPU: the canvas texture stays valid until the frame is presented)
      if (!r.backend.isWebGPUBackend) { this.valid = false; return; }
      r.initTexture(this.colorTex);
      r.backend.copyFramebufferToTexture(this.colorTex, (this._canvasCtx ??= { renderTarget: null }), _rect.set(0, 0, full.x, full.y));
    }
    this._prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.valid = true;
  }

  /** fn(P view position, D view direction, jitter) -> vec4(display rgb, confidence). */
  _traceFn() {
    const u = this.uniforms;
    const viewZ = (d) => u.ssrNear.mul(u.ssrFar).div(u.ssrFar.sub(u.ssrNear).mul(d).sub(u.ssrFar));
    // view position -> texture uv (rows run down)
    const toUv = (p) => ndcToUv(p.xy.div(p.z.negate().mul(u.ssrProjXY)));
    const depthAt = (uv) => u.ssrDepth.load(ivec2(clamp(uv, 0.0, 0.9999).mul(u.ssrDepthSize))).x;
    return Fn(([P, D, jit]) => {
      const res = vec4(0.0).toVar();
      If(P.z.negate().lessThanEqual(u.ssrFar), () => { // water past the depth range (most of the sea): no work
        const len = u.ssrRay.toVar();
        If(D.z.greaterThan(0.0), () => { len.assign(min(len, P.z.negate().sub(u.ssrNear.mul(4.0)).div(D.z))); }); // stop before the near plane
        If(len.greaterThanEqual(0.5), () => {
          const E = P.add(D.mul(len)).toVar();
          const s0 = toUv(P).toVar(), s1 = toUv(E).toVar();
          const k0 = float(-1.0).div(P.z).toVar(), k1 = float(-1.0).div(E.z).toVar(); // 1/w is linear in screen space
          // clip the segment to the screen
          const ds = s1.sub(s0).toVar();
          const tEnd = float(1.0).toVar();
          If(ds.x.greaterThan(1e-5), () => { tEnd.assign(min(tEnd, s0.x.oneMinus().div(ds.x))); }).ElseIf(ds.x.lessThan(-1e-5), () => { tEnd.assign(min(tEnd, s0.x.negate().div(ds.x))); });
          If(ds.y.greaterThan(1e-5), () => { tEnd.assign(min(tEnd, s0.y.oneMinus().div(ds.y))); }).ElseIf(ds.y.lessThan(-1e-5), () => { tEnd.assign(min(tEnd, s0.y.negate().div(ds.y))); });
          const tPrev = float(0.0).toVar(), zPrev = P.z.toVar();
          Loop({ start: int(1), end: int(MAX_STEPS + 1) }, ({ i }) => {
            If(float(i).greaterThan(u.ssrSteps), () => { Break(); });
            const f = float(i).sub(jit).div(u.ssrSteps);
            const t = tEnd.mul(f).mul(sqrt(f)).toVar(); // denser near the start: the base of what stands on the water
            const rz = float(-1.0).div(mix(k0, k1, t)).toVar();
            const d = depthAt(mix(s0, s1, t)).toVar();
            const sz = select(d.lessThan(1.0), viewZ(d), float(-1e6));
            const behind = sz.sub(rz).toVar(); // > 0: the ray went behind the surface stored at this pixel
            // generous: a ray that slips behind a tree crown between two steps went through it
            const thick = rz.sub(zPrev).abs().mul(1.5).add(0.5).sub(rz.mul(0.06));
            If(behind.greaterThan(0.0).and(behind.lessThan(thick)), () => {
              // refine between the last point in front and this one
              const a = tPrev.toVar(), b = t.toVar();
              Loop({ start: int(0), end: int(MAX_REFINE) }, ({ i: j }) => {
                If(float(j).greaterThanEqual(u.ssrRefine), () => { Break(); });
                const mm = a.add(b).mul(0.5).toVar();
                const mz = float(-1.0).div(mix(k0, k1, mm));
                const md = depthAt(mix(s0, s1, mm)).toVar();
                If(md.lessThan(1.0).and(viewZ(md).greaterThan(mz)), () => { b.assign(mm); }).Else(() => { a.assign(mm); });
              });
              const Huv = mix(s0, s1, b).toVar();
              const Hz = float(-1.0).div(mix(k0, k1, b)).toVar();
              const Hv = vec3(vec2(Huv.x.mul(2.0).sub(1.0), Huv.y.mul(-2.0).add(1.0)).mul(u.ssrProjXY).mul(Hz.negate()), Hz);
              const pc = u.ssrReproj.mul(vec4(Hv, 1.0)).toVar();
              const puv = ndcToUv(pc.xy.div(pc.w)).toVar();
              If(pc.w.greaterThan(0.0).and(puv.x.greaterThanEqual(0.0)).and(puv.y.greaterThanEqual(0.0)).and(puv.x.lessThanEqual(1.0)).and(puv.y.lessThanEqual(1.0)), () => {
                const edge = smoothstep(vec2(0.0), vec2(0.07), puv).mul(smoothstep(vec2(0.0), vec2(0.07), puv.oneMinus()));
                const hitDist = len.mul(b).mul(k1).div(mix(k0, k1, b));
                const conf = edge.x.mul(edge.y)
                  .mul(float(1.0).sub(smoothstep(0.6, 1.0, hitDist.div(u.ssrRay)))) // long rays fade out
                  .mul(float(1.0).sub(smoothstep(0.1, 0.6, D.z))); // rays toward the camera: little on screen to hit
                const col = u.ssrColor.sample(puv).rgb.toVar();
                If(u.ssrBlur.greaterThan(0.0), () => {
                  // glossy: 4 more taps around the hit (rotated per pixel), wider the farther the hit
                  const rad = u.ssrBlur.mul(clamp(hitDist.div(60.0), 0.0, 1.0).mul(0.035).add(0.002));
                  const ax = vec2(rad.mul(u.ssrProjXY.y).div(u.ssrProjXY.x), rad);
                  const a0 = jit.mul(6.2831853);
                  for (let k = 0; k < 4; k++) {
                    const ang = a0.add(k * 1.5707963);
                    col.addAssign(u.ssrColor.sample(clamp(puv.add(vec2(cos(ang), sin(ang)).mul(ax)), 0.0, 1.0)).rgb);
                  }
                  col.mulAssign(0.2);
                });
                res.assign(vec4(col, conf));
              });
              Break();
            });
            tPrev.assign(t);
            zPrev.assign(rz);
          });
        });
      });
      return res;
    });
  }

  /** Interleaved gradient noise (per-pixel jitter). */
  static ign(p) { return fract(dot(p, vec2(0.06711056, 0.00583715)).fract().mul(52.9829189)); }

  dispose() { this.colorTex.dispose(); }
}

const _v2 = new THREE.Vector2(), _rect = new THREE.Vector4();
