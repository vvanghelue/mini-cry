// Lighting of the first-person view models (separate overlay pass, Weapons.js): the sun (dimmed
// where the sky is hidden, GI.js openness) and image-based light from a small procedural sky
// (zenith / horizon of the time of day, ground bounce, a soft sun glow, a darker tree line) turned
// into a PMREM, so the PBR weapons and arms get sky reflections on their metal and a sky / ground
// ambient. The environment is re-rendered only when the sky colours change (time of day), at most
// once a second: a 32 px cube + the PMREM passes into reused targets; its brightness follows the
// probe light at the eye every frame.
import * as THREE from 'three';

const ENV_SIZE = 32;

export class ViewLight {
  constructor(renderer, scene, lighting) {
    this.renderer = renderer;
    this.scene = scene;
    this.lighting = lighting;
    this.sun = new THREE.DirectionalLight(0xffffff, 1); // colour = the world sun's (colour x intensity)
    scene.add(this.sun, this.sun.target);
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
    this._e = [0, 0, 0];
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
    // sun: dimmed where the sky is hidden; ambient: the probe light at the eye (sky / bounce),
    // or the hemisphere light without GI. A hemisphere light of intensity I lights like an
    // environment of radiance colour x I / PI.
    this.sun.color.copy(L.sunColor);
    this.sun.position.copy(L.sunDir).multiplyScalar(5);
    let k = L.hemi.intensity;
    if (L.gi.active) {
      const e = this._e;
      L.gi.cameraIrradiance(0, 1, 0, e, L.hemi);
      const up = 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2];
      const sky = L.hemi.color, ref = (0.2126 * sky.r + 0.7152 * sky.g + 0.0722 * sky.b) * L.hemi.intensity;
      k = ref > 1e-4 ? L.hemi.intensity * THREE.MathUtils.clamp(up / ref, 0.1, 1.5) : L.hemi.intensity;
      this.sun.color.multiplyScalar(Math.min(1, Math.max(0.15, L.gi.openness)));
    }
    this.scene.environmentIntensity = (k / Math.PI) * this.intensity;
  }
}
