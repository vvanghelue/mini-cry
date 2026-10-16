// Texture arrays (public/data/textures.json, packed by `mc textures build`) and the shader code that
// samples them:
//
//  - terrain  : albedo (A = height) + normal / roughness per terrain layer (TerrainMaterial.js)
//  - surfaces : opaque PBR layers for props, buildings, bark, rocks... albedo + normal / roughness
//  - foliage  : alpha-cut leaf atlases (palm frond, leaf clusters, fern, grass...)
//
// Each group is one tall strip image (layers stacked vertically), decoded once and copied layer by
// layer straight into a GPU 2D texture array (WebGPU copyExternalImageToTexture: no CPU pixel work),
// then mipmapped on the GPU. Assets carry `uv` + a per-vertex `surface` id (assets/surfaces.js), so
// every prop / plant keeps sharing one material and one draw call per batch: the layer is picked in
// the shader. Albedo is divided by the layer's mean colour, so the vertex colours (asset palettes)
// still set the overall colour and the texture adds the detail.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Discard, float, int, vec3, vec4, dot, min, max, clamp, mix, sqrt, normalize, cross, inverseSqrt, select,
  texture, uniformArray, attribute, varying, uv, dFdx, dFdy, fwidth, positionView, faceDirection, cameraViewMatrix, renderGroup,
} from 'three/tsl';
import { Data } from '../core/Data.js';
import { setSurfaceManifest, FOLIAGE_BASE } from '../assets/surfaces.js';
import { U } from './tsl.js';

const MAX_SURF = 32, MAX_FOL = 16;

function placeholder(srgb) {
  const t = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

async function decode(url, opts = {}) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', ...opts });
}

/** One strip image -> a texture array of `size` x `size` layers, uploaded on the GPU directly. */
async function loadStrip(renderer, url, size, { srgb }) {
  const bmp = await decode(url);
  const depth = Math.round(bmp.height / size);
  const tex = new THREE.DataArrayTexture(null, size, size, depth);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  uploadLayers(renderer, tex, bmp, size, depth);
  bmp.close?.();
  return tex;
}

/** Fill a texture array from a vertical strip of layers. WebGPU: GPU copies of each layer, then GPU
 *  mipmaps; WebGL 2 fallback: CPU decode into the texture's data. */
