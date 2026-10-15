// Texture arrays (public/data/textures.json, packed by `mc textures build`) and the shader code that
// samples them:
//
//  - terrain  : albedo (A = height) + normal / roughness per terrain layer (TerrainMaterial.js)
//  - surfaces : opaque PBR layers for props, buildings, bark, rocks... albedo + normal / roughness
//  - foliage  : alpha-cut leaf atlases (palm frond, leaf clusters, fern, grass...)
//
// Each group is one tall strip image (layers stacked vertically) uploaded straight into a
// 2D texture array (the image source is sliced by layer height): one fetch + one decode per
// group, no per-layer canvas work. Assets carry `uv` + a per-vertex `surface` id
// (assets/surfaces.js), so every prop / plant keeps sharing one material and one draw call per
// batch: the layer is picked in the shader. Albedo is divided by the layer's mean colour, so the
// vertex colours (asset palettes) still set the overall colour and the texture adds the detail.
import * as THREE from 'three/webgpu';
import {
  Fn, If, texture, uniform, uniformArray, attribute, varying, vec2, vec3, vec4, float, int, mix, min, max, clamp, dot, sqrt, fwidth, dFdx, dFdy, cross, inverseSqrt, normalize, select,
  renderGroup, cameraViewMatrix, Discard, faceDirection, property,
} from 'three/tsl';
import { Data } from '../core/Data.js';
import { setSurfaceManifest, FOLIAGE_BASE } from '../assets/surfaces.js';
import { surfSpecK } from './nodes.js';

/** Fragment properties of a textured surface (surfaceColor -> roughness / metalness / normal nodes). */
export const sRough = property('float', 'sRough'), sMetal = property('float', 'sMetal'), sNrm = property('vec4', 'sNrm'), sLeaf = property('float', 'sLeaf');

const MAX_SURF = 32, MAX_FOL = 16;

/** Same sampler settings as the loaded arrays, so swapping the texture keeps the bindings valid. */
function arraySampler(t, srgb) {
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  return t;
}

function placeholder(srgb) {
  const t = arraySampler(new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255, 128, 128, 128, 255]), 1, 1, 2), srgb);
  t.needsUpdate = true;
  return t;
}

/** Load one strip image as a texture array of `size` x `size` layers. WebGPU: each layer is
 *  copied from the decoded image straight into the GPU texture (no CPU pixel copy), then the
 *  mipmaps of every layer are generated on the GPU. WebGL 2: decoded to pixels first. */
async function loadStrip(url, size, { srgb, renderer }) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const depth = Math.round(bmp.height / size);
  const gpu = renderer?.backend?.isWebGPUBackend;
  const data = gpu ? null : pixels(bmp);
  const tex = arraySampler(new THREE.DataArrayTexture(data, size, size, depth), srgb);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.anisotropy = 8;
  tex.unpackAlignment = 4;
  tex.needsUpdate = true;
  if (!gpu) return tex;
  // allocate (with its mip chain) without uploading, then copy the layers on the GPU
  tex.source.dataReady = false;
  renderer.initTexture(tex);
  const device = renderer.backend.device, dst = renderer.backend.get(tex).texture;
  for (let i = 0; i < depth; i++) {
    device.queue.copyExternalImageToTexture({ source: bmp, origin: { x: 0, y: i * size } }, { texture: dst, origin: { x: 0, y: 0, z: i }, premultipliedAlpha: false }, { width: size, height: size, depthOrArrayLayers: 1 });
  }
  renderer.backend.generateMipmaps(tex);
  bmp.close();
  return tex;
}

/** RGBA pixels of a decoded image (WebGL 2 path). */
function pixels(bmp) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(bmp, 0, 0);
  return new Uint8Array(ctx.getImageData(0, 0, bmp.width, bmp.height, { colorSpace: 'srgb' }).data.buffer);
}

function flatNormal() {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** A plain tiling 2D texture (linear data: normal maps). */
async function loadImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'flipY' });
  const t = new THREE.Texture(bmp);
  t.flipY = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const inv = (m) => (m ?? [0.2, 0.2, 0.2]).map((c) => 1 / Math.max(0.004, c));
export const luma = (m) => Math.max(0.004, 0.2126 * (m?.[0] ?? 0.2) + 0.7152 * (m?.[1] ?? 0.2) + 0.0722 * (m?.[2] ?? 0.2));

/** Texel relative to its layer's mean colour, as luminance ratio x (chroma share of) the hue
 *  ratio — stable for dark layers with tiny channels, amount 0 = flat. info: 1 / mean, mean luma. */
export const surfRel = /*@__PURE__*/ Fn(([t, info, chroma, amount]) => {
  const lt = dot(t, vec3(0.2126, 0.7152, 0.0722));
  const dl = min(lt.div(info.w), 2.6); // very dark layers: bright specks / cracks must not blow up
  const dc = clamp(t.div(max(lt, 1e-4)).mul(info.w).mul(info.xyz), 0, 3);
  return mix(vec3(1), mix(vec3(1), dc, chroma).mul(dl), amount);
}).setLayout({ name: 'surfRel', type: 'vec3', inputs: [{ name: 't', type: 'vec3' }, { name: 'info', type: 'vec4' }, { name: 'chroma', type: 'float' }, { name: 'amount', type: 'float' }] });

