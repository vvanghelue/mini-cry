// Engine core: renderer, scene, main camera, lighting, the frame loop (ordered systems, optional
// frame rate cap) and performance counters (CPU / GPU ms, draw calls).
//
// Rendering goes through three.js' WebGPURenderer (WebGPU, or its WebGL 2 backend where WebGPU
// is missing, or with `?renderer=webgl`). Every material is a node material (TSL); the display
// transform (tone mapping, grade, sRGB, fog) runs inline in the materials (render/Output.js), so
// the frame is drawn straight into the canvas with no HDR target or output pass. Two modes need a
// frame target instead: FXAA (main passes into an LDR target, then the FXAA pass into the canvas)
// and the water's screen-space reflections (they read the previous frame: two frame targets used
// in turn, no copy).
//
// A "system" is any object with update(dt, engine) (and optionally lateUpdate(dt, engine) after
// every system updated, before rendering). Systems run in the order they were added.
import * as THREE from 'three/webgpu';
import { context, uniform, vec2, floor } from 'three/tsl';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';
import { Lighting, QUALITY } from '../render/Lighting.js';
import { LAYERS } from '../render/layers.js';
import { outputTransform } from '../render/Output.js';
import { Perf } from './Perf.js';

// three.js r186 always sets the texture view `swizzle` to the identity ('rgba', the string form of
// the texture-component-swizzle proposal); browsers that only know the older dictionary form
// (Chromium 141, the headless test browser) reject the whole view. The identity swizzle is the
// default anyway: drop it.
if (typeof GPUTexture !== 'undefined' && !GPUTexture.prototype.createView.mcShim) {
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (desc) {
    if (desc?.swizzle === 'rgba') { const { swizzle, ...rest } = desc; void swizzle; return createView.call(this, rest); }
    return createView.call(this, desc);
  };
  GPUTexture.prototype.createView.mcShim = true;
}

