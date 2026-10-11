// Reusable editors for the Missions panel: reference pickers (combobox = <input list> +
// <datalist>, free text allowed), positions, typed values, conditions (recursive) and action
// lists. Every editor is controlled: { value, onChange(newValue) }, undefined removes the key.
import { createContext } from 'preact';
import { useContext, useState, useEffect, useMemo } from 'preact/hooks';
import { JsonField, Vec3Field } from '../../ui/Fields.jsx';
import {
  ACTIONS, ACTION_INFO, ACTION_DEFAULTS, COND_INFO, COND_KINDS, COND_DEFAULT, condKind, KIND_LABEL,
} from './schema.js';

export const RefCtx = createContext(null);
export const useRefs = () => useContext(RefCtx);

let uid = 0;
const useUid = (p) => useMemo(() => `${p}-${++uid}`, []);

/** The shared <datalist>s (one per reference kind), rendered once per panel. */
export function Datalists({ R }) {
  return <>{Object.entries(R.lists).map(([k, l]) => <datalist id={'mcdl-' + k}>{l.map((o) => <option value={o.value}>{o.label}</option>)}</datalist>)}</>;
}

/** Text input committing on blur / Enter (or right away when an option of its datalist is picked). */
export function Txt({ value, onChange, placeholder, list, cls = '', title, keepEmpty, size }) {
  const [t, setT] = useState(value ?? '');
  useEffect(() => setT(value ?? ''), [value]);
  const commit = (v) => { if (v !== (value ?? '')) onChange(v === '' && !keepEmpty ? undefined : v); };
  return (
    <input type="text" class={cls} list={list} value={t} placeholder={placeholder} title={title} size={size} spellcheck={false}
      onInput={(e) => { setT(e.target.value); if (list && (!e.inputType || e.inputType === 'insertReplacementText')) commit(e.target.value); }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') setT(value ?? ''); }} />
  );
}

/** Multi-line text committing on blur. */
export function Area({ value, onChange, placeholder, rows = 2, cls = '' }) {
  const [t, setT] = useState(value ?? '');
  useEffect(() => setT(value ?? ''), [value]);
  return <textarea class={'txt ' + cls} rows={rows} value={t} placeholder={placeholder} onInput={(e) => setT(e.target.value)} onBlur={() => t !== (value ?? '') && onChange(t === '' ? undefined : t)} />;
}

/** Optional number (empty = undefined, the default shown as placeholder). Arrow keys step it. */
export function Num({ value, onChange, placeholder, int, step = 1, title }) {
  const [t, setT] = useState(value ?? '');
  useEffect(() => setT(value ?? ''), [value]);
  const commit = (s) => {
    s = String(s).trim().replace(',', '.');
    if (s === '') { if (value !== undefined && value !== null) onChange(undefined); return; }
    const n = Number(s);
    if (Number.isNaN(n)) { setT(value ?? ''); return; }
    const v = int ? Math.round(n) : n;
    if (v !== value) onChange(v);
  };
  return (
    <input type="text" class="num" inputMode="decimal" value={t} placeholder={placeholder === undefined ? '' : String(placeholder)} title={title}
      onInput={(e) => setT(e.target.value)} onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const base = Number(t === '' ? (typeof placeholder === 'number' ? placeholder : 0) : t) || 0;
          const v = +(base + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? step * 10 : step)).toFixed(4);
          setT(v); onChange(int ? Math.round(v) : v);
        }
      }} />
  );
}

/** Reference to an id (entity, actor, group, item, dialogue, mission...): combobox + "Voir". */
export function RefField({ kind, value, onChange, placeholder, options }) {
  const R = useRefs();
  const id = useUid('mcdl-x');
  const listId = options ? id : 'mcdl-' + kind;
  const st = options ? (value && !options.some((o) => o.value === value) ? 'unknown' : 'ok') : R.check(kind, value);
  const ent = R.isEntityKind(kind) && typeof value === 'string' && R.byId.get(value);
  const tip = st === 'unknown' ? `${KIND_LABEL[kind] ?? kind} inconnu(e) — sera peut-être créé(e) plus tard`
    : st === 'type' ? `type inattendu : ${ent?.type}` : ent ? `${ent.type}${ent.name ? ' · ' + ent.name : ''}` : '';
  return (
    <span class="ref">
      <Txt value={typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)} onChange={onChange} list={listId}
        placeholder={placeholder ?? KIND_LABEL[kind] ?? ''} cls={st === 'unknown' || st === 'type' ? 'warn' : ''} title={tip} />
      {options && <datalist id={id}>{options.map((o) => <option value={o.value}>{o.label}</option>)}</datalist>}
      {ent && <button class="mini eye" title="Voir dans le monde 3D" onClick={(e) => { e.preventDefault(); R.show(value); }}>👁</button>}
    </span>
  );
}

