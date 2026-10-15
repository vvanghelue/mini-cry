// Screen-space ambient occlusion (ported from three-rigged-game/src/lighting/ao.js), tuned for
// speed and a clean (noise-free, halo-free) result.
//
// Everything runs at half resolution:
//   1. depth pre-pass of the STATIC + DYNAMIC layers (no grass, water, FX) through a copy of the
//      main camera whose far plane stops where the AO has faded out (fadeFar), so the distant
//      world is frustum-culled and costs nothing. Same depth material as the shadow cascades
//      (Lighting.js: LOD switch, cut-out leaves);
//   2. AO pass: view-space position rebuilt from depth, normal rebuilt from depth (picking the
//      smaller neighbour delta so edges don't smear), N samples on a golden-angle spiral rotated
//      by a 4x4 interleaved pattern. A range falloff kills occluders far away from the receiver,
//      so there is no dark halo around foreground objects;
//   3. one 4x4 depth-aware blur: every 4x4 window contains all 16 rotations of the pattern, so it
//      removes the pattern noise completely (no temporal accumulation, no ghosting).
// The result (AO + linear depth) is read back in the lit materials (aoNode(), Lighting.js) with a
// depth-aware bilateral upsample and applied to the indirect light (probe GI, sky reflections),
// plus a small share of the direct sun. Surfaces missing from the pre-pass (grass) take the AO of
// the closest depth around them, i.e. the ground they stand on.
// The water's screen-space reflections (SSR.js) march through the same depth: while they are on,
// the pre-pass reaches `depthFar` and runs even with the AO switched off.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, uniform, texture, textureLoad, screenCoordinate, vec2, vec3, vec4, float, int, ivec2, clamp, max, min, abs, cos, sin, pow, round, floor, dot, normalize, cross,
  smoothstep, inverseSqrt, select, mix, renderGroup,
} from 'three/tsl';
import { LAYERS } from './layers.js';

const DEPTH_LAYERS = (1 << LAYERS.STATIC) | (1 << LAYERS.DYNAMIC) | (1 << LAYERS.OCCLUDER);

/** 4x4 Bayer index (0..15) of a pixel, computed (a constant array indexed per pixel is slow on Apple GPUs). */
export const bayer16 = (ip) => {
  const bx = ip.x.bitAnd(3), by = ip.y.bitAnd(3), xy = bx.bitXor(by);
  const lo = xy.bitAnd(1).shiftLeft(1).bitOr(by.bitAnd(1));
  const hi = xy.shiftRight(1).bitAnd(1).shiftLeft(1).bitOr(by.shiftRight(1).bitAnd(1));
  return lo.shiftLeft(2).bitOr(hi);
};

export class SSAO {
  constructor(renderer, scene, { samples = 8, radius = 1.0, intensity = 2.6, direct = 0.2, maxPx = 48, fadeFar = 80, depthMaterial = null } = {}) {
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

    this.depthRT = new THREE.RenderTarget(1, 1, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false });
    this.depthRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    const rtOpts = { format: THREE.RGFormat, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.aoRT = new THREE.RenderTarget(1, 1, rtOpts);
    this.blurRT = new THREE.RenderTarget(1, 1, rtOpts);
    // same parameters as the sun cascades: double-sided (leaves, open props), LOD switch, cut-outs
    this.depthMat = depthMaterial;

    const g = (n) => n.setGroup(renderGroup);
    this.u = {
      size: g(uniform(this.size)),
      projXY: g(uniform(new THREE.Vector2())),
      cNear: g(uniform(0.1)),
      cFar: g(uniform(1000)),
      radius: g(uniform(radius)),
      intensity: g(uniform(intensity)),
      projScale: g(uniform(1)),
      maxPx: g(uniform(maxPx)),
      fadeFar: g(uniform(fadeFar)),
    };
    this.depthTex = texture(this.depthRT.depthTexture);
    this.aoTexIn = texture(this.aoRT.texture);
    this.quad = new THREE.QuadMesh(this._aoMaterial(this._compiled));
    this.blurMat = this._blurMaterial();

    this.uniforms = {
      aoTex: texture(this.blurRT.texture),
      aoScale: g(uniform(new THREE.Vector2(0.5, 0.5))),
      aoSize: this.u.size,
      aoEnabled: g(uniform(0)),
      aoFar: this.u.fadeFar, // AO is 1 past this distance: no lookup
      aoDirect: g(uniform(direct)),
      aoDebug: g(uniform(0)), // 1: show the AO term only
    };
  }

