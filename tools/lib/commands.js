// mc command table. Each command: { usage, help, run(args, opts) -> printable }.
import fs from 'node:fs';
import path from 'node:path';
import { generateTerrain } from '../../src/engine/world/TerrainGen.js';
import { MATERIAL_ID } from '../../src/engine/world/TerrainData.js';
import { readJSON, writeJSON, listData, ROOT } from './data.js';
import { loadTerrain, saveTerrain, terrainPreview } from './terrain.js';
import { scatterVegetation, decodeVegetation } from '../../src/engine/world/VegetationScatter.js';
import { readBin, writeBin } from './data.js';
import { smoothPath } from '../../src/engine/world/TerrainGen.js';
import { soundCommands } from './sound-commands.js';
import { worldCommands } from './world-commands.js';
import { voiceCommands } from './voice-commands.js';
import { giCommands } from './gi-commands.js';
import { textureCommands } from './texture-commands.js';
import { viewmodelCommands } from './viewmodel-commands.js';
import { setSurfaceManifest } from '../../src/engine/assets/surfaces.js';

/** Areas kept free of vegetation: building sites, roads, and entity footprints. */
export function vegetationExclusions() {
  const layout = readJSON('terrain/layout.json');
  const world = readJSON('world.json', { entities: [] });
  const circles = (layout.flats ?? []).map((f) => ({ x: f.x, z: f.z, r: f.r + 4 }));
  // every placed object keeps its footprint (+ margin) clear of plants
  const defs = loadAssetDefs();
  const radius = new Map();
  for (const e of world.entities ?? []) {
    if (!e.pos) continue;
    let r = e.clearRadius;
    if (r === undefined && e.asset && defs[e.asset] && e.type !== 'pickup') {
      if (!radius.has(e.asset)) { try { const b = buildAssetSync(defs[e.asset], defs); radius.set(e.asset, Math.max(b.x, b.z) / 2); } catch { radius.set(e.asset, 1); } }
      r = radius.get(e.asset) * (typeof e.scale === 'number' ? e.scale : 1) + 1.5;
    }
    if (r === undefined && ['enemy', 'npc', 'vehicle', 'alarm', 'interactable', 'explosive', 'destructible'].includes(e.type)) r = 2.5;
    if (r) circles.push({ x: e.pos[0], z: e.pos[2], r });
  }
  const paths = (layout.roads ?? []).map((r) => ({ points: smoothPath(r.points, 6), width: r.width }));
  return { circles, paths };
}

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number for ${name}, got ${v}`);
  return n;
};
const outFile = (opts, def) => {
  const p = path.resolve(ROOT, opts.out ?? def);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
};

export const commands = {
  // ---------------------------------------------------------------- terrain
  'terrain generate': {
    usage: '[--seed N]',
    help: 'Regenerate the heightfield from terrain/layout.json (overwrites manual sculpting; a backup is kept).',
    run(_, opts) {
      const layout = readJSON('terrain/layout.json');
      if (opts.seed) { layout.seed = num(opts.seed, 'seed'); writeJSON('terrain/layout.json', layout); }
      const t0 = Date.now();
      const t = generateTerrain(layout);
      const meta = saveTerrain(t);
      return { ok: true, ms: Date.now() - t0, res: meta.res, size: meta.size, minHeight: meta.minHeight, maxHeight: meta.maxHeight, rivers: meta.rivers.length };
    },
  },
  'terrain info': {
    help: 'Heightfield summary (size, resolution, height range, rivers).',
    run() {
      const t = loadTerrain();
      let land = 0;
      for (const h of t.heights) if (h > t.seaLevel) land++;
      const meta = readJSON('terrain/terrain.json');
      return { size: t.size, res: t.res, cell: t.cell, seaLevel: t.seaLevel, minHeight: meta.minHeight, maxHeight: meta.maxHeight, landRatio: +(land / t.heights.length).toFixed(3), rivers: t.rivers.map((r) => ({ name: r.name, width: r.width, points: r.points.length })) };
    },
  },
  'terrain height': {
    usage: '<x> <z>',
    help: 'Ground height, water level, slope and material at a world position.',
    run([x, z]) {
      const t = loadTerrain();
      x = num(x, 'x'); z = num(z, 'z');
      const n = t.normalAt(x, z);
      const i = Math.round(t.gx(x)), j = Math.round(t.gz(z));
      return { x, z, height: +t.heightAt(x, z).toFixed(2), waterLevel: +t.waterLevelAt(x, z).toFixed(2), slopeDeg: +(Math.acos(n.y) * 180 / Math.PI).toFixed(1), material: Object.keys(MATERIAL_ID)[t.materialAt(i, j)] };
    },
  },
  'terrain sculpt': {
    usage: '<raise|lower|flatten|smooth|noise|paint> <x> <z> <radius> [strength] [--height h] [--material name] [--falloff 0..1]',
    help: 'Apply one brush stroke to the saved heightfield. paint uses --material (sand, grass, jungle, dirt, rock, mud, concrete...).',
    run([op, x, z, radius, strength = 1], opts) {
      const t = loadTerrain();
      const o = {};
      if (opts.height !== undefined) o.height = num(opts.height, 'height');
      if (opts.material !== undefined) { o.material = MATERIAL_ID[opts.material]; if (o.material === undefined) throw new Error('materials: ' + Object.keys(MATERIAL_ID).join(', ')); }
      if (opts.falloff !== undefined) o.falloff = num(opts.falloff, 'falloff');
      const rect = t.sculpt(op, num(x, 'x'), num(z, 'z'), num(radius, 'radius'), num(strength, 'strength'), o);
      saveTerrain(t);
      return { ok: true, op, vertices: (rect.i1 - rect.i0 + 1) * (rect.j1 - rect.j0 + 1), heightNow: +t.heightAt(+x, +z).toFixed(2) };
    },
  },
  'terrain preview': {
    usage: '[--out shots/map.png] [--size 1024] [--x0 -1024 --z0 -1024 --span 2048] [--no-entities]',
    help: 'Render a top-down shaded map PNG (with entity markers) to look at the island layout.',
    run(_, opts) {
      const t = loadTerrain();
      const size = opts.size ? num(opts.size, 'size') : 1024;
      const markers = [];
      if (!opts['no-entities']) {
        const world = readJSON('world.json', { entities: [] });
        const COLORS = { enemy: [230, 30, 30], prop: [40, 40, 40], pickup: [250, 220, 40], zone: [40, 120, 255], marker: [255, 255, 255], vehicle: [255, 140, 0], outpost: [180, 0, 200], spawn: [0, 255, 120] };
        for (const e of world.entities ?? []) if (e.pos) markers.push({ x: e.pos[0], z: e.pos[2], color: COLORS[e.type] ?? [255, 0, 255], r: e.type === 'outpost' ? 5 : 2 });
        if (world.player?.pos) markers.push({ x: world.player.pos[0], z: world.player.pos[2], color: [0, 255, 0], r: 5 });
      }
      const view = opts.span ? { x0: num(opts.x0 ?? -t.half, 'x0'), z0: num(opts.z0 ?? -t.half, 'z0'), span: num(opts.span, 'span') } : null;
      const file = outFile(opts, 'shots/map.png');
      fs.writeFileSync(file, terrainPreview(t, size, markers, view));
      return { ok: true, file, note: 'north is up (-z), x grows to the right' };
    },
  },

  // ---------------------------------------------------------------- vegetation
  'vegetation generate': {
    usage: '[--seed N] [--species id,id]',
    help: 'Scatter all vegetation species (rules in vegetation.json) over the terrain -> vegetation.bin. Sites, roads and entities with clearRadius stay clear. --species re-scatters only those species and keeps every other instance (hand edits included).',
    run(_, opts) {
      const veg = readJSON('vegetation.json');
      if (opts.seed) { veg.seed = num(opts.seed, 'seed'); writeJSON('vegetation.json', veg); }
      const t = loadTerrain();
      const t0 = Date.now();
      let only = null, existing = null;
      if (opts.species) {
        only = new Set(String(opts.species).split(','));
        for (const id of only) if (!veg.species.some((s) => s.id === id)) throw new Error(`unknown species ${id}`);
        existing = decodeVegetation(readBin('vegetation.bin'));
      }
      const r = scatterVegetation(t, veg, vegetationExclusions(), { only, existing });
      writeBin('vegetation.bin', r.bytes);
      return { ok: true, ms: Date.now() - t0, instances: r.count, bytes: r.bytes.length, perSpecies: r.perSpecies };
    },
  },
  'vegetation info': {
    help: 'Count of placed instances per species.',
    run() {
      const veg = readJSON('vegetation.json');
      const v = decodeVegetation(readBin('vegetation.bin'));
      const per = {};
      for (let k = 0; k < v.n; k++) { const id = veg.species[v.species[k]]?.id ?? '?'; per[id] = (per[id] ?? 0) + 1; }
      return { instances: v.n, perSpecies: per };
    },
  },
  'vegetation clear': {
    usage: '<x> <z> <radius> [--species id,id]',
    help: 'Remove vegetation instances in a circle (optionally only some species).',
    run([x, z, r], opts) {
      x = num(x, 'x'); z = num(z, 'z'); r = num(r, 'radius');
      const veg = readJSON('vegetation.json');
      const bytes = readBin('vegetation.bin');
      const only = opts.species ? new Set(String(opts.species).split(',')) : null;
      const keep = [];
      let removed = 0;
      for (let o = 0; o < bytes.length; o += 12) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset + o, 12);
        const px = dv.getFloat32(4, true), pz = dv.getFloat32(8, true);
        const sp = veg.species[bytes[o]]?.id;
        if ((px - x) ** 2 + (pz - z) ** 2 < r * r && (!only || only.has(sp))) { removed++; continue; }
        keep.push(bytes.subarray(o, o + 12));
      }
      const out = new Uint8Array(keep.length * 12);
      keep.forEach((b, i) => out.set(b, i * 12));
      writeBin('vegetation.bin', out);
      return { ok: true, removed, remaining: keep.length };
    },
  },

  // ---------------------------------------------------------------- assets
  'asset list': {
    usage: '[--category vegetation|prop|weapon|vehicle|building]',
    help: 'List asset definitions (public/data/assets) with category and triangle counts per LOD.',
    async run(_, opts) {
      const { assetStats } = await import('../../src/engine/assets/ModelBuilder.js');
      const all = loadAssetDefs();
      return Object.entries(all).filter(([, d]) => !opts.category || d.category === opts.category).map(([n, d]) => ({ name: n, category: d.category, label: d.label, generator: d.generator?.type, parts: d.parts?.length ?? 0, tris: assetStats(d, all) }));
    },
  },
  'asset get': {
    usage: '<name>',
    help: 'Print an asset definition (JSON).',
    run([name]) { return readJSON(`assets/${name}.json`); },
  },
  'asset shot': {
    usage: '<name> [--variant N] [--quality 1|0.5|0.25] [--yaw deg] [--dist m] [--colliders] [--noground] [--lineup [variants]] [--out shots/asset_<name>.png] [--size 900x700]',
    help: 'Render an asset on a turntable (headless GPU) to a PNG, to look at it. --colliders draws collision shapes (ladders green), --noground hides the ground disc, --lineup shows every variant at every LOD quality (1, 0.5, 0.25) side by side.',
    async run([name], opts) {
      const { ensureServer, launch, openApp, frames } = await import('./browser.js');
      await ensureServer();
      const [w, h] = (opts.size ?? (opts.lineup ? '2400x800' : '900x700')).split('x').map(Number);
      const { browser, page, logs } = await launch({ width: w, height: h });
      try {
        const q = new URLSearchParams({ mode: 'asset', asset: name, nohud: '1', variant: opts.variant ?? 0, quality: opts.quality ?? 1, yaw: opts.yaw ?? 35 });
        if (opts.lineup) q.set('lineup', opts.lineup === true ? '4' : opts.lineup);
        if (opts.dist) q.set('dist', opts.dist);
        if (opts.colliders) q.set('colliders', '1');
        if (opts.noground) q.set('ground', '0');
        await openApp(page, '/?' + q);
        await frames(page, 20);
        const info = await page.evaluate(() => window.__mc.assetInfo);
        if (opts.lineup && !opts.size) { await page.setViewportSize({ width: w, height: Math.round(w / info.aspect) }); await frames(page, 20); }
        const file = outFile(opts, `shots/asset_${name}.png`);
        await page.screenshot({ path: file });
        return { file, ...info, errors: logs.filter((l) => /error/i.test(l)).slice(0, 5) };
      } finally { await browser.close(); }
    },
  },
  'asset reindex': {
    help: 'Rewrite assets/index.json from the files present (the built game loads assets from this index).',
    run() { return writeAssetIndex(); },
  },
  'asset bake': {
    usage: '<name> [--seed N] [--as newName]',
    help: 'Expand a generator-based asset into explicit editable parts (saved as --as or in place).',
    async run([name], opts) {
      const { resolveParts } = await import('../../src/engine/assets/ModelBuilder.js');
      const all = loadAssetDefs();
      const def = all[name];
      if (!def) throw new Error('unknown asset ' + name);
      const parts = resolveParts(def, all, opts.seed ? num(opts.seed, 'seed') : undefined);
      const out = { ...def, name: opts.as ?? name, parts, generator: undefined };
      writeJSON(`assets/${out.name}.json`, out);
      writeAssetIndex();
      return { ok: true, name: out.name, parts: parts.length };
    },
  },
  'asset import': {
    usage: '<file.glb> --as <name> [--rot x,y,z] [--length m | --scale k] [--origin x,y,z] [--brightness k] [--minLight 0..1] [--jitter j] [--category weapon] [--label ..] [--url ..] [--author ..] [--license ..]',
    help: 'Convert a flat-coloured GLB (e.g. a CC0 Quaternius model) into an asset: one `tris` part per material colour, rotated (deg, Euler YXZ) so the front faces -Z, scaled to --length (size along Z) and moved so --origin (in the frame centred on X / Z with the bottom at y = 0) becomes the asset origin. Re-importing over an existing asset only replaces its parts and `source` (muzzle, sight, hands, collider... are kept).',
    async run([file], opts) {
      const { importGLB, stringifyCompact } = await import('./import-glb.js');
      if (!file || !opts.as) throw new Error('usage: asset import <file.glb> --as <name>');
      const vec = (s) => (s === undefined ? undefined : String(s).split(',').map((x) => num(x, 'vector')));
      const params = {
        rot: vec(opts.rot), origin: vec(opts.origin),
        length: opts.length && num(opts.length, 'length'), scale: opts.scale && num(opts.scale, 'scale'),
        brightness: opts.brightness && num(opts.brightness, 'brightness'), minLight: opts.minLight && num(opts.minLight, 'minLight'),
        jitter: opts.jitter !== undefined ? num(opts.jitter, 'jitter') : undefined,
      };
      const r = await importGLB(path.resolve(file), params);
      const prev = readJSON(`assets/${opts.as}.json`, {});
      const out = {
        name: opts.as, category: opts.category ?? prev.category ?? 'prop', label: opts.label ?? prev.label ?? opts.as,
        material: prev.material ?? 'metal', tags: prev.tags ?? [],
        ...prev,
        source: { url: opts.url ?? prev.source?.url, author: opts.author ?? prev.source?.author, license: opts.license ?? prev.source?.license, file: path.basename(file), ...Object.fromEntries(Object.entries(params).filter(([, x]) => x !== undefined)) },
        parts: r.parts,
      };
      out.name = opts.as;
      writeJSON(`assets/${opts.as}.json`, out, stringifyCompact);
      writeAssetIndex();
      return { ok: true, name: opts.as, tris: r.tris, parts: r.parts.length, colors: r.parts.map((p) => p.color), bounds: r.bounds, scale: +r.scale.toFixed(5) };
    },
  },
  'asset validate': {
    usage: '[name]',
    help: 'Build every asset (or one) and report errors / triangle counts / colliders.',
    async run([name]) {
      const { buildAsset } = await import('../../src/engine/assets/ModelBuilder.js');
      const all = loadAssetDefs();
      const out = [];
      for (const [n, d] of Object.entries(all)) {
        if (name && n !== name) continue;
        try { const b = buildAsset(d, { assets: all }); out.push({ name: n, ok: true, tris: b.triangles, size: b.bounds.max.clone().sub(b.bounds.min).toArray().map((v) => +v.toFixed(2)), colliders: b.colliders.length }); }
        catch (e) { out.push({ name: n, ok: false, error: e.message }); }
      }
      return out;
    },
  },

  // ---------------------------------------------------------------- data
  'data list': {
    usage: '[dir]',
    help: 'List the data files under public/data.',
    run([dir = '']) { return listData(dir); },
  },
  'data get': {
    usage: '<file.json> [json.path]',
    help: 'Print a JSON file or a value inside it (path like weapons.rifle.damage or entities[3].pos).',
    run([file, p]) { return getPath(readJSON(file), p); },
  },
  'data set': {
    usage: '<file.json> <json.path> <json value>',
    help: 'Set a value inside a JSON data file (value parsed as JSON, else kept as a string).',
    async run([file, p, ...v]) {
      const obj = readJSON(file);
      const raw = v.join(' ');
      let val;
      try { val = JSON.parse(raw); } catch { val = raw; }
      setPath(obj, p, val);
      if (/^assets\//.test(file)) {
        // assets keep their number arrays on one line (parts' raw triangles)
        const { stringifyCompact } = await import('./import-glb.js');
        writeJSON(file, obj, stringifyCompact);
      } else writeJSON(file, obj);
      return { ok: true, file, path: p, value: val };
    },
  },
  ...soundCommands,
  ...worldCommands,
  ...voiceCommands,
  ...giCommands,
  ...textureCommands,
  ...viewmodelCommands,
};

let _build = null;
/** Footprint size {x, z} of an asset (sync, lazy import of the builder done at module load below). */
function buildAssetSync(def, defs) {
  const b = _build(def, { assets: defs, quality: 0.25 });
  const size = { x: b.bounds.max.x - b.bounds.min.x, z: b.bounds.max.z - b.bounds.min.z };
  b.geometry.dispose();
  return size;
}
_build = (await import('../../src/engine/assets/ModelBuilder.js')).buildAsset;

export function loadAssetDefs() {
  // texture layer ids / uv scales for the builds (the runtime registers them from the same file)
  setSurfaceManifest(readJSON('textures.json', null));
  const all = {};
  for (const f of listData('assets')) {
    if (!f.endsWith('.json') || f.endsWith('index.json')) continue;
    const n = f.slice('assets/'.length, -5);
    all[n] = { name: n, ...readJSON(f) };
  }
  return all;
}
export function writeAssetIndex() {
  const names = Object.keys(loadAssetDefs()).sort();
  writeJSON('assets/index.json', { assets: names });
  return { ok: true, assets: names.length };
}

// "a.b[2].c" -> ['a', 'b', 2, 'c']
export function parsePath(p) {
  if (!p) return [];
  const out = [];
  for (const part of p.split('.')) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(part))) out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return out;
}
export function getPath(obj, p) {
  let o = obj;
  for (const k of parsePath(p)) {
    if (o == null) throw new Error(`path ${p}: ${k} not found`);
    o = Array.isArray(o) && typeof k === 'string' && !(k in o) ? o.find((e) => e?.id === k) : o[k];
  }
  return o;
}
export function setPath(obj, p, val) {
  const keys = parsePath(p);
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    let next = Array.isArray(o) && typeof k === 'string' && !(k in o) ? o.find((e) => e?.id === k) : o[k];
    if (next == null) { next = typeof keys[i + 1] === 'number' ? [] : {}; o[k] = next; }
    o = next;
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(o) && typeof last === 'string' && !(last in o)) {
    const idx = o.findIndex((e) => e?.id === last);
    if (idx >= 0) { o[idx] = val; return; }
  }
  o[last] = val;
}
