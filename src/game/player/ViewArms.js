// First-person arms: the arms of a Quaternius character (same rig as the NPCs, real fingers),
// drawn in the weapon view-model pass. Only the arm triangles of the merged character mesh are
// kept, the (short, stylised) arms are stretched along their bones at build time, and every frame
// the wrists are put on the weapon's grips by two-bone IK (elbows toward a pole), the hands turned
// to the grip frame and the fingers curled around it.
//
// Config (game/player.json `arms`): model, palette (material name -> colour), shoulder (camera
// space [_, y, z] of the shoulders, centred on x = 0), stretch (arm length factor), handScale,
// pole (camera space elbow direction of the right arm, mirrored).
// Grips (weapon asset `hands.right` / `hands.left`, weapon space, docs/ASSETS.md): pos (wrist),
// fingers (direction of the straight fingers), thumb (direction of the thumb), curl ([index,
// middle, ring, pinky] degrees per joint), thumbCurl (degrees per joint), thumbFold (degrees, across
// the palm). A missing grip hangs that arm out of view.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LAYERS } from '../../engine/render/layers.js';

const D2R = Math.PI / 180;
const san = THREE.PropertyBinding.sanitizeNodeName;
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

/** Rotation taking the orthonormal frame built on (a0, b0) to the one built on (a1, b1). */
function frameRotation(a0, b0, a1, b1, out) {
  const f = (a, b, m) => {
    const x = _c.copy(a).normalize(), z = _d.crossVectors(x, b).normalize();
    const y = _b.crossVectors(z, x);
    return m.makeBasis(x, y, z);
  };
  f(a0, b0, _m);
  f(a1, b1, _m2);
  return out.setFromRotationMatrix(_m2.multiply(_m.transpose()));
}

