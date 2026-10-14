// Rigged characters — two kinds of models share the code below:
//   * realistic bodies (public/models/characters/*.glb, built by `mc character build` from the
//     Rocketbox avatars of data/characters.json: one skinned mesh, photo texture atlas, the game
//     rig with identity rest rotations, scene extras { rig, grip }): PBR material with their own
//     colour / normal / roughness maps + the lighting patch; part ranges for palette tints
//   * flat-coloured Quaternius GLBs (public/models/*.glb) — ported from three-rigged-game/src/main.js:
//   - the 10–15 skinned parts of a character are merged into ONE skinned mesh (1 draw call,
//     1 bone texture), part colours baked into vertex colours, the shared textured PBR material
//     (clothes in a woven fabric layer, uvs boxed from the bind pose)
//   - smooth normals rebuilt (the exports are flat-split) with a crease angle
//   - the Universal Animation Library clips (ual_base.glb: crouch, sprint, pistol aim, swim,
//     driving...) are retargeted once at load onto the character rig and shared by all
//   - derived clips: additive aim up/down offsets, crouch + aim, jump + aim
//   - capsule hitboxes following the animated skeleton (head / body / limbs) + ray test
//   - skeletons update once per frame (not once per render pass: shadows render them again)
import * as THREE from 'three';
import { surfaceInfo } from '../assets/surfaces.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LAYERS } from '../render/layers.js';
import { Data } from '../core/Data.js';

export const CHAR_HEIGHT = 1.8;
const BASE = (import.meta.env?.BASE_URL ?? '/') + 'models/';
/** Rig of the realistic bodies (tools/lib/import-character.js RIG_VERSION). */
const REALISTIC_RIG = 'mc-human-1';
/** Clip names the game asks for (the Quaternius pack's) -> the UAL clips realistic bodies play. */
const REALISTIC_ALIASES = {
  Idle: 'Idle_Loop', Idle_Gun: 'Idle_Rifle', Walk: 'Walk_Loop', Run: 'Jog_Fwd_Loop', Run_Shoot: 'Jog_Aim',
  HitRecieve: 'Hit_Chest', HitRecieve_2: 'Hit_Head', Death: 'Death01',
};

