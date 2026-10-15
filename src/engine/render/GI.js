// Probe global illumination at runtime (data baked by `mc gi bake`, format in GIField.js).
//
//  - The baked terms (sky + one sun bounce per time-of-day key, 8 bits) live in a texture array.
//    relight() mixes them for the current sky / sun colours and sun position into a small 3D
//    texture (RGB L1 SH per probe, half float) with a few fullscreen draws — only when the light
//    changed (~10 x per second while the day advances).
//  - Lit materials take the probe irradiance at the shaded point in place of the hemisphere light
//    (irradianceNode(): one base-height fetch + three trilinear 3D fetches), so props, terrain,
//    vegetation and characters all get sky occlusion and coloured bounce light.
//  - Interior volumes (boxes of finer probes baked inside buildings, GIField.js) sit in a second
//    3D texture relit the same way; a 2 m index texture says which volume covers a pixel (one
//    more fetch everywhere, three more inside a volume).
//  - The CPU keeps the field to meter the light at the camera: auto exposure (brighter in the
//    jungle or a bunker, a bit) and the view model's light.
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, texture, texture3D, vec2, vec3, vec4, float, int, ivec2, ivec3, clamp, max, min, log2, dot, abs, mix, screenCoordinate, renderGroup, luminance,
} from 'three/tsl';
import { GIFieldData, GI_LAYERS, GI_H0, GI_RATIO, GI_VOL_CELL, keyBlend, sliceCount, evalSH, luminance as lum } from './GIField.js';

const SLICES = 3 * GI_LAYERS; // field 3D texture: channel r, g, b x layers

export const GI_DEFAULTS = {
  gi: { enabled: true, intensity: 1, bias: 0.6, floor: 0.12 },
  autoExposure: { enabled: true, strength: 0.5, reference: 0.85, min: 0.85, max: 2.2, speedUp: 0.8, speedDown: 3 },
};

