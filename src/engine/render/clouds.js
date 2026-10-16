// Sky cloud layer (TSL), shared by the sky dome (Lighting.js), the water's sky reflection
// (Water.js) and the lens flare's sun probes (LensFlare.js): a cloud that hides the sun in the
// sky also dims its flare. Reads Lighting.skyU.cloudCoverage / cloudSpeed and the clock uTime.
import { Fn, vec2, float, fract, sin, dot, floor, mix, smoothstep, select } from 'three/tsl';

const cloudHash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

const cloudNoise = Fn(([p]) => {
  const i = floor(p), f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2.0).add(3.0));
  const a = mix(cloudHash(i), cloudHash(i.add(vec2(1, 0))), f.x);
  const b = mix(cloudHash(i.add(vec2(0, 1))), cloudHash(i.add(vec2(1, 1))), f.x);
  return mix(a, b, f.y);
});

/** skyU: Lighting.skyU. Returns fn(d: unit direction) -> vec2(cloud density 0..1, raw noise). */
export function skyCloudsFn(skyU) {
  const { cloudCoverage, cloudSpeed, uTime } = skyU;
  return Fn(([d]) => {
    const h = d.y;
    // three octaves of noise projected on a plane above
    const t = uTime.mul(cloudSpeed);
    const uv = d.xz.div(h.max(0.0).add(0.12)).mul(1.6).add(vec2(t.mul(0.002), t.mul(0.0012)));
    const n = cloudNoise(uv).mul(0.6).add(cloudNoise(uv.mul(2.7).add(3.1)).mul(0.3)).add(cloudNoise(uv.mul(6.1)).mul(0.1));
    const c = float(1.0).sub(cloudCoverage);
    const dens = smoothstep(c, c.add(0.25), n).mul(smoothstep(0.0, 0.18, h));
    return vec2(select(h.greaterThan(0.0), dens, 0.0), n);
  });
}
