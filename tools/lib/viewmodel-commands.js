// mc viewmodel …: the first-person models (public/models/fp/*.glb) from the sources listed in
// public/data/viewmodels.json: arms (Microsoft Rocketbox avatars, MIT: FBX converted with
// FBX2glTF, arm triangles + bones kept, textures cropped) and realistic weapons (CC0 glTF scans /
// models: oriented, scaled and placed in their asset's weapon space, textures resized).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJSON, ROOT } from './data.js';

export const CACHE = path.join(ROOT, '.vm-cache');
const OUT = path.join(ROOT, 'public', 'models', 'fp');
const FBX2GLTF = 'fbx2gltf@0.9.7-p1'; // npm package with the FBX2glTF binaries (BSD), used at build time only

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
  fs.renameSync(file + '.part', file);
  return true;
}

/** FBX2glTF binary for this OS (npm tarball unpacked in the cache). */
function fbx2gltf() {
  const dir = path.join(CACHE, 'fbx2gltf');
  const os = { darwin: 'Darwin', linux: 'Linux', win32: 'Windows_NT' }[process.platform];
  const bin = path.join(dir, 'package', 'bin', os, 'FBX2glTF' + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(dir, { recursive: true });
    const tgz = execFileSync('npm', ['pack', FBX2GLTF, '--silent'], { cwd: dir }).toString().trim().split('\n').pop();
    execFileSync('tar', ['xzf', tgz], { cwd: dir });
    fs.chmodSync(bin, 0o755);
  }
  return bin;
}

/** Blender for the .blend / .obj sources (BLENDER=/path/to/blender, else `blender` on the PATH). */
function blender() {
  const b = process.env.BLENDER ?? 'blender';
  try { execFileSync(b, ['--version'], { stdio: 'ignore' }); } catch { throw new Error('this source needs Blender: install it or set BLENDER=/path/to/blender'); }
  return b;
}

/** Source file -> glTF the importers read: .gltf / .glb as is, .fbx with FBX2glTF, .blend / .obj with Blender (cached). */
function converted(file, { via } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.gltf' || ext === '.glb') return file;
  const out = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.converted.glb');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(file).mtimeMs) return out;
  if (ext === '.fbx' && via !== 'blender') execFileSync(fbx2gltf(), ['--binary', '--input', file, '--output', out.replace(/\.glb$/, '')], { stdio: ['ignore', 'ignore', 'inherit'] });
  else execFileSync(blender(), ['-b', '--factory-startup', '--python', path.join(import.meta.dirname, 'blend2glb.py'), '--', file, out], { stdio: ['ignore', 'ignore', 'inherit'] });
  return out;
}

const armsDir = (name) => path.join(CACHE, 'arms', name);
const weaponDir = (name) => path.join(CACHE, 'weapons', name);

async function fetchArms(name, src) {
  let n = 0;
  for (const f of [src.fbx, ...Object.values(src.textures)]) if (await download(src.base + f, path.join(armsDir(name), path.basename(f)))) n++;
  return n;
}

/** Weapon sources: `files` ({ relative path: url }) and / or `polyhaven` (model id: its glTF at `res`). */
async function fetchWeapon(name, src) {
  const files = { ...src.files };
  if (src.polyhaven) {
    const r = await fetch(`https://api.polyhaven.com/files/${src.polyhaven}`);
    if (!r.ok) throw new Error(`polyhaven ${src.polyhaven}: HTTP ${r.status}`);
    const g = (await r.json()).gltf?.[src.res ?? '2k']?.gltf;
    if (!g) throw new Error(`polyhaven ${src.polyhaven}: no ${src.res ?? '2k'} glTF`);
    files[path.basename(g.url)] = g.url;
    for (const [rel, f] of Object.entries(g.include ?? {})) files[rel] = f.url;
  }
  let n = 0;
  for (const [rel, url] of Object.entries(files)) if (await download(url, path.join(weaponDir(name), rel))) n++;
  return n;
}

function select(manifest, name) {
  const all = [...Object.keys(manifest.arms ?? {}).map((k) => ['arms', k]), ...Object.keys(manifest.weapons ?? {}).map((k) => ['weapons', k])];
  const out = name ? all.filter(([, k]) => k === name) : all;
  if (name && !out.length) throw new Error(`no view model "${name}" in viewmodels.json`);
  return out;
}

const fileSize = (f) => (fs.existsSync(f) ? fs.statSync(f).size : null);

