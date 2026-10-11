// Shared state of the Missions and Dialogues panels: the two JSON documents (kept across panel
// switches), their loading (never writes on load: a missing file stays missing until the user
// edits), staging for ed.saveAll() and undo / redo through the editor's undo stack.
import { signal } from '@preact/signals';
import { Data } from '../../../engine/core/Data.js';
import { S, log } from '../../core.js';
import { VOICE_MANIFEST } from '../../../game/missions/voice.js';

export const MISSIONS_FILE = 'game/missions.json';
export const DIALOGUE_FILE = 'game/dialogue.json';

/** Raw read through the dev API (distinguishes "missing" from "invalid JSON"). */
async function readJson(path) {
  try {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const files = await Data.list(dir); // existence check first: no 404 noise in the console
    if (!files.includes(path)) return { missing: true };
    const r = await fetch(`/api/read?path=${encodeURIComponent(path)}&t=${Date.now()}`, { cache: 'no-store' });
    if (r.status === 404) return { missing: true };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    try { return { data: JSON.parse(txt) }; } catch (e) { return { error: `JSON invalide : ${e.message}` }; }
  } catch {
    try { return { data: await Data.json(path, { fresh: true }) }; } catch { return { missing: true }; }
  }
}

function makeDoc(file, empty, normalize) {
  const D = {
    file,
    doc: signal(null), // the JSON document (null until loaded)
    status: signal('idle'), // idle | loading | ready | missing | error
    error: signal(null),
    conflict: signal(false), // modified on disk while we had unsaved edits
    normalize,
    _loading: null,
    get dirty() { return !!S.dirty.value[file]; },
    /** Load from disk unless there are unsaved edits (force = discard them). */
    load({ force = false } = {}) {
      if (D.dirty && D.doc.value && !force) return Promise.resolve();
      if (D._loading) return D._loading;
      if (!D.doc.value) D.status.value = 'loading';
      D._loading = readJson(file).then((r) => {
        D._loading = null;
        if (D.dirty && D.doc.value && !force) return; // edited while loading
        if (r.error) { D.error.value = r.error; D.status.value = 'error'; D.doc.value = null; return; }
        D.error.value = null;
        if (r.missing) { D.doc.value = empty(); D.status.value = 'missing'; }
        else { D.doc.value = normalize(r.data); D.status.value = 'ready'; }
        D.conflict.value = false;
        if (force) {
          const d = { ...S.dirty.value };
          delete d[file];
          S.dirty.value = d;
          if (D._ed?.pendingFiles) delete D._ed.pendingFiles[file];
        }
      });
      return D._loading;
    },
    /** Replace the document (undoable, staged for saving). `key` merges rapid edits of one field. */
    set(ed, next, label = 'Modifier', key = null) {
      const before = D.doc.value;
      if (before === next) return;
      D._apply(ed, next);
      const top = ed.undoStack[ed.undoStack.length - 1];
      if (key && top?._key === key && top._file === file && Date.now() - top._t < 1500) {
        top.redo = () => D._apply(ed, next);
        top._t = Date.now();
        return;
      }
      ed.pushUndo({ label: `${label} (${file.split('/').pop()})`, file, _file: file, _key: key, _t: Date.now(), undo: () => D._apply(ed, before), redo: () => D._apply(ed, next) });
    },
    _apply(ed, v) {
      D._ed = ed;
      D.doc.value = v;
      if (v) { D.status.value = 'ready'; ed.stageFile(file, v); }
    },
  };
  return D;
}

export const missions = makeDoc(MISSIONS_FILE, () => ({ start: null, variables: {}, missions: [], triggers: [] }), (d) => ({
  ...d,
  start: d.start ?? null,
  variables: d.variables ?? {},
  missions: Array.isArray(d.missions) ? d.missions : [],
  triggers: Array.isArray(d.triggers) ? d.triggers : [],
}));
export const dialogue = makeDoc(DIALOGUE_FILE, () => ({ speakers: {}, dialogues: {} }), (d) => ({
  ...d,
  speakers: d.speakers ?? {},
  dialogues: d.dialogues ?? {},
}));

// Recorded dialogue voices (voice/manifest.json, written by mc voice generate / the dev API).
export const voices = signal({ lines: {} });
export async function loadVoices() {
  const r = await readJson(VOICE_MANIFEST);
  voices.value = r.data ?? { lines: {} };
}

// Another tool / agent wrote the file: reload it when we have no unsaved edits, otherwise flag a
// conflict (the panels then offer to reload or keep the in-memory version).
import.meta.hot?.on('mc:data-changed', async (d) => {
  if (d?.path === VOICE_MANIFEST) loadVoices();
  for (const D of [missions, dialogue]) {
    if (d?.path !== D.file || !D.doc.value) continue;
    const r = await readJson(D.file);
    if (!r.data) continue;
    const disk = D.normalize(r.data);
    if (JSON.stringify(disk) === JSON.stringify(D.doc.value)) continue; // our own save
    if (D.dirty) { D.conflict.value = true; log(`${D.file} modifié sur le disque pendant l'édition`, 'warn'); }
    else { D.doc.value = disk; D.status.value = 'ready'; log(`${D.file} rechargé (modifié sur le disque)`); }
  }
});

// Static data used by the pickers (items, archetypes, weapons, sounds).
export const gameData = signal(null);
export function loadGameData(ed) {
  if (gameData.value) return;
  gameData.value = { items: ed.world.itemsData ?? { items: {} }, archetypes: ed.world.archetypes ?? { archetypes: {} }, weapons: { weapons: {} }, sounds: ed.sounds ?? { sounds: {} } };
  Promise.all([Data.jsonOr('game/weapons.json', { weapons: {}, ammoTypes: {} }), Data.jsonOr('sounds.json', { sounds: {} })]).then(([weapons, sounds]) => {
    gameData.value = { ...gameData.value, weapons, sounds };
  });
}

// Selection in the Missions panel (kept across panel switches; the Dialogues panel jumps here).
export const sel = signal({ kind: 'mission', i: 0, obj: null }); // kind: mission | trigger
export const selDialogue = signal(null);
export const selSpeaker = signal(null);
