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
  goto: { label: 'Aller à', icon: '📍', fields: [f('target', 'pos', 'Cible', { req: true }), f('radius', 'number', 'Rayon (m)', { def: 6 })] },
  kill: { label: 'Éliminer', icon: '☠', fields: [f('group', 'group', 'Groupe'), f('actor', 'actor', 'ou acteur')], oneOf: ['group', 'actor'] },
  pickup: { label: 'Ramasser', icon: '✋', fields: [f('target', 'pickup', 'Objet posé'), f('item', 'item', 'ou type d\'objet')], oneOf: ['target', 'item'] },
  interact: { label: 'Utiliser / parler', icon: '⚙', fields: [f('target', 'interact', 'Cible', { req: true })] },
  liberate: { label: 'Libérer', icon: '🚩', fields: [f('target', 'outpost', 'Avant-poste', { req: true })] },
  survive: { label: 'Survivre', icon: '⏱', fields: [f('seconds', 'number', 'Durée (s)', { def: 60 })] },
  escort: { label: 'Escorter', icon: '🧍', fields: [f('actor', 'actor', 'Acteur', { req: true }), f('target', 'pos', 'Destination', { req: true }), f('radius', 'number', 'Rayon (m)', { def: 6 })] },
  collect: { label: 'Collecter', icon: '💎', fields: [f('item', 'collect', 'Collectible', { req: true }), f('count', 'int', 'Nombre', { def: 1 }), f('absolute', 'bool', 'Total (pas depuis le début)')] },
  destroy: { label: 'Détruire', icon: '💥', fields: [f('target', 'destroy', 'Cible', { req: true })] },
  wait: { label: 'Attendre', icon: '⏸', fields: [f('seconds', 'number', 'Durée (s)', { def: 2 })] },
  condition: { label: 'Condition', icon: '❓', fields: [f('condition', 'condition', 'Condition', { req: true })] },
};
export const OBJ_COMMON = ['id', 'type', 'text', 'hidden', 'noMarker', 'marker', 'onStart', 'onComplete'];

