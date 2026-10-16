// Frame timings: CPU ms (JS time of the frame incl. encoding the GPU work), GPU ms (WebGPU
// timestamp queries around every render pass, summed per frame; resolved asynchronously a frame or
// two later), FPS, draw calls, triangles. Values are smoothed; `snapshot()` is what the HUD, the
// editor status bar and tools/bench.mjs read. Raw per-frame samples go to the optional
// `onFrame(cpuMs, frameMs)` / `onGpu(ms)` hooks (graphs).
export class Perf {
  constructor(renderer) {
    this.renderer = renderer;
    this.cpuMs = 0;
    this.gpuMs = 0;
    this.fps = 0;
    this.frameMs = 0;
    this._frames = 0;
    this._fpsT = performance.now();
    this._last = performance.now();
    this.calls = 0;
    this.triangles = 0;
    this.history = new Float32Array(240); // frame ms ring for graphs
    this.gpuHistory = new Float32Array(240);
    this.hIndex = 0;
    this.marks = {}; // named CPU sections (ms, smoothed)
    this.onFrame = null;
    this.onGpu = null;
    this._pending = false;
  }

  /** GPU timing available (WebGPU timestamp-query). */
  get gpuTimer() { return !!this.renderer.backend?.trackTimestamp; }

  begin() {
    this._t0 = performance.now();
  }

  end() {
    const now = performance.now();
    const cpu = now - this._t0;
    this.cpuMs += (cpu - this.cpuMs) * 0.1;
    const fm = now - this._last;
    this._last = now;
    this.frameMs += (fm - this.frameMs) * 0.1;
    this.history[this.hIndex] = fm;
    this.gpuHistory[this.hIndex] = this.gpuMs;
    this.hIndex = (this.hIndex + 1) % this.history.length;
    this._frames++;
    if (now - this._fpsT >= 500) {
      this.fps = (this._frames * 1000) / (now - this._fpsT);
      this._fpsT = now;
      this._frames = 0;
    }
    const info = this.renderer.info.render;
    this.calls = info.drawCalls;
    this.triangles = info.triangles;
    this._resolveGpu();
    this.onFrame?.(cpu, fm);
  }

  /** Sum of this frame's render pass timestamps (async: lands a frame or two later). */
  _resolveGpu() {
    if (!this.gpuTimer) return;
    this._unresolved = (this._unresolved ?? 0) + 1;
    if (this._pending) return;
    // the queries of every frame since the last resolve: their sum / the frame count
    const n = this._unresolved;
    this._unresolved = 0;
    this._pending = true;
    this.renderer.resolveTimestampsAsync('render').then((total) => {
      this._pending = false;
      const ms = total / n;
      if (!(ms > 0)) return;
      this.gpuMs += (ms - this.gpuMs) * 0.1;
      this.onGpu?.(ms);
    }, () => { this._pending = false; });
  }

  /** Time a CPU section: perf.mark('ai', () => ...) */
  mark(name, fn) {
    const t = performance.now();
    const r = fn();
    const ms = performance.now() - t;
    this.marks[name] = (this.marks[name] ?? ms) + (ms - (this.marks[name] ?? ms)) * 0.1;
    return r;
  }

  snapshot() {
    const r = (v) => Math.round(v * 100) / 100;
    return {
      fps: r(this.fps), frameMs: r(this.frameMs), cpuMs: r(this.cpuMs), gpuMs: this.gpuTimer ? r(this.gpuMs) : null,
      calls: this.calls, triangles: this.triangles,
      marks: Object.fromEntries(Object.entries(this.marks).map(([k, v]) => [k, r(v)])),
    };
  }
}
