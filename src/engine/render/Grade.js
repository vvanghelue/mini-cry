// Colour grade + output, applied inside every material that draws to the screen (no extra pass,
// Engine.js installs it as the renderer's output hook): AgX tone mapping (filmic, natural greens
// and skies that roll off instead of clipping) with a slightly punchier look — a touch more
// contrast and saturation — so the island doesn't look washed out, then the sRGB encoding.
// Materials with `toneMapped: false` (additive glows, the flare) only get the encoding.
import { Fn, vec3, vec4, float, mix, dot, clamp, pow, agxToneMapping, sRGBTransferOETF, toneMappingExposure, context } from 'three/tsl';

export const grade = Fn(([color, exposure]) => {
  const c = clamp(agxToneMapping(color, exposure), 0.0, 1.0);
  // grade in display space: mild S curve + saturation
  const g = pow(c, vec3(1.0 / 2.2)).toVar();
  g.assign(mix(g, g.mul(g).mul(g.mul(-2.0).add(3.0)), 0.22));
  const l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g.assign(clamp(mix(vec3(l), g, 1.1), 0.0, 1.0));
  return pow(g, vec3(2.2));
});

/** Does a render into `rt` produce the final image (canvas, or the FXAA source)? */
export const isOutputTarget = (rt) => rt === null || rt?.mcOutput === true;

/**
 * Renderer context: tone map + encode the output of every material drawn to the screen (the
 * canvas, or a render target flagged `mcOutput`). renderer.toneMapping stays off and the output
 * colour space linear, so three.js renders straight to the canvas instead of an HDR buffer + an
 * output pass. A material with `mcRawOutput` writes its colour as is (additive glows, flare, motes:
 * linear, like their WebGL shaders did).
 */
export function outputContext() {
  return context({
    getOutput: (out, builder) => {
      const m = builder.material;
      if (!isOutputTarget(builder.renderer.getRenderTarget()) || m?.mcRawOutput) return out;
      const rgb = m?.toneMapped === false ? out.rgb : grade(out.rgb, toneMappingExposure);
      return vec4(sRGBTransferOETF(rgb), out.a);
    },
  });
}

export { float };
