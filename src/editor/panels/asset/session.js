// Asset editor state (module level, survives panel switches) and edit operations: open / commit
// with a local undo history per asset, live push into the running world (AssetLibrary.set +
// re-batched props), staging of assets/<name>.json and assets/index.json, create / duplicate /
// delete, bake a generator into parts, part & collider list operations.
import { signal } from '@preact/signals';
import { buildAsset, resolveParts } from '../../../engine/assets/ModelBuilder.js';
import { Data } from '../../../engine/core/Data.js';
import { S, log } from '../../core.js';
import { formatAsset, roundDeep, TEMPLATES, patchObj, move, newPart } from './shapes.js';

export const A = {
  name: signal(null), // asset being edited
  def: signal(null), // working definition (never mutated: every edit makes a new object)
  sel: signal(null), // { kind: 'part' | 'collider' | 'point', i?, key? }
  tab: signal('asset'), // right column tab: asset | parts | colliders
  view: signal({ wire: false, colliders: true, markers: true, wind: false, turntable: false, quality: 1, variant: 0, gizmo: 'translate', space: 'world' }),
  stats: signal(null),
  err: signal(null),
  lib: signal(0), // bumped when the asset list changes
  thumbs: signal({}), // name -> thumbnail version (bumped after edits)
  hist: signal(0), // bumped when the undo history changes
};

export const setView = (patch) => (A.view.value = { ...A.view.value, ...patch });
const NAME_RE = /^[a-z0-9_]+$/;
const LIVE_DELAY = 140;

let session = null;
export function getSession(ed) {
  if (!session || session.ed !== ed) session = window.__assetSession = new AssetSession(ed);
  return session;
}

export class AssetSession {
  constructor(ed) {
    this.ed = ed;
    this.history = new Map(); // name -> { undo: [def], redo: [def], key, t }
    this.base = new Map(); // name -> file text as on disk (null: not saved yet) — undo back to it unstages
    this.staged = new Map(); // name -> last staged file text
    this.preview = null;
    this._dragN = 0;
    import.meta.hot?.on('mc:data-changed', (d) => this._external(d.path));
  }

  get lib() { return this.ed.world.assets; }
  get names() { return this.lib.names.filter((n) => n !== 'index'); }
  get path() { return `assets/${A.name.value}.json`; }
  isDirty(name) { return !!S.dirty.value[`assets/${name}.json`]; }

  /** Number of static props in the world using an asset. */
  usage(name) { return this.ed.world.entities.list.filter((e) => e.asset === name).length; }

  open(name) {
    if (!name || !this.lib.has(name)) return;
    if (name === A.name.value && A.def.value) return;
    this.flushLive();
    A.name.value = name;
    A.def.value = { ...structuredClone(this.lib.get(name)), name };
    if (!this.base.has(name)) this.base.set(name, this.isDirty(name) ? null : formatAsset(A.def.value));
    A.sel.value = null;
    A.err.value = null;
    A.hist.value++;
  }

  // --- history ---------------------------------------------------------------------------------
  _h(name = A.name.value) {
    let h = this.history.get(name);
    if (!h) this.history.set(name, (h = { undo: [], redo: [], key: null, t: 0 }));
    return h;
  }

  /** Replace the working definition. `key` merges successive edits of the same field (scrubbing). */
  commit(next, { key } = {}) {
    const prev = A.def.value;
    if (!prev || next === prev) return;
    const h = this._h();
    const now = performance.now();
    if (!(key && h.key === key && now - h.t < 1500)) {
      h.undo.push(prev);
      if (h.undo.length > 200) h.undo.shift();
    }
    h.redo = [];
    h.key = key ?? null;
    h.t = now;
    this._apply(next);
  }

  update(fn, key) { if (A.def.value) this.commit(fn(A.def.value), { key }); }

  _apply(def) {
    A.def.value = def;
    A.hist.value++;
    this._clampSel();
    this.scheduleLive();
  }

