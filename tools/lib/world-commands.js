// mc commands for world entities, missions, global validation and live control.
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON, listData, ROOT } from './data.js';
import { loadTerrain } from './terrain.js';
import { BASE, serverUp } from './browser.js';

const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`expected a number for ${name}, got ${v}`); return n; };
const vec = (s, n = 3) => { const a = String(s).split(',').map(Number); if (a.length < n - 1 || a.some((x) => !Number.isFinite(x))) throw new Error('expected x,y,z or x,z: ' + s); return a; };
const loadWorld = () => readJSON('world.json', { entities: [] });

async function registry() {
  // entity types (engine + game) with their schemas; pure JS modules, importable in Node
  const { ENTITY_TYPES, validateEntity } = await import('../../src/engine/world/Entities.js');
  await import('../../src/game/entities/index.js');
  return { ENTITY_TYPES, validateEntity };
}

function newId(world, type) {
  let i = 1;
  while (world.entities.some((e) => e.id === `${type}_${i}`)) i++;
  return `${type}_${i}`;
}

/** --at x,z (ground height) or --pos x,y,z */
function position(opts, terrain) {
  if (opts.pos) { const p = vec(opts.pos); if (p.length === 2) return [p[0], +terrain().heightAt(p[0], p[1]).toFixed(3), p[1]]; return p; }
  if (opts.at) { const [x, z] = vec(opts.at, 2); return [x, +(terrain().heightAt(x, z) + num(opts.dy ?? 0, 'dy')).toFixed(3), z]; }
  return null;
}

