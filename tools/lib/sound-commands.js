// mc sound commands: list / render to WAV / check the procedural sound recipes of
// public/data/sounds.json (format: src/engine/audio/synth.js, docs/AUDIO.md). Pure Node: renders
// with the same synth the game uses, no browser needed.
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, ROOT } from './data.js';
import { renderSound, analyze, encodeWAV, estimateDuration, variationCount, soundMap, SAMPLE_RATE } from '../../src/engine/audio/synth.js';

const BUSES = ['sfx', 'ambient', 'music', 'ui'];
const r3 = (v) => +(+v).toFixed(3);
const loadSounds = () => soundMap(readJSON('sounds.json'));
function getRecipe(name) {
  const all = loadSounds();
  if (!name) throw new Error('missing sound name (mc sound list)');
  if (!all[name]) throw new Error(`unknown sound "${name}" (mc sound list)`);
  return all[name];
}

/** Render every variation of a recipe and list what looks wrong (NaN, silence, clipping...). */
export function checkRecipe(name, recipe) {
  const row = { name, bus: recipe.bus ?? 'sfx', loop: !!recipe.loop, variations: variationCount(recipe), duration: 0, peak: 0, rms: 0, ms: 0, problems: [] };
  if (!BUSES.includes(row.bus)) row.problems.push(`unknown bus "${row.bus}" (${BUSES.join(', ')})`);
  if (!Array.isArray(recipe.layers) || !recipe.layers.length) row.problems.push('no layers');
  let samples = 0;
  for (let v = 0; v < row.variations; v++) {
    const info = {};
    const t0 = performance.now();
    let s;
    try { s = renderSound(recipe, { seed: v + 1, info }); }
    catch (e) { row.problems.push(`render error: ${e.message}`); break; }
    row.ms += performance.now() - t0;
    samples += s.length;
    const a = analyze(s);
    row.duration = Math.max(row.duration, a.seconds);
    row.peak = Math.max(row.peak, a.peak);
    row.rms = Math.max(row.rms, a.rms);
    const tag = row.variations > 1 ? ` (variation ${v})` : '';
    if (a.nonFinite) row.problems.push(`${a.nonFinite} NaN/Infinity samples${tag}`);
    if (!(info.rawPeak > 1e-5)) row.problems.push(`silent${tag}`);
    else if (a.peak <= 0.05) row.problems.push(`too quiet: peak ${r3(a.peak)}${tag}`);
    if (info.outPeak > 1.0001) row.problems.push(`clipping: peak ${r3(info.outPeak)} before clamp${tag}`);
    let mean = 0;
    for (let i = 0; i < s.length; i++) mean += s[i];
    mean /= s.length;
    if (Math.abs(mean) > 0.05) row.problems.push(`DC offset ${r3(mean)}${tag}`);
    if (row.loop) {
      const jump = Math.abs(s[s.length - 1] - s[0]);
      if (jump > 0.25 * a.peak + 0.02) row.problems.push(`loop seam jump ${r3(jump)}${tag}`);
      if (a.rms < 0.01) row.problems.push(`loop nearly silent: rms ${r3(a.rms)}${tag}`);
    }
  }
  if (!row.loop && row.duration > 10) row.problems.push(`long one-shot (${r3(row.duration)} s)`);
  if (!row.loop && row.duration < 0.02) row.problems.push(`very short (${r3(row.duration)} s)`);
  if (row.loop && row.duration < 0.5) row.problems.push(`short loop (${r3(row.duration)} s): repetition will be audible`);
  row.duration = r3(row.duration); row.peak = r3(row.peak); row.rms = r3(row.rms); row.ms = +row.ms.toFixed(1);
  row.mb = +((samples * 4) / 1048576).toFixed(2);
  return row;
}

