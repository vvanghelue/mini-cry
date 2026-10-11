// Procedural sound synthesis. Pure JS with no DOM, no AudioContext and no three.js, so the same
// module runs on the browser main thread, inside a Web Worker (see the bottom of this file) and
// in Node (the `mc sound ...` CLI). A sound is a JSON "recipe", rendered offline to mono
// Float32 samples at 44100 Hz.
//
// RECIPE (all fields optional except layers)
// {
//   "duration": 0.6,      // s. Dry length (default: end of the last layer). For loops: the loop length.
//   "gain": 0.8,          // output peak 0..1: the mix is peak-normalised, then scaled by gain
//   "normalize": true,    // false: keep the raw mix level (x gain), clamped to +-1
//   "loop": false,        // render a seamless loop (the overhang is cross-faded into the head;
//                         // LFO rates and steady oscillator pitches snap to whole cycles per loop)
//   "loopFade": 0.3,      // s, loop cross-fade length (default min(0.5, duration / 4))
//   "reverb": 0.2,        // 0..1 wet amount of a small room/plate. "reverbSize": 0..1, "reverbDamp": 0..1
//   "echo": { "time": 0.35, "feedback": 0.35, "mix": 0.4, "lowpass": 2000 },  // slap-back / canyon echo
//   "tail": 0.6,          // s rendered after `duration` for reverb/echo (default: automatic)
//   "filter": {...},      // filter(s) on the whole mix (same format as a layer filter)
//   "distortion": 0.2,    // saturation on the whole mix (0..1)
//   "layers": [ layer, ... ],
//   "variations": { "count": 3, "pitch": [0.95, 1.05], "gain": [0.85, 1] },
//       // count = variants rendered with different random seeds (default 3, loops 1);
//       // pitch/gain = random playback-rate / volume ranges picked at each play (Audio.js)
//   // Playback metadata, read by Audio.js (ignored here):
//   "bus": "sfx" | "ambient" | "music" | "ui",  "refDistance": 5, "maxDistance": 300,
//   "rolloff": 1, "priority": 0, "maxInstances": 8
// }
//
// LAYER
// {
//   "type": "noise" | "sine" | "square" | "saw" | "triangle" | "fm" | "click",
//   "start": 0,           // s, when the layer starts (alias "delay")
//   "length": 0.2,        // s. Default: attack+hold+decay if env.sustain is 0, else to the end of the sound
//   "gain": 1,
//   "mute": false,        // skip this layer (editor solo / mute)
//   "freq": 440, "freqEnd": 110,  // Hz, exponential glide from freq to freqEnd...
//   "sweep": 0.1,         // ...over `sweep` s (default: the layer length)
//   "curve": 1,           // glide shape: < 1 = fast at first (kick drums), > 1 = slow at first
//   "noiseColor": "white" | "pink" | "brown",   // type noise
//   "duty": 0.5,          // type square: pulse width
//   "unison": { "voices": 3, "detune": 10 },    // detuned copies spread over +-detune cents
//   "fm": { "ratio": 1.4, "index": 3, "indexEnd": 0 },  // type fm: sine carrier phase-modulated by
//                         // a sine at freq * ratio; index glides to indexEnd over the layer
//   "rate": 30, "jitter": 0.5,  // type click: impulses per second (0 = a single impulse at the
//                         // start) and timing randomness 0..1. A click is a one-sample impulse;
//                         // filter it to get ticks / pings / pulses: the impulse is scaled so the
//                         // first filter's ringing peaks near 1 (gains stay comparable to noise)
//   "env": { "attack": 0.002, "hold": 0, "decay": 0.1, "sustain": 0, "release": 0, "curve": 4 },
//                         // s. Linear attack, hold at 1, decay to sustain (curve: 0 linear,
//                         // higher = more exponential), release = fade over the last `release` s.
//                         // No env: constant level with 2 ms / 5 ms edge fades.
//   "filter": { "type": "lowpass"|"highpass"|"bandpass"|"notch", "freq": 2000, "freqEnd": 400,
//               "q": 0.7, "sweep": s, "curve": 1, "lfo": LFO (depth in octaves) }  or [filter, ...]
//   "distortion": 0.5,    // 0..1 tanh drive (also compresses: makes decays punchier)
//   "vibrato": LFO,       // pitch modulation, depth in semitones
//   "tremolo": LFO | [LFO, ...],   // amplitude modulation, depth 0..1 (several multiply)
//   "repeat": { "count": 3, "interval": 0.1, "jitter": 0.02, "pitch": 1.1, "gain": 0.7, "notes": [0, 4, 7] }
//                         // re-trigger the layer: k-th copy starts at start + k*interval (+ random
//                         // 0..jitter s), freq (and its filters) x pitch^k, gain x gain^k. `notes`
//                         // (semitones, cycled) replaces the pitch progression: arpeggios / jingles.
// }
// LFO: { "rate": Hz, "depth": n, "shape": "sine"|"triangle"|"square"|"saw"|"noise", "phase": 0..1, "duty": 0.5 }
//      ("noise" = smooth random wander, one new random target per cycle)
//
// Any number may be written [min, max]: a random value is drawn for each rendered variation
// (and for each repeat), e.g. "freq": [2800, 4200] for birds that never sing the same note.

