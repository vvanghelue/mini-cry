// Audio panel: sound designer for the procedural recipes of public/data/sounds.json (see
// docs/AUDIO.md). Left: the sound list. Main: the recipe (sound settings + layer stack), a
// waveform / envelope of the rendered result (re-rendered in a worker on every edit), playback
// through an AudioSystem, .wav export, and a music / ambience tuning + live test view.
// Edits are undoable (Ctrl+Z) and staged for ed.saveAll() (the file keeps its compact layout).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { analyze, encodeWAV, variationCount } from '../../engine/audio/synth.js';
import { S, log } from '../core.js';
import { A, FILE, load, setDoc, setRecipe, insertAfter, renameKey, validName, uniqueName } from './audio/store.js';
import { TEMPLATES, GROUPINGS, CAT_ORDER, BUSES } from './audio/templates.js';
import { renderAsync, disposeRenderer, layerTimeline } from './audio/render.js';
import { playRecipe, playSamples, playRandom, stopPreview, playing, playheadTime, disposePlayers, test, tickTest, stopTest } from './audio/player.js';
import { editKey, setKey, CodeJson } from './audio/fields.jsx';
import { formatRecipe } from './audio/format.js';
import { Waveform } from './audio/Waveform.jsx';
import { SoundForm } from './audio/SoundForm.jsx';
import { LayerStack, LayerForm } from './audio/LayerEditor.jsx';
import { MixView } from './audio/MixView.jsx';

export function AudioPanel({ ed }) {
  const root = useRef(null);
  const actions = useRef({});
  useEffect(() => {
    load(ed);
    root.current?.focus({ preventScroll: true });
    // the panel covers the 3D view: pause its rendering (frees the CPU for the audio renders)
    const eng = ed.engine, paused = !!eng?.running;
    if (paused) { eng.stop(); S.perf.value = null; } // (the status bar would show a frozen fps)
    // music / ambience test: AudioSystem.update() every frame while the panel is open
    let raf = 0, last = performance.now();
    const frame = (t) => {
      const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
      last = t;
      if (test.sys && A.doc.value) tickTest(dt, ed.engine?.camera, A.doc.value);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); disposePlayers(); disposeRenderer(); if (paused && !eng.running) eng.start(); };
  }, []);

  const onKey = (e) => {
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable]')) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') { // duplicate the sound, not the world selection
      e.preventDefault(); e.stopPropagation();
      if (A.view.value === 'sound') actions.current.duplicate?.();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+Z / Ctrl+S... go to the editor
    e.stopPropagation(); // world shortcuts (Suppr, F, W, G...) must not act from the audio panel
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) actions.current.toggle?.(); }
    else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') { e.preventDefault(); actions.current.step?.(e.code === 'ArrowDown' ? 1 : -1); }
    else if (e.code === 'Escape') stopPreview();
  };
  const onKeyUp = (e) => { if (e.code === 'Space' && !e.target.closest?.('input, textarea, select')) e.preventDefault(); };

  const status = A.status.value;
  const doc = A.doc.value;
  return (
    <div class="panel au" ref={root} tabIndex={0} onKeyDown={onKey} onKeyUp={onKeyUp}>
      {!doc
        ? <div class="au-main"><p class={status === 'error' ? 'err' : 'hint'}>{status === 'error' ? `Impossible de lire ${FILE} : ${A.error.value}` : 'Chargement des sons…'}</p></div>
        : <>
          <Sidebar ed={ed} actions={actions} />
          {A.view.value === 'mix' ? <MixView ed={ed} actions={actions} /> : A.sel.value && doc.sounds[A.sel.value] ? <SoundView ed={ed} actions={actions} /> : <div class="au-main"><p class="hint">Aucun son sélectionné.</p></div>}
        </>}
    </div>
  );
}

// ------------------------------------------------------------------ sound list

function select(name) {
  if (name === A.sel.value) return;
  A.sel.value = name;
  A.layer.value = 0;
  A.variation.value = 0;
  A.view.value = 'sound';
}

