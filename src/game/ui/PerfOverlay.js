// Stats overlay (bottom right, F3 toggles): shown by default (?stats=0 hides it; automated runs
// with ?bot / ?bench / ?nohud start without it). stats.js-style graph panels for
// FPS, CPU ms (JS time of the frame incl. issuing GL calls), GPU ms (timer queries, when the
// browser exposes EXT_disjoint_timer_query_webgl2), draw calls and JS heap (Chromium only), plus
// a caption line (resolution scale, triangles, CPU marks). CPU / GPU graphs get a dashed line at
// the 120 fps budget (8.3 ms). Raw samples come from the engine's Perf hooks, so no extra queries.
const BUDGET_MS = 1000 / 120;

// One graph: `${value} NAME (min-max)` over the visible history, bars scaled to `max`.
class Panel {
  constructor(name, fg, bg, { max, budget = 0, decimals = 0, width = 92 }) {
    this.name = name; this.fg = fg; this.bg = bg; this.max = max; this.budget = budget; this.decimals = decimals;
    const pr = (this.pr = Math.max(1, Math.round(devicePixelRatio || 1)));
    this.w = width * pr; this.h = 48 * pr;
    this.gx = 3 * pr; this.gy = 15 * pr; this.gw = this.w - 6 * pr; this.gh = 30 * pr;
    this.values = new Float32Array(Math.floor(this.gw / pr)); // one column per sample
    this.n = 0;
    this.dom = Object.assign(document.createElement('canvas'), { width: this.w, height: this.h });
    this.dom.style.cssText = `width:${width}px;height:48px`;
    this.ctx = this.dom.getContext('2d');
    this.ctx.font = `bold ${9 * pr}px Helvetica,Arial,sans-serif`;
    this.ctx.textBaseline = 'top';
    this._label(`${name}`);
    this._graphBg();
  }

  _label(text) {
    const c = this.ctx;
    c.globalAlpha = 1;
    c.fillStyle = this.bg;
    c.fillRect(0, 0, this.w, this.gy);
    c.fillStyle = this.fg;
    c.fillText(text, 3 * this.pr, 2 * this.pr);
  }

  _graphBg() {
    const c = this.ctx;
    c.fillStyle = this.fg;
    c.fillRect(this.gx, this.gy, this.gw, this.gh);
    c.fillStyle = this.bg;
    c.globalAlpha = 0.9;
    c.fillRect(this.gx, this.gy, this.gw, this.gh);
    c.globalAlpha = 1;
  }

  /** Text only (no graph), e.g. "GPU n/a". */
  message(text) { this._label(text); }

  update(v) {
    const vals = this.values, len = vals.length;
    vals.copyWithin(0, 1);
    vals[len - 1] = v;
    this.n = Math.min(len, this.n + 1);
    let lo = Infinity, hi = 0;
    for (let i = len - this.n; i < len; i++) { if (vals[i] < lo) lo = vals[i]; if (vals[i] > hi) hi = vals[i]; }
    const f = (x) => x.toFixed(this.decimals);
    this._label(`${f(v)} ${this.name} (${f(lo)}-${f(hi)})`);
    // scroll the graph one column left, draw the new column
    const c = this.ctx, pr = this.pr, x = this.gx + this.gw - pr;
    c.drawImage(this.dom, this.gx + pr, this.gy, this.gw - pr, this.gh, this.gx, this.gy, this.gw - pr, this.gh);
    c.fillStyle = this.fg;
    c.fillRect(x, this.gy, pr, this.gh);
    c.fillStyle = this.bg;
    c.globalAlpha = 0.9;
    c.fillRect(x, this.gy, pr, Math.round((1 - Math.min(1, v / this.max)) * this.gh));
    c.globalAlpha = 1;
    // budget line (dashed: one pixel every other column)
    if (this.budget && (this._dash = !this._dash)) {
      c.fillStyle = '#fff';
      c.fillRect(x, this.gy + Math.round((1 - this.budget / this.max) * this.gh), pr, pr);
    }
  }
}

export class PerfOverlay {
  constructor(engine) {
    this.engine = engine;
    const params = new URLSearchParams(location.search);
    this.el = Object.assign(document.createElement('div'), { id: 'perf' });
    this.caption = Object.assign(document.createElement('div'), { className: 'perf-caption' });
    const row = Object.assign(document.createElement('div'), { className: 'perf-panels' });
    this.el.append(this.caption, row);
    const add = (p) => (row.appendChild(p.dom), p);
    this.fps = add(new Panel('FPS', '#0ff', '#002', { max: 144 }));
    this.cpu = add(new Panel('CPU', '#0f0', '#020', { max: 2 * BUDGET_MS, budget: BUDGET_MS, decimals: 1 }));
    this.gpu = add(new Panel('GPU', '#fa0', '#210', { max: 2 * BUDGET_MS, budget: BUDGET_MS, decimals: 1 }));
    this.dc = add(new Panel('DC', '#ff0', '#220', { max: 1500 }));
    if (performance.memory) this.mem = add(new Panel('MB', '#f08', '#201', { max: 1024 }));
    this.cpu.dom.title = this.gpu.dom.title = 'dashed line: 8.3 ms (120 fps budget)';
    if (!engine.perf.ext) { this.gpu.message('GPU n/a'); this.gpu.dom.title = 'GPU timer queries not supported by this browser'; }
    document.body.appendChild(this.el);
    const flag = params.get('stats');
    this.setVisible(flag !== null ? flag !== '0' : params.has('perf') || !(params.has('bot') || params.has('bench') || params.has('nohud')));

    this._frames = 0;
    this._fpsT = performance.now();
    this._dcMax = 0;
    this._dcT = this._fpsT;
    engine.perf.onFrame = (cpu) => this._frame(cpu);
    engine.perf.onGpu = (ms) => { if (!this.el.hidden) this.gpu.update(ms); };
    addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); this.setVisible(this.el.hidden); } });
    setInterval(() => this._refreshCaption(), 250);
  }

  get visible() { return !this.el.hidden; }

  setVisible(v) {
    this.el.hidden = !v;
    document.body.classList.toggle('perf-on', !!v); // lifts the bottom-right HUD above the panels
  }

  hide() { this.setVisible(false); }

  _frame(cpu) {
    if (this.el.hidden) return;
    const now = performance.now(), perf = this.engine.perf;
    this.cpu.update(cpu);
    this._frames++;
    this._dcMax = Math.max(this._dcMax, perf.calls);
    // draw calls: worst frame of each 250 ms (shadow cascades are not redrawn every frame)
    if (now - this._dcT >= 250) { this.dc.update(this._dcMax); this._dcMax = 0; this._dcT = now; }
    if (now - this._fpsT >= 1000) {
      this.fps.update((this._frames * 1000) / (now - this._fpsT));
      if (this.mem) this.mem.update(performance.memory.usedJSHeapSize / 1048576);
      this._frames = 0;
      this._fpsT = now;
    }
  }

  _refreshCaption() {
    if (this.el.hidden) return;
    const e = this.engine, s = e.perf.snapshot(), c = e.canvas;
    const marks = Object.entries(s.marks).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · ');
    this.caption.textContent = `res ${(e.resScale * e.maxDpr).toFixed(2)} (${c.width}×${c.height}) · ${(s.triangles / 1000).toFixed(0)}k tris${marks ? ' · ' + marks : ''}`;
  }
}