export const SAMPLE_RATE = 44100;
const TAU = Math.PI * 2;
const TYPES = { noise: 0, sine: 1, square: 2, saw: 3, triangle: 4, fm: 5, click: 6 };
const SHAPES = { sine: 0, triangle: 1, tri: 1, square: 2, saw: 3, noise: 4 };
const FILTERS = { lowpass: 0, highpass: 1, bandpass: 2, notch: 3 };
const COLORS = { white: 0, pink: 1, brown: 2 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Number, [min, max] (random in range) or undefined -> default. */
function val(v, rng, def) {
  if (v === undefined || v === null) return def;
  if (Array.isArray(v)) {
    const a = +v[0], b = v.length > 1 ? +v[1] : a;
    const r = a + (b - a) * rng();
    return Number.isFinite(r) ? r : def;
  }
  const n = +v;
  return Number.isFinite(n) ? n : def;
}
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** The { name: recipe } map from a parsed sounds.json ({ sounds: {...} }) or the map itself. */
export function soundMap(json) {
  if (!json || typeof json !== 'object') return {};
  const inner = json.sounds;
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && !Array.isArray(inner.layers)) return inner;
  return json;
}

/** How many random variants Audio.js renders for a recipe. */
export function variationCount(recipe) {
  const c = recipe?.variations?.count;
  return Math.max(1, Math.min(8, Math.round(Number.isFinite(+c) ? +c : recipe?.loop ? 1 : 3)));
}

// ------------------------------------------------------------------ planning

function resolveFilter(f, rng, pitchMul) {
  const type = FILTERS[f?.type ?? 'lowpass'];
  if (type === undefined) throw new Error(`unknown filter type "${f?.type}"`);
  const f0 = val(f.freq, rng, 1000) * pitchMul;
  return {
    type, f0,
    f1: f.freqEnd != null ? val(f.freqEnd, rng, f0) * pitchMul : f0,
    q: Math.max(0.05, val(f.q, rng, type === 2 ? 1 : 0.707)),
    curve: Math.max(0.05, val(f.curve, rng, 1)),
    sweep: f.sweep != null ? val(f.sweep, rng, 0) : null,
    lfo: f.lfo ?? null,
  };
}

