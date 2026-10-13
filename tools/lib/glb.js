// Minimal glTF 2.0 binary (GLB) reader / writer for the Node tools (three's GLTFLoader can't
// decode images in Node and its exporter needs a DOM).
//   readGLB(buffer)         -> { json, bin } (glTF JSON + binary chunk)
//   imageBytes(glb, i)      -> Buffer of image i (embedded or next to a .gltf, see loadGLTF)
//   stripTextures(glb)      -> GLB Buffer without images / textures (parsable by GLTFLoader in Node)
//   new GLBBuilder()        -> accessors, images, materials, meshes, nodes, skins -> toBuffer()
import fs from 'node:fs';
import path from 'node:path';

const MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

export function readGLB(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB');
  let o = 12, json = null, bin = null;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_CHUNK) bin = data;
    o += 8 + len;
  }
  return { json, bin, dir: null };
}

/** .glb or .gltf (+ .bin / images next to it) -> { json, bin, dir }. */
export function loadGLTF(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) === MAGIC) return { ...readGLB(buf), dir: path.dirname(file) };
  const json = JSON.parse(buf.toString('utf8'));
  const dir = path.dirname(file);
  const uri = json.buffers?.[0]?.uri;
  const bin = uri ? (uri.startsWith('data:') ? Buffer.from(uri.split(',')[1], 'base64') : fs.readFileSync(path.join(dir, decodeURIComponent(uri)))) : null;
  return { json, bin, dir };
}

export function imageBytes(glb, i) {
  const img = glb.json.images[i];
  if (img.bufferView !== undefined) {
    const bv = glb.json.bufferViews[img.bufferView];
    return Buffer.from(glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
  }
  if (img.uri?.startsWith('data:')) return Buffer.from(img.uri.split(',')[1], 'base64');
  return fs.readFileSync(path.join(glb.dir ?? '.', decodeURIComponent(img.uri)));
}

/** GLB without images / textures / samplers (geometry, skins, materials' factors kept). */
export function stripTextures(glb) {
  const json = structuredClone(glb.json);
  delete json.images; delete json.textures; delete json.samplers;
  for (const m of json.materials ?? []) {
    for (const k of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete m[k];
    if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; }
    delete m.extensions;
  }
  const keep = (e) => !/texture|pbrSpecular|KHR_materials/i.test(e);
  if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter(keep);
  if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter(keep);
  if (json.buffers?.[0]) { delete json.buffers[0].uri; json.buffers[0].byteLength = glb.bin?.length ?? 0; }
  return packGLB(json, glb.bin ?? Buffer.alloc(0));
}

function pad4(buf, fill) {
  const p = (4 - (buf.length % 4)) % 4;
  return p ? Buffer.concat([buf, Buffer.alloc(p, fill)]) : buf;
}

export function packGLB(json, bin) {
  const js = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const bn = pad4(Buffer.from(bin), 0);
  const parts = [js, bn.length ? bn : null].filter(Boolean);
  const total = 12 + parts.reduce((s, p) => s + 8 + p.length, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const chunk = (data, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return [h, data]; };
  return Buffer.concat([head, ...chunk(js, JSON_CHUNK), ...(bn.length ? chunk(bn, BIN_CHUNK) : [])]);
}

const COMPONENT = { Float32Array: 5126, Uint32Array: 5125, Uint16Array: 5123, Uint8Array: 5121, Int16Array: 5122, Int8Array: 5120 };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export class GLBBuilder {
  constructor() {
    this.json = { asset: { version: '2.0', generator: 'mini-cry tools/lib/glb.js' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
    this.chunks = [];
    this.length = 0;
  }

  _view(bytes, target) {
    const off = this.length;
    const b = pad4(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
    this.chunks.push(b);
    this.length += b.length;
    const view = { buffer: 0, byteOffset: off, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  /** typed array -> accessor index (type: SCALAR / VEC2 / VEC3 / VEC4 / MAT4). */
  accessor(arr, type, { normalized = false, minmax = false, target } = {}) {
    const n = SIZE[type];
    const acc = { bufferView: this._view(arr, target), componentType: COMPONENT[arr.constructor.name], count: arr.length / n, type };
    if (normalized) acc.normalized = true;
    if (minmax) {
      const mn = new Array(n).fill(Infinity), mx = new Array(n).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) { const k = i % n; mn[k] = Math.min(mn[k], arr[i]); mx[k] = Math.max(mx[k], arr[i]); }
      acc.min = mn; acc.max = mx;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  /** encoded image (image/jpeg, image/png) -> texture index. */
  texture(bytes, mimeType = 'image/jpeg', { wrap = 10497 } = {}) {
    const j = this.json;
    j.images ??= []; j.textures ??= []; j.samplers ??= [];
    j.images.push({ bufferView: this._view(new Uint8Array(bytes)), mimeType });
    let s = j.samplers.findIndex((x) => x.wrapS === wrap);
    if (s < 0) { j.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: wrap, wrapT: wrap }); s = j.samplers.length - 1; }
    j.textures.push({ source: j.images.length - 1, sampler: s });
    return j.textures.length - 1;
  }

  material(m) { this.json.materials.push(m); return this.json.materials.length - 1; }
  mesh(m) { this.json.meshes.push(m); return this.json.meshes.length - 1; }
  node(n, { root = false } = {}) { this.json.nodes.push(n); const i = this.json.nodes.length - 1; if (root) this.json.scenes[0].nodes.push(i); return i; }
  skin(s) { (this.json.skins ??= []).push(s); return this.json.skins.length - 1; }

  toBuffer() {
    const bin = Buffer.concat(this.chunks);
    this.json.buffers[0].byteLength = bin.length;
    for (const k of ['materials', 'meshes']) if (!this.json[k].length) delete this.json[k];
    return packGLB(this.json, bin);
  }
}
