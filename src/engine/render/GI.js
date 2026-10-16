// Probe global illumination at runtime (data baked by `mc gi bake`, format in GIField.js).
//
//  - The baked terms (sky + one sun bounce per time-of-day key, 8 bits) live in a texture array.
//    relight() mixes them for the current sky / sun colours and sun position into a small 3D
//    texture (RGB L1 SH per probe, half float) with a few fullscreen draws — only when the light
//    changed (~10 x per second while the day advances).
//  - Lit materials replace the hemisphere light by the probe irradiance at the shaded point (one
//    base-height fetch + three trilinear 3D fetches): a lighting node of our own (probeLight) in the
//    materials' lights, so props, terrain, vegetation and characters all get sky occlusion and
//    coloured bounce light. It also adds the sky reflections (Lighting.js), occluded by the probes.
//  - Interior volumes (boxes of finer probes baked inside buildings, GIField.js) sit in a second
//    3D texture relit the same way; a 2 m index texture says which volume covers a pixel (one
//    more fetch everywhere, three more inside a volume).
//  - The CPU keeps the field to meter the light at the camera: auto exposure (brighter in the
//    jungle or a bunker, a bit) and the view model's light.
import * as THREE from 'three/webgpu';
import {
  Fn, If, int, ivec2, vec3, vec4, max, min, abs, clamp, mix, log2, dot, select, texture, texture3D, screenCoordinate, property, luminance,
} from 'three/tsl';
import { GIFieldData, GI_LAYERS, GI_H0, GI_RATIO, GI_VOL_CELL, keyBlend, sliceCount, evalSH, luminance as lumCPU } from './GIField.js';
import { U } from './tsl.js';

const SLICES = 3 * GI_LAYERS; // field 3D texture: channel r, g, b x layers

export const GI_DEFAULTS = {
  gi: { enabled: true, intensity: 1, bias: 0.6, floor: 0.12 },
  autoExposure: { enabled: true, strength: 0.5, reference: 0.85, min: 0.85, max: 2.2, speedUp: 0.8, speedDown: 3 },
};

/** Debug: the irradiance of the last probe lookup (GI debug view, Lighting.js) */
export const giDbg = property('vec3', 'giDbg');

