// Playback for the Audio panel. Two AudioSystem instances, both created lazily on a click:
//  - `preview`: plays the edited recipe (preview()) and random variations (play(name) on the
//    edited document, exactly like the game picks them). Never update()d: no ambience / music.
//  - `test`: the music / ambience test (setMusicIntensity + update(dt, camera, ambientState)
//    driven by the panel's requestAnimationFrame loop).
import { signal } from '@preact/signals';
import { AudioSystem } from '../../../engine/audio/Audio.js';
import { SAMPLE_RATE } from '../../../engine/audio/synth.js';

let preview = null;
let previewDoc = null; // the document the preview system last reloaded
export const playing = signal(null); // { name, loop, t0 (performance.now ms), rate, dur, variation, handle } | null

// clear `playing` when the voice ends (one-shots) or is stopped
let watch = 0;
function watchPlaying() {
  clearInterval(watch);
  watch = setInterval(() => {
    const p = playing.value;
    if (!p) { clearInterval(watch); return; }
    if (p.handle && !p.handle.playing) { playing.value = null; clearInterval(watch); }
  }, 100);
}

function previewSystem(doc) {
  if (!preview) { preview = new AudioSystem({ sounds: doc }); previewDoc = doc; }
  return preview;
}

/** ▶ Play a recipe (variation 1, like AudioSystem.preview renders it). */
export function playRecipe(doc, name, recipe, { loop = false, dur = 1 } = {}) {
  const a = previewSystem(doc);
  a.resume();
  randomToken++;
  stopDirect();
  const h = a.preview(recipe, { loop });
  playing.value = { name, loop, t0: performance.now(), rate: 1, dur, variation: 0, handle: h, kind: 'preview' };
  watchPlaying();
  return h;
}

/**
 * Play the exact rendered samples of one variation through the preview system's context (used
 * for variations other than the first, which preview() cannot pick).
 */
let direct = null;
export function playSamples(doc, name, recipe, samples, variation, { loop = false } = {}) {
  const a = previewSystem(doc);
  randomToken++;
  const go = () => {
    const ctx = a.ctx;
    if (!ctx || ctx.state !== 'running' || !a.buses) return;
    try { a._preview?.stop(0.03); } catch { /* ignore */ }
    stopDirect();
    const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    const range = (r, d) => (Array.isArray(r) && r.length > 1 ? r[0] + (r[1] - r[0]) * Math.random() : d);
    const rate = range(recipe.variations?.pitch, 1);
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate;
    g.gain.value = range(recipe.variations?.gain, 1);
    src.connect(g);
    g.connect(a.buses[recipe.bus] ?? a.buses.sfx);
    src.start();
    direct = { src, g };
    src.onended = () => { if (direct?.src === src) { direct = null; if (playing.value?.kind === 'direct') playing.value = null; } };
    playing.value = { name, loop, t0: performance.now(), rate, dur: samples.length / SAMPLE_RATE, variation, kind: 'direct' };
  };
  a.resume().then(go);
}

function stopDirect() {
  if (!direct) return;
  const { src, g } = direct;
  direct = null;
  try {
    const t = src.context.currentTime;
    g.gain.setTargetAtTime(0, t, 0.01);
    src.stop(t + 0.06);
  } catch { /* ignore */ }
}

/**
 * 🎲 A random variation, picked and pitched like in the game (AudioSystem.play on the edited
 * document). Waits for the edited recipe to be rendered (one-shots waiting > 250 ms would be
 * dropped by the game logic). onPlayed(variationIndex) once it starts (-1 if unknown).
 */
let randomToken = 0;
export function playRandom(doc, name, onPlayed) {
  const a = previewSystem(doc);
  if (previewDoc !== doc) { a.reload(doc); previewDoc = doc; }
  stopDirect();
  try { a._preview?.stop(0.03); } catch { /* ignore */ }
  const token = ++randomToken;
  const go = () => {
    if (token !== randomToken) return;
    const h = a.play(name);
    let v = -1;
    try { v = a._cache.get(name)?.last ?? -1; } catch { /* ignore */ }
    playing.value = h?.playing ? { name, loop: false, t0: performance.now(), rate: h.lastRate || 1, dur: 0, variation: v, handle: h, kind: 'random' } : null;
    watchPlaying();
    onPlayed?.(v);
  };
  a.resume().then(() => {
    let e = null;
    try { e = a._entry(name); if (e && !e.ready && !e.failed) a._request(e, true); } catch { e = null; }
    if (!e || e.ready || e.failed) { go(); return; }
    const t0 = performance.now();
    const wait = () => {
      if (token !== randomToken) return;
      if (e.ready || e.failed || a._cache.get(name) !== e || performance.now() - t0 > 4000) go();
      else setTimeout(wait, 25);
    };
    wait();
  });
}

export function stopPreview() {
  randomToken++;
  stopDirect();
  try { preview?._preview?.stop(0.05); } catch { /* ignore */ }
  try { preview?.stopAll(0.05); } catch { /* ignore */ }
  playing.value = null;
}

/** Position (s, in the rendered buffer) of the current one-shot preview, or null. */
export function playheadTime() {
  const p = playing.value;
  if (!p) return null;
  const h = p.handle;
  if (h && !h.playing) return null;
  let t;
  if (h && preview?.ctx && h.state === 1 && Number.isFinite(h.started)) t = (preview.ctx.currentTime - h.started) * (h.lastRate || 1);
  else t = ((performance.now() - p.t0) / 1000) * (p.rate || 1);
  if (p.loop) return null;
  return t;
}

export function disposePlayers() {
  stopPreview();
  preview?.dispose();
  preview = null;
  previewDoc = null;
  stopTest();
}

// ------------------------------------------------------------------ music / ambience test

export const test = {
  on: signal(false),
  state: signal({ night: 0, inJungle: 0.5, coastDistance: 120, height: 2, underwater: false, indoor: false, combat: 0 }),
  intensity: signal(0),
  musicVol: signal(0.5),
  ambientVol: signal(0.8),
  stats: signal(null),
  sys: null,
};

/** The test plays the edited document; calm music starts after at most 1 s instead of `firstDelay`. */
export function testDoc(doc) {
  const m = doc.music ?? {};
  return { ...doc, music: { ...m, firstDelay: Math.min(1, Number.isFinite(+m.firstDelay) ? +m.firstDelay : 6) } };
}

export function startTest(doc) {
  if (test.sys) return;
  const a = (test.sys = new AudioSystem({ sounds: testDoc(doc) }));
  a._testDoc = doc;
  a.resume();
  a.setMusicIntensity(test.intensity.value);
  a.setVolume('music', test.musicVol.value);
  a.setVolume('ambient', test.ambientVol.value);
  test.on.value = true;
}

export function stopTest() {
  test.sys?.dispose();
  test.sys = null;
  test.on.value = false;
  test.stats.value = null;
}

/** Called every frame by the panel while it is open. */
export function tickTest(dt, camera, doc) {
  const a = test.sys;
  if (!a) return;
  if (a._testDoc !== doc) { a._testDoc = doc; a.reload(testDoc(doc)); }
  a.update(dt, camera, test.state.value);
}
