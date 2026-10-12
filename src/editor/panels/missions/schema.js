// Mission / dialogue editor: what each objective type, action and condition takes (see
// docs/MISSIONS.md), the reference lists built from the world + data files (dropdowns), and the
// validation walker (unknown ids, duplicates, empty missions...).
import { OBJECTIVE_TYPES, ACTIONS } from '../../../game/missions/Missions.js';
import { S } from '../../core.js';

export { OBJECTIVE_TYPES, ACTIONS };

// field spec: { k: key, kind, label, req?: bool, def?: default shown as placeholder, options? }
const f = (k, kind, label, o = {}) => ({ k, kind, label, ...o });

/** Objective types: label, icon and type-specific fields. `oneOf`: at least one of these keys. */
export const OBJ_INFO = {
  goto: { label: 'Go to', icon: '📍', fields: [f('target', 'pos', 'Target', { req: true }), f('radius', 'number', 'Radius (m)', { def: 6 })] },
  kill: { label: 'Eliminate', icon: '☠', fields: [f('group', 'group', 'Group'), f('actor', 'actor', 'or actor')], oneOf: ['group', 'actor'] },
  pickup: { label: 'Pick up', icon: '✋', fields: [f('target', 'pickup', 'Placed item'), f('item', 'item', 'or item type')], oneOf: ['target', 'item'] },
  interact: { label: 'Use / talk', icon: '⚙', fields: [f('target', 'interact', 'Target', { req: true })] },
  liberate: { label: 'Liberate', icon: '🚩', fields: [f('target', 'outpost', 'Outpost', { req: true })] },
  survive: { label: 'Survive', icon: '⏱', fields: [f('seconds', 'number', 'Duration (s)', { def: 60 })] },
  escort: { label: 'Escort', icon: '🧍', fields: [f('actor', 'actor', 'Actor', { req: true }), f('target', 'pos', 'Destination', { req: true }), f('radius', 'number', 'Radius (m)', { def: 6 })] },
  collect: { label: 'Collect', icon: '💎', fields: [f('item', 'collect', 'Collectible', { req: true }), f('count', 'int', 'Count', { def: 1 }), f('absolute', 'bool', 'Total (not since the start)')] },
  destroy: { label: 'Destroy', icon: '💥', fields: [f('target', 'destroy', 'Target', { req: true })] },
  wait: { label: 'Wait', icon: '⏸', fields: [f('seconds', 'number', 'Duration (s)', { def: 2 })] },
  condition: { label: 'Condition', icon: '❓', fields: [f('condition', 'condition', 'Condition', { req: true })] },
};
export const OBJ_COMMON = ['id', 'type', 'text', 'hidden', 'noMarker', 'marker', 'onStart', 'onComplete'];

