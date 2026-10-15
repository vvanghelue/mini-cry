// Sky cloud layer (TSL), shared by the sky dome (Lighting.js), the water's sky reflection
// (Water.js) and the lens flare's sun probes (LensFlare.js): a cloud that hides the sun in the
// sky also dims its flare.
import { Fn, vec2, float, floor, fract, sin, dot, mix, smoothstep, select } from 'three/tsl';

const cloudHash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

const cloudNoise = /*@__PURE__*/ Fn(([p]) => {
  const i = floor(p), f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2).add(3));
  const a = mix(cloudHash(i), cloudHash(i.add(vec2(1, 0))), f.x);
  const b = mix(cloudHash(i.add(vec2(0, 1))), cloudHash(i.add(vec2(1, 1))), f.x);
  return mix(a, b, f.y);
}).setLayout({ name: 'cloudNoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

const cache = new WeakMap();

/** Fn(unit direction) -> vec2(x: cloud density 0..1 (the sky draws it at 0.9 opacity), y: raw
 *  noise (shading)). u: Lighting.skyU (cloudCoverage, cloudSpeed, uTime). */
export function skyClouds(u) {
  let fn = cache.get(u);
  if (fn) return fn;
  fn = Fn(([d]) => {
    const h = d.y;
    // three octaves of noise projected on a plane above
    const t = u.uTime.mul(u.cloudSpeed);
    const uv = d.xz.div(h.add(0.12)).mul(1.6).add(vec2(t.mul(0.002), t.mul(0.0012))).toVar();
    const n = cloudNoise(uv).mul(0.6).add(cloudNoise(uv.mul(2.7).add(3.1)).mul(0.3)).add(cloudNoise(uv.mul(6.1)).mul(0.1)).toVar();
    const c = float(1).sub(u.cloudCoverage);
    const dens = smoothstep(c, c.add(0.25), n).mul(smoothstep(0, 0.18, h));
    return select(h.greaterThan(0), vec2(dens, n), vec2(0));
  });
  cache.set(u, fn);
  return fn;
}

