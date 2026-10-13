// Realistic first-person weapon: a textured glTF / GLB (CC0 scans or models) -> one GLB in the
// asset's weapon space (docs/ASSETS.md: metres, +Y up, front toward -Z), with the same transform
// conventions as `mc asset import` (import-glb.js): rot (deg, Euler YXZ, applied first), length
// (size along Z after rotation) or scale, origin (point of the scaled model, in the frame centred on
// X / Z with the bottom at y = 0, that becomes the origin). Meshes are merged per material, the
// textures resized to maxTexture (JPEG, or PNG when they have an alpha channel).
import path from 'node:path';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import sharp from 'sharp';
import { loadGLTF, stripTextures, imageBytes, GLBBuilder } from './glb.js';

const D2R = Math.PI / 180;

/**
 * src: viewmodels.json weapons entry: file, keep / hide (regexps on mesh names: one variant of a
 * model sheet), rot, length | scale, origin, maxTexture, quality, materials (per material name:
 * maxTexture, color / normal / orm texture files of the source folder, pbr factors, alphaMode...);
 * dir: its cache folder.
 */
export async function buildWeapon(src, dir) {
  const file = path.join(dir, src.file ?? `${src.polyhaven}_${src.res ?? '2k'}.gltf`);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}: run \`mc viewmodel fetch\` first`);
  const glb = loadGLTF(file);
  const buf = stripTextures(glb);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  gltf.scene.updateMatrixWorld(true);
  const r = src.rot ?? [0, 0, 0];
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'YXZ'));
  const keep = src.keep ? new RegExp(src.keep) : null, hide = src.hide ? new RegExp(src.hide) : null;
  // geometry per source material, rotated
  const groups = new Map();
  const box = new THREE.Box3();
  const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    if (!o.isMesh || (keep && !keep.test(o.name)) || (hide && hide.test(o.name))) return;
    const assoc = gltf.parser.associations.get(o.material);
    const mi = assoc?.materials ?? -1;
    const g = o.geometry;
    m.multiplyMatrices(R, o.matrixWorld);
    nm.getNormalMatrix(m);
    const flip = m.determinant() < 0;
    const grp = groups.get(mi) ?? { P: [], N: [], UV: [], T: [], I: [], hasT: !!g.attributes.tangent };
    const base = grp.P.length / 3;
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, tan = g.attributes.tangent;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      box.expandByPoint(v);
      grp.P.push(v.x, v.y, v.z);
      if (nor) { v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); grp.N.push(v.x, v.y, v.z); }
      grp.UV.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      if (grp.hasT) {
        if (tan) { v.fromBufferAttribute(tan, i).transformDirection(m); grp.T.push(v.x, v.y, v.z, tan.getW(i) * (flip ? -1 : 1)); } else grp.T.push(1, 0, 0, 1);
      }
    }
    const idx = g.index ? g.index.array : Array.from({ length: pos.count }, (_, i) => i);
    for (let f = 0; f < idx.length; f += 3) {
      if (flip) grp.I.push(base + idx[f], base + idx[f + 2], base + idx[f + 1]);
      else grp.I.push(base + idx[f], base + idx[f + 1], base + idx[f + 2]);
    }
    groups.set(mi, grp);
  });
  if (!groups.size) throw new Error('no meshes');
  const size = box.getSize(new THREE.Vector3());
  const s = src.scale ?? (src.length ? src.length / size.z : 1);
  const base = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const o = new THREE.Vector3(...(src.origin ?? [0, 0, 0]));
  // textures: each source image once per size, resized
  const out = new GLBBuilder();
  const q = src.quality ?? 86;
  const texCache = new Map();
  const texStats = [];
  const encode = async (key, name, read, { linear = false, max }) => {
    const ck = `${key}@${max}`;
    if (!texCache.has(ck)) {
      const meta = await sharp(read()).metadata();
      const k = Math.min(1, max / Math.max(meta.width, meta.height));
      const w = Math.round(meta.width * k), h = Math.round(meta.height * k);
      const alpha = meta.hasAlpha && !linear && (await sharp(read()).stats()).channels[3]?.min < 250;
      const img = sharp(read()).resize(w, h).toColourspace('srgb');
      const bytes = alpha ? await img.png({ compressionLevel: 9 }).toBuffer() : await img.removeAlpha().jpeg({ quality: q, mozjpeg: true }).toBuffer();
      texCache.set(ck, out.texture(bytes, alpha ? 'image/png' : 'image/jpeg'));
      texStats.push({ image: name, size: [w, h], bytes: bytes.length });
    }
    return { index: texCache.get(ck) };
  };
  // a glTF texture reference, or a file of the source folder (materials.<name>.color / normal / orm)
  const tex = async (info, opts) => {
    if (!info) return undefined;
    if (typeof info === 'string') return encode('file:' + info, path.basename(info), () => fs.readFileSync(path.join(dir, info)), opts);
    const t = glb.json.textures[info.index];
    const img = t.source ?? t.extensions?.EXT_texture_webp?.source;
    const r = await encode('img:' + img, glb.json.images[img].name ?? glb.json.images[img].uri ?? String(img), () => imageBytes(glb, img), opts);
    return { ...r, ...(info.texCoord ? { texCoord: info.texCoord } : {}) };
  };
  const prims = [];
  let tris = 0;
  for (const [mi, grp] of groups) {
    const sm = glb.json.materials?.[mi] ?? {};
    const pbr = sm.pbrMetallicRoughness ?? {};
    const name = sm.name ?? `material${mi}`;
    const over = src.materials?.[name] ?? {};
    const max = over.maxTexture ?? src.maxTexture ?? 1024;
    const mat = { name, pbrMetallicRoughness: {} };
    for (const k of ['baseColorFactor', 'metallicFactor', 'roughnessFactor']) if (pbr[k] !== undefined) mat.pbrMetallicRoughness[k] = pbr[k];
    const color = over.color ?? pbr.baseColorTexture, orm = over.orm ?? pbr.metallicRoughnessTexture, normal = over.normal ?? sm.normalTexture;
    const occl = over.orm ?? sm.occlusionTexture;
    if (color) mat.pbrMetallicRoughness.baseColorTexture = await tex(color, { max });
    // occlusion / roughness / metalness at half the size (smooth maps, the colour and normals carry the detail)
    if (orm) mat.pbrMetallicRoughness.metallicRoughnessTexture = await tex(orm, { linear: true, max: max / 2 });
    if (normal) mat.normalTexture = { ...(await tex(normal, { linear: true, max })), ...(sm.normalTexture?.scale !== undefined ? { scale: sm.normalTexture.scale } : {}) };
    if (occl) mat.occlusionTexture = { ...(await tex(occl, { linear: true, max: max / 2 })), ...(sm.occlusionTexture?.strength !== undefined ? { strength: sm.occlusionTexture.strength } : {}) };
    if (over.orm) { mat.pbrMetallicRoughness.metallicFactor = 1; mat.pbrMetallicRoughness.roughnessFactor = 1; }
    if (sm.emissiveTexture || over.emissive) mat.emissiveTexture = await tex(over.emissive ?? sm.emissiveTexture, { max });
    for (const k of ['emissiveFactor', 'alphaMode', 'alphaCutoff', 'doubleSided']) if (sm[k] !== undefined) mat[k] = sm[k];
    // overrides: glTF material fields (alphaMode, doubleSided, emissiveFactor) and pbr factors
    for (const [k, val] of Object.entries(over)) {
      if (['maxTexture', 'color', 'normal', 'orm', 'emissive'].includes(k)) continue;
      if (['alphaMode', 'alphaCutoff', 'doubleSided', 'emissiveFactor'].includes(k)) mat[k] = val;
      else mat.pbrMetallicRoughness[k] = val;
    }
    const P = new Float32Array(grp.P);
    for (let i = 0; i < P.length; i += 3) {
      P[i] = (P[i] - base.x) * s - o.x;
      P[i + 1] = (P[i + 1] - base.y) * s - o.y;
      P[i + 2] = (P[i + 2] - base.z) * s - o.z;
    }
    const n = P.length / 3;
    const attributes = {
      POSITION: out.accessor(P, 'VEC3', { minmax: true, target: 34962 }),
      TEXCOORD_0: out.accessor(new Float32Array(grp.UV), 'VEC2', { target: 34962 }),
    };
    if (grp.N.length) attributes.NORMAL = out.accessor(new Float32Array(grp.N), 'VEC3', { target: 34962 });
    if (grp.hasT) attributes.TANGENT = out.accessor(new Float32Array(grp.T), 'VEC4', { target: 34962 });
    prims.push({ attributes, indices: out.accessor(n > 65535 ? new Uint32Array(grp.I) : new Uint16Array(grp.I), 'SCALAR', { target: 34963 }), material: out.material(mat) });
    tris += grp.I.length / 3;
  }
  const mesh = out.mesh({ name: 'weapon', primitives: prims });
  out.node({ name: 'weapon', mesh }, { root: true });
  const round = (x) => Math.round(x * 1e4) / 1e4 || 0;
  const min = [(box.min.x - base.x) * s - o.x, -o.y, (box.min.z - base.z) * s - o.z].map(round);
  const max = [(box.max.x - base.x) * s - o.x, size.y * s - o.y, (box.max.z - base.z) * s - o.z].map(round);
  return { glb: out.toBuffer(), tris, materials: prims.length, textures: texStats, bounds: { min, max }, scale: round(s) };
}