/** Actions: label + params. */
export const ACTION_INFO = {
  dialogue: { label: 'Dialogue', params: [f('id', 'dialogue', 'dialogue', { req: true }), f('wait', 'bool', 'wait for the end')] },
  say: { label: 'Free line', params: [f('speaker', 'speaker', 'speaker'), f('text', 'longtext', 'text', { req: true }), f('duration', 'number', 'duration (s)')] },
  banner: { label: 'Banner', params: [f('title', 'string', 'title'), f('subtitle', 'string', 'subtitle'), f('duration', 'number', 'duration (s)', { def: 4 })] },
  hint: { label: 'Message', params: [f('text', 'string', 'text', { req: true, wide: true }), f('duration', 'number', 'duration (s)', { def: 5 })] },
  startMission: { label: 'Start a mission', params: [f('id', 'mission', 'mission', { req: true })] },
  completeMission: { label: 'Complete a mission', params: [f('id', 'mission', 'mission', { def: 'active' })] },
  failMission: { label: 'Fail a mission', params: [f('id', 'mission', 'mission', { def: 'active' }), f('reason', 'string', 'reason')] },
  completeObjective: { label: 'Complete an objective', params: [f('mission', 'mission', 'mission', { def: 'active' }), f('id', 'objective', 'objective')] },
  setVar: { label: 'Set a variable', params: [f('name', 'var', 'variable', { req: true }), f('value', 'value', 'value')] },
  incVar: { label: 'Increment a variable', params: [f('name', 'var', 'variable', { req: true }), f('by', 'number', 'by', { def: 1 })] },
  spawn: { label: 'Spawn', params: [f('archetype', 'archetype', 'archetype', { req: true }), f('at', 'pos', 'at'), f('count', 'int', 'count', { def: 1 }), f('group', 'group', 'group'), f('behavior', 'enum', 'behavior', { options: ['attack', 'idle', 'patrol'] }), f('patrol', 'path', 'path')] },
  activateGroup: { label: 'Wake up a group', params: [f('group', 'group', 'group', { req: true })] },
  alertGroup: { label: 'Alert a group', params: [f('group', 'group', 'group', { req: true })] },
  removeGroup: { label: 'Remove a group', params: [f('group', 'group', 'group', { req: true })] },
  enable: { label: 'Enable an entity', params: [f('entity', 'entity', 'entity', { req: true })] },
  disable: { label: 'Disable an entity', params: [f('entity', 'entity', 'entity', { req: true })] },
  giveWeapon: { label: 'Give a weapon', params: [f('weapon', 'weapon', 'weapon', { req: true }), f('ammo', 'ammo', 'ammo')] },
  giveItem: { label: 'Give an item', params: [f('item', 'item', 'item', { req: true }), f('count', 'int', 'count', { def: 1 })] },
  heal: { label: 'Heal', params: [f('amount', 'number', 'amount', { def: 100 })] },
  teleport: { label: 'Teleport the player', params: [f('to', 'pos', 'to', { req: true }), f('yaw', 'number', 'heading (rad)')] },
  setTime: { label: 'Change the time', params: [f('hour', 'number', 'hour', { req: true })] },
  setDayLength: { label: 'Day length', params: [f('minutes', 'number', 'minutes', { req: true })] },
  playSound: { label: 'Play a sound', params: [f('sound', 'sound', 'sound', { req: true }), f('at', 'pos', 'at'), f('volume', 'number', 'volume', { def: 1 })] },
  cinematic: { label: 'Cinematic', params: [f('from', 'pos', 'camera from'), f('to', 'pos', 'to'), f('lookAt', 'pos', 'looks at'), f('duration', 'number', 'duration (s)', { def: 4 }), f('text', 'string', 'text')] },
  explode: { label: 'Explosion', params: [f('at', 'pos', 'at', { req: true }), f('radius', 'number', 'radius', { def: 6 }), f('damage', 'number', 'damage', { def: 150 })] },
  wait: { label: 'Wait', params: [f('seconds', 'number', 'seconds', { def: 1 })] },
  checkpoint: { label: 'Checkpoint', params: [] },
  follow: { label: 'NPC follows the player', params: [f('actor', 'actor', 'actor', { req: true })] },
  stopFollow: { label: 'NPC stops following', params: [f('actor', 'actor', 'actor', { req: true })] },
  music: { label: 'Music', params: [f('intensity', 'number', 'intensity 0..1', { def: 'auto' })] },
  endGame: { label: 'End of the game', params: [f('title', 'string', 'title'), f('text', 'longtext', 'text')] },
  setMarker: { label: 'Map marker', params: [f('id', 'string', 'id', { req: true }), f('at', 'pos', 'at (empty = remove)')] },
};
for (const a of ACTIONS) ACTION_INFO[a] ??= { label: a, params: [] };

export const ACTION_DEFAULTS = {
  dialogue: { wait: true }, wait: { seconds: 2 }, banner: { title: '' }, hint: { text: '' }, say: { text: '' },
  spawn: { count: 1, behavior: 'attack' }, giveItem: { count: 1 }, heal: { amount: 100 }, setVar: { value: true },
};