  get canUndo() { return A.hist.value >= 0 && !!this.history.get(A.name.value)?.undo.length; }
  get canRedo() { return A.hist.value >= 0 && !!this.history.get(A.name.value)?.redo.length; }

  undo() {
    const h = this._h(), prev = h.undo.pop();
    if (!prev) return;
    h.redo.push(A.def.value);
    h.key = null;
    this._apply(prev);
    log(`Asset ${A.name.value} : annuler (${h.undo.length})`);
  }

  redo() {
    const h = this._h(), next = h.redo.pop();
    if (!next) return;
    h.undo.push(A.def.value);
    h.key = null;
    this._apply(next);
    log(`Asset ${A.name.value} : rétablir`);
  }

  _clampSel() {
    const s = A.sel.value, d = A.def.value;
    if (!s || !d) return;
    if (s.kind === 'part' && !(d.parts?.[s.i])) A.sel.value = null;
    if (s.kind === 'collider' && !(Array.isArray(d.collider) && d.collider[s.i])) A.sel.value = null;
    if (s.kind === 'point' && !(s.i === undefined ? d[s.key] : d[s.key]?.[s.i])) A.sel.value = null;
  }

  // --- live push into the world + staging --------------------------------------------------------
  scheduleLive() {
    clearTimeout(this._liveTimer);
    this._liveName = A.name.value;
    this._liveTimer = setTimeout(() => this.pushLive(), LIVE_DELAY);
  }

  flushLive() {
    if (!this._liveTimer) return;
    clearTimeout(this._liveTimer);
    this._liveTimer = null;
    this.pushLive();
  }

  /** Build-check, then push the definition into the AssetLibrary, re-batch props, stage the file. */
  pushLive() {
    this._liveTimer = null;
    const name = this._liveName ?? A.name.value, def = A.def.value;
    if (!def || name !== A.name.value) return;
    try {
      const b = buildAsset(def, { quality: 1, assets: { ...this.lib.defs, [name]: def } });
      b.geometry.dispose();
    } catch (e) {
      A.err.value = e.message;
      return; // keep the last valid version in the world / on disk
    }
    this.lib.set(name, def);
    const ents = this.ed.world.entities;
    const used = new Set(ents.list.filter((e) => e.type === 'prop').map((e) => e.asset));
    const refs = (n) => (this.lib.get(n)?.parts ?? []).some((p) => p.shape === 'ref' && p.asset === name);
    if (used.has(name) || [...used].some(refs)) {
      try { ents._rebuildProps(); } catch (e) { log(`Mise à jour du monde : ${e.message}`, 'error'); }
    }
    this._refreshVegetation(name);
    const path = `assets/${name}.json`, text = formatAsset(def);
    if (this.staged.has(name) && !S.dirty.value[path]) this.base.set(name, this.staged.get(name)); // saved since
    if (text === this.base.get(name)) { this._unstage(path); this.staged.delete(name); }
    else { this.ed.stageFile(path, text); this.staged.set(name, text); }
    clearTimeout(this._thumbTimer);
    this._thumbTimer = setTimeout(() => (A.thumbs.value = { ...A.thumbs.value, [name]: (A.thumbs.value[name] ?? 0) + 1 }), 600);
  }

  _unstage(path) {
    if (this.ed.pendingFiles) delete this.ed.pendingFiles[path];
    if (S.dirty.value[path]) { const d = { ...S.dirty.value }; delete d[path]; S.dirty.value = d; }
  }

  /** Painted vegetation instances using an asset (count), or null if no species uses it. */
  vegetationUsage(name) {
    const veg = this.ed.world.vegetation;
    const ids = new Set();
    (veg?.def?.species ?? []).forEach((sp, i) => { if (sp.asset === name) ids.add(i); });
    if (!ids.size) return null;
    let n = 0;
    const sp = veg.data.species;
    for (let k = 0; k < veg.data.n; k++) if (ids.has(sp[k])) n++;
    return n;
  }

