// Waveform of the rendered sound (min / max per pixel), its RMS amplitude envelope, the dry length
// / reverb tail, the layer timeline (click a bar to select the layer) and the playhead.
// Wheel = zoom around the cursor, drag = pan, double-click = show everything.
import { useEffect, useRef, useState } from 'preact/hooks';
import { LAYER_COLORS } from './templates.js';
import { SAMPLE_RATE } from './render.js';

const WH = 140, AXIS = 16, ROW = 11;

function niceStep(span, n = 8) {
  const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}
const tLabel = (t, step) => (step < 1 ? `${+(t * 1000).toFixed(step < 0.01 ? 1 : 0)} ms` : `${+t.toFixed(2)} s`);

export function Waveform({ samples, timeline, sel, onSelect, loop, playhead }) {
  const wrap = useRef(null), base = useRef(null), over = useRef(null);
  const [w, setW] = useState(800);
  const [view, setView] = useState(null); // [t0, t1] or null = all
  const hover = useRef(null);
  const rows = timeline?.rows ?? [];
  const H = WH + AXIS + Math.max(1, rows.length) * ROW + 6;
  const total = Math.max(samples ? samples.length / SAMPLE_RATE : 0, timeline?.dry ?? 0, 0.01);
  const [v0, v1] = view ? [Math.max(0, view[0]), Math.min(total, view[1])] : [0, total];

  useEffect(() => {
    const ro = new ResizeObserver((e) => setW(Math.max(200, Math.floor(e[0].contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // static layer
  useEffect(() => {
    const c = base.current;
    const dpr = devicePixelRatio || 1;
    c.width = w * dpr; c.height = H * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#12161a'; g.fillRect(0, 0, w, H);
    const span = Math.max(1e-6, v1 - v0), X = (t) => ((t - v0) / span) * w;
    const mid = WH / 2, amp = WH / 2 - 6;
    // tail region (reverb / echo after the dry length)
    if (!loop && timeline && timeline.dry < total - 1e-3) {
      g.fillStyle = 'rgba(255,255,255,0.035)';
      g.fillRect(X(timeline.dry), 0, w - X(timeline.dry), WH);
    }
    // grid
    g.strokeStyle = '#232a31'; g.lineWidth = 1;
    for (const a of [-1, -0.5, 0.5, 1]) { g.beginPath(); g.moveTo(0, mid - a * amp + 0.5); g.lineTo(w, mid - a * amp + 0.5); g.stroke(); }
    g.strokeStyle = '#2e3740'; g.beginPath(); g.moveTo(0, mid + 0.5); g.lineTo(w, mid + 0.5); g.stroke();
    const step = niceStep(span, Math.max(3, Math.floor(w / 110)));
    g.font = '10px system-ui, sans-serif'; g.fillStyle = '#7d8a97'; g.textBaseline = 'top';
    for (let t = Math.ceil(v0 / step) * step; t <= v1 + 1e-9; t += step) {
      const x = Math.round(X(t)) + 0.5;
      g.strokeStyle = '#1f262d'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, WH); g.stroke();
      g.strokeStyle = '#3a434e'; g.beginPath(); g.moveTo(x, WH); g.lineTo(x, WH + 4); g.stroke();
      const lab = tLabel(t, step);
      if (x + 3 + g.measureText(lab).width < w) g.fillText(lab, x + 3, WH + 3);
    }
    // waveform + RMS envelope
    if (samples?.length) {
      const sr = SAMPLE_RATE, n = samples.length;
      const spp = (span * sr) / w; // samples per pixel
      if (spp < 1.5) {
        g.strokeStyle = '#4fb3ff'; g.lineWidth = 1.2; g.beginPath();
        const i0 = Math.max(0, Math.floor(v0 * sr) - 1), i1 = Math.min(n - 1, Math.ceil(v1 * sr) + 1);
        for (let i = i0; i <= i1; i++) { const x = X(i / sr), y = mid - samples[i] * amp; if (i === i0) g.moveTo(x, y); else g.lineTo(x, y); }
        g.stroke();
        if (spp < 0.25) { g.fillStyle = '#4fb3ff'; for (let i = i0; i <= i1; i++) g.fillRect(X(i / sr) - 1.5, mid - samples[i] * amp - 1.5, 3, 3); }
      } else {
        const rms = new Float32Array(w);
        g.fillStyle = '#3d8fd1';
        for (let x = 0; x < w; x++) {
          const a = Math.max(0, Math.floor((v0 + (x / w) * span) * sr)), b = Math.min(n, Math.max(a + 1, Math.floor((v0 + ((x + 1) / w) * span) * sr)));
          if (a >= n) break;
          let lo = Infinity, hi = -Infinity, ss = 0;
          for (let i = a; i < b; i++) { const s = samples[i]; if (s < lo) lo = s; if (s > hi) hi = s; ss += s * s; }
          rms[x] = Math.sqrt(ss / (b - a));
          g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
        }
        // smoothed RMS envelope (mirrored)
        const k = Math.max(1, Math.round(Math.min(12, (0.01 * sr) / spp)));
        const sm = new Float32Array(w);
        for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let j = x - k; j <= x + k; j++) if (j >= 0 && j < w) { s += rms[j] * rms[j]; c++; } sm[x] = Math.sqrt(s / c); }
        g.fillStyle = 'rgba(255,211,77,0.13)';
        g.beginPath(); g.moveTo(0, mid);
        for (let x = 0; x < w; x++) g.lineTo(x + 0.5, mid - sm[x] * amp);
        for (let x = w - 1; x >= 0; x--) g.lineTo(x + 0.5, mid + sm[x] * amp);
        g.closePath(); g.fill();
        g.strokeStyle = 'rgba(255,211,77,0.95)'; g.lineWidth = 1.3;
        for (const sgn of [1, -1]) {
          g.beginPath();
          let pen = false;
          for (let x = 0; x < w; x++) {
            if (sm[x] < 0.004) { pen = false; continue; }
            const y = mid - sgn * sm[x] * amp;
            if (pen) g.lineTo(x + 0.5, y); else { g.moveTo(x + 0.5, y); pen = true; }
          }
          g.stroke();
        }
      }
    } else {
      g.fillStyle = '#5b6773'; g.textBaseline = 'middle'; g.fillText('rendu…', 10, mid);
    }
    if (!loop && timeline && timeline.dry < total - 1e-3 && X(timeline.dry) > 0 && X(timeline.dry) < w) {
      const x = Math.round(X(timeline.dry)) + 0.5;
      g.setLineDash([3, 3]); g.strokeStyle = '#8b98a5'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, WH); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#8b98a5'; g.textBaseline = 'top'; g.fillText('queue (réverb / écho)', x + 4, 4);
    }
    if (loop) { g.fillStyle = '#7bd88f'; g.textBaseline = 'top'; g.fillText('↻ boucle', 6, 4); }
    // layer timeline
    const y0 = WH + AXIS + 2;
    g.fillStyle = '#161b20'; g.fillRect(0, y0 - 2, w, H - y0 + 2);
    rows.forEach((r, i) => {
      const y = y0 + i * ROW, col = LAYER_COLORS[i % LAYER_COLORS.length];
      g.globalAlpha = r.mute ? 0.22 : i === sel ? 1 : 0.6;
      g.fillStyle = col;
      for (const [a, b] of r.spans) {
        if (b < v0 || a > v1) continue;
        const xa = Math.max(0, X(a)), xb = Math.min(w, X(b));
        g.fillRect(xa, y, Math.max(2, xb - xa), ROW - 3);
      }
      g.globalAlpha = 1;
      if (i === sel) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(0.5, y - 0.5, w - 1, ROW - 2); }
    });
  }, [samples, timeline, sel, w, H, v0, v1, loop, total]);

  // overlay: playhead + hover cursor
  useEffect(() => {
    const c = over.current;
    const dpr = devicePixelRatio || 1;
    c.width = w * dpr; c.height = H * dpr;
    const g = c.getContext('2d');
    let raf = 0, sig = null;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const ph = playhead?.();
      const s = `${ph == null ? '' : ph.toFixed(4)}|${hover.current ?? ''}`;
      if (s === sig) return; // redraw only when the playhead or the cursor moved
      sig = s;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, H);
      const span = Math.max(1e-6, v1 - v0), X = (t) => ((t - v0) / span) * w;
      if (ph != null && ph >= v0 && ph <= v1) {
        g.strokeStyle = '#ff5a4d'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(X(ph), 0); g.lineTo(X(ph), H); g.stroke();
      }
      const hx = hover.current;
      if (hx != null) {
        const t = v0 + (hx / w) * span;
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(hx + 0.5, 0); g.lineTo(hx + 0.5, WH); g.stroke();
        g.font = '10px system-ui, sans-serif'; g.fillStyle = '#d9e1e8'; g.textBaseline = 'bottom';
        const lab = t < 1 ? `${(t * 1000).toFixed(1)} ms` : `${t.toFixed(3)} s`;
        g.fillText(lab, Math.min(hx + 4, w - 50), WH - 3);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [w, H, v0, v1, playhead]);

  const tAt = (e) => { const r = over.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onWheel = (e) => {
    e.preventDefault();
    const { x } = tAt(e), span = v1 - v0, t = v0 + (x / w) * span;
    const f = Math.pow(1.0015, e.deltaY);
    const ns = Math.min(total, Math.max(64 / SAMPLE_RATE, span * f));
    let a = t - (x / w) * ns, b = a + ns;
    if (a < 0) { b -= a; a = 0; }
    if (b > total) { a = Math.max(0, a - (b - total)); b = total; }
    setView(ns >= total - 1e-9 ? null : [a, b]);
  };
  const onDown = (e) => {
    const { x, y } = tAt(e);
    if (y > WH + AXIS) {
      const i = Math.floor((y - WH - AXIS - 2) / ROW);
      if (i >= 0 && i < rows.length) onSelect?.(i);
      return;
    }
    if (!view) return;
    const x0 = x, a0 = v0, span = v1 - v0;
    const mv = (ev) => {
      const dx = ev.clientX - over.current.getBoundingClientRect().left - x0;
      let a = a0 - (dx / w) * span;
      a = Math.max(0, Math.min(total - span, a));
      setView([a, a + span]);
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };
  useEffect(() => {
    const c = over.current;
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  });

  return (
    <div class="au-wave" ref={wrap} style={{ height: H + 'px' }}>
      <canvas ref={base} style={{ width: w + 'px', height: H + 'px' }} />
      <canvas ref={over} class={view ? 'zoomed' : ''} style={{ width: w + 'px', height: H + 'px' }}
        onPointerDown={onDown} onDblClick={() => setView(null)}
        onPointerMove={(e) => { const p = tAt(e); hover.current = p.y < WH ? p.x : null; }}
        onPointerLeave={() => (hover.current = null)}
        title="Molette : zoom · glisser : défiler · double-clic : tout afficher · clic sur une barre : sélectionner la couche" />
      {view && <span class="au-zoom">zoom ×{(total / (v1 - v0)).toFixed(1)} <button class="au-mini" onClick={() => setView(null)}>tout</button></span>}
    </div>
  );
}