function resolveLayer(L, rng, start, pitchMul, gainMul) {
  const type = TYPES[L.type ?? 'sine'];
  if (type === undefined) throw new Error(`unknown layer type "${L.type}"`);
  const e = L.env;
  let env = null;
  if (e) {
    env = {
      a: Math.max(0, val(e.attack, rng, type === 6 ? 0 : 0.002)),
      h: Math.max(0, val(e.hold, rng, 0)),
      d: Math.max(0, val(e.decay, rng, 0.1)),
      s: clamp(val(e.sustain, rng, 0), 0, 1),
      r: Math.max(0, val(e.release, rng, 0)),
      c: Math.max(0, val(e.curve, rng, 4)),
    };
  }
  let len = L.length != null ? Math.max(0, val(L.length, rng, 0.1)) : env && env.s === 0 ? env.a + env.h + env.d : null;
  const freq = Math.max(0.01, val(L.freq, rng, 440)) * pitchMul;
  return {
    type, start: Math.max(0, start), len,
    gain: val(L.gain, rng, 1) * gainMul,
    freq,
    freqEnd: L.freqEnd != null ? Math.max(0.01, val(L.freqEnd, rng, freq)) * pitchMul : freq,
    curve: Math.max(0.05, val(L.curve, rng, 1)),
    sweep: L.sweep != null ? val(L.sweep, rng, 0) : null,
    color: COLORS[L.noiseColor ?? 'white'] ?? 0,
    duty: clamp(val(L.duty, rng, 0.5), 0.02, 0.98),
    voices: L.unison ? clamp(Math.round(val(L.unison.voices, rng, 1)), 1, 8) : 1,
    detune: L.unison ? val(L.unison.detune, rng, 10) : 0,
    fmRatio: val(L.fm?.ratio, rng, 1),
    fmIndex: val(L.fm?.index, rng, 1),
    fmIndexEnd: L.fm?.indexEnd != null ? val(L.fm.indexEnd, rng, 1) : null,
    rate: Math.max(0, val(L.rate, rng, 0)),
    jitter: clamp(val(L.jitter, rng, 0), 0, 1),
    env,
    drive: clamp(val(L.distortion, rng, 0), 0, 1),
    filters: list(L.filter).map((f) => resolveFilter(f, rng, pitchMul)),
    vib: L.vibrato ?? null,
    trem: list(L.tremolo),
  };
}

function planLayers(recipe, rng) {
  const out = [];
  for (const L of recipe.layers ?? []) {
    if (!L || typeof L !== 'object' || L.mute) continue;
    const rep = L.repeat;
    const count = rep ? clamp(Math.round(val(rep.count, rng, 1)), 1, 256) : 1;
    const interval = rep ? Math.max(0, val(rep.interval, rng, 0.1)) : 0;
    const pStep = rep ? val(rep.pitch, rng, 1) : 1;
    const gStep = rep ? val(rep.gain, rng, 1) : 1;
    const jit = rep ? Math.max(0, val(rep.jitter, rng, 0)) : 0;
    const notes = Array.isArray(rep?.notes) && rep.notes.length ? rep.notes : null;
    const start0 = val(L.start ?? L.delay, rng, 0);
    for (let k = 0; k < count; k++) {
      const pm = notes ? Math.pow(2, val(notes[k % notes.length], rng, 0) / 12) : Math.pow(pStep, k);
      out.push(resolveLayer(L, rng, start0 + k * interval + (jit ? rng() * jit : 0), pm, Math.pow(gStep, k)));
    }
  }
  return out;
}

function autoTail(recipe, rng) {
  if (recipe.tail != null) return Math.max(0, val(recipe.tail, rng, 0));
  let tail = 0;
  const wet = val(recipe.reverb, rng, 0);
  if (wet > 0) tail = 0.25 + 1.6 * clamp(val(recipe.reverbSize, rng, 0.5), 0, 1);
  const echo = recipe.echo;
  if (echo) {
    const fb = clamp(val(echo.feedback, rng, 0.3), 0, 0.9);
    const reps = fb > 0.01 ? Math.ceil(Math.log(0.03) / Math.log(fb)) : 1;
    tail = Math.max(tail, Math.min(4, val(echo.time, rng, 0.3) * (reps + 1)));
  }
  return tail;
}

