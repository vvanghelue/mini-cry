// Engine core: renderer (three.js WebGPURenderer: WebGPU, WebGL 2 where WebGPU is missing),
// scene, main camera, lighting, the frame loop (ordered systems, optional frame rate cap) and
// performance counters (CPU / GPU ms, draw calls).
//
// A "system" is any object with update(dt, engine) (and optionally lateUpdate(dt, engine) after
// every system updated, before rendering). Systems run in the order they were added.
//
// Call `await engine.init()` once before rendering (WebGPU adapter / device).
import * as THREE from 'three/webgpu';
import { Fn, vec4, texture } from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { Lighting, QUALITY } from '../render/Lighting.js';
import { LAYERS } from '../render/layers.js';
import { outputContext } from '../render/Grade.js';
import { Perf } from './Perf.js';

export class Engine {
  /** antialias (fixed when the renderer is created): 'msaa' / 'msaa4' (the canvas' own MSAA, 4x;
   *  WebGPU offers 1 or 4 samples: 'msaa2' / 'msaa8' fall back to 4x), 'fxaa' (a post pass on the
   *  final image, ~20-30 % less GPU time than MSAA 4x with this much vegetation), 'off' */
  constructor({ container = document.body, quality = 'medium', fov = 70, far = 2600, antialias = 'msaa' } = {}) {
    this.container = container;
    const aa = antialias === true ? 'msaa' : antialias === false ? 'off' : String(antialias);
    const m = /^msaa(\d*)$/.exec(aa);
    this.aa = m ? 'msaa' : aa;
    this.samples = m ? 4 : 0; // MSAA samples (0 = no MSAA)
    this.msaaCounts = [4];
    const renderer = createRenderer({ antialias: this.samples === 4, trackTimestamp: true });
    this.quality = QUALITY[quality] ? quality : 'medium';
    this.maxDpr = Math.min(devicePixelRatio, QUALITY[this.quality].dpr * Math.max(1, devicePixelRatio / 2));
    this.resScale = 1; // resolution factor (x maxDpr, debug panel)
    renderer.setPixelRatio(this.maxDpr);
    renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
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
    // optional overlay pass (first-person weapon): { scene, camera, beforeRender? } rendered after clearing depth
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

  /** Create the GPU device (WebGPU, else the WebGL 2 fallback). Required before rendering. */
  async init() {
    await this.renderer.init();
    this.backend = this.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    this.lighting.init?.();
    return this;
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
    const fx = this.aa === 'fxaa' ? this._fxaaTarget() : null;
    try {
      this.lighting.prepass(camera);
      // the sun probes (occlusion queries) and the flare ride along in the main pass (LensFlare.js)
      this.lighting.flare.beforeRender(camera);
      renderer.setRenderTarget(fx);
      renderer.render(scene, camera);
      if (this.overlay?.scene && this.overlay.visible !== false) {
        // over the world: same colour buffer, depth cleared (one pass, no separate clear)
        renderer.autoClearColor = false;
        this.overlay.beforeRender?.();
        this.overlay.scene.matrixWorldAutoUpdate = true;
        renderer.render(this.overlay.scene, this.overlay.camera);
        renderer.autoClearColor = true;
      }
      this.lighting.flare.render(camera);
      if (fx) this._fxaa();
      // last: the finished frame feeds next frame's water reflections (SSR.js)
      this.lighting.ssr.grab(camera, fx);
    } finally {
      renderer.setRenderTarget(null);
      scene.matrixWorldAutoUpdate = auto;
    }
  }

  /** Antialiasing setting as the options name it: 'msaa4' / 'fxaa' / 'off'. */
  get aaMode() { return this.aa === 'msaa' ? `msaa${this.samples}` : this.aa; }

  /** FXAA: the frame is drawn (tone mapped, sRGB: flagged as output) into this target, then filtered
   *  onto the canvas. */
  _fxaaTarget() {
    const size = this.renderer.getDrawingBufferSize(_size);
    let f = this._fx;
    if (!f) {
      const rt = new THREE.RenderTarget(size.x, size.y, { type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      rt.mcOutput = true;
      const src = texture(rt.texture);
      const mat = new THREE.NodeMaterial();
      mat.fragmentNode = Fn(() => vec4(fxaa(src).rgb, 1.0))();
      mat.depthTest = mat.depthWrite = false;
      f = this._fx = { rt, quad: new THREE.QuadMesh(mat) };
    }
    if (f.rt.width !== size.x || f.rt.height !== size.y) f.rt.setSize(size.x, size.y);
    return f.rt;
  }

  /** FXAA over the finished (tone-mapped, sRGB) frame, onto the canvas. */
  _fxaa() {
    const r = this.renderer;
    r.setRenderTarget(null);
    this._fx.quad.render(r);
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
    this._fx?.rt.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

const _size = new THREE.Vector2();

/** A WebGPU renderer (WebGL 2 where WebGPU is missing, or with ?webgl=1) set up the engine's way:
 *  output straight to the canvas, tone mapping + sRGB inside the materials (Grade.js: no HDR buffer
 *  and output pass). Call `await renderer.init()` before rendering. */
export function createRenderer({ canvas, antialias = true, trackTimestamp = false } = {}) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
    trackTimestamp,
    forceWebGL: params.get('webgl') === '1',
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.contextNode = outputContext();
  return renderer;
}

export { LAYERS };
