// First-person arms from a rigged character (Microsoft Rocketbox avatars, MIT: 3ds Max Biped rig,
// 3 joints per finger, photo textures): keeps the arm triangles of the body mesh, re-binds them in
// the rest pose with an arm-only skeleton (names as src/game/player/ViewArms.js expects), crops the
// textures to the arms' UV rectangle and writes one GLB (PBR material: colour, normal, roughness).
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import sharp from 'sharp';
import { loadGLTF, stripTextures, GLBBuilder } from './glb.js';
import { decodeTGA } from './tga.js';

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

/** Biped bone name -> arm rig name (null: not an arm bone). */
export function bipedArmName(name) {
  const m = /Bip01[_ ]([LR])[_ ](UpperArm|Forearm|Hand|Finger(\d)(\d?))$/.exec(name);
  if (!m) return null;
  const s = m[1];
  if (m[2] === 'UpperArm') return `UpperArm.${s}`;
  if (m[2] === 'Forearm') return `LowerArm.${s}`;
  if (m[2] === 'Hand') return `Wrist.${s}`;
  return `${FINGERS[+m[3]]}${(m[4] === '' ? 0 : +m[4]) + 1}.${s}`;
}

async function readImage(file) {
  if (/\.tga$/i.test(file)) {
    const t = decodeTGA(fs.readFileSync(file));
    return sharp(t.data, { raw: { width: t.width, height: t.height, channels: 4 } });
  }
  return sharp(file);
}

/**
 * opts: glb (converted character), mesh (name of the body mesh, regexp source), textures
 * { color, normal, specular } (files), roughness [at spec 0, at spec 1], flipNormalY, maxSize
 * (longest side of the packed textures), quality (jpeg), erase ([[x, y, w, h, dx, dy]] texels).
 */
