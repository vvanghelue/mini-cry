// State of the Audio panel (kept across panel switches): the sounds.json document, the selection,
// staging for ed.saveAll() (as text in the file's compact layout, see format.js) and undo / redo
// through the editor's undo stack.
import { signal } from '@preact/signals';
import { Data } from '../../../engine/core/Data.js';
import { S, log } from '../../core.js';
import { scanLayout, formatSoundsFile } from './format.js';

export const FILE = 'sounds.json';

export const A = {
  doc: signal(null), // parsed sounds.json
  status: signal('idle'), // idle | loading | ready | error
  error: signal(null),
  conflict: signal(false),
  sel: signal(null), // selected sound name
  layer: signal(0), // selected layer index
  view: signal('sound'), // sound | mix
  solo: signal(null), // { sound, layer } preview-only solo
  json: signal(false), // raw JSON mode for the recipe
  group: signal('cat'),
  collapsed: signal({}),
  search: signal(''),
  variation: signal(0), // displayed / exported variation index (seed = index + 1)
  loopPreview: signal(true),
  autoPlay: signal(false),
};

let layout = null; // scanLayout() of the file as loaded / last saved

export const isDirty = () => !!S.dirty.value[FILE];

async function readText() {
  const r = await fetch(`${Data.base}${FILE}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** Load sounds.json from disk (unless there are unsaved edits; force = discard them). */
export async function load(ed, { force = false } = {}) {
  if (A.doc.value && isDirty() && !force) return;
  if (!A.doc.value) A.status.value = 'loading';
  try {
    const text = await readText();
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || typeof doc.sounds !== 'object') throw new Error('pas de section "sounds"');
    if (A.doc.value && isDirty() && !force) return; // edited while loading
    layout = scanLayout(text);
    A.doc.value = doc;
    A.status.value = 'ready';
    A.error.value = null;
    A.conflict.value = false;
    ed.sounds = doc;
    if (force) {
      const d = { ...S.dirty.value };
      delete d[FILE];
      S.dirty.value = d;
      if (ed.pendingFiles) delete ed.pendingFiles[FILE];
    }
    const names = Object.keys(doc.sounds);
    if (!A.sel.value || !doc.sounds[A.sel.value]) A.sel.value = names[0] ?? null;
  } catch (e) {
    if (!A.doc.value) { A.status.value = 'error'; A.error.value = e.message; }
    log(`Audio : lecture de ${FILE} impossible (${e.message})`, 'error');
  }
}

function apply(ed, doc) {
  A.doc.value = doc;
  ed.sounds = doc;
  ed.stageFile(FILE, formatSoundsFile(doc, layout));
}

/**
 * Replace the document (undoable, staged for saving). `key` merges rapid edits of the same field
 * (drag-scrubbing a number) into one undo step.
 */
export function setDoc(ed, next, label = 'Modifier', key = null) {
  const before = A.doc.value;
  if (before === next || !next) return;
  apply(ed, next);
  const top = ed.undoStack[ed.undoStack.length - 1];
  if (key && top?._audioKey === key && Date.now() - top._t < 1500) {
    top.redo = () => restore(ed, next);
    top._t = Date.now();
    return;
  }
  const sel = A.sel.value;
  ed.pushUndo({
    label: `${label} (son)`, file: FILE, _audioKey: key, _t: Date.now(),
    undo: () => restore(ed, before, sel),
    redo: () => restore(ed, next, sel),
  });
}

function restore(ed, doc, sel) {
  apply(ed, doc);
  if (sel && doc.sounds[sel]) A.sel.value = sel;
  else if (!doc.sounds[A.sel.value]) A.sel.value = Object.keys(doc.sounds)[0] ?? null;
}

/** Set one sound's recipe (null = delete). */
export function setRecipe(ed, name, recipe, label, key) {
  const doc = A.doc.value;
  const sounds = { ...doc.sounds };
  if (recipe == null) delete sounds[name]; else sounds[name] = recipe;
  setDoc(ed, { ...doc, sounds }, label ?? `Modifier ${name}`, key ? `${name}:${key}` : null);
}

/** Set a top-level section (music / ambient). */
export function setSection(ed, sec, value, key) {
  const doc = A.doc.value;
  setDoc(ed, { ...doc, [sec]: value }, `Réglages ${sec}`, key ? `${sec}:${key}` : null);
}

/** Insert `key: value` right after `after` (or at the end), keeping the key order of the file. */
export function insertAfter(obj, after, key, value) {
  const out = {};
  let done = false;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) continue;
    out[k] = v;
    if (k === after) { out[key] = value; done = true; }
  }
  if (!done) out[key] = value;
  return out;
}

export function renameKey(obj, from, to) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

export const validName = (n) => /^[a-z0-9_]+$/i.test(n ?? '');

export function uniqueName(base, sounds) {
  if (!sounds[base]) return base;
  const stem = base.replace(/_\d+$/, '');
  for (let i = 2; ; i++) if (!sounds[`${stem}_${i}`]) return `${stem}_${i}`;
}

// Another tool / agent wrote the file: reload it when we have no unsaved edits, otherwise flag a
// conflict (the panel then offers to reload).
import.meta.hot?.on('mc:data-changed', async (d) => {
  if (d?.path !== FILE || !A.doc.value) return;
  try {
    const text = await readText();
    const disk = JSON.parse(text);
    if (JSON.stringify(disk) === JSON.stringify(A.doc.value)) { layout = scanLayout(text); return; } // our own save
    if (isDirty()) { A.conflict.value = true; return; }
    layout = scanLayout(text);
    A.doc.value = disk;
    if (window.__editor) window.__editor.sounds = disk;
    if (!disk.sounds?.[A.sel.value]) A.sel.value = Object.keys(disk.sounds ?? {})[0] ?? null;
    log(`${FILE} rechargé (modifié sur le disque)`);
  } catch { /* ignore */ }
});
