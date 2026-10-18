// Ocean + rivers. No depth pre-pass: the water depth comes from the terrain heightmap, uploaded
// once as a half-float texture, so the shader knows how deep the water is under every pixel (shore
// foam, turquoise shallows -> deep blue, see-through lagoon) at the cost of one texture fetch.
//
// Ocean: a polar grid that follows the camera (dense near, sparse to the horizon), a smooth swell
// of directional waves (height + analytic normal) in the vertex stage, small ripples from two
// scrolling samples of a normal map (Surfaces.waterNormal) in the fragment stage. Shading:
// Fresnel between the body colour (absorbed with depth, lit by the sun / sky) and the reflected
// sky (gradient + the cloud layer), a sharp sun glint, light scattered through the wave crests.
// Rivers: ribbon meshes along the river polylines, ripples scrolling with the flow.
// Optional screen-space reflections of the shore, trees, boats... in place of the sky
// reflection where a ray finds them on screen (render/SSR.js).
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, max, min, abs, mix, pow, sin, cos, sqrt, fract, floor, dot, exp, clamp, normalize, reflect, distance, length, smoothstep, step, select,
  attribute, varyingProperty, positionLocal, positionView, modelWorldMatrix, cameraWorldMatrix, cameraViewMatrix, cameraPosition, screenCoordinate, texture, toneMappingExposure, sRGBTransferOETF,
} from 'three/tsl';
import { LAYERS } from '../render/layers.js';
import { U, tex } from '../render/tsl.js';
import { grade } from '../render/Grade.js';
import { SSR } from '../render/SSR.js';

// far deep sea: opaque past `depth` m of water, faded in between `from` and `to` m from the camera.
// The terrain renderer doesn't draw the seabed there (TerrainRenderer: whole nodes deeper than
// that, farther than `to`): from a plane, the sea floor out to the horizon would be fully lit and
// then 90 % hidden under the water
export const DEEP_SEA = { depth: 6, from: 1400, to: 2000 };

// directional swell: dir xy, spatial frequency, amplitude
const WAVES = [[0.8, 0.6, 0.11, 0.5], [-0.35, 0.94, 0.13, 0.38], [0.97, -0.24, 0.23, 0.22], [0.42, 0.91, 0.37, 0.12]];

const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const noise = Fn(([p]) => {
  const i = floor(p), f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2.0).add(3.0));
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), f.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x), f.y);
});

export class Water {
  constructor(terrain, lighting, scene) {
    this.terrain = terrain;
    this.lighting = lighting;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'Water';
    this.heightTex = this._heightTexture();
    const env = lighting.env;
    this.oceanU = this._uniforms(env.ocean, false);
    this.riverU = this._uniforms(env.river, true);
    this.ocean = new THREE.Mesh(this._polarGrid(), this._material(this.oceanU, false));
    this.ocean.frustumCulled = false;
    this.ocean.renderOrder = 10;
    this.ocean.layers.set(LAYERS.DETAIL);
    this.group.add(this.ocean);
    this.rivers = new THREE.Group();
    this.group.add(this.rivers);
    this.riverMat = this._material(this.riverU, true);
    this.buildRivers();
    scene.add(this.group);
  }

  _uniforms(c, river) {
    const t = this.terrain;
    return {
      waveAmp: U(river ? 0.04 : 0.45),
      flowSpeed: U(river ? 1.4 : 0.15),
      opacity: U(river ? 0.92 : 0.9),
      shallow: U(new THREE.Color(c.shallow)),
      deep: U(new THREE.Color(c.deep)),
      foam: U(new THREE.Color(this.lighting.env.ocean.foam)),
      night: U(0),
      camPos: U(new THREE.Vector3()),
      terrainRect: U(new THREE.Vector4(t.x0, t.z0, t.size, 0)), // x0, z0, size, unused
      rippleScale: U(river ? 1.6 : 1),
    };
  }