function lengths(recipe, insts, rng) {
  const loop = !!recipe.loop;
  let dry;
  if (recipe.duration != null) dry = Math.max(0.01, val(recipe.duration, rng, 1));
  else {
    dry = 0;
    for (const s of insts) dry = Math.max(dry, s.start + (s.len ?? 0));
    if (!(dry > 0)) dry = 1;
  }
  dry = Math.min(dry, 60);
  const fade = loop ? clamp(val(recipe.loopFade, rng, Math.min(0.5, dry * 0.25)), 0.005, dry * 0.5) : 0;
  const tail = loop ? 0 : Math.min(8, autoTail(recipe, rng));
  return { loop, dry, fade, tail };
}

/** Length in seconds of the rendered sound (upper bound when params are random ranges). */
export function estimateDuration(recipe) {
  try {
    const one = () => 0.999999;
    const insts = planLayers(recipe, one);
    const { dry, tail } = lengths(recipe, insts, one);
    return dry + tail;
  } catch { return 1; }
}

// ------------------------------------------------------------------ DSP helpers

function makeLfo(o, rng, loopDur, len) {
  if (!o || typeof o !== 'object') return null;
  const shape = SHAPES[o.shape ?? 'sine'] ?? 0;
  let rate = Math.max(0, val(o.rate, rng, 1));
  if (loopDur > 0 && rate > 0) rate = Math.max(1, Math.round(rate * loopDur)) / loopDur;
  const l = { shape, rate, depth: val(o.depth, rng, 0.5), phase: val(o.phase, rng, 0), duty: clamp(val(o.duty, rng, 0.5), 0.01, 0.99), pts: null, n: 0 };
  if (shape === 4) {
    const n = loopDur > 0 ? Math.max(1, Math.round(rate * loopDur)) : Math.ceil(rate * len) + 2;
    l.n = Math.max(1, n);
    l.pts = new Float32Array(l.n);
    for (let i = 0; i < l.n; i++) l.pts[i] = rng() * 2 - 1;
  }
  return l;
}

function lfoAt(l, t) {
  if (l.shape === 4) {
    if (!(l.rate > 0)) return l.pts[0];
    const x = t * l.rate + l.phase * l.n;
    const i = Math.floor(x);
    let f = x - i;
    f = f * f * (3 - 2 * f);
    const a = l.pts[i % l.n], b = l.pts[(i + 1) % l.n];
    return a + (b - a) * f;
  }
  let p = t * l.rate + l.phase;
  p -= Math.floor(p);
  switch (l.shape) {
    case 0: return Math.sin(TAU * p);
    case 1: { let q = p + 0.25; if (q >= 1) q -= 1; return 1 - 4 * Math.abs(q - 0.5); }
    case 2: return p < l.duty ? 1 : -1;
    default: return 2 * p - 1;
  }
}

function makeBiquad(f, rng, loopDur, len, sr) {
  const lfo = makeLfo(f.lfo, rng, loopDur, len);
  const F = {
    type: f.type, f0: f.f0, q: f.q, curve: f.curve,
    sweepLn: f.f1 !== f.f0 && f.f0 > 0 && f.f1 > 0 ? Math.log(f.f1 / f.f0) : 0,
    sweepT: Math.max(1e-4, f.sweep ?? len),
    lfo, lfoK: lfo ? lfo.depth * Math.LN2 : 0,
    dyn: false,
    b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0,
  };
  F.dyn = !!(F.sweepLn || lfo);
  setCoefs(F, cutoffAt(F, 0), sr);
  return F;
}

function cutoffAt(F, t) {
  let f = F.f0;
  if (F.sweepLn) {
    let p = t / F.sweepT;
    if (p > 1) p = 1;
    f *= Math.exp(F.sweepLn * (F.curve === 1 ? p : Math.pow(p, F.curve)));
  }
  if (F.lfo) f *= Math.exp(F.lfoK * lfoAt(F.lfo, t));
  return f;
}