  /** Painted vegetation using this asset: swap the instanced meshes' geometry for the new build. */
  _refreshVegetation(name) {
    const veg = this.ed.world.vegetation;
    const fields = [veg?.fieldNear, veg?.fieldFar ?? veg?.field].filter(Boolean);
    if (!fields.length) return;
    try {
      for (const kind of fields.flatMap((f) => f.kinds)) {
        if (kind.def?.asset !== name) continue;
        kind.variants.forEach((vr, v) => vr.meshes.forEach((mesh, li) => {
          if (v > 0 && li > 0) return; // far LODs share variant 0's mesh
          const b = this.lib.build(name, { quality: kind.lods[li]?.quality ?? 1, variant: v });
          mesh.geometry = b.geometry;
          mesh.userData.tris = b.triangles;
        }));
      }
    } catch (e) { log(`Végétation (${name}) : ${e.message}`, 'warn'); }
  }

  /** Stage assets/index.json = every asset file on disk + the library's names (sorted). */
  async stageIndex(without = []) {
    let files = [];
    try { files = (await Data.list('assets')).filter((f) => f.endsWith('.json') && !f.endsWith('index.json')).map((f) => f.slice(7, -5)); } catch { /* static */ }
    const names = [...new Set([...files, ...this.names])].filter((n) => !without.includes(n)).sort();
    const disk = await Data.json('assets/index.json', { fresh: true }).catch(() => null);
    if (JSON.stringify(disk?.assets ?? null) === JSON.stringify(names)) this._unstage('assets/index.json');
    else this.ed.stageFile('assets/index.json', { assets: names });
  }

  _external(path) {
    if (!path?.startsWith('assets/') || path.endsWith('index.json')) return;
    // core reloads the definition into the library; refresh our list / working copy afterwards
    setTimeout(() => {
      A.lib.value++;
      const name = path.slice(7, -5);
      if (name !== A.name.value || !this.lib.has(name)) return;
      const disk = { ...this.lib.get(name), name };
      if (formatAsset(disk) === formatAsset(A.def.value)) return;
      if (this.isDirty(name)) { log(`${path} modifié à l'extérieur : modifications locales conservées`, 'warn'); return; }
      this.base.set(name, formatAsset(disk));
      this._h(name).undo.push(A.def.value);
      A.def.value = disk;
      A.hist.value++;
      this._clampSel();
      log(`Asset ${name} rechargé (modifié à l'extérieur)`);
    }, 400);
  }

