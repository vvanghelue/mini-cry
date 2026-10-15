// Lighting of the first-person view models (separate overlay pass, Weapons.js). The view-model
// camera follows the world camera (position + orientation), so the view-model scene is in world
// space and its materials (patch(): world materials, render/WorldMaterial.js) are lit like the
// world's:
//  - the sun of SunShadows.js with the world's cascaded shadows (the gun goes dark under a tree or a
//    roof; the shadow cameras only draw the world, so the view model casts none);
//  - the baked GI probes at each shaded point in place of the ambient light (GI.js; the
//    hemisphere light of the time of day without GI);
//  - sky reflections from a small procedural sky (zenith / horizon of the time of day, ground
//    bounce, a soft sun glow, a darker tree line) turned into a PMREM, specular only, scaled by
//    the probe sky visibility so metal doesn't glow in a bunker.
// SSAO is not applied: its buffer holds the world behind the view model (the overlay clears depth),
// so its occlusion would be the background's; the probes and the shadows darken enclosed places.
// The environment is re-rendered only when the sky colours change (time of day), at most once a
// second: a 32 px cube + the PMREM passes into reused targets.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, varying, vec3, vec4, float, normalize, dot, max, min, mix, pow, sin, atan, smoothstep, step, select, positionLocal, positionViewDirection, normalView, roughness,
  cameraWorldMatrix, pmremTexture, materialReference, reflect,
} from 'three/tsl';

const ENV_SIZE = 32;

export class ViewLight {
  /** camera: the view-model camera (kept on the world camera, follow()). */
  constructor(renderer, scene, lighting, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.lighting = lighting;
    this.camera = camera;
    this._patched = new WeakMap();
    this.u = {
      zenith: uniform(new THREE.Color()), horizon: uniform(new THREE.Color()), ground: uniform(new THREE.Color()),
      sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunCol: uniform(new THREE.Color()),
    };
    const u = this.u;
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
    const vDir = varying(positionLocal, 'vEnvDir');
    m.colorNode = Fn(() => {
      const d = normalize(vDir).toVar();
      const h = d.y;
      const col = select(h.greaterThan(0), mix(u.horizon, u.zenith, pow(max(h, 0), 0.5)), mix(u.horizon.mul(0.5), u.ground, min(h.negate().mul(4), 1))).toVar();
      // tree line / hills: a darker, greener band just above the horizon, uneven in azimuth
      const a = atan(d.z, d.x);
      const top = float(0.06).add(sin(a.mul(5).add(1.3)).mul(sin(a.mul(3).sub(0.4))).mul(0.5).add(0.5).mul(0.05));
      col.assign(mix(col, u.ground.mul(vec3(0.55, 0.75, 0.5)), smoothstep(top.add(0.02), top.sub(0.02), h).mul(step(-0.02, h)).mul(0.85)));
      const sd = max(dot(d, u.sunDir), 0);
      col.addAssign(u.sunCol.mul(pow(sd, 6).mul(0.35).add(pow(sd, 64).mul(1.5))));
      return col;
    })();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), m);
    sky.frustumCulled = false;
    this.envScene = new THREE.Scene();
    this.envScene.add(sky);
    this.cubeRT = new THREE.CubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmremRT = null;
    this.envIntensity = uniform(1); // radiance of an open sky (scene.environmentIntensity of the WebGL version)
    this._key = '';
    this.intensity = 1; // env map scale (game/player.json arms.envMap multiplies it in the materials)
    this.update(0);
  }

  update() {
    const L = this.lighting, u = this.u;
    // sky colours of the time of day -> re-render the environment when they changed
    u.zenith.value.copy(L.skyU.zenith.value);
    u.horizon.value.copy(L.skyU.horizon.value);
    u.ground.value.copy(L.hemi.groundColor);
    u.sunDir.value.copy(L.realSunDir ?? L.sunDir);
    u.sunCol.value.copy(L.skyU.sunCol.value);
    const key = [u.zenith.value, u.horizon.value, u.ground.value, u.sunCol.value].map((c) => c.getHexString()).join('') + u.sunDir.value.toArray().map((x) => Math.round(x * 50)).join(',');
    const now = performance.now();
    if (this.renderer.initialized && key !== this._key && !(now - (this._at ?? -1e9) < 1000)) {
      this._key = key;
      this._at = now;
      this.cubeCam.update(this.renderer, this.envScene);
      this.pmremRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.pmremRT);
    }
    // sky radiance of an open sky (a hemisphere light of intensity I lights like an environment of
    // radiance colour x I / PI); the shader occludes it with the probes
    this.envIntensity.value = (L.hemi.intensity / Math.PI) * this.intensity;
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

  /** Environment radiance (specular) of a view-model fragment, for the world lighting model. */
  _env() {
    if (!this._envFn) {
      const tex = this.pmremRT?.texture ?? this.cubeRT.texture; // the PMREM target is reused: same texture
      this._envFn = () => {
        const n = normalView;
        // mixing the reflection with the normal keeps rough objects from gathering light from behind
        const r = normalize(mix(reflect(positionViewDirection.negate(), n), n, pow(roughness, 4)));
        const rW = normalize(cameraWorldMatrix.mul(vec4(r, 0)).xyz);
        // x the material's own envMapIntensity (player.json arms.envMap)
        return pmremTexture(tex, rW, roughness).rgb.mul(this.envIntensity).mul(materialReference('envMapIntensity', 'float'));
      };
    }
    return this._envFn;
  }

  /** Light the materials under `root` like the world (sun + shadows, probe GI, environment
   *  reflections; no SSAO): their materials are replaced by world materials, once per material. */
  patch(root) {
    const L = this.lighting;
    root.traverse((o) => {
      if (!o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const out = list.map((m) => {
        if (!(m.isMeshStandardMaterial || m.isMeshLambertMaterial) || m.isWorldMaterial) return m;
        let w = this._patched.get(m);
        if (!w) {
          w = L.patch(m);
          w.mcCfg = { ao: false, sky: false, env: w.isMeshStandardNodeMaterial ? this._env() : null };
          this._patched.set(m, w);
        }
        return w;
      });
      o.material = Array.isArray(o.material) ? out : out[0];
    });
  }
}

const _s = new THREE.Vector3();
