// Engine core: renderer, scene, main camera, lighting, the frame loop (ordered systems, optional
// frame rate cap) and performance counters (CPU / GPU ms, draw calls).
//
// A "system" is any object with update(dt, engine) (and optionally lateUpdate(dt, engine) after
// every system updated, before rendering). Systems run in the order they were added.
import * as THREE from 'three';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { Lighting, QUALITY } from '../render/Lighting.js';
import { LAYERS } from '../render/layers.js';
import { Perf } from './Perf.js';
import { TONE_MAPPING } from '../render/Grade.js';

export class Engine {
  /** antialias (fixed when the WebGL context is created): 'msaa' / 'msaa4' (the canvas' own MSAA, 4x),
   *  'msaa2' / 'msaa8' (offscreen multisampled framebuffer resolved onto the canvas, see _msaaBegin;
   *  clamped to what the GPU supports), 'fxaa' (a post pass on the final image, ~20-30 % less GPU
   *  time than MSAA 4x with this much vegetation), 'off' */
  constructor({ container = document.body, quality = 'medium', fov = 70, far = 2600, antialias = 'msaa' } = {}) {
    this.container = container;
    const aa = antialias === true ? 'msaa' : antialias === false ? 'off' : String(antialias);
    const m = /^msaa(\d*)$/.exec(aa);
    this.aa = m ? 'msaa' : aa;
    this.samples = m ? Number(m[1] || 4) : 0; // MSAA samples (0 = no MSAA)
    const renderer = new THREE.WebGLRenderer({ antialias: this.samples === 4, powerPreference: 'high-performance', stencil: false });
    const gl = renderer.getContext();
    // sample counts the GPU supports for offscreen MSAA (Options only offer x8 when it is there)
    this.msaaCounts = [...(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES) ?? [])];
    if (this.samples && this.samples !== 4) {
      const ok = this.msaaCounts.filter((n) => n <= this.samples);
      this.samples = ok.length ? Math.max(...ok) : Math.min(...this.msaaCounts, 4);
      this._offscreenMsaa = this.samples > 1;
      if (!this._offscreenMsaa) { this.aa = 'off'; this.samples = 0; }
    }
    this.quality = QUALITY[quality] ? quality : 'medium';
    this.maxDpr = Math.min(devicePixelRatio, QUALITY[this.quality].dpr * Math.max(1, devicePixelRatio / 2));
    this.resScale = 1; // resolution factor (x maxDpr, debug panel)
    renderer.setPixelRatio(this.maxDpr);
    renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = TONE_MAPPING; // AgX + grade (render/Grade.js)
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
      if (this._offscreenMsaa) this._msaaBegin();
      this.lighting.prepass(camera);
      renderer.render(scene, camera);
      // sun visibility queries, while the depth buffer still holds the world
      this.lighting.flare.occlude(camera);
      if (this.overlay?.scene && this.overlay.visible !== false) {
        renderer.autoClear = false;
        renderer.clearDepth();
        this.overlay.beforeRender?.();
        this.overlay.scene.matrixWorldAutoUpdate = true;
        renderer.render(this.overlay.scene, this.overlay.camera);
        renderer.autoClear = true;
      }
      this.lighting.flare.render(camera);
      if (this._offscreenMsaa) this._msaaResolve();
      if (this.aa === 'fxaa') this._fxaa();
      // last (after FXAA): the finished frame feeds next frame's water reflections (SSR.js)
      this.lighting.ssr.grab(camera);
    } finally {
      scene.matrixWorldAutoUpdate = auto;
    }
  }

  /** Antialiasing setting as the options name it: 'msaa2' / 'msaa4' / 'msaa8' / 'fxaa' / 'off'. */
  get aaMode() { return this.aa === 'msaa' ? `msaa${this.samples}` : this.aa; }

  /** Offscreen MSAA (x2 / x8): the canvas' MSAA has a fixed sample count, so the frame is drawn into
   *  our own multisampled framebuffer (colour + depth renderbuffers at the drawing buffer size) and
   *  resolved onto the canvas once at the end (_msaaResolve). three draws into it through an external
   *  framebuffer render target (no resolve / invalidation after each render() call, so the world,
   *  the first-person overlay and the flare all land in the same buffer); flagged as an XR target
   *  so materials get the same tone mapping + sRGB output as on the canvas (same shader programs). */
  _msaaBegin() {
    const r = this.renderer, gl = r.getContext(), size = r.getDrawingBufferSize(_size);
    let m = this._msaa;
    if (!m) {
      m = this._msaa = { rt: new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }), fb: gl.createFramebuffer(), color: gl.createRenderbuffer(), depth: gl.createRenderbuffer(), w: 0, h: 0 };
      m.rt.isXRRenderTarget = true;
      m.rt.texture.colorSpace = THREE.SRGBColorSpace;
      r.setRenderTargetFramebuffer(m.rt, m.fb);
    }
    if (m.w !== size.x || m.h !== size.y) {
      m.w = size.x; m.h = size.y;
      for (const [rb, fmt] of [[m.color, gl.RGBA8], [m.depth, gl.DEPTH_COMPONENT24]]) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, fmt, m.w, m.h);
      }
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      r.state.bindFramebuffer(gl.FRAMEBUFFER, m.fb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, m.color);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, m.depth);
      // not setSize(): it would dispose the target (and delete our framebuffer)
      m.rt.width = m.w; m.rt.height = m.h;
      m.rt.viewport.set(0, 0, m.w, m.h);
      m.rt.scissor.set(0, 0, m.w, m.h);
    }
    r.setRenderTarget(m.rt);
  }

  /** Resolve the offscreen MSAA frame onto the canvas, then drop its samples (tile GPUs skip the store). */
  _msaaResolve() {
    const r = this.renderer, gl = r.getContext(), m = this._msaa;
    r.setRenderTarget(null);
    r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, m.fb);
    gl.blitFramebuffer(0, 0, m.w, m.h, 0, 0, m.w, m.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0, gl.DEPTH_ATTACHMENT]);
    r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  /** FXAA over the finished (tone-mapped, sRGB) canvas: copy it, filter it back onto it. */
  _fxaa() {
    const r = this.renderer, size = r.getDrawingBufferSize(_size);
    const f = (this._fx ??= { quad: new FullScreenQuad(new THREE.ShaderMaterial({ ...FXAAShader, uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false })), tex: null });
    if (!f.tex || f.tex.image.width !== size.x || f.tex.image.height !== size.y) {
      f.tex?.dispose();
      f.tex = new THREE.FramebufferTexture(size.x, size.y);
      f.quad.material.uniforms.tDiffuse.value = f.tex;
      f.quad.material.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
    }
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(f.tex);
    f.quad.render(r);
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
    if (this._msaa) {
      const gl = this.renderer.getContext();
      gl.deleteFramebuffer(this._msaa.fb); gl.deleteRenderbuffer(this._msaa.color); gl.deleteRenderbuffer(this._msaa.depth);
    }
    this.renderer.dispose();
    this.canvas.remove();
  }
}

const _size = new THREE.Vector2();

export { LAYERS };
