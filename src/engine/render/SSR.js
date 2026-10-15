// Screen-space reflections on the water (ocean + rivers). Their own setting, independent of the
// quality preset: off (default), ultra low, low, medium or high (SSR_LEVELS: steps per ray, depth range,
// longest ray), plus a blur (glossy reflections, wider the farther the hit).
//
// Built to cost as little as possible on top of what the frame already does:
//   - no extra geometry pass: the rays march through the half-res depth pre-pass of SSAO.js
//     (STATIC + DYNAMIC layers). While SSR is on, that pre-pass reaches `distance` metres instead
//     of stopping where the AO fades out, and it runs even when the AO itself is switched off;
//   - no extra colour pass and no copy: while SSR is on, the engine draws the frame into one of
//     two frame targets in turn (Engine.js), so the reflected colour is simply the previous
//     frame's target, reprojected to this frame's view with the previous view-projection matrix;
//   - only water pixels trace: the march lives in the water shader (Water.js), behind a uniform
//     switch, so the same program serves every quality preset (nothing compiles late) and the
//     rest of the frame pays nothing. Per pixel: `steps` depth fetches spread along the ray in
//     screen space (denser near the start, jittered per pixel), then a short binary refinement;
//     the level only changes uniforms (the loops break on them), so switching never recompiles.
// The previous frame is already tone mapped, so the water blends it in after its own tone mapping,
// in display space, in place of its sky reflection (Fresnel x hit confidence). A ray that leaves
// the screen, finds nothing within `ray` metres, or points back at the camera fades back to the
// sky reflection.
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, Break, uniform, texture, vec2, vec3, vec4, float, ivec2, mix, sqrt, abs, cos, sin, clamp, min, fract, dot, smoothstep, select, renderGroup } from 'three/tsl';

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
    this.valid = false; // a previous frame exists (ssrColor)
    this._prevViewProj = new THREE.Matrix4();
    const placeholder = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    placeholder.minFilter = placeholder.magFilter = THREE.LinearFilter;
    placeholder.needsUpdate = true;
    const u = (v) => uniform(v).setGroup(renderGroup);
    this.uniforms = {
      ssrColor: texture(placeholder),
      ssrDepth: texture(ao.depthRT.depthTexture),
      ssrOn: u(0),
      ssrIntensity: u(1),
      ssrNear: u(0.1),
      ssrFar: u(100),
      ssrRay: u(100),
      ssrSteps: u(1),
      ssrRefine: u(0),
      ssrBlur: u(SSR_DEFAULTS.ssr.blur),
      ssrDebug: u(0), // 1: water shows the reflection colour x confidence only
      ssrProjXY: u(new THREE.Vector2(1, 1)),
      ssrReproj: u(new THREE.Matrix4()), // this frame's view space -> previous frame's clip space
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

  /** End of the frame (everything drawn into `rt`, the engine's frame target): the next frame
   *  reflects it. rt null (SSR off, or drawn straight into the canvas): nothing to reflect. */
  endFrame(camera, rt) {
    if (!this.active || !rt || !camera.isPerspectiveCamera) { this.valid = false; return; }
    this.uniforms.ssrColor.value = rt.texture;
    this._prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.valid = true;
  }

  /**
   * Water fragment code: Fn(view pos, view dir, jitter) -> vec4(display rgb, confidence).
   * Screen uvs run down the texture (WebGPU convention; three flips them for WebGL).
   */
  traceNode() {
    if (this._trace) return this._trace;
    const U = this.uniforms, A = this.ao.uniforms;
    const viewZ = (d) => U.ssrNear.mul(U.ssrFar).div(U.ssrFar.sub(U.ssrNear).mul(d).sub(U.ssrFar));
    const toUv = (p) => {
      const n = p.xy.div(p.z.negate().mul(U.ssrProjXY));
      return vec2(n.x.mul(0.5).add(0.5), n.y.mul(-0.5).add(0.5));
    };
    const depthAt = (uv) => U.ssrDepth.load(ivec2(clamp(uv, 0, 0.9999).mul(A.aoSize)));
    this._trace = Fn(([P, D, jit]) => {
      const out = vec4(0).toVar();
      // water past the depth range (most of the sea): no work
      If(P.z.negate().lessThanEqual(U.ssrFar), () => {
        const len = U.ssrRay.toVar();
        If(D.z.greaterThan(0), () => { len.assign(min(len, P.z.negate().sub(U.ssrNear.mul(4)).div(D.z))); }); // stop before the near plane
        If(len.greaterThanEqual(0.5), () => {
          const E = P.add(D.mul(len));
          const s0 = toUv(P).toVar(), s1 = toUv(E).toVar();
          const k0 = float(-1).div(P.z), k1 = float(-1).div(E.z); // 1/w is linear in screen space
          // clip the segment to the screen
          const ds = s1.sub(s0);
          const tEnd = float(1).toVar();
          If(ds.x.greaterThan(1e-5), () => { tEnd.assign(min(tEnd, s0.x.oneMinus().div(ds.x))); }).ElseIf(ds.x.lessThan(-1e-5), () => { tEnd.assign(min(tEnd, s0.x.negate().div(ds.x))); });
          If(ds.y.greaterThan(1e-5), () => { tEnd.assign(min(tEnd, s0.y.oneMinus().div(ds.y))); }).ElseIf(ds.y.lessThan(-1e-5), () => { tEnd.assign(min(tEnd, s0.y.negate().div(ds.y))); });
          const tPrev = float(0).toVar(), zPrev = P.z.toVar();
          Loop({ start: 1, end: MAX_STEPS, condition: '<=' }, ({ i }) => {
            If(float(i).greaterThan(U.ssrSteps), () => { Break(); });
            const f = float(i).sub(jit).div(U.ssrSteps);
            const t = tEnd.mul(f).mul(sqrt(f)).toVar(); // denser near the start: the base of what stands on the water
            const rz = float(-1).div(mix(k0, k1, t)).toVar();
            const d = depthAt(mix(s0, s1, t));
            const sz = select(d.lessThan(1), viewZ(d), float(-1e6));
            const behind = sz.sub(rz); // > 0: the ray went behind the surface stored at this pixel
            // generous: a ray that slips behind a tree crown between two steps went through it
            const thick = abs(rz.sub(zPrev)).mul(1.5).add(0.5).sub(rz.mul(0.06));
            If(behind.greaterThan(0).and(behind.lessThan(thick)), () => {
              // refine between the last point in front and this one
              const a = tPrev.toVar(), b = t.toVar();
              Loop(MAX_REFINE, ({ i: j }) => {
                If(float(j).greaterThanEqual(U.ssrRefine), () => { Break(); });
                const mid = a.add(b).mul(0.5);
                const mz = float(-1).div(mix(k0, k1, mid));
                const md = depthAt(mix(s0, s1, mid));
                If(md.lessThan(1).and(viewZ(md).greaterThan(mz)), () => { b.assign(mid); }).Else(() => { a.assign(mid); });
              });
              const Hz = float(-1).div(mix(k0, k1, b));
              const Hs = mix(s0, s1, b);
              const Hv = vec3(vec2(Hs.x.mul(2).sub(1), Hs.y.mul(-2).add(1)).mul(U.ssrProjXY).mul(Hz.negate()), Hz);
              const pc = U.ssrReproj.mul(vec4(Hv, 1)).toVar();
              const n = pc.xy.div(pc.w);
              const puv = vec2(n.x.mul(0.5).add(0.5), n.y.mul(-0.5).add(0.5)).toVar();
              If(pc.w.greaterThan(0).and(puv.x.greaterThanEqual(0)).and(puv.y.greaterThanEqual(0)).and(puv.x.lessThanEqual(1)).and(puv.y.lessThanEqual(1)), () => {
                const edge = smoothstep(vec2(0), vec2(0.07), puv).mul(smoothstep(vec2(0), vec2(0.07), puv.oneMinus()));
                const conf = edge.x.mul(edge.y).toVar();
                const hitDist = len.mul(b).mul(k1).div(mix(k0, k1, b));
                conf.mulAssign(float(1).sub(smoothstep(0.6, 1, hitDist.div(U.ssrRay)))); // long rays fade out
                conf.mulAssign(float(1).sub(smoothstep(0.1, 0.6, D.z))); // rays toward the camera: little on screen to hit
                const c = U.ssrColor.sample(puv).level(0).rgb.toVar();
                If(U.ssrBlur.greaterThan(0), () => {
                  // glossy: 4 more taps around the hit (rotated per pixel), wider the farther the hit
                  const rad = U.ssrBlur.mul(float(0.002).add(clamp(hitDist.div(60), 0, 1).mul(0.035)));
                  const ax = vec2(rad.mul(U.ssrProjXY.y).div(U.ssrProjXY.x), rad);
                  const a0 = jit.mul(6.2831853);
                  for (let k = 0; k < 4; k++) {
                    const ang = a0.add(k * 1.5707963);
                    c.addAssign(U.ssrColor.sample(clamp(puv.add(vec2(cos(ang), sin(ang)).mul(ax)), 0, 1)).level(0).rgb);
                  }
                  c.mulAssign(0.2);
                });
                out.assign(vec4(c, conf));
              });
              Break();
            });
            tPrev.assign(t);
            zPrev.assign(rz);
          });
        });
      });
      return out;
    });
    return this._trace;
  }

  /** Interleaved gradient noise of a pixel (ray jitter). */
  static ign(p) { return fract(fract(dot(p, vec2(0.06711056, 0.00583715))).mul(52.9829189)); }

  dispose() {}
}
