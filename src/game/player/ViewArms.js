// First-person arms: a realistic skinned arms model (public/models/fp/arms_*.glb, built by
// `mc viewmodel build` from a Microsoft Rocketbox avatar: photo textures, 3 joints per finger),
// drawn in the weapon view-model pass. Every frame the wrists are put on the weapon's grips by
// two-bone IK (elbows toward a pole), the hands turned to the grip frame and the fingers curled
// around it. The bind pose can be anything (T- or A-pose): the bone directions, the thumb side of
// the hands and the palm normals are measured on the skeleton at load.
//
// Config (game/player.json `arms`): model (public/models/fp/<model>.glb), shoulder (camera space
// [_, y, z] of the shoulders, centred on x = 0), scale, pole (camera space elbow direction of the
// right arm, mirrored), yaw (deg the torso is turned to the right: left shoulder forward),
// stretch (arm length factor: view-model weapons are held farther than real arms reach), reach (m a
// shoulder may move toward a grip the straight arm can't reach, default 0.1), envMap (sky
// reflection strength of the arms' material).
// Grips (weapon asset `hands.right` / `hands.left`, weapon space, docs/ASSETS.md): pos (wrist),
// fingers (direction of the straight fingers), thumb (thumb side of the hand), curl ([index,
// middle, ring, pinky] degrees per joint), thumbCurl (degrees per joint), thumbFold (degrees, across
// the palm). A missing grip hangs that arm out of view.
import * as THREE from 'three';
import { LAYERS } from '../../engine/render/layers.js';

const D2R = Math.PI / 180;
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

/**
 * Longer arms (first-person view models are held farther than real arms reach): vertices slide
 * along the upper arm / forearm by (k - 1) x their distance along it, the hands move by the whole
 * extra length, the elbows and wrists with them, then the skin is re-bound. Model space, bind pose.
 */
function stretchArms(mesh, bone, k) {
  const sk = mesh.skeleton, geo = mesh.geometry;
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const main = new Int16Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    let best = -1;
    for (let j = 0; j < 4; j++) { const w = sw.getComponent(i, j); if (w > best) { best = w; main[i] = si.getComponent(i, j); } }
  }
  for (const s of ['R', 'L']) {
    const upper = bone(`UpperArm.${s}`), lower = bone(`LowerArm.${s}`), wrist = bone(`Wrist.${s}`);
    const S = wp(upper), E = wp(lower), W = wp(wrist);
    const du = E.clone().sub(S), lu = du.length(); du.divideScalar(lu);
    const df = W.clone().sub(E), lf = df.length(); df.divideScalar(lf);
    const ui = sk.bones.indexOf(upper), li = sk.bones.indexOf(lower);
    const hand = new Set();
    wrist.traverse((b) => { if (b.isBone) hand.add(sk.bones.indexOf(b)); });
    const v = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const b = main[i];
      if (b !== ui && b !== li && !hand.has(b)) continue;
      v.fromBufferAttribute(pos, i);
      const alongF = b === li ? THREE.MathUtils.clamp(c.subVectors(v, E).dot(df), 0, lf) : lf;
      v.addScaledVector(du, (k - 1) * (b === ui ? THREE.MathUtils.clamp(c.subVectors(v, S).dot(du), 0, lu) : lu));
      if (b !== ui) v.addScaledVector(df, (k - 1) * alongF);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    for (const [b, off] of [[lower, du.clone().multiplyScalar((k - 1) * lu)], [wrist, df.clone().multiplyScalar((k - 1) * lf)]]) {
      b.position.copy(b.parent.worldToLocal(wp(b).add(off)));
      b.updateMatrixWorld(true);
    }
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
  sk.calculateInverses();
}