export class GI {
  constructor(renderer) {
    this.renderer = renderer;
    this.data = null;
    this.enabled = true;
    // interior volumes (A/B: F2 > GI, `?givol=0`)
    this.volumesEnabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('givol') !== '0';
    this.cfg = structuredClone(GI_DEFAULTS.gi);
    this.ae = structuredClone(GI_DEFAULTS.autoExposure);
    this.exposure = 1; // auto exposure multiplier
    this.openness = 1; // ambient light at the camera / open air (0..~1.2)
    this.cameraSH = new Float32Array(12);
    this.weights = { sky: [0, 0, 0], sun: [0, 0, 0], kA: 0, kB: 0, f: 0 };
    this._dirty = true;
    this._ref = new Float32Array(12);
    const d3 = new THREE.Data3DTexture(new Uint16Array(4).fill(0), 1, 1, 1);
    d3.type = THREE.HalfFloatType;
    d3.minFilter = d3.magFilter = THREE.LinearFilter;
    d3.needsUpdate = true;
    const d2 = new THREE.DataTexture(new Uint16Array(1), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
    d2.minFilter = d2.magFilter = THREE.LinearFilter;
    d2.needsUpdate = true;
    const dv = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    dv.needsUpdate = true;
    const di = new THREE.DataTexture(new Uint16Array(1), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
    di.needsUpdate = true;
    this.uniforms = {
      giField: texture3D(d3),
      giBase: texture(d2),
      giGrid: U(new THREE.Vector4(0, 0, 1, 0)), // world -> uv: x, z offset, 1 / size; w = on
      giLayer: U(new THREE.Vector4(GI_H0, 1 / Math.log2(GI_RATIO), GI_LAYERS - 1, this.cfg.bias)), // H0, 1 / log2(ratio), layers - 1, normal offset (m)
      giDebug: U(0),
      giFloor: U(this.cfg.floor),
      giVolField: texture3D(d3),
      giVolIndex: texture(di),
      giVols: texture(dv),
      giVolGrid: U(new THREE.Vector4(0, 0, 1, 0)), // world -> index uv: x, z offset, 1 / size; w = on
      giVolAtlas: U(new THREE.Vector3(1, 1, 1)), // 1 / atlas width, 1 / atlas height, atlas layers
    };
    this._dummies = { d3, d2, dv, di };
    // hemisphere light (fallback without probes, and the floor): set by Lighting
    this.hemi = { sky: U(new THREE.Color()), ground: U(new THREE.Color()) };
    this._blend = this._blendMaterial();
  }

  get loaded() { return !!this.data; }
  get active() { return !!this.data && this.enabled && this.cfg.enabled !== false; }

  /** Settings from environment.json ({ gi, autoExposure }). */
  setConfig(env) {
    Object.assign(this.cfg, GI_DEFAULTS.gi, env?.gi);
    Object.assign(this.ae, GI_DEFAULTS.autoExposure, env?.autoExposure);
    this.uniforms.giLayer.value.w = this.cfg.bias;
    this.uniforms.giFloor.value = this.cfg.floor ?? 0;
    this._sync();
  }

  setEnabled(v) { this.enabled = !!v; this._sync(); }

  setVolumesEnabled(v) {
    this.volumesEnabled = !!v;
    if (this.data) this.data.useVolumes = this.volumesEnabled;
    this._sync();
  }

  _sync() {
    this.uniforms.giGrid.value.w = this.active ? 1 : 0;
    this.uniforms.giVolGrid.value.w = this.active && this.vol && this.volumesEnabled ? 1 : 0;
    this._dirty = true;
  }

  /** meta = gi/probes.json, bytes = gi/probes.bin (gzip or raw). */
  async load(meta, bytes) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    const d = new GIFieldData(meta, bytes);
    this.data = d;
    d.useVolumes = this.volumesEnabled;
    const n = d.n;
    const terms = new THREE.DataArrayTexture(d.texels, n, n * GI_LAYERS, sliceCount(d.keys));
    terms.format = THREE.RGBAFormat;
    terms.type = THREE.UnsignedByteType;
    terms.minFilter = terms.magFilter = THREE.NearestFilter;
    terms.generateMipmaps = false;
    terms.needsUpdate = true;
    const base = new THREE.DataTexture(toHalf(d.base), n, n, THREE.RedFormat, THREE.HalfFloatType);
    base.minFilter = base.magFilter = THREE.LinearFilter;
    base.wrapS = base.wrapT = THREE.ClampToEdgeWrapping;
    base.needsUpdate = true;
    const rt = field3D(n, n, SLICES);
    this.dispose();
    this.termsTex = terms;
    this.baseTex = base;
    this.rt = rt;
    const U = this.uniforms;
    U.giField.value = rt.texture;
    U.giBase.value = base;
    U.giGrid.value.set(meta.size / 2, meta.size / 2, 1 / meta.size, 0);
    this.bu.amSky.value = meta.amax[0];
    this._loadVolumes(d);
    this._sync();
    return this;
  }

  /** GPU side of the interior volumes: terms array, relit 3D atlas, index + parameter textures. */
  _loadVolumes(d) {
    const V = d.vols, U = this.uniforms;
    this.vol = null;
    if (!V) {
      U.giVolField.value = this._dummies.d3; U.giVolIndex.value = this._dummies.di; U.giVols.value = this._dummies.dv;
      return;
    }
    const terms = new THREE.DataArrayTexture(V.texels, V.aw, V.ah * V.ad, sliceCount(d.keys));
    terms.format = THREE.RGBAFormat;
    terms.type = THREE.UnsignedByteType;
    terms.minFilter = terms.magFilter = THREE.NearestFilter;
    terms.generateMipmaps = false;
    terms.needsUpdate = true;
    const rt = field3D(V.aw, V.ah, 3 * V.ad);
    const ix = V.index, idx = new Float32Array(ix.idx);
    const index = new THREE.DataTexture(toHalf(idx), ix.n, ix.n, THREE.RedFormat, THREE.HalfFloatType);
    index.minFilter = index.magFilter = THREE.NearestFilter;
    index.wrapS = index.wrapT = THREE.ClampToEdgeWrapping;
    index.needsUpdate = true;
    const p = new Float32Array(V.list.length * 16);
    V.list.forEach((v, i) => {
      p.set([v.c[0], v.c[1], v.c[2], Math.cos(v.yaw), v.size[0] / 2, v.size[1] / 2, v.size[2] / 2, Math.sin(v.yaw), v.at[0], v.at[1], v.blend, v.bias, v.res[0], v.res[1], v.res[2], 0], i * 16);
    });
    const params = new THREE.DataTexture(p, 4, V.list.length, THREE.RGBAFormat, THREE.FloatType);
    params.minFilter = params.magFilter = THREE.NearestFilter;
    params.needsUpdate = true;
    this.vol = { terms, rt, index, params, ah: V.ah, ad: V.ad, amax: V.amax };
    U.giVolField.value = rt.texture;
    U.giVolIndex.value = index;
    U.giVols.value = params;
    const size = ix.n * GI_VOL_CELL;
    U.giVolGrid.value.set(d.meta.size / 2, d.meta.size / 2, 1 / size, 0);
    U.giVolAtlas.value.set(1 / V.aw, 1 / V.ah, V.ad);
  }

  /**
   * Current light (Lighting.setTimeOfDay): sky radiance = hemi colour x intensity / PI (so open
   * ground matches the hemisphere light), sun = shadow light colour x intensity and direction.
   */
  setLight(skyColor, skyIntensity, sunColor, lightDirX) {
    const w = this.weights, k = (this.cfg.intensity ?? 1);
    const s = (skyIntensity / Math.PI) * k;
    w.sky[0] = skyColor.r * s; w.sky[1] = skyColor.g * s; w.sky[2] = skyColor.b * s;
    w.sun[0] = sunColor.r * k; w.sun[1] = sunColor.g * k; w.sun[2] = sunColor.b * k;
    const kb = keyBlend(lightDirX, this.data?.keys ?? 7, this._kb ??= [0, 0, 0]);
    w.kA = kb[0]; w.kB = kb[1]; w.f = kb[2];
    this._dirty = true;
  }

  /** The blend pass: one channel of one layer of the field, from the baked terms. */
  _blendMaterial() {
    const da = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
    da.needsUpdate = true;
    const terms = texture(da);
    const bu = (this.bu = {
      terms, chan: U(0), layer: U(0), n: U(1), kA: U(0), kB: U(0),
      wSky: U(new THREE.Vector3()), wA: U(new THREE.Vector3()), wB: U(new THREE.Vector3()),
      amSky: U(1), amA: U(1), amB: U(1),
    });
    const pick = (v, c) => select(c.lessThan(0.5), v.x, select(c.lessThan(1.5), v.y, select(c.lessThan(2.5), v.z, v.w)));
    const fetch = (q, slice) => terms.load(q).depth(slice);
    const key = (q, k, am) => {
      const a = fetch(q, int(k).mul(2).add(3)), b = fetch(q, int(k).mul(2).add(4));
      const A = pick(a, bu.chan).pow(2.0).mul(am);
      return vec4(A, vec3(a.w, b.x, b.y).mul(4.0).sub(2.0).mul(A));
    };
    const m = new THREE.NodeMaterial();
    m.fragmentNode = Fn(() => {
      const q = ivec2(screenCoordinate.xy).add(ivec2(0, int(bu.layer).mul(int(bu.n)))).toVar();
      const s = fetch(q, int(bu.chan));
      const A = s.x.pow(2.0).mul(bu.amSky);
      return vec4(A, s.yzw.mul(4.0).sub(2.0).mul(A)).mul(pick(bu.wSky, bu.chan))
        .add(key(q, bu.kA, bu.amA).mul(pick(bu.wA, bu.chan)))
        .add(key(q, bu.kB, bu.amB).mul(pick(bu.wB, bu.chan)));
    })();
    m.depthTest = m.depthWrite = false;
    m.toneMapped = false;
    this.quad = new THREE.QuadMesh(m);
    return m;
  }

  /** Re-mix the field for the current light (GPU, only when it changed). Call before rendering. */
  relight() {
    if (!this._dirty || !this.data || !this.active) return;
    this._dirty = false;
    const r = this.renderer, u = this.bu, w = this.weights;
    u.wSky.value.fromArray(w.sky);
    u.wA.value.fromArray(w.sun).multiplyScalar(1 - w.f);
    u.wB.value.fromArray(w.sun).multiplyScalar(w.f);
    u.kA.value = w.kA; u.kB.value = w.kB;
    const prev = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevMip = r.getActiveMipmapLevel();
    const autoClear = r.autoClear;
    r.autoClear = false;
    // the world field, then the interior volume atlas (same terms layout, rows of `n` per layer)
    const fields = [{ terms: this.termsTex, rt: this.rt, n: this.data.n, layers: GI_LAYERS, am: this.data.amax }];
    if (this.vol) fields.push({ terms: this.vol.terms, rt: this.vol.rt, n: this.vol.ah, layers: this.vol.ad, am: this.vol.amax });
    for (const fd of fields) {
      u.terms.value = fd.terms; u.n.value = fd.n;
      u.amSky.value = fd.am[0]; u.amA.value = fd.am[1 + w.kA]; u.amB.value = fd.am[1 + w.kB];
      for (let c = 0; c < 3; c++) {
        for (let l = 0; l < fd.layers; l++) {
          u.chan.value = c; u.layer.value = l;
          r.setRenderTarget(fd.rt, c * fd.layers + l);
          this.quad.render(r);
        }
      }
    }
    r.setRenderTarget(prev, prevFace, prevMip);
    r.autoClear = autoClear;
  }

  /** Meter the light at the camera: auto exposure multiplier + openness. */
  update(dt, pos) {
    let target = 1;
    if (this.active) {
      const d = this.data, w = this.weights;
      d.sample(pos.x, pos.y, pos.z, w, this.cameraSH);
      // openness = sky light reaching the eye from above / the same in open air (open-sea probe):
      // ~ how much sky is visible, independent of how bright the ground around is
      const ws = (this._wSky ??= { sky: null, sun: [0, 0, 0], kA: 0, kB: 0, f: 0 });
      ws.sky = w.sky;
      const sky = d.sample(pos.x, pos.y, pos.z, ws, (this._skySH ??= new Float32Array(12)));
      const ref = d.meta.ref, R = ref ? d.probe(ref.i, ref.j, 0, ws, this._ref) : null;
      const up = (s) => lumCPU(s[0] + s[2], s[4] + s[6], s[8] + s[10]);
      const lc = up(sky), lr = R ? up(R) : lc;
      this.openness = lr > 1e-6 ? Math.min(1.2, lc / lr) : 1;
      // a usual outdoor spot (a few trees around) sees ~`reference` of the sky: no compensation there
      if (this.ae.enabled) target = Math.min(this.ae.max, Math.max(this.ae.min, Math.min(1, Math.max(this.openness, 0.02) / (this.ae.reference || 1)) ** -this.ae.strength));
    } else this.openness = 1;
    // a jump of the camera (teleport, respawn, cut) snaps instead of easing
    const last = (this._lastPos ??= { x: pos.x, y: pos.y, z: pos.z });
    const jump = (pos.x - last.x) ** 2 + (pos.y - last.y) ** 2 + (pos.z - last.z) ** 2 > 30 * 30;
    last.x = pos.x; last.y = pos.y; last.z = pos.z;
    const speed = target > this.exposure ? this.ae.speedUp : this.ae.speedDown;
    const a = dt > 0 && !jump ? 1 - Math.exp(-dt * speed) : 1;
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * a);
  }