function uploadLayers(renderer, tex, bmp, size, depth) {
  const backend = renderer.backend;
  if (backend?.isWebGPUBackend) {
    // allocated by three (format, mip levels, usage) without uploading anything: then our copies
    tex.isRenderTargetTexture = true;
    tex.image = { width: size, height: size, depth, data: null };
    renderer.initTexture(tex);
    const gpu = backend.get(tex).texture;
    const q = backend.device.queue;
    for (let l = 0; l < depth; l++) {
      q.copyExternalImageToTexture({ source: bmp, origin: { x: 0, y: l * size }, flipY: false }, { texture: gpu, origin: { x: 0, y: 0, z: l }, premultipliedAlpha: false }, [size, size, 1]);
    }
    backend.textureUtils.generateMipmaps(tex);
    return;
  }
  const c = new OffscreenCanvas(size, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  tex.image = { width: size, height: size, depth, data: new Uint8Array(ctx.getImageData(0, 0, size, bmp.height).data.buffer) };
  tex.needsUpdate = true;
}

function flatNormal() {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** A plain tiling 2D texture (linear data: normal maps). */
async function loadImage(url) {
  const bmp = await decode(url, { imageOrientation: 'flipY' });
  const t = new THREE.Texture(bmp);
  t.flipY = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const inv = (m) => (m ?? [0.2, 0.2, 0.2]).map((c) => 1 / Math.max(0.004, c));
export const luma = (m) => Math.max(0.004, 0.2126 * (m?.[0] ?? 0.2) + 0.7152 * (m?.[1] ?? 0.2) + 0.0722 * (m?.[2] ?? 0.2));

/** Texel relative to its layer's mean colour, as luminance ratio x (chroma share of) the hue ratio
 *  — stable for dark layers with tiny channels, amount 0 = flat. info: (1 / mean rgb, mean luma). */
export const surfRel = Fn(([t, info, chroma, amount]) => {
  const lt = dot(t, vec3(0.2126, 0.7152, 0.0722));
  const dl = min(lt.div(info.w), 2.6); // very dark layers: bright specks / cracks must not blow up
  const dc = clamp(t.div(max(lt, 1e-4)).mul(info.w).mul(info.xyz), 0.0, 3.0);
  return mix(vec3(1.0), mix(vec3(1.0), dc, chroma).mul(dl), amount);
});

export class Surfaces {
  constructor() {
    this.manifest = null;
    this.ready = false;
    const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4(1, 1, 1, 0.6));
    const arr = (n) => uniformArray(v4(n), 'vec4').setGroup(renderGroup);
    this.uniforms = {
      surfAlbedo: texture(placeholder(true)),
      surfNormal: texture(placeholder(false)),
      folAlbedo: texture(placeholder(true)),
      surfInfo: arr(MAX_SURF), // xyz: 1 / mean albedo, w: mean luminance
      surfParams: arr(MAX_SURF), // x: metalness, y: chroma (share of the texture's own hue variation), z: detail amount, w: roughness scale
      folInfo: arr(MAX_FOL), // xyz: 1 / mean albedo, w: mean luminance
      folParams: arr(MAX_FOL), // x: roughness, y: chroma, z: detail amount
      folCut: U(0.5),
      surfNormalScale: U(1),
      surfDetail: U(1), // 0 = flat vertex colours (A/B), 1 = textured
      terAlbedo: texture(placeholder(true)),
      terNormal: texture(placeholder(false)),
      waterNormal: texture(flatNormal()),
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
      jobs.push(loadStrip(renderer, url(f), size, { srgb }).then((t) => { U[uniform].value = t; }).catch((err) => console.warn('textures:', err.message)));
    };
    strip('surfaces', 'albedo', 'surfAlbedo', true, m.surfaces?.size);
    strip('surfaces', 'normal', 'surfNormal', false, m.surfaces?.normalSize ?? m.surfaces?.size);
    strip('foliage', 'albedo', 'folAlbedo', true, m.foliage?.size);
    strip('terrain', 'albedo', 'terAlbedo', true, m.terrain?.size);
    strip('terrain', 'normal', 'terNormal', false, m.terrain?.normalSize ?? m.terrain?.size);
    if (m.water?.files?.normal) jobs.push(loadImage(url(m.water.files.normal)).then((t) => { U.waterNormal.value = t; }).catch((err) => console.warn('textures:', err.message)));
    await Promise.all(jobs);
    // upload now (during loading) rather than on the first frame that uses them
    renderer?.initTexture?.(U.waterNormal.value);
    this.ready = true;
    return this;
  }

  /** Terrain layer index of a layer id. */
  terrainLayer(id) { return Math.max(0, (this.manifest?.terrain?.layers ?? []).findIndex((l) => l.id === id)); }

  /** Varyings of a textured asset: uv and the surface id (flat). */
  varyings() {
    return {
      sUv: varying(uv(), 'vSurfUv'),
      sId: varying(attribute('surface', 'float'), 'vSurf').setInterpolation('flat'),
    };
  }

  /** Fragment mask of the depth passes: false on the cut-out part of a leaf texture. Only for
   *  geometries with a `surface` attribute (checked at build time). */
  leafMaskNode() {
    const U = this.uniforms;
    return Fn((builder) => {
      if (!builder.geometry?.attributes?.surface) return float(1.0).greaterThan(0.5);
      const { sUv, sId } = this.varyings();
      const keep = float(1.0).toVar();
      If(sId.greaterThanEqual(FOLIAGE_BASE - 0.5), () => {
        const a = U.folAlbedo.sample(sUv).depth(int(sId.add(0.5)).sub(FOLIAGE_BASE)).a;
        If(a.lessThan(U.folCut), () => { keep.assign(0.0); });
      });
      return keep.greaterThan(0.5);
    })();
  }

  /**
   * The textured surface of an asset fragment (inside the material's colour node). Updates the
   * material state vars `st` = { color (vec3, multiplied), alpha, rough, metal, normal (view space,
   * in: the geometry normal), leaf (0 / 1), specK (sky reflection share) } and cuts the leaves out
   * (discard, or a soft alpha for alpha to coverage).
   */
  sample(st, { alphaToCoverage = false, doubleSided = false } = {}) {
    const U = this.uniforms;
    const { sUv, sId } = this.varyings();
    const id = int(sId.add(0.5)).toVar();
    If(id.greaterThanEqual(FOLIAGE_BASE), () => {
      const li = id.sub(FOLIAGE_BASE).toVar();
      const t = U.folAlbedo.sample(sUv).depth(li).toVar();
      // cut-out, sharpened around the threshold (crisp at every mip, smooth with alpha to coverage)
      const a = t.a.sub(U.folCut).div(max(fwidth(t.a), 1e-4)).add(0.5).toVar();
      if (alphaToCoverage) {
        If(a.lessThanEqual(0.0), () => { Discard(); });
        st.alpha.assign(clamp(a, 0.0, 1.0));
      } else {
        If(a.lessThan(0.5), () => { Discard(); });
      }
      const fp = U.folParams.element(li).toVar();
      st.color.mulAssign(mix(vec3(1.0), surfRel(t.rgb, U.folInfo.element(li), fp.y, fp.z), U.surfDetail));
      st.rough.assign(fp.x);
      st.specK.assign(0.15);
      st.leaf.assign(1.0);
      // thin, translucent leaves: light from above reaches their undersides too
      st.normal.assign(normalize(st.normal.add(cameraViewMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz.mul(0.9))));
    }).Else(() => {
      const t = U.surfAlbedo.sample(sUv).depth(id);
      const sp = U.surfParams.element(id).toVar();
      // detail relative to the layer's mean: the part colour keeps its hue (rust, stains: chroma)
      st.color.mulAssign(mix(vec3(1.0), surfRel(t.rgb, U.surfInfo.element(id), sp.y, sp.z), U.surfDetail));
      const n = U.surfNormal.sample(sUv).depth(id).toVar();
      st.rough.assign(mix(0.75, clamp(n.b.mul(sp.w), 0.05, 1.0), U.surfDetail));
      st.metal.assign(sp.x.mul(U.surfDetail));
      const m = n.xy.mul(2.0).sub(1.0).mul(U.surfNormalScale).mul(U.surfDetail).toVar();
      const mz = sqrt(max(0.0, float(1.0).sub(dot(m, m))));
      // cotangent frame from screen derivatives (no tangent attribute; three's getTangentFrame)
      const N = st.normal, eye = positionView;
      const q0 = dFdx(eye), q1 = dFdy(eye), st0 = dFdx(sUv), st1 = dFdy(sUv);
      const q1perp = cross(q1, N), q0perp = cross(N, q0);
      const T = q1perp.mul(st0.x).add(q0perp.mul(st1.x)).toVar();
      const B = q1perp.mul(st0.y).add(q0perp.mul(st1.y)).toVar();
      const det = max(dot(T, T), dot(B, B));
      let k = select(det.equal(0.0), float(0.0), inverseSqrt(det));
      if (doubleSided) k = k.mul(faceDirection);
      st.normal.assign(normalize(T.mul(k.mul(m.x)).add(B.mul(k.mul(m.y))).add(N.mul(mz))));
    });
  }
}

