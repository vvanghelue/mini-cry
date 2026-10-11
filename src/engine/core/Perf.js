// Frame timings: CPU ms (JS time of the frame incl. issuing GL calls), GPU ms (timer queries,
// EXT_disjoint_timer_query_webgl2 when available), FPS, draw calls, triangles. Values are
// smoothed; `snapshot()` is what the HUD, the editor status bar and tools/bench.mjs read.
// Raw per-frame samples go to the optional `onFrame(cpuMs, frameMs)` / `onGpu(ms)` hooks (graphs).
export class Perf {
  constructor(renderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = [];
    this.pool = [];
    this.active = null;
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
  }

  begin() {
    this._t0 = performance.now();
    this._poll();
    if (this.ext && !this.active) {
      const q = this.pool.pop() || this.gl.createQuery();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this.active = q;
    }
  }

  end() {
    const now = performance.now();
    const cpu = now - this._t0;
    this.cpuMs += (cpu - this.cpuMs) * 0.1;
    if (this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.queries.push(this.active);
      this.active = null;
    }
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
    this.calls = info.calls;
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

  _poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.queries.shift();
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.gpuMs += (ms - this.gpuMs) * 0.1;
        this.onGpu?.(ms);
      }
      this.pool.push(q);
    }
    if (disjoint) { this.pool.push(...this.queries); this.queries.length = 0; }
  }

  snapshot() {
    const r = (v) => Math.round(v * 100) / 100;
    return {
      fps: r(this.fps), frameMs: r(this.frameMs), cpuMs: r(this.cpuMs), gpuMs: this.ext ? r(this.gpuMs) : null,
      calls: this.calls, triangles: this.triangles,
      marks: Object.fromEntries(Object.entries(this.marks).map(([k, v]) => [k, r(v)])),
    };
  }
}
