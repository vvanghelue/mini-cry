// mc gi …: bake / inspect the probe global illumination (public/data/gi/).
import { readJSON, exists } from './data.js';

export const giCommands = {
  'gi bake': {
    usage: '[--rays 128] [--bounces 2] [--transmission 0.8] [--workers N]',
    help: 'Bake the GI probes (sky light + sun bounces for every time-of-day key) -> gi/probes.json + probes.bin. Re-run after changing terrain, vegetation, props or sunTilt.',
    async run(_, opts) {
      const { bakeGI } = await import('./gi/bake.js');
      const num = (v, d) => (v === undefined ? d : Number(v));
      const r = await bakeGI({ rays: num(opts.rays, 128), bounces: num(opts.bounces, 2), transmission: num(opts.transmission, 0.8), workers: num(opts.workers, 0), log: (s) => console.error(s) });
      return { ok: true, ms: r.ms, probes: r.probes, invalid: r.invalid, bytes: r.bytes, amax: r.amax, scene: r.scene, passes: r.passes };
    },
  },
  'gi info': {
    help: 'Baked GI summary and whether it is stale (inputs changed since the bake).',
    async run() {
      if (!exists('gi/probes.json')) return { baked: false, hint: 'npm run mc -- gi bake' };
      const { giInputsHash } = await import('./gi/bake.js');
      const m = readJSON('gi/probes.json');
      return { baked: true, stale: m.inputs !== giInputsHash(), bakedAt: m.bakedAt, ms: m.ms, probes: m.probes, invalid: m.invalid, rays: m.rays, bounces: m.bounces, bytes: m.bytes, cell: m.cell, keys: m.keys, sunTilt: m.sunTilt };
    },
  },
};