// ---------------------------------------------------------------------------------------------
// Mesh preparation
const CREASE = THREE.MathUtils.degToRad(80);
function smoothGeometryNormals(geo, creaseAngle) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const index = geo.index ? geo.index.array : Array.from({ length: n }, (_, i) => i);
  if (!geo.boundingBox) geo.computeBoundingBox();
  const tol = geo.boundingBox.getSize(new THREE.Vector3()).length() * 1e-4 || 1e-9;
  const ids = new Int32Array(n), keys = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) / tol)},${Math.round(pos.getY(i) / tol)},${Math.round(pos.getZ(i) / tol)}`;
    let id = keys.get(k);
    if (id === undefined) keys.set(k, (id = keys.size));
    ids[i] = id;
  }
  const faceCount = index.length / 3;
  const fN = new Float32Array(faceCount * 3), fU = new Float32Array(faceCount * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const facesAtPos = Array.from({ length: keys.size }, () => []);
  const own = new Float32Array(n * 3);
  for (let f = 0; f < faceCount; f++) {
    const i0 = index[3 * f], i1 = index[3 * f + 1], i2 = index[3 * f + 2];
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    c.sub(b); a.sub(b); c.cross(a);
    fN.set([c.x, c.y, c.z], 3 * f);
    c.normalize();
    fU.set([c.x, c.y, c.z], 3 * f);
    for (const v of [i0, i1, i2]) { facesAtPos[ids[v]].push(f); own[3 * v] += c.x; own[3 * v + 1] += c.y; own[3 * v + 2] += c.z; }
  }
  const creaseDot = Math.cos(creaseAngle);
  const out = new Float32Array(n * 3), ref = new THREE.Vector3(), acc = new THREE.Vector3();
  for (let v = 0; v < n; v++) {
    ref.fromArray(own, 3 * v).normalize();
    acc.set(0, 0, 0);
    for (const f of facesAtPos[ids[v]]) {
      if (ref.x * fU[3 * f] + ref.y * fU[3 * f + 1] + ref.z * fU[3 * f + 2] >= creaseDot) { acc.x += fN[3 * f]; acc.y += fN[3 * f + 1]; acc.z += fN[3 * f + 2]; }
    }
    if (acc.lengthSq() === 0) acc.copy(ref);
    acc.normalize().toArray(out, 3 * v);
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
}

// texture repeats per model unit (the models are ~1.8 units tall): a fabric weave of ~2 cm
const CHAR_UV = 3.5;

/** Surface layer of a character part from its material name. */
function characterSurface(name = '') {
  if (/skin|eye|hair|brow|joint/i.test(name)) return 'plain';
  if (/gold|earring|metal|buckle/i.test(name)) return 'metal_smooth';
  return 'fabric';
}

/** Merge all skinned parts into one skinned mesh with vertex colours (see file header). */
function mergeCharacterMeshes(root, lighting) {
  const parts = [];
  root.traverse((o) => { if (o.isSkinnedMesh) parts.push(o); });
  if (!parts.length) return null;
  const base = parts[0], sk = base.skeleton;
  if (parts.some((m) => m.skeleton.bones.length !== sk.bones.length || m.skeleton.bones.some((b, i) => b !== sk.bones[i]))) {
    console.warn(`${root.name}: parts use different bones, not merged`);
    return null;
  }
  let n = 0, nIdx = 0;
  for (const m of parts) { n += m.geometry.attributes.position.count; nIdx += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const index = n > 65535 ? new Uint32Array(nIdx) : new Uint16Array(nIdx);
  const baseBindInv = base.bindMatrix.clone().invert();
  const v = new THREE.Vector3(), c = new THREE.Color();
  let vo = 0, io = 0;
  const ranges = []; // per source part: { name: material name, start, count } (palette swaps)
  for (const m of parts) {
    ranges.push({ name: m.material.name, start: vo, count: m.geometry.attributes.position.count });
    const g = m.geometry, P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color;
    const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, mat = m.material;
    const xf = new Map();
    const toBase = (bi) => {
      let t = xf.get(bi);
      if (!t) {
        const M = sk.boneInverses[bi].clone().invert().premultiply(baseBindInv).multiply(m.skeleton.boneInverses[bi]).multiply(m.bindMatrix);
        xf.set(bi, (t = [M, new THREE.Matrix3().getNormalMatrix(M)]));
      }
      return t;
    };
    let flip = false;
    const tint = 1;
    for (let i = 0; i < P.count; i++) {
      const o = vo + i;
      let main = 0, best = -1;
      for (let k = 0; k < 4; k++) {
        const w = SW.getComponent(i, k), bi = SI.getComponent(i, k);
        si[o * 4 + k] = bi; sw[o * 4 + k] = w;
        if (w > best) { best = w; main = bi; }
      }
      const [M, NM] = toBase(main);
      if (i === 0) flip = M.determinant() < 0;
      v.fromBufferAttribute(P, i).applyMatrix4(M).toArray(pos, o * 3);
      v.fromBufferAttribute(N, i).applyMatrix3(NM).normalize().toArray(nor, o * 3);
      c.copy(mat.color).multiplyScalar(tint);
      if (C) { c.r *= C.getX(i); c.g *= C.getY(i); c.b *= C.getZ(i); }
      col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b;
    }
    const idx = g.index;
    const count = idx ? idx.count : P.count;
    for (let k = 0; k < count; k += 3) {
      const a = idx ? idx.getX(k) : k, b = idx ? idx.getX(k + 1) : k + 1, d = idx ? idx.getX(k + 2) : k + 2;
      index[io++] = vo + a; index[io++] = vo + (flip ? d : b); index[io++] = vo + (flip ? b : d);
    }
    vo += P.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // textured surfaces (render/Surfaces.js): clothes get a woven fabric, metal bits a smooth metal,
  // skin / hair / eyes stay plain; tiling uvs boxed from the bind pose (no texture atlas needed)
  const uv = new Float32Array(n * 2), surf = new Float32Array(n);
  for (const r of ranges) {
    const id = surfaceInfo(characterSurface(r.name)).id;
    for (let i = r.start; i < r.start + r.count; i++) {
      surf[i] = id;
      const ax = Math.abs(nor[i * 3]), ay = Math.abs(nor[i * 3 + 1]), az = Math.abs(nor[i * 3 + 2]);
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const [u, w] = ax >= ay && ax >= az ? [z, y] : ay >= az ? [x, z] : [x, y];
      uv[i * 2] = u * CHAR_UV; uv[i * 2 + 1] = -w * CHAR_UV;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('surface', new THREE.BufferAttribute(surf, 1));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.userData.parts = ranges;
  const mat = lighting.material({ textured: true });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.name = `${root.name || 'Character'}_Merged`;
  mesh.position.copy(base.position);
  mesh.quaternion.copy(base.quaternion);
  mesh.scale.copy(base.scale);
  base.parent.add(mesh);
  mesh.bind(sk, base.bindMatrix);
  for (const m of parts) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); }
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// UAL retargeting (Rigify DEF skeleton facing -Z -> Quaternius CharacterArmature / the realistic
// bodies' rig, facing +Z)
export const UAL_CLIPS = [
  'Idle_Loop', 'Sword_Idle',
  'Jump_Start', 'Jump_Loop', 'Jump_Land', 'Sprint_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop',
  'Pistol_Idle_Loop', 'Pistol_Aim_Neutral', 'Pistol_Aim_Up', 'Pistol_Aim_Down', 'Pistol_Shoot', 'Pistol_Reload',
  'Swim_Fwd_Loop', 'Swim_Idle_Loop', 'Driving_Loop', 'Idle_Talking_Loop', 'Sitting_Idle_Loop', 'Interact',
  'Hit_Chest', 'Hit_Head', 'Death01', 'Walk_Loop', 'Jog_Fwd_Loop', 'Idle_Torch_Loop', 'Fixing_Kneeling', 'Dance_Loop', 'Roll', 'PickUp_Table',
];
const UAL_MAP = { Body: 'DEF-hips', Abdomen: 'DEF-spine.001', Torso: 'DEF-spine.002', Chest: 'DEF-spine.003', Neck: 'DEF-neck', Head: 'DEF-head' };
for (const s of ['L', 'R']) {
  Object.assign(UAL_MAP, {
    [`Shoulder.${s}`]: `DEF-shoulder.${s}`, [`UpperArm.${s}`]: `DEF-upper_arm.${s}`,
    [`LowerArm.${s}`]: `DEF-forearm.${s}`, [`Wrist.${s}`]: `DEF-hand.${s}`,
    [`UpperLeg.${s}`]: `DEF-thigh.${s}`, [`LowerLeg.${s}`]: `DEF-shin.${s}`, [`Foot.${s}`]: `DEF-foot.${s}`,
  });
  for (const [t, f] of [['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Pinky', 'pinky']])
    for (let i = 1; i <= 3; i++) UAL_MAP[`${t}${i + 1}.${s}`] = `DEF-f_${f}.0${i}.${s}`;
  for (let i = 1; i <= 3; i++) UAL_MAP[`Thumb${i}.${s}`] = `DEF-thumb.0${i}.${s}`;
}
const UAL_ALIGN = [];
for (const s of ['L', 'R']) {
  UAL_ALIGN.push(
    [`UpperArm.${s}`, `LowerArm.${s}`, `DEF-forearm.${s}`], [`LowerArm.${s}`, `Wrist.${s}`, `DEF-hand.${s}`],
    [`Wrist.${s}`, `Middle2.${s}`, `DEF-f_middle.01.${s}`], [`UpperLeg.${s}`, `LowerLeg.${s}`, `DEF-shin.${s}`],
    [`LowerLeg.${s}`, `Foot.${s}`, `DEF-foot.${s}`], [`Thumb1.${s}`, `Thumb2.${s}`, `DEF-thumb.02.${s}`],
    [`Thumb2.${s}`, `Thumb3.${s}`, `DEF-thumb.03.${s}`],
  );
  for (const [t, f] of [['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Pinky', 'pinky']])
    for (let i = 2; i <= 3; i++) UAL_ALIGN.push([`${t}${i}.${s}`, `${t}${i + 1}.${s}`, `DEF-f_${f}.0${i}.${s}`]);
}

function retargetClips(srcGltf, tgtScene, clipNames, fps = 30) {
  const san = THREE.PropertyBinding.sanitizeNodeName;
  const skinned = (root) => { let sk = null; root.traverse((o) => { if (!sk && o.isSkinnedMesh) sk = o.skeleton; }); return sk; };
  const src = srcGltf.scene;
  const tgt = SkeletonUtils.clone(tgtScene);
  const srcSk = skinned(src), tgtSk = skinned(tgt);
  srcSk.pose(); tgtSk.pose();
  src.updateMatrixWorld(true); tgt.updateMatrixWorld(true);
  const sBone = (n) => srcSk.bones.find((b) => b.name === san(n));
  const tBone = (n) => tgtSk.bones.find((b) => b.name === san(n));
  const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion());
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  const side = (L, R) => wp(L).sub(wp(R)).setY(0);
  const sSide = side(sBone('DEF-upper_arm.L'), sBone('DEF-upper_arm.R'));
  const tSide = side(tBone('UpperArm.L'), tBone('UpperArm.R'));
  const yaw = Math.atan2(sSide.z, sSide.x) - Math.atan2(tSide.z, tSide.x);
  const Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const Yi = Y.clone().invert();
  const bones = tgtSk.bones;
  const info = new Map();
  for (const b of bones) {
    const srcName = Object.keys(UAL_MAP).find((k) => san(k) === b.name);
    info.set(b, { src: srcName ? sBone(UAL_MAP[srcName]) : null, bindLocal: b.quaternion.clone(), bindWorld: wq(b), world: new THREE.Quaternion(), values: [] });
  }
  for (const b of bones) { const i = info.get(b); if (i.src) i.srcBindInv = wq(i.src).invert(); }
  for (const [t, tc, sc] of UAL_ALIGN) {
    const b = tBone(t), i = info.get(b);
    if (!b || !i?.src || !tBone(tc) || !sBone(sc)) continue;
    const tDir = wp(tBone(tc)).sub(wp(b)).normalize();
    const sDir = wp(sBone(sc)).sub(wp(i.src)).applyQuaternion(Y).normalize();
    i.bindWorld.premultiply(new THREE.Quaternion().setFromUnitVectors(tDir, sDir));
  }
  const sHips = sBone('DEF-hips'), tBody = tBone('Body'), tRoot = tBody.parent;
  const legLen = (a, b) => wp(a).distanceTo(wp(b));
  const ratio = (legLen(tBone('UpperLeg.L'), tBone('LowerLeg.L')) + legLen(tBone('LowerLeg.L'), tBone('Foot.L'))) /
    (legLen(sBone('DEF-thigh.L'), sBone('DEF-shin.L')) + legLen(sBone('DEF-shin.L'), sBone('DEF-foot.L')));
  const sHipsBind = wp(sHips), tBodyBind = wp(tBody);
  const rootInv = tRoot.matrixWorld.clone().invert();
  // feet parented to the root (Quaternius IK-style rig): their position follows the shin
  const feet = ['L', 'R'].map((s) => {
    const foot = tBone(`Foot.${s}`), shin = tBone(`LowerLeg.${s}`);
    return { foot, shin, offset: shin.worldToLocal(wp(foot)), pos: [] };
  }).filter((f) => f.foot.parent !== f.shin);
  const bodyPos = [];
  const mixer = new THREE.AnimationMixer(src);
  const out = [];
  const q = new THREE.Quaternion(), v = new THREE.Vector3();
  for (const name of clipNames) {
    const clip = srcGltf.animations.find((c) => c.name.split('|').pop() === name);
    if (!clip) { console.warn('UAL clip missing', name); continue; }
    const action = mixer.clipAction(clip).play();
    const n = Math.max(2, Math.round(clip.duration * fps) + 1);
    const times = [];
    for (const i of info.values()) i.values = [];
    bodyPos.length = 0;
    feet.forEach((f) => (f.pos = []));
    for (let k = 0; k < n; k++) {
      const t = (k / (n - 1)) * clip.duration;
      times.push(t);
      action.time = t;
      mixer.update(0);
      src.updateMatrixWorld(true);
      for (const b of bones) {
        const i = info.get(b);
        const parentWorld = b.parent.isBone ? info.get(b.parent).world : wq(b.parent);
        if (i.src) {
          i.world.copy(wq(i.src)).multiply(i.srcBindInv).premultiply(Y).multiply(Yi).multiply(i.bindWorld);
          q.copy(parentWorld).invert().multiply(i.world);
        } else {
          q.copy(i.bindLocal);
          i.world.copy(parentWorld).multiply(q);
        }
        const vs = i.values, m = vs.length;
        if (m && q.x * vs[m - 4] + q.y * vs[m - 3] + q.z * vs[m - 2] + q.w * vs[m - 1] < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        vs.push(q.x, q.y, q.z, q.w);
        b.quaternion.copy(q);
      }
      v.copy(wp(sHips)).sub(sHipsBind).applyQuaternion(Y).multiplyScalar(ratio).add(tBodyBind).applyMatrix4(rootInv);
      tBody.position.copy(v);
      bodyPos.push(v.x, v.y, v.z);
      tgt.updateMatrixWorld(true);
      for (const f of feet) { v.copy(f.offset).applyMatrix4(f.shin.matrixWorld).applyMatrix4(rootInv); f.pos.push(v.x, v.y, v.z); }
    }
    action.stop();
    const tracks = [];
    for (const b of bones) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, info.get(b).values));
    tracks.push(new THREE.VectorKeyframeTrack(`${tBody.name}.position`, times, bodyPos.slice()));
    for (const f of feet) tracks.push(new THREE.VectorKeyframeTrack(`${f.foot.name}.position`, times, f.pos));
    const baked = new THREE.AnimationClip(name, clip.duration, tracks);
    baked.optimize();
    out.push(baked);
  }
  mixer.uncacheRoot(src);
  return out;
}

/**
 * Clips retargeted onto one realistic body, for another one (same rig and rest rotations, other
 * proportions): only the hip position track changes (rest height, stride scaled by leg length).
 */
function refitClips(clips, fromScene, toScene) {
  const info = (scene) => {
    const b = (n) => scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));
    const p = (n) => b(n).position;
    return { body: p('Body').clone(), leg: p('LowerLeg.L').length() + p('Foot.L').length() };
  };
  const a = info(fromScene), b = info(toScene), k = b.leg / a.leg;
  return clips.map((c) => {
    const i = c.tracks.findIndex((t) => t.name === 'Body.position');
    if (i < 0) return c;
    const t = c.tracks[i].clone(), v = t.values;
    for (let j = 0; j < v.length; j += 3) {
      v[j] = (v[j] - a.body.x) * k + b.body.x;
      v[j + 1] = (v[j + 1] - a.body.y) * k + b.body.y;
      v[j + 2] = (v[j + 2] - a.body.z) * k + b.body.z;
    }
    const tracks = c.tracks.slice();
    tracks[i] = t;
    return new THREE.AnimationClip(c.name, c.duration, tracks, c.blendMode);
  });
}

const UPPER_BONES = /^(Abdomen|Torso|Chest|Neck|Head|Shoulder|UpperArm|LowerArm|Wrist|Index|Middle|Ring|Pinky|Thumb)/;
const isUpper = (track) => UPPER_BONES.test(track.name.split('.')[0]);

/**
 * Upper-body rotation tracks between clip a (stretched to b's duration) and clip b: slerp by k,
 * resampled at 30 fps over b.
 */
function blendUpper(a, b, k, fps = 30) {
  const names = new Set([...a.tracks, ...b.tracks].filter((t) => isUpper(t) && t.name.endsWith('.quaternion')).map((t) => t.name));
  const n = Math.max(2, Math.round(b.duration * fps) + 1);
  const times = Float32Array.from({ length: n }, (_, i) => (i / (n - 1)) * b.duration);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const out = [];
  for (const name of names) {
    const ta = a.tracks.find((t) => t.name === name), tb = b.tracks.find((t) => t.name === name);
    const ia = ta?.createInterpolant(new Float32Array(4)), ib = tb?.createInterpolant(new Float32Array(4));
    const v = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const t = times[i];
      if (ia) qa.fromArray(ia.evaluate((t / b.duration) * a.duration)); else qa.identity();
      if (ib) qb.fromArray(ib.evaluate(t)); else qb.copy(qa);
      if (!ia) qa.copy(qb);
      qa.slerp(qb, k).toArray(v, i * 4);
    }
    out.push(new THREE.QuaternionKeyframeTrack(name, times, v));
  }
  return out;
}

/** Aim layers + combined clips built from the retargeted ones. */
function deriveClips(clips) {
  const get = (n) => clips.find((c) => c.name === n);
  const neutral = get('Pistol_Aim_Neutral');
  const out = [];
  if (!neutral) return out;
  const upperOf = (src, k = 1) => src.tracks.filter(isUpper).map((t) => { const c = t.clone(); if (k !== 1) c.scale(k); return c; });
  for (const n of ['Jump_Start', 'Jump_Loop', 'Jump_Land']) {
    const legs = get(n);
    if (legs) out.push(new THREE.AnimationClip(`${n}_Gun`, legs.duration, [...legs.tracks.filter((t) => !isUpper(t)), ...upperOf(neutral)]));
  }
  for (const [n, src] of [['Crouch_Idle_Aim', 'Crouch_Idle_Loop'], ['Crouch_Fwd_Aim', 'Crouch_Fwd_Loop'], ['Walk_Aim', 'Walk_Loop'], ['Jog_Aim', 'Jog_Fwd_Loop'], ['Sprint_Aim', 'Sprint_Loop']]) {
    const legs = get(src);
    if (!legs) continue;
    const k = legs.duration / neutral.duration;
    out.push(new THREE.AnimationClip(n, legs.duration, [...legs.tracks.filter((t) => !isUpper(t)), ...upperOf(neutral, k)]));
  }
  // armed, not aiming (realistic bodies' Idle_Gun): standing idle, the weapon held low ("low
  // ready": the upper body halfway between the pistol ready stance and the relaxed idle)
  const idle = get('Idle_Loop'), ready = get('Pistol_Idle_Loop');
  if (idle && ready) out.push(new THREE.AnimationClip('Idle_Rifle', idle.duration, [...idle.tracks.filter((t) => !isUpper(t)), ...blendUpper(ready, idle, 0.25)]));
  for (const [n, src] of [['Aim_Up_Add', 'Pistol_Aim_Up'], ['Aim_Down_Add', 'Pistol_Aim_Down']]) {
    const s = get(src);
    if (!s) continue;
    const upper = (c) => new THREE.AnimationClip(c.name, c.duration, c.tracks.filter(isUpper).map((t) => t.clone()));
    const add = THREE.AnimationUtils.makeClipAdditive(upper(s), 0, upper(neutral));
    add.name = n;
    out.push(add);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hitboxes (capsules between joints, metres on the 1.8 m characters)
export const HIT_MULT = { head: 2.5, body: 1, limb: 0.7 };
const HITBOXES = [
  { part: 'head', a: 'Head', b: 'Head', aUp: 0.07, bTop: true, r: 0.13 },
  { part: 'body', a: 'Chest', b: 'Head', r: 0.08 },
  { part: 'body', a: 'Torso', b: 'Chest', bUp: 0.05, r: 0.18 },
  { part: 'body', a: 'Hips', b: 'Torso', r: 0.17 },
  ...['L', 'R'].flatMap((s) => [
    { part: 'limb', a: `UpperArm.${s}`, b: `LowerArm.${s}`, r: 0.065 },
    { part: 'limb', a: `LowerArm.${s}`, b: `Wrist.${s}`, r: 0.06 },
    { part: 'limb', a: `UpperLeg.${s}`, b: `LowerLeg.${s}`, r: 0.095 },
    { part: 'limb', a: `LowerLeg.${s}`, b: `Foot.${s}`, r: 0.075 },
  ]),
];

const _ba = new THREE.Vector3(), _oa = new THREE.Vector3(), _oc = new THREE.Vector3();
/** Distance along a normalized ray to a capsule [pa, pb] radius r, or -1 (Inigo Quilez). */
export function rayCapsule(ro, rd, pa, pb, r) {
  _ba.subVectors(pb, pa);
  _oa.subVectors(ro, pa);
  const baba = _ba.dot(_ba), bard = _ba.dot(rd), baoa = _ba.dot(_oa);
  const rdoa = rd.dot(_oa), oaoa = _oa.dot(_oa);
  const a = baba - bard * bard;
  if (a > 1e-9) {
    const b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - r * r * baba;
    const h = b * b - a * c;
    if (h < 0) return -1;
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t;
    _oc.copy(y <= 0 ? _oa : _oc.subVectors(ro, pb));
  } else _oc.copy(baoa <= 0 ? _oa : _oc.subVectors(ro, pb));
  const b = rd.dot(_oc), c = _oc.dot(_oc) - r * r, h = b * b - c;
  return h > 0 ? -b - Math.sqrt(h) : -1;
}

// skeleton.update() once per frame (shadow cascades would re-run it per pass)
let renderFrame = 0;
const skeletonUpdate = THREE.Skeleton.prototype.update;
function updateSkeletonOncePerFrame() {
  if (this._rf === renderFrame) return;
  this._rf = renderFrame;
  skeletonUpdate.call(this);
}
export function nextCharacterFrame() { renderFrame++; }

// ---------------------------------------------------------------------------------------------
/**
 * Character model of an actor (game/archetypes.json): the archetype's `models` (one picked per actor id, stable across
 * reloads: a squad of the same archetype mixes faces and outfits) or its `model`.
 */
export function archetypeModel(arch, id = '') {
  const list = arch.models?.length ? arch.models : null;
  if (!list) return arch.model;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return list[(h >>> 0) % list.length];
}

/** Every character model the archetypes use (loaded at start). */
export function archetypeModels(archetypes) {
  return [...new Set(Object.values(archetypes).flatMap((a) => (a.models?.length ? a.models : [a.model])).filter(Boolean))];
}

export class CharacterLibrary {
  constructor(lighting) {
    this.lighting = lighting;
    this.templates = {};
    this.loader = new GLTFLoader();
    this.shared = [];
  }

  /**
   * Load character models + retarget the UAL clips onto them. Names listed in data/characters.json
   * are realistic bodies (models/characters/<name>.glb), the others Quaternius models
   * (models/<name>.glb). The clips are retargeted once per rig and shared by its models.
   */
  async load(names, { ual = 'ual_base.glb' } = {}) {
    const t0 = performance.now();
    const realistic = (await Data.jsonOr('characters.json', {})).characters ?? {};
    const url = (n) => (realistic[n] ? `${BASE}characters/${n}.glb` : `${BASE}${n}.glb`);
    const [ualGltf, ...gltfs] = await Promise.all([this.loader.loadAsync(BASE + ual), ...names.map((n) => this.loader.loadAsync(url(n)))]);
    names.forEach((name, i) => {
      const g = gltfs[i];
      g.scene.name = name;
      if (g.scene.userData.rig === REALISTIC_RIG) { this.templates[name] = this._realistic(g.scene); return; }
      g.scene.traverse((o) => { if (o.isMesh && o.geometry.attributes.position) smoothGeometryNormals(o.geometry, CREASE); });
      g.scene.updateMatrixWorld(true);
      mergeCharacterMeshes(g.scene, this.lighting);
      g.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g.scene, true);
      const h = box.max.y - box.min.y || 1;
      this.templates[name] = { scene: g.scene, animations: g.animations.map((c) => { c.name = c.name.split('|').pop(); return c; }), scale: CHAR_HEIGHT / h, minY: box.min.y, rig: 'quaternius' };
    });
    // one retargeting per rig; realistic bodies differ in proportions only (identity rest
    // rotations): the others get the first one's clips with their own hip height / stride
    const rigs = new Map();
    for (const n of names) { const r = this.templates[n].rig; if (!rigs.has(r)) rigs.set(r, []); rigs.get(r).push(n); }
    for (const [rig, list] of rigs) {
      const first = this.templates[list[0]];
      const baked = retargetClips(ualGltf, first.scene, UAL_CLIPS);
      baked.push(...deriveClips(baked));
      for (const n of list) {
        const t = this.templates[n];
        t.animations.push(...(rig === REALISTIC_RIG && t !== first ? refitClips(baked, first.scene, t.scene) : baked));
      }
    }
    this.loadMs = performance.now() - t0;
    return this;
  }

  /** Template of a realistic body (see the file header): material, vertex colours, part ranges. */
  _realistic(scene) {
    scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const g = o.geometry, n = g.attributes.position.count;
      g.userData.parts = o.userData.parts ?? [];
      // white vertex colours: palettes tint parts (variant())
      g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(n * 3).fill(255), 3, true));
      const src = o.material;
      const mat = new THREE.MeshStandardMaterial({
        name: 'character', vertexColors: true, map: src.map, normalMap: src.normalMap, normalScale: src.normalScale,
        roughnessMap: src.roughnessMap, roughness: 1, metalness: 0,
      });
      src.dispose();
      o.material = this.lighting.patch(mat);
    });
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene, true);
    const { grip } = scene.userData;
    return { scene, animations: [], scale: 1, minY: box.min.y, rig: REALISTIC_RIG, aliases: REALISTIC_ALIASES, grip };
  }

  /**
   * A recoloured copy of a template: palette maps source material names (e.g. "Red") to hex
   * colours. Cached; instances of a variant share its geometry.
   */
  variant(name, palette, key) {
    const vk = `${name}#${key ?? JSON.stringify(palette)}`;
    if (this.templates[vk]) return vk;
    const t = this.templates[name];
    if (!t) throw new Error(`character model "${name}" not loaded`);
    const scene = SkeletonUtils.clone(t.scene);
    const col = new THREE.Color();
    scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const parts = o.geometry.userData.parts ?? [];
      o.geometry = o.geometry.clone();
      o.geometry.userData.parts = parts;
      const c = o.geometry.attributes.color;
      for (const r of parts) {
        const hex = palette?.[r.name];
        if (!hex) continue;
        col.set(hex);
        for (let i = r.start; i < r.start + r.count; i++) c.setXYZ(i, col.r, col.g, col.b);
      }
      c.needsUpdate = true;
    });
    this.templates[vk] = { ...t, scene };
    return vk;
  }

  /** A new animated instance: see class Character. */
  create(name, opts) {
    const t = this.templates[name];
    if (!t) throw new Error(`character model "${name}" not loaded`);
    return new Character(t, opts);
  }
}

