// Frame timings: CPU ms (JS time of the frame incl. encoding the GPU work), GPU ms (WebGPU
// timestamp queries around every render pass: the time the GPU was busy with the frame's passes;
// resolved asynchronously a frame or two later), FPS, draw calls, triangles. Values are smoothed; `snapshot()` is what the HUD, the
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

  /** GPU time per frame from the render pass timestamps (async: lands a frame or two later). three.js keys each pass' queries by render context + frame: the passes sharing a
   *  context in one frame (world, view model, flare on the canvas) would overwrite each other, so
   *  each allocation gets its own key; Engine sets info.frame (three only counts frames in its own
   *  animation loop). */
  _resolveGpu() {
    if (!this.gpuTimer) return;
    const pool = this.renderer.backend.timestampQueryPool?.render;
    if (pool && !pool.mcKeyed) {
      pool.mcKeyed = true;
      const alloc = pool.allocateQueriesForContext.bind(pool);
      let n = 0;
      pool.allocateQueriesForContext = (uid) => alloc(String(uid).replace(/:f(\d+)$/, `#${n++}:f$1`));
      if (pool._resolveQueries && pool.querySet) pool._resolveQueries = resolveBusyTime;
    }
    if (this._pending) return;
    this._pending = true;
    this.renderer.resolveTimestampsAsync('render').then((ms) => {
      this._pending = false;
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

/**
 * Replaces three.js' WebGPUTimestampQueryPool._resolveQueries: GPU ms = the time covered by the
 * passes' [begin, end] intervals (their union) over the frames resolved together, per frame, instead
 * of the last frame's sum of pass durations. On tile GPUs (Apple) consecutive passes overlap, also
 * across frames (the next pass' vertex work runs during the previous one's fragment work): the sum
 * counted that twice and read more than the frame interval of a GPU-bound page.
 */
async function resolveBusyTime() {
  if (this.isDisposed || this.resultBuffer.mapState !== 'unmapped') return this.lastValue;
  const offsets = new Map(this.queryOffsets), count = this.currentQueryIndex, bytes = count * 8;
  this.currentQueryIndex = 0;
  this.queryOffsets.clear();
  const enc = this.device.createCommandEncoder();
  enc.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
  enc.copyBufferToBuffer(this.resolveBuffer, 0, this.resultBuffer, 0, bytes);
  this.device.queue.submit([enc.finish()]);
  try {
    await this.resultBuffer.mapAsync(GPUMapMode.READ, 0, bytes);
  } catch {
    return this.lastValue;
  }
  if (this.isDisposed) { this.resultBuffer.unmap(); return this.lastValue; }
  const t = new BigUint64Array(this.resultBuffer.getMappedRange(0, bytes));
  const frames = new Set(), spans = [];
  for (const [uid, o] of offsets) {
    frames.add(uid.slice(uid.lastIndexOf(':f') + 2));
    if (t[o + 1] > t[o] && t[o] > 0n) spans.push([t[o], t[o + 1]]);
  }
  this.resultBuffer.unmap();
  spans.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let busy = 0n, s0 = 0n, s1 = 0n;
  for (const [a, b] of spans) {
    if (a > s1) { busy += s1 - s0; s0 = a; s1 = b; } else if (b > s1) s1 = b;
  }
  busy += s1 - s0;
  if (!frames.size) return this.lastValue;
  this.lastValue = Number(busy) / 1e6 / frames.size;
  return this.lastValue;
}