  _material(u, river) {
    const L = this.lighting, sk = L.skyU, sunU = L.sun.uniforms, haze = L.haze, ssr = L.ssr.uniforms;
    const uTime = L.uniforms.uTime, heightTex = tex(this.heightTex), waterNormal = L.surfaces.uniforms.waterNormal;
    const vWaveN = varyingProperty('vec3', 'vWaveN'), vCrest = varyingProperty('float', 'vCrest'), vHaze = varyingProperty('float', 'vHaze');
    const vFlow = varyingProperty('vec2', 'vFlow');
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    m.lights = false;
    m.positionNode = Fn(() => {
      const w = modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz.toVar();
      const fade = float(1.0).sub(smoothstep(120.0, 400.0, distance(w.xz, u.camPos.xz)));
      // the swell: height + gradient (d/dx, d/dz)
      const r = vec3(0.0).toVar();
      for (const [dx, dz, k, a] of WAVES) {
        const ph = dot(vec2(dx, dz), w.xz).mul(k).add(uTime.mul(Math.sqrt(9.8 * k) * 0.55)).toVar();
        r.x.addAssign(sin(ph).mul(a));
        r.y.addAssign(cos(ph).mul(a * k * dx));
        r.z.addAssign(cos(ph).mul(a * k * dz));
      }
      const h = r.mul(u.waveAmp).mul(fade).toVar();
      vWaveN.assign(normalize(vec3(h.y.negate(), 1.0, h.z.negate())));
      vCrest.assign(h.x.div(max(u.waveAmp, 1e-3)));
      vFlow.assign(attribute('flow', 'vec2'));
      // the near haze's opacity (render/Haze.js), as on the land
      vHaze.assign(haze.vertexFn(w.add(vec3(0.0, h.x, 0.0)).sub(cameraPosition)));
      return positionLocal.add(vec3(0.0, h.x, 0.0)); // the meshes are only translated
    })();
    const ripple = (p) => {
      const t = waterNormal.sample(p).xyz.mul(2.0).sub(1.0);
      return vec3(t.x, 0.0, t.y);
    };
    const skyAt = (d0) => {
      const d = vec3(d0.x, abs(d0.y), d0.z).toVar();
      const c = mix(sk.horizon, sk.zenith, pow(d.y, 0.5));
      const cl = L.skyClouds(d);
      const cloudLit = mix(sk.horizon.mul(1.1), vec3(1.0), sk.night.oneMinus().mul(0.6)).add(sunU.sunColor.mul(0.05));
      return mix(c, cloudLit.mul(sk.night.oneMinus().mul(0.8).add(0.2)), cl.x.mul(0.85));
    };
    m.fragmentNode = Fn(() => {
      const vWorld = cameraWorldMatrix.mul(vec4(positionView, 1.0)).xyz.toVar();
      const uv = vWorld.xz.sub(u.terrainRect.xy).div(u.terrainRect.z).toVar();
      const ground = heightTex.sample(uv).r;
      const depth = vWorld.y.sub(ground).toVar();
      If(uv.x.lessThan(0.0).or(uv.y.lessThan(0.0)).or(uv.x.greaterThan(1.0)).or(uv.y.greaterThan(1.0)), () => { depth.assign(60.0); });
      const V = normalize(cameraPosition.sub(vWorld)).toVar();
      const dist = positionView.z.negate();
      // ripples: two scrolling scales of the normal map (along the flow on rivers), fading with distance
      const drift = (river ? vFlow.mul(uTime.mul(u.flowSpeed).mul(0.35)) : vec2(uTime.mul(0.011), uTime.mul(0.007))).toVar();
      const rp = ripple(vWorld.xz.mul(u.rippleScale.mul(0.055)).add(drift)).add(ripple(vWorld.xz.mul(u.rippleScale.mul(0.13)).sub(drift.yx.mul(1.3)).add(vec2(0.37, 0.71)))).toVar();
      const rk = float(river ? 0.22 : 0.3).mul(float(1.0).sub(smoothstep(40.0, 600.0, dist).mul(0.8))).toVar();
      const n = normalize(vWaveN.add(rp.mul(rk))).toVar();
      const NdV = max(dot(n, V), 0.0);
      const F = float(0.02).add(pow(float(1.0).sub(NdV), 5.0).mul(0.98)).toVar();
      // body: absorbed toward the deep colour with depth, lit by the sun and the sky
      const dk = float(1.0).sub(exp(max(depth, 0.0).negate().mul(river ? 0.45 : 0.16))).toVar();
      // the far shadows (render/FarShadows.js): mountains and the trees on the shore shade the water
      const far = vec2(1.0).toVar();
      // (at the undisplaced surface: the swell would streak a shadow's grazing edge)
      If(L.sun.far.uniforms.farOn.greaterThan(0.5), () => { far.assign(L.sun.far.sampleFn('any')(vWorld.sub(vec3(0.0, vCrest.mul(u.waveAmp), 0.0)), float(1.0))); });
      const sunDir = sunU.sunDirW, sunColor = sunU.sunColor.mul(min(far.x, far.y)).toVar();
      const sunUp = clamp(sunDir.y.mul(2.0), 0.0, 1.0);
      const lightC = sunColor.mul(sunUp.mul(0.16).add(0.12)).add(sk.zenith.mul(0.35)).add(sk.horizon.mul(0.15)).toVar();
      const body = mix(u.shallow, u.deep, dk).mul(lightC).mul(mix(1.0, 0.25, u.night)).toVar();
      // light through the wave crests (turquoise glow facing the sun)
      const sss = pow(max(dot(V, sunDir.negate()), 0.0), 3.0).mul(clamp(vCrest.mul(0.5).add(0.5), 0.0, 1.0));
      body.addAssign(u.shallow.mul(sunColor).mul(sss.mul(0.25).mul(float(1.0).sub(dk.mul(0.5)))));
      // reflection: sky + clouds, the sun's glint
      const refl = skyAt(reflect(V.negate(), n));
      const col = mix(body, refl, F).toVar();
      const H = normalize(sunDir.add(V));
      const NdH = max(dot(n, H), 0.0);
      col.addAssign(sunColor.mul(pow(NdH, 900.0).mul(6.0).add(pow(NdH, 120.0).mul(0.25))).mul(step(0.0, sunDir.y)));
      // shore foam: animated bands where it gets shallow, broken by noise (the sea: only there, its
      // bands are 0 past 1.6 m of depth; rivers have foam streaks everywhere)
      const f = float(0.0).toVar();
      const foam = () => {
        const fuv = vWorld.xz.mul(0.35).add(vFlow.mul(uTime.mul(u.flowSpeed))).toVar();
        const fn = noise(fuv).mul(0.6).add(noise(fuv.mul(2.3)).mul(0.3)).add(noise(fuv.mul(5.1)).mul(0.1));
        const band = river ? smoothstep(0.85, 0.0, depth) : smoothstep(0.85, 0.0, depth).add(smoothstep(1.6, 0.4, depth).mul(sin(depth.mul(6.0).sub(uTime.mul(1.6))).mul(0.5).add(0.5)).mul(0.6));
        f.assign(smoothstep(0.5, 0.8, fn.mul(band).add(band.mul(0.2))));
        if (river) f.assign(max(f, smoothstep(0.74, 0.92, noise(fuv.mul(1.7))).mul(0.3)));
      };
      if (river) foam();
      else If(depth.lessThan(1.6), foam);
      col.assign(mix(col, u.foam.mul(lightC).mul(0.75), f.mul(0.8)));
      // see-through in the shallows, opaque at grazing angles (Fresnel) and in the deep
      const alpha = max(max(mix(0.45, u.opacity, smoothstep(0.0, 3.0, depth)), f.mul(0.9)), F).mul(smoothstep(-0.05, 0.12, depth)).toVar();
      if (!river) alpha.assign(mix(alpha, 1.0, smoothstep(DEEP_SEA.from, DEEP_SEA.to, length(vWorld.sub(cameraPosition))).mul(smoothstep(DEEP_SEA.depth - 1, DEEP_SEA.depth, depth))));
      const hz = haze.fragFn(vWorld.sub(cameraPosition), vHaze).toVar(); // near haze + far fog (render/Haze.js)
      col.assign(col.mul(hz.a).add(hz.rgb));
      // tone mapping + sRGB here (display space): the reflections below blend in that space
      const out = vec4(sRGBTransferOETF(grade(col, toneMappingExposure)), alpha).toVar();
      // screen-space reflections: the previous frame is tone mapped already, so it replaces the
      // reflected share of the shaded colour here, in display space
      If(ssr.ssrOn.greaterThan(0.5).and(F.greaterThan(0.025)), () => {
        // calmer normal than the shading one: at grazing angles the full ripples would send most
        // rays to the sky or under the surface; never below the horizon (nothing to hit there)
        const nS = normalize(vWaveN.add(rp.mul(rk).mul(0.25)));
        const Rw = reflect(V.negate(), nS).toVar();
        Rw.y.assign(max(Rw.y, 0.005));
        const Rv = normalize(cameraViewMatrix.mul(vec4(Rw, 0.0)).xyz);
        const s = L.ssr.traceFn(positionView, Rv, SSR.ign(screenCoordinate.xy)).toVar();
        // the reflected share is not see-through: out = (1 - w) * (water over the bed) + w * reflection
        const w = clamp(s.a.mul(F).mul(ssr.ssrIntensity).mul(float(1.0).sub(f.mul(0.8))).mul(hz.a), 0.0, 1.0).toVar();
        const a2 = float(1.0).sub(w.oneMinus().mul(out.a.oneMinus())).toVar();
        out.assign(vec4(w.oneMinus().mul(out.a).mul(out.rgb).add(w.mul(s.rgb)).div(max(a2, 1e-4)), a2));
        If(ssr.ssrDebug.greaterThan(0.5), () => { out.assign(vec4(s.rgb.mul(s.a), 1.0)); });
      });
      return out;
    })();
    return m;
  }

