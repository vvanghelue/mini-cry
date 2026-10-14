// Realistic NPC bodies from rigged avatars (Microsoft Rocketbox Avatar Library, MIT: 3ds Max Biped
// rig, photo textures; FBX converted to glTF by FBX2glTF before this runs):
//   - the parts (body, head, helmet, equipment… one per material) merged into ONE skinned mesh
//   - the Biped skeleton replaced by the rig src/engine/anim/Characters.js retargets the UAL clips
//     onto (bone names of the Quaternius characters: Body, Hips, Abdomen… Wrist.L, Index2.L…),
//     every bone at rest with the identity rotation (only offsets): avatars built here share the
//     same rest frame, so the clips retargeted once at load play on all of them
//   - the textures of every part cropped to the part's uv rectangle, scaled (texel density per
//     part), packed into one atlas (colour, normal, roughness from the specular map); `erase`
//     covers insignia with nearby texels, `recolor` maps the low-saturation texels (camouflage,
//     fabric) of some parts through a colour ramp (e.g. grey ACU camo -> jungle greens)
//   - distance LODs: simplified index ranges (meshoptimizer) after the full one, sharing the
//     vertices (mesh extras `lods`: start, count, distance)
//   - compact vertex data (KHR_mesh_quantization: int8 normals, uint16 uvs, uint8 joints / weights)
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import sharp from 'sharp';
import { loadGLTF, stripTextures, GLBBuilder } from './glb.js';
import { decodeTGA } from './tga.js';

export const RIG_VERSION = 'mc-human-1';
const FINGERS = { 0: 'Thumb', 1: 'Index', 2: 'Middle', 3: 'Ring', 4: 'Pinky' };

/** Output rig: [name, parent, Biped bone (name without the Bip01 prefix, side as L / R)]. */
function rigBones() {
  const out = [
    ['Root', null, null], ['Body', 'Root', 'Pelvis'], ['Hips', 'Body', null], ['Abdomen', 'Hips', 'Spine'],
    ['Torso', 'Abdomen', 'Spine1'], ['Chest', 'Torso', 'Spine2'], ['Neck', 'Chest', 'Neck'], ['Head', 'Neck', 'Head'],
  ];
  for (const s of ['L', 'R']) {
    out.push([`Shoulder.${s}`, 'Chest', `${s}_Clavicle`], [`UpperArm.${s}`, `Shoulder.${s}`, `${s}_UpperArm`],
      [`LowerArm.${s}`, `UpperArm.${s}`, `${s}_Forearm`], [`Wrist.${s}`, `LowerArm.${s}`, `${s}_Hand`]);
    for (const [f, name] of Object.entries(FINGERS)) {
      // Biped Finger<f>, Finger<f>1, Finger<f>2 = the three phalanges; the rig numbers the thumb
      // 1-3 and the other fingers 2-4 (1 = the metacarpal, which Biped doesn't have)
      const first = f === '0' ? 1 : 2;
      for (let k = 0; k < 3; k++) out.push([`${name}${first + k}.${s}`, k ? `${name}${first + k - 1}.${s}` : `Wrist.${s}`, `${s}_Finger${f}${k ? k : ''}`]);
    }
    out.push([`UpperLeg.${s}`, 'Body', `${s}_Thigh`], [`LowerLeg.${s}`, `UpperLeg.${s}`, `${s}_Calf`], [`Foot.${s}`, `LowerLeg.${s}`, `${s}_Foot`]);
  }
  return out;
}

/** Biped node name -> its short name ("Bip01_L_Thigh" / "Bip01 L Thigh" -> "L_Thigh"), or null. */
const bipedName = (n) => {
  const m = /^Bip\d+[_ ]?(.*)$/.exec(n);
  return m ? m[1].replace(/[ ]/g, '_') : null;
};