  // --- asset list operations ---------------------------------------------------------------------
  askName(base, question) {
    let def = base;
    for (let i = 2; this.lib.has(def); i++) def = `${base}_${i}`;
    for (;;) {
      const n = prompt(question, def);
      if (n === null) return null;
      const name = n.trim();
      if (!NAME_RE.test(name)) { alert('Nom invalide : lettres minuscules, chiffres et _ uniquement.'); def = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_'); continue; }
      if (this.lib.has(name) || name === 'index') { alert(`L'asset « ${name} » existe déjà.`); def = name; continue; }
      return name;
    }
  }

  _addAsset(name, def, what) {
    this.flushLive();
    const ordered = { name, ...def };
    ordered.name = name;
    this.base.set(name, null); // not on disk yet
    this.staged.set(name, formatAsset(ordered));
    this.lib.set(name, ordered);
    this.ed.stageFile(`assets/${name}.json`, formatAsset(ordered));
    this.stageIndex();
    A.lib.value++;
    A.name.value = null;
    this.open(name);
    log(`${what} : ${name} (à enregistrer)`);
  }

  create(templateId, name) {
    const t = TEMPLATES.find((x) => x.id === templateId) ?? TEMPLATES[0];
    name ??= this.askName(`nouveau_${t.id}`, `Nom du nouvel asset (${t.label}) — minuscules, chiffres, _ :`);
    if (!name) return;
    this._addAsset(name, t.make(), 'Asset créé');
    if (t.id === 'empty') A.tab.value = 'parts';
  }

  duplicate(name) {
    const src = A.def.value;
    if (!src) return;
    name ??= this.askName(`${A.name.value}_copie`, `Dupliquer « ${A.name.value} » sous le nom :`);
    if (!name) return;
    const def = structuredClone(src);
    if (def.label) def.label += ' (copie)';
    this._addAsset(name, def, 'Asset dupliqué');
  }

  async remove(name = A.name.value, { confirmed = false } = {}) {
    if (!name) return;
    const uses = this.usage(name);
    if (!confirmed && !confirm(`Supprimer définitivement l'asset « ${name} » ?${uses ? `\n\n⚠ ${uses} objet(s) placé(s) dans le monde l'utilisent et disparaîtront.` : ''}\n\n(une copie est gardée dans .mc-backup/)`)) return;
    clearTimeout(this._liveTimer);
    this._liveTimer = null;
    const path = `assets/${name}.json`;
    try {
      const r = await fetch(`/api/delete?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) { log(`Suppression de ${path} impossible : ${e.message}`, 'error'); return; }
    // drop a staged (unsaved) version so "Enregistrer" doesn't recreate the file
    this._unstage(path);
    this.base.delete(name);
    this.staged.delete(name);
    // remove from the library (and its cached builds)
    const lib = this.lib;
    delete lib.defs[name];
    for (const k of [...lib.cache.keys()]) if (k.split('|')[0] === name) { lib.cache.get(k).geometry.dispose(); lib.cache.delete(k); }
    lib.version++;
    if (uses) { try { this.ed.world.entities._rebuildProps(); } catch (e) { log(e.message, 'error'); } }
    // index.json: rewrite it now if it lists the asset, and fix a staged version
    try {
      const idx = await Data.json('assets/index.json', { fresh: true }).catch(() => null);
      if (idx?.assets?.includes(name)) await Data.save('assets/index.json', { ...idx, assets: idx.assets.filter((n) => n !== name) });
    } catch (e) { log(`assets/index.json : ${e.message}`, 'warn'); }
    if (this.ed.pendingFiles?.['assets/index.json']) await this.stageIndex([name]);
    this.history.delete(name);
    A.lib.value++;
    if (A.name.value === name) { A.name.value = null; A.def.value = null; A.sel.value = null; this.open(this.names[0]); }
    log(`Asset ${name} supprimé`);
  }

  placeInWorld() {
    const name = A.name.value;
    if (!name) return;
    this.flushLive();
    S.panel.value = 'world';
    this.ed.startPlace({ type: 'prop', asset: name });
  }

  // --- generator ---------------------------------------------------------------------------------
  /** Generator -> explicit parts (variant = the preview's), keeping the generator's colliders. */
  bake() {
    const def = A.def.value;
    if (!def?.generator) return;
    const seed = A.view.value.variant + 1;
    const assets = { ...this.lib.defs, [def.name]: def };
    const parts = roundDeep(resolveParts(def, assets, seed, 1), 4);
    const next = { ...def, parts };
    delete next.generator;
    if (def.collider === undefined) {
      const b = buildAsset(def, { quality: 1, seed, assets });
      b.geometry.dispose();
      next.collider = b.colliders.length ? roundDeep(b.colliders, 3) : 'none';
    }
    this.commit(next);
    A.tab.value = 'parts';
    log(`Générateur cuit : ${parts.length} pièces (variante ${A.view.value.variant})`);
  }

  // --- parts -------------------------------------------------------------------------------------
  setPart(i, part, key) { this.update((d) => ({ ...d, parts: d.parts.map((p, j) => (j === i ? part : p)) }), key); }
  patchPart(i, patch, key) { const p = A.def.value?.parts?.[i]; if (p) this.setPart(i, patchObj(p, patch), key); }

  addPart(shape) {
    const d = A.def.value;
    if (!d) return;
    const s = A.sel.value;
    const from = s?.kind === 'part' ? d.parts[s.i] : d.parts?.[d.parts.length - 1];
    const p = newPart(shape, from);
    if (shape === 'ref') p.asset = this.names.find((n) => n !== d.name) ?? '';
    const parts = [...(d.parts ?? [])];
    const at = s?.kind === 'part' ? s.i + 1 : parts.length;
    parts.splice(at, 0, p);
    this.commit({ ...d, parts });
    A.sel.value = { kind: 'part', i: at };
  }

  duplicatePart(i) {
    const d = A.def.value, p = d?.parts?.[i];
    if (!p) return;
    const c = structuredClone(p);
    if (c.pos) c.pos = [c.pos[0] + 0.25, c.pos[1], c.pos[2]];
    else if (c.shape !== 'limb' && c.shape !== 'frond' && c.shape !== 'tris') c.pos = [0.25, 0, 0];
    const parts = [...d.parts];
    parts.splice(i + 1, 0, c);
    this.commit({ ...d, parts });
    A.sel.value = { kind: 'part', i: i + 1 };
  }

  deletePart(i) {
    const d = A.def.value;
    if (!d?.parts?.[i]) return;
    this.commit({ ...d, parts: d.parts.filter((_, j) => j !== i) });
    A.sel.value = d.parts.length > 1 ? { kind: 'part', i: Math.min(i, d.parts.length - 2) } : null;
  }

  movePart(i, delta) {
    const d = A.def.value, j = i + delta;
    if (!d?.parts || j < 0 || j >= d.parts.length) return;
    this.commit({ ...d, parts: move(d.parts, i, j) });
    A.sel.value = { kind: 'part', i: j };
  }

  // --- colliders ---------------------------------------------------------------------------------
  setCollider(i, c, key) { this.update((d) => ({ ...d, collider: d.collider.map((x, j) => (j === i ? c : x)) }), key); }

  addCollider(c) {
    const d = A.def.value;
    const list = Array.isArray(d.collider) ? [...d.collider] : [];
    list.push(c);
    this.commit({ ...d, collider: list });
    A.sel.value = { kind: 'collider', i: list.length - 1 };
  }

  duplicateCollider(i) {
    const d = A.def.value;
    if (!Array.isArray(d?.collider) || !d.collider[i]) return;
    const c = structuredClone(d.collider[i]);
    const p = c.pos ?? [0, 0, 0];
    c.pos = [p[0] + 0.25, p[1], p[2]];
    const list = [...d.collider];
    list.splice(i + 1, 0, c);
    this.commit({ ...d, collider: list });
    A.sel.value = { kind: 'collider', i: i + 1 };
  }

  deleteCollider(i) {
    const d = A.def.value;
    if (!Array.isArray(d?.collider)) return;
    this.commit({ ...d, collider: d.collider.filter((_, j) => j !== i) });
    A.sel.value = d.collider.length > 1 ? { kind: 'collider', i: Math.min(i, d.collider.length - 2) } : null;
  }

  // --- selection shortcuts -------------------------------------------------------------------------
  deleteSelection() {
    const s = A.sel.value;
    if (s?.kind === 'part') this.deletePart(s.i);
    else if (s?.kind === 'collider') this.deleteCollider(s.i);
  }

  duplicateSelection() {
    const s = A.sel.value;
    if (s?.kind === 'part') this.duplicatePart(s.i);
    else if (s?.kind === 'collider') this.duplicateCollider(s.i);
  }

  /** Gizmo edit of the selection: patch = { pos?, rot?, scale?, size?, radius?, height? }. */
  applyGizmo(sel, patch, dragId) {
    const key = 'gizmo:' + dragId;
    if (sel.kind === 'part') this.patchPart(sel.i, patch, key);
    else if (sel.kind === 'collider') {
      const c = A.def.value?.collider?.[sel.i];
      if (c) this.setCollider(sel.i, patchObj(c, patch), key);
    } else if (sel.kind === 'point') {
      this.update((d) => {
        if (sel.i === undefined) return { ...d, [sel.key]: patch.pos };
        return { ...d, [sel.key]: d[sel.key].map((p, j) => (j === sel.i ? patch.pos : p)) };
      }, key);
    }
  }
  newDragId() { return ++this._dragN; }
}
