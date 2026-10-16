// Cascaded sun shadows done by hand (ported from three-rigged-game/src/lighting/sun.js), without
// any three.js shadow: the sun is a light of our own (Lighting.js SunLight) whose colour node
// carries the cascaded shadow, and the cascade depth maps are sampled with hardware PCF
// (comparison sampler, each tap a 2x2 bilinear compare).
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
// - The depth passes draw everything with one override material (DepthMaterial, shared with the
//   SSAO pre-pass): it inherits each object's position node (instancing, wind, LOD collapse) and
//   cuts alpha-tested leaves through their texture.
import * as THREE from 'three/webgpu';
import { Fn, If, float, ivec2, vec2, vec3, vec4, mix, min, max, length, smoothstep, select, texture, cameraPosition } from 'three/tsl';
import { LAYERS } from './layers.js';
import { U, ndcToUv } from './tsl.js';
import { lodPassMode } from './LodFade.js';

const MAX = 3;

export class SunShadows {
  /** cascades: [{ radius, res, every }] smallest first; distance: shadow distance (m) */
  constructor(renderer, scene, cascades, { distance = Infinity } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.dir = new THREE.Vector3(0, 1, 0);
    this.enabled = true;
    this.frame = 0;
    const dummy = this._dummy();
    this.uniforms = {
      sunDirW: U(this.dir),
      sunColor: U(new THREE.Color(1, 1, 1)),
      sunCascades: U(0),
      sunShadowOn: U(1),
      sunMat: Array.from({ length: MAX }, () => U(new THREE.Matrix4())),
      sunParams: Array.from({ length: MAX }, () => U(new THREE.Vector4(0.1, 1 / 1024, 0, 1))), // x: world texel size, y: 1/res, z: depth bias, w: kernel step (texels)
      sunFade: U(new THREE.Vector2(1e8, 2e8)), // shadows fade out between these horizontal distances from the camera
      sunSplit: U(new THREE.Vector2(1e8, 2e8)), // past these horizontal distances only the last cascade (it alone has the far trees)
      sunBlend: U(0.06), // blend band at a cascade's border (fraction of its width, edge distance in uv)
      sunDebug: U(0), // 1: tint by cascade (debug panel)
      sunMap: Array.from({ length: MAX }, () => texture(dummy)),
    };
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
    this.depthMat = new DepthMaterial(); // set by Lighting (needs the foliage textures)
    this.setCascades(cascades, { distance });
    this.shadowFn = this._shadowFn();
    this.tintFn = this._tintFn();
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
    const u = this.uniforms;
    u.sunCascades.value = this.cascades.length;
    // unused slots point at a valid depth texture so the bindings stay valid
    const dummy = this.cascades[0]?.rt.depthTexture ?? this._dummy();
    for (let i = 0; i < MAX; i++) u.sunMap[i].value = this.cascades[i]?.rt.depthTexture ?? dummy;
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
    rt.depthTexture = new THREE.DepthTexture(res, res, THREE.UnsignedIntType);
    rt.depthTexture.format = THREE.DepthFormat;
    rt.depthTexture.compareFunction = THREE.LessEqualCompare;
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.LinearFilter;
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
    this.uniforms.sunParams[i].value.set(c.texel * this.bias, 1 / c.res, (c.texel * 0.8 * this.bias) / c.span, step);
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
    const prevOverride = scene.overrideMaterial, prevTarget = r.getRenderTarget(), prevFog = scene.fogNode, prevBg = scene.background, prevAuto = r.autoClear;
    scene.overrideMaterial = this.depthMat;
    scene.fogNode = null;
    scene.background = null;
    lodPassMode.value = 1;
    this.onBeforeShadow?.();
    r.autoClear = true;
    r.setRenderTarget(c.rt);
    r.render(scene, c.cam);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    this.onAfterShadow?.();
    lodPassMode.value = 0;
    scene.overrideMaterial = prevOverride;
    scene.fogNode = prevFog;
    scene.background = prevBg;
    this.uniforms.sunMat[index].value.multiplyMatrices(c.cam.projectionMatrix, c.cam.matrixWorldInverse);
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

  // --- shader side ------------------------------------------------------------------------------

  /** fn(P world, N world geometry normal, NdL) -> shadow factor (1 = lit). */
  _shadowFn() {
    const u = this.uniforms;
    const pcf = (i, c) => {
      // rotated 4-tap pattern (each tap is a hardware 2x2 bilinear compare)
      const p = u.sunParams[i], t = vec2(p.y.mul(p.w)), m = u.sunMap[i];
      const tap = (dx, dy) => m.sample(c.xy.add(vec2(t.x.mul(dx), t.y.mul(dy)))).compare(c.z);
      return tap(-1, -0.5).add(tap(0.5, -1)).add(tap(1, 0.5)).add(tap(-0.5, 1)).mul(0.25);
    };
    const coord = (i, P, N, NdL) => {
      const p = u.sunParams[i];
      const nb = p.x.mul(NdL.oneMinus().mul(2.5).add(1.0)).mul(max(p.w, 1.0));
      const c = u.sunMat[i].mul(vec4(P.add(N.mul(nb)), 1.0));
      return vec3(ndcToUv(c), c.z.sub(p.z));
    };
    const edge = (c) => select(c.z.greaterThanEqual(1.0).or(c.z.lessThanEqual(0.0)), float(-1.0), min(min(c.x, c.x.oneMinus()), min(c.y, c.y.oneMinus())));
    // written out per cascade, no loop over an index (loops picking samplers / uniform arrays by
    // index compile badly on Apple GPUs). Smallest cascade containing the point; across the blend
    // band at its border, mix with the next one (or fade out after the last).
    const next = (i, P, N, NdL) => Fn(() => {
      const s = float(1.0).toVar();
      If(u.sunCascades.greaterThan(i), () => {
        const c = coord(i, P, N, NdL).toVar();
        If(edge(c).greaterThan(0.0), () => { s.assign(pcf(i, c)); });
      });
      return s;
    })();
    const cascaded = Fn(([P, N, NdL]) => {
      const s = float(1.0).toVar();
      const c0 = coord(0, P, N, NdL).toVar(), e0 = edge(c0).toVar();
      If(e0.greaterThan(0.0), () => {
        const s0 = pcf(0, c0).toVar();
        If(e0.greaterThanEqual(u.sunBlend), () => { s.assign(s0); }).Else(() => { s.assign(mix(next(1, P, N, NdL), s0, smoothstep(0.0, u.sunBlend, e0))); });
      }).Else(() => {
        If(u.sunCascades.greaterThanEqual(2), () => {
          const c1 = coord(1, P, N, NdL).toVar(), e1 = edge(c1).toVar();
          If(e1.greaterThan(0.0), () => {
            const s1 = pcf(1, c1).toVar();
            If(e1.greaterThanEqual(u.sunBlend), () => { s.assign(s1); }).Else(() => { s.assign(mix(next(2, P, N, NdL), s1, smoothstep(0.0, u.sunBlend, e1))); });
          }).Else(() => {
            If(u.sunCascades.greaterThanEqual(3), () => {
              const c2 = coord(2, P, N, NdL).toVar(), e2 = edge(c2).toVar();
              If(e2.greaterThan(0.0), () => { s.assign(mix(1.0, pcf(2, c2), smoothstep(0.0, u.sunBlend, e2))); });
            });
          });
        });
      });
      return s;
    });
    const last = Fn(([P, N, NdL]) => {
      const s = float(1.0).toVar();
      const one = (i) => {
        const c = coord(i, P, N, NdL).toVar(), e = edge(c).toVar();
        If(e.greaterThan(0.0), () => { s.assign(mix(1.0, pcf(i, c), smoothstep(0.0, u.sunBlend, e))); });
      };
      If(u.sunCascades.greaterThan(2), () => { one(2); }).ElseIf(u.sunCascades.greaterThan(1), () => { one(1); }).Else(() => { one(0); });
      return s;
    });
    return Fn(([P, N, NdL]) => {
      const s = float(1.0).toVar();
      If(u.sunShadowOn.greaterThan(0.5).and(u.sunCascades.greaterThanEqual(1)), () => {
        const d = length(P.xz.sub(cameraPosition.xz)).toVar();
        If(d.lessThan(u.sunFade.y), () => {
          If(d.lessThan(u.sunSplit.y), () => { s.assign(cascaded(P, N, NdL)); });
          If(d.greaterThan(u.sunSplit.x), () => { s.assign(mix(s, last(P, N, NdL), smoothstep(u.sunSplit.x, u.sunSplit.y, d))); });
          s.assign(mix(s, 1.0, smoothstep(u.sunFade.x, u.sunFade.y, d)));
        });
      });
      return s;
    });
  }

  /** Vertex stage variant (dust motes): one point-sampled tap of the first cascade containing P
   *  (comparison samplers are fragment-only). fn(P) -> 0 / 1. */
  shadowVertexFn() {
    const u = this.uniforms;
    return Fn(([P]) => {
      const s = float(1.0).toVar();
      If(u.sunShadowOn.greaterThan(0.5), () => {
        const done = float(0.0).toVar();
        for (let i = 0; i < MAX; i++) {
          If(done.lessThan(0.5).and(u.sunCascades.greaterThan(i)), () => {
            const c = u.sunMat[i].mul(vec4(P, 1.0));
            const uv = ndcToUv(c).toVar(), z = c.z.sub(u.sunParams[i].z);
            If(uv.x.greaterThan(0.0).and(uv.y.greaterThan(0.0)).and(uv.x.lessThan(1.0)).and(uv.y.lessThan(1.0)).and(z.lessThan(1.0)).and(z.greaterThan(0.0)), () => {
              const d = u.sunMap[i].load(ivec2(uv.mul(float(1.0).div(u.sunParams[i].y)))).x;
              s.assign(select(z.lessThanEqual(d), float(1.0), float(0.0)));
              done.assign(1.0);
            });
          });
        }
      });
      return s;
    });
  }

  /** Debug view: fn(P) -> tint (near cascade red, mid green, far blue, no shadow white; bands and
   *  the fade mixed in). */
  _tintFn() {
    const u = this.uniforms;
    const edgeOf = (i, P) => {
      const c = u.sunMat[i].mul(vec4(P, 1.0));
      const uv = ndcToUv(c), z = c.z.sub(u.sunParams[i].z);
      return select(z.greaterThanEqual(1.0).or(z.lessThanEqual(0.0)).or(u.sunCascades.lessThanEqual(i)), float(-1.0), min(min(uv.x, uv.x.oneMinus()), min(uv.y, uv.y.oneMinus())));
    };
    const COL = [vec3(1.0, 0.3, 0.25), vec3(0.3, 1.0, 0.3), vec3(0.3, 0.5, 1.0)];
    const tintOf = (i, P) => (i > 2 ? vec3(1.0) : select(edgeOf(i, P).greaterThan(0.0), COL[i], vec3(1.0)));
    return Fn(([P]) => {
      const t = vec3(1.0).toVar();
      const e0 = edgeOf(0, P).toVar(), e1 = edgeOf(1, P).toVar(), e2 = edgeOf(2, P).toVar();
      const band = (i, e) => mix(tintOf(i + 1, P), tintOf(i, P), smoothstep(0.0, u.sunBlend, e));
      If(e0.greaterThan(0.0), () => { t.assign(band(0, e0)); }).ElseIf(e1.greaterThan(0.0), () => { t.assign(band(1, e1)); }).ElseIf(e2.greaterThan(0.0), () => { t.assign(band(2, e2)); });
      const d = length(P.xz.sub(cameraPosition.xz));
      const lastT = select(u.sunCascades.greaterThan(2), tintOf(2, P), select(u.sunCascades.greaterThan(1), tintOf(1, P), tintOf(0, P)));
      t.assign(mix(t, lastT, smoothstep(u.sunSplit.x, u.sunSplit.y, d)));
      return mix(t, vec3(1.0), smoothstep(u.sunFade.x, u.sunFade.y, d));
    });
  }
}

/** Depth-only override material of the sun cascades and the SSAO pre-pass: double-sided, no colour,
 *  each object's own position node (instancing, wind, LOD collapse: three.js copies it over), and
 *  alpha-cut leaves through their texture (maskNode: Surfaces.leafMaskNode(), set by Lighting; it
 *  only cuts geometries with a `surface` attribute). */
export class DepthMaterial extends THREE.MeshBasicNodeMaterial {
  constructor() {
    super({ side: THREE.DoubleSide, colorWrite: false, fog: false });
    this.lights = false;
    this.toneMapped = false;
    // three copies `transparent` from each source material: never blend (the colour target is R8)
    this.blending = THREE.NoBlending;
  }
}

const _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1);
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _lup = new THREE.Vector3(), _snap = new THREE.Vector3();
const _cfwd = new THREE.Vector3(), _center = new THREE.Vector3();