export async function buildArms(opts) {
  const src = loadGLTF(opts.glb);
  const buf = stripTextures(src);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  gltf.scene.updateMatrixWorld(true);
  const re = new RegExp(opts.mesh ?? 'body', 'i');
  let mesh = null;
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !mesh && re.test(o.material?.name ?? '')) mesh = o; });
  if (!mesh) throw new Error('no skinned mesh with a material matching ' + re);
  const sk = mesh.skeleton;
  sk.pose();
  gltf.scene.updateMatrixWorld(true);
  // arm bones (source index -> rig name), the rest re-assigned to the upper arm of their side
  const rigName = sk.bones.map((b) => bipedArmName(b.name));
  const keep = new Set(rigName.map((n, i) => (n ? i : -1)).filter((i) => i >= 0));
  const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const upperOf = { L: rigName.indexOf('UpperArm.L'), R: rigName.indexOf('UpperArm.R') };
  const geo = mesh.geometry, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, idx = geo.index.array;
  const main = new Int16Array(si.count);
  for (let i = 0; i < si.count; i++) {
    let best = -1;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > best) { best = w; main[i] = si.getComponent(i, k); } }
  }
  const tris = [], remap = new Map();
  for (let f = 0; f < idx.length; f += 3) {
    if (!keep.has(main[idx[f]]) || !keep.has(main[idx[f + 1]]) || !keep.has(main[idx[f + 2]])) continue;
    for (let j = 0; j < 3; j++) { const v = idx[f + j]; if (!remap.has(v)) remap.set(v, remap.size); tris.push(remap.get(v)); }
  }
  // output skeleton: the kept bones in source order (parents before children), unit scale,
  // rest-pose world transforms; vertices at their skinned rest positions
  const depth = (b) => { let d = 0; for (let p = sk.bones[b].parent; p; p = p.parent) d++; return d; };
  const order = [...keep].sort((a, b) => depth(a) - depth(b) || a - b);
  const outIndex = new Map(order.map((b, i) => [b, i]));
  const worldQ = (b) => b.getWorldQuaternion(new THREE.Quaternion());
  // canonical frame (whatever the converter's root transform): shoulders centred on the origin,
  // the left arm toward +X, up +Y, the character facing +Z (what ViewArms expects)
  const shL = wp(sk.bones[upperOf.L]), shR = wp(sk.bones[upperOf.R]);
  const left = shL.clone().sub(shR).normalize(), up = new THREE.Vector3(0, 1, 0);
  up.addScaledVector(left, -up.dot(left)).normalize();
  const fwd = new THREE.Vector3().crossVectors(left, up);
  const toCanon = new THREE.Matrix4().makeBasis(left, up, fwd).transpose().multiply(new THREE.Matrix4().makeTranslation(shL.add(shR).multiplyScalar(-0.5)));
  const rotCanon = new THREE.Matrix3().setFromMatrix4(toCanon);
  const n = remap.size;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2);
  const J = new Uint8Array(n * 4), W = new Float32Array(n * 4);
  const v3 = new THREE.Vector3(), nm = new THREE.Matrix3(), m4 = new THREE.Matrix4();
  for (const [v, i] of remap) {
    mesh.getVertexPosition(v, v3);
    mesh.localToWorld(v3).applyMatrix4(toCanon).toArray(P, i * 3);
    // world = meshWorld x bindInverse x (bone x boneInverse) x bind (dominant bone)
    m4.multiplyMatrices(sk.bones[main[v]].matrixWorld, sk.boneInverses[main[v]]).multiply(mesh.bindMatrix).premultiply(mesh.bindMatrixInverse).premultiply(mesh.matrixWorld);
    nm.getNormalMatrix(m4);
    v3.fromBufferAttribute(geo.attributes.normal, v).applyMatrix3(nm).applyMatrix3(rotCanon).normalize().toArray(N, i * 3);
    UV[i * 2] = geo.attributes.uv.getX(v); UV[i * 2 + 1] = geo.attributes.uv.getY(v);
    const side = P[i * 3] >= 0 ? 'L' : 'R';
    const acc = new Map();
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(v, k);
      if (w <= 0) continue;
      let b = si.getComponent(v, k);
      if (!keep.has(b)) b = upperOf[side];
      acc.set(b, (acc.get(b) ?? 0) + w);
    }
    const ws = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const tot = ws.reduce((s, x) => s + x[1], 0);
    ws.forEach(([b, w], k) => { J[i * 4 + k] = outIndex.get(b); W[i * 4 + k] = w / tot; });
  }
  // texture: the arms' uv islands (columns separated by unused texels, e.g. the left / right arm)
  // cut out and packed side by side, uvs remapped; `erase` rectangles (source texels [x, y, w, h,
  // dx, dy]) are covered with the texels at (x + dx, y + dy) first (insignia on the sleeves)
  const raw = async (file) => {
    const { data, info } = await (await readImage(file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const [x, y, w, h, dx, dy] of opts.erase ?? []) {
      for (let r = 0; r < h; r++) data.copy(data, ((y + r) * info.width + x) * 3, ((y + dy + r) * info.width + x + dx) * 3, ((y + dy + r) * info.width + x + dx + w) * 3);
    }
    return { data, width: info.width, height: info.height };
  };
  const color = await raw(opts.textures.color);
  const TW = color.width, TH = color.height, margin = 8;
  let v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < n; i++) { v0 = Math.min(v0, UV[i * 2 + 1]); v1 = Math.max(v1, UV[i * 2 + 1]); }
  if (Math.min(...UV) < -0.01 || Math.max(...UV) > 1.01) throw new Error('arm uvs outside [0, 1]');
  const us = [...UV.filter((_, i) => i % 2 === 0)].sort((a, b) => a - b);
  const islands = [[us[0], us[0]]];
  for (const u of us) { const last = islands.at(-1); if ((u - last[1]) * TW > 4 * margin) islands.push([u, u]); else last[1] = u; }
  const top = Math.max(0, Math.floor(v0 * TH) - margin), height = Math.min(TH, Math.ceil(v1 * TH) + margin) - top;
  let width = 0;
  const cols = islands.map(([a, b]) => {
    const left = Math.max(0, Math.floor(a * TW) - margin), w = Math.min(TW, Math.ceil(b * TW) + margin) - left;
    const c = { a, b, left, w, x: width };
    width += w;
    return c;
  });
  for (let i = 0; i < n; i++) {
    const u = UV[i * 2], c = cols.find((col) => u >= col.a && u <= col.b);
    UV[i * 2] = (u * TW - c.left + c.x) / width;
    UV[i * 2 + 1] = (UV[i * 2 + 1] * TH - top) / height;
  }
  const pack = (img) => {
    const out = Buffer.alloc(width * height * 3);
    for (const c of cols) for (let r = 0; r < height; r++) img.data.copy(out, (r * width + c.x) * 3, ((top + r) * img.width + c.left) * 3, ((top + r) * img.width + c.left + c.w) * 3);
    return out;
  };
  const maxSize = opts.maxSize ?? 2048;
  const k = Math.min(1, maxSize / Math.max(width, height));
  const size = { width: Math.round(width * k), height: Math.round(height * k) };
  const q = opts.quality ?? 88;
  const encode = (buf, quality = q) => sharp(buf, { raw: { width, height, channels: 3 } }).resize(size).jpeg({ quality, mozjpeg: true }).toBuffer();
  const colorJpg = await encode(pack(color));
  const nrm = pack(await raw(opts.textures.normal));
  if (opts.flipNormalY) for (let i = 1; i < nrm.length; i += 3) nrm[i] = 255 - nrm[i];
  const normalJpg = await encode(nrm);
  // glTF metallic-roughness: G = roughness (from the specular map), B = metalness (0)
  const [r0, r1] = opts.roughness ?? [0.85, 0.35];
  let rough = null;
  if (opts.textures.specular) {
    const spec = pack(await raw(opts.textures.specular));
    rough = Buffer.alloc(spec.length);
    for (let i = 0; i < spec.length; i += 3) {
      const sp = (spec[i] + spec[i + 1] + spec[i + 2]) / 765;
      rough[i] = 255; rough[i + 1] = Math.round(255 * THREE.MathUtils.clamp(r0 + (r1 - r0) * Math.sqrt(sp), 0, 1)); rough[i + 2] = 0;
    }
  }
  const crop = { top, height, columns: cols.map((c) => [c.left, c.w]) };
  const out = new GLBBuilder();
  const tex = (bytes) => ({ index: out.texture(bytes, 'image/jpeg', { wrap: 33071 }) });
  const material = out.material({
    name: 'arms',
    pbrMetallicRoughness: {
      baseColorTexture: tex(colorJpg), metallicFactor: 0, roughnessFactor: rough ? 1 : r0,
      ...(rough ? { metallicRoughnessTexture: tex(await encode(rough, 85)) } : {}),
    },
    normalTexture: tex(normalJpg),
  });
  const prim = {
    attributes: {
      POSITION: out.accessor(P, 'VEC3', { minmax: true, target: 34962 }),
      NORMAL: out.accessor(N, 'VEC3', { target: 34962 }),
      TEXCOORD_0: out.accessor(UV, 'VEC2', { target: 34962 }),
      JOINTS_0: out.accessor(J, 'VEC4', { target: 34962 }),
      WEIGHTS_0: out.accessor(W, 'VEC4', { target: 34962 }),
    },
    indices: out.accessor(n > 65535 ? new Uint32Array(tris) : new Uint16Array(tris), 'SCALAR', { target: 34963 }),
    material,
  };
  const meshI = out.mesh({ name: 'arms', primitives: [prim] });
  // bones: world rest transforms -> local TRS (unit scale) under a root node
  const nodeOf = new Map();
  const rootI = out.node({ name: 'ViewArms', children: [] }, { root: true });
  const ibm = new Float32Array(order.length * 16);
  const bw = new Map(order.map((b) => [b, toCanon.clone().multiply(new THREE.Matrix4().compose(wp(sk.bones[b]), worldQ(sk.bones[b]), new THREE.Vector3(1, 1, 1)))]));
  order.forEach((b, i) => {
    const bone = sk.bones[b];
    let p = bone.parent, pi = -1;
    while (p && pi < 0) { pi = sk.bones.indexOf(p); if (pi >= 0 && !keep.has(pi)) pi = -1; if (pi < 0) p = p.parent; }
    const local = pi >= 0 ? bw.get(pi).clone().invert().multiply(bw.get(b)) : bw.get(b).clone();
    const t = new THREE.Vector3(), r = new THREE.Quaternion(), s = new THREE.Vector3();
    local.decompose(t, r, s);
    const ni = out.node({ name: rigName[b], translation: t.toArray(), rotation: r.toArray() });
    nodeOf.set(b, ni);
    const parentNode = pi >= 0 ? out.json.nodes[nodeOf.get(pi)] : out.json.nodes[rootI];
    (parentNode.children ??= []).push(ni);
    bw.get(b).clone().invert().toArray(ibm, i * 16);
  });
  const skin = out.skin({ joints: order.map((b) => nodeOf.get(b)), inverseBindMatrices: out.accessor(ibm, 'MAT4'), skeleton: rootI });
  out.json.nodes[rootI].children.push(out.node({ name: 'arms', mesh: meshI, skin }));
  const glb = out.toBuffer();
  return {
    glb, tris: tris.length / 3, verts: n, bones: order.map((b) => rigName[b]),
    texture: { crop, size, color: colorJpg.length, normal: normalJpg.length },
  };
}
