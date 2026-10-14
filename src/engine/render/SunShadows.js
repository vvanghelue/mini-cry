// Cascaded sun shadows done by hand (ported from three-rigged-game/src/lighting/sun.js), without
// any three.js light: the sun is injected into the lit materials' shader (RE_Direct) and the
// cascade depth maps are sampled with hardware PCF.
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
import * as THREE from 'three';
import { LAYERS } from './layers.js';

const MAX = 3;

export const SUN_GLSL = /* glsl */ `
uniform vec3 sunDirW;
uniform vec3 sunColor;
uniform int sunCascades;
uniform float sunShadowOn;
uniform mat4 sunMat[${MAX}];
uniform vec4 sunParams[${MAX}]; // x: world texel size, y: 1/res, z: depth bias, w: kernel step (texels)
uniform vec2 sunFade; // shadows fade out between these horizontal distances from the camera
uniform vec2 sunSplit; // past these horizontal distances only the last cascade (it alone has the far trees)
uniform float sunBlend; // blend band at a cascade's border (fraction of its width, edge distance in uv)
uniform float sunDebug; // 1: tint by cascade (debug panel)
uniform sampler2DShadow sunMap0;
uniform sampler2DShadow sunMap1;
uniform sampler2DShadow sunMap2;

float sunPCF(sampler2DShadow m, vec3 c, vec4 p) {
  // rotated 4-tap pattern (each tap is a hardware 2x2 bilinear compare)
  vec2 t = vec2(p.y * p.w);
  float s = texture(m, vec3(c.xy + vec2(-t.x, -t.y * 0.5), c.z));
  s += texture(m, vec3(c.xy + vec2( t.x * 0.5, -t.y), c.z));
  s += texture(m, vec3(c.xy + vec2( t.x,  t.y * 0.5), c.z));
  s += texture(m, vec3(c.xy + vec2(-t.x * 0.5,  t.y), c.z));
  return s * 0.25;
}
vec3 sunCoord(int i, vec3 P, vec3 N, float NdL) {
  vec4 p = sunParams[i];
  float nb = p.x * (1.0 + 2.5 * (1.0 - NdL)) * max(p.w, 1.0);
  vec3 c = (sunMat[i] * vec4(P + N * nb, 1.0)).xyz * 0.5 + 0.5;
  c.z -= p.z;
  return c;
}
float sunEdge(vec3 c) {
  if (c.z >= 1.0 || c.z <= 0.0) return -1.0;
  return min(min(c.x, 1.0 - c.x), min(c.y, 1.0 - c.y));
}
// Written out per cascade, no loop over an index (loops picking samplers / uniform arrays by
// index compile badly on Apple GPUs, see TerrainMaterial.js). Smallest cascade containing the
// point; across the blend band at its border, mix with the next one (or fade out after the last).
float sunNext(int i, vec3 P, vec3 N, float NdL) {
  if (i >= sunCascades) return 1.0;
  vec3 c = sunCoord(i, P, N, NdL);
  if (sunEdge(c) <= 0.0) return 1.0;
  return i == 1 ? sunPCF(sunMap1, c, sunParams[1]) : sunPCF(sunMap2, c, sunParams[2]);
}
float sunCascaded(vec3 P, vec3 N, float NdL) {
  vec3 c = sunCoord(0, P, N, NdL);
  float e = sunEdge(c);
  if (e > 0.0) {
    float s = sunPCF(sunMap0, c, sunParams[0]);
    return e >= sunBlend ? s : mix(sunNext(1, P, N, NdL), s, smoothstep(0.0, sunBlend, e));
  }
  if (sunCascades < 2) return 1.0;
  c = sunCoord(1, P, N, NdL);
  e = sunEdge(c);
  if (e > 0.0) {
    float s = sunPCF(sunMap1, c, sunParams[1]);
    return e >= sunBlend ? s : mix(sunNext(2, P, N, NdL), s, smoothstep(0.0, sunBlend, e));
  }
  if (sunCascades < 3) return 1.0;
  c = sunCoord(2, P, N, NdL);
  e = sunEdge(c);
  if (e > 0.0) {
    float s = sunPCF(sunMap2, c, sunParams[2]);
    return e >= sunBlend ? s : mix(1.0, s, smoothstep(0.0, sunBlend, e));
  }
  return 1.0;
}
float sunLast(vec3 P, vec3 N, float NdL) {
  vec3 c;
  float s;
  if (sunCascades > 2) { c = sunCoord(2, P, N, NdL); if (sunEdge(c) <= 0.0) return 1.0; s = sunPCF(sunMap2, c, sunParams[2]); }
  else if (sunCascades > 1) { c = sunCoord(1, P, N, NdL); if (sunEdge(c) <= 0.0) return 1.0; s = sunPCF(sunMap1, c, sunParams[1]); }
  else { c = sunCoord(0, P, N, NdL); if (sunEdge(c) <= 0.0) return 1.0; s = sunPCF(sunMap0, c, sunParams[0]); }
  return mix(1.0, s, smoothstep(0.0, sunBlend, sunEdge(c)));
}
float sunShadow(vec3 P, vec3 N, float NdL) {
  if (sunShadowOn < 0.5 || sunCascades < 1) return 1.0;
  float d = length(P.xz - cameraPosition.xz);
  if (d >= sunFade.y) return 1.0;
  float s = d < sunSplit.y ? sunCascaded(P, N, NdL) : 1.0;
  if (d > sunSplit.x) s = mix(s, sunLast(P, N, NdL), smoothstep(sunSplit.x, sunSplit.y, d));
  return mix(s, 1.0, smoothstep(sunFade.x, sunFade.y, d));
}
// debug view: near cascade red, mid green, far blue, no shadow white (bands and the fade mixed in)
vec3 sunTintOf(int i, vec3 P) {
  if (i >= sunCascades || sunEdge(sunCoord(i, P, vec3(0.0), 1.0)) <= 0.0) return vec3(1.0);
  return i == 0 ? vec3(1.0, 0.3, 0.25) : i == 1 ? vec3(0.3, 1.0, 0.3) : vec3(0.3, 0.5, 1.0);
}
vec3 sunTintBand(int i, vec3 P, float e) { return mix(sunTintOf(i + 1, P), sunTintOf(i, P), smoothstep(0.0, sunBlend, e)); }
vec3 sunCascadeTint(vec3 P) {
  vec3 t = vec3(1.0);
  float e0 = sunEdge(sunCoord(0, P, vec3(0.0), 1.0));
  float e1 = sunCascades > 1 ? sunEdge(sunCoord(1, P, vec3(0.0), 1.0)) : -1.0;
  float e2 = sunCascades > 2 ? sunEdge(sunCoord(2, P, vec3(0.0), 1.0)) : -1.0;
  if (e0 > 0.0) t = sunTintBand(0, P, e0);
  else if (e1 > 0.0) t = sunTintBand(1, P, e1);
  else if (e2 > 0.0) t = sunTintBand(2, P, e2);
  float d = length(P.xz - cameraPosition.xz);
  t = mix(t, sunCascades > 2 ? sunTintOf(2, P) : sunCascades > 1 ? sunTintOf(1, P) : sunTintOf(0, P), smoothstep(sunSplit.x, sunSplit.y, d));
  return mix(t, vec3(1.0), smoothstep(sunFade.x, sunFade.y, d));
}
`;