/** Actions: label + params. */
export const ACTION_INFO = {
  dialogue: { label: 'Dialogue', params: [f('id', 'dialogue', 'dialogue', { req: true }), f('wait', 'bool', 'attendre la fin')] },
  say: { label: 'Réplique libre', params: [f('speaker', 'speaker', 'personnage'), f('text', 'longtext', 'texte', { req: true }), f('duration', 'number', 'durée (s)')] },
  banner: { label: 'Bannière', params: [f('title', 'string', 'titre'), f('subtitle', 'string', 'sous-titre'), f('duration', 'number', 'durée (s)', { def: 4 })] },
  hint: { label: 'Message', params: [f('text', 'string', 'texte', { req: true, wide: true }), f('duration', 'number', 'durée (s)', { def: 5 })] },
  startMission: { label: 'Démarrer une mission', params: [f('id', 'mission', 'mission', { req: true })] },
  completeMission: { label: 'Réussir une mission', params: [f('id', 'mission', 'mission', { def: 'active' })] },
  failMission: { label: 'Échouer une mission', params: [f('id', 'mission', 'mission', { def: 'active' }), f('reason', 'string', 'raison')] },
  completeObjective: { label: 'Valider un objectif', params: [f('mission', 'mission', 'mission', { def: 'active' }), f('id', 'objective', 'objectif')] },
  setVar: { label: 'Définir une variable', params: [f('name', 'var', 'variable', { req: true }), f('value', 'value', 'valeur')] },
  incVar: { label: 'Incrémenter une variable', params: [f('name', 'var', 'variable', { req: true }), f('by', 'number', 'de', { def: 1 })] },
  spawn: { label: 'Faire apparaître', params: [f('archetype', 'archetype', 'archétype', { req: true }), f('at', 'pos', 'à'), f('count', 'int', 'nombre', { def: 1 }), f('group', 'group', 'groupe'), f('behavior', 'enum', 'comportement', { options: ['attack', 'idle', 'patrol'] }), f('patrol', 'path', 'chemin')] },
  activateGroup: { label: 'Réveiller un groupe', params: [f('group', 'group', 'groupe', { req: true })] },
  alertGroup: { label: 'Alerter un groupe', params: [f('group', 'group', 'groupe', { req: true })] },
  removeGroup: { label: 'Retirer un groupe', params: [f('group', 'group', 'groupe', { req: true })] },
  enable: { label: 'Activer une entité', params: [f('entity', 'entity', 'entité', { req: true })] },
  disable: { label: 'Désactiver une entité', params: [f('entity', 'entity', 'entité', { req: true })] },
  giveWeapon: { label: 'Donner une arme', params: [f('weapon', 'weapon', 'arme', { req: true }), f('ammo', 'ammo', 'munitions')] },
  giveItem: { label: 'Donner un objet', params: [f('item', 'item', 'objet', { req: true }), f('count', 'int', 'nombre', { def: 1 })] },
  heal: { label: 'Soigner', params: [f('amount', 'number', 'quantité', { def: 100 })] },
  teleport: { label: 'Téléporter le joueur', params: [f('to', 'pos', 'vers', { req: true }), f('yaw', 'number', 'orientation (rad)')] },
  setTime: { label: 'Changer l\'heure', params: [f('hour', 'number', 'heure', { req: true })] },
  setDayLength: { label: 'Durée du jour', params: [f('minutes', 'number', 'minutes', { req: true })] },
  playSound: { label: 'Jouer un son', params: [f('sound', 'sound', 'son', { req: true }), f('at', 'pos', 'à'), f('volume', 'number', 'volume', { def: 1 })] },
  cinematic: { label: 'Cinématique', params: [f('from', 'pos', 'caméra de'), f('to', 'pos', 'vers'), f('lookAt', 'pos', 'regarde'), f('duration', 'number', 'durée (s)', { def: 4 }), f('text', 'string', 'texte')] },
  explode: { label: 'Explosion', params: [f('at', 'pos', 'à', { req: true }), f('radius', 'number', 'rayon', { def: 6 }), f('damage', 'number', 'dégâts', { def: 150 })] },
  wait: { label: 'Attendre', params: [f('seconds', 'number', 'secondes', { def: 1 })] },
  checkpoint: { label: 'Sauvegarde', params: [] },
  follow: { label: 'PNJ suit le joueur', params: [f('actor', 'actor', 'acteur', { req: true })] },
  stopFollow: { label: 'PNJ arrête de suivre', params: [f('actor', 'actor', 'acteur', { req: true })] },
  music: { label: 'Musique', params: [f('intensity', 'number', 'intensité 0..1', { def: 'auto' })] },
  endGame: { label: 'Fin du jeu', params: [f('title', 'string', 'titre'), f('text', 'longtext', 'texte')] },
  setMarker: { label: 'Marqueur carte', params: [f('id', 'string', 'id', { req: true }), f('at', 'pos', 'à (vide = retirer)')] },
};
for (const a of ACTIONS) ACTION_INFO[a] ??= { label: a, params: [] };

export const ACTION_DEFAULTS = {
  dialogue: { wait: true }, wait: { seconds: 2 }, banner: { title: '' }, hint: { text: '' }, say: { text: '' },
  spawn: { count: 1, behavior: 'attack' }, giveItem: { count: 1 }, heal: { amount: 100 }, setVar: { value: true },
};

