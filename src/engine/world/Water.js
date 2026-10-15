// Ocean + rivers. No depth pre-pass: the water depth comes from the terrain heightmap, uploaded
// once as a float texture, so the shader knows how deep the water is under every pixel (shore
// foam, turquoise shallows -> deep blue, see-through lagoon) at the cost of one texture fetch.
//
// Ocean: a polar grid that follows the camera (dense near, sparse to the horizon), a smooth swell
// of directional waves (height + analytic normal) in the vertex shader, small ripples from two
// scrolling samples of a normal map (Surfaces.waterNormal) in the fragment shader. Shading:
// Fresnel between the body colour (absorbed with depth, lit by the sun / sky) and the reflected
// sky (gradient + the cloud layer), a sharp sun glint, light scattered through the wave crests.
// Rivers: ribbon meshes along the river polylines, ripples scrolling with the flow.
// Optional screen-space reflections of the shore, trees, boats... in place of the sky
// reflection where a ray finds them on screen (render/SSR.js).
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, texture, attribute, varying, varyingProperty, property, vec2, vec3, vec4, float, normalize, dot, max, mix, pow, exp, sin, cos, abs, clamp, smoothstep, step, select,
  floor, fract, distance, reflect, positionLocal, modelWorldMatrix, cameraViewMatrix, cameraPosition, screenCoordinate, renderGroup,
} from 'three/tsl';
import { LAYERS } from '../render/layers.js';
import { skyClouds } from '../render/clouds.js';
import { SSR } from '../render/SSR.js';
import { toDisplay } from '../render/Output.js';

// directional swell: dir xy, spatial frequency, amplitude
const WAVES = [[0.80, 0.60, 0.11, 0.50], [-0.35, 0.94, 0.13, 0.38], [0.97, -0.24, 0.23, 0.22], [0.42, 0.91, 0.37, 0.12]];

/** x height, yz gradient (d/dx, d/dz) of the swell at world xz, time t (written out, no loop). */
function wave(p, t) {
  let r = vec3(0);
  for (const [dx, dz, k, a] of WAVES) {
    const ph = dot(vec2(dx, dz), p).mul(k).add(t.mul(Math.sqrt(9.8 * k) * 0.55));
    r = r.add(vec3(sin(ph).mul(a), vec2(dx, dz).mul(cos(ph).mul(a * k))));
  }
  return r;
}