function dummy3D() {
  const t = new THREE.Data3DTexture(new Uint16Array(4), 1, 1, 1);
  t.type = THREE.HalfFloatType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
function dummy2D(format, filter, type = THREE.HalfFloatType) {
  const n = format === THREE.RedFormat ? 1 : 4;
  const t = new THREE.DataTexture(type === THREE.FloatType ? new Float32Array(n) : new Uint16Array(n), 1, 1, format, type);
  t.minFilter = t.magFilter = filter;
  t.needsUpdate = true;
  return t;
}

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
    const g = (n) => n.setGroup(renderGroup);
    this._dummies = { d3: dummy3D(), d2: dummy2D(THREE.RedFormat, THREE.LinearFilter), dv: dummy2D(THREE.RGBAFormat, THREE.NearestFilter, THREE.FloatType), di: dummy2D(THREE.RedFormat, THREE.NearestFilter) };
    this.uniforms = {
      giField: texture3D(this._dummies.d3),
      giBase: texture(this._dummies.d2),
      giGrid: g(uniform(new THREE.Vector4(0, 0, 1, 0))), // world -> uv: x, z offset, 1 / size; w = on
      giLayer: g(uniform(new THREE.Vector4(GI_H0, 1 / Math.log2(GI_RATIO), GI_LAYERS - 1, this.cfg.bias))), // H0, 1 / log2(ratio), layers - 1, normal offset (m)
      giDebug: g(uniform(0)),
      giFloor: g(uniform(this.cfg.floor)),
      giVolField: texture3D(this._dummies.d3),
      giVolIndex: texture(this._dummies.di),
      giVols: texture(this._dummies.dv),
      giVolGrid: g(uniform(new THREE.Vector4(0, 0, 1, 0))), // world -> index uv: x, z offset, 1 / size; w = on
      giVolAtlas: g(uniform(new THREE.Vector3(1, 1, 1))), // 1 / atlas width, 1 / atlas height, atlas layers
      // hemisphere light (the fallback without GI, and the GI floor): sky / ground colour x intensity
      hemiSky: g(uniform(new THREE.Color(1, 1, 1))),
      hemiGround: g(uniform(new THREE.Color(0.3, 0.3, 0.3))),
    };
    // relight pass inputs
    this.blend = {
      terms: texture(new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2)),
      chan: uniform(new THREE.Vector4(1, 0, 0, 0)), // one-hot colour channel
      layer: uniform(0, 'int'), n: uniform(1, 'int'), kA: uniform(0, 'int'), kB: uniform(0, 'int'),
      wSky: uniform(new THREE.Vector3()), wA: uniform(new THREE.Vector3()), wB: uniform(new THREE.Vector3()),
      amSky: uniform(1), amA: uniform(1), amB: uniform(1),
    };
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
    const terms = termsTexture(d.texels, n, n * GI_LAYERS, sliceCount(d.keys));
    const base = new THREE.DataTexture(toHalf(d.base), n, n, THREE.RedFormat, THREE.HalfFloatType);
    base.minFilter = base.magFilter = THREE.LinearFilter;
    base.wrapS = base.wrapT = THREE.ClampToEdgeWrapping;
    base.needsUpdate = true;
    const rt = fieldTarget(n, n, SLICES);
    this.dispose();
    this.termsTex = terms;
    this.baseTex = base;
    this.rt = rt;
    const U = this.uniforms;
    U.giField.value = rt.texture;
    U.giBase.value = base;
    U.giGrid.value.set(meta.size / 2, meta.size / 2, 1 / meta.size, 0);
    this.blend.terms.value = terms;
    this._loadVolumes(d);
    this.quad ??= new THREE.QuadMesh(this._blendMaterial());
    this._sync();
    return this;
  }

  /** Relight pass: one channel of one layer of a field (rows of `n` per layer in the terms array). */
  _blendMaterial() {
    const B = this.blend;
    const m = new THREE.NodeMaterial();
    // fragmentNode, not colorNode: signed SH coefficients written as they are (the colour path
    // clamps the output to >= 0 and forces alpha to 1 on opaque materials)
    m.fragmentNode = Fn(() => {
      const q = ivec2(screenCoordinate).add(ivec2(0, B.layer.mul(B.n))).toVar();
      const chan = B.chan;
      const fetch = (slice) => B.terms.load(q).depth(slice);
      const key = (k, am) => {
        const a = fetch(int(3).add(k.mul(2))), b = fetch(int(4).add(k.mul(2)));
        const ac = dot(a, chan);
        const A = ac.mul(ac).mul(am);
        return vec4(A, vec3(a.w, b.x, b.y).mul(4).sub(2).mul(A));
      };
      // sky term: slice = channel; A in x, B / A in yzw
      const sky = this._skySlice(fetch, chan);
      const A = sky.x.mul(sky.x).mul(B.amSky);
      const out = vec4(A, sky.yzw.mul(4).sub(2).mul(A)).mul(dot(vec4(B.wSky, 0), chan))
        .add(key(B.kA, B.amA).mul(dot(vec4(B.wA, 0), chan)))
        .add(key(B.kB, B.amB).mul(dot(vec4(B.wB, 0), chan)));
      return out;
    })();
    m.depthTest = m.depthWrite = false;
    m.blending = THREE.NoBlending;
    m.name = 'giRelight';
    return m;
  }

  /** The sky slice of the current channel (slices 0-2 = sky r / g / b). */
  _skySlice(fetch, chan) {
    return fetch(int(0)).mul(chan.x).add(fetch(int(1)).mul(chan.y)).add(fetch(int(2)).mul(chan.z));
  }

  /** GPU side of the interior volumes: terms array, relit 3D atlas, index + parameter textures. */
  _loadVolumes(d) {
    const V = d.vols, U = this.uniforms;
    this.vol = null;
    if (!V) {
      U.giVolField.value = this._dummies.d3; U.giVolIndex.value = this._dummies.di; U.giVols.value = this._dummies.dv;
      return;
    }
    const terms = termsTexture(V.texels, V.aw, V.ah * V.ad, sliceCount(d.keys));
    const rt = fieldTarget(V.aw, V.ah, 3 * V.ad);
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

  /** Hemisphere light the probes replace (and the GI floor mixes back in). */
  setHemisphere(hemi) {
    this.uniforms.hemiSky.value.copy(hemi.color).multiplyScalar(hemi.intensity);
    this.uniforms.hemiGround.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity);
  }

  /** Re-mix the field for the current light (GPU, only when it changed). Call before rendering. */
  relight() {
    if (!this._dirty || !this.data || !this.active) return;
    this._dirty = false;
    const r = this.renderer, B = this.blend, w = this.weights;
    B.wSky.value.fromArray(w.sky);
    B.wA.value.fromArray(w.sun).multiplyScalar(1 - w.f);
    B.wB.value.fromArray(w.sun).multiplyScalar(w.f);
    B.kA.value = w.kA; B.kB.value = w.kB;
    const prev = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevMip = r.getActiveMipmapLevel();
    // the world field, then the interior volume atlas (same terms layout, rows of `n` per layer)
    const fields = [{ terms: this.termsTex, rt: this.rt, n: this.data.n, layers: GI_LAYERS, am: this.data.amax }];
    if (this.vol) fields.push({ terms: this.vol.terms, rt: this.vol.rt, n: this.vol.ah, layers: this.vol.ad, am: this.vol.amax });
    for (const fd of fields) {
      B.terms.value = fd.terms; B.n.value = fd.n;
      B.amSky.value = fd.am[0]; B.amA.value = fd.am[1 + w.kA]; B.amB.value = fd.am[1 + w.kB];
      for (let c = 0; c < 3; c++) {
        B.chan.value.set(c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0, 0);
        for (let l = 0; l < fd.layers; l++) {
          B.layer.value = l;
          r.setRenderTarget(fd.rt, c * fd.layers + l);
          this.quad.render(r);
        }
      }
    }
    r.setRenderTarget(prev, prevFace, prevMip);
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
      const up = (s) => lum(s[0] + s[2], s[4] + s[6], s[8] + s[10]);
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

  // ---- shader side -------------------------------------------------------------------------

  /**
   * Diffuse irradiance at world point P, world normal N: the probe field (+ the interior volume
   * covering P), floored with a share of the hemisphere light; the hemisphere light alone without
   * GI. Returns an Fn (P, N) -> vec4(irradiance, occ): occ = probe light / open-sky light (sky
   * reflections are scaled by it, so nothing glows under a roof or in the jungle).
   */
  irradianceNode() {
    if (this._irr) return this._irr;
    const U = this.uniforms;
    const SL = float(SLICES), GL = float(GI_LAYERS);
    const field = Fn(([P, N]) => {
      const p = P.add(N.mul(U.giLayer.w));
      const uv = p.xz.add(U.giGrid.xy).mul(U.giGrid.z);
      const base = U.giBase.sample(uv).r;
      const lc = clamp(log2(max(p.y.sub(base), U.giLayer.x).div(U.giLayer.x)).mul(U.giLayer.y), 0, U.giLayer.z);
      const w = lc.add(0.5).div(SL);
      const r = U.giField.sample(vec3(uv, w));
      const g = U.giField.sample(vec3(uv, w.add(GL.div(SL))));
      const b = U.giField.sample(vec3(uv, w.add(GL.mul(2).div(SL))));
      const k = vec4(1, N);
      return max(vec3(dot(r, k), dot(g, k), dot(b, k)), vec3(0));
    });
    // interior volume covering P (if any): its probes, faded into the world field at the box faces
    const volume = Fn(([P, N, world]) => {
      const out = vec3(world).toVar();
      If(U.giVolGrid.w.greaterThan(0.5), () => {
        const id = U.giVolIndex.sample(P.xz.add(U.giVolGrid.xy).mul(U.giVolGrid.z)).r;
        If(id.greaterThan(0.5), () => {
          const v = int(id.add(0.5)).sub(1);
          const a = U.giVols.load(ivec2(0, v)); // centre, cos yaw
          const b = U.giVols.load(ivec2(1, v)); // half size, sin yaw
          const c = U.giVols.load(ivec2(2, v)); // atlas column, row, blend, normal offset
          const res = U.giVols.load(ivec2(3, v)).xyz;
          const p = P.add(N.mul(c.w)).sub(a.xyz);
          const q = vec3(a.w.mul(p.x).sub(b.w.mul(p.z)), p.y, b.w.mul(p.x).add(a.w.mul(p.z)));
          const e = b.xyz.sub(abs(q));
          const m = min(e.x, min(e.y, e.z));
          If(m.greaterThan(0), () => {
            const f = clamp(q.add(b.xyz).div(b.xyz.mul(2)).mul(res).sub(0.5), vec3(0), res.sub(1));
            const uv = c.xy.add(f.xz).add(0.5).mul(U.giVolAtlas.xy);
            const w = f.y.add(0.5).div(U.giVolAtlas.z.mul(3));
            const r = U.giVolField.sample(vec3(uv, w));
            const g = U.giVolField.sample(vec3(uv, w.add(1 / 3)));
            const bl = U.giVolField.sample(vec3(uv, w.add(2 / 3)));
            const k = vec4(1, N);
            const ev = max(vec3(dot(r, k), dot(g, k), dot(bl, k)), vec3(0));
            out.assign(mix(world, ev, clamp(m.div(max(c.z, 1e-3)), 0, 1)));
          });
        });
      });
      return out;
    });
    this._irr = Fn(([P, N]) => {
      // hemisphere light (world up), the floor keeps a part of it so nothing goes pitch black (artistic)
      const h = mix(U.hemiGround, U.hemiSky, N.y.mul(0.5).add(0.5));
      const e = vec3(h).toVar();
      If(U.giGrid.w.greaterThan(0.5), () => { e.assign(mix(volume(P, N, field(P, N)), h, U.giFloor)); });
      const occ = clamp(luminance(e).div(max(luminance(h), 1e-4)), 0, 1);
      return vec4(e, occ);
    });
    return this._irr;
  }

  dispose() {
    this.termsTex?.dispose();
    this.baseTex?.dispose();
    this.rt?.dispose();
    if (this.vol) for (const k of ['terms', 'rt', 'index', 'params']) this.vol[k].dispose();
    this.vol = null;
  }
}

function termsTexture(texels, w, h, depth) {
  const t = new THREE.DataArrayTexture(texels, w, h, depth);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function fieldTarget(w, h, d) {
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