// RBJ audio-EQ-cookbook biquads (band-pass = constant 0 dB peak gain).
function setCoefs(F, freq, sr) {
  const f = clamp(freq, 10, sr * 0.45);
  const w = (TAU * f) / sr, cw = Math.cos(w), alpha = Math.sin(w) / (2 * F.q);
  const a0 = 1 + alpha;
  let b0, b1, b2;
  switch (F.type) {
    case 0: b1 = 1 - cw; b0 = b2 = b1 / 2; break;
    case 1: b1 = -(1 + cw); b0 = b2 = (1 + cw) / 2; break;
    case 2: b0 = alpha; b1 = 0; b2 = -alpha; break;
    default: b0 = 1; b1 = -2 * cw; b2 = 1; break;
  }
  F.b0 = b0 / a0; F.b1 = b1 / a0; F.b2 = b2 / a0; F.a1 = (-2 * cw) / a0; F.a2 = (1 - alpha) / a0;
}

function runFilters(buf, i0, n, filters, sr) {
  for (const F of filters) {
    let { b0, b1, b2, a1, a2, x1, x2, y1, y2 } = F;
    for (let i = 0; i < n; i++) {
      if (F.dyn && (i & 15) === 0) {
        setCoefs(F, cutoffAt(F, i / sr), sr);
        b0 = F.b0; b1 = F.b1; b2 = F.b2; a1 = F.a1; a2 = F.a2;
      }
      const x = buf[i0 + i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      buf[i0 + i] = y;
    }
    F.x1 = x1; F.x2 = x2; F.y1 = y1; F.y2 = y2;
  }
}

function impulsePeak(F) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, peak = 1e-6;
  for (let i = 0; i < 4096; i++) {
    const x = i === 0 ? 1 : 0;
    const y = F.b0 * x + F.b1 * x1 + F.b2 * x2 - F.a1 * y1 - F.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    const a = Math.abs(y);
    if (a > peak) peak = a;
    else if (i > 64 && a < peak * 0.01) break;
  }
  return peak;
}

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// ------------------------------------------------------------------ layer rendering

let scratch = new Float32Array(44100);

