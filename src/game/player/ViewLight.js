// Lighting of the first-person view models (separate overlay pass, Weapons.js). The view-model
// camera follows the world camera (position + orientation), so the view-model scene is in world
// space and its materials (patch()) are lit like the world's (Lighting.viewLightsNode):
//  - the sun of SunShadows.js with the world's cascaded shadows (the gun goes dark under a tree or a
//    roof; the shadow cameras only draw the world, so the view model casts none);
//  - the baked GI probes at each shaded point in place of the ambient light (GI.js);
//  - sky reflections (the sky gradient around the reflected direction, blurred with roughness),
//    scaled by the probe sky visibility so metal doesn't glow in a bunker.
// SSAO is not applied: its buffer holds the world behind the view model (the overlay clears depth),
// so its occlusion would be the background's; the probes and the shadows darken enclosed places.
import * as THREE from 'three/webgpu';

export class ViewLight {
  /** camera: the view-model camera (kept on the world camera, follow()). */
  constructor(renderer, scene, lighting, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.lighting = lighting;
    this.camera = camera;
    this._patched = new WeakMap(); // source material -> lit node material
    this.intensity = 1; // sky reflection scale (game/player.json arms.envMap: kept for the config)
    this.update(0);
  }

  update() {
    this.follow();
  }

  /** Put the view-model camera on the world camera (call again right before drawing the overlay). */
  follow() {
    const c = this.lighting.camera, v = this.camera;
    if (!v) return;
    c.updateWorldMatrix(true, false);
    c.matrixWorld.decompose(v.position, v.quaternion, _s);
    v.updateMatrixWorld(true);
  }

  /** Light the materials under `root` like the world (sun + shadows, probe GI); once per material. */
  patch(root) {
    const L = this.lighting;
    root.traverse((o) => {
      if (!o.material) return;
      const one = (m) => {
        if (!m || !(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshStandardNodeMaterial || m.isMeshLambertNodeMaterial)) return m;
        if (m.mcView) return m;
        let lit = this._patched.get(m);
        if (!lit) {
          lit = L.patch(m, { smooth: !m.flatShading }, { view: true });
          lit.mcView = true;
          this._patched.set(m, lit);
        }
        return lit;
      };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    });
  }
}

const _s = new THREE.Vector3();
