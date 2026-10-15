// Display output, applied inline by every material drawn to the screen (renderer.contextNode
// `getOutput`, see Engine.js): no intermediate HDR target and no extra full-screen pass, so the
// tile GPU writes each pixel once, like the old WebGL path did.
//
//   lit colour x exposure -> AgX + a grade -> sRGB -> fog (display space, like three's
//   WebGL fog_fragment, which mixed after the colour space conversion)
//
// Materials pick their own output with `material.mcOutput(node, builder)` (water: own fog, SSR
// blended after the tone mapping; the sky: no fog). Unlit materials with `toneMapped = false`
// only get the sRGB encoding. Off-screen targets (shadow maps, SSAO, impostor bakes...) keep
// linear values, except the engine's own frame targets (`rt.isMcOutput`, FXAA / SSR modes).
import * as THREE from 'three/webgpu';
import { Fn, vec3, vec4, float, uniform, mix, clamp, pow, dot, exp, positionView, sRGBTransferOETF, agxToneMapping, renderGroup } from 'three/tsl';

/** Tone mapping exposure (Lighting: base exposure x auto exposure x sun dazzle). */
export const exposure = uniform(1).setGroup(renderGroup);
/** World fog (FogExp2): colour in display space (sRGB), density. Lighting keeps them up to date. */
export const fogColor = uniform(new THREE.Color(0.7, 0.85, 0.95)).setGroup(renderGroup);
export const fogDensity = uniform(0).setGroup(renderGroup);

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** AgX tone mapping (exposure inside) with a slightly punchier look: a mild S curve and a bit
 *  more saturation in display space (no washed-out island), back to linear. */
export const grade = /*@__PURE__*/ Fn(([color]) => {
  const c = clamp(agxToneMapping(color, exposure), 0, 1);
  const g = pow(c, vec3(1 / 2.2)).toVar();
  g.assign(mix(g, g.mul(g).mul(g.mul(-2).add(3)), 0.22));
  const l = dot(g, LUMA);
  g.assign(clamp(mix(vec3(l), g, 1.1), 0, 1));
  return pow(g, vec3(2.2));
});

/** Linear lit colour -> display colour (tone mapped, graded, sRGB). */
export const toDisplay = (rgb) => sRGBTransferOETF(grade(rgb));

/** exp2 fog factor of the shaded point (view depth), as three's FogExp2. */
export const fogFactor = () => float(1).sub(exp(fogDensity.mul(fogDensity).mul(positionView.z).mul(positionView.z).negate()));

/** Display colour with the world fog mixed in (display space). */
export const withFog = (rgb) => mix(rgb, fogColor, fogFactor());

/** Is this build drawing to the screen (canvas, or the engine's frame target)? */
export function toScreen(builder) {
  const rt = builder.renderer.getRenderTarget();
  return rt === null || rt.isMcOutput === true;
}

/** renderer.contextNode getOutput hook. */
export function outputTransform(node, builder) {
  if (!toScreen(builder)) return node;
  const m = builder.material;
  if (m.mcRaw) return node; // already display values (FXAA / copy passes)
  if (m.mcOutput) return m.mcOutput(node, builder);
  const out = vec4(node);
  let rgb = m.toneMapped === false ? sRGBTransferOETF(out.rgb) : toDisplay(out.rgb);
  if (m.fog === true && builder.scene?.userData.mcFog === true) rgb = withFog(rgb);
  return vec4(rgb, out.a);
}