const CULL_RADIUS = 2.2;
export class Character {
  constructor(t, { layer = LAYERS.DYNAMIC } = {}) {
    this.root = new THREE.Group();
    this.model = SkeletonUtils.clone(t.scene);
    this.model.scale.setScalar(t.scale);
    this.model.position.y = -t.minY * t.scale;
    this.root.add(this.model);
    this.baseScale = t.scale;
    this.skeletons = new Set();
    this.meshes = [];
    this.model.traverse((o) => {
      o.layers.set(layer);
      if (o.isMesh) {
        // own material (hit tint); clone() drops the lighting patch (sun, shadows, SSAO, GI,
        // textures): carry it over — same program cache key, no extra compile
        const src = o.material;
        o.material = src.clone();
        o.material.onBeforeCompile = src.onBeforeCompile;
        o.material.customProgramCacheKey = src.customProgramCacheKey;
        this.meshes.push(o);
      }
      if (o.isSkinnedMesh && !this.skeletons.has(o.skeleton)) { this.skeletons.add(o.skeleton); o.skeleton.update = updateSkeletonOncePerFrame; }
    });
    this.material = this.meshes[0]?.material;
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const clip of t.animations) this.actions[clip.name] = this.mixer.clipAction(clip);
    for (const [name, clip] of Object.entries(t.aliases ?? {})) if (this.actions[clip]) this.actions[name] = this.actions[clip];
    /** Where a held object's origin goes, in hand-bone space (realistic bodies: in the palm). */
    this.grip = { R: new THREE.Vector3(...(t.grip?.R ?? [0, 0, 0])), L: new THREE.Vector3(...(t.grip?.L ?? [0, 0, 0])) };
    this.current = null;
    this.bone = (n) => this.model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n)) ?? this.model.getObjectByName(n);
    this.headBone = this.bone('Head');
    this.handR = this.bone('Wrist.R') ?? this.bone('WristR');
    this.handL = this.bone('Wrist.L') ?? this.bone('WristL');
    this._buildHitboxes();
    this._cullingSphere();
    // The renderer's culling walk skips invisible subtrees: hiding the bone hierarchy saves ~90
    // object visits per character and per render pass. Bones still get their world matrices
    // (updateMatrixWorld ignores visibility), which is all skinning needs.
    this.model.traverse((o) => { if (o.isBone && !o.parent?.isBone) o.visible = false; });
  }

  get position() { return this.root.position; }

  _cullingSphere() {
    this.root.updateMatrixWorld(true);
    const center = new THREE.Vector3(0, CHAR_HEIGHT / 2, 0);
    this.model.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.boundingSphere = new THREE.Sphere(o.worldToLocal(center.clone()), CULL_RADIUS / o.matrixWorld.getMaxScaleOnAxis());
    });
  }

  _buildHitboxes() {
    this.root.updateMatrixWorld(true);
    const top = new THREE.Box3().setFromObject(this.model, true).max.y;
    const end = (b, up, atTop, r) => {
      const p = b.getWorldPosition(new THREE.Vector3());
      if (atTop) p.y = Math.max(p.y, top - r); else if (up) p.y += up;
      return b.worldToLocal(p);
    };
    this.hitboxes = [];
    for (const h of HITBOXES) {
      const a = this.bone(h.a), b = this.bone(h.b);
      if (!a || !b) continue;
      this.hitboxes.push({ ...h, boneA: a, boneB: b, localA: end(a, h.aUp, false, h.r), localB: end(b, h.bUp, h.bTop, h.r), pa: new THREE.Vector3(), pb: new THREE.Vector3() });
    }
  }

  /** Nearest hitbox the ray enters between minD and maxD: { box, part, d } or null. */
  raycastHitboxes(ray, minD = 0, maxD = Infinity) {
    let best = null;
    for (const h of this.hitboxes) {
      h.pa.copy(h.localA).applyMatrix4(h.boneA.matrixWorld);
      h.pb.copy(h.localB).applyMatrix4(h.boneB.matrixWorld);
      const d = rayCapsule(ray.origin, ray.direction, h.pa, h.pb, h.r);
      if (d > minD && d < maxD) { maxD = d; best = { box: h, part: h.part, d }; }
    }
    return best;
  }

  /** Play a clip (cross-fade). Returns its duration (s) at that speed. */
  play(name, { once = false, fade = 0.15, speed = 1, from = 0, restart = false } = {}) {
    const a = this.actions[name];
    if (!a) return 0;
    if (this.current === a && !once && !restart) { a.timeScale = speed; return a.getClip().duration / speed; }
    a.reset();
    a.time = from;
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.timeScale = speed;
    a.setEffectiveWeight(1);
    a.fadeIn(fade).play();
    if (this.current && this.current !== a) this.current.fadeOut(fade);
    this.current = a;
    return (a.getClip().duration - from) / speed;
  }

  playing(name) { return this.current === this.actions[name]; }

  /** Additive aim pitch: k in [-1, 1] (-1 down, 1 up). */
  setAimPitch(k, dt) {
    if (!this.aimUp) {
      this.aimUp = this.actions.Aim_Up_Add?.play();
      this.aimDown = this.actions.Aim_Down_Add?.play();
      this.aimK = 0;
      if (!this.aimUp) return;
    }
    this.aimK += (k - this.aimK) * Math.min(1, 12 * dt);
    this.aimUp.setEffectiveWeight(Math.max(0, this.aimK));
    this.aimDown.setEffectiveWeight(Math.max(0, -this.aimK));
  }

  /**
   * Attach an object to the right hand, cancelling the armature scale. The object is a child of the
   * character root (bones are hidden from the renderer's walk) and follows the hand bone through
   * onBeforeRender. Returns the holder (set its position / quaternion = grip in hand space).
   */
  attachToHand(obj, { hand = 'R' } = {}) {
    const bone = hand === 'R' ? this.handR : this.handL;
    if (!bone) return null;
    this.model.updateMatrixWorld(true);
    const s = new THREE.Vector3();
    bone.getWorldScale(s);
    const holder = new THREE.Group();
    holder.scale.setScalar(1 / s.x);
    holder.add(obj);
    this.root.add(holder);
    holder.matrixAutoUpdate = false;
    holder.matrixWorldAutoUpdate = false;
    const local = new THREE.Matrix4();
    const follow = () => {
      local.compose(holder.position, holder.quaternion, holder.scale);
      holder.matrixWorld.multiplyMatrices(bone.matrixWorld, local);
      obj.matrixWorld.multiplyMatrices(holder.matrixWorld, obj.matrix);
    };
    obj.traverse((o) => { o.layers.set(LAYERS.DYNAMIC); o.frustumCulled = false; if (o.isMesh) o.onBeforeRender = follow; });
    obj.updateMatrix();
    return holder;
  }

  /** Hand-local rotation that makes the held object's -Z point along the character's forward in a pose. */
  solveGrip(clipName = 'Pistol_Aim_Neutral') {
    const a = this.actions[clipName];
    const bone = this.handR;
    if (!a || !bone) return new THREE.Quaternion();
    const prev = this.current;
    a.reset().play();
    this.mixer.update(0);
    this.model.updateMatrixWorld(true);
    // character forward is +Z in model space (Quaternius): rotate held -Z to +Z
    const toFwd = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const q = bone.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(this.root.getWorldQuaternion(new THREE.Quaternion())).multiply(toFwd);
    a.stop();
    if (prev) prev.play();
    return q;
  }

  setTint(r, g, b) {
    if (this.material?.emissive) this.material.emissive.setRGB(r, g, b);
  }

  update(dt) { this.mixer.update(dt); }

  dispose() {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    for (const m of this.meshes) m.material.dispose();
  }
}