export class Engine {
  /** antialias: 'msaa' (4x MSAA, fixed when the renderer is created), 'fxaa' (a post pass on the
   *  final image, ~20-30 % less GPU time than MSAA with this much vegetation), 'off'.
   *  backend: 'webgpu' (default: WebGPU, WebGL 2 where it is missing) or 'webgl' (force WebGL 2). */
  constructor({ container = document.body, quality = 'medium', fov = 70, far = 2600, antialias = 'msaa', backend = 'webgpu', gpuTimer = true } = {}) {
    this.container = container;
    this.aa = antialias === true ? 'msaa' : antialias === false ? 'off' : antialias;
    const renderer = new THREE.WebGPURenderer({
      antialias: this.aa === 'msaa', powerPreference: 'high-performance', stencil: false, alpha: false,
      forceWebGL: backend === 'webgl', trackTimestamp: gpuTimer,
    });
    this.quality = QUALITY[quality] ? quality : 'medium';
    this.maxDpr = Math.min(devicePixelRatio, QUALITY[this.quality].dpr * Math.max(1, devicePixelRatio / 2));
    this.resScale = 1; // resolution factor (x maxDpr, debug panel)
    renderer.setPixelRatio(this.maxDpr);
    renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    // display transform inline in the materials (render/Output.js): the renderer itself stays linear,
    // so it never allocates its HDR frame buffer and output pass
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.contextNode = context({ getOutput: outputTransform });
    renderer.info.autoReset = false;
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    // resolves once the GPU device is ready (await engine.init() before loading / rendering)
    this._init = renderer.init().then(() => {
      this.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl';
      return this;
    });

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

  /** Wait for the GPU device (WebGPU adapter / WebGL context). */
  init() { return this._init; }

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
    // the renderer's own loop: it advances the node frame (time, per-frame node updates) first
    this.renderer.setAnimationLoop((t) => {
      if (t === undefined) return; // the immediate first call, outside requestAnimationFrame
      if (this.maxFps > 0) {
        // skip the display refreshes that come before the next frame is due (2 ms early is fine:
        // rAF timestamps jitter around the vsync); the schedule advances by whole steps so 60 on
        // a 120 Hz display is exactly every other refresh, and restarts after a stall
        const step = 1000 / this.maxFps;
        if (t < this._nextFrame - 2) return;
        this._nextFrame = t - this._nextFrame > step ? t + step : this._nextFrame + step;
      }
      this.frame(t);
    });
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
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
      // the frame target (FXAA, or the previous frame for the water reflections), else the canvas
      const target = this._frameTarget();
      renderer.setRenderTarget(target);
      // the sun's visibility probes (lens flare occlusion queries) are drawn last in this pass
      renderer.render(scene, camera);
      if (this.overlay?.scene && this.overlay.visible !== false) {
        // view model: same target, its own depth (cleared as the pass begins, colour kept)
        renderer.autoClearColor = false;
        this.overlay.beforeRender?.();
        this.overlay.scene.matrixWorldAutoUpdate = true;
        renderer.render(this.overlay.scene, this.overlay.camera);
        renderer.autoClearColor = true;
      }
      this.lighting.flare.render(camera);
      if (target) this._present(target);
      renderer.setRenderTarget(null);
      // the water reflects this frame next frame (SSR.js)
      this.lighting.ssr.endFrame(camera, target);
    } finally {
      scene.matrixWorldAutoUpdate = auto;
    }
  }

  /** The target of this frame's passes: null (the canvas) unless FXAA or SSR needs one. Two
   *  targets in turn while the water reflects the previous frame. */
  _frameTarget() {
    const ssr = this.lighting.ssr;
    if (this.aa !== 'fxaa' && !ssr.active) return null;
    const size = this.renderer.getDrawingBufferSize(_size);
    const f = (this._frame ??= { rts: [], i: 0 });
    f.i = ssr.active ? 1 - f.i : 0;
    let rt = f.rts[f.i];
    if (!rt) {
      rt = f.rts[f.i] = new THREE.RenderTarget(size.x, size.y, { samples: this.aa === 'msaa' ? 4 : 0, type: THREE.UnsignedByteType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      rt.isMcOutput = true; // display values (render/Output.js)
    }
    if (rt.width !== size.x || rt.height !== size.y) rt.setSize(size.x, size.y);
    return rt;
  }

  /** Frame target -> canvas: FXAA, or a plain copy. */
  _present(rt) {
    const r = this.renderer;
    const p = (this._post ??= { tex: new TexelTextureNode(rt.texture), fxaa: null, copy: null });
    p.tex.value = rt.texture;
    _texels.value.set(rt.width, rt.height);
    const fx = this.aa === 'fxaa';
    let quad = fx ? p.fxaa : p.copy;
    if (!quad) {
      const m = new THREE.NodeMaterial();
      m.colorNode = fx ? fxaa(p.tex) : p.tex;
      m.mcRaw = true; // already display values
      m.depthTest = m.depthWrite = false;
      quad = new THREE.QuadMesh(m);
      if (fx) p.fxaa = quad; else p.copy = quad;
    }
    r.setRenderTarget(null);
    quad.render(r);
  }

  /** Render pipelines created so far (a late one is a frame hitch: World.warmUp, tests). */
  pipelineCount() { return this.renderer._pipelines?.caches.size ?? 0; }

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
    for (const rt of this._frame?.rts ?? []) rt.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

const _size = new THREE.Vector2();

// FXAA reads the frame target texel by texel (each tap snapped to a texel centre), as the WebGL
// version's FXAA read a nearest-filtered copy of the canvas: same look (crisp foliage, only whole
// texels moved at edges). The frame target itself stays linear-filtered for the water reflections.
const _texels = uniform(new THREE.Vector2(1, 1));
class TexelTextureNode extends THREE.TextureNode {
  sample(uv) { return super.sample(floor(vec2(uv).mul(_texels)).add(0.5).div(_texels)); }
}

export { LAYERS };