  _aoMaterial(samples) {
    const u = this.u, depth = this.depthTex;
    const viewZ = (d) => u.cNear.mul(u.cFar).div(u.cFar.sub(u.cNear).mul(d).sub(u.cFar));
    const viewPos = (p, d) => {
      const uv = vec2(p).add(0.5).div(u.size);
      const z = viewZ(d);
      return vec3(uv.mul(2).sub(1).mul(vec2(1, -1)).mul(u.projXY).mul(z.negate()), z);
    };
    const last = ivec2(u.size).sub(1);
    const fetchPos = (p) => {
      const q = clamp(p, ivec2(0), last);
      return viewPos(q, depth.load(q));
    };
    const m = new THREE.NodeMaterial();
    m.colorNode = Fn(() => {
      const ip = ivec2(screenCoordinate);
      const d = depth.load(ip).toVar();
      const out = vec4(1, u.cFar, 0, 1).toVar();
      If(d.lessThan(1), () => {
        const P = viewPos(ip, d).toVar();
        const dist = P.z.negate();
        const rPx = u.radius.mul(u.projScale).div(dist).toVar();
        const fade = float(1).sub(smoothstep(u.fadeFar.mul(0.6), u.fadeFar, dist));
        out.assign(vec4(1, dist, 0, 1));
        If(rPx.greaterThanEqual(1).and(fade.greaterThan(0)), () => {
          rPx.assign(min(rPx, u.maxPx));
          const pr = fetchPos(ip.add(ivec2(1, 0))), pl = fetchPos(ip.sub(ivec2(1, 0)));
          const pu = fetchPos(ip.add(ivec2(0, 1))), pd = fetchPos(ip.sub(ivec2(0, 1)));
          const useR = ip.x.equal(0).or(ip.x.lessThan(last.x).and(abs(pr.z.sub(P.z)).lessThan(abs(P.z.sub(pl.z)))));
          const useU = ip.y.equal(0).or(ip.y.lessThan(last.y).and(abs(pu.z.sub(P.z)).lessThan(abs(P.z.sub(pd.z)))));
          const dx = select(useR, pr.sub(P), P.sub(pl)), dy = select(useU, pu.sub(P), P.sub(pd));
          // rows run down the texture (WebGPU): flip the cross product to keep N toward the camera
          const N = normalize(cross(dy, dx)).toVar();
          // 4x4 interleaved rotation (Bayer order so neighbours differ a lot)
          const b = float(bayer16(ip));
          const ang = b.mul(6.2831853 / 16), jit = b.div(16);
          const r2 = u.radius.mul(u.radius);
          const occ = float(0).toVar();
          Loop(samples, ({ i }) => {
            const fi = float(i);
            const t = fi.add(jit).div(samples);
            const a = ang.add(fi.mul(2.3999632));
            const off = vec2(cos(a), sin(a)).mul(rPx.mul(pow(t, 1.5)).add(1));
            const Q = fetchPos(ip.add(ivec2(round(off))));
            const v = Q.sub(P);
            const vv = dot(v, v);
            const cosT = dot(v, N).mul(inverseSqrt(vv.add(1e-6)));
            const fall = max(float(1).sub(vv.div(r2)), 0);
            occ.addAssign(max(cosT.sub(0.12), 0).mul(fall));
          });
          const ao = clamp(float(1).sub(u.intensity.mul(occ).div(samples)), 0, 1);
          out.assign(vec4(mix(1, ao, fade), dist, 0, 1));
        });
      });
      return out;
    })();
    m.depthTest = m.depthWrite = false;
    m.name = `ssao${samples}`;
    return m;
  }