function renderInstance(out, s, sr, rng, loopDur) {
  const i0 = Math.round(s.start * sr);
  let n = Math.round(s.len * sr);
  if (i0 >= out.length || n <= 0) return;
  if (i0 + n > out.length) n = out.length - i0;
  if (scratch.length < n) scratch = new Float32Array(n);
  const buf = scratch;
  const T = s.type, dt = 1 / sr, len = Math.max(1e-4, s.len);
  // loops: steady layers covering the whole loop snap to whole cycles so the seam is in phase
  const ld = s.start === 0 && s.len >= loopDur ? loopDur : 0;

  // pitch
  let f0 = s.freq;
  const sweepLn = s.freqEnd !== s.freq ? Math.log(s.freqEnd / s.freq) : 0;
  const sweepT = Math.max(1e-4, s.sweep ?? len), curve = s.curve;
  const vib = makeLfo(s.vib, rng, ld, len);
  const vibK = vib ? (vib.depth * Math.LN2) / 12 : 0;
  const nv = T >= 1 && T <= 4 ? s.voices : 1;
  const det = new Float64Array(nv), ph = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    const cents = nv > 1 ? s.detune * ((2 * v) / (nv - 1) - 1) : 0;
    let r = Math.pow(2, cents / 1200);
    if (ld && !sweepLn && !vib && f0 * r * ld >= 1) r = Math.round(f0 * r * ld) / (f0 * ld);
    det[v] = r;
    ph[v] = v ? rng() : 0;
  }
  const uni = nv > 1 ? 1 / Math.sqrt(nv) : 1;
  const duty = s.duty;
  // fm
  let pm = 0;
  const fmR = s.fmRatio, ix0 = s.fmIndex, ixD = (s.fmIndexEnd ?? s.fmIndex) - s.fmIndex;
  // noise
  const color = s.color;
  let p0 = 0, p1 = 0, p2 = 0, br = 0;
  // clicks
  let rate = s.rate;
  if (ld && rate > 0) rate = Math.max(1, Math.round(rate * ld)) / ld;
  const period = rate > 0 ? sr / rate : Infinity, jit = s.jitter;
  let nextClick = 0;
  // amplitude
  const env = s.env;
  let ec = 0, einv = 1;
  if (env && env.c > 0.01) { ec = Math.exp(-env.c); einv = 1 / (1 - ec); }
  const fa = loopDur || T === 6 ? 0 : 0.002, fr = loopDur ? 0 : 0.005;
  const trem = s.trem.map((o) => makeLfo(o, rng, ld, len)).filter(Boolean);
  const nt = trem.length;
  const drive = s.drive > 0 ? 1 + s.drive * 12 : 0, dnorm = drive ? 1 / Math.tanh(drive) : 1;
  const filters = s.filters.map((f) => makeBiquad(f, rng, ld, len, sr));
  // a filtered impulse is scaled so its ringing peaks near 1, whatever the filter
  const clickAmp = T === 6 && filters.length ? 1 / impulsePeak(filters[0]) : 1;

  for (let i = 0; i < n; i++) {
    const t = i * dt;
    let x = 0;
    if (T === 0) {
      const w = rng() * 2 - 1;
      if (color === 0) x = w;
      else if (color === 1) {
        p0 = 0.99765 * p0 + w * 0.099046;
        p1 = 0.963 * p1 + w * 0.2965164;
        p2 = 0.57 * p2 + w * 1.0526913;
        x = (p0 + p1 + p2 + w * 0.1848) * 0.25;
      } else {
        br = (br + 0.02 * w) / 1.02;
        x = br * 3.5;
      }
    } else if (T === 6) {
      if (i >= nextClick) {
        x = clickAmp;
        nextClick += period === Infinity ? Infinity : Math.max(1, period * (1 + (jit ? (rng() * 2 - 1) * jit : 0)));
      }
    } else {
      let f = f0;
      if (sweepLn) {
        let p = t / sweepT;
        if (p > 1) p = 1;
        f = f0 * Math.exp(sweepLn * (curve === 1 ? p : Math.pow(p, curve)));
      }
      if (vib) f *= Math.exp(vibK * lfoAt(vib, t));
      const inc = f * dt;
      if (T === 5) {
        const ix = ix0 + ixD * (t / len);
        x = Math.sin(TAU * ph[0] + ix * Math.sin(TAU * pm));
        pm += inc * fmR; pm -= Math.floor(pm);
        let p = ph[0] + inc; p -= Math.floor(p); ph[0] = p;
      } else {
        for (let v = 0; v < nv; v++) {
          const di = inc * det[v];
          const p = ph[v];
          if (T === 1) x += Math.sin(TAU * p);
          else if (T === 2) { let q = p + 1 - duty; if (q >= 1) q -= 1; x += (p < duty ? 1 : -1) + blep(p, di) - blep(q, di); }
          else if (T === 3) x += 2 * p - 1 - blep(p, di);
          else { let q = p + 0.25; if (q >= 1) q -= 1; x += 1 - 4 * Math.abs(q - 0.5); }
          let np = p + di;
          if (np >= 1) np -= Math.floor(np);
          ph[v] = np;
        }
        x *= uni;
      }
    }
    // envelope
    let a;
    if (env) {
      if (t < env.a) a = t / env.a;
      else {
        const td = t - env.a - env.h;
        if (td <= 0) a = 1;
        else if (td < env.d) {
          const q = td / env.d;
          a = env.s + (1 - env.s) * (ec ? (Math.exp(-env.c * q) - ec) * einv : 1 - q);
        } else a = env.s;
      }
      if (env.r > 0) { const tr = len - t; if (tr < env.r) a *= tr > 0 ? tr / env.r : 0; }
    } else {
      a = 1;
      if (fa && t < fa) a = t / fa;
      if (fr) { const tr = len - t; if (tr < fr) a *= tr > 0 ? tr / fr : 0; }
    }
    for (let k = 0; k < nt; k++) { const l = trem[k]; a *= 1 - l.depth * 0.5 * (1 - lfoAt(l, t)); }
    x *= a;
    if (drive) x = Math.tanh(x * drive) * dnorm;
    buf[i] = x;
  }
  if (filters.length) runFilters(buf, 0, n, filters, sr);
  const g = s.gain;
  for (let i = 0; i < n; i++) out[i0 + i] += buf[i] * g;
}

