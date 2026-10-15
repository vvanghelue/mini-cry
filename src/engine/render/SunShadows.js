// Cascaded sun shadows done by hand (ported from three-rigged-game/src/lighting/sun.js), without
// any three.js light: the sun is computed in the lit materials' lighting model (Lighting.js) and
// the cascade depth maps are sampled with hardware PCF (comparison samplers).
//
// - Up to 3 cascades (near / mid / far) follow the camera, texel-snapped (no shimmering). Cascade i
//   is re-rendered every `every[i]` frames, so the far ones cost less. A cascade with every <= 2 is
//   re-rendered every frame anyway while the camera moves fast (vehicles): what moves with the
//   camera would otherwise see its shadow lag a frame behind.
// - Cascade selection is by containment (smallest cascade containing the point) with a blend band
//   at the border, where the point mixes the two cascades: what one cascade has and the next lacks
//   (small casters, InstancedField) fades out there instead of popping.
// - Shadows fade out radially over the last `fade` (20 %) of the shadow `distance` (horizontal, from the
//   camera); points past it skip the cascades. Far trees cast too, their impostors as sun-facing
//   cards (InstancedField), into the last cascade only (cards are big in a fine cascade's texels):
//   past where the trees turn into impostors (`split`, setCasterReach) the shadow comes from the
//   last cascade alone, blended in over 15 % of that distance, and the other cascades only need
//   the casters up to there. Without impostor casters the distance is lowered to `split` instead
//   (clampToCasters), so no tree shadow pops in when coming closer.
// - The cascades sit on the ground in front of the camera (groundAt) and grow with its height above
//   the ground (plane, helicopter view: the nearest ground is that far away), in half-octave steps:
//   radii, depth range and shadow distance x `scale`.
// - Cascade i only sees LAYERS.STATIC + DYNAMIC + CASCADE + i (grass, water, FX don't cast; LOD'd
//   instance fields put each LOD mesh in the cascades it can land in, reach()).
import * as THREE from 'three/webgpu';
import { Fn, If, uniform, texture, vec2, vec3, vec4, float, min, max, mix, smoothstep, length, cameraPosition, renderGroup } from 'three/tsl';
import { LAYERS } from './layers.js';

const MAX = 3;
const _texSpace = new THREE.Matrix4();

export class SunShadows {
  /** cascades: [{ radius, res, every }] smallest first; distance: shadow distance (m).
   *  depthMaterial: the shared depth-only override (Lighting.js: LOD switch, cut-out leaves). */
  constructor(renderer, scene, cascades, { distance = Infinity, depthMaterial = null } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.dir = new THREE.Vector3(0, 1, 0);
    this.enabled = true;
    this.frame = 0;
    this.depthMat = depthMaterial;
    // world -> shadow-map texture space (u, v, depth) per cascade
    this.mats = Array.from({ length: MAX }, () => new THREE.Matrix4());
    this.params = Array.from({ length: MAX }, () => new THREE.Vector4(0.1, 1 / 1024, 0, 1));
    const g = (n) => n.setGroup(renderGroup);
    this.uniforms = {
      sunDirW: g(uniform(this.dir)),
      sunColor: g(uniform(new THREE.Color(1, 1, 1))),
      sunCascades: g(uniform(0)),
      sunShadowOn: g(uniform(1)),
      sunMat: { value: this.mats },
      sunParams: { value: this.params }, // x: world texel size, y: 1/res, z: depth bias, w: kernel step (texels)
      sunFade: g(uniform(new THREE.Vector2(1e8, 2e8))), // shadows fade out between these horizontal distances from the camera
      sunSplit: g(uniform(new THREE.Vector2(1e8, 2e8))), // past these horizontal distances only the last cascade (it alone has the far trees)
      sunBlend: g(uniform(0.06)), // blend band at a cascade's border (fraction of its width, edge distance in uv)
      sunDebug: g(uniform(0)), // 1: tint by cascade (debug panel)
    };
    this._matU = this.mats.map((m) => g(uniform(m)));
    this._parU = this.params.map((p) => g(uniform(p)));
    this._maps = Array.from({ length: MAX }, () => texture(this._dummy()));
    this.casterReach = new Map(); // caster set -> distance its far casters stop at (setCasterReach)
    // live tuning (debug panel): fade length (fraction of the distance), the distance clamp to the
    // casters, depth / normal bias and PCF kernel size multipliers
    this.fade = 0.2;
    this.clampToCasters = true;
    this.bias = 1;
    this.softness = 1;
    this.impostorCasters = true; // far trees cast through their impostors (InstancedField)
    // (x, z) -> ground height (World); the cascades grow from `altitude.ref` m above the ground, up
    // to x `altitude.max`
    this.groundAt = null;
    this.altitude = { ref: 25, max: 8 };
    this.scale = 1;
    this.version = 0; // bumped when the cascades or the shadow distance change
    this.setCascades(cascades, { distance });
  }