const camPos = (R) => R.ed?.engine?.camera?.position.toArray().map((v) => +v.toFixed(1)) ?? [0, 0, 0];

/** Position reference: entity / actor id, "player", or literal [x, y, z]. */
export function PosField({ value, onChange, placeholder }) {
  const R = useRefs();
  const xyz = Array.isArray(value);
  const toXyz = () => { const e = typeof value === 'string' && R.byId.get(value); onChange(e?.pos ? e.pos.map((v) => +(+v).toFixed(2)) : camPos(R)); };
  return (
    <span class="pos">
      {xyz ? <Vec3Field value={value} onChange={onChange} /> : <RefField kind="pos" value={value} onChange={onChange} placeholder={placeholder ?? 'entité, acteur, player'} />}
      <button class="mini" title={xyz ? 'Utiliser un id d\'entité' : 'Coordonnées x, y, z'} onClick={(e) => { e.preventDefault(); xyz ? onChange(undefined) : toXyz(); }}>{xyz ? 'id' : 'xyz'}</button>
      {xyz && <button class="mini" title="Position actuelle de la caméra de l'éditeur" onClick={(e) => { e.preventDefault(); onChange(camPos(R)); }}>📷</button>}
    </span>
  );
}

/** Typed literal (variables): boolean / number / text. */
export function ValueField({ value, onChange }) {
  const t = typeof value === 'number' ? 'num' : typeof value === 'string' ? 'str' : 'bool';
  return (
    <span class="value">
      <select class="vt" value={t} title="Type de la valeur" onChange={(e) => onChange(e.target.value === 'bool' ? true : e.target.value === 'num' ? 0 : '')}>
        <option value="bool">bool</option><option value="num">nombre</option><option value="str">texte</option>
      </select>
      {t === 'bool' && <select value={String(value !== false)} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">vrai</option><option value="false">faux</option></select>}
      {t === 'num' && <Num value={value} onChange={(v) => onChange(v ?? 0)} />}
      {t === 'str' && <Txt value={value} onChange={(v) => onChange(v ?? '')} keepEmpty />}
    </span>
  );
}

/** { ammoType: count } */
function AmmoField({ value, onChange }) {
  const R = useRefs();
  const ent = Object.entries(value ?? {});
  const emit = (e) => onChange(e.length ? Object.fromEntries(e) : undefined);
  return (
    <span class="ammo">
      {ent.map(([k, n], i) => (
        <span class="am">
          <select value={k} onChange={(e) => { const x = [...ent]; x[i] = [e.target.value, n]; emit(x); }}>
            {[...new Set([k, ...R.lists.ammo.map((o) => o.value)])].map((a) => <option value={a}>{a}</option>)}
          </select>
          <Num value={n} int onChange={(v) => { const x = [...ent]; x[i] = [k, v ?? 0]; emit(x); }} />
          <button class="mini danger" onClick={(e) => { e.preventDefault(); emit(ent.filter((_, j) => j !== i)); }}>✕</button>
        </span>
      ))}
      <button class="mini" title="Ajouter des munitions" onClick={(e) => { e.preventDefault(); const free = R.lists.ammo.map((o) => o.value).find((a) => !(a in (value ?? {}))) ?? 'pistol'; emit([...ent, [free, 30]]); }}>+</button>
    </span>
  );
}

/** One field of an action / objective / filter, by kind. */
export function ParamField({ p, value, onChange, ctx = {} }) {
  const R = useRefs();
  const ph = p.def !== undefined ? String(p.def) : undefined;
  switch (p.kind) {
    case 'bool': return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? true : undefined)} />;
    case 'number': return <Num value={value} onChange={onChange} placeholder={p.def ?? ''} step={0.5} />;
    case 'int': return <Num value={value} onChange={onChange} placeholder={p.def ?? ''} int />;
    case 'string': return <Txt value={value} onChange={onChange} placeholder={ph} cls={p.wide ? 'wide' : ''} />;
    case 'longtext': return <Area value={value} onChange={onChange} placeholder={p.label} />;
    case 'enum': return <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}><option value="">—</option>{p.options.map((o) => <option value={o}>{o}</option>)}</select>;
    case 'pos': return <PosField value={value} onChange={onChange} />;
    case 'value': return <ValueField value={value} onChange={onChange} />;
    case 'ammo': return <AmmoField value={value} onChange={onChange} />;
    case 'condition': return <CondEditor value={value} onChange={onChange} />;
    case 'objective': {
      const mid = ctx.mission;
      const m = (R.mdoc?.missions ?? []).find((x) => x.id === mid);
      const options = (m?.objectives ?? []).filter((o) => o.id).map((o) => ({ value: o.id, label: o.text ?? o.type }));
      return <RefField kind="objective" value={value} onChange={onChange} options={options} placeholder={mid ? `objectif de ${mid}` : 'objectif (courant)'} />;
    }
    default: return <RefField kind={p.kind} value={value} onChange={onChange} placeholder={ph ?? p.label} />;
  }
}