const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const noise = Fn(([p]) => {
  const i = floor(p), f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2).add(3));
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), f.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x), f.y);
}).setLayout({ name: 'waterNoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

// fragment values the output stage reads (SSR blend after the tone mapping)
const wF = property('float', 'wF'), wFoam = property('float', 'wFoam'), wFogF = property('float', 'wFogF'), wNs = property('vec3', 'wNs'), wV = property('vec3', 'wV');

/** Water material (ocean or rivers) for one uniform set (Water._uniforms). */
function waterMaterial(u, lighting) {
  const m = new THREE.NodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.name = u.isRiver.value ? 'river' : 'ocean';
  const ssr = lighting.ssr, S = ssr.uniforms;
  const vWaveN = varyingProperty('vec3', 'vWaveN'), vCrest = varyingProperty('float', 'vCrest');
  // vertex: the swell (world space, faded out far from the camera)
  m.positionNode = Fn(() => {
    const w = modelWorldMatrix.mul(vec4(positionLocal, 1));
    const fade = float(1).sub(smoothstep(120, 400, distance(w.xz, u.camPos.xz)));
    const h = wave(w.xz, u.uTime).mul(u.waveAmp).mul(fade).toVar();
    vWaveN.assign(normalize(vec3(h.y.negate(), 1, h.z.negate())));
    vCrest.assign(h.x.div(max(u.waveAmp, 1e-3)));
    return positionLocal.add(vec3(0, h.x, 0));
  })();
  const vWorld = varying(modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz, 'vWorld');
  const vFogDepth = varying(cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(positionLocal, 1))).z.negate(), 'vFogDepth');
  const vFlow = varying(attribute('flow', 'vec2'), 'vFlow');
  const clouds = skyClouds(lighting.skyU);
  const ripple = (uv) => { const t = u.waterNormal.sample(uv).xyz.mul(2).sub(1); return vec3(t.x, 0, t.y); };
  const skyAt = (d0) => {
    const d = vec3(d0.x, abs(d0.y), d0.z);
    const c = mix(u.horizonCol, u.skyCol, pow(d.y, 0.5));
    const cl = clouds(d);
    const lit = mix(u.horizonCol.mul(1.1), vec3(1), u.night.oneMinus().mul(0.6)).add(u.sunColor.mul(0.05));
    return mix(c, lit.mul(u.night.oneMinus().mul(0.8).add(0.2)), cl.x.mul(0.85));
  };
  m.colorNode = Fn(() => {
    const river = u.isRiver.greaterThan(0.5);
    const uv = vWorld.xz.sub(u.terrainRect.xy).div(u.terrainRect.z);
    const ground = u.heightTex.sample(uv).r;
    const depth = vWorld.y.sub(ground).toVar();
    If(uv.x.lessThan(0).or(uv.y.lessThan(0)).or(uv.x.greaterThan(1)).or(uv.y.greaterThan(1)), () => { depth.assign(60); });
    const V = normalize(cameraPosition.sub(vWorld)).toVar();
    wV.assign(V);
    const dist = vFogDepth;
    // ripples: two scrolling scales of the normal map (along the flow on rivers), fading with distance
    const t = u.uTime;
    const drift = select(river, vFlow.mul(t).mul(u.flowSpeed).mul(0.35), vec2(t.mul(0.011), t.mul(0.007)));
    const rp = ripple(vWorld.xz.mul(0.055).mul(u.rippleScale).add(drift)).add(ripple(vWorld.xz.mul(0.13).mul(u.rippleScale).sub(drift.yx.mul(1.3)).add(vec2(0.37, 0.71)))).toVar();
    const rk = select(river, float(0.22), float(0.3)).mul(float(1).sub(smoothstep(40, 600, dist).mul(0.8))).toVar();
    const n = normalize(vWaveN.add(rp.mul(rk))).toVar();
    const NdV = max(dot(n, V), 0);
    const F = float(0.02).add(pow(NdV.oneMinus(), 5).mul(0.98)).toVar();
    wF.assign(F);
    // body: absorbed toward the deep colour with depth, lit by the sun and the sky
    const dk = float(1).sub(exp(max(depth, 0).negate().mul(select(river, float(0.45), float(0.16))))).toVar();
    const body = mix(u.shallow, u.deep, dk).toVar();
    const sunUp = clamp(u.sunDirW.y.mul(2), 0, 1);
    const lightC = u.sunColor.mul(sunUp.mul(0.16).add(0.12)).add(u.skyCol.mul(0.35)).add(u.horizonCol.mul(0.15)).toVar();
    body.mulAssign(lightC.mul(mix(1, 0.25, u.night)));
    // light through the wave crests (turquoise glow facing the sun)
    const sss = pow(max(dot(V, u.sunDirW.negate()), 0), 3).mul(clamp(vCrest.mul(0.5).add(0.5), 0, 1));
    body.addAssign(u.shallow.mul(u.sunColor).mul(sss).mul(0.25).mul(dk.mul(-0.5).add(1)));
    // reflection: sky + clouds, the sun's glint
    const R = reflect(V.negate(), n);
    const col = mix(body, skyAt(R), F).toVar();
    const H = normalize(u.sunDirW.add(V));
    const NdH = max(dot(n, H), 0);
    col.addAssign(u.sunColor.mul(pow(NdH, 900).mul(6).add(pow(NdH, 120).mul(0.25))).mul(step(0, u.sunDirW.y)));
    // shore foam: animated bands where it gets shallow, broken by noise
    const fuv = vWorld.xz.mul(0.35).add(vFlow.mul(u.uTime).mul(u.flowSpeed)).toVar();
    const fn = noise(fuv).mul(0.6).add(noise(fuv.mul(2.3)).mul(0.3)).add(noise(fuv.mul(5.1)).mul(0.1));
    const band = smoothstep(0.85, 0, depth).add(select(river, float(0), smoothstep(1.6, 0.4, depth).mul(sin(depth.mul(6).sub(u.uTime.mul(1.6))).mul(0.5).add(0.5)).mul(0.6))).toVar();
    const f = smoothstep(0.5, 0.8, fn.mul(band).add(band.mul(0.2))).toVar();
    If(river, () => { f.assign(max(f, smoothstep(0.74, 0.92, noise(fuv.mul(1.7))).mul(0.3))); });
    wFoam.assign(f);
    col.assign(mix(col, u.foam.mul(lightC).mul(0.75), f.mul(0.8)));
    // see-through in the shallows, opaque at grazing angles (Fresnel) and in the deep
    const alpha = mix(0.45, u.opacity, smoothstep(0, 3, depth)).toVar();
    alpha.assign(max(max(alpha, f.mul(0.9)), F));
    alpha.mulAssign(smoothstep(-0.05, 0.12, depth));
    // fog (exp2, before the tone mapping like the WebGL version)
    const fogF = float(1).sub(exp(u.fogDensity.mul(u.fogDensity).mul(vFogDepth).mul(vFogDepth).negate()));
    wFogF.assign(fogF);
    col.assign(mix(col, u.fogColor, fogF));
    // calmer normal for the reflection rays than the shading one: at grazing angles the full
    // ripples would send most rays to the sky or under the surface
    wNs.assign(normalize(vWaveN.add(rp.mul(rk).mul(0.25))));
    return vec4(col, alpha);
  })();
  // output: tone mapped like everything else, then the screen-space reflection (the previous
  // frame is display values already) replaces the reflected share, in display space
  const trace = ssr.traceNode();
  m.mcOutput = (node) => Fn(() => {
    const o = vec4(node).toVar();
    const out = vec4(toDisplay(o.rgb), o.a).toVar();
    If(S.ssrOn.greaterThan(0.5).and(wF.greaterThan(0.025)), () => {
      const Pv = cameraViewMatrix.mul(vec4(vWorld, 1)).xyz;
      // never below the horizon (nothing to hit there)
      const Rw = reflect(wV.negate(), wNs).toVar();
      Rw.y.assign(max(Rw.y, 0.005));
      const Rv = normalize(cameraViewMatrix.mul(vec4(Rw, 0)).xyz);
      const s = trace(Pv, Rv, SSR.ign(screenCoordinate)).toVar();
      // the reflected share is not see-through: out = (1 - w) * (water over the bed) + w * reflection
      const w = clamp(s.a.mul(wF).mul(S.ssrIntensity).mul(wFoam.mul(-0.8).add(1)).mul(wFogF.oneMinus()), 0, 1);
      const a2 = float(1).sub(w.oneMinus().mul(out.a.oneMinus()));
      out.assign(vec4(w.oneMinus().mul(out.a).mul(out.rgb).add(s.rgb.mul(w)).div(max(a2, 1e-4)), a2));
      If(S.ssrDebug.greaterThan(0.5), () => { out.assign(vec4(s.rgb.mul(s.a), 1)); });
    });
    return out;
  })();
  return m;
}

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
    this.ocean = new THREE.Mesh(this._polarGrid(), this._material(this.oceanU));
    this.ocean.frustumCulled = false;
    this.ocean.renderOrder = 10;
    this.ocean.layers.set(LAYERS.DETAIL);
    this.group.add(this.ocean);
    this.rivers = new THREE.Group();
    this.group.add(this.rivers);
    this.buildRivers();
    scene.add(this.group);
  }

  _uniforms(c, river) {
    const L = this.lighting, S = L.sun.uniforms, K = L.skyU;
    const t = this.terrain, g = (v) => uniform(v);
    return {
      uTime: L.uniforms.uTime,
      waveAmp: g(river ? 0.04 : 0.45),
      flowSpeed: g(river ? 1.4 : 0.15),
      isRiver: g(river ? 1 : 0),
      opacity: g(river ? 0.92 : 0.9),
      shallow: g(new THREE.Color(c.shallow)),
      deep: g(new THREE.Color(c.deep)),
      foam: g(new THREE.Color(this.lighting.env.ocean.foam)),
      sunDirW: S.sunDirW,
      sunColor: g(L.sunColor).setGroup(renderGroup),
      skyCol: K.zenith,
      horizonCol: K.horizon,
      fogColor: g(L.fog.color).setGroup(renderGroup), // linear (the water mixes its fog before the tone mapping)
      fogDensity: g(0),
      night: g(0),
      camPos: g(new THREE.Vector3()),
      heightTex: texture(this.heightTex),
      terrainRect: g(new THREE.Vector4(-t.half, -t.half, t.size, 0)),
      waterNormal: L.surfaces.uniforms.waterNormal,
      rippleScale: g(river ? 1.6 : 1),
    };
  }

  _material(u) {
    return waterMaterial(u, this.lighting);
  }

  /** Terrain heights for the water depth (float32 where the GPU filters it, else half float). */
  _heightTexture() {
    const t = this.terrain;
    const f32 = this.lighting.renderer.hasFeature?.('float32-filterable') !== false && this.lighting.renderer.backend?.isWebGPUBackend;
    const tex = f32
      ? new THREE.DataTexture(t.heights, t.res, t.res, THREE.RedFormat, THREE.FloatType)
      : new THREE.DataTexture(new Uint16Array(t.res * t.res), t.res, t.res, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    this._halfHeights = !f32;
    this._fillHeights(tex);
    return tex;
  }

  _fillHeights(tex) {
    if (this._halfHeights) {
      const h = this.terrain.heights, d = tex.image.data;
      for (let i = 0; i < h.length; i++) d[i] = THREE.DataUtils.toHalfFloat(h[i]);
    }
    tex.needsUpdate = true;
  }

  /** Call after sculpting so depth shading follows the new ground. */
  refreshHeights() {
    this._fillHeights(this.heightTex);
  }

  /** Rings of quads around the origin, ring radius growing geometrically (follows the camera). */
  _polarGrid() {
    const seg = 96, rings = [];
    let r = 0, step = 2.5;
    while (r < 6000) { rings.push(r); r += step; step *= 1.07; }
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
    const mat = this._material(this.riverU);
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
    const fog = this.lighting.fog;
    for (const u of [this.oceanU, this.riverU]) {
      u.camPos.value.copy(camera.position);
      u.fogDensity.value = fog ? fog.density : 0;
      u.night.value = this.lighting.night;
    }
  }
}
