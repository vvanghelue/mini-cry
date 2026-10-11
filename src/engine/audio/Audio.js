// Runtime audio (Web Audio). Every sound is a procedural recipe from public/data/sounds.json,
// rendered once by synth.js (lazily, in a Web Worker) into a few AudioBuffer variations, then
// played through cheap AudioBufferSourceNodes. Also runs the ambient soundscape (beds + spot
// sounds driven by an ambient state) and a light generative music layer. Never throws: without
// Web Audio (headless tests) or before the first user gesture every call is a harmless no-op.
//
//   const audio = new AudioSystem({ sounds: await Data.json('sounds.json') });
//   canvas.addEventListener('click', () => audio.resume());   // audio starts on a user gesture
//   every frame: audio.update(dt, camera, { coastDistance, underwater, night, inJungle, height, indoor, combat });
//   const h = audio.play('rifle_shot', { position: muzzle });  // h.stop(fade) / setPosition / setPitch / setVolume
//
// Graph: voice = source -> gain -> [air lowpass -> panner (spatial)] -> bus
//        sfx -> world lowpass (underwater) -> master -> limiter -> out
//        ambient -> duck -> ambient lowpass (indoor) -> world lowpass;  music (calm + combat) -> duck -> master;  ui -> master
// Clips (recorded files, e.g. dialogue voices): playClip(url) -> gain -> [radio band-pass] -> voice bus -> master
// (they duck music and ambience while they play).
import { renderSound, estimateDuration, variationCount, soundMap, SAMPLE_RATE } from './synth.js';

const BUSES = ['master', 'sfx', 'ambient', 'music', 'ui', 'voice'];
const DEFAULT_VOLUMES = { master: 0.9, sfx: 1, ambient: 0.8, music: 0.5, ui: 0.8, voice: 1 };
const DUCK = { music: 0.45, ambient: 0.6 }; // levels while a clip that ducks is playing
const PENDING = 0, PLAYING = 1, STOPPING = 2, STOPPED = 3, VIRTUAL = 4;
const PREVIEW = '\u0000preview';
const SYNC_RENDER_MAX = 1.5; // s: shorter one-shots render on the spot if not ready (a late shot is worse)
const ONE_SHOT_LATE = 250; // ms: a one-shot still waiting for its buffer after this is dropped
const TAU = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const range = (r, d) => (Array.isArray(r) && r.length > 1 ? r[0] + (r[1] - r[0]) * Math.random() : num(r, d));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const NULL_HANDLE = Object.freeze({ name: '', playing: false, stop() {}, setPosition() {}, setPitch() {}, setVolume() {} });

const AMBIENT_DEFAULTS = {
  oceanRange: 220, // m: the surf fades out this far from the coast
  beds: { ocean: 1, wind: 0.8, cicadas: 0.55, frogs: 0.6, crickets: 0.5, underwater: 0.9 },
  sounds: {
    ocean: 'ocean_waves', wind: 'wind', cicadas: 'cicadas', frogs: 'frogs', crickets: 'crickets', underwater: 'underwater',
    bird: 'bird_chirp', parrot: 'parrot_call', gull: 'gull_call', owl: 'owl_hoot',
  },
  birdsPerMinute: 16, parrotShare: 0.25, gullsPerMinute: 6, owlsPerMinute: 1.5,
};
const MUSIC_DEFAULTS = {
  bpm: 96, padRoot: 57, pluckRoot: 69, bassRoot: 33, barsPerChord: 2,
  chords: [[57, 60, 64, 71], [53, 57, 60, 64], [55, 60, 64, 71], [55, 59, 62, 64]],
  scale: [69, 72, 74, 76, 79, 81, 84],
  phraseChords: [6, 10], restSeconds: [25, 50], firstDelay: 6, pluckDensity: 0.12,
  levels: { pad: 0.14, pluck: 0.18, drum_low: 0.45, drum_high: 0.3, shaker: 0.18, log: 0.25, bass: 0.35, drone: 0.3 },
  patterns: { drum_low: 'x..x..x...x.x...', drum_high: '....x.......x.o?', shaker: 'xoxoxoxoxoxoxoxo', log: '..?...x...?..x.?', bass: 'x.......x..?....' },
};
const BED_KEYS = ['ocean', 'wind', 'cicadas', 'frogs', 'crickets', 'underwater'];

/**
 * Radio voice: telephone band (~380 Hz - 3.3 kHz), a presence bump and a soft saturation. Returns
 * the input node; the output goes to `out`. Exported for the editor's dialogue preview.
 */
export function radioFilter(ctx, out) {
  const biquad = (type, f, q, g = 0) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = g; return n; };
  const hp = biquad('highpass', 380, 0.7), mid = biquad('peaking', 1700, 0.9, 5), lp = biquad('lowpass', 3300, 0.7);
  const sh = ctx.createWaveShaper(), n = 1024, curve = new Float32Array(n), k = 2.5;
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(k * (i / (n - 1) * 2 - 1)) / Math.tanh(k);
  sh.curve = curve;
  sh.oversample = '2x';
  const g = ctx.createGain();
  g.gain.value = 0.9;
  hp.connect(mid); mid.connect(lp); lp.connect(sh); sh.connect(g); g.connect(out);
  return hp;
}

