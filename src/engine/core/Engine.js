// Engine core: renderer, scene, main camera, lighting, the frame loop (ordered systems, optional
// frame rate cap) and performance counters (CPU / GPU ms, draw calls).
//
// A "system" is any object with update(dt, engine) (and optionally lateUpdate(dt, engine) after
// every system updated, before rendering). Systems run in the order they were added.
import * as THREE from 'three';
import { Lighting, QUALITY } from '../render/Lighting.js';
import { LAYERS } from '../render/layers.js';
import { Perf } from './Perf.js';

export class Engine {
  constructor({ container = document.body, quality = 'medium', fov = 70, far = 2600 } = {}) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.quality = QUALITY[quality] ? quality : 'medium';
    this.maxDpr = Math.min(devicePixelRatio, QUALITY[this.quality].dpr * Math.max(1, devicePixelRatio / 2));
    this.resScale = 1; // resolution factor (x maxDpr, debug panel)
    renderer.setPixelRatio(this.maxDpr);
    renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.info.autoReset = false;
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.canvas = renderer.domElement;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.camera = new THREE.PerspectiveCamera(fov, renderer.domElement.clientWidth / renderer.domElement.clientHeight, 0.08, far);
    this.camera.position.set(0, 60, 0);
    this.scene.add(this.camera);

    this.lighting = new Lighting(renderer, this.scene, this.camera, { quality: this.quality });
    this.perf = new Perf(renderer);
    this.systems = [];
    this.timeScale = 1;
    this.paused = false;
    this.running = false;
    this.frameCount = 0;
    this.elapsed = 0;
    this.maxFps = 0; // frame rate cap (0 = one frame per display refresh)
    this._nextFrame = 0;
    // optional overlay pass (first-person weapon): { scene, camera } rendered after clearing depth
    this.overlay = null;
    this.clock = new THREE.Timer();
    this._raf = 0;
    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
    // the editor changes the viewport size without a window resize (panels, layout)
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => {
        const w = container.clientWidth, h = container.clientHeight;
        if (w && h && (w !== this._lastW || h !== this._lastH)) { this._lastW = w; this._lastH = h; this.resize(); }
      });
      this._ro.observe(container);
    }
    this.events = new EventTarget();
  }

  on(type, fn) { this.events.addEventListener(type, (e) => fn(e.detail)); }
  emit(type, detail) { this.events.dispatchEvent(new CustomEvent(type, { detail })); }

  addSystem(sys, { before } = {}) {
    if (before) {
      const i = this.systems.indexOf(before);
      this.systems.splice(i < 0 ? this.systems.length : i, 0, sys);
    } else this.systems.push(sys);
    return sys;
  }

  removeSystem(sys) {
    const i = this.systems.indexOf(sys);
    if (i >= 0) this.systems.splice(i, 1);
  }

  resize() {
    const w = this.container.clientWidth || innerWidth, h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.overlay?.camera) { this.overlay.camera.aspect = w / h; this.overlay.camera.updateProjectionMatrix(); }
    this.emit('resize', { w, h });
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.quality = name;
    this.lighting.setQuality(name);
    this.maxDpr = Math.min(devicePixelRatio, QUALITY[name].dpr * Math.max(1, devicePixelRatio / 2));
    this.resScale = 1;
    this.renderer.setPixelRatio(this.maxDpr);
    this.emit('quality', name);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (t) => {
      this._raf = requestAnimationFrame(loop);
      if (this.maxFps > 0) {
        // skip the display refreshes that come before the next frame is due (2 ms early is fine:
        // rAF timestamps jitter around the vsync); the schedule advances by whole steps so 60 on
        // a 120 Hz display is exactly every other refresh, and restarts after a stall
        const step = 1000 / this.maxFps;
        if (t < this._nextFrame - 2) return;
        this._nextFrame = t - this._nextFrame > step ? t + step : this._nextFrame + step;
      }
      this.frame(t);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  frame(t) {
    this.perf.begin();
    this.clock.update(t);
    const real = Math.min(this.clock.getDelta(), 0.1);
    const dt = this.paused ? 0 : Math.min(real, 1 / 20) * this.timeScale;
    this.realDt = real;
    this.dt = dt;
    this.elapsed += dt;
    this.frameCount++;
    this.renderer.info.reset();
    for (const s of this.systems) if (s.update && s.enabled !== false) s.update(dt, this);
    for (const s of this.systems) if (s.lateUpdate && s.enabled !== false) s.lateUpdate(dt, this);
    this.render();
    this.perf.end(this);
  }

  render() {
    const { renderer, scene, camera } = this;
    scene.updateMatrixWorld();
    const auto = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    try {
      this.lighting.prepass(camera);
      renderer.render(scene, camera);
      // sun visibility queries, while the depth buffer still holds the world
      this.lighting.flare.occlude(camera);
      if (this.overlay?.scene && this.overlay.visible !== false) {
        renderer.autoClear = false;
        renderer.clearDepth();
        this.overlay.scene.matrixWorldAutoUpdate = true;
        renderer.render(this.overlay.scene, this.overlay.camera);
        renderer.autoClear = true;
      }
      this.lighting.flare.render(camera);
    } finally {
      scene.matrixWorldAutoUpdate = auto;
    }
  }

  /** Screen-space -> world ray through the main camera (ndc in [-1, 1]). */
  rayFromNdc(x, y, ray = new THREE.Ray()) {
    ray.origin.setFromMatrixPosition(this.camera.matrixWorld);
    ray.direction.set(x, y, 0.5).unproject(this.camera).sub(ray.origin).normalize();
    return ray;
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this._ro?.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

export { LAYERS };
