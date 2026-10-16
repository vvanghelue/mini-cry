// Small TSL helpers shared by the render modules (WebGPU, three.js node materials).
//
//  - U(value): a uniform shared by every material of a render call (renderGroup: uploaded once per
//    render, not per object). The `.value` API matches the old `{ value }` uniform objects, so the
//    debug panel, the editor and the tools keep writing `uniforms.x.value`.
//  - screen-space conventions: WebGPU's framebuffer (and the textures rendered into it) have their
//    origin top-left, NDC y points up: a clip position maps to uv (x * 0.5 + 0.5, 0.5 - y * 0.5).
//  - instancing: our own instanced attributes (render/Instancing.js), not three's InstancedMesh, so
//    every instanced mesh of a material shares one shader (three keys InstancedMesh shaders per
//    object).
import { Fn, uniform, renderGroup, float, int, ivec2, vec2, vec3, vec4, mat4, uvec2, uint, mix, attribute, modelWorldMatrix, positionGeometry } from 'three/tsl';

/** Uniform shared by every material of a render call (`.value` like the old uniform objects). */
export const U = (v, type) => uniform(v, type).setGroup(renderGroup);

/** Clip / NDC xy -> texture uv of a render target (WebGPU: v down). */
export const ndcToUv = (p) => vec2(p.x.mul(0.5).add(0.5), p.y.mul(-0.5).add(0.5));

/** 4x4 Bayer threshold in [0, 1) at a pixel (computed, not a constant array: Apple GPUs). */
export const bayer4 = Fn(([p]) => {
  const q = ivec2(p).bitAnd(3);
  const x = q.x, y = q.y, xy = x.bitXor(y);
  const lo = xy.bitAnd(1).shiftLeft(1).bitOr(y.bitAnd(1));
  const hi = xy.shiftRight(1).bitAnd(1).shiftLeft(1).bitOr(y.shiftRight(1).bitAnd(1));
  return float(lo.shiftLeft(2).bitOr(hi)).add(0.5).div(16.0);
});

/** Same pattern as an integer 0..15 (SSAO rotations). */
export const bayer4i = Fn(([p]) => {
  const q = ivec2(p).bitAnd(3);
  const x = q.x, y = q.y, xy = x.bitXor(y);
  const lo = xy.bitAnd(1).shiftLeft(1).bitOr(y.bitAnd(1));
  const hi = xy.shiftRight(1).bitAnd(1).shiftLeft(1).bitOr(y.shiftRight(1).bitAnd(1));
  return lo.shiftLeft(2).bitOr(hi);
});

/** Per-instance leaf tint from the instance position (same hash as the old GLSL). */
export const instanceTint = Fn(([pos]) => {
  const hq = uvec2(ivec2(pos.xz.mul(4.0).floor()).add(1048576));
  let hh = hq.x.mul(uint(1597334677)).bitXor(hq.y.mul(uint(3812015801)));
  hh = hh.mul(uint(747796405)).add(uint(2891336453));
  hh = hh.bitXor(hh.shiftRight(uint(16)));
  hh = hh.mul(uint(2246822519));
  hh = hh.bitXor(hh.shiftRight(uint(13)));
  const h1 = float(hh.bitAnd(uint(1023))).div(1023.0);
  const h2 = float(hh.shiftRight(uint(10)).bitAnd(uint(1023))).div(1023.0);
  return mix(vec3(1.07, 1.03, 0.8), vec3(0.9, 1.0, 1.1), h2).mul(h1.mul(0.28).add(0.86));
});

// --- instancing ---------------------------------------------------------------------------------

export const INSTANCE_ATTRS = ['iM0', 'iM1', 'iM2', 'iM3'];

/** Build time: does this geometry carry our instance matrices? */
export const isInstanced = (builder) => !!builder.geometry?.attributes?.iM0;

/** The instance matrix (vertex stage) of a geometry with instance attributes. */
export const instanceMatrix = () => mat4(attribute('iM0', 'vec4'), attribute('iM1', 'vec4'), attribute('iM2', 'vec4'), attribute('iM3', 'vec4'));

/** World-space origin of the instance / object (vertex stage). */
export const objectOrigin = (builder) => (isInstanced(builder) ? modelWorldMatrix.mul(vec4(attribute('iM3', 'vec4').xyz, 1.0)).xyz : modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz);

export { positionGeometry, int, float, vec2, vec3, vec4 };