export class ViewArms {
  constructor(library, cfg = {}, parent) {
    const name = library.templates[cfg.model] ? cfg.model : Object.keys(library.templates)[0];
    const t = library.templates[cfg.palette ? library.variant(name, cfg.palette, 'arms') : name];
    this.root = new THREE.Group();
    this.root.name = 'ViewArms';
    const model = SkeletonUtils.clone(t.scene);
    let mesh = null;
    model.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
    this.model = model;
    const sk = mesh.skeleton;
    const bone = (n) => sk.bones.find((b) => b.name === san(n));
    // bind pose (a T-pose: arms along ±X, palms down, thumbs toward +Z), model space at scale 1
    sk.pose();
    model.updateMatrixWorld(true);
    this.sides = {};
    const geo = mesh.geometry;
    const keep = new Set();
    for (const s of ['R', 'L']) {
      const side = { s, sign: s === 'R' ? 1 : -1 };
      side.upper = bone(`UpperArm.${s}`); side.lower = bone(`LowerArm.${s}`); side.wrist = bone(`Wrist.${s}`);
      side.fingers = FINGERS.map((f) => [2, 3, 4].map((i) => bone(`${f}${i}.${s}`)).filter(Boolean));
      side.thumb = [1, 2, 3].map((i) => bone(`Thumb${i}.${s}`)).filter(Boolean);
      side.bones = new Set([side.upper, side.lower, side.wrist, ...side.thumb, ...side.fingers.flat(), ...FINGERS.map((f) => bone(`${f}1.${s}`))].filter(Boolean).map((b) => sk.bones.indexOf(b)));
      for (const i of side.bones) keep.add(i);
      this.sides[s] = side;
    }
    // keep the triangles whose three vertices mostly follow an arm bone
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, idx = geo.index.array;
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
    // re-bind in the bind-pose world (whatever space the glTF skin used): each kept vertex at its
    // skinned bind position / normal, bones inverted where they stand
    model.updateMatrixWorld(true);
    const n = remap.size, P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3);
    const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4), M = new Int16Array(n);
    const nrm = new THREE.Matrix3();
    for (const [v, i] of remap) {
      mesh.getVertexPosition(v, _a);
      mesh.localToWorld(_a).toArray(P, i * 3);
      nrm.getNormalMatrix(_m.multiplyMatrices(sk.bones[main[v]].matrixWorld, sk.boneInverses[main[v]]));
      _a.fromBufferAttribute(geo.attributes.normal, v).applyMatrix3(nrm).normalize().toArray(N, i * 3);
      _a.fromBufferAttribute(geo.attributes.color, v).toArray(C, i * 3);
      for (let k = 0; k < 4; k++) { SI[i * 4 + k] = si.getComponent(v, k); SW[i * 4 + k] = sw.getComponent(v, k); }
      M[i] = main[v];
    }
    // stretch the (short, stylised) arms: vertices slide along the upper arm / forearm by
    // (k - 1) x their distance along it, the hand moves by the whole extra length
    const k = cfg.stretch ?? 1;
    const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
    for (const side of Object.values(this.sides)) {
      const S = wp(side.upper), E = wp(side.lower), W = wp(side.wrist);
      const du = E.clone().sub(S), lu = du.length(); du.divideScalar(lu);
      const df = W.clone().sub(E), lf = df.length(); df.divideScalar(lf);
      const lowerI = sk.bones.indexOf(side.lower), upperI = sk.bones.indexOf(side.upper);
      for (let i = 0; i < n; i++) {
        const b = M[i];
        if (!side.bones.has(b)) continue;
        _a.fromArray(P, i * 3);
        _b.set(0, 0, 0);
        if (b === upperI) _b.addScaledVector(du, (k - 1) * THREE.MathUtils.clamp(_c.subVectors(_a, S).dot(du), 0, lu));
        else if (b === lowerI) _b.addScaledVector(du, (k - 1) * lu).addScaledVector(df, (k - 1) * THREE.MathUtils.clamp(_c.subVectors(_a, E).dot(df), 0, lf));
        else _b.addScaledVector(du, (k - 1) * lu).addScaledVector(df, (k - 1) * lf);
        _a.add(_b).toArray(P, i * 3);
      }
      // move the elbow / wrist bones by the same amounts (world offsets -> parent space)
      for (const [b, off] of [[side.lower, du.clone().multiplyScalar((k - 1) * lu)], [side.wrist, df.clone().multiplyScalar((k - 1) * lf)]]) {
        const target = wp(b).add(off);
        b.position.copy(b.parent.worldToLocal(target));
        b.updateMatrixWorld(true);
      }
    }
    model.updateMatrixWorld(true);
    sk.boneInverses = sk.bones.map((b) => b.matrixWorld.clone().invert()); // own array (the clone shares the template's)
    const arms = new THREE.BufferGeometry();
    arms.setAttribute('position', new THREE.BufferAttribute(P, 3));
    arms.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    arms.setAttribute('color', new THREE.BufferAttribute(C, 3));
    arms.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
    arms.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
    arms.setIndex(tris);
    arms.computeBoundingSphere();
    mesh.geometry = arms;
    mesh.bind(sk, new THREE.Matrix4()); // attached: vertex = sum(bone x inverse) x position
    mesh.material = new THREE.MeshLambertMaterial({ vertexColors: true, name: 'ViewArms' });
    mesh.frustumCulled = false;
    model.traverse((o) => o.layers.set(LAYERS.VIEW));
    // bind data in model space: world quaternions, bone lengths, the local rotations at rest
    const mq = (b) => b.getWorldQuaternion(new THREE.Quaternion());
    for (const side of Object.values(this.sides)) {
      side.lenU = wp(side.lower).distanceTo(wp(side.upper));
      side.lenF = wp(side.wrist).distanceTo(wp(side.lower));
      side.qU = mq(side.upper); side.qF = mq(side.lower); side.qW = mq(side.wrist);
      // bind directions (model space): upper arm, forearm, straight fingers
      const mid = side.fingers[1][0] ?? side.fingers[0][0];
      side.dU0 = wp(side.lower).sub(wp(side.upper)).normalize();
      side.dF0 = wp(side.wrist).sub(wp(side.lower)).normalize();
      side.dH0 = wp(mid).sub(wp(side.wrist)).normalize();
      side.rest = new Map();
      for (const b of [...side.thumb, ...side.fingers.flat()]) side.rest.set(b, b.quaternion.clone());
      // curl axis (palm down, fingers along ∓X: bending toward -Y turns about ±Z), per bone local
      const axisW = new THREE.Vector3(0, 0, side.sign);
      side.curlAxis = new Map();
      for (const b of [...side.thumb, ...side.fingers.flat()]) side.curlAxis.set(b, axisW.clone().applyQuaternion(mq(b).invert()));
      // thumb: folds across the palm (about the axis along the hand)
      side.thumbAxis = new Map();
      for (const b of side.thumb) side.thumbAxis.set(b, new THREE.Vector3(1, 0, 0).applyQuaternion(mq(b).invert()));
    }
    // model space -> camera space: face -Z, real size, shoulders centred on x = 0 at cfg.shoulder's
    // height / depth
    const sh = wp(this.sides.R.upper).add(wp(this.sides.L.upper)).multiplyScalar(0.5);
    model.rotation.y = Math.PI;
    model.scale.setScalar(t.scale * (cfg.scale ?? 1));
    const shoulder = new THREE.Vector3(0, ...(cfg.shoulder ?? [0, -0.26, -0.08]).slice(1));
    model.position.copy(shoulder).sub(sh.applyQuaternion(model.quaternion).multiplyScalar(model.scale.x));
    this.root.add(model);
    parent.add(this.root);
    // the stylised hands are big (palm ~1.5x a real one): scale them about the wrist
    for (const side of Object.values(this.sides)) side.wrist.scale.setScalar(cfg.handScale ?? 1);
    this.pole = new THREE.Vector3(...(cfg.pole ?? [0.5, -1, 0.15]));
    this.mesh = mesh;
    const v = () => new THREE.Vector3(), q = () => new THREE.Quaternion();
    this._t = { T: v(), fingers: v(), thumb: v(), S: v(), E: v(), W: v(), n: v(), m: v(), dU: v(), dF: v(), bend: v(), fwd0: v(), along: v(), rootQ: q(), wq: q(), g: q(), g2: q() };
  }

  set visible(v) { this.root.visible = v; }
  get visible() { return this.root.visible; }

  /**
   * Put the hands on the grips of `weapon` (an Object3D, weapon space = its local frame): grips
   * from the weapon asset `hands`. Call after the weapon's world matrix is up to date.
   * leftAway (0..1) moves the left hand from its grip by `awayOffset` (camera space): reloads.
   */
  update(weapon, hands, { leftAway = 0, awayOffset = null } = {}) {
    const t = this._t; // scratch objects (no allocation per frame)
    this.root.updateMatrixWorld(true);
    this.model.getWorldQuaternion(t.rootQ);
    weapon.getWorldQuaternion(t.wq);
    for (const side of Object.values(this.sides)) {
      const grip = side.s === 'R' ? hands?.right : hands?.left;
      if (grip) {
        t.T.fromArray(grip.pos).applyMatrix4(weapon.matrixWorld);
        t.fingers.fromArray(grip.fingers).applyQuaternion(t.wq).normalize();
        t.thumb.fromArray(grip.thumb).applyQuaternion(t.wq);
        if (leftAway > 0 && side.s === 'L' && awayOffset) t.T.addScaledVector(awayOffset, leftAway);
      } else {
        // no grip: hang the arm down out of the view
        side.upper.getWorldPosition(t.T).add(_a.set(0.05 * side.sign, -0.5, 0.05));
        t.fingers.set(0, -1, 0);
        t.thumb.set(0, 0, -1);
      }
      this._solve(side, t);
      this._curl(side, grip);
    }
  }

  _solve(side, t) {
    const { T, fingers, thumb, rootQ, S, E, W, n, m, dU, dF, bend, fwd0, along, g, g2 } = t;
    side.upper.getWorldPosition(S);
    const scale = this.model.scale.x;
    const a = side.lenU * scale, b = side.lenF * scale;
    const d = THREE.MathUtils.clamp(n.subVectors(T, S).length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
    n.normalize();
    m.copy(this.pole);
    if (side.sign < 0) m.x = -m.x;
    m.addScaledVector(n, -m.dot(n)).normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    E.copy(S).addScaledVector(n, a * cosA).addScaledVector(m, a * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
    W.copy(S).addScaledVector(n, d);
    // bind frames in world: bone directions of the T-pose, elbow bend / thumbs toward +Z (model)
    fwd0.set(0, 0, 1).applyQuaternion(rootQ);
    // upper arm: along S->E, the forearm bending toward W
    dU.subVectors(E, S).normalize();
    bend.subVectors(W, E).addScaledVector(dU, -bend.dot(dU));
    frameRotation(along.copy(side.dU0).applyQuaternion(rootQ), fwd0, dU, bend, g);
    this._setWorld(side.upper, _q2.copy(g).multiply(rootQ).multiply(side.qU));
    // forearm: along E->W, twist halfway between the elbow hinge and the hand's thumb direction
    dF.subVectors(W, E);
    along.copy(side.dF0).applyQuaternion(rootQ);
    frameRotation(along, fwd0, dF, bend.copy(fwd0).applyQuaternion(g), g2);
    frameRotation(along, fwd0, dF, thumb, g);
    this._setWorld(side.lower, g2.slerp(g, 0.5).multiply(rootQ).multiply(side.qF));
    // hand: fingers / thumb
    frameRotation(along.copy(side.dH0).applyQuaternion(rootQ), fwd0, fingers, thumb, g);
    this._setWorld(side.wrist, g.multiply(rootQ).multiply(side.qW));
  }

  _setWorld(bone, q) {
    bone.parent.getWorldQuaternion(_q).invert();
    bone.quaternion.copy(_q.multiply(q));
    bone.updateMatrixWorld(true);
  }

  _curl(side, grip) {
    const curl = grip?.curl ?? [25, 30, 35, 40];
    side.fingers.forEach((chain, f) => {
      const deg = Array.isArray(curl[f]) ? curl[f] : [curl[f], curl[f], curl[f]];
      chain.forEach((b, j) => b.quaternion.copy(side.rest.get(b)).multiply(_q.setFromAxisAngle(side.curlAxis.get(b), (deg[j] ?? deg[0]) * D2R)));
    });
    const tc = grip?.thumbCurl ?? [10, 10, 10];
    const tf = grip?.thumbFold ?? 20;
    side.thumb.forEach((b, j) => {
      b.quaternion.copy(side.rest.get(b));
      if (j === 0) b.quaternion.multiply(_q.setFromAxisAngle(side.thumbAxis.get(b), tf * D2R));
      b.quaternion.multiply(_q.setFromAxisAngle(side.curlAxis.get(b), (tc[j] ?? 0) * D2R));
    });
  }
}