export class ViewArms {
  /** gltf: the loaded arms model (one skinned mesh, bones named UpperArm.R, LowerArm.R, Wrist.R, Index1.R...). */
  constructor(gltf, cfg = {}, parent) {
    this.root = new THREE.Group();
    this.root.name = 'ViewArms';
    const model = gltf.scene;
    let mesh = null;
    model.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
    if (!mesh) throw new Error('arms model without a skinned mesh');
    this.model = model;
    const sk = mesh.skeleton;
    const bone = (n) => sk.bones.find((b) => b.name === THREE.PropertyBinding.sanitizeNodeName(n));
    sk.pose();
    model.updateMatrixWorld(true);
    const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
    if ((cfg.stretch ?? 1) !== 1) stretchArms(mesh, bone, cfg.stretch);
    const mq = (b) => b.getWorldQuaternion(new THREE.Quaternion());
    this.sides = {};
    for (const s of ['R', 'L']) {
      const side = { s, sign: s === 'R' ? 1 : -1 };
      side.upper = bone(`UpperArm.${s}`); side.lower = bone(`LowerArm.${s}`); side.wrist = bone(`Wrist.${s}`);
      if (!side.upper || !side.lower || !side.wrist) throw new Error(`arms model: missing ${s} arm bones`);
      side.fingers = FINGERS.map((f) => [1, 2, 3].map((i) => bone(`${f}${i}.${s}`)).filter(Boolean));
      side.thumb = [1, 2, 3].map((i) => bone(`Thumb${i}.${s}`)).filter(Boolean);
      // bind data (model space): bone lengths and directions, world rotations, finger rest rotations
      const S = wp(side.upper), E = wp(side.lower), W = wp(side.wrist);
      side.lenU = E.distanceTo(S);
      side.lenF = W.distanceTo(E);
      side.shoulder0 = side.upper.position.clone(); // rest position (parent space): the shoulder moves forward when needed
      side.qU = mq(side.upper); side.qF = mq(side.lower); side.qW = mq(side.wrist);
      side.dU0 = E.clone().sub(S).normalize();
      side.dF0 = W.clone().sub(E).normalize();
      const base = (i) => (side.fingers[i]?.[0] ? wp(side.fingers[i][0]) : W.clone());
      side.dH0 = base(1).sub(W).normalize(); // wrist -> middle finger
      // thumb side of the hand (pinky -> index, across the palm) and palm normal (out of the palm)
      side.t0 = base(0).sub(base(3));
      side.t0.addScaledVector(side.dH0, -side.t0.dot(side.dH0)).normalize();
      const palm = new THREE.Vector3().crossVectors(side.dH0, side.t0).multiplyScalar(-side.sign);
      // the elbow bends toward the front of the body (+Z) in the bind pose
      side.fwd0 = new THREE.Vector3(0, 0, 1);
      // curl: each finger bends toward the palm, about (finger direction x palm normal), per bone local;
      // the thumb folds across the palm about (thumb side x palm normal)
      side.rest = new Map();
      side.curlAxis = new Map();
      const chains = [...side.fingers, side.thumb];
      for (const chain of chains) {
        chain.forEach((b, j) => {
          const next = chain[j + 1] ?? null;
          const dir = next ? wp(next).sub(wp(b)) : wp(b).sub(wp(chain[j - 1] ?? side.wrist));
          const axis = new THREE.Vector3().crossVectors(chain === side.thumb ? side.dH0 : dir.normalize(), palm).normalize();
          side.rest.set(b, b.quaternion.clone());
          side.curlAxis.set(b, axis.applyQuaternion(mq(b).invert()));
        });
      }
      side.thumbAxis = new Map();
      const fold = new THREE.Vector3().crossVectors(side.t0, palm).normalize();
      for (const b of side.thumb) side.thumbAxis.set(b, fold.clone().applyQuaternion(mq(b).invert()));
      this.sides[s] = side;
    }
    mesh.frustumCulled = false;
    model.traverse((o) => {
      o.layers.set(LAYERS.VIEW);
      if (o.material) o.material.envMapIntensity = cfg.envMap ?? 1;
    });
    // model space -> camera space: face -Z (turned by cfg.yaw: a shooter blades the torso, the
    // left shoulder forward), shoulders centred on x = 0 at cfg.shoulder's height / depth
    const sh = wp(this.sides.R.upper).add(wp(this.sides.L.upper)).multiplyScalar(0.5);
    model.rotation.y = Math.PI - (cfg.yaw ?? 0) * D2R;
    model.scale.setScalar(cfg.scale ?? 1);
    const shoulder = new THREE.Vector3(0, ...(cfg.shoulder ?? [0, -0.26, 0.02]).slice(1));
    model.position.copy(shoulder).sub(sh.applyQuaternion(model.quaternion).multiplyScalar(model.scale.x));
    this.root.add(model);
    parent.add(this.root);
    this.pole = new THREE.Vector3(...(cfg.pole ?? [0.5, -1, 0.15]));
    this.reach = cfg.reach ?? 0.1; // how far a shoulder can move toward a grip out of reach (m, scapula protraction)
    this.mesh = mesh;
    const v = () => new THREE.Vector3(), q = () => new THREE.Quaternion();
    this._t = { T: v(), fingers: v(), thumb: v(), S: v(), E: v(), W: v(), n: v(), m: v(), dU: v(), dF: v(), bend: v(), fwd0: v(), along: v(), t0: v(), rootQ: q(), camQ: q(), wq: q(), g: q(), g2: q() };
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
    // camera space -> world (the view-model camera follows the world camera): pole, offsets
    this.root.parent.getWorldQuaternion(t.camQ);
    for (const side of Object.values(this.sides)) {
      const grip = side.s === 'R' ? hands?.right : hands?.left;
      if (grip) {
        t.T.fromArray(grip.pos).applyMatrix4(weapon.matrixWorld);
        t.fingers.fromArray(grip.fingers).applyQuaternion(t.wq).normalize();
        t.thumb.fromArray(grip.thumb).applyQuaternion(t.wq);
        if (leftAway > 0 && side.s === 'L' && awayOffset) t.T.addScaledVector(_a.copy(awayOffset).applyQuaternion(t.camQ), leftAway);
      } else {
        // no grip: hang the arm down out of the view
        side.upper.getWorldPosition(t.T).add(_a.set(0.05 * side.sign, -0.5, 0.05).applyQuaternion(t.camQ));
        t.fingers.set(0, -1, 0).applyQuaternion(t.camQ);
        t.thumb.set(0, 0, -1).applyQuaternion(t.camQ);
      }
      this._solve(side, t);
      this._curl(side, grip);
    }
  }

