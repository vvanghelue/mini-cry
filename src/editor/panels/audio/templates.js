// Starting points for new sounds, default values of every recipe field (shown as placeholders)
// and the grouping of the sound list.

export const TEMPLATES = {
  gunshot: {
    label: 'Gunshot',
    recipe: {
      bus: 'sfx', refDistance: 10, maxDistance: 500, priority: 5, maxInstances: 6, gain: 0.9,
      reverb: 0.22, reverbSize: 0.45, distortion: 0.15,
      variations: { count: 3, pitch: [0.95, 1.05], gain: [0.9, 1] },
      layers: [
        { type: 'noise', gain: 0.9, env: { attack: 0, decay: 0.03, curve: 6 }, filter: { type: 'highpass', freq: 1800 } },
        { type: 'noise', gain: 1.5, env: { attack: 0.0005, decay: 0.12, curve: 5 }, filter: { type: 'lowpass', freq: 5000, freqEnd: 900, q: 0.9 }, distortion: 0.4 },
        { type: 'sine', gain: 0.8, freq: 150, freqEnd: 50, curve: 0.5, env: { attack: 0.0005, decay: 0.14, curve: 4 }, distortion: 0.5 },
        { type: 'noise', noiseColor: 'brown', gain: 0.5, start: 0.015, env: { attack: 0.01, decay: 0.4, curve: 4 }, filter: { type: 'lowpass', freq: 1400, freqEnd: 300 } },
      ],
    },
  },
  impact: {
    label: 'Impact',
    recipe: {
      bus: 'sfx', refDistance: 4, maxDistance: 120, priority: 2, maxInstances: 6, gain: 0.7,
      variations: { count: 4, pitch: [0.9, 1.1], gain: [0.8, 1] },
      layers: [
        { type: 'click', gain: 0.8, filter: { type: 'bandpass', freq: [1800, 2600], q: 3 } },
        { type: 'noise', gain: 1, env: { attack: 0, decay: 0.05, curve: 5 }, filter: { type: 'bandpass', freq: 1500, q: 0.8 } },
        { type: 'noise', noiseColor: 'brown', gain: 0.6, env: { attack: 0.002, decay: 0.12, curve: 4 }, filter: { type: 'lowpass', freq: 600 } },
      ],
    },
  },
  ui_blip: {
    label: 'UI blip',
    recipe: {
      bus: 'ui', gain: 0.5, variations: { count: 1 },
      layers: [
        { type: 'square', gain: 0.6, freq: 880, duty: 0.3, env: { attack: 0.002, decay: 0.07, curve: 4 }, filter: { type: 'lowpass', freq: 4000 } },
        { type: 'sine', gain: 0.8, start: 0.06, freq: 1320, env: { attack: 0.002, decay: 0.1, curve: 4 } },
      ],
    },
  },
  ambient_loop: {
    label: 'Ambient loop',
    recipe: {
      bus: 'ambient', loop: true, duration: 6, loopFade: 0.5, gain: 0.6,
      layers: [
        { type: 'noise', noiseColor: 'pink', gain: 1, filter: { type: 'bandpass', freq: 700, q: 0.6, lfo: { rate: 0.17, depth: 1, shape: 'noise' } }, tremolo: { rate: 0.33, depth: 0.5, shape: 'noise' } },
        { type: 'noise', noiseColor: 'brown', gain: 0.5, filter: { type: 'lowpass', freq: 220 } },
      ],
    },
  },
  tone: {
    label: 'Note / tone',
    recipe: {
      bus: 'sfx', gain: 0.6, variations: { count: 1 },
      layers: [
        { type: 'sine', gain: 1, freq: 440, env: { attack: 0.005, decay: 0.6, curve: 4 } },
      ],
    },
  },
  empty: {
    label: 'Empty',
    recipe: { bus: 'sfx', gain: 0.8, layers: [{ type: 'sine', freq: 440, env: { decay: 0.3 } }] },
  },
};

