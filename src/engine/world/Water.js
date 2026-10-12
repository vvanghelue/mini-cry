// Ocean + rivers. No depth pre-pass: the water depth comes from the terrain heightmap, uploaded
// once as a float texture, so the shader knows how deep the water is under every pixel (shore
// foam, turquoise shallows -> deep blue, see-through lagoon) at the cost of one texture fetch.
//
// Ocean: a polar grid that follows the camera (dense near, sparse to the horizon), faceted
// low-poly waves in the vertex shader. Rivers: ribbon meshes along the river polylines.
import * as THREE from 'three';
import { LAYERS } from '../render/layers.js';

const WATER_VERT = /* glsl */ `
  uniform float uTime, waveAmp, flowSpeed;
  uniform vec3 camPos;
  attribute vec2 flow;
  varying vec3 vWorld;
  varying vec2 vFlow;
  varying float vFogDepth;
  #include <logdepthbuf_pars_vertex>
  float wave(vec2 p, float t) {
    return sin(p.x * 0.11 + t * 1.1) * 0.5 + sin(p.y * 0.13 + t * 0.9) * 0.4 + sin((p.x + p.y) * 0.23 + t * 1.7) * 0.25;
  }
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    float fade = 1.0 - smoothstep(120.0, 400.0, distance(w.xz, camPos.xz));
    w.y += wave(w.xz, uTime) * waveAmp * fade;
    vWorld = w.xyz;
    vFlow = flow;
    vec4 mv = viewMatrix * w;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const WATER_FRAG = /* glsl */ `
  uniform float uTime, opacity, isRiver, flowSpeed, night;
  uniform vec3 shallow, deep, foam, sunDirW, sunColor, skyCol, horizonCol, fogColor;
  uniform float fogDensity;
  uniform sampler2D heightTex;
  uniform vec4 terrainRect; // x0, z0, size, unused
  varying vec3 vWorld;
  varying vec2 vFlow;
  varying float vFogDepth;
  #include <logdepthbuf_pars_fragment>
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec2 uv = (vWorld.xz - terrainRect.xy) / terrainRect.z;
    float ground = texture2D(heightTex, uv).r;
    float depth = vWorld.y - ground;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) depth = 60.0;
    // faceted normal from derivatives (low-poly waves)
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;
    vec3 V = normalize(cameraPosition - vWorld);
    float dk = 1.0 - exp(-max(depth, 0.0) * (isRiver > 0.5 ? 0.45 : 0.16));
    vec3 col = mix(shallow, deep, dk) * mix(1.0, 0.28, night);
    // diffuse-ish lighting so the water darkens at night
    float light = 0.35 + 0.65 * max(dot(n, sunDirW), 0.0);
    col *= mix(vec3(0.25), vec3(1.0), clamp(length(sunColor) * 0.35, 0.0, 1.0)) * light + skyCol * 0.08;
    // fresnel toward the sky colour
    float fr = pow(1.0 - max(dot(n, V), 0.0), 4.0);
    col = mix(col, skyCol, fr * 0.55);
    // sun glint
    vec3 H = normalize(sunDirW + V);
    col += sunColor * pow(max(dot(n, H), 0.0), 180.0) * 0.6;
    // shore foam: animated bands where it gets shallow
    vec2 fuv = vWorld.xz * 0.35 + vFlow * uTime * flowSpeed;
    float fn = noise(fuv) * 0.6 + noise(fuv * 2.3) * 0.4;
    float band = smoothstep(0.85, 0.0, depth) + (isRiver > 0.5 ? 0.0 : smoothstep(1.6, 0.4, depth) * (0.5 + 0.5 * sin(depth * 6.0 - uTime * 1.6)) * 0.6);
    float f = smoothstep(0.45, 0.75, fn * band + band * 0.25);
    if (isRiver > 0.5) f = max(f, smoothstep(0.72, 0.9, noise(fuv * 1.7)) * 0.35);
    col = mix(col, foam * (0.5 + 0.5 * light), f * 0.85);
    float alpha = mix(0.55, opacity, smoothstep(0.0, 3.0, depth));
    alpha = max(alpha, f * 0.9);
    alpha *= smoothstep(-0.05, 0.12, depth);
    // fog (exp2, same as three)
    float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    col = mix(col, fogColor, fogF);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

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
    const L = this.lighting;
    const t = this.terrain;
    return {
      uTime: L.uniforms.uTime,
      waveAmp: { value: river ? 0.05 : 0.35 },
      flowSpeed: { value: river ? 1.4 : 0.15 },
      isRiver: { value: river ? 1 : 0 },
      opacity: { value: river ? 0.92 : 0.9 },
      shallow: { value: new THREE.Color(c.shallow) },
      deep: { value: new THREE.Color(c.deep) },
      foam: { value: new THREE.Color(this.lighting.env.ocean.foam) },
      sunDirW: { value: L.sunDir },
      sunColor: { value: L.sunColor },
      skyCol: { value: L.skyU.zenith.value },
      horizonCol: { value: L.skyU.horizon.value },
      fogColor: { value: L.scene.fog.color },
      fogDensity: { value: 0 },
      night: { value: 0 },
      camPos: { value: new THREE.Vector3() },
      heightTex: { value: this.heightTex },
      terrainRect: { value: new THREE.Vector4(-t.half, -t.half, t.size, 0) },
    };
  }

  _material(u) {
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: false, extensions: {} });
  }

  _heightTexture() {
    const t = this.terrain;
    const tex = new THREE.DataTexture(t.heights, t.res, t.res, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  /** Call after sculpting so depth shading follows the new ground. */
  refreshHeights() {
    this.heightTex.needsUpdate = true;
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
    const fog = this.scene.fog;
    for (const u of [this.oceanU, this.riverU]) {
      u.camPos.value.copy(camera.position);
      u.fogDensity.value = fog ? fog.density : 0;
      u.night.value = this.lighting.night;
    }
  }
}