/** Conditions: kind -> label + params. */
export const COND_INFO = {
  var: { label: 'Variable' },
  missionDone: { label: 'Mission completed', ref: 'mission' },
  missionActive: { label: 'Mission in progress', ref: 'mission' },
  objectiveActive: { label: 'Objective in progress' },
  actorDead: { label: 'Actor dead', ref: 'actor' },
  actorAlive: { label: 'Actor alive', ref: 'actor' },
  groupDead: { label: 'Group eliminated', ref: 'group' },
  hasItem: { label: 'Has the item', ref: 'item' },
  hasWeapon: { label: 'Has the weapon', ref: 'weapon' },
  liberated: { label: 'Outpost liberated', ref: 'outpost' },
  inZone: { label: 'Player in the zone', ref: 'zone' },
  timeBetween: { label: 'Time between' },
  destroyed: { label: 'Entity destroyed', ref: 'destroy' },
  interacted: { label: 'Entity used', ref: 'interact' },
  collected: { label: 'Collectibles picked up' },
  not: { label: 'NOT (inverse)' },
  all: { label: 'ALL (and)' },
  any: { label: 'AT LEAST ONE (or)' },
};
export const COND_KINDS = Object.keys(COND_INFO);
export const COND_DEFAULT = {
  var: { var: '' }, timeBetween: { timeBetween: [20, 5] }, collected: { collected: { item: 'relic', count: 3 } },
  objectiveActive: { objectiveActive: { mission: '', id: '' } },
  not: { not: { var: '' } }, all: { all: [] }, any: { any: [] },
};

/** Kind of a condition ('?' = not understood by the editor: kept and edited as raw JSON). */
export function condKind(c) {
  if (Array.isArray(c)) return 'all';
  if (!c || typeof c !== 'object') return '?';
  for (const k of ['all', 'any', 'not', 'var', ...COND_KINDS]) if (c[k] !== undefined) return k;
  return '?';
}

/** Trigger events and their filters. */
export const EVENTS = {
  kill: { label: 'Actor killed', filters: [f('actor', 'actor', 'actor'), f('group', 'group', 'group')] },
  pickup: { label: 'Item picked up', filters: [f('entity', 'pickup', 'placed item'), f('item', 'item', 'item type')] },
  interact: { label: 'Entity used', filters: [f('entity', 'interact', 'entity')] },
  destroyed: { label: 'Entity destroyed', filters: [f('entity', 'destroy', 'entity')] },
  liberate: { label: 'Outpost liberated', filters: [f('outpost', 'outpost', 'outpost')] },
  alarm: { label: 'Alarm raised', filters: [f('outpost', 'outpost', 'outpost')] },
  missionStart: { label: 'Mission started', filters: [f('mission', 'mission', 'mission')] },
  missionComplete: { label: 'Mission completed', filters: [f('mission', 'mission', 'mission')] },
  objectiveComplete: { label: 'Objective completed', filters: [f('mission', 'mission', 'mission'), f('objective', 'objective', 'objective')] },
  enterZone: { label: 'Zone entered', filters: [f('zone', 'zone', 'zone')] },
  leaveZone: { label: 'Zone left', filters: [f('zone', 'zone', 'zone')] },
};
export const WHEN_KINDS = { enterZone: 'Enters the zone', leaveZone: 'Leaves the zone', event: 'Event', always: 'Always (with condition)' };
export function whenKind(w) {
  if (!w) return 'enterZone';
  if (w.enterZone !== undefined) return 'enterZone';
  if (w.leaveZone !== undefined) return 'leaveZone';
  if (w.always) return 'always';
  return 'event';
}

// --- references -------------------------------------------------------------------------------
/** Entity-backed reference kinds -> accepted entity types (null = any). */
export const ENTITY_KINDS = {
  pos: null, entity: null, zone: ['zone'], pickup: ['pickup'], interact: ['interactable', 'alarm', 'npc'],
  destroy: ['explosive', 'destructible'], outpost: ['outpost'], actor: ['enemy', 'npc'], path: ['path'],
};
export const KIND_LABEL = {
  pos: 'entity', entity: 'entity', zone: 'zone', pickup: 'placed item', interact: 'usable entity', destroy: 'destructible entity',
  outpost: 'outpost', actor: 'actor', path: 'path', group: 'group', item: 'item', collect: 'collectible', archetype: 'archetype',
  weapon: 'weapon', ammo: 'ammo', sound: 'sound', dialogue: 'dialogue', speaker: 'speaker', mission: 'mission', var: 'variable', objective: 'objective',
};