// ------------------------------------------------------------------ master effects

function applyEcho(buf, echo, rng, sr) {
  const time = clamp(val(echo.time, rng, 0.3), 0.01, 2);
  const fb = clamp(val(echo.feedback, rng, 0.3), 0, 0.9);
  const mix = clamp(val(echo.mix, rng, 0.4), 0, 1);
  const a = 1 - Math.exp((-TAU * clamp(val(echo.lowpass, rng, 3000), 50, sr * 0.45)) / sr);
  const d = Math.max(1, Math.round(time * sr));
  const line = new Float32Array(d);
  let idx = 0, z = 0;
  for (let i = 0; i < buf.length; i++) {
    z += a * (line[idx] - z);
    const x = buf[i];
    line[idx] = x + z * fb;
    buf[i] = x + z * mix;
    if (++idx >= d) idx = 0;
  }
}

// Freeverb-style mono reverb: 6 damped feedback combs + 3 all-passes. The input is high-passed
// (like real reverbs) so sub-bass thumps don't build up in the combs.
function applyReverb(buf, wet, size, damp, sr) {
  const n = buf.length, sc = (sr / 44100) * (0.55 + 0.9 * size);
  const fb = 0.7 + 0.27 * size;
  const src = buf.slice();
  const hp = { type: 1, q: 0.707, b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0, dyn: false };
  setCoefs(hp, 280, sr);
  runFilters(src, 0, n, [hp], sr);
  const out = new Float32Array(n);
  for (const len of [1116, 1188, 1277, 1356, 1422, 1491]) {
    const d = Math.max(1, Math.round(len * sc));
    const line = new Float32Array(d);
    let idx = 0, store = 0;
    for (let i = 0; i < n; i++) {
      const y = line[idx];
      store = y * (1 - damp) + store * damp;
      line[idx] = src[i] + store * fb;
      out[i] += y;
      if (++idx >= d) idx = 0;
    }
  }
  for (const len of [556, 441, 341]) {
    const d = Math.max(1, Math.round((len * sr) / 44100));
    const line = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const b = line[idx], x = out[i];
      line[idx] = x + b * 0.5;
      out[i] = b - x;
      if (++idx >= d) idx = 0;
    }
  }
  const g = wet * 0.3, dry = 1 - wet * 0.35;
  for (let i = 0; i < n; i++) buf[i] = buf[i] * dry + out[i] * g;
}

// ------------------------------------------------------------------ render

/**
 * Render a recipe to mono samples (SAMPLE_RATE Hz, peak = recipe.gain unless normalize is false).
 * opts: { seed = 1 (variation seed), sampleRate, info: {} (filled with rawPeak, dry, tail, loop) }
 * Throws on malformed recipes (unknown layer / filter type).
 */
