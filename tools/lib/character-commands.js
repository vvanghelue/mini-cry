// mc character …: the realistic NPC bodies (public/models/characters/*.glb) from the avatars listed
// in public/data/characters.json (Microsoft Rocketbox Avatar Library, MIT: FBX converted with
// FBX2glTF, re-rigged for the UAL clips, textures packed into one atlas; tools/lib/import-character.js).
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, ROOT } from './data.js';
import { CACHE, download, converted } from './viewmodel-commands.js';

const OUT = path.join(ROOT, 'public', 'models', 'characters');
const dir = (name) => path.join(CACHE, 'characters', name);
const avatarName = (c) => path.basename(c.avatar);

/** Source files of a character: { fbx, textures: { <material>: { color, normal, specular } } } (relative to the avatar folder). */
function sources(c) {
  const textures = {};
  for (const [part, suffix] of Object.entries(c.parts)) {
    const m = `${c.prefix}_${part}`;
    textures[m] = { color: `Textures/${m}_color${suffix}.tga`, normal: `Textures/${m}_normal.tga`, specular: `Textures/${m}_specular.tga` };
  }
  return { fbx: `Export/${avatarName(c)}.fbx`, textures };
}

function select(manifest, names) {
  const all = Object.keys(manifest.characters ?? {});
  if (!names.length) return all;
  for (const n of names) if (!manifest.characters[n]) throw new Error(`no character "${n}" in characters.json`);
  return names;
}

/** characters.json `recolor`: a preset name (manifest.recolor) or an object, merged over the preset. */
function recolorOf(manifest, c) {
  if (!c.recolor) return null;
  const r = typeof c.recolor === 'string' ? { preset: c.recolor } : c.recolor;
  const preset = r.preset ? manifest.recolor?.[r.preset] : null;
  if (r.preset && !preset) throw new Error(`unknown recolor preset ${r.preset}`);
  return { ...preset, ...r };
}