/** Solo every layer (raw level, no normalisation) to balance a recipe without listening. */
function layerReport(recipe) {
  const full = {};
  renderSound(recipe, { seed: 1, info: full });
  return (recipe.layers ?? []).map((L, k) => {
    const solo = { ...recipe, duration: full.dry, normalize: false, gain: 1, distortion: 0, layers: recipe.layers.map((l, j) => (j === k ? { ...l, mute: false } : { ...l, mute: true })) };
    try {
      const info = {};
      const a = analyze(renderSound(solo, { seed: 1, info }));
      return { layer: k, type: L.type, start: L.start ?? L.delay ?? 0, gain: L.gain ?? 1, peak: r3(info.rawPeak), rms: +a.rms.toFixed(4), muted: !!L.mute };
    } catch (e) { return { layer: k, type: L.type, error: e.message }; }
  });
}

export const soundCommands = {
  'sound list': {
    usage: '[--bus sfx|ambient|music|ui]',
    help: 'List the sound recipes of sounds.json (bus, loop, length, layers, variations).',
    run(_, opts) {
      return Object.entries(loadSounds())
        .filter(([, r]) => !opts.bus || (r.bus ?? 'sfx') === opts.bus)
        .map(([name, r]) => `${name.padEnd(22)} ${(r.bus ?? 'sfx').padEnd(8)} ${(r.loop ? 'loop' : 'once').padEnd(5)} ${estimateDuration(r).toFixed(2).padStart(6)} s  ${String(r.layers?.length ?? 0).padStart(2)} layers  x${variationCount(r)}`)
        .join('\n');
    },
  },
  'sound render': {
    usage: '<name> [--out shots/<name>.wav] [--variation N] [--loops N]',
    help: 'Render one recipe to a 16-bit mono WAV (loops: --loops N repeats it N times to hear the seam).',
    run([name], opts) {
      const recipe = getRecipe(name);
      const variation = opts.variation !== undefined ? Math.max(0, Math.round(Number(opts.variation)) || 0) : 0;
      let s = renderSound(recipe, { seed: variation + 1 });
      const reps = recipe.loop ? Math.max(1, Math.min(16, Math.round(Number(opts.loops ?? 1)) || 1)) : 1;
      if (reps > 1) {
        const out = new Float32Array(s.length * reps);
        for (let k = 0; k < reps; k++) out.set(s, k * s.length);
        s = out;
      }
      const file = path.resolve(ROOT, opts.out ?? `shots/${name}.wav`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, encodeWAV(s, SAMPLE_RATE));
      const a = analyze(s);
      return { ok: true, file, seconds: r3(a.seconds), peak: r3(a.peak), rms: r3(a.rms), sampleRate: SAMPLE_RATE };
    },
  },
  'sound check': {
    usage: '[name] [--layers] [--problems]',
    help: 'Render every recipe (all variations) and report duration / peak / RMS / render ms; flags NaN, silence, clipping, DC, loop seams. --layers (with a name): solo level of each layer. --problems: only rows with problems.',
    run([name], opts) {
      const all = loadSounds();
      if (name) {
        const recipe = getRecipe(name);
        const row = checkRecipe(name, recipe);
        return opts.layers ? { ...row, layers: layerReport(recipe) } : row;
      }
      const rows = Object.entries(all).map(([n, r]) => checkRecipe(n, r));
      const problems = rows.flatMap((r) => r.problems.map((p) => `${r.name}: ${p}`));
      return {
        ok: problems.length === 0,
        sounds: rows.length,
        renderMs: Math.round(rows.reduce((a, r) => a + r.ms, 0)),
        memoryMB: +rows.reduce((a, r) => a + r.mb, 0).toFixed(1),
        problems,
        table: rows
          .filter((r) => !opts.problems || r.problems.length)
          .map((r) => `${r.name.padEnd(22)} ${r.bus.padEnd(8)} ${(r.loop ? 'loop' : 'once').padEnd(5)} ${r.duration.toFixed(2).padStart(6)} s  peak ${r.peak.toFixed(2)}  rms ${r.rms.toFixed(3)}  ${String(r.ms).padStart(6)} ms x${r.variations}${r.problems.length ? '  <-- ' + r.problems.join('; ') : ''}`),
      };
    },
  },
};