/** New layers added with "+ Layer". */
export const LAYER_PRESETS = {
  sine: { type: 'sine', gain: 1, freq: 440, env: { attack: 0.002, decay: 0.2, curve: 4 } },
  noise: { type: 'noise', gain: 1, env: { attack: 0.001, decay: 0.15, curve: 4 }, filter: { type: 'lowpass', freq: 3000 } },
  click: { type: 'click', gain: 0.6, filter: { type: 'bandpass', freq: 2500, q: 2 } },
  square: { type: 'square', gain: 0.6, freq: 220, duty: 0.5, env: { attack: 0.002, decay: 0.2, curve: 4 }, filter: { type: 'lowpass', freq: 3000 } },
  saw: { type: 'saw', gain: 0.6, freq: 110, env: { attack: 0.005, decay: 0.3, curve: 4 }, filter: { type: 'lowpass', freq: 1500 } },
  triangle: { type: 'triangle', gain: 1, freq: 330, env: { attack: 0.002, decay: 0.2, curve: 4 } },
  fm: { type: 'fm', gain: 0.8, freq: 600, fm: { ratio: 1.4, index: 3, indexEnd: 0 }, env: { attack: 0.001, decay: 0.6, curve: 5 } },
  sample: { type: 'sample', gain: 1, file: 'sfx/ak47_1.wav' },
};

export const LAYER_TYPES = ['sine', 'noise', 'click', 'square', 'saw', 'triangle', 'fm', 'sample'];
export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];
export const LFO_SHAPES = ['sine', 'triangle', 'square', 'saw', 'noise'];
export const NOISE_COLORS = ['white', 'pink', 'brown'];
export const BUSES = ['sfx', 'ambient', 'music', 'ui'];

// Defaults applied by synth.js / Audio.js when a field is missing (placeholders in the form).
export const DEF = {
  sound: { gain: 0.8, reverbSize: 0.5, reverbDamp: 0.4, distortion: 0, reverb: 0, refDistance: 5, maxDistance: 300, rolloff: 1, priority: 0, maxInstances: 8 },
  echo: { time: 0.3, feedback: 0.3, mix: 0.4, lowpass: 3000 },
  layer: { gain: 1, start: 0, freq: 440, curve: 1, duty: 0.5, rate: 0, jitter: 0, distortion: 0 },
  unison: { voices: 1, detune: 10 },
  fm: { ratio: 1, index: 1 },
  env: { attack: 0.002, hold: 0, decay: 0.1, sustain: 0, release: 0, curve: 4 },
  filter: { freq: 1000, q: 0.707, curve: 1 },
  lfo: { rate: 1, depth: 0.5, phase: 0, duty: 0.5 },
  repeat: { count: 1, interval: 0.1, jitter: 0, pitch: 1, gain: 1 },
};

export const LAYER_COLORS = ['#4fb3ff', '#ffb04d', '#7bd88f', '#ff7a9c', '#c39bff', '#4de0d0', '#ffd34d', '#ff8a5c'];

// List grouping
const CATS = [
  ['Music', (n, r) => r.bus === 'music'],
  ['Ambience', (n, r) => r.bus === 'ambient'],
  ['UI', (n, r) => r.bus === 'ui'],
  ['Weapons', (n) => /shot|rpg|reload|dry_fire|pump|grenade|machete|weapon|explosion|launch/.test(n)],
  ['Impacts', (n) => /impact|whizz|hit|glass|body_fall/.test(n)],
  ['Footsteps & player', (n) => /footstep|jump|land|swim|splash|hurt|heart|health|pickup|binoculars/.test(n)],
  ['Vehicles', (n) => /engine|jeep|boat|heli|truck|car_/.test(n)],
];
export const GROUPINGS = {
  cat: { label: 'Category', key: (n, r) => (CATS.find(([, f]) => f(n, r ?? {}))?.[0] ?? 'Misc') },
  bus: { label: 'Bus', key: (n, r) => r?.bus ?? 'sfx' },
  prefix: { label: 'Prefix', key: (n) => (n.includes('_') ? n.slice(0, n.indexOf('_')) : n) },
  none: { label: 'None', key: () => '' },
};
export const CAT_ORDER = ['Weapons', 'Impacts', 'Footsteps & player', 'Vehicles', 'Misc', 'UI', 'Ambience', 'Music'];