  /** distance: where shadows end (fading out over its last `fade`, 20 %), Infinity = the far cascade's border. */
  setCascades(cascades, { distance = Infinity } = {}) {
    for (const c of this.cascades ?? []) c.rt.dispose();
    this.cascades = cascades.slice(0, MAX).map((c) => this._make(c.radius, c.res, c.every ?? 1, c.depth ?? 600));
    this.cascades.forEach((c, i) => {
      c.cam.layers.mask = (1 << LAYERS.STATIC) | (1 << LAYERS.DYNAMIC) | (1 << (LAYERS.CASCADE + i));
      this._fit(c);
    });
    this.maxDistance = distance;
    this._setDistance();
    this.uniforms.sunCascades.value = this.cascades.length;
    // unused slots point at a valid depth texture so the samplers stay bound
    const dummy = this.cascades[0]?.rt.depthTexture ?? this._dummy();
    for (let i = 0; i < MAX; i++) this._maps[i].value = this.cascades[i]?.rt.depthTexture ?? dummy;
    this.cascades.forEach((c, i) => this._setParams(i, c));
    this.frame = 0;
    this.version++;
  }

  _dummy() {
    if (!this.dummy) this.dummy = this._make(1, 4, 1, 10);
    return this.dummy.rt.depthTexture;
  }