export const worldCommands = {
  'entity list': {
    usage: '[--type t] [--group g] [--near x,z,radius] [--tag t] [--brief]',
    help: 'List world entities (filters combine). --brief prints one line per entity.',
    run(_, o) {
      const w = loadWorld();
      let l = w.entities;
      if (o.type) l = l.filter((e) => e.type === o.type);
      if (o.group) l = l.filter((e) => e.group === o.group);
      if (o.tag) l = l.filter((e) => e.tags?.includes(o.tag));
      if (o.near) { const [x, z, r] = vec(o.near); l = l.filter((e) => e.pos && Math.hypot(e.pos[0] - x, e.pos[2] - z) <= r); }
      if (o.brief) return l.map((e) => `${e.id.padEnd(24)} ${e.type.padEnd(13)} ${(e.asset ?? e.archetype ?? e.item ?? e.name ?? '').toString().padEnd(18)} ${e.pos ? e.pos.map((v) => Math.round(v)).join(',') : ''}${e.group ? '  [' + e.group + ']' : ''}`).join('\n') + `\n(${l.length})`;
      return l;
    },
  },
  'entity get': { usage: '<id>', help: 'Print one entity.', run([id]) { const e = loadWorld().entities.find((x) => x.id === id); if (!e) throw new Error('no entity ' + id); return e; } },
  'entity add': {
    usage: '<type> (--at x,z [--dy h] | --pos x,y,z) [--id id] [--yaw deg] [--json \'{"asset":"crate",...}\']',
    help: 'Add an entity (y from the terrain with --at). Fields from --json and any --key value (e.g. --asset crate --group camp1).',
    async run([type], o) {
      const { ENTITY_TYPES, validateEntity } = await registry();
      if (!ENTITY_TYPES[type]) throw new Error(`unknown type ${type}; types: ${Object.keys(ENTITY_TYPES).join(', ')}`);
      const w = loadWorld();
      let T = null;
      const terrain = () => (T ??= loadTerrain());
      const e = { ...structuredClone(ENTITY_TYPES[type].defaults), type, id: o.id ?? newId(w, type) };
      const pos = position(o, terrain);
      if (pos) e.pos = pos;
      if (o.yaw !== undefined) e.rot = [0, num(o.yaw, 'yaw'), 0];
      if (o.json) Object.assign(e, JSON.parse(o.json));
      for (const [k, v] of Object.entries(o)) {
        if (['at', 'pos', 'dy', 'id', 'yaw', 'json'].includes(k)) continue;
        try { e[k] = JSON.parse(v); } catch { e[k] = v; }
      }
      if (w.entities.some((x) => x.id === e.id)) throw new Error('id exists: ' + e.id);
      const errs = validateEntity(e);
      if (errs.length) throw new Error(errs.join('; '));
      w.entities.push(e);
      writeJSON('world.json', w);
      return e;
    },
  },
  'entity set': {
    usage: '<id> \'<json patch>\'',
    help: 'Merge a JSON patch into an entity (e.g. \'{"group":"camp2","pos":[1,2,3]}\'). null removes a key.',
    async run([id, ...json]) {
      const { validateEntity } = await registry();
      const w = loadWorld();
      const i = w.entities.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('no entity ' + id);
      const patch = JSON.parse(json.join(' '));
      const e = { ...w.entities[i], ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === null) delete e[k];
      const errs = validateEntity(e);
      if (errs.length) throw new Error(errs.join('; '));
      w.entities[i] = e;
      writeJSON('world.json', w);
      return e;
    },
  },
  'entity move': {
    usage: '<id> <x> <z> [--dy h] [--yaw deg]',
    help: 'Move an entity onto the ground at (x, z).',
    run([id, x, z], o) {
      const w = loadWorld();
      const e = w.entities.find((q) => q.id === id);
      if (!e) throw new Error('no entity ' + id);
      const T = loadTerrain();
      x = num(x, 'x'); z = num(z, 'z');
      e.pos = [x, +(T.heightAt(x, z) + Number(o.dy ?? 0)).toFixed(3), z];
      if (o.yaw !== undefined) e.rot = [0, num(o.yaw, 'yaw'), 0];
      writeJSON('world.json', w);
      return e;
    },
  },
  'entity remove': {
    usage: '<id...> | --group g | --tag t',
    help: 'Remove entities by id, group or tag.',
    run(ids, o) {
      const w = loadWorld();
      const before = w.entities.length;
      w.entities = w.entities.filter((e) => !(ids.includes(e.id) || (o.group && e.group === o.group) || (o.tag && e.tags?.includes(o.tag))));
      writeJSON('world.json', w);
      return { removed: before - w.entities.length, remaining: w.entities.length };
    },
  },
  'entity types': {
    help: 'Entity types with their schema (fields, labels).',
    async run() {
      const { ENTITY_TYPES } = await registry();
      return Object.fromEntries(Object.entries(ENTITY_TYPES).map(([k, t]) => [k, { label: t.label, category: t.category, defaults: t.defaults, fields: Object.fromEntries(Object.entries(t.schema).map(([f, s]) => [f, s.type + (s.options ? `(${s.options.join('|')})` : '') + (s.required ? ' *' : '')])) }]));
    },
  },
  'world stats': {
    help: 'Counts of entities by type / group, player start.',
    run() {
      const w = loadWorld();
      const byType = {}, byGroup = {};
      for (const e of w.entities) { byType[e.type] = (byType[e.type] ?? 0) + 1; if (e.group) byGroup[e.group] = (byGroup[e.group] ?? 0) + 1; }
      return { name: w.name, player: w.player, entities: w.entities.length, byType, byGroup };
    },
  },

  // ---------------------------------------------------------------- missions
  'mission list': {
    help: 'Missions with their objectives (one line each).',
    run() {
      const m = readJSON('game/missions.json', { missions: [] });
      return (m.missions ?? []).map((x) => `${x.id === m.start ? '*' : ' '} ${x.id.padEnd(16)} ${x.type ?? 'main'}  ${x.title}\n${(x.objectives ?? []).map((o, i) => `      ${i + 1}. [${o.type}] ${o.text ?? ''}${o.target ? ' -> ' + o.target : ''}${o.group ? ' group=' + o.group : ''}`).join('\n')}`).join('\n');
    },
  },
  'mission show': { usage: '<id>', help: 'Print one mission (JSON).', run([id]) { const m = readJSON('game/missions.json').missions.find((x) => x.id === id); if (!m) throw new Error('no mission ' + id); return m; } },

  // ---------------------------------------------------------------- validation
  validate: {
    help: 'Check everything: assets build, entity schemas & references, mission / dialogue references, data cross-references. Exit code 1 on errors.',
    async run() {
      const errors = [], warnings = [];
      const { buildAsset } = await import('../../src/engine/assets/ModelBuilder.js');
      const { validateEntity } = await registry();
      // assets
      const assets = {};
      for (const f of listData('assets')) if (f.endsWith('.json') && !f.endsWith('index.json')) assets[f.slice(7, -5)] = { name: f.slice(7, -5), ...readJSON(f) };
      for (const [n, d] of Object.entries(assets)) { try { buildAsset(d, { assets, quality: 0.5 }).geometry.dispose(); } catch (e) { errors.push(`asset ${n}: ${e.message}`); } }
      const index = readJSON('assets/index.json', { assets: [] }).assets;
      for (const n of Object.keys(assets)) if (!index.includes(n)) warnings.push(`asset ${n} missing from assets/index.json (run: mc asset reindex)`);
      // data
      const weapons = readJSON('game/weapons.json'), arch = readJSON('game/archetypes.json'), items = readJSON('game/items.json');
      for (const [id, w] of Object.entries(weapons.weapons)) { if (!assets[w.asset]) warnings.push(`weapon ${id}: asset ${w.asset} missing`); if (w.ammo && !weapons.ammoTypes[w.ammo]) errors.push(`weapon ${id}: unknown ammo ${w.ammo}`); }
      for (const [id, a] of Object.entries(arch.archetypes)) { if (a.weapon && !weapons.weapons[a.weapon]) errors.push(`archetype ${id}: unknown weapon ${a.weapon}`); for (const l of a.loot ?? []) if (!items.items[l.item]) errors.push(`archetype ${id}: unknown loot item ${l.item}`); if (a.palette && !arch.palettes?.[a.palette]) warnings.push(`archetype ${id}: palette ${a.palette} missing`); if (!fs.existsSync(path.join(ROOT, 'public', 'models', `${a.model}.glb`))) warnings.push(`archetype ${id}: model ${a.model}.glb not found`); }
      for (const [id, it] of Object.entries(items.items)) { if (it.asset && !assets[it.asset]) warnings.push(`item ${id}: asset ${it.asset} missing`); if (it.weapon && !weapons.weapons[it.weapon]) errors.push(`item ${id}: unknown weapon ${it.weapon}`); }
      // entities
      const w = loadWorld();
      const ids = new Set();
      for (const e of w.entities) {
        if (ids.has(e.id)) errors.push(`duplicate entity id ${e.id}`);
        ids.add(e.id);
        for (const x of validateEntity(e)) errors.push(`entity ${e.id}: ${x}`);
        if (e.asset && !assets[e.asset]) errors.push(`entity ${e.id}: unknown asset ${e.asset}`);
        if (e.archetype && !arch.archetypes[e.archetype]) errors.push(`entity ${e.id}: unknown archetype ${e.archetype}`);
        if (e.item && !items.items[e.item]) errors.push(`entity ${e.id}: unknown item ${e.item}`);
      }
      const refOk = (r) => !r || Array.isArray(r) || r === 'player' || ids.has(r);
      for (const e of w.entities) {
        if (e.patrol && !ids.has(e.patrol)) errors.push(`entity ${e.id}: patrol path ${e.patrol} not found`);
        if (e.type === 'outpost') { if (e.alarm && !ids.has(e.alarm)) errors.push(`outpost ${e.id}: alarm ${e.alarm} not found`); if (!e.group) warnings.push(`outpost ${e.id}: no garrison group`); else if (!w.entities.some((x) => x.group === e.group && (x.type === 'enemy'))) warnings.push(`outpost ${e.id}: no enemy in group ${e.group}`); }
      }
      // missions & dialogue
      const M = readJSON('game/missions.json', { missions: [], triggers: [] });
      const D = readJSON('game/dialogue.json', { speakers: {}, dialogues: {} });
      const groups = new Set(w.entities.map((e) => e.group).filter(Boolean));
      const mids = new Set((M.missions ?? []).map((m) => m.id));
      if (M.start && !mids.has(M.start)) errors.push(`missions: start mission ${M.start} not found`);
      const checkActions = (list, where) => {
        for (const a of list ?? []) {
          if (a.do === 'dialogue' && !D.dialogues?.[a.id]) errors.push(`${where}: dialogue ${a.id} not found`);
          if (['startMission', 'completeMission', 'failMission'].includes(a.do) && a.id && !mids.has(a.id)) errors.push(`${where}: mission ${a.id} not found`);
          for (const k of ['at', 'to', 'from', 'lookAt', 'entity']) if (a[k] && !refOk(a[k])) errors.push(`${where}: ${a.do}.${k} -> unknown entity ${a[k]}`);
          if (a.do === 'spawn' && !arch.archetypes[a.archetype]) errors.push(`${where}: spawn archetype ${a.archetype} unknown`);
          if (a.do === 'giveWeapon' && !weapons.weapons[a.weapon]) errors.push(`${where}: weapon ${a.weapon} unknown`);
          if (a.do === 'giveItem' && !items.items[a.item]) errors.push(`${where}: item ${a.item} unknown`);
        }
      };
      for (const m of M.missions ?? []) {
        checkActions(m.onStart, `mission ${m.id}.onStart`); checkActions(m.onComplete, `mission ${m.id}.onComplete`); checkActions(m.onFail, `mission ${m.id}.onFail`);
        if (!m.objectives?.length) warnings.push(`mission ${m.id}: no objectives`);
        for (const o of m.objectives ?? []) {
          const where = `mission ${m.id}/${o.id ?? o.type}`;
          for (const k of ['target', 'marker', 'actor']) if (o[k] && !refOk(o[k])) errors.push(`${where}: ${k} -> unknown entity ${o[k]}`);
          if (o.group && !groups.has(o.group)) warnings.push(`${where}: group ${o.group} has no entity (spawned later?)`);
          checkActions(o.onStart, where + '.onStart'); checkActions(o.onComplete, where + '.onComplete');
        }
      }
      for (const t of M.triggers ?? []) { checkActions(t.do, `trigger ${t.id}`); if (t.when?.enterZone && !ids.has(t.when.enterZone)) errors.push(`trigger ${t.id}: zone ${t.when.enterZone} not found`); }
      for (const [id, lines] of Object.entries(D.dialogues ?? {})) for (const l of lines) if (l.speaker && !D.speakers?.[l.speaker]) warnings.push(`dialogue ${id}: speaker ${l.speaker} undefined`);
      // recorded voices (voice/manifest.json): stale / missing clips fall back to the browser voice
      const { voicePlan, loadManifest } = await import('./voice.js');
      const vm = loadManifest();
      for (const [k, e] of Object.entries(vm.lines ?? {})) if (!fs.existsSync(path.join(ROOT, 'public', 'data', 'voice', e.file))) errors.push(`voice/manifest.json: ${k} -> missing file voice/${e.file}`);
      const vplan = voicePlan(D, vm);
      const vmissing = vplan.filter((r) => r.status === 'missing');
      if (vmissing.length) warnings.push(`voice: ${vmissing.length} line(s) without an up-to-date recording (${vmissing.slice(0, 5).map((r) => r.id).join(', ')}${vmissing.length > 5 ? ', …' : ''}): run mc voice generate`);
      // baked GI (gi/probes.*): derived data, a stale bake still works but lights the old world
      const giMeta = readJSON('gi/probes.json', null);
      if (!giMeta) warnings.push('gi: not baked (hemisphere light only): run mc gi bake');
      else {
        const { giInputsHash } = await import('./gi/bake.js');
        if (giMeta.inputs !== giInputsHash()) warnings.push('gi: stale (terrain / vegetation / props / assets / sunTilt changed since the bake): run mc gi bake');
      }
      const out = { ok: !errors.length, errors, warnings, counts: { assets: Object.keys(assets).length, entities: w.entities.length, missions: (M.missions ?? []).length, dialogues: Object.keys(D.dialogues ?? {}).length, voicedLines: vplan.filter((r) => r.status === 'ok').length } };
      if (errors.length) process.exitCode = 1;
      return out;
    },
  },

  // ---------------------------------------------------------------- live
  live: {
    usage: '<command> [json args] [--target editor|game|any]',
    help: 'Run a command in a running editor / game tab (via the dev server). e.g. mc live state; mc live select \'{"ids":["crate_3"]}\'; mc live commands',
    async run([cmd, ...json], o) {
      if (!(await serverUp())) throw new Error('dev server not running (npm run dev)');
      const r = await fetch(`${BASE}/api/live/cmd`, { method: 'POST', body: JSON.stringify({ target: o.target ?? 'any', cmd, args: json.length ? JSON.parse(json.join(' ')) : {} }) });
      const res = await r.json();
      if (res.error) throw new Error(res.error);
      if (res.result?.dataUrl && o.out) {
        const fs = await import('node:fs');
        fs.writeFileSync(o.out, Buffer.from(res.result.dataUrl.split(',')[1], 'base64'));
        return { file: o.out };
      }
      return res.result;
    },
  },
};

export function guardWrite() { writeJSON; }