/** Conditions: kind -> label + params. */
export const COND_INFO = {
  var: { label: 'Variable' },
  missionDone: { label: 'Mission réussie', ref: 'mission' },
  missionActive: { label: 'Mission en cours', ref: 'mission' },
  objectiveActive: { label: 'Objectif en cours' },
  actorDead: { label: 'Acteur mort', ref: 'actor' },
  actorAlive: { label: 'Acteur vivant', ref: 'actor' },
  groupDead: { label: 'Groupe éliminé', ref: 'group' },
  hasItem: { label: 'Possède l\'objet', ref: 'item' },
  hasWeapon: { label: 'Possède l\'arme', ref: 'weapon' },
  liberated: { label: 'Avant-poste libéré', ref: 'outpost' },
  inZone: { label: 'Joueur dans la zone', ref: 'zone' },
  timeBetween: { label: 'Heure entre' },
  destroyed: { label: 'Entité détruite', ref: 'destroy' },
  interacted: { label: 'Entité utilisée', ref: 'interact' },
  collected: { label: 'Collectibles ramassés' },
  not: { label: 'NON (inverse)' },
  all: { label: 'TOUTES (et)' },
  any: { label: 'AU MOINS UNE (ou)' },
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
  kill: { label: 'Acteur tué', filters: [f('actor', 'actor', 'acteur'), f('group', 'group', 'groupe')] },
  pickup: { label: 'Objet ramassé', filters: [f('entity', 'pickup', 'objet posé'), f('item', 'item', 'type d\'objet')] },
  interact: { label: 'Objet utilisé', filters: [f('entity', 'interact', 'entité')] },
  destroyed: { label: 'Entité détruite', filters: [f('entity', 'destroy', 'entité')] },
  liberate: { label: 'Avant-poste libéré', filters: [f('outpost', 'outpost', 'avant-poste')] },
  alarm: { label: 'Alarme déclenchée', filters: [f('outpost', 'outpost', 'avant-poste')] },
  missionStart: { label: 'Mission démarrée', filters: [f('mission', 'mission', 'mission')] },
  missionComplete: { label: 'Mission réussie', filters: [f('mission', 'mission', 'mission')] },
  objectiveComplete: { label: 'Objectif validé', filters: [f('mission', 'mission', 'mission'), f('objective', 'objective', 'objectif')] },
  enterZone: { label: 'Entrée dans une zone', filters: [f('zone', 'zone', 'zone')] },
  leaveZone: { label: 'Sortie d\'une zone', filters: [f('zone', 'zone', 'zone')] },
};
export const WHEN_KINDS = { enterZone: 'Entre dans la zone', leaveZone: 'Sort de la zone', event: 'Évènement', always: 'Toujours (avec condition)' };
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
  pos: 'entité', entity: 'entité', zone: 'zone', pickup: 'objet posé', interact: 'entité utilisable', destroy: 'entité destructible',
  outpost: 'avant-poste', actor: 'acteur', path: 'chemin', group: 'groupe', item: 'objet', collect: 'collectible', archetype: 'archétype',
  weapon: 'arme', ammo: 'munition', sound: 'son', dialogue: 'dialogue', speaker: 'personnage', mission: 'mission', var: 'variable', objective: 'objectif',
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
  const entOpts = (types) => nonProp.filter((e) => !types || types.includes(e.type)).map((e) => opt(e.id, [e.type, e.name, e.group && 'groupe ' + e.group].filter(Boolean).join(' · ')));
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
  lists.pos = [opt('player', 'le joueur'), ...lists.pos];
  lists.group = [...[...groups].map(([g, n]) => opt(g, `${n} entité${n > 1 ? 's' : ''}`)), ...[...spawnGroups].filter((g) => !groups.has(g)).map((g) => opt(g, 'créé par « spawn »'))];
  const it = items?.items ?? {};
  lists.item = Object.entries(it).map(([k, v]) => opt(k, v.label));
  lists.collect = Object.values(it).filter((v) => v.collectible).map((v) => opt(v.collectible, v.label));
  lists.archetype = Object.entries(archetypes?.archetypes ?? {}).map(([k, v]) => opt(k, v.label));
  lists.weapon = Object.entries(weapons?.weapons ?? {}).map(([k, v]) => opt(k, v.label));
  lists.ammo = Object.entries(weapons?.ammoTypes ?? {}).map(([k, v]) => opt(k, v.label));
  lists.sound = Object.keys(sounds?.sounds ?? {}).map((k) => opt(k));
  lists.dialogue = Object.entries(ddoc?.dialogues ?? {}).map(([k, v]) => opt(k, `${v.length} réplique${v.length > 1 ? 's' : ''} · ${(v[0]?.text ?? '').slice(0, 40)}`));
  lists.speaker = Object.entries(ddoc?.speakers ?? {}).map(([k, v]) => opt(k, v.name));
  lists.mission = (mdoc?.missions ?? []).map((m) => opt(m.id, m.title));
  const declared = Object.keys(mdoc?.variables ?? {});
  lists.var = [...declared.map((v) => opt(v, 'déclarée')), ...[...usedVars].filter((v) => !declared.includes(v)).map((v) => opt(v, 'non déclarée'))];
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
  if (doc.start && !mids.has(doc.start)) add({}, `Mission de départ « ${doc.start} » introuvable`);
  if (!doc.start && missions.length) add({}, 'Aucune mission de départ (★)', 'info');

  const ref = (kind, v, where, label) => {
    const r = R.check(kind, v);
    if (r === 'unknown') add(where, `${label} : ${KIND_LABEL[kind] ?? kind} « ${v} » inconnu${kind === 'var' ? 'e (non déclarée)' : ''}`, kind === 'var' || kind === 'group' ? 'info' : 'warn');
    else if (r === 'type') add(where, `${label} : « ${v} » est un(e) ${R.byId.get(v)?.type}, attendu ${(ENTITY_KINDS[kind] ?? []).join(' / ')}`);
  };
  const cond = (c, where, label) => {
    if (c === undefined || c === null) return;
    if (Array.isArray(c)) { c.forEach((x) => cond(x, where, label)); return; }
    const k = condKind(c);
    if (k === 'all' || k === 'any') { (c[k] ?? []).forEach((x) => cond(x, where, label)); return; }
    if (k === 'not') { cond(c.not, where, label); return; }
    if (k === '?') { add(where, `${label} : condition non reconnue ${JSON.stringify(c)}`); return; }
    if (k === 'var') { if (!c.var) add(where, `${label} : condition sur variable sans nom`); else ref('var', c.var, where, label); return; }
    if (k === 'collected') { ref('collect', c.collected?.item, where, label); return; }
    if (k === 'objectiveActive') {
      const { mission, id } = c.objectiveActive ?? {};
      if (!mission || !id) add(where, `${label} : condition « Objectif en cours » incomplète`);
      else { ref('mission', mission, where, label); if (!objIds(mission).has(id)) add(where, `${label} : objectif « ${id} » absent de la mission ${mission}`); }
      return;
    }
    const info = COND_INFO[k];
    if (info?.ref) { if (!c[k]) add(where, `${label} : condition « ${info.label} » incomplète`); else ref(info.ref, c[k], where, label); }
  };
  const objIds = (mid) => new Set((missions.find((m) => m.id === mid)?.objectives ?? []).map((o) => o.id));
  const actions = (list, where, label, curMission) => {
    (list ?? []).forEach((a, i) => {
      const l = `${label} #${i + 1}`;
      if (!a || typeof a !== 'object') { add(where, `${l} : action invalide`); return; }
      const info = ACTION_INFO[a.do];
      if (!ACTIONS.includes(a.do)) { add(where, `${l} : action « ${a.do} » inconnue`); return; }
      for (const p of info.params) {
        const v = a[p.k];
        if ((v === undefined || v === '') && p.req) { add(where, `${l} (${a.do}) : « ${p.label} » manquant`); continue; }
        if (p.kind === 'objective') {
          const mid = a.mission ?? curMission;
          if (v && mid && !objIds(mid).has(v)) add(where, `${l} : objectif « ${v} » absent de la mission ${mid}`);
        } else if (p.kind === 'ammo') {
          for (const t of Object.keys(v ?? {})) ref('ammo', t, where, l);
        } else ref(p.kind, v, where, l);
      }
      if (a.if !== undefined) cond(a.if, where, `${l} (si)`);
    });
  };

  missions.forEach((m, mi) => {
    const W = { m: mi };
    const name = `Mission ${m.id || '#' + (mi + 1)}`;
    if (!m.id) add(W, `${name} : id manquant`);
    else if (mids.get(m.id) > 1) add(W, `${name} : id en double`);
    if (!m.title) add(W, `${name} : titre manquant`, 'info');
    if (!m.objectives?.length) add(W, `${name} : aucun objectif`);
    (m.failIf ?? []).forEach((c) => cond(c, W, `${name} · échec si`));
    actions(m.onStart, W, `${name} · au démarrage`, m.id);
    actions(m.onComplete, W, `${name} · à la réussite`, m.id);
    actions(m.onFail, W, `${name} · à l'échec`, m.id);
    const oids = new Map();
    for (const o of m.objectives ?? []) if (o.id) oids.set(o.id, (oids.get(o.id) ?? 0) + 1);
    (m.objectives ?? []).forEach((o, oi) => {
      const OW = { m: mi, o: oi };
      const on = `${m.id} · objectif ${o.id || '#' + (oi + 1)}`;
      if (!o.id) add(OW, `${on} : id manquant`, 'info');
      else if (oids.get(o.id) > 1) add(OW, `${on} : id en double`);
      const info = OBJ_INFO[o.type];
      if (!info) { add(OW, `${on} : type « ${o.type} » inconnu`); return; }
      if (!o.text && !o.hidden) add(OW, `${on} : pas de texte affiché`, 'info');
      if (info.oneOf && !info.oneOf.some((k) => o[k])) add(OW, `${on} : renseigner ${info.oneOf.join(' ou ')}`);
      for (const fl of info.fields) {
        const v = o[fl.k];
        if (fl.req && (v === undefined || v === '')) { add(OW, `${on} : « ${fl.label} » manquant`); continue; }
        if (fl.kind === 'condition') cond(v, OW, on);
        else ref(fl.kind, v, OW, on);
      }
      if (o.marker) ref('pos', o.marker, OW, `${on} · marqueur`);
      actions(o.onStart, OW, `${on} · au début`, m.id);
      actions(o.onComplete, OW, `${on} · à la fin`, m.id);
    });
  });

  // world: NPCs that start a dialogue when the player talks to them
  for (const e of R.byId.values()) if (e.dialogue && typeof e.dialogue === 'string' && R.check('dialogue', e.dialogue) === 'unknown') add({}, `Monde : ${e.id} (parler) → dialogue « ${e.dialogue} » inconnu`);

  const tids = new Map();
  for (const t of doc.triggers ?? []) tids.set(t.id, (tids.get(t.id) ?? 0) + 1);
  (doc.triggers ?? []).forEach((t, ti) => {
    const W = { t: ti };
    const name = `Déclencheur ${t.id || '#' + (ti + 1)}`;
    if (!t.id) add(W, `${name} : id manquant (nécessaire pour « une seule fois »)`);
    else if (tids.get(t.id) > 1) add(W, `${name} : id en double`);
    const w = t.when ?? {};
    const k = whenKind(t.when);
    if (!t.when) add(W, `${name} : « quand » manquant`);
    else if (k === 'enterZone' || k === 'leaveZone') { if (!w[k]) add(W, `${name} : zone manquante`); else ref('zone', w[k], W, name); }
    else if (k === 'event') {
      const ev = EVENTS[w.event];
      if (!ev) add(W, `${name} : évènement « ${w.event ?? ''} » inconnu`);
      else for (const fl of ev.filters) if (fl.kind !== 'objective') ref(fl.kind, w[fl.k], W, name);
    } else if (k === 'always' && t.if === undefined) add(W, `${name} : « toujours » sans condition se déclenche immédiatement`, 'info');
    if (t.if !== undefined) cond(t.if, W, `${name} · si`);
    if (!t.do?.length) add(W, `${name} : aucune action`, 'info');
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
    const at = { onStart: 'au démarrage', onComplete: 'à la fin', onFail: 'à l\'échec', do: '' }[w.at] ?? w.at;
    let label;
    if (t) label = `Déclencheur ${t.id ?? '#' + (w.t + 1)}`;
    else if (w.o !== undefined) label = `${m.title || m.id} › objectif ${m.objectives[w.o]?.id ?? w.o + 1} (${at})`;
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
