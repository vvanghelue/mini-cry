import { render } from 'preact';
import * as THREE from 'three/webgpu';
import { EditorCore, S, log } from './core.js';
import { App } from './ui/App.jsx';
import { Data } from '../engine/core/Data.js';

// Extra editor-core helpers that need the UI context
Object.assign(EditorCore.prototype, {
  /** Asset thumbnail (data URL) rendered offscreen with the main renderer. */
  thumbnail(name) {
    this._thumbQ ??= [];
    return new Promise((resolve) => {
      this._thumbQ.push({ name, resolve });
      if (this._thumbQ.length === 1) requestAnimationFrame(() => this._thumbNext());
    });
  },
  async _thumbNext() {
    const job = this._thumbQ[0];
    if (!job) return;
    const size = 96;
    const r = this.engine.renderer;
    if (!this._thumbRT) {
      // tone mapped + sRGB in the materials (flagged as an output target, render/Grade.js)
      this._thumbRT = new THREE.RenderTarget(size, size, { samples: 4 });
      this._thumbRT.mcOutput = true;
    }
    if (!this._thumbScene) {
      const sc = (this._thumbScene = new THREE.Scene());
      sc.add(new THREE.HemisphereLight(0xdde8ff, 0x6b5a3a, 2.2));
      const d = new THREE.DirectionalLight(0xffffff, 2.5);
      d.position.set(3, 5, 4);
      sc.add(d);
      this._thumbCam = new THREE.PerspectiveCamera(35, 1, 0.01, 500);
      this._thumbMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    }
    let url = '';
    try {
      const b = this.world.assets.build(job.name, { quality: 0.5 });
      const mesh = new THREE.Mesh(b.geometry, this._thumbMat);
      this._thumbScene.add(mesh);
      const s = b.bounds.getSize(new THREE.Vector3()), c = b.bounds.getCenter(new THREE.Vector3());
      const rad = Math.max(s.x, s.y, s.z) * 0.75 + 0.05;
      this._thumbCam.position.set(c.x + rad * 1.6, c.y + rad * 1.0, c.z + rad * 1.9);
      this._thumbCam.lookAt(c);
      const prev = r.getRenderTarget(), prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
      r.setRenderTarget(this._thumbRT);
      // the target holds display values: the clear colour as is
      r.setClearColor(new THREE.Color().setRGB(0x2a / 255, 0x31 / 255, 0x3a / 255, THREE.LinearSRGBColorSpace), 1);
      r.render(this._thumbScene, this._thumbCam);
      r.setRenderTarget(prev);
      r.setClearColor(prevClear, prevAlpha);
      this._thumbScene.remove(mesh);
      // WebGPU rows run top-down: no flip
      const px = await r.readRenderTargetPixelsAsync(this._thumbRT, 0, 0, size, size);
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(size, size);
      img.data.set(px.subarray(0, size * size * 4));
      ctx.putImageData(img, 0, 0);
      url = cv.toDataURL();
    } catch (e) { console.warn('thumb', job.name, e); }
    job.resolve(url);
    this._thumbQ.shift();
    if (this._thumbQ.length) requestAnimationFrame(() => this._thumbNext());
  },
  async playHere() {
    if (Object.keys(S.dirty.value).length) await this.saveAll();
    const c = this.engine.camera.position;
    const h = this.world.terrain.heightAt(c.x, c.z);
    window.open(`/?autostart=1&nointro=1&spawn=${c.x.toFixed(1)},${(h + 0.5).toFixed(1)},${c.z.toFixed(1)},${this.fly.yaw.toFixed(2)}`, 'minicry-game');
  },
  async playFromStart() {
    if (Object.keys(S.dirty.value).length) await this.saveAll();
    window.open('/', 'minicry-game');
  },
});

const ed = new EditorCore();
window.__editor = ed;
Data.jsonOr('sounds.json', { sounds: {} }).then((s) => (ed.sounds = s));
render(<App ed={ed} />, document.getElementById('editor'));
void log;