  _blurMaterial() {
    const u = this.u, ao = this.aoTexIn;
    const m = new THREE.NodeMaterial();
    m.colorNode = Fn(() => {
      const ip = ivec2(screenCoordinate);
      const c = ao.load(ip).rg.toVar();
      const tol = c.y.mul(0.06).add(0.02);
      const s = float(0).toVar(), w = float(0).toVar();
      const last = ivec2(u.size).sub(1);
      for (let y = -2; y <= 1; y++) {
        for (let x = -2; x <= 1; x++) {
          const t = ao.load(clamp(ip.add(ivec2(x, y)), ivec2(0), last)).rg;
          const k = max(float(1).sub(abs(t.y.sub(c.y)).div(tol)), 0);
          s.addAssign(t.x.mul(k));
          w.addAssign(k);
        }
      }
      return vec4(select(w.greaterThan(1e-4), s.div(w), c.x), c.y, 0, 1);
    })();
    m.depthTest = m.depthWrite = false;
    m.name = 'ssaoBlur';
    return m;
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

  /** Samples per pixel (quality presets); 0 turns the AO off. */
  setSamples(n) {
    this.samples = n;
    if (n > 0 && n !== this._compiled) {
      this._compiled = n;
      this.quad.material.dispose();
      this.quad.material = this._aoMaterial(n);
      this._aoMat = null;
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
    cam.far = Math.min(camera.far, Math.max(this.active ? this.u.fadeFar.value * 1.1 : 0, this.depthFar));
    cam.coordinateSystem = r.coordinateSystem;
    cam.updateProjectionMatrix();
    cam.matrixWorld.copy(camera.matrixWorld);
    cam.matrixWorldInverse.copy(camera.matrixWorldInverse);
    cam.layers.mask = camera.layers.mask & DEPTH_LAYERS;

    const prevTarget = r.getRenderTarget();
    const prevOverride = scene.overrideMaterial, prevBg = scene.background;

    // 1. half-res depth pre-pass
    scene.overrideMaterial = this.depthMat;
    scene.background = null;
    r.setRenderTarget(this.depthRT);
    r.render(scene, cam);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    this.depthReady = true;
    if (!this.active) { r.setRenderTarget(prevTarget); return; }

    // 2. AO
    const u = this.u;
    const pm = cam.projectionMatrix.elements;
    u.projXY.value.set(1 / pm[0], 1 / pm[5]);
    u.cNear.value = cam.near;
    u.cFar.value = cam.far;
    u.projScale.value = pm[5] * this.size.y * 0.5;
    const aoMat = this.quad.material;
    r.setRenderTarget(this.aoRT);
    this.quad.render(r);

    // 3. depth-aware 4x4 blur
    this.quad.material = this.blurMat;
    r.setRenderTarget(this.blurRT);
    this.quad.render(r);
    this.quad.material = aoMat;

    r.setRenderTarget(prevTarget);
    if (!this.rendered) { this.rendered = true; this._sync(); }
  }

  /**
   * AO (0..1) at the shaded pixel of a lit material, view depth z: the 4 half-res texels around,
   * weighted bilinearly and by depth similarity (written out, no loop: runs in every lit pixel
   * within aoFar); no texel at this depth: the closest one.
   */
  sampleNode() {
    if (this._sample) return this._sample;
    const U = this.uniforms, ao = U.aoTex;
    const fn = Fn(([z, fc]) => {
      const hp = fc.mul(U.aoScale).sub(0.5);
      const fb = floor(hp);
      const f = hp.sub(fb);
      const b = ivec2(fb);
      const mx = ivec2(U.aoSize).sub(1);
      const tol = z.mul(0.05).add(0.02);
      const at = (dx, dy) => ao.load(clamp(b.add(ivec2(dx, dy)), ivec2(0), mx)).rg;
      const t0 = at(0, 0).toVar(), t1 = at(1, 0).toVar(), t2 = at(0, 1).toVar(), t3 = at(1, 1).toVar();
      const d = abs(vec4(t0.y, t1.y, t2.y, t3.y).sub(z)).toVar();
      const fx = f.x, fy = f.y;
      const wt = vec4(fx.oneMinus().mul(fy.oneMinus()), fx.mul(fy.oneMinus()), fx.oneMinus().mul(fy), fx.mul(fy)).mul(max(float(1).sub(d.div(tol)), 0)).toVar();
      const w = wt.x.add(wt.y).add(wt.z).add(wt.w);
      const out = float(0).toVar();
      If(w.greaterThan(1e-4), () => {
        out.assign(dot(vec4(t0.x, t1.x, t2.x, t3.x), wt).div(w));
      }).Else(() => {
        out.assign(t0.x);
        const bestD = d.x.toVar();
        If(d.y.lessThan(bestD), () => { bestD.assign(d.y); out.assign(t1.x); });
        If(d.z.lessThan(bestD), () => { bestD.assign(d.z); out.assign(t2.x); });
        If(d.w.lessThan(bestD), () => { out.assign(t3.x); });
      });
      return out;
    });
    this._sample = (z) => fn(z, screenCoordinate);
    return this._sample;
  }

  dispose() {
    this.depthRT.dispose();
    this.aoRT.dispose();
    this.blurRT.dispose();
    this.quad.material.dispose();
    this.blurMat.dispose();
  }
}

const _v2 = new THREE.Vector2();
