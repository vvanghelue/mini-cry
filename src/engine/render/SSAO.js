// Screen-space ambient occlusion (ported from three-rigged-game/src/lighting/ao.js), tuned for
// speed and a clean (noise-free, halo-free) result.
//
// Everything runs at half resolution:
//   1. depth pre-pass of the STATIC + DYNAMIC layers (no grass, water, FX) through a copy of the
//      main camera whose far plane stops where the AO has faded out (fadeFar), so the distant
//      world is frustum-culled and costs nothing. Same depth material as the shadow cascades;
//   2. AO pass: view-space position rebuilt from depth, normal rebuilt from depth (picking the
//      smaller neighbour delta so edges don't smear), N samples on a golden-angle spiral rotated
//      by a 4x4 interleaved pattern. A range falloff kills occluders far away from the receiver,
//      so there is no dark halo around foreground objects;
//   3. one 4x4 depth-aware blur: every 4x4 window contains all 16 rotations of the pattern, so it
//      removes the pattern noise completely (no temporal accumulation, no ghosting).
// The result (AO + linear depth) is read back in the lit materials (Lighting.js aoNode) with a
// depth-aware bilateral upsample and applied to the indirect light, plus a small share of the
// direct sun. Surfaces missing from the pre-pass (grass) take the AO of the closest depth around
// them, i.e. the ground they stand on.
// The water's screen-space reflections (SSR.js) march through the same depth: while they are on,
// the pre-pass reaches `depthFar` and runs even with the AO switched off.
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, float, int, ivec2, vec2, vec3, vec4, max, min, abs, clamp, mix, cos, sin, pow, round, normalize, cross, dot, inverseSqrt, smoothstep, select, texture, screenCoordinate, positionView } from 'three/tsl';
import { LAYERS } from './layers.js';
import { U, bayer4i } from './tsl.js';
import { lodPassMode } from './LodFade.js';

const DEPTH_LAYERS = (1 << LAYERS.STATIC) | (1 << LAYERS.DYNAMIC) | (1 << LAYERS.OCCLUDER);