/** A playing (or pending) sound. Returned by play() as the handle. */
class Voice {
  constructor(sys, name, recipe, o) {
    this.sys = sys;
    this.name = name;
    this.recipe = recipe;
    this.state = PENDING;
    this.loop = !!o.loop;
    this.volume = num(o.volume, 1);
    this.pitch = num(o.pitch, 1);
    this.priority = num(o.priority, num(recipe.priority, 0));
    this.bus = o.bus ?? recipe.bus ?? 'sfx';
    this.varPitch = range(recipe.variations?.pitch, 1);
    this.varGain = range(recipe.variations?.gain, 1);
    const p = o.position;
    this.spatial = !!p;
    this.x = num(p?.x, 0); this.y = num(p?.y, 0); this.z = num(p?.z, 0);
    this.ref = Math.max(0.1, num(recipe.refDistance, 5));
    this.max = Math.max(this.ref, num(recipe.maxDistance, 300));
    this.rolloff = Math.max(0, num(recipe.rolloff, 1));
    this.dist = 0;
    this.lateOk = false;
    this.fadeIn = false;
    this.stale = false;
    this.lastRate = 0;
    this.lastGain = 0;
    this.src = null;
    this.ch = null;
    this.t0 = 0;
    this.started = 0;
    this.idx = -1;
  }
  get playing() { return this.state === PLAYING || this.state === PENDING || this.state === VIRTUAL; }
  stop(fade = 0.05) { try { this.sys._stop(this, fade); } catch (e) { this.sys._warn(e); } }
  setPosition(p) {
    if (!p) return;
    this.x = num(p.x, this.x); this.y = num(p.y, this.y); this.z = num(p.z, this.z);
    try { if (this.state === PLAYING && this.ch?.panner) this.sys._place(this); } catch (e) { this.sys._warn(e); }
  }
  setPitch(p) {
    this.pitch = num(p, this.pitch);
    try { if (this.state === PLAYING) this.sys._rate(this); } catch (e) { this.sys._warn(e); }
  }
  setVolume(v) {
    this.volume = num(v, this.volume);
    try { if (this.state === PLAYING) this.sys._gain(this); } catch (e) { this.sys._warn(e); }
  }
}