/** Visit every action of a missions doc: fn(action, where). */
export function eachAction(doc, fn) {
  const list = (acts, where) => { for (const a of acts ?? []) if (a && typeof a === 'object') fn(a, where); };
  (doc?.missions ?? []).forEach((m, mi) => {
    for (const k of ['onStart', 'onComplete', 'onFail']) list(m[k], { m: mi, at: k });
    (m.objectives ?? []).forEach((o, oi) => { list(o.onStart, { m: mi, o: oi, at: 'onStart' }); list(o.onComplete, { m: mi, o: oi, at: 'onComplete' }); });
  });
  (doc?.triggers ?? []).forEach((t, ti) => list(t.do, { t: ti, at: 'do' }));
}

/** Lists for the dropdowns + lookup sets, from the world and the data files. */
export function buildRefs({ ed, mdoc, ddoc, items, archetypes, weapons, sounds }) {
  const ents = ed?.world?.entities?.list ?? [];
  const byId = new Map(ents.map((e) => [e.id, e]));
  const nonProp = ents.filter((e) => e.type !== 'prop');
  const opt = (value, label = '') => ({ value, label });
  const entOpts = (types) => nonProp.filter((e) => !types || types.includes(e.type)).map((e) => opt(e.id, [e.type, e.name, e.group && 'group ' + e.group].filter(Boolean).join(' · ')));
  const groups = new Map();
  for (const e of ents) if (e.group) groups.set(e.group, (groups.get(e.group) ?? 0) + 1);
  const spawnGroups = new Set();
  const usedVars = new Set();
  eachAction(mdoc, (a) => {
    if (a.do === 'spawn' && a.group) spawnGroups.add(a.group);
    if ((a.do === 'setVar' || a.do === 'incVar') && a.name) usedVars.add(a.name);
  });
  const lists = {};
  for (const [k, types] of Object.entries(ENTITY_KINDS)) lists[k] = entOpts(types);
  lists.pos = [opt('player', 'the player'), ...lists.pos];
  lists.group = [...[...groups].map(([g, n]) => opt(g, `${n} entit${n > 1 ? 'ies' : 'y'}`)), ...[...spawnGroups].filter((g) => !groups.has(g)).map((g) => opt(g, 'created by "spawn"'))];
  const it = items?.items ?? {};
  lists.item = Object.entries(it).map(([k, v]) => opt(k, v.label));
  lists.collect = Object.values(it).filter((v) => v.collectible).map((v) => opt(v.collectible, v.label));
  lists.archetype = Object.entries(archetypes?.archetypes ?? {}).map(([k, v]) => opt(k, v.label));
  lists.weapon = Object.entries(weapons?.weapons ?? {}).map(([k, v]) => opt(k, v.label));
  lists.ammo = Object.entries(weapons?.ammoTypes ?? {}).map(([k, v]) => opt(k, v.label));
  lists.sound = Object.keys(sounds?.sounds ?? {}).map((k) => opt(k));
  lists.dialogue = Object.entries(ddoc?.dialogues ?? {}).map(([k, v]) => opt(k, `${v.length} line${v.length > 1 ? 's' : ''} · ${(v[0]?.text ?? '').slice(0, 40)}`));
  lists.speaker = Object.entries(ddoc?.speakers ?? {}).map(([k, v]) => opt(k, v.name));
  lists.mission = (mdoc?.missions ?? []).map((m) => opt(m.id, m.title));
  const declared = Object.keys(mdoc?.variables ?? {});
  lists.var = [...declared.map((v) => opt(v, 'declared')), ...[...usedVars].filter((v) => !declared.includes(v)).map((v) => opt(v, 'undeclared'))];
  const sets = {};
  for (const [k, l] of Object.entries(lists)) sets[k] = new Set(l.map((o) => o.value));
  sets.group = new Set([...groups.keys(), ...spawnGroups]);
  sets.var = new Set(declared);
  const known = { dialogue: !!ddoc, speaker: !!ddoc, sound: lists.sound.length > 0, item: lists.item.length > 0, archetype: lists.archetype.length > 0, weapon: lists.weapon.length > 0 };
  return {
    ed, lists, sets, byId, groups, mdoc, ddoc,
    isEntityKind: (k) => k in ENTITY_KINDS,
    /** 'ok' | 'unknown' | 'type' (exists, wrong entity type) | 'skip' (cannot be checked) */
    check(kind, v) {
      if (v === undefined || v === null || v === '') return 'ok';
      if (kind in ENTITY_KINDS) {
        if (Array.isArray(v)) return 'ok';
        if (kind === 'pos' && v === 'player') return 'ok';
        const e = byId.get(v);
        if (!e) return 'unknown';
        const types = ENTITY_KINDS[kind];
        return !types || types.includes(e.type) ? 'ok' : 'type';
      }
      if (kind === 'objective' || kind === 'value' || kind === 'string') return 'ok';
      if (known[kind] === false) return 'skip';
      if (!sets[kind]) return 'ok';
      return sets[kind].has(v) ? 'ok' : 'unknown';
    },
    show(id) {
      if (!ed || !byId.has(id)) return;
      ed.select([id]);
      ed.frameSelection();
      S.panel.value = 'world';
    },
  };
}