  /** Jump the exposure to its target (teleports, cuts). */
  snapExposure(pos) { this.update(0, pos); }

  /** Irradiance at the camera for a world normal -> [r, g, b] (view model light), floor included. */
  cameraIrradiance(nx, ny, nz, out, hemi) {
    evalSH(this.cameraSH, nx, ny, nz, out);
    const f = this.cfg.floor ?? 0;
    if (hemi && f > 0) {
      const t = 0.5 * ny + 0.5, k = hemi.intensity;
      out[0] += f * ((hemi.groundColor.r + (hemi.color.r - hemi.groundColor.r) * t) * k - out[0]);
      out[1] += f * ((hemi.groundColor.g + (hemi.color.g - hemi.groundColor.g) * t) * k - out[1]);
      out[2] += f * ((hemi.groundColor.b + (hemi.color.b - hemi.groundColor.b) * t) * k - out[2]);
    }
    return out;
  }

  // --- shader side ------------------------------------------------------------------------------

  /** fn(P world, N world) -> irradiance of the world field (vec3). */
  irradianceFn() {
    const u = this.uniforms;
    return Fn(([P0, N]) => {
      const P = P0.add(N.mul(u.giLayer.w));
      const uv = P.xz.add(u.giGrid.xy).mul(u.giGrid.z);
      const base = u.giBase.sample(uv).r;
      const lc = clamp(log2(max(P.y.sub(base), u.giLayer.x).div(u.giLayer.x)).mul(u.giLayer.y), 0.0, u.giLayer.z);
      const w = lc.add(0.5).div(SLICES);
      const r = u.giField.sample(vec3(uv, w));
      const g = u.giField.sample(vec3(uv, w.add(GI_LAYERS / SLICES)));
      const b = u.giField.sample(vec3(uv, w.add((2 * GI_LAYERS) / SLICES)));
      const k = vec4(1.0, N);
      return max(vec3(dot(r, k), dot(g, k), dot(b, k)), vec3(0.0));
    });
  }

