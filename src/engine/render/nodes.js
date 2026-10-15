// Small TSL pieces shared by the world materials (WorldMaterial.js) and the render passes.
import { Fn, property, attribute, mat3, mat4, vec3, float, uint, uvec2, ivec2, floor, dot, mix } from 'three/tsl';

/** Fragment property shared between a material's nodes and the world lighting model: the share
 *  of the sky reflection (leaves 0.15, rough ground 0.35). */
export const surfSpecK = property('float', 'surfSpecK');

/** Per-instance matrix of a FieldMesh (render/FieldMesh.js: attributes iM0..iM3), or null when
 *  the drawn geometry has none (build time). */
export function fieldInstance(builder) {
  if (!builder.geometry?.hasAttribute('iM0')) return null;
  return mat4(attribute('iM0', 'vec4'), attribute('iM1', 'vec4'), attribute('iM2', 'vec4'), attribute('iM3', 'vec4'));
}

/** Normal through an instance matrix, non-uniform scale handled (three's defaultnormal_vertex). */
export const instanceNormal = (m, n) => {
  const im = mat3(m);
  const c0 = m.element(0).xyz, c1 = m.element(1).xyz, c2 = m.element(2).xyz;
  return im.mul(n.div(vec3(dot(c0, c0), dot(c1, c1), dot(c2, c2))));
};

/** 4x4 Bayer threshold in (0, 1) of a pixel, computed (a constant array indexed per pixel is
 *  slow on Apple GPUs). p: fragment coordinate. */
export const bayer4 = /*@__PURE__*/ Fn(([p]) => {
  const q = ivec2(floor(p)).bitAnd(3);
  const xy = q.x.bitXor(q.y);
  const lo = xy.bitAnd(1).shiftLeft(1).bitOr(q.y.bitAnd(1));
  const hi = xy.shiftRight(1).bitAnd(1).shiftLeft(1).bitOr(q.y.shiftRight(1).bitAnd(1));
  return float(lo.shiftLeft(2).bitOr(hi)).add(0.5).div(16);
}).setLayout({ name: 'mcBayer4', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

/** Per-instance leaf tint from the instance position (xz), same hash as the impostors. */
export const leafTint = /*@__PURE__*/ Fn(([xz]) => {
  const hq = uvec2(ivec2(floor(xz.mul(4))).add(1048576));
  const hh = hq.x.mul(uint(1597334677)).bitXor(hq.y.mul(uint(3812015801))).toVar();
  hh.assign(hh.mul(uint(747796405)).add(uint(2891336453)));
  hh.assign(hh.bitXor(hh.shiftRight(uint(16))));
  hh.assign(hh.mul(uint(2246822519)));
  hh.assign(hh.bitXor(hh.shiftRight(uint(13))));
  const h1 = float(hh.bitAnd(uint(1023))).div(1023), h2 = float(hh.shiftRight(uint(10)).bitAnd(uint(1023))).div(1023);
  return mix(vec3(1.07, 1.03, 0.8), vec3(0.9, 1.0, 1.1), h2).mul(h1.mul(0.28).add(0.86));
}).setLayout({ name: 'mcLeafTint', type: 'vec3', inputs: [{ name: 'xz', type: 'vec2' }] });

