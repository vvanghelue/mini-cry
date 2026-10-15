// Frame timings: CPU ms (JS time of the frame incl. encoding the GPU commands), GPU ms (WebGPU
// timestamp queries around every render pass of the frame, summed by three.js; read back
// asynchronously, a frame or two late), FPS, draw calls, triangles. Values are smoothed;
// `snapshot()` is what the HUD, the editor status bar and tools/bench.mjs read.
// Raw per-frame samples go to the optional `onFrame(cpuMs, frameMs)` / `onGpu(ms)` hooks (graphs).
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
    this._gpuPending = false;
    this._gpuSeen = false;
  }

  /** GPU timing is available (WebGPU with the timestamp-query feature, renderer trackTimestamp). */
  get gpuTimer() {
    const b = this.renderer.backend;
    return !!(b?.trackTimestamp && this.renderer.hasFeature?.('timestamp-query'));
  }

  begin() {
    this._t0 = performance.now();
    this._poll();
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
    this.onFrame?.(cpu, fm);
  }

  /** Time a CPU section: perf.mark('ai', () => ...) */
  mark(name, fn) {
    const t = performance.now();
    const r = fn();
    const ms = performance.now() - t;
    this.marks[name] = (this.marks[name] ?? ms) + (ms - (this.marks[name] ?? ms)) * 0.1;
    return r;
  }

  /** Collect the GPU time of the last resolved frame (never waits for the GPU). */
  _poll() {
    if (this._gpuPending || !this.renderer.initialized || !this.gpuTimer) return;
    this._gpuPending = true;
    this.renderer.resolveTimestampsAsync('render').then((ms) => {
      this._gpuPending = false;
      if (!(ms > 0)) return;
      this.gpuMs = this._gpuSeen ? this.gpuMs + (ms - this.gpuMs) * 0.1 : ms;
      this._gpuSeen = true;
      this.onGpu?.(ms);
    }, () => { this._gpuPending = false; });
  }

  snapshot() {
    const r = (v) => Math.round(v * 100) / 100;
    return {
      fps: r(this.fps), frameMs: r(this.frameMs), cpuMs: r(this.cpuMs), gpuMs: this._gpuSeen ? r(this.gpuMs) : null,
      calls: this.calls, triangles: this.triangles,
      marks: Object.fromEntries(Object.entries(this.marks).map(([k, v]) => [k, r(v)])),
    };
  }
}