// --- conditions -------------------------------------------------------------------------------
const OPS = [['', 'est vraie'], ['eq', '='], ['gt', '>'], ['lt', '<'], ['gte', '≥']];

/** A condition (recursive for not / all / any). `extra` is rendered at the end of its first line. */
export function CondEditor({ value, onChange, depth = 0, extra }) {
  const R = useRefs();
  const k = condKind(value);
  const c = Array.isArray(value) ? { all: value } : (value && typeof value === 'object' ? value : {});
  const put = (patch) => onChange({ ...c, ...patch });
  const setKind = (nk) => {
    const base = structuredClone(COND_DEFAULT[nk] ?? { [nk]: '' });
    if (c.reason !== undefined) base.reason = c.reason;
    onChange(base);
  };
  let body = null;
  if (k === 'var') {
    const op = ['eq', 'gt', 'lt', 'gte'].find((o) => c[o] !== undefined) ?? '';
    const setOp = (no) => {
      const n = { ...c };
      for (const o of ['eq', 'gt', 'lt', 'gte']) delete n[o];
      if (no) n[no] = no === 'eq' ? (c[op] ?? true) : typeof c[op] === 'number' ? c[op] : 0;
      onChange(n);
    };
    body = <>
      <RefField kind="var" value={c.var} onChange={(v) => put({ var: v ?? '' })} />
      <select class="op" value={op} onChange={(e) => setOp(e.target.value)}>{OPS.map(([v, l]) => <option value={v}>{l}</option>)}</select>
      {op === 'eq' && <ValueField value={c.eq} onChange={(v) => put({ eq: v })} />}
      {op && op !== 'eq' && <Num value={c[op]} onChange={(v) => put({ [op]: v ?? 0 })} />}
    </>;
  } else if (k === 'timeBetween') {
    const [a, b] = c.timeBetween ?? [20, 5];
    body = <><span class="lb">de</span><Num value={a} onChange={(v) => put({ timeBetween: [v ?? 0, b] })} /><span class="lb">h à</span><Num value={b} onChange={(v) => put({ timeBetween: [a, v ?? 0] })} /><span class="lb">h</span></>;
  } else if (k === 'collected') {
    const x = c.collected ?? {};
    body = <><RefField kind="collect" value={x.item} onChange={(v) => put({ collected: { ...x, item: v ?? '' } })} /><span class="lb">≥</span><Num int value={x.count} onChange={(v) => put({ collected: { ...x, count: v ?? 1 } })} /></>;
  } else if (k === 'objectiveActive') {
    const x = c.objectiveActive ?? {};
    const m = (R.mdoc?.missions ?? []).find((y) => y.id === x.mission);
    const options = (m?.objectives ?? []).filter((o) => o.id).map((o) => ({ value: o.id, label: o.text ?? o.type }));
    body = <><RefField kind="mission" value={x.mission} onChange={(v) => put({ objectiveActive: { ...x, mission: v ?? '' } })} /><span class="lb">·</span><RefField kind="objective" value={x.id} onChange={(v) => put({ objectiveActive: { ...x, id: v ?? '' } })} options={options} placeholder="objectif" /></>;
  } else if (k === 'not') {
    body = <CondEditor value={c.not} onChange={(v) => put({ not: v })} depth={depth + 1} />;
  } else if (k === 'all' || k === 'any') {
    body = <CondList value={c[k]} onChange={(v) => put({ [k]: v ?? [] })} depth={depth + 1} />;
  } else if (COND_INFO[k]?.ref) {
    body = <RefField kind={COND_INFO[k].ref} value={c[k]} onChange={(v) => put({ [k]: v ?? '' })} />;
  } else if (k === '?') {
    body = <span class="rawc"><JsonField value={value ?? null} rows={1} onChange={(v) => v !== undefined && onChange(v)} /></span>;
  }
  const nested = k === 'not' || k === 'all' || k === 'any';
  return (
    <div class={'cond' + (nested ? ' nested' : '')}>
      <div class="cond-h">
        <select class={'ck' + (k === '?' ? ' warn' : '')} value={k} onChange={(e) => setKind(e.target.value)}>
          {k === '?' && <option value="?">⚠ non reconnue (JSON)</option>}
          {COND_KINDS.map((x) => <option value={x}>{COND_INFO[x].label}</option>)}
        </select>
        {!nested && body}
        {extra}
      </div>
      {nested && <div class="cond-sub">{body}</div>}
    </div>
  );
}