export class SunShadows {
  /** cascades: [{ radius, res, every }] smallest first; distance: shadow distance (m) */
  constructor(renderer, scene, cascades, { distance = Infinity } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.dir = new THREE.Vector3(0, 1, 0);
    this.enabled = true;
    this.frame = 0;
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.BackSide });
    this.depthMatDouble = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    this.uniforms = {
      sunDirW: { value: this.dir },
      sunColor: { value: new THREE.Color(1, 1, 1) },
      sunCascades: { value: 0 },
      sunShadowOn: { value: 1 },
      sunMat: { value: Array.from({ length: MAX }, () => new THREE.Matrix4()) },
      sunParams: { value: Array.from({ length: MAX }, () => new THREE.Vector4(0.1, 1 / 1024, 0, 1)) },
      sunFade: { value: new THREE.Vector2(1e8, 2e8) },
      sunSplit: { value: new THREE.Vector2(1e8, 2e8) },
      sunBlend: { value: 0.06 },
      sunDebug: { value: 0 },
      sunMap0: { value: null },
      sunMap1: { value: null },
      sunMap2: { value: null },
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
    const u = this.uniforms;
    u.sunCascades.value = this.cascades.length;
    // unused slots point at a valid depth texture so the samplers stay bound
    const dummy = this.cascades[0]?.rt.depthTexture ?? this._dummy();
    for (let i = 0; i < MAX; i++) u['sunMap' + i].value = this.cascades[i]?.rt.depthTexture ?? dummy;
    this.cascades.forEach((c, i) => this._setParams(i, c));
    this.frame = 0;
    this.version++;
  }

  _dummy() {
    if (!this.dummy) this.dummy = this._make(1, 4, 1, 10);
    return this.dummy.rt.depthTexture;
  }

  _make(radius, res, every, depth) {
    const rt = new THREE.WebGLRenderTarget(res, res, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false });
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
    this.uniforms.sunParams.value[i].set(c.texel * this.bias, 1 / c.res, (c.texel * 0.8 * this.bias) / c.span, step);
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
    const prevOverride = scene.overrideMaterial, prevTarget = r.getRenderTarget(), prevFog = scene.fog, prevBg = scene.background;
    scene.overrideMaterial = this.depthMatDouble;
    scene.fog = null;
    scene.background = null;
    this.onBeforeShadow?.();
    r.setRenderTarget(c.rt);
    r.clear(true, true, false);
    r.render(scene, c.cam);
    r.setRenderTarget(prevTarget);
    this.onAfterShadow?.();
    scene.overrideMaterial = prevOverride;
    scene.fog = prevFog;
    scene.background = prevBg;
    this.uniforms.sunMat.value[index].multiplyMatrices(c.cam.projectionMatrix, c.cam.matrixWorldInverse);
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

  /** Inject the sun (direct light + cascaded shadow) into a built-in lit material's shader. */
  inject(sh) {
    Object.assign(sh.uniforms, this.uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SUN_GLSL)
      .replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
        {
          vec3 sP = (vec4(-vViewPosition, 0.0) * viewMatrix).xyz + cameraPosition;
          #ifdef SUN_RECEIVER_SHIFT
            sP += sunDirW * SUN_RECEIVER_SHIFT; // in front of the receiver's own caster (impostor card)
          #endif
          vec3 sN = normalize((vec4(geometryNormal, 0.0) * viewMatrix).xyz);
          float sNdL = dot(sN, sunDirW);
          if (sNdL > 0.0) {
            IncidentLight sunL;
            sunL.direction = normalize((viewMatrix * vec4(sunDirW, 0.0)).xyz);
            sunL.color = sunColor * sunShadow(sP, sN, sNdL);
            sunL.visible = true;
            RE_Direct(sunL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
          }
        }`,
      )
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (sunDebug > 0.5) gl_FragColor.rgb *= sunCascadeTint((vec4(-vViewPosition, 0.0) * viewMatrix).xyz + cameraPosition);`);
  }
}

const _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1);
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _lup = new THREE.Vector3(), _snap = new THREE.Vector3();
const _cfwd = new THREE.Vector3(), _center = new THREE.Vector3();