export class AudioSystem {
  /**
   * @param {object} o
   * @param {object} o.sounds parsed sounds.json ({ sounds: { name: recipe }, music?, ambient? }) or the name -> recipe map
   * @param {number} [o.maxVoices=32] simultaneous game voices (music and ambient beds not counted)
   * @param {boolean} [o.worker=true] render recipes in a Web Worker (falls back to the main thread)
   */
  constructor({ sounds, maxVoices = 32, worker = true } = {}) {
    this.sounds = soundMap(sounds);
    this._applyConfig(sounds);
    this.maxVoices = Math.max(4, maxVoices | 0);
    this.volumes = { ...DEFAULT_VOLUMES };
    this.musicIntensity = 0;
    this.ctx = null;
    this.buses = null;
    const g = typeof window !== 'undefined' ? window : null;
    this._AC = g ? g.AudioContext ?? g.webkitAudioContext ?? null : null;
    this.enabled = !!this._AC;
    this._extra = new Map(); // unsaved recipes (preview)
    this._cache = new Map(); // name -> { recipe, key, count, data[], bufs[], ready, ... }
    this._queue = [];
    this._inflight = new Map();
    this._jobId = 0;
    this._active = [];
    this._pending = [];
    this._virtual = [];
    this._pool = { spatial: [], flat: [] };
    this._lx = 0; this._ly = 0; this._lz = 0;
    this._lf = new Float64Array(9).fill(NaN);
    this._camera = null;
    this._amb = {};
    this._tmpPos = { x: 0, y: 0, z: 0 };
    this._tickT = 0;
    this._beds = {};
    this._fear = 0;
    this._wf = 0; this._af = 0;
    this._intensity = 0;
    this._ms = { t: 0, n: 0, chord: -1, phraseLeft: 0, resting: true, restUntil: 0, calm: -1, combat: -1, drone: null, droneIdle: 0, started: false };
    this._notes = 0;
    this._warned = new Set();
    this._warmed = false;
    this._resumeAt = 0;
    this._preview = null;
    this._worker = null;
    this._clips = new Map(); // url -> { buffer, promise }
    this._clipHandles = new Set();
    this._ducking = 0;
    if (!this.enabled) return;
    if (worker) this._initWorker();
    this._gesture = () => this.resume();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) g.addEventListener(ev, this._gesture, { capture: true, passive: true });
    // the worker renders everything off the main thread shortly after boot -> first plays are instant
    if (this._worker) this._warmTimer = setTimeout(() => this._startWarmup(), 1500);
  }

  // ------------------------------------------------------------------ public API

  /** Start / unlock audio. Call from a user gesture (also done automatically on the first click / key). */
  resume() {
    try {
      const ctx = this._ensureContext();
      if (!ctx) return Promise.resolve(false);
      this._resumeAt = now();
      this._startWarmup();
      if (ctx.state === 'running') { this._onState(); return Promise.resolve(true); }
      return ctx.resume().then(() => { this._onState(); return ctx.state === 'running'; }, () => false);
    } catch (e) { this._warn(e); return Promise.resolve(false); }
  }

  /** The three.js camera used as the listener (also passed to update()). */
  setListener(camera) {
    this._camera = camera ?? null;
    try { if (camera && this.ctx?.state === 'running') this._updateListener(camera); } catch (e) { this._warn(e); }
  }

  /**
   * Play a sound. opts: { position?: {x,y,z} (spatial when given), volume = 1, pitch = 1 (playback
   * rate), loop = false, priority = recipe.priority ?? 0, bus = recipe.bus }. Returns a handle
   * { stop(fadeSec), setPosition(v), setPitch(p), setVolume(v), playing }.
   */
  play(name, opts) {
    try { return this._play(name, opts ?? {}) ?? NULL_HANDLE; } catch (e) { this._warn(e); return NULL_HANDLE; }
  }

  /** Play an unsaved recipe (editor). Stops the previous preview. Same opts as play(). */
  preview(recipe, opts = {}) {
    try {
      this.resume();
      if (this._preview) this._preview.stop(0.03);
      if (!recipe || typeof recipe !== 'object') return NULL_HANDLE;
      const key = JSON.stringify(recipe);
      const e = this._cache.get(PREVIEW);
      if (!e || e.key !== key) { this._extra.set(PREVIEW, recipe); this._cache.delete(PREVIEW); }
      const v = this._play(PREVIEW, { ...opts, lateOk: true });
      this._preview = v;
      return v ?? NULL_HANDLE;
    } catch (e) { this._warn(e); return NULL_HANDLE; }
  }

  /** Per-frame update: listener, ambient soundscape, music. No allocations in the steady state. */
  update(dt = 0, camera, ambientState) {
    try {
      if (camera) this._camera = camera;
      if (ambientState) this._amb = ambientState;
      if (!this._worker && this._queue.length && (this._warmed || this.ctx)) this._renderBudget(2);
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return;
      if (this._camera) this._updateListener(this._camera);
      this._tickT += num(dt, 0);
      if (this._tickT >= 0.1) {
        const tdt = Math.min(this._tickT, 0.5);
        this._tickT = 0;
        this._tick(tdt);
      }
      this._updateMusic(num(dt, 0));
    } catch (e) { this._warn(e); }
  }

  /** Bus volume 0..2: 'master' | 'sfx' | 'ambient' | 'music' | 'ui' | 'voice'. */
  setVolume(bus, v) {
    if (!BUSES.includes(bus)) { this._warn(`unknown bus "${bus}" (${BUSES.join(', ')})`); return; }
    this.volumes[bus] = clamp(num(+v, 1), 0, 2);
    try {
      const node = bus === 'master' ? this.master : this.buses?.[bus];
      if (node) node.gain.setTargetAtTime(this.volumes[bus], this.ctx.currentTime, 0.03);
    } catch (e) { this._warn(e); }
  }
  getVolume(bus) { return this.volumes[bus]; }

  /** 0 = calm exploration pads, 1 = tribal combat percussion (cross-faded). */
  setMusicIntensity(x) { this.musicIntensity = clamp01(num(+x, 0)); }

  /** Live edit (editor): new sounds.json. Changed recipes re-render; playing loops and beds pick them up. */
  reload(sounds) {
    try {
      this.sounds = soundMap(sounds);
      this._applyConfig(sounds);
      const changed = new Set();
      for (const [name, e] of this._cache) {
        if (name === PREVIEW) continue;
        const r = this.sounds[name];
        if (r && JSON.stringify(r) === e.key) { e.recipe = r; continue; }
        this._cache.delete(name);
        changed.add(name);
      }
      if (!changed.size) return;
      for (const v of this._active) if (changed.has(v.name)) { v.recipe = this.sounds[v.name] ?? v.recipe; if (v.loop) v.stale = true; }
      for (const b of Object.values(this._beds)) if (changed.has(b.name)) this._stopBed(b);
      if (this._ms.drone && changed.has('music_drone')) this._stopDrone(0.3);
      for (const name of changed) {
        const e = this._entry(name);
        if (e && (this._warmed || this._active.some((v) => v.name === name && v.stale))) this._request(e, this._active.some((v) => v.name === name));
      }
    } catch (e) { this._warn(e); }
  }

  /** Render these sounds now (default: all) so their first play is instant. */
  preload(names) {
    try { for (const n of names ?? Object.keys(this.sounds)) { const e = this._entry(n); if (e) this._request(e, false); } } catch (e) { this._warn(e); }
  }

  // ------------------------------------------------------------------ clips (recorded audio files)

  /** True once audio has started (after the first user gesture). */
  get running() { return this.ctx?.state === 'running'; }

  /** Fetch + decode an audio file once (cached). Resolves to an AudioBuffer, or null (no audio / error). */
  loadClip(url) {
    let c = this._clips.get(url);
    if (c) return c.promise;
    c = { buffer: null, promise: null };
    this._clips.set(url, c);
    c.promise = (async () => {
      try {
        const ctx = this._ensureContext();
        if (!ctx) return null;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        c.buffer = await ctx.decodeAudioData(await r.arrayBuffer());
        return c.buffer;
      } catch (e) { this._warn(e); return null; }
    })();
    return c.promise;
  }
  clipReady(url) { return !!this._clips.get(url)?.buffer; }

  /**
   * Play a loaded clip, flat (not spatial). opts: { bus = 'voice', volume = 1, radio = false
   * (band-limited, slightly saturated radio voice), offset = 0 (s into the clip), delay = 0 (s),
   * duck = true (lowers music and ambience while it plays) }. Not loaded yet / audio not started:
   * starts loading and returns a no-op handle. Handle: { stop(fade), setVolume(v), playing, duration }.
   */
  playClip(url, o = {}) {
    try {
      const c = this._clips.get(url), ctx = this.ctx;
      if (!c) this.loadClip(url);
      const buf = c?.buffer;
      if (!buf || !ctx || ctx.state !== 'running') return NULL_HANDLE;
      const offset = clamp(num(o.offset, 0), 0, buf.duration);
      if (offset > buf.duration - 0.05) return NULL_HANDLE;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = num(o.volume, 1);
      src.connect(g);
      g.connect(o.radio ? this.radioIn : this.buses[o.bus] ?? this.buses.voice);
      const duck = o.duck !== false;
      if (duck) this._duck(1);
      const sys = this;
      const h = {
        name: url, playing: true, duration: buf.duration,
        stop(fade = 0.05) {
          if (!h.playing) return;
          try { const t = ctx.currentTime; g.gain.setTargetAtTime(0, t, Math.max(0.005, fade / 3)); src.stop(t + Math.max(0.01, fade)); } catch (e) { sys._warn(e); }
        },
        setVolume(v) { try { g.gain.setTargetAtTime(num(v, 1), ctx.currentTime, 0.02); } catch (e) { sys._warn(e); } },
        setPosition() {}, setPitch() {},
      };
      src.onended = () => {
        if (!h.playing) return;
        h.playing = false;
        this._clipHandles.delete(h);
        try { g.disconnect(); } catch { /* */ }
        if (duck) this._duck(-1);
      };
      src.start(ctx.currentTime + Math.max(0, num(o.delay, 0)), offset);
      this._clipHandles.add(h);
      return h;
    } catch (e) { this._warn(e); return NULL_HANDLE; }
  }

  _duck(d) {
    this._ducking = Math.max(0, this._ducking + d);
    if (!this.ctx || !this.duckMusic) return;
    const on = this._ducking > 0, t = this.ctx.currentTime, tc = on ? 0.12 : 0.6;
    this.duckMusic.gain.setTargetAtTime(on ? DUCK.music : 1, t, tc);
    this.duckAmbient.gain.setTargetAtTime(on ? DUCK.ambient : 1, t, tc);
  }

  /** Stop every game voice (not ambient / music), e.g. on respawn or level change. */
  stopAll(fade = 0.1) {
    try {
      for (const h of [...this._clipHandles]) h.stop(fade);
      for (let i = this._active.length - 1; i >= 0; i--) this._stop(this._active[i], fade);
      for (const v of [...this._pending, ...this._virtual]) v.state = STOPPED;
      this._pending.length = 0; this._virtual.length = 0;
    } catch (e) { this._warn(e); }
  }

  /** Debug counters (for the live console / perf overlay). */
  get stats() {
    let ready = 0;
    for (const e of this._cache.values()) if (e.ready) ready++;
    const beds = {};
    for (const [k, b] of Object.entries(this._beds)) beds[k] = +Math.max(0, b.level).toFixed(2);
    return {
      state: this.ctx?.state ?? (this.enabled ? 'waiting for a user gesture' : 'unavailable'),
      voices: this._active.length, pending: this._pending.length, virtual: this._virtual.length,
      musicNotes: this._notes, rendered: ready, renderQueue: this._queue.length + this._inflight.size,
      worker: !!this._worker, beds, clips: this._clips.size, clipsPlaying: this._clipHandles.size,
      music: { intensity: +this._intensity.toFixed(2), calm: +Math.max(0, this._ms.calm).toFixed(2), combat: +Math.max(0, this._ms.combat).toFixed(2), resting: this._ms.resting },
    };
  }

  dispose() {
    try {
      clearTimeout(this._warmTimer);
      if (this._gesture) for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, this._gesture, { capture: true });
      this._worker?.terminate();
      this._worker = null;
      this.ctx?.close?.().catch?.(() => {});
    } catch { /* ignore */ }
    this.ctx = null;
    this.enabled = false;
    this._active.length = 0; this._pending.length = 0; this._virtual.length = 0; this._queue.length = 0;
  }

  // ------------------------------------------------------------------ config / context

  _applyConfig(json) {
    const m = json && typeof json === 'object' && json.sounds && typeof json.sounds === 'object' ? json : {};
    const M = { ...MUSIC_DEFAULTS, ...(m.music ?? {}) };
    M.levels = { ...MUSIC_DEFAULTS.levels, ...(m.music?.levels ?? {}) };
    M.patterns = { ...MUSIC_DEFAULTS.patterns, ...(m.music?.patterns ?? {}) };
    if (!Array.isArray(M.chords) || !M.chords.length) M.chords = MUSIC_DEFAULTS.chords;
    if (!Array.isArray(M.scale) || !M.scale.length) M.scale = MUSIC_DEFAULTS.scale;
    M.bpm = clamp(num(M.bpm, 96), 30, 240);
    this.music = M;
    this._patterns = Object.entries(M.patterns).map(([k, p]) => ({
      name: 'music_' + k, level: num(M.levels[k], 0.5), bass: k === 'bass', steps: String(p).padEnd(16, '.').slice(0, 16).split(''),
    }));
    const A = { ...AMBIENT_DEFAULTS, ...(m.ambient ?? {}) };
    A.beds = { ...AMBIENT_DEFAULTS.beds, ...(m.ambient?.beds ?? {}) };
    A.sounds = { ...AMBIENT_DEFAULTS.sounds, ...(m.ambient?.sounds ?? {}) };
    this.ambient = A;
  }

  _ensureContext() {
    if (this.ctx || !this._AC) return this.ctx;
    try {
      const ctx = new this._AC({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this._buildGraph(ctx);
      ctx.onstatechange = () => { try { this._onState(); } catch (e) { this._warn(e); } };
    } catch (e) {
      this._warn('Web Audio unavailable: ' + (e?.message ?? e));
      this.ctx = null;
      this._AC = null;
      this.enabled = false;
    }
    return this.ctx;
  }

  _buildGraph(ctx) {
    const gain = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const lowpass = () => { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 20000; f.Q.value = 0.5; return f; };
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 4; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.2;
    lim.connect(ctx.destination);
    this.limiter = lim;
    this.master = gain(this.volumes.master);
    this.master.connect(lim);
    this.worldFilter = lowpass();
    this.worldFilter.connect(this.master);
    this.ambFilter = lowpass();
    this.ambFilter.connect(this.worldFilter);
    this.buses = { sfx: gain(this.volumes.sfx), ambient: gain(this.volumes.ambient), ui: gain(this.volumes.ui), music: gain(this.volumes.music), voice: gain(this.volumes.voice) };
    this.duckMusic = gain(1);
    this.duckAmbient = gain(1);
    this.buses.sfx.connect(this.worldFilter);
    this.buses.ambient.connect(this.duckAmbient);
    this.duckAmbient.connect(this.ambFilter);
    this.buses.ui.connect(this.master);
    this.buses.music.connect(this.duckMusic);
    this.duckMusic.connect(this.master);
    this.buses.voice.connect(this.master);
    this.radioIn = radioFilter(ctx, this.buses.voice);
    if (this._ducking) this._duck(0);
    this.musicCalm = gain(0);
    this.musicCalm.connect(this.buses.music);
    this.musicCombat = gain(0);
    this.musicCombat.connect(this.buses.music);
  }

  _onState() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (this._gesture) {
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, this._gesture, { capture: true });
      this._gesture = null;
    }
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const v = this._pending[i];
      const e = this._entry(v.name);
      if (e?.ready) { this._pending.splice(i, 1); this._startPending(v, e); }
    }
  }

  _warn(msg) {
    const s = String(msg?.message ?? msg);
    if (this._warned.has(s) || this._warned.size > 50) return;
    this._warned.add(s);
    console.warn('[audio]', s);
  }

  // ------------------------------------------------------------------ rendering (cache / worker)

  _recipe(name) { return this._extra.get(name) ?? this.sounds[name]; }

  _entry(name) {
    let e = this._cache.get(name);
    if (e) return e;
    const recipe = this._recipe(name);
    if (!recipe || typeof recipe !== 'object') return null;
    e = { name, recipe, key: JSON.stringify(recipe), count: name === PREVIEW ? 1 : variationCount(recipe), data: [], bufs: [], ready: 0, queued: 0, failed: false, last: -1, dur: estimateDuration(recipe) };
    this._cache.set(name, e);
    return e;
  }

  _initWorker() {
    try {
      if (typeof Worker === 'undefined') return;
      const w = new Worker(new URL('./synth.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => { try { this._onRendered(ev.data); } catch (e) { this._warn(e); } };
      w.onerror = (ev) => { ev?.preventDefault?.(); this._workerFailed(); };
      this._worker = w;
    } catch { this._worker = null; }
  }

  _workerFailed() {
    if (!this._worker) return;
    this._warn('audio worker unavailable, rendering on the main thread');
    try { this._worker.terminate(); } catch { /* ignore */ }
    this._worker = null;
    for (const job of this._inflight.values()) this._queue.unshift(job);
    this._inflight.clear();
  }

  _startWarmup() {
    if (this._warmed) return;
    this._warmed = true;
    clearTimeout(this._warmTimer);
    // one variation of everything (ambient beds and gunfire first); the other variations of a
    // sound render once it is actually played (keeps memory down for unused sounds)
    const A = this.ambient.sounds, first = new Set(BED_KEYS.map((k) => A[k]));
    const names = Object.keys(this.sounds).sort((a, b) => rank(a) - rank(b));
    function rank(n) { return first.has(n) ? 0 : /shot|explosion|impact|footstep/.test(n) ? 1 : 2; }
    for (const n of names) { const e = this._entry(n); if (e) this._request(e, false, 1); }
  }

  _live(job) { const e = job.e; return this._cache.get(e.name) === e && !e.failed && !e.data[job.v] && !e.bufs[job.v]; }

  /** Queue the renders of variations [0, n) of a sound (urgent: its first job jumps the queue). */
  _request(e, urgent, n = e?.count) {
    if (!e || e.failed) return;
    for (let v = e.queued; v < n; v++) this._queue.push({ e, v });
    if (n > e.queued) e.queued = n;
    if (urgent) {
      const i = this._queue.findIndex((j) => j.e === e);
      if (i > 0) this._queue.unshift(this._queue.splice(i, 1)[0]);
    }
    this._pump();
  }

  _pump() {
    const w = this._worker;
    if (!w) return;
    while (this._inflight.size < 2 && this._queue.length) {
      const job = this._queue.shift();
      if (!this._live(job)) continue;
      const id = ++this._jobId;
      this._inflight.set(id, job);
      try { w.postMessage({ id, recipe: job.e.recipe, seed: job.v + 1 }); }
      catch { this._inflight.delete(id); this._queue.unshift(job); this._workerFailed(); return; }
    }
  }

  _onRendered(msg) {
    const job = this._inflight.get(msg?.id);
    if (!job) return;
    this._inflight.delete(msg.id);
    if (msg.error) { job.e.failed = true; this._warn(`sound "${job.e.name}": ${msg.error}`); }
    else if (msg.samples) this._store(job, msg.samples);
    this._pump();
  }

  _renderNow(job) {
    if (!this._live(job)) return;
    try { this._store(job, renderSound(job.e.recipe, { seed: job.v + 1 })); }
    catch (err) { job.e.failed = true; this._warn(`sound "${job.e.name}": ${err.message}`); }
  }

  _renderBudget(ms) {
    const t0 = now();
    while (this._queue.length && now() - t0 < ms) this._renderNow(this._queue.shift());
  }

  _store(job, samples) {
    const e = job.e;
    if (this._cache.get(e.name) !== e || e.data[job.v] || e.bufs[job.v]) return;
    e.data[job.v] = samples;
    e.ready++;
    this._onReady(e);
  }

  _onReady(e) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const v = this._pending[i];
      if (v.name !== e.name) continue;
      this._pending.splice(i, 1);
      this._startPending(v, e);
    }
    for (let i = 0; i < this._active.length; i++) { const v = this._active[i]; if (v.stale && v.name === e.name) this._swap(v, e); }
  }

  _startPending(v, e) {
    if (!v.loop && !v.lateOk && now() - v.t0 > ONE_SHOT_LATE) { v.state = STOPPED; return; }
    if (v.spatial) v.dist = this._distTo(v);
    this._start(v, e);
  }

  /** A random ready variation (not the last one played when possible) as an AudioBuffer. */
  _buffer(e) {
    if (!e?.ready) return null;
    let pick = -1, n = 0;
    for (let v = 0; v < e.count; v++) {
      if ((e.bufs[v] || e.data[v]) && v !== e.last && Math.random() * ++n < 1) pick = v;
    }
    if (pick < 0) pick = e.last;
    e.last = pick;
    let b = e.bufs[pick];
    if (!b) {
      const s = e.data[pick];
      try { b = new AudioBuffer({ length: s.length, numberOfChannels: 1, sampleRate: SAMPLE_RATE }); }
      catch { b = this.ctx.createBuffer(1, s.length, SAMPLE_RATE); }
      if (b.copyToChannel) b.copyToChannel(s, 0); else b.getChannelData(0).set(s);
      e.bufs[pick] = b;
      e.data[pick] = null;
    }
    return b;
  }

  // ------------------------------------------------------------------ voices

  _play(name, o) {
    const recipe = this._recipe(name);
    if (!recipe) { this._warn(`unknown sound "${name}"`); return null; }
    if (!this.enabled) return null;
    const v = new Voice(this, name, recipe, o);
    v.lateOk = !!o.lateOk;
    if (v.bus === 'master' || !BUSES.includes(v.bus)) v.bus = 'sfx';
    const ctx = this.ctx;
    const e = this._entry(name);
    if (!e) return null;
    if (!ctx || ctx.state !== 'running') {
      // not started yet: loops wait for audio to start; one-shots only right after resume()
      if (!v.loop && !(this._resumeAt && now() - this._resumeAt < 500)) return null;
      v.t0 = now();
      this._pending.push(v);
      this._request(e, true);
      return v;
    }
    if (v.spatial) {
      v.dist = this._distTo(v);
      if (v.dist > v.max) {
        if (!v.loop) return null;
        v.state = VIRTUAL; // out of range: starts when the listener comes closer
        this._virtual.push(v);
        this._request(e, false);
        return v;
      }
    }
    if (!e.ready && !e.failed && !v.loop && e.dur <= SYNC_RENDER_MAX) this._renderNow({ e, v: 0 });
    if (e.queued < e.count) this._request(e, false);
    if (!e.ready) {
      if (e.failed) return null;
      v.t0 = now();
      this._pending.push(v);
      this._request(e, true);
      return v;
    }
    this._start(v, e);
    return v;
  }

  _score(v) {
    let a = v.volume * v.varGain;
    if (v.spatial) a *= v.ref / (v.ref + v.rolloff * (Math.max(v.dist, v.ref) - v.ref));
    return v.priority * 4 + a;
  }

  _start(v, e) {
    const ctx = this.ctx;
    const buf = this._buffer(e);
    if (!buf) return false;
    // per-sound cap: the oldest instance of the same sound makes room
    const cap = Math.max(1, num(v.recipe.maxInstances, 8));
    let same = 0, oldest = null;
    for (let i = 0; i < this._active.length; i++) {
      const a = this._active[i];
      if (a.name === v.name) { same++; if (!oldest || a.started < oldest.started) oldest = a; }
    }
    if (same >= cap && oldest) this._halt(oldest, 0.03);
    // global voice limit: drop the lowest priority / least audible voice (maybe this one)
    if (this._active.length >= this.maxVoices) {
      let victim = null, vs = Infinity;
      for (let i = 0; i < this._active.length; i++) { const s = this._score(this._active[i]); if (s < vs) { vs = s; victim = this._active[i]; } }
      if (!victim || vs > this._score(v)) {
        if (v.loop) { v.state = VIRTUAL; this._virtual.push(v); } else v.state = STOPPED;
        return false;
      }
      this._halt(victim, 0.03);
    }
    const ch = this._channel(v.spatial, this.buses[v.bus] ?? this.buses.sfx);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = v.loop;
    src.playbackRate.value = v.lastRate = clamp(v.pitch * v.varPitch, 0.05, 16);
    src.connect(ch.input);
    const t = ctx.currentTime, g = ch.gain.gain, target = v.lastGain = v.volume * v.varGain;
    g.cancelScheduledValues(0);
    if (v.fadeIn) { g.value = 0; g.setTargetAtTime(target, t, 0.1); v.fadeIn = false; } else g.value = target;
    v.ch = ch;
    if (v.spatial) {
      const p = ch.panner;
      p.panningModel = 'equalpower'; p.distanceModel = 'inverse';
      p.refDistance = v.ref; p.maxDistance = v.max; p.rolloffFactor = v.rolloff;
      ch.cut = -1;
      this._place(v);
    }
    src.onended = () => this._ended(v, src, ch);
    src.start(t, v.loop ? Math.random() * buf.duration : 0);
    v.src = src;
    v.state = PLAYING;
    v.started = t;
    v.idx = this._active.length;
    this._active.push(v);
    return true;
  }

  _channel(spatial, bus) {
    let ch = (spatial ? this._pool.spatial : this._pool.flat).pop();
    if (!ch) {
      const ctx = this.ctx, gain = ctx.createGain();
      ch = { gain, input: gain, out: gain, panner: null, air: null, bus: null, cut: -1 };
      if (spatial) {
        ch.air = ctx.createBiquadFilter();
        ch.air.type = 'lowpass'; ch.air.Q.value = 0.5; ch.air.frequency.value = 20000;
        ch.panner = ctx.createPanner();
        gain.connect(ch.air);
        ch.air.connect(ch.panner);
        ch.out = ch.panner;
      }
    }
    if (ch.bus !== bus) {
      if (ch.bus) ch.out.disconnect();
      ch.out.connect(bus);
      ch.bus = bus;
    }
    return ch;
  }

  _place(v) {
    const ch = v.ch, p = ch.panner;
    if (p.positionX) { p.positionX.value = v.x; p.positionY.value = v.y; p.positionZ.value = v.z; }
    else p.setPosition(v.x, v.y, v.z);
    this._air(v);
  }

  /** Air absorption: far sounds lose their highs. */
  _air(v) {
    const ch = v.ch;
    v.dist = this._distTo(v);
    const cut = v.dist < 25 ? 20000 : Math.max(900, 20000 / (1 + (v.dist - 25) / 30));
    if (ch.cut < 0 || Math.abs(cut - ch.cut) > ch.cut * 0.04) { ch.air.frequency.value = cut; ch.cut = cut; }
  }

  _distTo(v) { const dx = v.x - this._lx, dy = v.y - this._ly, dz = v.z - this._lz; return Math.sqrt(dx * dx + dy * dy + dz * dz); }

  // per-frame setPitch / setVolume (engines) only schedule an automation event on a real change
  _rate(v) {
    const r = clamp(v.pitch * v.varPitch, 0.05, 16);
    if (Math.abs(r - v.lastRate) < r * 0.002) return;
    v.lastRate = r;
    v.src.playbackRate.setTargetAtTime(r, this.ctx.currentTime, 0.03);
  }
  _gain(v) {
    const g = Math.max(0, v.volume * v.varGain);
    if (Math.abs(g - v.lastGain) < 0.002) return;
    v.lastGain = g;
    v.ch.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
  }

  _removeActive(v) {
    const i = v.idx;
    if (i < 0) return;
    const last = this._active.pop();
    if (last !== v) { this._active[i] = last; last.idx = i; }
    v.idx = -1;
  }

  /** Fade out the current source; its channel goes back to the pool when it has ended. */
  _release(v, fade) {
    const t = this.ctx.currentTime, g = v.ch.gain.gain;
    fade = Math.max(0.005, num(+fade, 0.05));
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    try { v.src.stop(t + fade + 0.01); } catch { /* already stopped */ }
    this._removeActive(v);
  }

  _stop(v, fade) {
    if (v.state === PENDING) { const i = this._pending.indexOf(v); if (i >= 0) this._pending.splice(i, 1); v.state = STOPPED; return; }
    if (v.state === VIRTUAL) { const i = this._virtual.indexOf(v); if (i >= 0) this._virtual.splice(i, 1); v.state = STOPPED; return; }
    if (v.state !== PLAYING || !this.ctx) return;
    this._release(v, fade);
    v.state = STOPPING;
  }

  /** Voice stealing / out of range: one-shots stop, loops become virtual and come back later. */
  _halt(v, fade) {
    if (v.state !== PLAYING) return;
    this._release(v, fade);
    if (v.loop) { v.state = VIRTUAL; this._virtual.push(v); } else v.state = STOPPING;
  }

  _ended(v, src, ch) {
    try { src.disconnect(); } catch { /* ignore */ }
    if (v.src === src) {
      v.src = null; v.ch = null;
      if (v.state === PLAYING) { this._removeActive(v); v.state = STOPPED; } else if (v.state === STOPPING) v.state = STOPPED;
    } else if (v.ch === ch) return; // buffer swapped on the same channel (live edit)
    (ch.panner ? this._pool.spatial : this._pool.flat).push(ch);
  }

  /** Live edit: swap the buffer of a playing loop. */
  _swap(v, e) {
    const buf = this._buffer(e), ctx = this.ctx, ch = v.ch, old = v.src;
    v.stale = false;
    if (!buf || !ch) return;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.playbackRate.value = clamp(v.pitch * v.varPitch, 0.05, 16);
    src.connect(ch.input);
    src.onended = () => this._ended(v, src, ch);
    src.start();
    v.src = src;
    try { old?.stop(); } catch { /* ignore */ }
  }

  _updateListener(cam) {
    const m = cam.matrixWorld?.elements;
    if (!m) return;
    const L = this.ctx.listener, f = this._lf;
    const x = m[12], y = m[13], z = m[14], fx = -m[8], fy = -m[9], fz = -m[10], ux = m[4], uy = m[5], uz = m[6];
    this._lx = x; this._ly = y; this._lz = z;
    if (Math.abs(f[0] - x) + Math.abs(f[1] - y) + Math.abs(f[2] - z) + Math.abs(f[3] - fx) + Math.abs(f[4] - fy) + Math.abs(f[5] - fz) + Math.abs(f[6] - ux) + Math.abs(f[7] - uy) + Math.abs(f[8] - uz) < 1e-4) return;
    f[0] = x; f[1] = y; f[2] = z; f[3] = fx; f[4] = fy; f[5] = fz; f[6] = ux; f[7] = uy; f[8] = uz;
    if (L.positionX) {
      L.positionX.value = x; L.positionY.value = y; L.positionZ.value = z;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(x, y, z);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // ------------------------------------------------------------------ 10 Hz tick: voices + ambience

  _tick(dt) {
    const t = now();
    // pending one-shots that waited too long are dropped
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const v = this._pending[i];
      if (!v.loop && !v.lateOk && t - v.t0 > ONE_SHOT_LATE) { this._pending.splice(i, 1); v.state = STOPPED; }
    }
    // spatial voices: air absorption follows the listener; far loops go virtual
    for (let i = this._active.length - 1; i >= 0; i--) {
      const v = this._active[i];
      if (!v.spatial) continue;
      this._air(v);
      if (v.loop && v.dist > v.max * 1.1) this._halt(v, 0.3);
    }
    // virtual loops come back when in range and a voice is free
    for (let i = this._virtual.length - 1; i >= 0; i--) {
      if (this._active.length >= this.maxVoices - 1) break;
      const v = this._virtual[i];
      if (v.src) continue; // still fading out
      if (v.spatial && (v.dist = this._distTo(v)) > v.max) continue;
      const e = this._entry(v.name);
      if (!e?.ready) continue;
      this._virtual.splice(i, 1);
      v.fadeIn = true;
      this._start(v, e);
    }
    this._tickAmbient(dt);
  }

  _tickAmbient(dt) {
    const s = this._amb, A = this.ambient, ctx = this.ctx, t = ctx.currentTime;
    const under = s.underwater ? 1 : 0, above = 1 - under, indoor = s.indoor ? 1 : 0;
    const night = clamp01(num(s.night, 0)), day = 1 - night;
    const jungle = clamp01(num(s.inJungle, 0));
    const coast = clamp01(1 - num(s.coastDistance, 1e4) / Math.max(1, A.oceanRange)), coastG = coast * coast;
    const h = num(s.height, 0);
    this._fear = Math.max(clamp01(num(s.combat, 0)), this._fear - dt / 30); // wildlife hides during / after fights
    const calm = 1 - this._fear, muffle = 1 - 0.45 * indoor;
    this._bed('ocean', above * coastG * muffle, dt);
    this._bed('wind', above * (0.15 + 0.6 * smoothstep(15, 140, h) + 0.2 * coastG) * (1 - 0.45 * jungle) * muffle, dt);
    this._bed('cicadas', above * day * (0.15 + 0.85 * jungle) * (1 - 0.7 * this._fear) * muffle, dt);
    this._bed('frogs', above * night * (0.3 + 0.7 * jungle) * (1 - 0.7 * this._fear) * muffle, dt);
    this._bed('crickets', above * night * (0.55 + 0.45 * (1 - coastG)) * (1 - 0.5 * this._fear) * muffle, dt);
    this._bed('underwater', under, dt);
    const wf = under ? 550 : 20000;
    if (wf !== this._wf) { this._wf = wf; this.worldFilter.frequency.setTargetAtTime(wf, t, 0.05); }
    const af = indoor ? 1500 : 20000;
    if (af !== this._af) { this._af = af; this.ambFilter.frequency.setTargetAtTime(af, t, 0.2); }
    // spot sounds placed around the listener
    const S = A.sounds, out = above * (1 - 0.8 * indoor) * calm;
    if (Math.random() < out * day * (0.15 + 0.85 * jungle) * (A.birdsPerMinute / 60) * dt) {
      this._spot(Math.random() < A.parrotShare * (0.3 + 0.7 * jungle) ? S.parrot : S.bird, 12, 55, 4, 16);
    }
    if (Math.random() < out * day * coastG * (A.gullsPerMinute / 60) * dt) this._spot(S.gull, 25, 90, 15, 40);
    if (Math.random() < out * night * (0.3 + 0.7 * jungle) * (A.owlsPerMinute / 60) * dt) this._spot(S.owl, 30, 90, 6, 20);
  }

  _spot(name, dMin, dMax, hMin, hMax) {
    if (!name || !this._recipe(name)) return;
    const a = Math.random() * TAU, d = dMin + Math.random() * (dMax - dMin), p = this._tmpPos;
    p.x = this._lx + Math.cos(a) * d; p.y = this._ly + hMin + Math.random() * (hMax - hMin); p.z = this._lz + Math.sin(a) * d;
    this._play(name, { position: p, priority: -1 });
  }

  _bed(key, level, dt) {
    let b = this._beds[key];
    if (!b) b = this._beds[key] = { key, name: null, gain: null, pans: null, srcs: [null, null], level: 0, running: false, idle: 0 };
    const name = this.ambient.sounds[key];
    if (b.name !== name) { this._stopBed(b); b.name = name; }
    const target = level * num(this.ambient.beds[key], 1);
    if (target > 0.002) { b.idle = 0; if (!b.running) this._startBed(b); }
    else if (b.running && (b.idle += dt) > 6) this._stopBed(b);
    if (b.gain && Math.abs(target - b.level) > 0.004) { b.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.8); b.level = target; }
  }

  /** Two decorrelated copies of the loop panned left / right: a wide stereo bed from a mono loop. */
  _startBed(b) {
    const e = b.name ? this._entry(b.name) : null;
    if (!e) return;
    if (!e.ready) { this._request(e, true); return; }
    const ctx = this.ctx;
    if (!b.gain) {
      b.gain = ctx.createGain();
      b.gain.gain.value = 0;
      b.level = 0;
      b.gain.connect(this.buses.ambient);
      b.pans = [-0.6, 0.6].map((pan) => {
        if (!ctx.createStereoPanner) return b.gain;
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        p.connect(b.gain);
        return p;
      });
    }
    const buf = this._buffer(e);
    for (let k = 0; k < 2; k++) {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      src.playbackRate.value = k ? 0.985 : 1;
      src.connect(b.pans[k]);
      src.start(ctx.currentTime, (k * 0.5 + Math.random() * 0.25) * buf.duration);
      b.srcs[k] = src;
    }
    b.running = true;
  }

  _stopBed(b) {
    for (let k = 0; k < 2; k++) {
      const s = b.srcs[k];
      if (!s) continue;
      try { s.stop(); s.disconnect(); } catch { /* ignore */ }
      b.srcs[k] = null;
    }
    b.running = false;
  }

  // ------------------------------------------------------------------ generative music

  _updateMusic(dt) {
    const M = this.music, ms = this._ms, ctx = this.ctx, t = ctx.currentTime;
    const target = Math.max(this.musicIntensity, clamp01(num(this._amb.combat, 0)));
    this._intensity += (target - this._intensity) * Math.min(1, dt / (target > this._intensity ? 1.5 : 6));
    const I = this._intensity;
    if (!ms.started) { ms.started = true; ms.restUntil = t + num(M.firstDelay, 6); ms.t = t + 0.1; }
    if (this.volumes.music <= 0 || this.volumes.master <= 0) { ms.t = t + 0.1; return; }
    const calm = ms.resting ? 0 : 1 - smoothstep(0.3, 0.7, I);
    const combat = smoothstep(0.2, 0.6, I);
    if (Math.abs(calm - ms.calm) > 0.01) { this.musicCalm.gain.setTargetAtTime(calm, t, calm > ms.calm ? 1.5 : 2.5); ms.calm = calm; }
    if (Math.abs(combat - ms.combat) > 0.01) { this.musicCombat.gain.setTargetAtTime(combat, t, combat > ms.combat ? 0.8 : 3); ms.combat = combat; }
    // combat drone under the drums
    if (combat > 0.01) { ms.droneIdle = 0; if (!ms.drone) this._startDrone(); }
    else if (ms.drone && (ms.droneIdle += dt) > 10) this._stopDrone(0.5);
    // 16th-note step scheduler, 120 ms look-ahead
    const step = 60 / M.bpm / 4;
    if (ms.t < t) ms.t = t + 0.05; // resync after a stall / hidden tab
    while (ms.t < t + 0.12) { this._musicStep(ms.n, ms.t, I); ms.n++; ms.t += step; }
  }

  _musicStep(n, t, I) {
    const M = this.music, ms = this._ms;
    const s = n % 16, bar = Math.floor(n / 16);
    if (s === 0 && bar % Math.max(1, M.barsPerChord | 0) === 0) {
      ms.chord = (ms.chord + 1) % M.chords.length;
      if (ms.resting) {
        if (t >= ms.restUntil) { ms.resting = false; ms.chord = 0; ms.phraseLeft = Math.round(range(M.phraseChords, 8)); }
      } else if (--ms.phraseLeft <= 0 && I < 0.3) {
        ms.resting = true;
        ms.restUntil = t + range(M.restSeconds, 30);
      }
      if (!ms.resting && ms.calm > 0.01) {
        const chord = M.chords[ms.chord];
        for (let k = 0; k < chord.length; k++) this._note('music_pad', t + Math.random() * 0.05, chord[k] - M.padRoot, M.levels.pad, this.musicCalm);
      }
    }
    if (!ms.resting && ms.calm > 0.01 && s % 2 === 0 && Math.random() < M.pluckDensity) {
      const m = M.scale[(Math.random() * M.scale.length) | 0];
      this._note('music_pluck', t + Math.random() * 0.02, m - M.pluckRoot, M.levels.pluck * (0.6 + 0.4 * Math.random()), this.musicCalm);
    }
    if (ms.combat > 0.01) {
      const root = M.chords[Math.max(0, ms.chord)][0];
      let bassSemis = (((root - M.bassRoot) % 12) + 12) % 12;
      if (bassSemis > 6) bassSemis -= 12;
      for (let k = 0; k < this._patterns.length; k++) {
        const P = this._patterns[k], c = P.steps[s];
        let vel = c === 'x' ? 1 : c === 'o' ? 0.55 : c === '?' && Math.random() < 0.25 + 0.5 * I ? 0.7 : 0;
        if (!vel && P.name === 'music_shaker' && Math.random() < 0.3 * I) vel = 0.35; // busier when intense
        if (vel) this._note(P.name, t, P.bass ? bassSemis : 0, P.level * vel * (0.9 + 0.1 * Math.random()), this.musicCombat);
      }
    }
  }

  _note(name, t, semis, vol, dest) {
    const e = this._entry(name);
    if (!e) return;
    if (!e.ready) { this._request(e, false); return; }
    if (this._notes >= 24) return;
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = this._buffer(e);
    if (semis) src.playbackRate.value = Math.pow(2, semis / 12);
    g.gain.value = vol;
    src.connect(g);
    g.connect(dest);
    this._notes++;
    src.onended = () => { this._notes--; try { g.disconnect(); } catch { /* ignore */ } };
    src.start(Math.max(t, ctx.currentTime));
  }

  _startDrone() {
    const e = this._entry('music_drone');
    if (!e) { this._ms.drone = false; return; }
    if (!e.ready) { this._request(e, false); return; }
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = this._buffer(e); src.loop = true;
    g.gain.value = 0;
    g.gain.setTargetAtTime(num(this.music.levels.drone, 0.3), ctx.currentTime, 1.5);
    src.connect(g);
    g.connect(this.musicCombat);
    src.start();
    this._ms.drone = { src, g };
  }

  _stopDrone(fade) {
    const d = this._ms.drone;
    this._ms.drone = null;
    if (!d) return;
    const t = this.ctx.currentTime;
    try { d.g.gain.setTargetAtTime(0, t, fade); d.src.stop(t + fade * 5); } catch { /* ignore */ }
  }
}