async function readImage(file) {
  if (/\.tga$/i.test(file)) {
    const t = decodeTGA(fs.readFileSync(file));
    return { data: t.data, width: t.width, height: t.height, channels: 4 };
  }
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

/**
 * Bones in the bind pose. Skeleton.pose() assumes the mesh is bound at its world transform and
 * decomposes a root bone's world matrix as its local one: both wrong for FBX2glTF exports (mesh
 * node rotated Z-up -> Y-up, bones under a transformed non-bone Bip01 node). The bind world of a
 * bone is meshWorld x bindMatrix^-1 x boneInverse^-1; locals come from the parents' worlds.
 */
function bindPose(mesh, scene) {
  scene.updateMatrixWorld(true);
  const sk = mesh.skeleton;
  const toWorld = mesh.matrixWorld.clone().multiply(mesh.bindMatrix.clone().invert());
  const world = sk.boneInverses.map((m) => toWorld.clone().multiply(m.clone().invert()));
  const depth = (b) => { let d = 0; for (let p = b.parent; p; p = p.parent) d++; return d; };
  const order = sk.bones.map((b, i) => i).sort((a, b) => depth(sk.bones[a]) - depth(sk.bones[b]));
  for (const i of order) {
    const b = sk.bones[i];
    const local = b.parent.matrixWorld.clone().invert().multiply(world[i]);
    local.decompose(b.position, b.quaternion, b.scale);
    b.updateMatrixWorld(true);
  }
  scene.updateMatrixWorld(true);
}

/** '#rrggbb' -> [r, g, b] 0-255 sRGB (the texels' space; THREE.Color would convert to linear). */
const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/**
 * Camouflage / fabric recolour of an RGBA image in place: texels below the saturation threshold
 * take the colour of the ramp at their brightness (brightness range [lo, hi] -> the palette stops),
 * saturated texels (skin, patches, buttons) are kept. `strength` mixes with the original; `rects`
 * ([[x, y, w, h]] texels) limits it to some areas (e.g. the cap in a head texture, not the eyes).
 */
function recolor(img, { palette, range = [0.15, 0.8], saturation = [0.16, 0.32], strength = 1 }, rects) {
  const stops = palette.map(hexRGB), n = stops.length - 1;
  const [lo, hi] = range, [s0, s1] = saturation, d = img.data;
  const inside = rects ? (i) => { const x = (i / 4) % img.width, y = Math.floor(i / 4 / img.width); return rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh); } : null;
  for (let i = 0; i < d.length; i += 4) {
    if (inside && !inside(i)) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = (mx - mn) / Math.max(mx, 96); // dark texels: chroma, not the noisy ratio
    const w = strength * (1 - THREE.MathUtils.smoothstep(sat, s0, s1));
    if (w <= 0) continue;
    const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const t = THREE.MathUtils.clamp((L - lo) / (hi - lo), 0, 1) * n;
    const k = Math.min(n - 1, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] * (1 - w) + (stops[k][c] * (1 - f) + stops[k + 1][c] * f) * w);
  }
}

/** Cover rectangles [x, y, w, h, dx, dy] (texels) with the texels at (x + dx, y + dy). */
function erase(img, rects) {
  const { data, width, channels: ch } = img;
  for (const [x, y, w, h, dx, dy] of rects ?? []) {
    for (let r = 0; r < h; r++) data.copy(data, ((y + r) * width + x) * ch, ((y + dy + r) * width + x + dx) * ch, ((y + dy + r) * width + x + dx + w) * ch);
  }
}

/** Skyline bottom-left packing of { w, h } rectangles (sorted by height) into a strip of `width`. */
function pack(rects, width) {
  const sky = [{ x: 0, w: width, y: 0 }];
  for (const r of [...rects].sort((a, b) => b.h - a.h || b.w - a.w)) {
    let best = null;
    for (let i = 0; i < sky.length; i++) {
      if (sky[i].x + r.w > width) break;
      let y = 0, span = 0;
      for (let j = i; j < sky.length && span < r.w; j++) { y = Math.max(y, sky[j].y); span = sky[j].x + sky[j].w - sky[i].x; }
      if (span < r.w) continue;
      if (!best || y < best.y) best = { x: sky[i].x, y };
    }
    if (!best) throw new Error(`atlas: ${r.w}x${r.h} does not fit in width ${width}`);
    r.x = best.x; r.y = best.y;
    // new skyline: cut the covered segments, insert this rectangle's top
    const top = { x: r.x, w: r.w, y: r.y + r.h };
    const next = [];
    for (const s of sky) {
      const a = s.x, b = s.x + s.w;
      if (b <= r.x || a >= r.x + r.w) { next.push(s); continue; }
      if (a < r.x) next.push({ x: a, w: r.x - a, y: s.y });
      if (b > r.x + r.w) next.push({ x: r.x + r.w, w: b - r.x - r.w, y: s.y });
    }
    next.push(top);
    next.sort((p, q) => p.x - q.x);
    sky.length = 0;
    for (const s of next) { const last = sky.at(-1); if (last && last.y === s.y && last.x + last.w === s.x) last.w += s.w; else sky.push(s); }
  }
  return Math.max(...rects.map((r) => r.y + r.h));
}