  _solve(side, t) {
    const { T, fingers, thumb, rootQ, camQ, S, E, W, n, m, dU, dF, bend, fwd0, along, t0, g, g2 } = t;
    const scale = this.model.scale.x;
    const a = side.lenU * scale, b = side.lenF * scale;
    // shoulder: at rest, or moved toward a grip that the straight arm can't reach (up to `reach`)
    side.upper.position.copy(side.shoulder0);
    side.upper.parent.localToWorld(S.copy(side.shoulder0));
    const over = S.distanceTo(T) - (a + b) * 0.97;
    if (over > 0) {
      S.addScaledVector(n.subVectors(T, S).normalize(), Math.min(over, this.reach));
      side.upper.position.copy(side.upper.parent.worldToLocal(n.copy(S)));
    }
    side.upper.updateMatrixWorld(true);
    const d = THREE.MathUtils.clamp(n.subVectors(T, S).length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
    n.normalize();
    m.copy(this.pole);
    if (side.sign < 0) m.x = -m.x;
    m.applyQuaternion(camQ);
    m.addScaledVector(n, -m.dot(n)).normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    E.copy(S).addScaledVector(n, a * cosA).addScaledVector(m, a * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
    W.copy(S).addScaledVector(n, d);
    // bind frames in world: bone directions, the elbow bending toward the front, the thumb side
    fwd0.copy(side.fwd0).applyQuaternion(rootQ);
    t0.copy(side.t0).applyQuaternion(rootQ);
    // upper arm: along S->E, the forearm bending toward W
    dU.subVectors(E, S).normalize();
    bend.subVectors(W, E).addScaledVector(dU, -bend.dot(dU));
    frameRotation(along.copy(side.dU0).applyQuaternion(rootQ), fwd0, dU, bend, g);
    this._setWorld(side.upper, _q2.copy(g).multiply(rootQ).multiply(side.qU));
    // forearm: along E->W, twist halfway between the elbow hinge and the hand's thumb side
    dF.subVectors(W, E);
    along.copy(side.dF0).applyQuaternion(rootQ);
    frameRotation(along, fwd0, dF, bend.copy(fwd0).applyQuaternion(g), g2);
    frameRotation(along, t0, dF, thumb, g);
    this._setWorld(side.lower, g2.slerp(g, 0.5).multiply(rootQ).multiply(side.qF));
    // hand: fingers / thumb side
    frameRotation(along.copy(side.dH0).applyQuaternion(rootQ), t0, fingers, thumb, g);
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