// --- validation -------------------------------------------------------------------------------
/** Problems in a missions doc: [{ msg, m?, o?, t?, level: 'warn' | 'info' }] */
export function validate(doc, R) {
  const out = [];
  if (!doc) return out;
  const add = (where, msg, level = 'warn') => out.push({ ...where, msg, level });
  const missions = doc.missions ?? [];
  const mids = new Map();
  for (const m of missions) mids.set(m.id, (mids.get(m.id) ?? 0) + 1);
  if (doc.start && !mids.has(doc.start)) add({}, `Start mission "${doc.start}" not found`);
  if (!doc.start && missions.length) add({}, 'No start mission (★)', 'info');

  const ref = (kind, v, where, label) => {
    const r = R.check(kind, v);
    if (r === 'unknown') add(where, `${label}: unknown ${KIND_LABEL[kind] ?? kind} "${v}"${kind === 'var' ? ' (undeclared)' : ''}`, kind === 'var' || kind === 'group' ? 'info' : 'warn');
    else if (r === 'type') add(where, `${label}: "${v}" is of type ${R.byId.get(v)?.type}, expected ${(ENTITY_KINDS[kind] ?? []).join(' / ')}`);
  };
  const cond = (c, where, label) => {
    if (c === undefined || c === null) return;
    if (Array.isArray(c)) { c.forEach((x) => cond(x, where, label)); return; }
    const k = condKind(c);
    if (k === 'all' || k === 'any') { (c[k] ?? []).forEach((x) => cond(x, where, label)); return; }
    if (k === 'not') { cond(c.not, where, label); return; }
    if (k === '?') { add(where, `${label}: unrecognized condition ${JSON.stringify(c)}`); return; }
    if (k === 'var') { if (!c.var) add(where, `${label}: variable condition without a name`); else ref('var', c.var, where, label); return; }
    if (k === 'collected') { ref('collect', c.collected?.item, where, label); return; }
    if (k === 'objectiveActive') {
      const { mission, id } = c.objectiveActive ?? {};
      if (!mission || !id) add(where, `${label}: incomplete "Objective in progress" condition`);
      else { ref('mission', mission, where, label); if (!objIds(mission).has(id)) add(where, `${label}: objective "${id}" is not in mission ${mission}`); }
      return;
    }
    const info = COND_INFO[k];
    if (info?.ref) { if (!c[k]) add(where, `${label}: incomplete "${info.label}" condition`); else ref(info.ref, c[k], where, label); }
  };
  const objIds = (mid) => new Set((missions.find((m) => m.id === mid)?.objectives ?? []).map((o) => o.id));
  const actions = (list, where, label, curMission) => {
    (list ?? []).forEach((a, i) => {
      const l = `${label} #${i + 1}`;
      if (!a || typeof a !== 'object') { add(where, `${l}: invalid action`); return; }
      const info = ACTION_INFO[a.do];
      if (!ACTIONS.includes(a.do)) { add(where, `${l}: unknown action "${a.do}"`); return; }
      for (const p of info.params) {
        const v = a[p.k];
        if ((v === undefined || v === '') && p.req) { add(where, `${l} (${a.do}): "${p.label}" missing`); continue; }
        if (p.kind === 'objective') {
          const mid = a.mission ?? curMission;
          if (v && mid && !objIds(mid).has(v)) add(where, `${l}: objective "${v}" is not in mission ${mid}`);
        } else if (p.kind === 'ammo') {
          for (const t of Object.keys(v ?? {})) ref('ammo', t, where, l);
        } else ref(p.kind, v, where, l);
      }
      if (a.if !== undefined) cond(a.if, where, `${l} (if)`);
    });
  };

  missions.forEach((m, mi) => {
    const W = { m: mi };
    const name = `Mission ${m.id || '#' + (mi + 1)}`;
    if (!m.id) add(W, `${name}: missing id`);
    else if (mids.get(m.id) > 1) add(W, `${name}: duplicate id`);
    if (!m.title) add(W, `${name}: missing title`, 'info');
    if (!m.objectives?.length) add(W, `${name}: no objectives`);
    (m.failIf ?? []).forEach((c) => cond(c, W, `${name} · fail if`));
    actions(m.onStart, W, `${name} · on start`, m.id);
    actions(m.onComplete, W, `${name} · on success`, m.id);
    actions(m.onFail, W, `${name} · on fail`, m.id);
    const oids = new Map();
    for (const o of m.objectives ?? []) if (o.id) oids.set(o.id, (oids.get(o.id) ?? 0) + 1);
    (m.objectives ?? []).forEach((o, oi) => {
      const OW = { m: mi, o: oi };
      const on = `${m.id} · objective ${o.id || '#' + (oi + 1)}`;
      if (!o.id) add(OW, `${on}: missing id`, 'info');
      else if (oids.get(o.id) > 1) add(OW, `${on}: duplicate id`);
      const info = OBJ_INFO[o.type];
      if (!info) { add(OW, `${on}: unknown type "${o.type}"`); return; }
      if (!o.text && !o.hidden) add(OW, `${on}: no displayed text`, 'info');
      if (info.oneOf && !info.oneOf.some((k) => o[k])) add(OW, `${on}: set ${info.oneOf.join(' or ')}`);
      for (const fl of info.fields) {
        const v = o[fl.k];
        if (fl.req && (v === undefined || v === '')) { add(OW, `${on}: "${fl.label}" missing`); continue; }
        if (fl.kind === 'condition') cond(v, OW, on);
        else ref(fl.kind, v, OW, on);
      }
      if (o.marker) ref('pos', o.marker, OW, `${on} · marker`);
      actions(o.onStart, OW, `${on} · at start`, m.id);
      actions(o.onComplete, OW, `${on} · on completion`, m.id);
    });
  });

  // world: NPCs that start a dialogue when the player talks to them
  for (const e of R.byId.values()) if (e.dialogue && typeof e.dialogue === 'string' && R.check('dialogue', e.dialogue) === 'unknown') add({}, `World: ${e.id} (talk) → unknown dialogue "${e.dialogue}"`);

  const tids = new Map();
  for (const t of doc.triggers ?? []) tids.set(t.id, (tids.get(t.id) ?? 0) + 1);
  (doc.triggers ?? []).forEach((t, ti) => {
    const W = { t: ti };
    const name = `Trigger ${t.id || '#' + (ti + 1)}`;
    if (!t.id) add(W, `${name}: missing id (needed for "Once only")`);
    else if (tids.get(t.id) > 1) add(W, `${name}: duplicate id`);
    const w = t.when ?? {};
    const k = whenKind(t.when);
    if (!t.when) add(W, `${name}: "when" missing`);
    else if (k === 'enterZone' || k === 'leaveZone') { if (!w[k]) add(W, `${name}: missing zone`); else ref('zone', w[k], W, name); }
    else if (k === 'event') {
      const ev = EVENTS[w.event];
      if (!ev) add(W, `${name}: unknown event "${w.event ?? ''}"`);
      else for (const fl of ev.filters) if (fl.kind !== 'objective') ref(fl.kind, w[fl.k], W, name);
    } else if (k === 'always' && t.if === undefined) add(W, `${name}: "always" without a condition fires immediately`, 'info');
    if (t.if !== undefined) cond(t.if, W, `${name} · if`);
    if (!t.do?.length) add(W, `${name}: no actions`, 'info');
    actions(t.do, W, name, null);
  });
  return out;
}

