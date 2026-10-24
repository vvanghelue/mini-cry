// Hands and arms in VR: the first-person arms model (ViewArms: Rocketbox arms, two-bone IK) in the
// world, its shoulders under the head (turned with the head's yaw only), each wrist put where the
// controller is — or on what the hand holds (the gun's grips: VRWeapons.handPose) — and the
// fingers curled by the trigger / grip pressure (the thumb by touching the buttons).
import * as THREE from 'three';
import { ViewArms } from '../player/ViewArms.js';

const UP = new THREE.Vector3(0, 1, 0);
const _f = new THREE.Vector3(), _t = new THREE.Vector3(), _w = new THREE.Vector3();

export class VRHands {
  constructor(vr) {
    this.vr = vr;
    const g = vr.game;
    this.body = new THREE.Group();
    this.body.name = 'VRBody';
    g.engine.scene.add(this.body);
    const model = g.viewModels?.arms;
    // real arm lengths (the desktop view model stretches them)
    const cfg = { ...g.data.player.arms, ...vr.cfg.arms, stretch: 1 };
    try { if (model) this.arms = new ViewArms(model, cfg, this.body); } catch (e) { console.warn('VR arms', e); }
    if (this.arms) g.weapons.vmLight.patch(this.arms.root);
    this.pose = { wrist: new THREE.Vector3(), fingers: new THREE.Vector3(), thumb: new THREE.Vector3(), grip: null };
    this.free = { curl: [[0, 0, 0], 0, 0, 0], thumbCurl: [0, 0, 0], thumbFold: 0 };
    this.body.visible = false;
  }

  update() {
    const vr = this.vr, head = vr.head, W = vr.weapons;
    this.body.visible = vr.presenting && !vr.game.player.inVehicle;
    W.placeHeld();
    if (!this.arms || !this.body.visible) return;
    this.body.position.copy(head.pos);
    this.body.quaternion.setFromAxisAngle(UP, head.yaw);
    this.body.updateMatrixWorld(true);
    for (const side of ['right', 'left']) {
      const h = vr.hands[side], s = side === 'right' ? 'R' : 'L', P = this.pose;
      if (!h.connected) {
        // hanging down by the body
        this.arms.place(s, _w.set(side === 'right' ? 0.22 : -0.22, -0.85, 0.05).applyMatrix4(this.body.matrixWorld), _f.set(0, -1, 0), _t.set(0, 0, -1).applyQuaternion(this.body.quaternion), null);
        continue;
      }
      if (W.handPose(h, P)) { this.arms.place(s, P.wrist, P.fingers, P.thumb, P.grip); continue; }
      // free hand on the controller: the wrist behind the fist, fingers by the buttons
      h.fingers(_f);
      h.thumb(_t);
      _w.copy(h.pos).addScaledVector(_f, -vr.cfg.grip.forward);
      this.arms.place(s, _w, _f, _t, P.grip ?? this._curl(h));
    }
  }

  /** Finger curls of a free hand: index = trigger, the others = grip, thumb on a button = folded. */
  _curl(h) {
    const c = this.free, tr = h.btn.trigger.value, sq = h.btn.squeeze.value;
    const thumb = h.btn.a.touched || h.btn.b.touched || h.btn.thumbrest.touched || h.btn.stick.touched;
    c.curl[0][0] = 8 + 55 * tr; c.curl[0][1] = 10 + 70 * tr; c.curl[0][2] = 8 + 50 * tr;
    c.curl[1] = 12 + 68 * sq; c.curl[2] = 14 + 70 * sq; c.curl[3] = 16 + 72 * sq;
    c.thumbCurl[0] = thumb ? 10 : 4; c.thumbCurl[1] = c.thumbCurl[2] = thumb ? 25 : 6;
    c.thumbFold = thumb ? 35 : 8;
    return c;
  }
}
