// mc textures …: download the CC0 source textures listed in public/data/textures.json (Poly Haven,
// ambientCG) into .tex-cache/, then build the packed texture arrays the engine loads
// (public/textures/*.webp, see src/engine/render/Surfaces.js).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJSON, writeJSON, ROOT } from './data.js';

export const CACHE = path.join(ROOT, '.tex-cache');

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return true;
}

/** Poly Haven: diffuse, GL normal, arm (AO / roughness / metal), displacement at 1k. */
async function fetchPolyHaven(id, log) {
  const dir = path.join(CACHE, 'polyhaven', id);
  const want = { Diffuse: 'diff', nor_gl: 'nor', arm: 'arm', Displacement: 'disp' };
  if (Object.values(want).every((k) => fs.existsSync(path.join(dir, k + '.jpg')))) return 0;
  const r = await fetch(`https://api.polyhaven.com/files/${id}`);
  if (!r.ok) throw new Error(`polyhaven ${id}: HTTP ${r.status}`);
  const files = await r.json();
  let n = 0;
  for (const [key, name] of Object.entries(want)) {
    const url = files[key]?.['1k']?.jpg?.url;
    if (!url) { log(`  polyhaven ${id}: no ${key}`); continue; }
    if (await download(url, path.join(dir, name + '.jpg'))) n++;
  }
  return n;
}

/** ambientCG atlas (leaf / grass scans): colour + opacity PNGs out of the 2K zip. */
async function fetchAmbientCG(id, log) {
  const dir = path.join(CACHE, 'ambientcg', id);
  if (fs.existsSync(path.join(dir, 'color.png')) && fs.existsSync(path.join(dir, 'opacity.png'))) return 0;
  const zip = path.join(CACHE, 'ambientcg', `${id}_2K-PNG.zip`);
  await download(`https://ambientcg.com/get?file=${id}_2K-PNG.zip`, zip);
  fs.mkdirSync(dir, { recursive: true });
  const list = execFileSync('unzip', ['-Z1', zip]).toString().split('\n');
  for (const [suffix, name] of [['_Color.png', 'color.png'], ['_Opacity.png', 'opacity.png']]) {
    const entry = list.find((f) => f.endsWith(suffix));
    if (!entry) { log(`  ambientcg ${id}: no ${suffix}`); continue; }
    fs.writeFileSync(path.join(dir, name), execFileSync('unzip', ['-p', zip, entry], { maxBuffer: 1 << 28 }));
  }
  fs.rmSync(zip);
  return 1;
}

export function textureSources(manifest = readJSON('textures.json')) {
  const ph = new Set(), acg = new Set();
  for (const group of ['terrain', 'surfaces', 'foliage']) {
    for (const l of manifest[group]?.layers ?? []) {
      if (l.polyhaven) ph.add(l.polyhaven);
      for (const f of [l.from].flat()) if (f) acg.add(f);
    }
  }
  return { polyhaven: [...ph], ambientcg: [...acg] };
}

export const textureCommands = {
  'textures fetch': {
    help: 'Download the CC0 source textures listed in textures.json (Poly Haven, ambientCG) into .tex-cache/ (already cached files are kept).',
    async run(_, opts) {
      const log = (s) => console.error(s);
      const src = textureSources();
      let n = 0;
      for (const id of src.polyhaven) { log(`polyhaven ${id}`); n += await fetchPolyHaven(id, log); }
      for (const id of src.ambientcg) { log(`ambientcg ${id}`); n += await fetchAmbientCG(id, log); }
      void opts;
      return { ok: true, downloaded: n, polyhaven: src.polyhaven.length, ambientcg: src.ambientcg.length, cache: path.relative(ROOT, CACHE) };
    },
  },
  'textures build': {
    usage: '[--only terrain|surfaces|foliage] [--quality 82]',
    help: 'Pack the texture arrays (public/textures/*.webp) from .tex-cache/ (run `textures fetch` first): resize, AO into albedo, height / opacity in alpha, normal + roughness, foliage atlases composed from the leaf scans; writes layer means into textures.json.',
    async run(_, opts) {
      const { buildTextures } = await import('./textures/build.js');
      const manifest = readJSON('textures.json');
      const out = await buildTextures(manifest, { only: opts.only, quality: Number(opts.quality ?? 82), log: (s) => console.error(s) });
      writeJSON('textures.json', manifest);
      return out;
    },
  },
  'textures info': {
    help: 'Texture arrays: layers, sizes, file sizes, build version.',
    run() {
      const m = readJSON('textures.json');
      const out = {};
      for (const g of ['terrain', 'surfaces', 'foliage']) {
        const files = Object.values(m[g]?.files ?? {});
        out[g] = { layers: m[g].layers.map((l) => l.id), size: m[g].size, files: Object.fromEntries(files.map((f) => [f, fs.existsSync(path.join(ROOT, 'public', f)) ? fs.statSync(path.join(ROOT, 'public', f)).size : null])) };
      }
      return { version: m.version, ...out };
    },
  },
};