export class SSAO {
  constructor(renderer, scene, { samples = 8, radius = 1.0, intensity = 2.6, direct = 0.2, maxPx = 48, fadeFar = 80 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.enabled = true; // user toggle (settings, debug panel)
    this.samples = samples; // quality preset, 0 = off
    this.rendered = false; // the materials only read the AO once a first frame exists
    this.depthFar = 0; // depth range another user (SSR) needs this frame, 0 = none
    this.depthReady = false; // the depth pre-pass ran this frame
    this.size = new THREE.Vector2(1, 1);
    this._full = new THREE.Vector2(-1, -1);
    // copy of the main camera with a short far plane (see the header)
    this.cam = new THREE.PerspectiveCamera();
    this.cam.matrixWorldAutoUpdate = false; // matrixWorld(Inverse) copied from the main camera

    this.depthRT = new THREE.RenderTarget(1, 1, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false });
    this.depthRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.depthRT.depthTexture.format = THREE.DepthFormat;
    const rtOpts = { format: THREE.RGFormat, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.aoRT = new THREE.RenderTarget(1, 1, rtOpts);
    this.blurRT = new THREE.RenderTarget(1, 1, rtOpts);
    this.depthMat = null; // the shared depth material (Lighting: SunShadows.depthMat)

    this.u = {
      size: U(this.size),
      projXY: U(new THREE.Vector2()),
      cNear: U(0.1),
      cFar: U(1000),
      radius: U(radius),
      intensity: U(intensity),
      projScale: U(1),
      maxPx: U(maxPx),
      fadeFar: U(fadeFar),
      samples: U(Math.max(1, samples)),
    };
    this.tDepth = texture(this.depthRT.depthTexture);
    this.tAO = texture(this.aoRT.texture);
    this.aoQuad = new THREE.QuadMesh(this._aoMaterial());
    this.blurQuad = new THREE.QuadMesh(this._blurMaterial());

    this.uniforms = {
      aoTex: texture(this.blurRT.texture),
      aoScale: U(new THREE.Vector2(0.5, 0.5)),
      aoSize: this.u.size,
      aoEnabled: U(0),
      aoFar: this.u.fadeFar, // AO is 1 past this distance: no lookup
      aoDirect: U(direct),
      aoDebug: U(0), // 1: show the AO term only
    };
    this.sampleFn = this._sampleFn();
  }

  _viewZ(d) { return this.u.cNear.mul(this.u.cFar).div(this.u.cFar.sub(this.u.cNear).mul(d).sub(this.u.cFar)); }

  _aoMaterial() {
    const u = this.u, tDepth = this.tDepth;
    const viewPos = (p, d) => {
      const uv = vec2(p).add(0.5).div(u.size);
      const z = this._viewZ(d);
      // pixel rows run down (WebGPU): view y up
      return vec3(vec2(uv.x.mul(2.0).sub(1.0), uv.y.mul(-2.0).add(1.0)).mul(u.projXY).mul(z.negate()), z);
    };
    const fetchPos = (p) => {
      const q = p.clamp(ivec2(0), ivec2(u.size).sub(1));
      return viewPos(q, tDepth.load(q).x);
    };
    const m = new THREE.NodeMaterial();
    m.fragmentNode = Fn(() => {
      const ip = ivec2(screenCoordinate.xy).toVar();
      const d = tDepth.load(ip).x.toVar();
      const out = vec4(1.0, u.cFar, 0.0, 1.0).toVar();
      If(d.lessThan(1.0), () => {
        const P = viewPos(ip, d).toVar();
        const dist = P.z.negate();
        const rPx = u.radius.mul(u.projScale).div(dist).toVar();
        const fade = float(1.0).sub(smoothstep(u.fadeFar.mul(0.6), u.fadeFar, dist)).toVar();
        out.assign(vec4(1.0, dist, 0.0, 1.0));
        If(rPx.greaterThanEqual(1.0).and(fade.greaterThan(0.0)), () => {
          rPx.assign(min(rPx, u.maxPx));
          const pr = fetchPos(ip.add(ivec2(1, 0))).toVar(), pl = fetchPos(ip.sub(ivec2(1, 0))).toVar();
          const pu = fetchPos(ip.add(ivec2(0, 1))).toVar(), pd = fetchPos(ip.sub(ivec2(0, 1))).toVar();
          const last = ivec2(u.size).sub(1);
          const useR = ip.x.equal(0).or(ip.x.lessThan(last.x).and(abs(pr.z.sub(P.z)).lessThan(abs(P.z.sub(pl.z)))));
          const useU = ip.y.equal(0).or(ip.y.lessThan(last.y).and(abs(pu.z.sub(P.z)).lessThan(abs(P.z.sub(pd.z)))));
          const dx = select(useR, pr.sub(P), P.sub(pl));
          const dy = select(useU, pu.sub(P), P.sub(pd));
          // rows run down: cross(dx, dy) faces away from the camera, flip it
          const N = normalize(cross(dy, dx)).toVar();
          // 4x4 interleaved rotation (Bayer order so neighbours differ a lot)
          const bayer = float(bayer4i(ip)).toVar();
          const ang = bayer.mul(6.2831853 / 16.0), jit = bayer.div(16.0);
          const r2 = u.radius.mul(u.radius);
          const occ = float(0.0).toVar();
          Loop({ start: int(0), end: int(u.samples), type: 'int', condition: '<' }, ({ i }) => {
            const fi = float(i);
            const t = fi.add(jit).div(u.samples);
            const a = ang.add(fi.mul(2.3999632));
            const off = vec2(cos(a), sin(a)).mul(rPx.mul(pow(t, 1.5)).add(1.0));
            const Q = fetchPos(ip.add(ivec2(round(off))));
            const v = Q.sub(P).toVar();
            const vv = dot(v, v);
            const cosT = dot(v, N).mul(inverseSqrt(vv.add(1e-6)));
            const fall = max(vv.div(r2).oneMinus(), 0.0);
            occ.addAssign(max(cosT.sub(0.12), 0.0).mul(fall));
          });
          const ao = clamp(float(1.0).sub(u.intensity.mul(occ).div(u.samples)), 0.0, 1.0);
          out.assign(vec4(mix(1.0, ao, fade), dist, 0.0, 1.0));
        });
      });
      return out;
    })();
    m.depthTest = m.depthWrite = false;
    m.toneMapped = false;
    return m;
  }

  _blurMaterial() {
    const u = this.u, tAO = this.tAO;
    const m = new THREE.NodeMaterial();
    m.fragmentNode = Fn(() => {
      const ip = ivec2(screenCoordinate.xy).toVar();
      const c = tAO.load(ip).rg.toVar();
      const tol = c.y.mul(0.06).add(0.02);
      const s = float(0.0).toVar(), w = float(0.0).toVar();
      const mx = ivec2(u.size).sub(1);
      for (let y = -2; y <= 1; y++) {
        for (let x = -2; x <= 1; x++) {
          const t = tAO.load(ip.add(ivec2(x, y)).clamp(ivec2(0), mx)).rg;
          const k = max(float(1.0).sub(abs(t.y.sub(c.y)).div(tol)), 0.0);
          s.addAssign(t.x.mul(k));
          w.addAssign(k);
        }
      }
      return vec4(select(w.greaterThan(1e-4), s.div(w), c.x), c.y, 0.0, 1.0);
    })();
    m.depthTest = m.depthWrite = false;
    m.toneMapped = false;
    return m;
  }

  /** fn(view distance) -> AO at the pixel: bilateral upsample of the half-res result. */
  _sampleFn() {
    const U2 = this.uniforms, aoTex = U2.aoTex;
    return Fn(([z]) => {
      const hp = screenCoordinate.xy.mul(U2.aoScale).sub(0.5);
      const fb = hp.floor();
      const f = hp.sub(fb).toVar();
      const b = ivec2(fb).toVar();
      const mx = ivec2(U2.aoSize).sub(1);
      const tol = z.mul(0.05).add(0.02);
      // the 4 texels around, written out (no loop: runs in every lit pixel within aoFar)
      const t0 = aoTex.load(b.clamp(ivec2(0), mx)).rg.toVar();
      const t1 = aoTex.load(b.add(ivec2(1, 0)).clamp(ivec2(0), mx)).rg.toVar();
      const t2 = aoTex.load(b.add(ivec2(0, 1)).clamp(ivec2(0), mx)).rg.toVar();
      const t3 = aoTex.load(b.add(ivec2(1, 1)).clamp(ivec2(0), mx)).rg.toVar();
      const d = abs(vec4(t0.y, t1.y, t2.y, t3.y).sub(z)).toVar();
      const wt = vec4(f.x.oneMinus().mul(f.y.oneMinus()), f.x.mul(f.y.oneMinus()), f.x.oneMinus().mul(f.y), f.x.mul(f.y)).mul(max(d.div(tol).oneMinus(), 0.0)).toVar();
      const w = wt.x.add(wt.y).add(wt.z).add(wt.w);
      const r = float(0.0).toVar();
      If(w.greaterThan(1e-4), () => {
        r.assign(dot(vec4(t0.x, t1.x, t2.x, t3.x), wt).div(w));
      }).Else(() => {
        // no texel at this depth: the closest one
        r.assign(t0.x);
        const bestD = d.x.toVar();
        If(d.y.lessThan(bestD), () => { bestD.assign(d.y); r.assign(t1.x); });
        If(d.z.lessThan(bestD), () => { bestD.assign(d.z); r.assign(t2.x); });
        If(d.w.lessThan(bestD), () => { r.assign(t3.x); });
      });
      return r;
    });
  }

  /** The AO factor of a lit pixel (1 when off / past aoFar). */
  aoNode() {
    const u = this.uniforms, sample = this.sampleFn;
    return Fn(() => {
      const z = positionView.z.negate();
      const ao = float(1.0).toVar();
      If(u.aoEnabled.greaterThan(0.5).and(z.lessThan(u.aoFar)), () => { ao.assign(sample(z)); });
      return ao;
    })();
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
    const u = this.u;
    if (intensity != null) u.intensity.value = intensity;
    if (radius != null) u.radius.value = radius;
    if (distance != null) u.fadeFar.value = distance;
    if (direct != null) this.uniforms.aoDirect.value = direct;
  }

  setEnabled(on) {
    this.enabled = on;
    this._sync();
  }

  /** Samples per pixel (quality presets); 0 turns the AO off. The loop count is a uniform: no
   *  recompile. */
  setSamples(n) {
    this.samples = n;
    if (n > 0) this.u.samples.value = n;
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
    cam.far = Math.min(camera.far, Math.max(this.active ? this.u.fadeFar.value * 1.1 : 0, this.depthFar));
    cam.coordinateSystem = camera.coordinateSystem;
    cam.updateProjectionMatrix();
    cam.matrixWorld.copy(camera.matrixWorld);
    cam.matrixWorldInverse.copy(camera.matrixWorldInverse);
    cam.layers.mask = camera.layers.mask & DEPTH_LAYERS;

    const prevTarget = r.getRenderTarget();
    const prevOverride = scene.overrideMaterial, prevFog = scene.fogNode, prevBg = scene.background;
    const autoClear = r.autoClear;
    r.autoClear = true;

    // 1. half-res depth pre-pass
    scene.overrideMaterial = this.depthMat;
    scene.fogNode = null;
    scene.background = null;
    lodPassMode.value = 1;
    r.setRenderTarget(this.depthRT);
    r.render(scene, cam);
    lodPassMode.value = 0;
    scene.overrideMaterial = prevOverride;
    scene.fogNode = prevFog;
    scene.background = prevBg;
    this.depthReady = true;
    if (!this.active) {
      r.autoClear = autoClear;
      r.setRenderTarget(prevTarget);
      return;
    }

    // 2. AO
    const u = this.u;
    const pm = cam.projectionMatrix.elements;
    u.projXY.value.set(1 / pm[0], 1 / pm[5]);
    u.cNear.value = cam.near;
    u.cFar.value = cam.far;
    u.projScale.value = pm[5] * this.size.y * 0.5;
    r.autoClear = false;
    r.setRenderTarget(this.aoRT);
    this.aoQuad.render(r);

    // 3. depth-aware 4x4 blur
    r.setRenderTarget(this.blurRT);
    this.blurQuad.render(r);

    r.autoClear = autoClear;
    r.setRenderTarget(prevTarget);
    if (!this.rendered) { this.rendered = true; this._sync(); }
  }

  dispose() {
    this.depthRT.dispose();
    this.aoRT.dispose();
    this.blurRT.dispose();
    this.aoQuad.material.dispose();
    this.blurQuad.material.dispose();
  }
}

const _v2 = new THREE.Vector2();