/** Where each dialogue id is used: id -> [{ m?, o?, t?, label }] */
export function dialogueUsage(doc) {
  const use = {};
  eachAction(doc, (a, w) => {
    if (a.do !== 'dialogue' || !a.id) return;
    const m = w.m !== undefined ? doc.missions[w.m] : null;
    const t = w.t !== undefined ? doc.triggers[w.t] : null;
    const at = { onStart: 'on start', onComplete: 'on completion', onFail: 'on fail', do: '' }[w.at] ?? w.at;
    let label;
    if (t) label = `Trigger ${t.id ?? '#' + (w.t + 1)}`;
    else if (w.o !== undefined) label = `${m.title || m.id} › objective ${m.objectives[w.o]?.id ?? w.o + 1} (${at})`;
    else label = `${m.title || m.id} (${at})`;
    (use[a.id] ??= []).push({ ...w, label });
  });
  return use;
}

/** A fresh id not in `taken`: base, base_2, base_3... (or prefix + number when base ends with a number). */
export function uniqueId(base, taken) {
  const set = taken instanceof Set ? taken : new Set(taken);
  if (!set.has(base)) return base;
  const m = /^(.*?)(\d+)$/.exec(base);
  if (m) {
    const w = m[2].length;
    for (let n = +m[2] + 1; ; n++) { const id = m[1] + String(n).padStart(w, '0'); if (!set.has(id)) return id; }
  }
  for (let n = 2; ; n++) if (!set.has(`${base}_${n}`)) return `${base}_${n}`;
}