  _make(radius, res, every, depth) {
    const rt = new THREE.RenderTarget(res, res, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false });
    const d = new THREE.DepthTexture(res, res, THREE.UnsignedIntType);
    d.compareFunction = THREE.LessEqualCompare;
    d.minFilter = d.magFilter = THREE.LinearFilter;
    rt.depthTexture = d;
    const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 1, depth);
    return { radius, res, every, depth, rt, cam, size: radius, span: depth, texel: (2 * radius) / res, rendered: false };
  }

  /** Size the cascade for the altitude scale: size (half-width), span (depth range), texel. */
  _fit(c) {
    c.size = c.radius * this.scale;
    c.span = c.depth * Math.max(1, this.scale * 0.5);
    c.texel = (2 * c.size) / c.res;
    const cam = c.cam;
    cam.left = cam.bottom = -c.size;
    cam.right = cam.top = c.size;
    cam.far = c.span;
    cam.updateProjectionMatrix();
  }

  _setParams(i, c) {
    const step = THREE.MathUtils.clamp(0.05 / c.texel, 1, 2.5) * this.softness;
    this.params[i].set(c.texel * this.bias, 1 / c.res, (c.texel * 0.8 * this.bias) / c.span, step);
  }

  /** Altitude scale for the camera: 1 near the ground, x sqrt(2) per half octave of height above
   *  `altitude.ref`, with hysteresis (a change re-renders every cascade: no flicker in between). */
  _altitudeScale(camera) {
    if (!this.groundAt) return 1;
    const p = camera.position, h = p.y - this.groundAt(p.x, p.z);
    const x = 2 * Math.log2(Math.max(1, h / this.altitude.ref)), top = Math.round(2 * Math.log2(Math.max(1, this.altitude.max)));
    let k = this._altK ?? 0;
    if (Math.abs(x - k) > 0.75 || k > top) k = Math.min(top, Math.round(x));
    this._altK = k;
    return 2 ** (k / 2);
  }

  /** Re-apply bias / softness / fade / distance after a live change (debug panel). */
  refresh() {
    this.cascades.forEach((c, i) => this._setParams(i, c));
    this.distance = this.split = undefined;
    this._setDistance();
  }

  /** Change one cascade live (debug panel): `every` only re-times it, radius / res rebuild the cascades. */
  setCascade(i, patch) {
    const c = this.cascades[i];
    if (!c) return;
    if (Object.keys(patch).every((k) => k === 'every')) { c.every = patch.every; return; }
    this.setCascades(this.config().map((x, j) => (j === i ? { ...x, ...patch } : x)), { distance: this.maxDistance });
  }

  /** The cascades as setCascades takes them. */
  config() { return this.cascades.map((c) => ({ radius: c.radius, res: c.res, every: c.every, depth: c.depth })); }

  /** Where the trees of `key` turn into impostors (Infinity: none do): past it, only the last
   *  cascade (which has their sun-facing cards); without impostor casters, the shadow distance
   *  stops there (clampToCasters), so their shadows fade out instead of popping. */
  setCasterReach(key, d) {
    if (this.casterReach.get(key) === d) return;
    this.casterReach.set(key, d);
    this._setDistance();
  }

  _setDistance() {
    let d = this.maxDistance * this.scale, reach = Infinity;
    for (const r of this.casterReach.values()) reach = Math.min(reach, r);
    const split = this.impostorCasters && reach < d ? reach : Infinity;
    if (!this.impostorCasters && this.clampToCasters) d = Math.min(d, reach);
    if (d === this.distance && split === this.split) return;
    this.distance = d;
    this.split = split;
    this.uniforms.sunFade.value.set(...(Number.isFinite(d) ? [d * (1 - this.fade), d] : [1e8, 2e8]));
    this.uniforms.sunSplit.value.set(...(Number.isFinite(split) ? [split * 0.85, split] : [1e8, 2e8]));
    this.version++;
  }

  /** Farthest horizontal distance from the camera, for any camera yaw, of a ground point cascade i
   *  covers: its square (half-size R, centred R/2 ahead of the camera) stretches 1 / sin(sun
   *  elevation) along the sun's azimuth. Capped by the shadow distance, and by the split for all
   *  but the last cascade (receivers past it don't look them up). */
  reach(i) {
    const R = this.cascades[i].size, s = Math.max(this.dir.y, 0.1);
    let m = 0;
    for (let k = 0; k <= 8; k++) {
      const a = (k / 16) * Math.PI;
      m = Math.max(m, Math.hypot(R + 0.5 * R * Math.cos(a), R / s + 0.5 * R * Math.sin(a)));
    }
    return Math.min(m, this.distance, i < this.cascades.length - 1 ? this.split : Infinity);
  }

  setSun(dir, color, intensity) {
    this.dir.copy(dir).normalize();
    this.uniforms.sunColor.value.copy(color).multiplyScalar(intensity);
  }

  setEnabled(on) {
    this.enabled = on;
    this.uniforms.sunShadowOn.value = on ? 1 : 0;
  }

  _place(c, center) {
    const cam = c.cam;
    const up = Math.abs(this.dir.y) > 0.99 ? _Z : _Y;
    _fwd.copy(this.dir).negate();
    _right.crossVectors(_fwd, up).normalize();
    _lup.crossVectors(_right, _fwd).normalize();
    const t = c.texel;
    const x = center.dot(_right), y = center.dot(_lup), z = center.dot(_fwd);
    _snap.set(0, 0, 0)
      .addScaledVector(_right, Math.round(x / t) * t)
      .addScaledVector(_lup, Math.round(y / t) * t)
      .addScaledVector(_fwd, z);
    cam.position.copy(_snap).addScaledVector(this.dir, c.span * 0.5);
    cam.up.copy(_lup);
    cam.lookAt(_snap);
    cam.updateMatrixWorld(true);
  }

  _render(c, index) {
    const r = this.renderer, scene = this.scene;
    const prevOverride = scene.overrideMaterial, prevTarget = r.getRenderTarget(), prevBg = scene.background;
    scene.overrideMaterial = this.depthMat;
    scene.background = null;
    this.onBeforeShadow?.();
    r.setRenderTarget(c.rt);
    r.render(scene, c.cam);
    r.setRenderTarget(prevTarget);
    this.onAfterShadow?.();
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    // clip space -> (u, v, depth): v runs down the texture (WebGPU convention, three flips it for
    // WebGL), depth is [0, 1] on WebGPU and [-1, 1] on WebGL
    const gl = r.coordinateSystem !== THREE.WebGPUCoordinateSystem;
    _texSpace.set(0.5, 0, 0, 0.5, 0, -0.5, 0, 0.5, 0, 0, gl ? 0.5 : 1, gl ? 0.5 : 0, 0, 0, 0, 1);
    this.mats[index].multiplyMatrices(_texSpace, c.cam.projectionMatrix).multiply(c.cam.matrixWorldInverse);
    c.rendered = true;
  }

  /** Re-fit and render the cascades due this frame around the camera. */
  update(camera, force = false) {
    if (!this.enabled || this.dir.y < -0.05) return;
    this.frame++;
    const fast = (this._lastCam ??= camera.position.clone()).distanceToSquared(camera.position) > 0.03 * 0.03;
    this._lastCam.copy(camera.position);
    const scale = this._altitudeScale(camera);
    if (scale !== this.scale) {
      this.scale = scale;
      this.cascades.forEach((c, i) => { this._fit(c); this._setParams(i, c); });
      this._setDistance();
      this.version++;
      force = true;
    }
    camera.getWorldDirection(_cfwd);
    _cfwd.y = 0;
    if (_cfwd.lengthSq() < 1e-4) _cfwd.set(0, 0, -1);
    _cfwd.normalize();
    this.cascades.forEach((c, i) => {
      const every = fast && c.every <= 2 ? 1 : c.every;
      if (!force && c.rendered && (this.frame + i) % every !== 0) return;
      // on the ground (not at the camera's height: seen from above, a cascade around the camera
      // would cover the air and miss the ground below)
      _center.copy(camera.position).addScaledVector(_cfwd, c.size * 0.5);
      if (this.groundAt) _center.y = Math.min(_center.y, this.groundAt(_center.x, _center.z));
      this._place(c, _center);
      this._render(c, i);
    });
  }

  // ---- shader side -------------------------------------------------------------------------

  /** (u, v, depth - bias) of world point P in cascade i, P pushed along the normal by its texel. */
  _coord(i, P, N, NdL) {
    const p = this._parU[i];
    const nb = p.x.mul(float(1).add(float(1).sub(NdL).mul(2.5))).mul(max(p.w, 1));
    const c = this._matU[i].mul(vec4(P.add(N.mul(nb)), 1)).xyz.toVar();
    c.z.subAssign(p.z);
    return c;
  }

  /** Distance of c to the cascade's border in uv (<= 0: outside, or out of its depth range). */
  _edge(c) {
    const e = min(min(c.x, c.x.oneMinus()), min(c.y, c.y.oneMinus())).toVar();
    If(c.z.greaterThanEqual(1).or(c.z.lessThanEqual(0)), () => { e.assign(-1); });
    return e;
  }

  /** Rotated 4-tap pattern, each tap a hardware 2x2 bilinear compare. */
  _pcf(i, c) {
    const p = this._parU[i], m = this._maps[i];
    const t = vec2(p.y.mul(p.w));
    const tap = (dx, dy) => m.sample(c.xy.add(vec2(t.x.mul(dx), t.y.mul(dy)))).compare(c.z);
    return tap(-1, -0.5).add(tap(0.5, -1)).add(tap(1, 0.5)).add(tap(-0.5, 1)).mul(0.25);
  }

  /** Shadow of cascade i if the point is inside it, else 1 (the far side of a blend band). */
  _next(i, P, N, NdL) {
    const s = float(1).toVar();
    If(this.uniforms.sunCascades.greaterThan(i), () => {
      const c = this._coord(i, P, N, NdL);
      If(this._edge(c).greaterThan(0), () => { s.assign(this._pcf(i, c)); });
    });
    return s;
  }

  /**
   * Sun visibility (0..1) at world point P with world normal N (NdL: their dot with the sun).
   * Written out per cascade, no loop over an index (loops picking samplers / uniform arrays by
   * index compile badly on Apple GPUs). Smallest cascade containing the point; across the blend
   * band at its border, mix with the next one (or fade out after the last).
   */
  shadowNode() {
    if (this._shadowFn) return this._shadowFn;
    const U = this.uniforms, blend = U.sunBlend;
    // (values read in several branches are made variables first: TSL would compute them in the
    // first branch that reads them only)
    const band = (i, P, N, NdL, out, e, pcf) => {
      const s = pcf.toVar();
      If(e.greaterThanEqual(blend), () => { out.assign(s); }).Else(() => {
        out.assign(mix(i + 1 < MAX ? this._next(i + 1, P, N, NdL) : float(1), s, smoothstep(0, blend, e)));
      });
    };
    const cascaded = (P, N, NdL) => {
      const out = float(1).toVar();
      const c0 = this._coord(0, P, N, NdL), e0 = this._edge(c0);
      If(e0.greaterThan(0), () => { band(0, P, N, NdL, out, e0, this._pcf(0, c0)); })
        .ElseIf(U.sunCascades.greaterThanEqual(2), () => {
          const c1 = this._coord(1, P, N, NdL), e1 = this._edge(c1);
          If(e1.greaterThan(0), () => { band(1, P, N, NdL, out, e1, this._pcf(1, c1)); })
            .ElseIf(U.sunCascades.greaterThanEqual(3), () => {
              const c2 = this._coord(2, P, N, NdL), e2 = this._edge(c2);
              If(e2.greaterThan(0), () => { band(2, P, N, NdL, out, e2, this._pcf(2, c2)); });
            });
        });
      return out;
    };
    // past the split: the last cascade alone (it has the far trees' impostor casters)
    const last = (P, N, NdL) => {
      const out = float(1).toVar();
      const one = (i) => {
        const c = this._coord(i, P, N, NdL), e = this._edge(c);
        If(e.greaterThan(0), () => { out.assign(mix(1, this._pcf(i, c), smoothstep(0, blend, e))); });
      };
      If(U.sunCascades.greaterThan(2), () => one(2)).ElseIf(U.sunCascades.greaterThan(1), () => one(1)).Else(() => one(0));
      return out;
    };
    this._shadowFn = Fn(([P, N, NdL]) => {
      const s = float(1).toVar();
      If(U.sunShadowOn.greaterThan(0.5).and(U.sunCascades.greaterThanEqual(1)), () => {
        const d = length(P.xz.sub(cameraPosition.xz));
        If(d.lessThan(U.sunFade.y), () => {
          const sc = float(1).toVar();
          If(d.lessThan(U.sunSplit.y), () => { sc.assign(cascaded(P, N, NdL)); });
          If(d.greaterThan(U.sunSplit.x), () => { sc.assign(mix(sc, last(P, N, NdL), smoothstep(U.sunSplit.x, U.sunSplit.y, d))); });
          s.assign(mix(sc, 1, smoothstep(U.sunFade.x, U.sunFade.y, d)));
        });
      });
      return s;
    });
    return this._shadowFn;
  }

  /** Debug view: near cascade red, mid green, far blue, no shadow white (bands and the fade mixed in). */
  cascadeTintNode() {
    if (this._tintFn) return this._tintFn;
    const U = this.uniforms, blend = U.sunBlend, zero = vec3(0);
    const tintOf = (i, P) => {
      const t = vec3(1).toVar();
      If(U.sunCascades.greaterThan(i), () => {
        If(this._edge(this._coord(i, P, zero, float(1))).greaterThan(0), () => { t.assign(vec3(...[[1, 0.3, 0.25], [0.3, 1, 0.3], [0.3, 0.5, 1]][i])); });
      });
      return t;
    };
    this._tintFn = Fn(([P]) => {
      const t = vec3(1).toVar();
      const e = [0, 1, 2].map((i) => {
        const v = float(-1).toVar();
        If(U.sunCascades.greaterThan(i), () => { v.assign(this._edge(this._coord(i, P, zero, float(1)))); });
        return v;
      });
      const bandTint = (i) => mix(i + 1 < MAX ? tintOf(i + 1, P) : vec3(1), tintOf(i, P), smoothstep(0, blend, e[i]));
      If(e[0].greaterThan(0), () => { t.assign(bandTint(0)); })
        .ElseIf(e[1].greaterThan(0), () => { t.assign(bandTint(1)); })
        .ElseIf(e[2].greaterThan(0), () => { t.assign(bandTint(2)); });
      const d = length(P.xz.sub(cameraPosition.xz));
      const lastTint = vec3(1).toVar();
      If(U.sunCascades.greaterThan(2), () => { lastTint.assign(tintOf(2, P)); })
        .ElseIf(U.sunCascades.greaterThan(1), () => { lastTint.assign(tintOf(1, P)); })
        .Else(() => { lastTint.assign(tintOf(0, P)); });
      t.assign(mix(t, lastTint, smoothstep(U.sunSplit.x, U.sunSplit.y, d)));
      return mix(t, vec3(1), smoothstep(U.sunFade.x, U.sunFade.y, d));
    });
    return this._tintFn;
  }
}

const _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1);
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _lup = new THREE.Vector3(), _snap = new THREE.Vector3();
const _cfwd = new THREE.Vector3(), _center = new THREE.Vector3();
