// Sky cloud layer (GLSL), shared by the sky dome (Lighting.js) and the lens flare's sun probes
// (LensFlare.js): a cloud that hides the sun in the sky also dims its flare.
// Needs the uniforms cloudCoverage, cloudSpeed, uTime (Lighting.skyU).
export const CLOUDS_GLSL = /* glsl */ `
uniform float cloudCoverage, cloudSpeed, uTime;
float cloudHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cloudNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cloudHash(i), cloudHash(i + vec2(1, 0)), f.x), mix(cloudHash(i + vec2(0, 1)), cloudHash(i + vec2(1, 1)), f.x), f.y);
}
// unit direction -> x: cloud density 0..1 (the sky draws it at 0.9 opacity), y: raw noise (shading)
vec2 skyClouds(vec3 d) {
  float h = d.y;
  if (h <= 0.0) return vec2(0.0);
  // three octaves of noise projected on a plane above
  vec2 uv = d.xz / (h + 0.12) * 1.6 + vec2(uTime * cloudSpeed * 0.002, uTime * cloudSpeed * 0.0012);
  float n = cloudNoise(uv) * 0.6 + cloudNoise(uv * 2.7 + 3.1) * 0.3 + cloudNoise(uv * 6.1) * 0.1;
  return vec2(smoothstep(1.0 - cloudCoverage, 1.0 - cloudCoverage + 0.25, n) * smoothstep(0.0, 0.18, h), n);
}
`;
