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
import { NodeBuilder, FunctionNode } from 'three/webgpu';
import { Fn, uniform, renderGroup, texture, texture3D, float, int, ivec2, vec2, vec3, vec4, mat4, uvec2, uint, mix, attribute, modelWorldMatrix, positionGeometry } from 'three/tsl';

// WGSL functions (Fn().setLayout) are generated once per backend in three.js r186 and their code
// reused by every later shader, without visiting their body again: the uniforms and textures they
// read are then missing from those shaders. Ours read the engine's shared uniforms (sun, GI,
// haze...), so the code is generated once per shader instead (still one copy per shader, called
// from every call site, instead of the body inlined at each call), per stage (a function used in
// the vertex stage declares its textures there).
NodeBuilder.prototype.buildFunctionNode = function (shaderNode) {
  const caches = (this.mcFunctions ??= {});
  const cache = (caches[this.shaderStage] ??= new Map());
  let fn = cache.get(shaderNode);
  if (fn === undefined) {
    fn = new FunctionNode();
    const previous = this.currentFunctionNode;
    this.currentFunctionNode = fn;
    fn.code = this.buildFunctionCode(shaderNode);
    this.currentFunctionNode = previous;
    cache.set(shaderNode, fn);
  }
  return fn;
};

let _uid = 0;

/** Uniform shared by every material of a render call (`.value` like the old uniform objects). Named:
 *  WGSL functions (Fn().setLayout) are generated once and reused by every shader, so the uniforms
 *  they read need the same name everywhere. */
export const U = (v, type) => uniform(v, type).setGroup(renderGroup).setName(`mcU${++_uid}`);

/** A texture node sampled with explicit coordinates: no uv transform (three adds a per-object mat3
 *  uniform to every sample of a texture node made without uv: uploaded with each draw). In the
 *  shared render bind group, not the per-object one (three's default): Dawn / Metal then binds a
 *  material's textures once per pass instead of re-binding all of them (texture arrays, shadow
 *  cascades, GI volumes, SSAO...) at every draw — that cost most of the GPU process' time. */
export const tex = (t) => texture(t).setUpdateMatrix(false).setGroup(renderGroup);
export const tex3D = (t) => texture3D(t).setGroup(renderGroup); // (3D texture nodes never transform their uv)

/** A texture node with a stable name (see U), in the render bind group (see tex). */
export const T = (node, name) => { node.updateMatrix = false; return node.setGroup(renderGroup).setName(`mc${name}${++_uid}`); };

/** Clip / NDC xy -> texture uv of a render target (WebGPU: v down). */
export const ndcToUv = (p) => vec2(p.x.mul(0.5).add(0.5), p.y.mul(-0.5).add(0.5));

/** 4x4 Bayer threshold in [0, 1) at a pixel (computed, not a constant array: Apple GPUs). */
export const bayer4 = Fn(([p]) => {
  const q = ivec2(p).bitAnd(3);
  const x = q.x, y = q.y, xy = x.bitXor(y);
  const lo = xy.bitAnd(1).shiftLeft(1).bitOr(y.bitAnd(1));
  const hi = xy.shiftRight(1).bitAnd(1).shiftLeft(1).bitOr(y.shiftRight(1).bitAnd(1));
  return float(lo.shiftLeft(2).bitOr(hi)).add(0.5).div(16.0);
}).setLayout({ name: 'bayer4', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

/** Same pattern as an integer 0..15 (SSAO rotations). */
export const bayer4i = Fn(([p]) => {
  const q = ivec2(p).bitAnd(3);
  const x = q.x, y = q.y, xy = x.bitXor(y);
  const lo = xy.bitAnd(1).shiftLeft(1).bitOr(y.bitAnd(1));
  const hi = xy.shiftRight(1).bitAnd(1).shiftLeft(1).bitOr(y.shiftRight(1).bitAnd(1));
  return lo.shiftLeft(2).bitOr(hi);
}).setLayout({ name: 'bayer4i', type: 'int', inputs: [{ name: 'p', type: 'ivec2' }] });

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
}).setLayout({ name: 'instanceTint', type: 'vec3', inputs: [{ name: 'pos', type: 'vec3' }] });

// --- instancing ---------------------------------------------------------------------------------

export const INSTANCE_ATTRS = ['iM0', 'iM1', 'iM2', 'iM3'];

/** Build time: does this geometry carry our instance matrices? */
export const isInstanced = (builder) => !!builder.geometry?.attributes?.iM0;

/** The instance matrix (vertex stage) of a geometry with instance attributes. */
export const instanceMatrix = () => mat4(attribute('iM0', 'vec4'), attribute('iM1', 'vec4'), attribute('iM2', 'vec4'), attribute('iM3', 'vec4'));

/** World-space origin of the instance / object (vertex stage). */
export const objectOrigin = (builder) => (isInstanced(builder) ? modelWorldMatrix.mul(vec4(attribute('iM3', 'vec4').xyz, 1.0)).xyz : modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz);

export { positionGeometry, int, float, vec2, vec3, vec4 };