/** Cotangent frame from screen derivatives (no tangent attribute; three's getTangentFrame):
 *  [T, B] scaled for the normal map, inline nodes. */
export function surfTBN(eye, n, uv) {
  const q0 = dFdx(eye), q1 = dFdy(eye), st0 = dFdx(uv), st1 = dFdy(uv);
  const q1perp = cross(q1, n), q0perp = cross(n, q0);
  const T = q1perp.mul(st0.x).add(q0perp.mul(st1.x)).toVar();
  const B = q1perp.mul(st0.y).add(q0perp.mul(st1.y)).toVar();
  const det = max(dot(T, T), dot(B, B));
  const s = select(det.equal(0), float(0), inverseSqrt(det));
  return [T.mul(s), B.mul(s)];
}

export class Surfaces {
  constructor() {
    this.manifest = null;
    this.ready = false;
    const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4(1, 1, 1, 0.6));
    const tex = (t) => texture(t);
    const arr = (n) => uniformArray(v4(n), 'vec4').setGroup(renderGroup);
    // nodes; `.value` (textures, floats) / `.array` (vec4 arrays) are updated in place
    this.uniforms = {
      surfAlbedo: tex(placeholder(true)),
      surfNormal: tex(placeholder(false)),
      folAlbedo: tex(placeholder(true)),
      surfInfo: arr(MAX_SURF), // xyz: 1 / mean albedo, w: mean luminance
      surfParams: arr(MAX_SURF), // x: metalness, y: chroma (share of the texture's own hue variation), z: detail amount, w: roughness scale
      folInfo: arr(MAX_FOL), // xyz: 1 / mean albedo, w: mean luminance
      folParams: arr(MAX_FOL), // x: roughness, y: chroma, z: detail amount
      folCut: uniform(0.5).setGroup(renderGroup),
      surfNormalScale: uniform(1).setGroup(renderGroup),
      surfDetail: uniform(1).setGroup(renderGroup), // 0 = flat vertex colours (A/B), 1 = textured
      terAlbedo: tex(placeholder(true)),
      terNormal: tex(placeholder(false)),
      waterNormal: tex(flatNormal()),
    };
  }

  /** Read textures.json and upload the arrays. Missing files leave neutral placeholders. */
  async load(renderer) {
    let m;
    try { m = await Data.json('textures.json'); } catch (err) { console.warn('textures:', err.message); return this; }
    this.manifest = m;
    setSurfaceManifest(m);
    const U = this.uniforms;
    (m.surfaces?.layers ?? []).forEach((l, i) => {
      if (i >= MAX_SURF) return;
      U.surfInfo.array[i].set(...inv(l.mean), luma(l.mean));
      U.surfParams.array[i].set(l.metal ? 0.65 : 0, l.chroma ?? 0.5, l.amount ?? 1, l.roughnessScale ?? 1);
    });
    (m.foliage?.layers ?? []).forEach((l, i) => {
      if (i >= MAX_FOL) return;
      U.folInfo.array[i].set(...inv(l.mean), luma(l.mean));
      U.folParams.array[i].set(Math.max(0.85, l.roughness ?? 0.85), l.chroma ?? 0.7, l.amount ?? 1, 0);
    });
    const url = (f) => `${Data.base}../${f}?v=${m.version ?? 0}`;
    const jobs = [];
    const strip = (group, map, uniform, srgb, size) => {
      const f = m[group]?.files?.[map];
      if (!f) return;
      jobs.push(loadStrip(url(f), size, { srgb, renderer }).then((t) => { U[uniform].value = t; }).catch((err) => console.warn('textures:', err.message)));
    };
    strip('surfaces', 'albedo', 'surfAlbedo', true, m.surfaces?.size);
    strip('surfaces', 'normal', 'surfNormal', false, m.surfaces?.normalSize ?? m.surfaces?.size);
    strip('foliage', 'albedo', 'folAlbedo', true, m.foliage?.size);
    strip('terrain', 'albedo', 'terAlbedo', true, m.terrain?.size);
    strip('terrain', 'normal', 'terNormal', false, m.terrain?.normalSize ?? m.terrain?.size);
    if (m.water?.files?.normal) jobs.push(loadImage(url(m.water.files.normal)).then((t) => { U.waterNormal.value = t; }).catch((err) => console.warn('textures:', err.message)));
    await Promise.all(jobs);
    // upload now (during loading) rather than on the first frame that uses them
    for (const k of ['surfAlbedo', 'surfNormal', 'folAlbedo', 'terAlbedo', 'terNormal', 'waterNormal']) renderer?.initTexture?.(U[k].value);
    this.ready = true;
    return this;
  }

  /** Terrain layer index of a layer id. */
  terrainLayer(id) { return Math.max(0, (this.manifest?.terrain?.layers ?? []).findIndex((l) => l.id === id)); }

  /**
   * Textured PBR surface of an asset fragment (per-vertex `uv` + `surface` layer id). Call inside
   * the colour node's Fn (fragment stage): returns the colour factor (multiplies the vertex colour)
   * and sets the fragment properties sRough, sMetal, sNrm, sLeaf, surfSpecK that the roughness,
   * metalness and normal nodes read. a2c: cut-out leaves through alpha to coverage (multisampled
   * target: smooth edges; the alpha goes to `alpha`), else a hard cut.
   */
  surfaceColor({ a2c = false, alpha = null } = {}) {
    const U = this.uniforms;
    const sUv = varying(attribute('uv', 'vec2'), 'vSurfUv');
    const sId = varying(int(attribute('surface', 'float').add(0.5)), 'vSurf').setInterpolation(THREE.InterpolationSamplingType.FLAT);
    const color = vec3(1).toVar('sColor');
    sRough.assign(0.6); sMetal.assign(0); sNrm.assign(vec4(0.5, 0.5, 0.6, 1)); surfSpecK.assign(1);
    sLeaf.assign(select(sId.greaterThanEqual(FOLIAGE_BASE), float(1), float(0)));
    const detail = U.surfDetail;
    If(sLeaf.greaterThan(0.5), () => {
      const li = sId.sub(FOLIAGE_BASE);
      const t = U.folAlbedo.sample(sUv).depth(li);
      // cut-out, sharpened around the threshold (crisp at every mip, smooth with alpha to coverage)
      const a = t.a.sub(U.folCut).div(max(fwidth(t.a), 1e-4)).add(0.5);
      if (a2c) {
        If(a.lessThanEqual(0), () => { Discard(); });
        alpha?.assign(clamp(a, 0, 1));
      } else {
        If(a.lessThan(0.5), () => { Discard(); });
      }
      const fp = U.folParams.element(li);
      color.assign(mix(vec3(1), surfRel(t.rgb, U.folInfo.element(li), fp.y, fp.z), detail));
      sRough.assign(fp.x);
      surfSpecK.assign(0.15);
    }).Else(() => {
      const t = U.surfAlbedo.sample(sUv).depth(sId);
      const sp = U.surfParams.element(sId);
      // detail relative to the layer's mean: the part colour keeps its hue (rust, stains: chroma)
      color.assign(mix(vec3(1), surfRel(t.rgb, U.surfInfo.element(sId), sp.y, sp.z), detail));
      sNrm.assign(U.surfNormal.sample(sUv).depth(sId));
      sRough.assign(mix(0.75, clamp(sNrm.b.mul(sp.w), 0.05, 1), detail));
      sMetal.assign(sp.x.mul(detail));
    });
    return color;
  }

  /** Shading normal of a textured surface (inside the normal node's Fn, after surfaceColor ran):
   *  the layer's normal map in a derivative cotangent frame; leaves bend toward the sky instead.
   *  nView: interpolated normal (view space), eye: view-space position. */
  surfaceNormal(nView, eye, doubleSided) {
    const U = this.uniforms;
    const sUv = varying(attribute('uv', 'vec2'), 'vSurfUv');
    const out = vec3(nView).toVar('sN');
    If(sLeaf.lessThan(0.5), () => {
      const mapN = vec3(sNrm.xy.mul(2).sub(1).mul(U.surfNormalScale).mul(U.surfDetail), 0).toVar();
      mapN.z.assign(sqrt(max(0, float(1).sub(dot(mapN.xy, mapN.xy)))));
      const [T, B] = surfTBN(eye, nView, sUv);
      const fd = doubleSided ? faceDirection : float(1);
      out.assign(normalize(T.mul(fd).mul(mapN.x).add(B.mul(fd).mul(mapN.y)).add(nView.mul(mapN.z))));
    }).Else(() => {
      // thin, translucent leaves: light from above reaches their undersides too
      out.assign(normalize(nView.add(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz.mul(0.9))));
    });
    return out;
  }

  /** Depth-only passes (sun cascades, SSAO pre-pass): discard where a leaf card is cut out. Call
   *  inside a material's colour node; geometries without a `surface` attribute skip it. */
  depthCut(builder) {
    if (!builder.geometry?.hasAttribute('surface') || !builder.geometry.hasAttribute('uv')) return;
    const U = this.uniforms;
    const sId = varying(int(attribute('surface', 'float').add(0.5)), 'vSurf').setInterpolation(THREE.InterpolationSamplingType.FLAT);
    const sUv = varying(attribute('uv', 'vec2'), 'vSurfUv');
    If(sId.greaterThanEqual(FOLIAGE_BASE), () => {
      If(U.folAlbedo.sample(sUv).depth(sId.sub(FOLIAGE_BASE)).a.lessThan(U.folCut), () => { Discard(); });
    });
  }
}