export const viewmodelCommands = {
  'viewmodel shot': {
    usage: '<weapon> [--ads 0..1] [--reload 0..1] [--orbit yaw,pitch,dist] [--grips] [--tod h] [--size 1280x720] [--out shots/viewmodel_<weapon>.png]',
    help: 'Render the first-person view of a weapon (realistic model + arms on its grips, as in game; ?mode=viewmodel) to a PNG: check the asset `hands` / `sight` and the weapons.json `view`. --ads 1 = aiming down sights, --reload 0.5 = mid reload, --orbit 270,10,0.9 = seen from the left (deg, m around the weapon), --grips draws the grip targets (wrist, red: fingers, blue: thumb side).',
    async run([weapon], opts) {
      const { ensureServer, launch, openApp, frames } = await import('./browser.js');
      await ensureServer();
      const [w, h] = (opts.size ?? '1280x720').split('x').map(Number);
      const { browser, page, logs } = await launch({ width: w, height: h });
      try {
        const q = new URLSearchParams({ mode: 'viewmodel', weapon: weapon ?? 'rifle_ak', nohud: '1', ads: opts.ads ?? 0, reload: opts.reload ?? 0, tod: opts.tod ?? 10.5 });
        if (opts.orbit) q.set('orbit', opts.orbit);
        if (opts.grips) q.set('grips', '1');
        await openApp(page, '/?' + q);
        await frames(page, 3);
        const info = await page.evaluate(() => window.__mc.viewModelInfo);
        const file = path.resolve(ROOT, opts.out ?? `shots/viewmodel_${weapon ?? 'rifle_ak'}${opts.ads ? '_ads' : ''}${opts.orbit ? '_orbit' : ''}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, timeout: 300000 });
        return { file, ...info, errors: logs.filter((l) => /error/i.test(l)).slice(0, 5) };
      } finally { await browser.close(); }
    },
  },
  'viewmodel list': {
    help: 'First-person models of viewmodels.json: source, licence, built file and size.',
    run() {
      const m = readJSON('viewmodels.json');
      const row = (file, s) => ({ file: `models/fp/${file}.glb`, bytes: fileSize(path.join(OUT, file + '.glb')), author: s.author, license: s.license, url: s.url });
      return {
        arms: Object.fromEntries(Object.entries(m.arms ?? {}).map(([k, s]) => [k, row('arms_' + k, s)])),
        weapons: Object.fromEntries(Object.entries(m.weapons ?? {}).map(([k, s]) => [k, row(k, s)])),
      };
    },
  },
  'viewmodel fetch': {
    usage: '[name]',
    help: 'Download the sources of the first-person models (viewmodels.json) into .vm-cache/ (cached files are kept).',
    async run([name]) {
      const m = readJSON('viewmodels.json');
      let n = 0;
      for (const [kind, k] of select(m, name)) {
        console.error(`${kind} ${k}`);
        n += kind === 'arms' ? await fetchArms(k, m.arms[k]) : await fetchWeapon(k, m.weapons[k]);
      }
      return { ok: true, downloaded: n, cache: path.relative(ROOT, CACHE) };
    },
  },
  'viewmodel build': {
    usage: '[name]',
    help: 'Build public/models/fp/*.glb from .vm-cache/ (run `viewmodel fetch` first; .blend / .obj sources need Blender: BLENDER=/path/to/blender). Arms: FBX -> glTF (FBX2glTF), arm triangles and bones, cropped colour / normal / roughness. Weapons: rotated (deg, Euler YXZ) so the front is -Z, scaled to `length` (m along Z), `origin` moved to the asset origin, textures resized to `maxTexture`.',
    async run([name]) {
      const m = readJSON('viewmodels.json');
      fs.mkdirSync(OUT, { recursive: true });
      const out = {};
      for (const [kind, k] of select(m, name)) {
        console.error(`${kind} ${k}`);
        if (kind === 'arms') {
          const src = m.arms[k], dir = armsDir(k);
          const fbx = path.join(dir, path.basename(src.fbx));
          if (!fs.existsSync(fbx)) throw new Error(`${k}: run \`mc viewmodel fetch ${k}\` first`);
          const glb = converted(fbx);
          const { buildArms } = await import('./import-arms.js');
          const tex = Object.fromEntries(Object.entries(src.textures).map(([t, f]) => [t, path.join(dir, path.basename(f))]));
          const r = await buildArms({ glb, textures: tex, mesh: src.mesh, roughness: src.roughness, flipNormalY: src.flipNormalY, maxSize: src.maxTexture, quality: src.quality, erase: src.erase });
          fs.writeFileSync(path.join(OUT, `arms_${k}.glb`), r.glb);
          out['arms_' + k] = { tris: r.tris, bones: r.bones.length, texture: r.texture.size, bytes: r.glb.length };
        } else {
          const { buildWeapon } = await import('./import-weapon.js');
          const src = m.weapons[k], dir = weaponDir(k);
          const file = path.join(dir, src.file ?? `${src.polyhaven}_${src.res ?? '2k'}.gltf`);
          if (!fs.existsSync(file)) throw new Error(`${k}: run \`mc viewmodel fetch ${k}\` first`);
          const r = await buildWeapon({ ...src, file: path.relative(dir, converted(file, { via: src.convert })) }, dir);
          fs.writeFileSync(path.join(OUT, `${k}.glb`), r.glb);
          out[k] = { tris: r.tris, materials: r.materials, textures: r.textures, bounds: r.bounds, bytes: r.glb.length };
        }
      }
      return { ok: true, built: out };
    },
  },
};