/** List of conditions (all must hold). withReason: failIf entries carry a "reason" text. */
export function CondList({ value, onChange, depth = 0, withReason, addLabel = '+ condition' }) {
  const list = value ?? [];
  const setAt = (i, v) => { const n = [...list]; n[i] = v; onChange(n); };
  return (
    <div class="condlist">
      {list.map((c, i) => (
        <CondEditor value={c} depth={depth} onChange={(v) => setAt(i, v)} extra={<>
          {withReason && <Txt value={c?.reason} placeholder="raison affichée" cls="reason" onChange={(r) => { const n = { ...c, reason: r }; if (r === undefined) delete n.reason; setAt(i, n); }} />}
          <button class="mini danger" title="Retirer cette condition" onClick={() => onChange(list.filter((_, j) => j !== i))}>✕</button>
        </>} />
      ))}
      <button class="mini add" onClick={() => onChange([...list, { var: '' }])}>{addLabel}</button>
    </div>
  );
}

/** Optional condition (action "if", trigger "if"). */
export function OptCond({ value, onChange, label = '+ condition (si…)' }) {
  if (value === undefined) return <button class="mini add" onClick={() => onChange({ var: '' })}>{label}</button>;
  return <CondEditor value={value} onChange={onChange} extra={<button class="mini danger" title="Retirer la condition" onClick={() => onChange(undefined)}>✕</button>} />;
}

// --- actions ----------------------------------------------------------------------------------
const ACTION_GROUPS = [
  ['Dialogue & HUD', ['dialogue', 'say', 'banner', 'hint']],
  ['Missions', ['startMission', 'completeMission', 'failMission', 'completeObjective', 'checkpoint', 'setMarker', 'endGame']],
  ['Variables', ['setVar', 'incVar']],
  ['Personnages', ['spawn', 'activateGroup', 'alertGroup', 'removeGroup', 'follow', 'stopFollow']],
  ['Joueur', ['giveWeapon', 'giveItem', 'heal', 'teleport']],
  ['Monde', ['enable', 'disable', 'explode', 'setTime', 'setDayLength']],
  ['Mise en scène', ['cinematic', 'playSound', 'music', 'wait']],
];
const grouped = new Set(ACTION_GROUPS.flatMap(([, l]) => l));
const OTHER = ACTIONS.filter((a) => !grouped.has(a));

function ActionOptions({ codes }) {
  return <>
    {ACTION_GROUPS.map(([g, l]) => <optgroup label={g}>{l.filter((a) => ACTIONS.includes(a)).map((a) => <option value={a}>{ACTION_INFO[a].label}{codes ? ` · ${a}` : ''}</option>)}</optgroup>)}
    {OTHER.length > 0 && <optgroup label="Autres">{OTHER.map((a) => <option value={a}>{a}</option>)}</optgroup>}
  </>;
}

export function newAction(d) { return { do: d, ...structuredClone(ACTION_DEFAULTS[d] ?? {}) }; }