/**
 * opts: glb (converted avatar), textures { <material name>: { color, normal, specular } } (files),
 * drop (material name regexp: parts left out), scale ({ <part>: texel scale, default }),
 * recolor ({ parts: regexp, palette, range, saturation, strength, regions: { <part>: [[x, y, w, h]] } }), erase ({ <part>: [[x, y, w, h,
 * dx, dy]] } in source texels; applied to colour, normal and specular), roughness [at spec 0, at
 * spec 1], quality (jpeg), atlasWidth, lods ([{ ratio, error, distance }]: triangle ratio, max error
 * (fraction of the size), camera distance from which it is drawn), label.
 * Returns { glb, info }.
 */
export async function buildCharacter(opts) {
  const src = loadGLTF(opts.glb);
  const buf = stripTextures(src);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const drop = opts.drop ? new RegExp(opts.drop, 'i') : null;
  const meshes = [];
  scene.traverse((o) => { if (o.isSkinnedMesh && !(drop && drop.test(o.material.name))) meshes.push(o); });
  if (!meshes.length) throw new Error('no skinned mesh');
  const sk = meshes[0].skeleton;
  bindPose(meshes[0], scene);

  // --- skeleton: Biped joints -> rig bones (rest positions, identity rotations) -------------------
  const byBiped = new Map();
  for (const b of sk.bones) { const n = bipedName(b.name); if (n) byBiped.set(n, b); }
  const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const RIG = rigBones();
  const need = (n) => { const b = byBiped.get(n); if (!b) throw new Error(`Biped bone ${n} missing (has: ${[...byBiped.keys()].join(', ')})`); return b; };
  // canonical frame: the left shoulder toward +X, up +Y, facing +Z, the pelvis above the origin
  const shL = wp(need('L_UpperArm')), shR = wp(need('R_UpperArm'));
  const left = shL.clone().sub(shR).setY(0).normalize(), up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3().crossVectors(left, up);
  const pelvis = wp(need('Pelvis'));
  const toCanon = new THREE.Matrix4().makeBasis(left, up, fwd).transpose().multiply(new THREE.Matrix4().makeTranslation(-pelvis.x, 0, -pelvis.z));
  const rotCanon = new THREE.Matrix3().setFromMatrix4(toCanon);
  const rigPos = new Map(), rigIndex = new Map();
  RIG.forEach(([name, , biped], i) => {
    rigIndex.set(name, i);
    if (biped) rigPos.set(name, wp(need(biped)).applyMatrix4(toCanon));
  });
  rigPos.set('Root', new THREE.Vector3());
  rigPos.set('Hips', rigPos.get('Body').clone());
  // source bone -> rig bone (Biped bones the rig doesn't have: the nearest mapped ancestor;
  // the pelvis skin goes to Hips, which follows Body)
  const srcToRig = sk.bones.map((b) => {
    for (let p = b; p; p = p.parent) {
      const n = bipedName(p.name);
      if (n === 'Pelvis') return rigIndex.get('Hips');
      const hit = RIG.find((r) => r[2] && r[2] === n);
      if (hit) return rigIndex.get(hit[0]);
    }
    return rigIndex.get('Hips');
  });

  // --- geometry: merged parts, canonical rest positions ------------------------------------------
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.geometry.attributes.position.count; ni += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count; }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2);
  const J = new Uint8Array(nv * 4), W = new Float32Array(nv * 4);
  const index = new Uint32Array(ni);
  const parts = [];
  const v3 = new THREE.Vector3(), nm = new THREE.Matrix3();
  let vo = 0, io = 0;
  for (const m of meshes) {
    const g = m.geometry, n = g.attributes.position.count;
    const name = m.material.name.replace(/^[a-z]+\d+_/i, ''); // "sm002_body" -> "body"
    parts.push({ name, material: m.material.name, start: vo, count: n, uv: [Infinity, Infinity, -Infinity, -Infinity] });
    const part = parts.at(-1);
    nm.getNormalMatrix(m.matrixWorld).premultiply(rotCanon);
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, uv = g.attributes.uv;
    for (let i = 0; i < n; i++) {
      const o = vo + i;
      m.getVertexPosition(i, v3);
      m.localToWorld(v3).applyMatrix4(toCanon).toArray(P, o * 3);
      v3.fromBufferAttribute(g.attributes.normal, i).applyMatrix3(nm).normalize().toArray(N, o * 3);
      const u = uv.getX(i), v = uv.getY(i);
      UV[o * 2] = u; UV[o * 2 + 1] = v;
      part.uv[0] = Math.min(part.uv[0], u); part.uv[1] = Math.min(part.uv[1], v); part.uv[2] = Math.max(part.uv[2], u); part.uv[3] = Math.max(part.uv[3], v);
      const acc = new Map();
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > 0) { const b = srcToRig[si.getComponent(i, k)]; acc.set(b, (acc.get(b) ?? 0) + w); }
      }
      // 4 strongest, quantized to 1/255 summing to exactly 255
      const ws = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const tot = ws.reduce((s, x) => s + x[1], 0) || 1;
      let left255 = 255;
      ws.forEach(([b, w], k) => {
        const q = k === ws.length - 1 ? left255 : Math.round((w / tot) * 255);
        left255 -= q;
        J[o * 4 + k] = b; W[o * 4 + k] = q;
      });
    }
    const idx = g.index;
    const cnt = idx ? idx.count : n;
    // a mirrored mesh transform flips the winding
    const flip = m.matrixWorld.determinant() < 0;
    for (let k = 0; k < cnt; k += 3) {
      const a = idx ? idx.getX(k) : k, b = idx ? idx.getX(k + 1) : k + 1, c = idx ? idx.getX(k + 2) : k + 2;
      index[io++] = vo + a; index[io++] = vo + (flip ? c : b); index[io++] = vo + (flip ? b : c);
    }
    vo += n;
  }

  // --- LODs: simplified copies of the index buffer (same vertices; attribute seams kept, open
  // borders such as the neck between the head and body parts locked: no cracks) --------------------
  const { MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptSimplifier.ready;
  const lods = [{ start: 0, count: index.length, distance: 0 }];
  const lodIndex = [index];
  let at = index.length;
  for (const l of opts.lods ?? []) {
    const target = Math.floor((index.length * l.ratio) / 3) * 3;
    const [ix] = MeshoptSimplifier.simplify(index, P, 3, target, l.error ?? 0.02, ['LockBorder']);
    lods.push({ start: at, count: ix.length, distance: l.distance });
    lodIndex.push(ix);
    at += ix.length;
  }
  const allIndex = new Uint32Array(at);
  lodIndex.reduce((o, ix) => (allIndex.set(ix, o), o + ix.length), 0);

  // --- textures: per part crop -> scale -> atlas --------------------------------------------------
  const scaleOf = (p) => opts.scale?.[p.name] ?? opts.scale?.default ?? 0.375;
  const margin = 6; // source texels kept around the uv rectangle (mip bleeding)
  const recolorRe = opts.recolor?.parts ? new RegExp(opts.recolor.parts, 'i') : null;
  const slots = [];
  for (const p of parts) {
    const files = opts.textures[p.material];
    if (!files?.color) throw new Error(`no textures for material ${p.material}`);
    const color = await readImage(files.color);
    const TW = color.width, TH = color.height;
    const x0 = Math.max(0, Math.floor(p.uv[0] * TW) - margin), y0 = Math.max(0, Math.floor(p.uv[1] * TH) - margin);
    const x1 = Math.min(TW, Math.ceil(p.uv[2] * TW) + margin), y1 = Math.min(TH, Math.ceil(p.uv[3] * TH) + margin);
    const s = scaleOf(p);
    slots.push({ p, files, color, TW, TH, crop: { left: x0, top: y0, width: x1 - x0, height: y1 - y0 }, w: Math.max(8, Math.round((x1 - x0) * s)), h: Math.max(8, Math.round((y1 - y0) * s)) });
  }
  // atlas width: the one (step 32) giving the smallest packed area
  let AW = opts.atlasWidth;
  if (!AW) {
    let best = Infinity;
    const minW = Math.max(...slots.map((s) => s.w)), maxW = slots.reduce((a, s) => a + s.w, 0);
    for (let w = Math.ceil(minW / 32) * 32; w <= maxW + 31; w += 32) {
      const area = w * pack(slots, w);
      if (area < best - 1) { best = area; AW = w; }
    }
  }
  const AH = Math.ceil(pack(slots, AW) / 4) * 4;
  const layers = { color: Buffer.alloc(AW * AH * 3), normal: Buffer.alloc(AW * AH * 3), rough: Buffer.alloc(AW * AH * 3) };
  layers.normal.fill(128);
  for (let i = 2; i < layers.normal.length; i += 3) layers.normal[i] = 255;
  const [r0, r1] = opts.roughness ?? [0.9, 0.4];
  layers.rough.fill(Math.round(r0 * 255));
  for (const s of slots) {
    const rects = opts.erase?.[s.p.name];
    const place = async (img, layer, fn) => {
      if (rects) erase(img, rects);
      fn?.(img);
      const scaled = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } })
        .extract(s.crop).resize(s.w, s.h, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
      for (let r = 0; r < s.h; r++) scaled.copy(layers[layer], ((s.y + r) * AW + s.x) * 3, r * s.w * 3, (r + 1) * s.w * 3);
    };
    await place(s.color, 'color', recolorRe?.test(s.p.name) ? (img) => recolor(img, opts.recolor, opts.recolor.regions?.[s.p.name]) : null);
    const sized = async (file) => {
      const img = await readImage(file);
      if (img.width === s.TW && img.height === s.TH) return img;
      const data = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).resize(s.TW, s.TH, { fit: 'fill' }).raw().toBuffer();
      return { data, width: s.TW, height: s.TH, channels: 4 };
    };
    if (s.files.normal) await place(await sized(s.files.normal), 'normal');
    if (s.files.specular) {
      await place(await sized(s.files.specular), 'rough', (img) => {
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const sp = (d[i] + d[i + 1] + d[i + 2]) / 765;
          d[i] = d[i + 1] = d[i + 2] = Math.round(255 * THREE.MathUtils.clamp(r0 + (r1 - r0) * Math.sqrt(sp), 0, 1));
        }
      });
    }
    // part uvs -> atlas
    const { left, top, width, height } = s.crop;
    for (let i = s.p.start; i < s.p.start + s.p.count; i++) {
      UV[i * 2] = (s.x + ((UV[i * 2] * s.TW - left) / width) * s.w) / AW;
      UV[i * 2 + 1] = (s.y + ((UV[i * 2 + 1] * s.TH - top) / height) * s.h) / AH;
    }
  }
  const q = opts.quality ?? 86;
  const enc = (layer, k, quality = q) => sharp(layers[layer], { raw: { width: AW, height: AH, channels: 3 } })
    .resize(Math.round(AW * k), Math.round(AH * k)).jpeg({ quality, mozjpeg: true, chromaSubsampling: layer === 'color' ? '4:2:0' : '4:4:4' }).toBuffer();
  const colorJpg = await enc('color', 1);
  const normalJpg = await enc('normal', opts.normalScale ?? 0.5, 92);
  const roughJpg = await enc('rough', opts.roughScale ?? 0.25, 90);

  // --- rig: rest positions, local offsets, inverse bind matrices ---------------------------------
  const top = (() => { let y = -Infinity; for (let i = 1; i < P.length; i += 3) y = Math.max(y, P[i]); return y; })();
  const bottom = (() => { let y = Infinity; for (let i = 1; i < P.length; i += 3) y = Math.min(y, P[i]); return y; })();
  // weapon grip (where a held object's origin goes) in wrist space: between the wrist and the
  // middle finger's first joint, a little toward the palm
  const grip = {};
  for (const s of ['L', 'R']) {
    const wr = rigPos.get(`Wrist.${s}`), mid = rigPos.get(`Middle2.${s}`), ix = rigPos.get(`Index2.${s}`), pk = rigPos.get(`Pinky2.${s}`);
    const along = mid.clone().sub(wr), across = pk.clone().sub(ix);
    const palm = new THREE.Vector3().crossVectors(along, across).normalize().multiplyScalar(s === 'L' ? 1 : -1);
    grip[s] = wr.clone().addScaledVector(along, 0.55).addScaledVector(palm, 0.02).sub(wr).toArray().map((v) => +v.toFixed(4));
  }

  // --- GLB -----------------------------------------------------------------------------------------
  const out = new GLBBuilder();
  out.json.extensionsUsed = ['KHR_mesh_quantization'];
  out.json.extensionsRequired = ['KHR_mesh_quantization'];
  const tex = (bytes) => ({ index: out.texture(bytes, 'image/jpeg', { wrap: 33071 }) });
  const material = out.material({
    name: 'character',
    pbrMetallicRoughness: { baseColorTexture: tex(colorJpg), metallicFactor: 0, roughnessFactor: 1, metallicRoughnessTexture: tex(roughJpg) },
    normalTexture: tex(normalJpg),
  });
  const N8 = new Int8Array(nv * 4), UV16 = new Uint16Array(nv * 2), W8 = new Uint8Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    for (let c = 0; c < 3; c++) N8[i * 4 + c] = Math.round(THREE.MathUtils.clamp(N[i * 3 + c], -1, 1) * 127);
    for (let c = 0; c < 2; c++) UV16[i * 2 + c] = Math.round(THREE.MathUtils.clamp(UV[i * 2 + c], 0, 1) * 65535);
    for (let c = 0; c < 4; c++) W8[i * 4 + c] = W[i * 4 + c];
  }
  const prim = {
    attributes: {
      POSITION: out.accessor(P, 'VEC3', { minmax: true, target: 34962 }),
      NORMAL: out.accessor(N8, 'VEC3', { normalized: true, target: 34962, byteStride: 4 }),
      TEXCOORD_0: out.accessor(UV16, 'VEC2', { normalized: true, target: 34962 }),
      JOINTS_0: out.accessor(J, 'VEC4', { target: 34962 }),
      WEIGHTS_0: out.accessor(W8, 'VEC4', { normalized: true, target: 34962 }),
    },
    indices: out.accessor(nv > 65535 ? allIndex : Uint16Array.from(allIndex), 'SCALAR', { target: 34963 }),
    material,
  };
  const partsOut = parts.map(({ name, start, count }) => ({ name, start, count }));
  const meshI = out.mesh({ name: 'character', primitives: [prim], extras: { parts: partsOut, lods } });
  const rootI = out.node({ name: opts.label ?? 'Character', children: [] }, { root: true });
  const nodeOf = new Map();
  RIG.forEach(([name, parent]) => {
    const p = rigPos.get(name), pp = parent ? rigPos.get(parent) : new THREE.Vector3();
    const ni = out.node({ name, translation: p.clone().sub(pp).toArray().map((v) => +v.toFixed(5)) });
    nodeOf.set(name, ni);
    (parent ? out.json.nodes[nodeOf.get(parent)] : out.json.nodes[rootI]).children ??= [];
    (parent ? out.json.nodes[nodeOf.get(parent)] : out.json.nodes[rootI]).children.push(ni);
  });
  const ibm = new Float32Array(RIG.length * 16);
  RIG.forEach(([name], i) => new THREE.Matrix4().makeTranslation(rigPos.get(name).clone().negate()).toArray(ibm, i * 16));
  const skin = out.skin({ joints: RIG.map(([n]) => nodeOf.get(n)), inverseBindMatrices: out.accessor(ibm, 'MAT4'), skeleton: nodeOf.get('Root') });
  out.json.nodes[rootI].children.push(out.node({ name: 'character', mesh: meshI, skin }));
  out.json.scenes[0].extras = { rig: RIG_VERSION, height: +(top - bottom).toFixed(3), grip };
  const glb = out.toBuffer();
  return {
    glb,
    info: {
      tris: lods.map((l) => l.count / 3), verts: nv, bones: RIG.length, height: +(top - bottom).toFixed(3),
      parts: Object.fromEntries(parts.map((p) => [p.name, p.count])),
      atlas: `${AW}x${AH}`, bytes: { color: colorJpg.length, normal: normalJpg.length, roughness: roughJpg.length, total: glb.length },
    },
  };
}
