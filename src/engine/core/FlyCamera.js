// Free-flying camera (editor viewport, debug "noclip"). Mouse look while the pointer is locked
// (or while the right button is held in the editor), WASD + Q/E down/up, Shift faster.
import * as THREE from 'three';

export class FlyCamera {
  constructor(camera, input, { speed = 30 } = {}) {
    this.camera = camera;
    this.input = input;
    this.speed = speed;
    this.yaw = 0;
    this.pitch = -0.2;
    this.enabled = true;
    this.lookActive = () => input.locked;
    this.minHeightFn = null; // (x, z) -> min camera y (terrain clearance)
  }

  setFrom(pos, yaw, pitch) {
    this.camera.position.copy(pos);
    this.yaw = yaw;
    this.pitch = pitch;
    this.apply();
  }

  lookAt(target) {
    const d = new THREE.Vector3().subVectors(target, this.camera.position);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    this.apply();
  }

  apply() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  update(dt) {
    if (!this.enabled) return;
    const inp = this.input;
    if (this.lookActive()) {
      const l = inp.look();
      this.yaw += l.yaw;
      this.pitch = THREE.MathUtils.clamp(this.pitch + l.pitch, -1.55, 1.55);
    } else inp.look();
    this.apply();
    const f = (inp.down('forward') ? 1 : 0) - (inp.down('back') ? 1 : 0);
    const s = (inp.down('right') ? 1 : 0) - (inp.down('left') ? 1 : 0);
    const u = (inp.keyDown('KeyE') ? 1 : 0) - (inp.keyDown('KeyQ') ? 1 : 0);
    const v = new THREE.Vector3(s, u, -f);
    if (v.lengthSq() > 0) {
      v.normalize().applyEuler(new THREE.Euler(this.pitch * (u ? 0 : 1), this.yaw, 0, 'YXZ'));
      const boost = inp.down('sprint') ? 4 : inp.keyDown('AltLeft') ? 0.25 : 1;
      this.camera.position.addScaledVector(v, this.speed * boost * dt);
    }
    if (this.minHeightFn) {
      const p = this.camera.position;
      p.y = Math.max(p.y, this.minHeightFn(p.x, p.z));
    }
  }
}