  /** fn(P, N, world irradiance) -> the interior volume covering P (if any), faded into the world
   *  field at the box faces. */
  volumeFn() {
    const u = this.uniforms;
    return Fn(([P, N, world]) => {
      const e = world.toVar();
      If(u.giVolGrid.w.greaterThan(0.5), () => {
        const id = u.giVolIndex.sample(P.xz.add(u.giVolGrid.xy).mul(u.giVolGrid.z)).r;
        If(id.greaterThan(0.5), () => {
          const v = int(id.add(0.5)).sub(1);
          const a = u.giVols.load(ivec2(0, v)), b = u.giVols.load(ivec2(1, v)); // centre, cos yaw / half size, sin yaw
          const c = u.giVols.load(ivec2(2, v)), res = u.giVols.load(ivec2(3, v)).xyz; // atlas column, row, blend, normal offset
          const p = P.add(N.mul(c.w)).sub(a.xyz);
          const q = vec3(a.w.mul(p.x).sub(b.w.mul(p.z)), p.y, b.w.mul(p.x).add(a.w.mul(p.z)));
          const ed = b.xyz.sub(abs(q));
          const m = min(ed.x, min(ed.y, ed.z));
          If(m.greaterThan(0.0), () => {
            const f = clamp(q.add(b.xyz).div(b.xyz.mul(2.0)).mul(res).sub(0.5), vec3(0.0), res.sub(1.0));
            const uv = c.xy.add(f.xz).add(0.5).mul(u.giVolAtlas.xy);
            const w = f.y.add(0.5).div(u.giVolAtlas.z.mul(3.0));
            const r = u.giVolField.sample(vec3(uv, w));
            const g = u.giVolField.sample(vec3(uv, w.add(1.0 / 3.0)));
            const bl = u.giVolField.sample(vec3(uv, w.add(2.0 / 3.0)));
            const k = vec4(1.0, N);
            const ev = max(vec3(dot(r, k), dot(g, k), dot(bl, k)), vec3(0.0));
            e.assign(mix(world, ev, clamp(m.div(max(c.z, 1e-3)), 0.0, 1.0)));
          });
        });
      });
      return e;
    });
  }