  _heightTexture() {
    const t = this.terrain;
    const tex = new THREE.DataTexture(toHalf(t.heights), t.res, t.res, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  /** Call after sculpting so depth shading follows the new ground. */
  refreshHeights() {
    this.heightTex.image.data = toHalf(this.terrain.heights, this.heightTex.image.data);
    this.heightTex.needsUpdate = true;
  }

  /** Rings of quads around the origin, ring radius growing geometrically (follows the camera). */
  _polarGrid() {
    // out to the camera's far plane (World.load: the world square's diagonal)
    const seg = 96, rings = [], reach = Math.max(6000, Math.SQRT2 * this.terrain.size);
    let r = 0, step = 2.5;
    while (r < reach) { rings.push(r); r += step; step *= 1.07; }
    const pos = [], flow = [], idx = [];
    for (let k = 0; k < rings.length; k++) {
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        pos.push(Math.cos(a) * rings[k], 0, Math.sin(a) * rings[k]);
        flow.push(0.6, 0.4);
      }
    }
    for (let k = 0; k < rings.length - 1; k++) {
      for (let s = 0; s < seg; s++) {
        const a = k * seg + s, b = k * seg + ((s + 1) % seg), c = a + seg, d = b + seg;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 2));
    g.setIndex(idx);
    return g;
  }

  buildRivers() {
    for (const m of this.rivers.children) m.geometry.dispose();
    this.rivers.clear();
    const mat = this.riverMat;
    for (const r of this.terrain.rivers) {
      const pts = r.points;
      const pos = [], flow = [], idx = [];
      const half = r.width / 2 + 3;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], q = pts[Math.min(pts.length - 1, k + 1)], o = pts[Math.max(0, k - 1)];
        let dx = q[0] - o[0], dz = q[1] - o[1];
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        const nx = -dz, nz = dx;
        for (const side of [-1, -0.5, 0, 0.5, 1]) {
          pos.push(p[0] + nx * half * side, p[2], p[1] + nz * half * side);
          flow.push(dx, dz);
        }
      }
      for (let k = 0; k < pts.length - 1; k++) {
        for (let s = 0; s < 4; s++) {
          const a = k * 5 + s, b = a + 1, c = a + 5, d = c + 1;
          // counter-clockwise seen from above (b - a is across, c - a downstream): faces up
          idx.push(a, b, c, b, d, c);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = 9;
      m.layers.set(LAYERS.DETAIL);
      m.name = 'river_' + r.name;
      this.rivers.add(m);
    }
  }

  setColors(env) {
    this.oceanU.shallow.value.set(env.ocean.shallow);
    this.oceanU.deep.value.set(env.ocean.deep);
    this.oceanU.foam.value.set(env.ocean.foam);
    this.riverU.shallow.value.set(env.river.shallow);
    this.riverU.deep.value.set(env.river.deep);
  }

  update(camera) {
    // snap to a coarse grid so the wave pattern (world space) doesn't swim
    this.ocean.position.set(Math.round(camera.position.x / 8) * 8, this.terrain.seaLevel, Math.round(camera.position.z / 8) * 8);
    this.ocean.updateMatrixWorld();
    for (const u of [this.oceanU, this.riverU]) {
      u.camPos.value.copy(camera.position);
      u.night.value = this.lighting.night;
    }
  }
}

function toHalf(f32, out = new Uint16Array(f32.length)) {
  for (let i = 0; i < f32.length; i++) out[i] = THREE.DataUtils.toHalfFloat(f32[i]);
  return out;
}