function Sidebar({ ed, actions }) {
  const doc = A.doc.value, sounds = doc.sounds;
  const [menu, setMenu] = useState(false);
  const q = A.search.value.trim().toLowerCase();
  const G = GROUPINGS[A.group.value] ?? GROUPINGS.cat;
  const names = Object.keys(sounds).filter((n) => !q || n.toLowerCase().includes(q) || (sounds[n]?.bus ?? 'sfx').includes(q));
  const groups = new Map();
  for (const n of names) {
    const g = G.key(n, sounds[n]);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  }
  let keys = [...groups.keys()];
  if (A.group.value === 'cat') keys.sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b));
  if (A.group.value === 'bus') keys.sort((a, b) => BUSES.indexOf(a) - BUSES.indexOf(b));
  const collapsed = A.collapsed.value;
  const flat = keys.flatMap((k) => (collapsed[k] && !q ? [] : groups.get(k)));
  actions.current.step = (d) => {
    const i = flat.indexOf(A.sel.value);
    const n = flat[Math.max(0, Math.min(flat.length - 1, i < 0 ? 0 : i + d))];
    if (n) select(n);
  };
  const sel = A.sel.value;
  // keep the selected sound visible in the list (keyboard navigation, new / renamed sounds)
  useEffect(() => {
    if (sel) document.querySelector(`.au-list [data-name="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const askName = (msg, def) => {
    const n = prompt(msg, def)?.trim();
    if (!n) return null;
    if (!validName(n)) { alert('Nom invalide : lettres, chiffres et _ uniquement.'); return null; }
    if (sounds[n]) { alert(`Le son « ${n} » existe déjà.`); return null; }
    return n;
  };
  const create = (tpl) => {
    setMenu(false);
    const n = askName('Nom du nouveau son :', uniqueName(tpl === 'empty' ? 'new_sound' : tpl, sounds));
    if (!n) return;
    setDoc(ed, { ...doc, sounds: insertAfter(sounds, sel, n, structuredClone(TEMPLATES[tpl].recipe)) }, `Nouveau son ${n}`);
    select(n);
    log(`Son ${n} créé (modèle : ${TEMPLATES[tpl].label})`);
  };
  const duplicate = () => {
    if (!sel) return;
    const n = askName('Nom de la copie :', uniqueName(`${sel}_2`, sounds));
    if (!n) return;
    setDoc(ed, { ...doc, sounds: insertAfter(sounds, sel, n, structuredClone(sounds[sel])) }, `Dupliquer ${sel}`);
    select(n);
  };
  actions.current.duplicate = duplicate;
  const rename = () => {
    if (!sel) return;
    const n = askName(`Renommer « ${sel} » en :\n(les références dans le code du jeu, les armes ou les missions ne sont pas mises à jour)`, sel);
    if (!n || n === sel) return;
    let next = { ...doc, sounds: renameKey(sounds, sel, n) };
    const am = doc.ambient?.sounds;
    if (am && Object.values(am).includes(sel)) {
      next = { ...next, ambient: { ...doc.ambient, sounds: Object.fromEntries(Object.entries(am).map(([k, v]) => [k, v === sel ? n : v])) } };
    }
    setDoc(ed, next, `Renommer ${sel}`);
    A.sel.value = n;
    if (/^music_|^(ocean_waves|wind|cicadas|frogs|crickets|underwater|bird_chirp|parrot_call|gull_call|owl_hoot)$/.test(sel)) log(`« ${sel} » est utilisé par la musique / l'ambiance par son nom : vérifiez les références`, 'warn');
    else log(`Son renommé : ${sel} → ${n} (pensez aux références dans le jeu)`, 'warn');
  };
  const remove = () => {
    if (!sel || !confirm(`Supprimer le son « ${sel} » ?`)) return;
    const i = flat.indexOf(sel);
    const s = { ...sounds };
    delete s[sel];
    setDoc(ed, { ...doc, sounds: s }, `Supprimer ${sel}`);
    const rest = flat.filter((x) => x !== sel);
    A.sel.value = rest[Math.min(Math.max(0, i), rest.length - 1)] ?? Object.keys(s)[0] ?? null;
    A.layer.value = 0;
  };

  return (
    <div class="au-side">
      <div class="au-tabs">
        <button class={A.view.value === 'sound' ? 'on' : ''} onClick={() => (A.view.value = 'sound')}>🔊 Sons <small>{Object.keys(sounds).length}</small></button>
        <button class={A.view.value === 'mix' ? 'on' : ''} onClick={() => (A.view.value = 'mix')}>🎵 Musique & ambiance</button>
      </div>
      <div class="au-filter-bar">
        <input type="text" class="au-search" placeholder="Rechercher…" value={A.search.value} onInput={(e) => (A.search.value = e.target.value)} />
        <select value={A.group.value} title="Regrouper par" onChange={(e) => (A.group.value = e.target.value)}>
          {Object.entries(GROUPINGS).map(([k, g]) => <option value={k}>{g.label}</option>)}
        </select>
      </div>
      <div class="au-list">
        {keys.map((k) => {
          const open = !collapsed[k] || !!q;
          return (
            <div class="au-group">
              {k && <div class="au-gh" onClick={() => (A.collapsed.value = { ...collapsed, [k]: !collapsed[k] })}>{open ? '▾' : '▸'} {k}<small>{groups.get(k).length}</small></div>}
              {open && groups.get(k).map((n) => {
                const r = sounds[n] ?? {};
                return (
                  <div class={'au-it' + (n === sel ? ' sel' : '')} data-name={n} onClick={() => select(n)} onDblClick={rename} title={`${n} · bus ${r.bus ?? 'sfx'}${r.loop ? ' · boucle' : ''} · ${(r.layers ?? []).length} couche(s)`}>
                    <span class="au-nm">{n}</span>
                    {r.loop && <span class="au-badge loop">↻</span>}
                    <span class={'au-badge b-' + (r.bus ?? 'sfx')}>{r.bus ?? 'sfx'}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {!names.length && <p class="hint" style={{ padding: '6px 8px' }}>Aucun son ne correspond.</p>}
      </div>
      <div class="au-actions">
        <div class="au-menuwrap">
          <button onClick={() => setMenu(!menu)} title="Nouveau son à partir d'un modèle">+ Nouveau ▾</button>
          {menu && (
            <div class="au-menu" onMouseLeave={() => setMenu(false)}>
              {Object.entries(TEMPLATES).map(([k, t]) => <button onClick={() => create(k)}>{t.label}</button>)}
            </div>
          )}
        </div>
        <button onClick={duplicate} disabled={!sel} title="Dupliquer le son sélectionné (Ctrl+D)">⧉ Dupliquer</button>
        <button onClick={rename} disabled={!sel} title="Renommer (double-clic dans la liste)">✎ Renommer</button>
        <button class="danger" onClick={remove} disabled={!sel} title="Supprimer le son">✕</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ rendering hook

function pump(s, setRes) {
  const job = s.next;
  if (!job || s.busy) return;
  s.next = null;
  s.busy = true;
  renderAsync(job.recipe, job.seed).then(
    ({ samples, ms }) => {
      if (s.alive && job.gen > s.shown) { s.shown = job.gen; setRes({ samples, ms, stats: analyze(samples), err: null, recipe: job.recipe, seed: job.seed, name: job.name }); }
    },
    (e) => {
      if (s.alive && job.gen > s.shown) {
        s.shown = job.gen;
        setRes((r) => ({ ...(r.name === job.name ? r : { samples: null, stats: null, ms: 0 }), err: e.message ?? String(e), recipe: job.recipe, name: job.name, seed: job.seed }));
      }
    },
  ).finally(() => { s.busy = false; if (s.next) pump(s, setRes); });
}

/** Render the recipe variation in the worker: throttled (latest edit wins), never blocks the UI. */
function useRendered(name, recipe, variation) {
  const [res, setRes] = useState({ samples: null, ms: 0, stats: null, err: null });
  const st = useRef({ busy: false, next: null, gen: 0, shown: 0, alive: true, timer: 0 });
  const key = JSON.stringify(recipe) + '#' + variation;
  useEffect(() => () => { st.current.alive = false; clearTimeout(st.current.timer); }, []);
  useEffect(() => {
    const s = st.current;
    s.next = { recipe, seed: variation + 1, gen: ++s.gen, name };
    if (!s.busy && !s.timer) s.timer = setTimeout(() => { s.timer = 0; pump(s, setRes); }, 40);
  }, [key, name]);
  return res;
}

// ------------------------------------------------------------------ sound view

const db = (x) => (x > 1e-6 ? `${(20 * Math.log10(x)).toFixed(1)} dB` : '-∞');

function SoundView({ ed, actions }) {
  const doc = A.doc.value, name = A.sel.value, r = doc.sounds[name];
  const layers = Array.isArray(r.layers) ? r.layers : [];
  const soloSt = A.solo.value;
  const solo = soloSt?.sound === name && soloSt.layer < layers.length ? soloSt.layer : null;
  const eff = useMemo(() => (solo == null ? r : { ...r, layers: layers.map((L, i) => (i === solo ? setKey(L, 'mute', undefined) : { ...L, mute: true })) }), [r, solo]);
  const nVar = variationCount(r);
  const variation = Math.min(A.variation.value, nVar - 1);
  const res = useRendered(name, eff, variation);
  const tl = useMemo(() => layerTimeline(eff), [eff]);
  const li = Math.min(A.layer.value, Math.max(0, layers.length - 1));
  const p = playing.value;
  const isPlaying = !!p && p.name === name;
  const dirty = !!S.dirty.value[FILE];

  const set = (nr, label) => setRecipe(ed, name, nr, label, editKey());
  const setLayers = (a, label) => setRecipe(ed, name, { ...r, layers: a }, label ?? `Couches de ${name}`);

  const play = () => {
    if (variation === 0 || !res.samples || res.name !== name) playRecipe(doc, name, eff, { loop: !!r.loop && A.loopPreview.value, dur: tl.dry });
    else playSamples(doc, name, eff, res.samples, variation, { loop: !!r.loop && A.loopPreview.value });
  };
  const toggle = () => { if (isPlaying && p.loop) stopPreview(); else play(); };
  actions.current.toggle = toggle;
  const toggleRef = useRef(null);
  toggleRef.current = toggle;
  useEffect(() => () => { if (actions.current.toggle === toggleRef.current) actions.current.toggle = null; }, []);

  const random = () => {
    const d = solo == null ? doc : { ...doc, sounds: { ...doc.sounds, [name]: eff } };
    playRandom(d, name, (v) => { if (v >= 0 && v < nVar && A.sel.value === name) A.variation.value = v; });
  };
  const download = () => {
    if (!res.samples) return;
    const blob = new Blob([encodeWAV(res.samples)], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}${nVar > 1 ? `_v${variation + 1}` : ''}${solo != null ? `_couche${solo + 1}` : ''}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    log(`${a.download} exporté (${(res.samples.length / 44100).toFixed(2)} s)`);
  };

  // stop a preview of another sound when the selection changes
  useEffect(() => { if (playing.value && playing.value.name !== name) stopPreview(); }, [name]);
  // after an edit (once the edits pause): replay a running loop preview with the new recipe, or
  // auto-play one-shots
  const prev = useRef(null), replay = useRef(0);
  const playRef = useRef(play);
  playRef.current = play;
  useEffect(() => {
    const before = prev.current;
    prev.current = res;
    if (!before || !res.samples || res.err || before.name !== res.name || before.seed !== res.seed || before.recipe === res.recipe) return;
    const cur = playing.value;
    if (!((cur?.loop && cur.name === name) || (A.autoPlay.value && !r.loop))) return;
    clearTimeout(replay.current);
    replay.current = setTimeout(() => playRef.current(), 180);
  }, [res]);
  useEffect(() => () => clearTimeout(replay.current), []);

  const st = res.stats;
  const warn = st && (st.nonFinite ? `${st.nonFinite} échantillons NaN !` : st.peak < 0.01 ? 'silencieux' : null);
  return (
    <div class="au-main">
      {A.conflict.value && (
        <div class="au-conflict">{FILE} a été modifié sur le disque pendant l'édition.
          <button onClick={() => load(ed, { force: true })}>Recharger (perdre mes modifications)</button>
          <button onClick={() => (A.conflict.value = false)}>Garder ma version</button>
        </div>
      )}
      <div class="au-head">
        <h3 title="Double-clic dans la liste pour renommer">{name}</h3>
        <span class={'au-badge b-' + (r.bus ?? 'sfx')}>{r.bus ?? 'sfx'}</span>
        {r.loop && <span class="au-badge loop">↻ boucle</span>}
        <span class="au-sep" />
        <button class={'au-play' + (isPlaying ? ' on' : '')} onClick={toggle} title="Lire (Espace)">{isPlaying && p.loop ? '⏹ Stop' : '▶ Lire'}</button>
        <button onClick={stopPreview} disabled={!isPlaying} title="Arrêter (Échap)">⏹</button>
        {nVar > 1 && <button onClick={random} title="Joue une variation au hasard, avec la hauteur et le gain aléatoires, comme en jeu">🎲 Variation aléatoire</button>}
        {r.loop && <label class="tg"><input type="checkbox" checked={A.loopPreview.value} onChange={(e) => (A.loopPreview.value = e.target.checked)} /> en boucle</label>}
        {!r.loop && <label class="tg" title="Rejoue le son après chaque modification"><input type="checkbox" checked={A.autoPlay.value} onChange={(e) => (A.autoPlay.value = e.target.checked)} /> lecture auto</label>}
        <span class="grow" />
        {test.on.value && <button class="on" title="Le test musique & ambiance tourne (onglet Musique & ambiance)" onClick={stopTest}>🎧 test ⏹</button>}
        <button class={A.json.value ? 'on' : ''} onClick={() => (A.json.value = !A.json.value)} title="Éditer la recette en JSON brut">{'{ }'} JSON brut</button>
        <button onClick={download} disabled={!res.samples} title="Exporte la variation affichée en WAV 16 bits mono 44,1 kHz">⬇ Télécharger .wav</button>
        <button class={'au-save' + (dirty ? ' dirty' : '')} onClick={() => ed.saveAll()} title={dirty ? `${FILE} modifié : enregistrer (Ctrl+S)` : 'Tout est enregistré'}>💾 Enregistrer{dirty ? ' •' : ''}</button>
      </div>
      <div class="au-wavebox">
        <Waveform key={name} samples={res.name === name ? res.samples : null} timeline={tl} sel={li} onSelect={(i) => (A.layer.value = i)} loop={!!r.loop} playhead={playheadTime} />
        <div class="au-stats-row">
          {nVar > 1 && (
            <span class="au-vars">variation
              {Array.from({ length: nVar }, (_, i) => <button class={'au-mini' + (i === variation ? ' on' : '')} onClick={() => (A.variation.value = i)} title={`Afficher / lire la variation ${i + 1} (graine ${i + 1})`}>{i + 1}</button>)}
            </span>
          )}
          {st && res.name === name && <>
            <span><small>durée</small> {st.seconds.toFixed(3)} s</span>
            <span><small>sèche</small> {tl.dry.toFixed(3)} s</span>
            <span><small>crête</small> {st.peak.toFixed(3)} ({db(st.peak)})</span>
            <span><small>RMS</small> {st.rms.toFixed(3)} ({db(st.rms)})</span>
            <span><small>rendu</small> {res.ms.toFixed(0)} ms</span>
          </>}
          {solo != null && <span class="au-solo">solo : couche {solo + 1} <button class="au-mini" onClick={() => (A.solo.value = null)}>×</button></span>}
          {warn && <span class="err">⚠ {warn}</span>}
          {res.err && <span class="err" title={res.err}>⚠ {res.err}</span>}
          <span class="grow" />
          <span class="hint au-keys">Espace : lire · ↑↓ : son suivant · Échap : stop · molette : zoom</span>
        </div>
      </div>
      {A.json.value
        ? (
          <div class="au-body au-json">
            <p class="hint">Recette complète en JSON, une couche par ligne (format : docs/AUDIO.md). Appliquée quand le champ perd le focus ou avec Ctrl+Entrée, si le JSON est valide.</p>
            <CodeJson value={r} rows={26} format={(v) => formatRecipe(v, 0)} onChange={(v) => { if (v && typeof v === 'object' && !Array.isArray(v)) set(v, `JSON de ${name}`); else log('La recette doit être un objet JSON', 'warn'); }} />
          </div>
        )
        : (
          <div class="au-body">
            <div class="au-col au-scol"><SoundForm r={r} onChange={set} dry={tl.dry} /></div>
            <div class="au-col au-lcol">
              <h4>Couches <small>({layers.length})</small></h4>
              <LayerStack layers={layers} sel={li} onSelect={(i) => (A.layer.value = i)} onChange={(a) => setLayers(a)}
                solo={solo} onSolo={(i) => (A.solo.value = i == null ? null : { sound: name, layer: i })} />
              {layers[li] !== undefined && (
                <LayerForm key={`${name}#${li}`} L={layers[li]} lenHint={tl.rows[li] ? tl.rows[li].spans[0][1] - tl.rows[li].spans[0][0] : undefined}
                  onChange={(nl) => { const a = [...layers]; a[li] = nl; setRecipe(ed, name, { ...r, layers: a }, `Couche ${li + 1} de ${name}`, editKey()); }} />
              )}
            </div>
          </div>
        )}
    </div>
  );
}

