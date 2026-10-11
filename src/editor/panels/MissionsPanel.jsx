// Missions editor (public/data/game/missions.json, format in docs/MISSIONS.md): missions list,
// global triggers and script variables on the left; the selected mission (or trigger) in the
// middle; the selected objective on the right. References use dropdowns filled from the world
// and the data files (free text allowed), problems are listed live, every edit is staged for the
// top bar's Enregistrer button and undoable with Ctrl+Z.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { S, log } from '../core.js';
import { Row, JsonField } from '../ui/Fields.jsx';
import { missions as MD, dialogue as DD, gameData, loadGameData, sel } from './missions/store.js';
import { OBJECTIVE_TYPES, OBJ_INFO, OBJ_COMMON, EVENTS, WHEN_KINDS, whenKind, buildRefs, validate, uniqueId, renameRefs } from './missions/schema.js';
import { RefCtx, Datalists, Txt, Area, ParamField, ActionList, CondList, OptCond, ValueField, PosField, moveItem } from './missions/widgets.jsx';

const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

export function MissionsPanel({ ed }) {
  useEffect(() => { loadGameData(ed); MD.load(); DD.load(); }, []);
  const doc = MD.doc.value;
  const ddoc = DD.doc.value;
  const gd = gameData.value;
  const ver = S.version.value; // world entities changed
  const R = useMemo(() => buildRefs({ ed, mdoc: doc, ddoc, ...(gd ?? {}) }), [doc, ddoc, gd, ver]);
  const issues = useMemo(() => validate(doc, R), [doc, R]);

  if (MD.status.value === 'error') {
    return (
      <div class="panel"><div class="main">
        <h2>🎯 Missions</h2>
        <p class="err">{MD.file} : {MD.error.value}</p>
        <p class="hint">Le fichier n'a pas été modifié. Corrigez-le (ou attendez la fin de son écriture), puis rechargez.</p>
        <button onClick={() => MD.load({ force: true })}>Recharger</button>
      </div></div>
    );
  }
  if (!doc) return <div class="panel"><p class="hint">Chargement des missions…</p></div>;

  const update = (next, label, key) => MD.set(ed, next, label, key);
  const list = doc.missions;
  const trigs = doc.triggers;
  let s = sel.value;
  if (s.kind === 'trigger' && !trigs[s.i]) s = { kind: 'mission', i: 0, obj: null };
  if (s.kind === 'mission' && !list[s.i]) s = { kind: 'mission', i: Math.max(0, list.length - 1), obj: null };
  const go = (n) => (sel.value = { obj: null, ...n });
  const m = s.kind === 'mission' ? list[s.i] : null;
  const t = s.kind === 'trigger' ? trigs[s.i] : null;
  const setMission = (i, nm, label = 'Modifier la mission', key) => { const ms = [...list]; ms[i] = nm; update({ ...doc, missions: ms }, label, key); };
  const setTrigger = (i, nt, label = 'Modifier le déclencheur', key) => { const ts = [...trigs]; ts[i] = nt; update({ ...doc, triggers: ts }, label, key); };
  const mIssues = (i) => issues.filter((x) => x.m === i && x.level === 'warn').length;
  const tIssues = (i) => issues.filter((x) => x.t === i && x.level === 'warn').length;

  // --- list commands ---
  const addMission = () => {
    const id = uniqueId(`m${String(list.length + 1).padStart(2, '0')}`, list.map((x) => x.id));
    const nm = { id, title: 'Nouvelle mission', type: 'main', description: '', objectives: [{ id: 'o1', type: 'goto', text: 'Rejoindre le point de rendez-vous', radius: 6 }] };
    update({ ...doc, missions: [...list, nm], start: doc.start ?? (list.length ? doc.start : id) }, 'Ajouter une mission');
    go({ kind: 'mission', i: list.length, obj: 0 });
  };
  const dupMission = () => {
    if (!m) return;
    const c = structuredClone(m);
    c.id = uniqueId(m.id + '_copie', list.map((x) => x.id));
    c.title = (m.title ?? '') + ' (copie)';
    const ms = [...list.slice(0, s.i + 1), c, ...list.slice(s.i + 1)];
    update({ ...doc, missions: ms }, 'Dupliquer la mission');
    go({ kind: 'mission', i: s.i + 1 });
  };
  const delMission = () => {
    if (!m || !confirm(`Supprimer la mission « ${m.title || m.id} » ?`)) return;
    update({ ...doc, missions: list.filter((_, j) => j !== s.i), start: doc.start === m.id ? null : doc.start }, 'Supprimer la mission');
    go({ kind: 'mission', i: Math.max(0, s.i - 1) });
  };
  const moveMission = (d) => {
    if (!m || !list[s.i + d]) return;
    update({ ...doc, missions: moveItem(list, s.i, d) }, 'Déplacer la mission');
    go({ kind: 'mission', i: s.i + d, obj: s.obj });
  };
  const setStart = () => m && update({ ...doc, start: doc.start === m.id ? null : m.id }, 'Mission de départ');
  const addTrigger = () => {
    const nt = { id: uniqueId('t_declencheur', trigs.map((x) => x.id)), when: { enterZone: '' }, once: true, do: [] };
    update({ ...doc, triggers: [...trigs, nt] }, 'Ajouter un déclencheur');
    go({ kind: 'trigger', i: trigs.length });
  };
  const dupTrigger = () => {
    if (!t) return;
    const c = structuredClone(t);
    c.id = uniqueId((t.id ?? 't') + '_copie', trigs.map((x) => x.id));
    update({ ...doc, triggers: [...trigs.slice(0, s.i + 1), c, ...trigs.slice(s.i + 1)] }, 'Dupliquer le déclencheur');
    go({ kind: 'trigger', i: s.i + 1 });
  };
  const delTrigger = () => {
    if (!t || !confirm(`Supprimer le déclencheur « ${t.id ?? s.i + 1} » ?`)) return;
    update({ ...doc, triggers: trigs.filter((_, j) => j !== s.i) }, 'Supprimer le déclencheur');
    if (trigs.length > 1) go({ kind: 'trigger', i: Math.max(0, s.i - 1) }); else go({ kind: 'mission', i: 0 });
  };
  const moveTrigger = (d) => {
    if (!t || !trigs[s.i + d]) return;
    update({ ...doc, triggers: moveItem(trigs, s.i, d) }, 'Déplacer le déclencheur');
    go({ kind: 'trigger', i: s.i + d });
  };
  const renameMission = (i, to) => {
    const from = list[i].id;
    if (!to || to === from) return;
    if (list.some((x, j) => j !== i && x.id === to)) { log(`L'id de mission « ${to} » existe déjà`, 'warn'); return; }
    const ms = [...list];
    ms[i] = { ...ms[i], id: to };
    const r = from ? renameRefs({ ...doc, missions: ms }, 'mission', from, to) : { doc: { ...doc, missions: ms }, n: 0 };
    update(r.doc, 'Renommer la mission');
    if (r.n) log(`Mission ${from} → ${to} : ${plural(r.n, 'référence')} mise${r.n > 1 ? 's' : ''} à jour`);
  };
  const renameObjective = (mi, oi, to) => {
    const mm = list[mi];
    const from = mm.objectives[oi].id;
    if (to === from) return;
    if (to && mm.objectives.some((x, j) => j !== oi && x.id === to)) { log(`L'objectif « ${to} » existe déjà dans ${mm.id}`, 'warn'); return; }
    const objs = [...mm.objectives];
    objs[oi] = { ...objs[oi], id: to };
    if (!to) delete objs[oi].id;
    const ms = [...list];
    ms[mi] = { ...mm, objectives: objs };
    const r = from && to ? renameRefs({ ...doc, missions: ms }, 'objective', from, to, mm.id) : { doc: { ...doc, missions: ms }, n: 0 };
    update(r.doc, 'Renommer l\'objectif');
    if (r.n) log(`Objectif ${from} → ${to} : ${plural(r.n, 'référence')} mise${r.n > 1 ? 's' : ''} à jour`);
  };

  const dirty = !!S.dirty.value[MD.file];
  const warnCount = issues.filter((x) => x.level === 'warn').length;
  return (
    <RefCtx.Provider value={R}>
      <div class="panel mpanel">
        <Datalists R={R} />
        <div class="side mside">
          <div class="mtitle">
            <h2>🎯 Missions</h2>
            <span class="grow" />
            <button class={'mini' + (dirty ? ' dirty' : '')} title="Enregistrer tous les fichiers modifiés (Ctrl+S)" onClick={() => ed.saveAll()}>💾 Enregistrer</button>
          </div>
          <p class="hint file">
            {MD.file}{MD.status.value === 'missing' && !dirty ? ' — absent, sera créé au premier enregistrement' : ''}{dirty ? ' — modifié, non enregistré' : ''}
          </p>
          <div class="list mlist">
            {list.map((x, i) => (
              <div class={'it' + (s.kind === 'mission' && s.i === i ? ' sel' : '')} onClick={() => go({ kind: 'mission', i })} title={x.description ?? ''}>
                <span class="nm"><span class={'bdg ' + (x.type === 'side' ? 'b-side' : 'b-main')}>{x.type === 'side' ? 'S' : 'P'}</span>{x.title || <i>sans titre</i>}</span>
                <small>{doc.start === x.id && <b class="star" title="Mission de départ">★ </b>}{mIssues(i) > 0 && <b class="warnc">⚠{mIssues(i)} </b>}{x.id}</small>
              </div>
            ))}
            {!list.length && <p class="hint pad">Aucune mission. Créez la première avec « + Mission ».</p>}
          </div>
          <div class="btns tight">
            <button onClick={addMission}>+ Mission</button>
            <button disabled={!m} title="Dupliquer" onClick={dupMission}>⧉</button>
            <button disabled={!m || s.i === 0} title="Monter" onClick={() => moveMission(-1)}>↑</button>
            <button disabled={!m || s.i === list.length - 1} title="Descendre" onClick={() => moveMission(1)}>↓</button>
            <button disabled={!m} class={m && doc.start === m.id ? 'on' : ''} title="Mission lancée au début d'une nouvelle partie" onClick={setStart}>★ Départ</button>
            <button disabled={!m} class="danger" title="Supprimer" onClick={delMission}>✕</button>
          </div>

          <h4>Déclencheurs <small>({trigs.length})</small></h4>
          <div class="list mlist trig">
            {trigs.map((x, i) => (
              <div class={'it' + (s.kind === 'trigger' && s.i === i ? ' sel' : '')} onClick={() => go({ kind: 'trigger', i })}>
                <span class="nm">⚡ {x.id ?? <i>sans id</i>}</span>
                <small>{tIssues(i) > 0 && <b class="warnc">⚠{tIssues(i)} </b>}{whenSummary(x.when)}</small>
              </div>
            ))}
            {!trigs.length && <p class="hint pad">Réagissent à tout moment à un évènement (zone, mort, ramassage…).</p>}
          </div>
          <div class="btns tight">
            <button onClick={addTrigger}>+ Déclencheur</button>
            <button disabled={!t} title="Dupliquer" onClick={dupTrigger}>⧉</button>
            <button disabled={!t || s.i === 0} title="Monter" onClick={() => moveTrigger(-1)}>↑</button>
            <button disabled={!t || s.i === trigs.length - 1} title="Descendre" onClick={() => moveTrigger(1)}>↓</button>
            <button disabled={!t} class="danger" title="Supprimer" onClick={delTrigger}>✕</button>
          </div>

          <h4>Variables <small>({Object.keys(doc.variables ?? {}).length})</small></h4>
          <VarsEditor vars={doc.variables ?? {}} onChange={(v) => update({ ...doc, variables: v }, 'Variables')} />

          <details class="issues" open={warnCount > 0}>
            <summary><h4>Problèmes <small>({warnCount}{issues.length > warnCount ? ` + ${issues.length - warnCount} remarques` : ''})</small></h4></summary>
            {!issues.length && <p class="hint">Aucun problème détecté.</p>}
            {issues.map((x) => (
              <div class={'issue ' + x.level} onClick={() => x.t !== undefined ? go({ kind: 'trigger', i: x.t }) : x.m !== undefined && go({ kind: 'mission', i: x.m, obj: x.o ?? null })}>
                {x.level === 'warn' ? '⚠' : 'ℹ'} {x.msg}
              </div>
            ))}
          </details>
        </div>

        {MD.conflict.value && (
          <div class="conflict">
            ⚠ {MD.file} a été modifié sur le disque par un autre outil pendant vos modifications.
            <button onClick={() => MD.load({ force: true })}>Recharger depuis le disque (perdre mes modifications)</button>
            <button onClick={() => (MD.conflict.value = false)}>Garder ma version</button>
          </div>
        )}

        {m && (
          <MissionEditor key={'m' + s.i} ed={ed} doc={doc} m={m} mi={s.i} obj={s.obj} issues={issues.filter((x) => x.m === s.i)}
            onChange={(nm, label, key) => setMission(s.i, nm, label, key)} onRename={(to) => renameMission(s.i, to)}
            onRenameObjective={(oi, to) => renameObjective(s.i, oi, to)} onSelectObj={(oi) => go({ kind: 'mission', i: s.i, obj: oi })} />
        )}
        {t && <TriggerEditor key={'t' + s.i} t={t} ti={s.i} issues={issues.filter((x) => x.t === s.i)} onChange={(nt, label, key) => setTrigger(s.i, nt, label, key)} />}
        {!m && !t && <div class="mcol"><p class="hint">Sélectionnez ou créez une mission.</p></div>}
      </div>
    </RefCtx.Provider>
  );
}