function ActionRow({ a, i, n, onChange, onMove, onDup, onDel, mission }) {
  const info = ACTION_INFO[a.do];
  const params = info?.params ?? [];
  const known = new Set(['do', 'if', ...params.map((p) => p.k)]);
  const extra = Object.keys(a).filter((k) => !known.has(k));
  const put = (k, v) => { const nx = { ...a, [k]: v }; if (v === undefined) delete nx[k]; onChange(nx); };
  const setDo = (d) => {
    const nx = newAction(d);
    for (const p of ACTION_INFO[d]?.params ?? []) if (a[p.k] !== undefined && params.find((q) => q.k === p.k)?.kind === p.kind) nx[p.k] = a[p.k];
    if (a.if !== undefined) nx.if = a.if;
    onChange(nx);
  };
  const ctx = { mission: a.mission ?? mission };
  // short parameter lists stay on the action's line, the others go below it
  const inline = !extra.length && (params.length === 0 || (params.length === 1 && ['number', 'int', 'bool', 'enum'].includes(params[0].kind)));
  const fields = (
    <div class={'params' + (inline ? '' : ' block')}>
      {params.map((p) => (
        <label class={'prm' + (p.kind === 'longtext' ? ' full' : '') + (p.wide ? ' grow' : '')} title={p.k}>
          <span>{p.label}</span>
          <ParamField p={p} value={a[p.k]} onChange={(v) => put(p.k, v)} ctx={ctx} />
        </label>
      ))}
      {extra.map((k) => <label class="prm full"><span>{k}</span><JsonField value={a[k]} rows={1} onChange={(v) => put(k, v)} /></label>)}
      {!params.length && !extra.length && <small class="none">(aucun paramètre)</small>}
    </div>
  );
  return (
    <div class={'act' + (ACTIONS.includes(a.do) ? '' : ' bad')}>
      <div class="act-row">
        <span class="idx">{i + 1}</span>
        <select class="do" value={a.do} title={a.do} onChange={(e) => setDo(e.target.value)}>
          {!ACTIONS.includes(a.do) && <option value={a.do}>⚠ {String(a.do)}</option>}
          <ActionOptions />
        </select>
        {inline ? fields : <span class="grow" />}
        <span class="rtools">
          <button class={'mini' + (a.if !== undefined ? ' on' : '')} title="Exécuter seulement si une condition est vraie" onClick={() => put('if', a.if === undefined ? { var: '' } : undefined)}>si</button>
          <button class="mini" title="Monter" disabled={i === 0} onClick={() => onMove(-1)}>↑</button>
          <button class="mini" title="Descendre" disabled={i === n - 1} onClick={() => onMove(1)}>↓</button>
          <button class="mini" title="Dupliquer" onClick={onDup}>⧉</button>
          <button class="mini danger" title="Supprimer" onClick={onDel}>✕</button>
        </span>
      </div>
      {!inline && fields}
      {a.if !== undefined && <div class="act-if"><span class="si">si</span><CondEditor value={a.if} onChange={(v) => put('if', v)} /></div>}
    </div>
  );
}

/** Ordered list of actions (onStart / onComplete / onFail / trigger "do" / objective hooks). */
export function ActionList({ value, onChange, title, hint, mission, keepEmpty }) {
  const [json, setJson] = useState(false);
  const list = Array.isArray(value) ? value : [];
  const emit = (n) => onChange(n.length || keepEmpty ? n : undefined);
  const setAt = (i, a) => { const n = [...list]; n[i] = a; emit(n); };
  const move = (i, d) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; emit(n); };
  return (
    <div class="acts">
      <div class="acts-h">
        <b>{title}</b>
        <small>{list.length ? `${list.length} action${list.length > 1 ? 's' : ''}` : 'aucune action'}{hint ? ` · ${hint}` : ''}</small>
        <span class="grow" />
        <button class={'mini' + (json ? ' on' : '')} title="Éditer la liste en JSON brut" onClick={() => setJson(!json)}>JSON</button>
      </div>
      {json
        ? <JsonField value={list} rows={Math.min(18, Math.max(4, JSON.stringify(list, null, 2).split('\n').length))} onChange={(v) => Array.isArray(v) && emit(v)} />
        : list.map((a, i) => (
          <ActionRow key={i} a={a ?? {}} i={i} n={list.length} mission={mission}
            onChange={(x) => setAt(i, x)} onMove={(d) => move(i, d)}
            onDup={() => emit([...list.slice(0, i + 1), structuredClone(a), ...list.slice(i + 1)])}
            onDel={() => emit(list.filter((_, j) => j !== i))} />
        ))}
      {!json && (
        <select class="addsel" value="" onChange={(e) => { const d = e.target.value; e.target.value = ''; if (d) emit([...list, newAction(d)]); }}>
          <option value="">+ ajouter une action…</option>
          <ActionOptions codes />
        </select>
      )}
    </div>
  );
}

/** Small list toolbar helpers. */
export function moveItem(list, i, d) {
  const n = [...list];
  const j = i + d;
  if (j < 0 || j >= n.length) return list;
  [n[i], n[j]] = [n[j], n[i]];
  return n;
}
