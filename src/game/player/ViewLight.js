// Lighting of the first-person view models (separate overlay pass, Weapons.js). The view-model
// camera follows the world camera (position + orientation), so the view-model scene is in world
// space and its materials (patch()) are lit like the world's:
//  - the sun of SunShadows.js with the world's cascaded shadows (the gun goes dark under a tree or a
//    roof; the shadow cameras only draw the world, so the view model casts none);
//  - the baked GI probes at each shaded point in place of the ambient light (GI.js, through a
//    hemisphere light that mirrors the world's: its fallback without GI);
//  - sky reflections from a small procedural sky (zenith / horizon of the time of day, ground
//    bounce, a soft sun glow, a darker tree line) turned into a PMREM, specular only, scaled by
//    the probe sky visibility (giOcc) so metal doesn't glow in a bunker.
// SSAO is not applied: its buffer holds the world behind the view model (the overlay clears depth),
// so its occlusion would be the background's; the probes and the shadows darken enclosed places.
// The environment is re-rendered only when the sky colours change (time of day), at most once a
// second: a 32 px cube + the PMREM passes into reused targets.
import * as THREE from 'three';

// diffuse comes from the probes (GI.js); the environment map only reflects, occluded like the world's
const IBL_DIFFUSE = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const IBL_SPECULAR = 'radiance += iblRadiance;';
const MAPS_CHUNK = THREE.ShaderChunk.lights_fragment_maps.replace(IBL_DIFFUSE, '').replace(IBL_SPECULAR, 'radiance += iblRadiance * giOcc;');

const ENV_SIZE = 32;

export class ViewLight {
  /** camera: the view-model camera (kept on the world camera, follow()). */
  constructor(renderer, scene, lighting, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.lighting = lighting;
    this.camera = camera;
    // ambient without GI (and the GI floor): the world's hemisphere light, copied every frame
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    scene.add(this.hemi);
    this._patched = new WeakSet();
    this.u = {
      zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() },
    };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.u, side: THREE.BackSide, depthWrite: false, depthTest: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith, horizon, ground, sunDir, sunCol;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.5)) : mix(horizon * 0.5, ground, min(-h * 4.0, 1.0));
          // tree line / hills: a darker, greener band just above the horizon, uneven in azimuth
          float a = atan(d.z, d.x);
          float top = 0.06 + 0.05 * (0.5 + 0.5 * sin(a * 5.0 + 1.3) * sin(a * 3.0 - 0.4));
          col = mix(col, ground * vec3(0.55, 0.75, 0.5), smoothstep(top + 0.02, top - 0.02, h) * step(-0.02, h) * 0.85);
          float sd = max(dot(d, sunDir), 0.0);
          col += sunCol * (pow(sd, 6.0) * 0.35 + pow(sd, 64.0) * 1.5);
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
    sky.frustumCulled = false;
    this.envScene = new THREE.Scene();
    this.envScene.add(sky);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmremRT = null;
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
    if (key !== this._key && !(now - (this._at ?? -1e9) < 1000)) {
      this._key = key;
      this._at = now;
      this.cubeCam.update(this.renderer, this.envScene);
      this.pmremRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.pmremRT);
      this.scene.environment = this.pmremRT.texture;
    }
    const h = L.hemi;
    this.hemi.color.copy(h.color);
    this.hemi.groundColor.copy(h.groundColor);
    this.hemi.intensity = h.intensity;
    // sky radiance of an open sky (a hemisphere light of intensity I lights like an environment of
    // radiance colour x I / PI); the shader occludes it with the probes
    this.scene.environmentIntensity = (h.intensity / Math.PI) * this.intensity;
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
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (this._patched.has(m) || !(m.isMeshStandardMaterial || m.isMeshLambertMaterial)) continue;
        this._patched.add(m);
        const prev = m.onBeforeCompile;
        m.onBeforeCompile = (sh, r) => {
          prev?.call(m, sh, r);
          L.sun.inject(sh);
          L.gi.inject(sh);
          sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_maps>', () => MAPS_CHUNK);
        };
        const prevKey = m.customProgramCacheKey?.bind(m);
        m.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|vm`;
        m.needsUpdate = true;
      }
    });
  }
}

const _s = new THREE.Vector3();
