// Cascaded sun shadows done by hand (ported from three-rigged-game/src/lighting/sun.js), without
// any three.js light: the sun is injected into the lit materials' shader (RE_Direct) and the
// cascade depth maps are sampled with hardware PCF.
//
// - Up to 3 cascades follow the camera, texel-snapped (no shimmering). Cascade i is re-rendered
//   every `every[i]` frames, so the far ones cost less.
// - Cascade selection is by containment (smallest cascade containing the point) with a blend band
//   at the border; past the last cascade shadows fade out.
// - Shadow cameras only see LAYERS.STATIC + LAYERS.DYNAMIC (grass, water, FX don't cast).
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
float sunSample(int i, vec3 c) {
  if (i == 0) return sunPCF(sunMap0, c, sunParams[0]);
  if (i == 1) return sunPCF(sunMap1, c, sunParams[1]);
  return sunPCF(sunMap2, c, sunParams[2]);
}
float sunShadow(vec3 P, vec3 N, float NdL) {
  if (sunShadowOn < 0.5) return 1.0;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= sunCascades) break;
    vec3 c = sunCoord(i, P, N, NdL);
    float e = sunEdge(c);
    if (e > 0.0) {
      float s = sunSample(i, c);
      float f = smoothstep(0.0, 0.06, e);
      if (f < 1.0) {
        float s2 = 1.0;
        if (i + 1 < sunCascades) {
          vec3 c2 = sunCoord(i + 1, P, N, NdL);
          if (sunEdge(c2) > 0.0) s2 = sunSample(i + 1, c2);
        }
        s = mix(s2, s, f);
      }
      return s;
    }
  }
  return 1.0;
}
`;

export class SunShadows {
  /** cascades: [{ radius, res, every }] smallest first */
  constructor(renderer, scene, cascades) {
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
      sunMap0: { value: null },
      sunMap1: { value: null },
      sunMap2: { value: null },
    };
    this.setCascades(cascades);
  }

  setCascades(cascades) {
    for (const c of this.cascades ?? []) c.rt.dispose();
    this.cascades = cascades.slice(0, MAX).map((c) => this._make(c.radius, c.res, c.every ?? 1, c.depth ?? 600));
    const u = this.uniforms;
    u.sunCascades.value = this.cascades.length;
    // unused slots point at a valid depth texture so the samplers stay bound
    const dummy = this.cascades[0]?.rt.depthTexture ?? this._dummy();
    for (let i = 0; i < MAX; i++) u['sunMap' + i].value = this.cascades[i]?.rt.depthTexture ?? dummy;
    this.cascades.forEach((c, i) => this._setParams(i, c));
    this.frame = 0;
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
    cam.layers.mask = (1 << LAYERS.STATIC) | (1 << LAYERS.DYNAMIC);
    return { radius, res, every, depth, rt, cam, texel: (2 * radius) / res, rendered: false };
  }

  _setParams(i, c) {
    const step = THREE.MathUtils.clamp(0.05 / c.texel, 1, 2.5);
    this.uniforms.sunParams.value[i].set(c.texel, 1 / c.res, (c.texel * 0.8) / c.depth, step);
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
    cam.position.copy(_snap).addScaledVector(this.dir, c.depth * 0.5);
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
    camera.getWorldDirection(_cfwd);
    _cfwd.y = 0;
    if (_cfwd.lengthSq() < 1e-4) _cfwd.set(0, 0, -1);
    _cfwd.normalize();
    this.cascades.forEach((c, i) => {
      if (!force && c.rendered && (this.frame + i) % c.every !== 0) return;
      _center.copy(camera.position).addScaledVector(_cfwd, c.radius * 0.5);
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
      );
  }
}

const _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1);
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _lup = new THREE.Vector3(), _snap = new THREE.Vector3();
const _cfwd = new THREE.Vector3(), _center = new THREE.Vector3();