function whenSummary(w) {
  const k = whenKind(w);
  if (!w) return '—';
  if (k === 'enterZone') return `entre ${w.enterZone || '?'}`;
  if (k === 'leaveZone') return `sort ${w.leaveZone || '?'}`;
  if (k === 'always') return 'toujours';
  const f = Object.entries(w).filter(([x]) => x !== 'event').map(([, v]) => v).join(' ');
  return `${w.event ?? '?'} ${f}`;
}

// --- variables --------------------------------------------------------------------------------
function VarsEditor({ vars, onChange }) {
  const ent = Object.entries(vars);
  const emit = (e) => onChange(Object.fromEntries(e));
  return (
    <div class="vars">
      {ent.map(([k, v], i) => (
        <div class="var" key={k}>
          <Txt value={k} cls="vn" title="Nom de la variable" onChange={(nk) => {
            if (!nk || nk === k) return;
            if (nk in vars) { log(`La variable « ${nk} » existe déjà`, 'warn'); return; }
            const x = [...ent]; x[i] = [nk, v]; emit(x);
          }} />
          <ValueField value={v} onChange={(nv) => { const x = [...ent]; x[i] = [k, nv]; emit(x); }} />
          <button class="mini danger" title="Supprimer la variable" onClick={() => emit(ent.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {!ent.length && <p class="hint">Aucune variable (valeurs initiales des scripts : setVar / incVar / conditions).</p>}
      <button class="mini add" onClick={() => emit([...ent, [uniqueId('variable', Object.keys(vars)), false]])}>+ variable</button>
    </div>
  );
}

// --- mission ----------------------------------------------------------------------------------
function MissionEditor({ ed, doc, m, mi, obj, issues, onChange, onRename, onRenameObjective, onSelectObj }) {
  const [json, setJson] = useState(false);
  // key: merges rapid edits of one field into one undo step (null = never merge)
  const put = (k, v, label, key) => { const x = { ...m, [k]: v }; if (v === undefined) delete x[k]; onChange(x, label, key === undefined ? k : key); };
  const objs = m.objectives ?? [];
  const oi = obj !== null && obj !== undefined && objs[obj] ? obj : null;
  const setObjs = (n, label = 'Objectifs') => put('objectives', n, label, null);
  const addObj = (type) => {
    const id = uniqueId(`o${objs.length + 1}`, objs.map((o) => o.id));
    const o = { id, type, text: '' };
    for (const f of OBJ_INFO[type].fields) if (f.def !== undefined && f.kind !== 'condition') o[f.k] = f.def;
    if (type === 'condition') o.condition = { var: '' };
    if (type === 'wait') { o.hidden = true; delete o.text; }
    setObjs([...objs, o], 'Ajouter un objectif');
    onSelectObj(objs.length);
  };
  const objIssues = (i) => issues.filter((x) => x.o === i && x.level === 'warn').length;
  // fromCamera: start where the editor camera is (like "Jouer ici") instead of the player start
  const test = async (fromCamera) => {
    if (Object.keys(S.dirty.value).length) await ed.saveAll();
    let spawn = '';
    if (fromCamera) {
      const c = ed.engine.camera.position;
      const h = ed.world.terrain.heightAt(c.x, c.z);
      spawn = `&spawn=${c.x.toFixed(1)},${(h + 0.5).toFixed(1)},${c.z.toFixed(1)},${ed.fly.yaw.toFixed(2)}`;
    }
    window.open(`/?autostart=1&nointro=1&mission=${encodeURIComponent(m.id)}${spawn}`, 'minicry-game');
  };
  const own = issues.filter((x) => x.o === undefined);
  return (
    <>
      <div class="mcol">
        <div class="mhead">
          <span class={'bdg ' + (m.type === 'side' ? 'b-side' : 'b-main')}>{m.type === 'side' ? 'Secondaire' : 'Principale'}</span>
          <h3>{m.title || <i>sans titre</i>}</h3>
          {doc.start === m.id && <span class="star" title="Mission de départ">★</span>}
          <span class="grow" />
          <button class="play" disabled={!m.id} title="Enregistrer puis lancer le jeu avec cette mission démarrée (depuis le départ du joueur)" onClick={() => test(false)}>▶ Tester</button>
          <button class="mini" disabled={!m.id} title="Tester la mission en partant de la position de la caméra de l'éditeur (vue Monde)" onClick={() => test(true)}>▶ ici</button>
          <button class={'mini' + (json ? ' on' : '')} title="Éditer la mission en JSON brut" onClick={() => setJson(!json)}>JSON</button>
        </div>
        {json ? <JsonField value={m} rows={30} onChange={(v) => v && typeof v === 'object' && !Array.isArray(v) && onChange(v, 'Mission (JSON)')} /> : (
          <>
            <div class="mcard">
              <Row label="Identifiant" title="Référencé par startMission, missionDone… (renommer met à jour les références)"><Txt value={m.id} onChange={(v) => onRename(v)} /></Row>
              <Row label="Titre"><Txt value={m.title} onChange={(v) => put('title', v)} /></Row>
              <Row label="Type">
                <select value={m.type ?? 'main'} onChange={(e) => put('type', e.target.value)}><option value="main">Principale</option><option value="side">Secondaire</option></select>
              </Row>
              <Row label="Description" title="Texte du journal"><Area value={m.description} rows={3} onChange={(v) => put('description', v ?? '')} placeholder="Texte du journal de missions" /></Row>
              <Row label="Sauvegarde" title="Point de sauvegarde quand la mission est réussie"><input type="checkbox" checked={m.checkpoint !== false} onChange={(e) => put('checkpoint', e.target.checked ? undefined : false)} /><small>sauvegarder à la réussite</small></Row>
            </div>
            {own.length > 0 && <div class="iss">{own.map((x) => <div class={'issue ' + x.level}>{x.level === 'warn' ? '⚠' : 'ℹ'} {x.msg}</div>)}</div>}

            <div class="sec">
              <div class="acts-h"><b>Objectifs</b><small>{objs.length ? `${plural(objs.length, 'objectif')}, accomplis dans l'ordre` : 'aucun objectif'}</small></div>
              <div class="olist">
                {objs.map((o, i) => {
                  const info = OBJ_INFO[o.type];
                  const st = (fn) => (e) => { e.stopPropagation(); fn(); };
                  return (
                    <div class={'orow' + (oi === i ? ' sel' : '') + (o.hidden ? ' hid' : '')} onClick={() => onSelectObj(i)}>
                      <span class="n">{i + 1}</span>
                      <span class="oi" title={info?.label ?? o.type}>{info?.icon ?? '?'}</span>
                      <span class="ot">{o.text || <i>{info?.label ?? o.type}{o.hidden ? ' (caché)' : ''}</i>}<small>{o.id ?? '—'} · {o.type}{objSummary(o)}</small></span>
                      {objIssues(i) > 0 && <b class="warnc">⚠{objIssues(i)}</b>}
                      <span class="rtools">
                        <button class="mini" title="Monter" disabled={i === 0} onClick={st(() => { setObjs(moveItem(objs, i, -1), 'Déplacer l\'objectif'); onSelectObj(i - 1); })}>↑</button>
                        <button class="mini" title="Descendre" disabled={i === objs.length - 1} onClick={st(() => { setObjs(moveItem(objs, i, 1), 'Déplacer l\'objectif'); onSelectObj(i + 1); })}>↓</button>
                        <button class="mini" title="Dupliquer" onClick={st(() => { const c = structuredClone(o); c.id = uniqueId(o.id ?? 'o', objs.map((x) => x.id)); setObjs([...objs.slice(0, i + 1), c, ...objs.slice(i + 1)], 'Dupliquer l\'objectif'); onSelectObj(i + 1); })}>⧉</button>
                        <button class="mini danger" title="Supprimer" onClick={st(() => { if (confirm(`Supprimer l'objectif « ${o.text || o.id} » ?`)) { setObjs(objs.filter((_, j) => j !== i), 'Supprimer l\'objectif'); onSelectObj(null); } })}>✕</button>
                      </span>
                    </div>
                  );
                })}
              </div>
              <select class="addsel" value="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) addObj(v); }}>
                <option value="">+ ajouter un objectif…</option>
                {OBJECTIVE_TYPES.map((x) => <option value={x}>{OBJ_INFO[x]?.icon} {OBJ_INFO[x]?.label ?? x} · {x}</option>)}
              </select>
            </div>

            <div class="sec"><ActionList title="Au démarrage" hint="onStart" value={m.onStart} mission={m.id} onChange={(v) => put('onStart', v, 'Actions au démarrage', null)} /></div>
            <div class="sec"><ActionList title="À la réussite" hint="onComplete" value={m.onComplete} mission={m.id} onChange={(v) => put('onComplete', v, 'Actions à la réussite', null)} /></div>
            <div class="sec">
              <div class="acts-h"><b>Échec si</b><small>failIf · la mission échoue dès qu'une condition est vraie</small></div>
              <CondList value={m.failIf} withReason addLabel="+ condition d'échec" onChange={(v) => put('failIf', v?.length ? v : undefined, 'Conditions d\'échec', null)} />
            </div>
            <div class="sec"><ActionList title="À l'échec" hint="onFail (puis retour au dernier point de sauvegarde)" value={m.onFail} mission={m.id} onChange={(v) => put('onFail', v, 'Actions à l\'échec', null)} /></div>
          </>
        )}
      </div>
      <div class="mcol objcol">
        {oi !== null
          ? <ObjectiveEditor key={oi} o={objs[oi]} oi={oi} n={objs.length} mission={m} issues={issues.filter((x) => x.o === oi)}
              onChange={(no, label, key) => { const n = [...objs]; n[oi] = no; put('objectives', n, label ?? 'Modifier l\'objectif', key ? `o${oi}.${key}` : null); }}
              onRename={(to) => onRenameObjective(oi, to)} onClose={() => onSelectObj(null)} />
          : <div class="empty"><p class="hint">Sélectionnez un objectif pour l'éditer.</p><p class="hint">Un objectif est accompli quand sa condition est remplie ; le suivant démarre alors. Quand le dernier est accompli, la mission est réussie.</p></div>}
      </div>
    </>
  );
}

function objSummary(o) {
  const info = OBJ_INFO[o.type];
  if (!info) return '';
  const parts = info.fields.filter((f) => f.kind !== 'condition' && o[f.k] !== undefined).map((f) => (Array.isArray(o[f.k]) ? `[${o[f.k].join(', ')}]` : String(o[f.k])));
  return parts.length ? ' · ' + parts.join(' · ') : '';
}

// --- objective --------------------------------------------------------------------------------
function ObjectiveEditor({ o, oi, n, mission, issues, onChange, onRename, onClose }) {
  const [json, setJson] = useState(false);
  const info = OBJ_INFO[o.type];
  const put = (k, v, label) => { const x = { ...o, [k]: v }; if (v === undefined) delete x[k]; onChange(x, label, k); };
  const setType = (type) => {
    const x = { id: o.id, type };
    for (const k of OBJ_COMMON) if (k !== 'id' && k !== 'type' && o[k] !== undefined) x[k] = o[k];
    for (const f of OBJ_INFO[type]?.fields ?? []) {
      if (o[f.k] !== undefined) x[f.k] = o[f.k];
      else if (f.kind === 'condition') x.condition = { var: '' };
    }
    if (x.id === undefined) delete x.id;
    onChange(x, 'Type d\'objectif');
  };
  return (
    <>
      <div class="mhead">
        <h3>{info?.icon ?? '?'} Objectif {oi + 1}/{n}</h3>
        <code>{o.id}</code>
        <span class="grow" />
        <button class={'mini' + (json ? ' on' : '')} title="Éditer l'objectif en JSON brut" onClick={() => setJson(!json)}>JSON</button>
        <button class="mini" title="Fermer" onClick={onClose}>✕</button>
      </div>
      {json ? <JsonField value={o} rows={24} onChange={(v) => v && typeof v === 'object' && !Array.isArray(v) && onChange(v, 'Objectif (JSON)')} /> : (
        <>
          <div class="mcard">
            <Row label="Type">
              <select value={o.type} onChange={(e) => setType(e.target.value)}>
                {!info && <option value={o.type}>⚠ {o.type}</option>}
                {OBJECTIVE_TYPES.map((x) => <option value={x}>{OBJ_INFO[x]?.icon} {OBJ_INFO[x]?.label ?? x} · {x}</option>)}
              </select>
            </Row>
            <Row label="Identifiant" title="Référencé par completeObjective et l'évènement objectiveComplete"><Txt value={o.id} onChange={onRename} /></Row>
            <Row label="Texte (HUD)"><Txt value={o.text} placeholder={o.hidden ? '(objectif caché)' : 'Texte affiché à l\'écran'} onChange={(v) => put('text', v)} /></Row>
            {(info?.fields ?? []).map((f) => (
              f.kind === 'condition'
                ? <div class="row blk"><span class="lbl">{f.label}</span><span class="val"><ParamField p={f} value={o[f.k]} onChange={(v) => put(f.k, v ?? { var: '' })} /></span></div>
                : <Row label={f.label + (f.req ? ' *' : '')}><ParamField p={f} value={o[f.k]} ctx={{ mission: mission.id }} onChange={(v) => put(f.k, v)} /></Row>
            ))}
            {info?.oneOf && <p class="hint">Renseigner {info.oneOf.join(' ou ')}.</p>}
            {Object.keys(o).filter((k) => !OBJ_COMMON.includes(k) && !(info?.fields ?? []).some((f) => f.k === k)).map((k) => (
              <Row label={k} title="Champ non géré par l'éditeur (conservé tel quel)"><JsonField value={o[k]} rows={1} onChange={(v) => put(k, v)} /></Row>
            ))}
            <Row label="Marqueur" title="Entité montrée sur la boussole / la carte quand elle diffère de la cible"><PosField value={o.marker} placeholder="= la cible" onChange={(v) => put('marker', v)} /></Row>
            <Row label="Options">
              <label class="chk"><input type="checkbox" checked={!!o.hidden} onChange={(e) => put('hidden', e.target.checked || undefined)} /> caché</label>
              <label class="chk"><input type="checkbox" checked={!!o.noMarker} onChange={(e) => put('noMarker', e.target.checked || undefined)} /> sans marqueur</label>
            </Row>
          </div>
          {issues.length > 0 && <div class="iss">{issues.map((x) => <div class={'issue ' + x.level}>{x.level === 'warn' ? '⚠' : 'ℹ'} {x.msg}</div>)}</div>}
          <div class="sec"><ActionList title="Au début de l'objectif" hint="onStart" value={o.onStart} mission={mission.id} onChange={(v) => put('onStart', v, 'Actions de l\'objectif')} /></div>
          <div class="sec"><ActionList title="Objectif accompli" hint="onComplete" value={o.onComplete} mission={mission.id} onChange={(v) => put('onComplete', v, 'Actions de l\'objectif')} /></div>
        </>
      )}
    </>
  );
}

// --- trigger ----------------------------------------------------------------------------------
function TriggerEditor({ t, issues, onChange }) {
  const [json, setJson] = useState(false);
  const k = whenKind(t.when);
  const w = t.when ?? {};
  const put = (key, v, label) => { const x = { ...t, [key]: v }; if (v === undefined) delete x[key]; onChange(x, label, key); };
  const setWhen = (nw) => put('when', nw, 'Quand');
  const setWhenKind = (nk) => setWhen(nk === 'always' ? { always: true } : nk === 'event' ? { event: 'kill' } : { [nk]: w.enterZone ?? w.leaveZone ?? w.zone ?? '' });
  const ev = EVENTS[w.event];
  return (
    <div class="mcol wide">
      <div class="mhead">
        <span class="bdg b-trig">Déclencheur</span>
        <h3>⚡ {t.id ?? <i>sans id</i>}</h3>
        <span class="grow" />
        <button class={'mini' + (json ? ' on' : '')} title="Éditer le déclencheur en JSON brut" onClick={() => setJson(!json)}>JSON</button>
      </div>
      {json ? <JsonField value={t} rows={24} onChange={(v) => v && typeof v === 'object' && !Array.isArray(v) && onChange(v, 'Déclencheur (JSON)')} /> : (
        <>
          <div class="mcard">
            <Row label="Identifiant" title="Sert à mémoriser qu'un déclencheur « une seule fois » a déjà été exécuté"><Txt value={t.id} onChange={(v) => put('id', v)} /></Row>
            <Row label="Quand">
              <select value={k} onChange={(e) => setWhenKind(e.target.value)}>{Object.entries(WHEN_KINDS).map(([x, l]) => <option value={x}>{l}</option>)}</select>
              {(k === 'enterZone' || k === 'leaveZone') && <ParamField p={{ kind: 'zone', label: 'zone' }} value={w[k]} onChange={(v) => setWhen({ [k]: v ?? '' })} />}
              {k === 'event' && (
                <select value={w.event ?? ''} onChange={(e) => setWhen({ event: e.target.value })}>
                  {!ev && <option value={w.event ?? ''}>⚠ {w.event ?? '?'}</option>}
                  {Object.entries(EVENTS).map(([x, e]) => <option value={x}>{e.label} · {x}</option>)}
                </select>
              )}
            </Row>
            {k === 'event' && ev?.filters.map((f) => (
              <Row label={'  ' + f.label} title="Filtre optionnel : vide = n'importe lequel">
                <ParamField p={f} value={w[f.k]} ctx={{ mission: w.mission }} onChange={(v) => { const x = { ...w, [f.k]: v }; if (v === undefined) delete x[f.k]; setWhen(x); }} />
              </Row>
            ))}
            <Row label="Une seule fois"><input type="checkbox" checked={t.once !== false} onChange={(e) => put('once', e.target.checked)} /><small>{t.once === false ? 'se répète à chaque fois' : 'exécuté une seule fois par partie'}</small></Row>
            <div class="row blk"><span class="lbl">Condition</span><span class="val"><OptCond value={t.if} onChange={(v) => put('if', v, 'Condition')} label="+ condition (si…)" /></span></div>
          </div>
          {issues.length > 0 && <div class="iss">{issues.map((x) => <div class={'issue ' + x.level}>{x.level === 'warn' ? '⚠' : 'ℹ'} {x.msg}</div>)}</div>}
          <div class="sec"><ActionList title="Actions" hint="do" value={t.do} keepEmpty onChange={(v) => put('do', v ?? [], 'Actions')} /></div>
          <p class="hint">Événements : {Object.keys(EVENTS).join(', ')}. Les filtres vides acceptent n'importe quelle valeur. « Toujours » est vérifié à chaque image : à utiliser avec une condition.</p>
        </>
      )}
    </div>
  );
}