function writeCredits(manifest) {
  const s = manifest.source;
  const rows = Object.entries(manifest.characters).map(([k, c]) => `| \`${k}.glb\` | ${c.label} | [${avatarName(c)}](${s.url}/tree/master/Assets/Avatars/${c.avatar}) |`);
  const md = `# NPC bodies (credits)

The GLBs here are the realistic NPC bodies, built by \`npm run mc -- character build\` from the
avatars listed in \`../../data/characters.json\`: the [Microsoft Rocketbox Avatar Library](${s.url})
(${s.author}, ${s.license}). The build converts each avatar to glTF, merges its parts into one
mesh, replaces its skeleton by the game's character rig, packs and resizes its textures into one
atlas, recolours the camouflage of the soldiers (jungle tones) and paints out the US flag, name
tapes and unit patches (docs/ASSETS.md).

| file | character | avatar |
|---|---|---|
${rows.join('\n')}

## Microsoft Rocketbox: MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
  fs.writeFileSync(path.join(OUT, 'CREDITS.md'), md);
}

const fileSize = (f) => (fs.existsSync(f) ? fs.statSync(f).size : null);

export const characterCommands = {
  'character list': {
    help: 'Realistic NPC bodies of characters.json: avatar, built file and size, and the archetypes using each.',
    run() {
      const m = readJSON('characters.json');
      const arch = readJSON('game/archetypes.json').archetypes;
      return Object.fromEntries(Object.entries(m.characters).map(([k, c]) => [k, {
        label: c.label, avatar: c.avatar, file: `models/characters/${k}.glb`, bytes: fileSize(path.join(OUT, k + '.glb')),
        archetypes: Object.entries(arch).filter(([, a]) => [a.model, ...(a.models ?? [])].includes(k)).map(([id]) => id),
      }]));
    },
  },
  'character fetch': {
    usage: '[name...]',
    help: 'Download the avatar sources (FBX + TGA textures) of characters.json into .vm-cache/characters/ (cached files are kept).',
    async run(names) {
      const m = readJSON('characters.json');
      let n = 0;
      for (const k of select(m, names)) {
        const c = m.characters[k], s = sources(c), base = m.source.base + c.avatar + '/';
        console.error(`character ${k} (${c.avatar})`);
        // the colour map is required, normal / specular maps are optional (alpha-cut parts have none)
        const files = [[s.fbx, true], ...Object.values(s.textures).flatMap((t) => Object.entries(t).map(([kind, f]) => [f, kind === 'color']))];
        await Promise.all(files.map(async ([f, required]) => {
          try { if (await download(base + f, path.join(dir(k), path.basename(f)))) n++; } catch (e) { if (required || !/HTTP 404/.test(e.message)) throw e; }
        }));
      }
      return { ok: true, downloaded: n, cache: path.relative(ROOT, path.join(CACHE, 'characters')) };
    },
  },
  'character build': {
    usage: '[name...]',
    help: 'Build public/models/characters/*.glb from .vm-cache/ (run `character fetch` first): FBX -> glTF (FBX2glTF), parts merged into one skinned mesh on the game rig (UAL clips retargeted at load), textures cropped / scaled (`scale` per part) / packed into one atlas (colour, normal, roughness), `erase` rectangles (source texels [x, y, w, h, dx, dy] per part) and `recolor` (camouflage colour ramp) applied. Rewrites CREDITS.md.',
    async run(names) {
      const m = readJSON('characters.json');
      const { buildCharacter } = await import('./import-character.js');
      fs.mkdirSync(OUT, { recursive: true });
      const out = {};
      for (const k of select(m, names)) {
        const c = m.characters[k], s = sources(c), d = dir(k);
        console.error(`character ${k}`);
        const fbx = path.join(d, path.basename(s.fbx));
        if (!fs.existsSync(fbx)) throw new Error(`${k}: run \`mc character fetch ${k}\` first`);
        const textures = Object.fromEntries(Object.entries(s.textures).map(([mat, t]) => [mat, Object.fromEntries(Object.entries(t).map(([kind, f]) => [kind, path.join(d, path.basename(f))]).filter(([, f]) => fs.existsSync(f)))]));
        const r = await buildCharacter({ ...m.defaults, ...c, glb: converted(fbx), textures, recolor: recolorOf(m, c), label: k });
        fs.writeFileSync(path.join(OUT, `${k}.glb`), r.glb);
        out[k] = r.info;
      }
      writeCredits(m);
      return { ok: true, built: out };
    },
  },
  'character shot': {
    usage: '[name|archetype...] [--archetypes] [--clip Idle] [--time s] [--yaw deg] [--pitch deg] [--dist m] [--face deg] [--lod i] [--tod h] [--size 1600x700] [--out shots/characters.png]',
    help: 'Render NPC bodies side by side under the game lighting (?mode=characters) to a PNG: characters.json names and / or archetype ids (with their palette and held weapon; archetype@model for one of its models); --archetypes = every archetype. --clip plays an animation (default: Idle_Gun when armed, else Idle) paused at --time. --dist / --yaw / --pitch move the camera closer / around (default: framed by width, from the front), --face turns the characters (e.g. toward the sun), --lod draws that distance LOD (0 = full mesh).',
    async run(names, opts) {
      const { ensureServer, launch, openApp, frames } = await import('./browser.js');
      await ensureServer();
      const [w, h] = (opts.size ?? '1600x700').split('x').map(Number);
      const { browser, page, logs } = await launch({ width: w, height: h });
      try {
        const q = new URLSearchParams({ mode: 'characters', nohud: '1', tod: opts.tod ?? 10.5 });
        if (names.length) q.set('show', names.join(','));
        if (opts.archetypes) q.set('archetypes', '1');
        for (const k of ['clip', 'time', 'yaw', 'pitch', 'dist', 'face', 'lod']) if (opts[k] !== undefined) q.set(k, opts[k]);
        await openApp(page, '/?' + q);
        await frames(page, 12);
        const info = await page.evaluate(() => window.__mc.charactersInfo);
        const file = path.resolve(ROOT, opts.out ?? `shots/characters${opts.clip ? '_' + opts.clip : ''}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, timeout: 300000 });
        return { file, ...info, errors: logs.filter((l) => /error/i.test(l)).slice(0, 5) };
      } finally { await browser.close(); }
    },
  },
};
