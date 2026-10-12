// Off-main-thread rendering of the edited recipe for the waveform display (synth.js in worker mode,
// with a main-thread fallback), plus the layer timeline (when each layer plays).
import { renderSound, SAMPLE_RATE, loadSamples, urlReader, sampleSeconds } from '../../../engine/audio/synth.js';
import { Data } from '../../../engine/core/Data.js';

const BASE = new URL(Data.base, location.href).href; // where sample layers' WAV files are fetched

let worker = null, failed = false, nextId = 0;
const waiting = new Map();

function getWorker() {
  if (worker || failed || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('../../../engine/audio/synth.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const { id, samples, error } = ev.data ?? {};
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (error) w.reject(new Error(error)); else w.resolve(samples);
    };
    worker.onerror = (ev) => {
      ev?.preventDefault?.();
      failed = true;
      worker?.terminate();
      worker = null;
      for (const [id, w] of waiting) { waiting.delete(id); w.retry(); }
    };
  } catch { failed = true; worker = null; }
  return worker;
}

function renderMain(recipe, seed) {
  return loadSamples(recipe, urlReader(BASE)).then(() => renderSound(recipe, { seed }));
}

/**
 * Render a recipe variation (seed = variation index + 1). Resolves { samples, ms }. The WAV files
 * of sample layers are also loaded here (main thread) so layerTimeline() knows their length.
 */
export function renderAsync(recipe, seed = 1) {
  const t0 = performance.now();
  const done = (samples) => ({ samples, ms: performance.now() - t0 });
  const w = getWorker();
  if (!w) return renderMain(recipe, seed).then(done);
  const files = loadSamples(recipe, urlReader(BASE)).catch(() => {}); // errors come back from the worker
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject, retry: () => renderMain(recipe, seed).then(resolve, reject) });
    try { w.postMessage({ id, recipe, seed, base: BASE }); } catch (e) { waiting.delete(id); renderMain(recipe, seed).then(resolve, reject); }
  }).then((samples) => files.then(() => done(samples)));
}

export function disposeRenderer() {
  worker?.terminate();
  worker = null;
  waiting.clear();
}

export { SAMPLE_RATE };

// ------------------------------------------------------------------ timeline

const first = (v, d) => {
  if (v == null) return d;
  const n = Array.isArray(v) ? +v[0] : +v;
  return Number.isFinite(n) ? n : d;
};
const hi = (v, d) => {
  if (v == null) return d;
  const n = Array.isArray(v) ? +(v.length > 1 ? v[1] : v[0]) : +v;
  return Number.isFinite(n) ? n : d;
};

/**
 * Time spans of each layer (and of its repeats): [{ i, spans: [[t0, t1]...], open }] plus the dry
 * length. Ranges [min, max] use their upper bound. `open` = plays until the end of the sound.
 */
export function layerTimeline(recipe) {
  const layers = Array.isArray(recipe?.layers) ? recipe.layers : [];
  const rows = layers.map((L, i) => {
    if (!L || typeof L !== 'object') return { i, spans: [], open: false };
    const e = L.env;
    let len = null;
    if (L.length != null) len = Math.max(0, hi(L.length, 0.1));
    else if (e && !(first(e.sustain, 0) > 0)) len = Math.max(0, hi(e.attack, L.type === 'click' ? 0 : 0.002)) + Math.max(0, hi(e.hold, 0)) + Math.max(0, hi(e.decay, 0.1));
    else if (L.type === 'sample') {
      // the rest of the longest file (once loaded by renderAsync), at the lowest pitch
      const secs = [].concat(L.file ?? []).map((f) => sampleSeconds(String(f))).filter((s) => s != null);
      if (secs.length) len = Math.max(0, Math.max(...secs) - Math.max(0, first(L.offset, 0))) / Math.max(0.05, first(L.pitch, 1));
    }
    const start = Math.max(0, first(L.start ?? L.delay, 0));
    const rep = L.repeat;
    const count = rep ? Math.max(1, Math.min(256, Math.round(hi(rep.count, 1)))) : 1;
    const interval = rep ? Math.max(0, first(rep.interval, 0.1)) : 0;
    const spans = [];
    for (let k = 0; k < count; k++) spans.push([start + k * interval, len]);
    return { i, spans, open: len == null, mute: !!L.mute };
  });
  let dry;
  if (recipe?.duration != null) dry = Math.max(0.01, hi(recipe.duration, 1));
  else {
    dry = 0;
    for (const r of rows) if (!r.mute) for (const [t, l] of r.spans) dry = Math.max(dry, t + (l ?? 0));
    if (!(dry > 0)) dry = 1;
  }
  dry = Math.min(dry, 60);
  for (const r of rows) r.spans = r.spans.map(([t, l]) => [t, l == null ? Math.max(t, dry) : t + l]);
  return { rows, dry };
}

/** Short human summary of a layer for the layer list. */
export function layerSummary(L) {
  if (!L || typeof L !== 'object') return '';
  const f = (v) => (Array.isArray(v) ? `${fmt(v[0])}~${fmt(v[1])}` : fmt(v));
  const parts = [];
  if (L.type === 'sample') parts.push([].concat(L.file ?? '?').map((f) => String(f).split('/').pop()).join(' | ') + (L.pitch != null ? ` ×${f(L.pitch)}` : ''));
  else if (L.type === 'noise') parts.push(L.noiseColor ?? 'white');
  else if (L.type === 'click') parts.push(L.rate ? `${f(L.rate)}/s` : 'impulse');
  else parts.push(`${f(L.freq ?? 440)}${L.freqEnd != null ? '→' + f(L.freqEnd) : ''} Hz`);
  const fl = L.filter == null ? [] : Array.isArray(L.filter) ? L.filter : [L.filter];
  for (const F of fl) parts.push(`${{ lowpass: 'LP', highpass: 'HP', bandpass: 'BP', notch: 'Notch' }[F?.type ?? 'lowpass'] ?? F?.type} ${f(F?.freq ?? 1000)}${F?.freqEnd != null ? '→' + f(F.freqEnd) : ''}`);
  if (L.env) parts.push(`env ${f(L.env.attack ?? 0.002)}/${f(L.env.decay ?? 0.1)}`);
  if (L.distortion) parts.push(`dist ${f(L.distortion)}`);
  if (L.repeat) parts.push(`×${f(L.repeat.count ?? 1)}`);
  if (L.tremolo) parts.push('trem.');
  if (L.vibrato) parts.push('vib.');
  return parts.join(' · ');
}

export function fmt(v) {
  const n = +v;
  if (!Number.isFinite(n)) return String(v);
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1000) return (n / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(+n.toPrecision(3));
}