export function renderSound(recipe, { seed = 1, sampleRate = SAMPLE_RATE, info } = {}) {
  if (!recipe || typeof recipe !== 'object') throw new Error('recipe must be an object');
  if (recipe.layers != null && !Array.isArray(recipe.layers)) throw new Error('layers must be an array');
  const sr = sampleRate;
  const rng = mulberry32(Math.imul(seed | 0, 2654435761) ^ 0x5bd1e995);
  const insts = planLayers(recipe, rng);
  const { loop, dry, fade, tail } = lengths(recipe, insts, rng);
  const nDry = Math.max(1, Math.round(dry * sr));
  const N = nDry + Math.round((fade + tail) * sr);
  const out = new Float32Array(N);
  const loopDur = loop ? nDry / sr : 0;
  for (const s of insts) {
    if (s.len == null) s.len = Math.max(0, (loop ? dry + fade : dry) - s.start);
    renderInstance(out, s, sr, rng, loopDur);
  }

  // whole-mix chain
  const mf = list(recipe.filter);
  if (mf.length) runFilters(out, 0, N, mf.map((f) => makeBiquad(resolveFilter(f, rng, 1), rng, loopDur, dry, sr)), sr);
  const md = clamp(val(recipe.distortion, rng, 0), 0, 1);
  if (md > 0) {
    const k = 1 + md * 12, kn = 1 / Math.tanh(k);
    for (let i = 0; i < N; i++) out[i] = Math.tanh(out[i] * k) * kn;
  }
  // DC blocker (~7 Hz)
  let xp = 0, yp = 0;
  for (let i = 0; i < N; i++) { const x = out[i]; yp = x - xp + 0.999 * yp; xp = x; out[i] = yp; }
  if (recipe.echo && typeof recipe.echo === 'object') applyEcho(out, recipe.echo, rng, sr);
  const wet = clamp(val(recipe.reverb, rng, 0), 0, 1);
  if (wet > 0) applyReverb(out, wet, clamp(val(recipe.reverbSize, rng, 0.5), 0, 1), clamp(val(recipe.reverbDamp, rng, 0.4), 0, 0.95), sr);

  let res;
  if (loop) {
    // seamless loop: cross-fade the overhang (rendered past the loop end) into the head
    res = out.slice(0, nDry);
    const X = Math.min(N - nDry, nDry);
    for (let i = 0; i < X; i++) {
      const u = (i / X) * (Math.PI / 2);
      res[i] = out[i] * Math.sin(u) + out[nDry + i] * Math.cos(u);
    }
  } else {
    res = out;
    const nf = Math.max(1, Math.min(N, Math.round((tail > 0 ? tail * 0.5 : 0.01) * sr)));
    for (let i = 0; i < nf; i++) res[N - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / nf);
  }

  let peak = 0;
  for (let i = 0; i < res.length; i++) { const a = Math.abs(res[i]); if (a > peak) peak = a; }
  const gain = clamp(val(recipe.gain, rng, 0.8), 0, 4);
  const g = (recipe.normalize === false ? 1 : peak > 1e-9 ? 1 / peak : 0) * gain;
  for (let i = 0; i < res.length; i++) { const y = res[i] * g; res[i] = y > 1 ? 1 : y < -1 ? -1 : y; }
  if (info) Object.assign(info, { rawPeak: peak, outPeak: peak * g, dry, tail, loop, fade });
  return res;
}

/** Peak / RMS / non-finite count of a sample buffer. */
export function analyze(samples, sampleRate = SAMPLE_RATE) {
  let peak = 0, sum = 0, bad = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    if (!Number.isFinite(x)) { bad++; continue; }
    const a = x < 0 ? -x : x;
    if (a > peak) peak = a;
    sum += x * x;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, samples.length)), nonFinite: bad, seconds: samples.length / sampleRate };
}

/** 16-bit PCM mono WAV file bytes. */
export function encodeWAV(samples, sampleRate = SAMPLE_RATE) {
  const n = samples.length;
  const bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(samples[i]) ? clamp(samples[i], -1, 1) : 0;
    dv.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return bytes;
}

// ------------------------------------------------------------------ worker mode
// Audio.js loads this module as a module Web Worker so recipes render off the main thread.
// Messages: { id, recipe, seed } -> { id, samples } (transferred) | { id, error }.
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (ev) => {
    const { id, recipe, seed } = ev.data ?? {};
    try {
      const samples = renderSound(recipe, { seed });
      self.postMessage({ id, samples }, [samples.buffer]);
    } catch (err) {
      self.postMessage({ id, error: String(err?.message ?? err) });
    }
  };
}