export { lineDuration as dialogueDuration } from '../../../game/missions/voice.js';

/**
 * Rename references in a missions doc (returns { doc, n } with n = references changed).
 * kind: 'mission' | 'objective' (scoped to the mission `scope`) | 'dialogue' | 'speaker'.
 */
export function renameRefs(doc, kind, from, to, scope) {
  const d = structuredClone(doc);
  let n = 0;
  const swap = (o, k) => { if (o && o[k] === from) { o[k] = to; n++; } };
  const cond = (c) => {
    if (!c || typeof c !== 'object') return;
    if (Array.isArray(c)) { c.forEach(cond); return; }
    if (kind === 'mission') { swap(c, 'missionDone'); swap(c, 'missionActive'); }
    cond(c.not);
    (c.all ?? []).forEach(cond);
    (c.any ?? []).forEach(cond);
  };
  const acts = (list, cur) => {
    for (const a of list ?? []) {
      if (!a || typeof a !== 'object') continue;
      if (kind === 'mission') {
        if (['startMission', 'completeMission', 'failMission'].includes(a.do)) swap(a, 'id');
        if (a.do === 'completeObjective') swap(a, 'mission');
      }
      if (kind === 'objective' && a.do === 'completeObjective' && (a.mission ?? cur) === scope) swap(a, 'id');
      if (kind === 'dialogue' && a.do === 'dialogue') swap(a, 'id');
      if (kind === 'speaker' && a.do === 'say') swap(a, 'speaker');
      cond(a.if);
    }
  };
  if (kind === 'mission') swap(d, 'start');
  for (const m of d.missions ?? []) {
    acts(m.onStart, m.id); acts(m.onComplete, m.id); acts(m.onFail, m.id);
    (m.failIf ?? []).forEach(cond);
    for (const o of m.objectives ?? []) { acts(o.onStart, m.id); acts(o.onComplete, m.id); cond(o.condition); }
  }
  for (const t of d.triggers ?? []) {
    cond(t.if);
    acts(t.do, null);
    const w = t.when;
    if (!w) continue;
    if (kind === 'mission') swap(w, 'mission');
    if (kind === 'objective' && w.event === 'objectiveComplete' && w.mission === scope) swap(w, 'objective');
  }
  return { doc: d, n };
}