  /** fn(P, N world) -> vec4(irradiance, sky visibility giOcc): the probes in place of the
   *  hemisphere light, a share of it kept as a floor (artistic: nothing goes pitch black). */
  ambientFn() {
    const u = this.uniforms, irr = this.irradianceFn(), vol = this.volumeFn(), hemi = this.hemi;
    return Fn(([P, N]) => {
      const h = mix(hemi.ground, hemi.sky, N.y.mul(0.5).add(0.5)).toVar();
      const e = h.toVar();
      If(u.giGrid.w.greaterThan(0.5), () => { e.assign(mix(vol(P, N, irr(P, N)), h, u.giFloor)); });
      const occ = clamp(luminance(e).div(max(luminance(h), 1e-4)), 0.0, 1.0);
      giDbg.assign(e);
      return vec4(e, occ);
    });
  }

  dispose() {
    this.termsTex?.dispose();
    this.baseTex?.dispose();
    this.rt?.dispose();
    if (this.vol) for (const k of ['terms', 'rt', 'index', 'params']) this.vol[k].dispose();
    this.vol = null;
  }
}

function field3D(w, h, d) {
  const rt = new THREE.RenderTarget3D(w, h, d, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.ClampToEdgeWrapping;
  return rt;
}

function toHalf(f32) {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = THREE.DataUtils.toHalfFloat(f32[i]);
  return out;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const zlib = await import(/* @vite-ignore */ 'node:zlib');
  return new Uint8Array(zlib.gunzipSync(bytes));
}

