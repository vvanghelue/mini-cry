// Form widgets of the Audio panel: numbers that can be unset (placeholder = default value),
// scrubbed by dragging (log scale for frequencies) or turned into a random [min, max] range;
// toggleable sections; filter / LFO lists; a small envelope graph.
import { useState, useEffect } from 'preact/hooks';
import { EnumField } from '../../ui/Fields.jsx';
import { FILTER_TYPES, LFO_SHAPES, DEF } from './templates.js';

// Edits made during one drag share a key so they merge into one undo step.
let dragKey = null, dragN = 0;
export const editKey = () => dragKey;

export const setKey = (o, k, v) => {
  const c = { ...(o ?? {}) };
  if (v === undefined) delete c[k]; else c[k] = v;
  return c;
};

function decimals(step) { return Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + 1)); }
function tidy(v, step, log) {
  if (!Number.isFinite(v)) return v;
  if (log || Math.abs(v) >= 1000) return +v.toPrecision(4);
  return +v.toFixed(decimals(step));
}
const show = (v) => (v === undefined || v === null ? '' : String(v));

/** Number input: drag to scrub (Shift = fine), click to type, empty = unset (shows the default). */
export function Scrub({ value, onChange, def, step = 0.01, min, max, log, int, title, wide }) {
  const [txt, setTxt] = useState(show(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(show(value)); }, [value, focus]);
  const clampV = (n) => {
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    return int ? Math.round(n) : tidy(n, step, log);
  };
  const commit = (s) => {
    s = String(s).trim();
    if (s === '') { if (value !== undefined) onChange(undefined); return; }
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n)) { setTxt(show(value)); return; }
    const c = clampV(n);
    if (c !== value) onChange(c);
    else setTxt(show(value));
  };
  const onDown = (e) => {
    if (e.button !== 0 || document.activeElement === e.target) return;
    e.preventDefault();
    const el = e.target, x0 = e.clientX;
    let v0 = Number.isFinite(+value) ? +value : Number.isFinite(+def) ? +def : 0;
    if (log && !(v0 > 0)) v0 = def > 0 ? def : 1;
    let moved = false;
    const key = `drag${++dragN}`;
    const mv = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      dragKey = key;
      const fine = ev.shiftKey ? 0.1 : 1;
      const n = log ? v0 * Math.pow(2, (dx * fine) / 90) : v0 + dx * step * fine;
      const c = clampV(n);
      setTxt(show(c));
      onChange(c);
    };
    const up = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
      dragKey = null;
      document.body.classList.remove('au-scrubbing');
      if (!moved) { el.focus(); el.select(); }
    };
    document.body.classList.add('au-scrubbing');
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };
  return (
    <input class={'num au-num' + (wide ? ' wide' : '')} type="text" value={txt} placeholder={def === undefined ? '' : show(def)} title={title ?? (log ? 'Glisser pour régler (échelle log, Maj = fin)' : 'Glisser pour régler (Maj = fin), vide = valeur par défaut')}
      onPointerDown={onDown} onFocus={() => setFocus(true)}
      onInput={(e) => setTxt(e.target.value)}
      onBlur={(e) => { setFocus(false); commit(e.target.value); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(e.target.value); e.target.blur(); }
        else if (e.key === 'Escape') { setTxt(show(value)); e.target.blur(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const d = e.key === 'ArrowUp' ? 1 : -1, base = Number.isFinite(+value) ? +value : +def || 0;
          const c = clampV(log ? base * Math.pow(2, d / 12) : base + d * step * (e.shiftKey ? 10 : 1));
          setTxt(show(c)); onChange(c);
        }
      }} />
  );
}

/**
 * JSON text editor (applied on blur or Ctrl+Entrée when valid). `format` lays the value out
 * (e.g. the compact sounds.json style); outside edits refresh it unless the text is being edited.
 */
export function CodeJson({ value, onChange, format, rows = 20 }) {
  const fmt = format ?? ((v) => JSON.stringify(v, null, 2));
  const key = JSON.stringify(value);
  const [txt, setTxt] = useState(() => fmt(value));
  const [err, setErr] = useState(null);
  const [edited, setEdited] = useState(false);
  useEffect(() => { if (!edited) { setTxt(fmt(value)); setErr(null); } }, [key]);
  const apply = () => {
    if (!edited) return;
    try {
      const v = JSON.parse(txt);
      setErr(null);
      setEdited(false);
      if (JSON.stringify(v) !== key) onChange(v); else setTxt(fmt(value));
    } catch (e) { setErr(e.message); }
  };
  return (
    <div class="au-code">
      <textarea rows={rows} spellcheck={false} class={err ? 'bad' : ''} value={txt} onBlur={apply}
        onInput={(e) => { setTxt(e.target.value); setEdited(true); try { JSON.parse(e.target.value); setErr(null); } catch (x) { setErr(x.message); } }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); apply(); } else if (e.key === 'Escape') { setEdited(false); setTxt(fmt(value)); setErr(null); } }} />
      <div class="au-codebar">
        {err ? <small class="err">{err}</small> : <small>{edited ? 'Modifié : appliqué en quittant le champ (Ctrl+Entrée), Échap pour annuler' : 'JSON valide'}</small>}
      </div>
    </div>
  );
}

/** A recipe parameter: a number, or a random range [min, max] drawn per variation. */
export function P({ value, onChange, def, range = true, ...o }) {
  if (Array.isArray(value)) {
    return (
      <span class="au-p au-range">
        <Scrub {...o} value={value[0]} onChange={(v) => onChange([v ?? value[1], value[1]])} title="minimum" />
        <span class="au-tilde">~</span>
        <Scrub {...o} value={value[1]} onChange={(v) => onChange([value[0], v ?? value[0]])} title="maximum" />
        <button class="au-mini" title="Valeur fixe (garder le minimum)" onClick={(e) => { e.preventDefault(); onChange(value[0]); }}>×</button>
      </span>
    );
  }
  return (
    <span class="au-p">
      <Scrub {...o} value={value} def={def} onChange={onChange} />
      {range && (
        <button class="au-mini au-torange" title="Plage aléatoire [min, max] : une valeur tirée par variation"
          onClick={(e) => { e.preventDefault(); const v = Number.isFinite(+value) ? +value : +def || 0; onChange([v, v === 0 ? 1 : tidy(v * 1.2, o.step ?? 0.01, o.log)]); }}>~</button>
      )}
    </span>
  );
}

export function R({ label, title, children }) {
  return <div class="row au-row" title={title}><span class="lbl">{label}</span><span class="val">{children}</span></div>;
}

/** Fieldset; with onToggle its legend has a checkbox that adds / removes the whole object. */
export function Sect({ title, on, onToggle, children, extra, cls = '' }) {
  return (
    <fieldset class={'au-sect ' + cls + (on === false ? ' off' : '')}>
      <legend>
        {onToggle ? <label><input type="checkbox" checked={!!on} onChange={(e) => onToggle(e.target.checked)} /> {title}</label> : title}
        {extra}
      </legend>
      {on !== false && children}
    </fieldset>
  );
}

/** Bind a key of an object: { value, onChange } (undefined deletes the key). */
export const bind = (obj, set, k) => ({ value: obj?.[k], onChange: (v) => set(setKey(obj, k, v)) });

export function LfoEdit({ value, onChange, depthLabel = 'profondeur', depthDef = DEF.lfo.depth, depthStep = 0.01 }) {
  const o = value ?? {};
  const b = (k) => bind(o, onChange, k);
  return (
    <div class="au-lfo">
      <R label="forme"><EnumField value={o.shape} options={LFO_SHAPES} allowEmpty onChange={(v) => onChange(setKey(o, 'shape', v))} /></R>
      <R label="vitesse (Hz)"><P {...b('rate')} def={DEF.lfo.rate} log step={0.01} min={0} /></R>
      <R label={depthLabel}><P {...b('depth')} def={depthDef} step={depthStep} /></R>
      <R label="phase"><P {...b('phase')} def={0} step={0.01} min={0} max={1} /></R>
      {o.shape === 'square' && <R label="rapport cyclique"><P {...b('duty')} def={0.5} step={0.01} min={0.01} max={0.99} /></R>}
    </div>
  );
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const fromList = (a) => (a.length === 0 ? undefined : a.length === 1 ? a[0] : a);

/** One filter or a chain of filters (in series). */
export function FilterList({ value, onChange }) {
  const list = asList(value);
  const put = (i, f) => { const a = [...list]; if (f === undefined) a.splice(i, 1); else a[i] = f; onChange(fromList(a)); };
  return (
    <div class="au-filters">
      {list.map((F, i) => {
        const f = F ?? {};
        const b = (k) => bind(f, (nf) => put(i, nf), k);
        const type = f.type ?? 'lowpass';
        return (
          <div class="au-filter">
            <div class="au-fhead">
              <EnumField value={type} options={FILTER_TYPES} onChange={(v) => put(i, { ...f, type: v ?? 'lowpass' })} />
              <span class="grow" />
              {i > 0 && <button class="au-mini" title="Monter (les filtres s'appliquent en série)" onClick={() => { const a = [...list]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; onChange(fromList(a)); }}>↑</button>}
              <button class="au-mini danger" title="Supprimer ce filtre" onClick={() => put(i, undefined)}>✕</button>
            </div>
            <R label="fréquence (Hz)"><P {...b('freq')} def={DEF.filter.freq} log step={1} min={10} max={20000} /></R>
            <R label="→ fin (Hz)" title="Balayage vers cette fréquence"><P {...b('freqEnd')} def={undefined} log step={1} min={10} max={20000} /></R>
            <R label="Q (résonance)"><P {...b('q')} def={type === 'bandpass' ? 1 : DEF.filter.q} log step={0.01} min={0.05} max={40} /></R>
            {f.freqEnd != null && <R label="balayage (s)" title="Durée du balayage (défaut : toute la couche)"><P {...b('sweep')} def={undefined} step={0.005} min={0} /></R>}
            {f.freqEnd != null && <R label="courbe" title="< 1 : rapide au début ; > 1 : lent au début"><P {...b('curve')} def={1} log step={0.01} min={0.05} max={20} /></R>}
            <div class="au-sub">
              <label><input type="checkbox" checked={!!f.lfo} onChange={(e) => put(i, setKey(f, 'lfo', e.target.checked ? { rate: 2, depth: 1 } : undefined))} /> LFO de coupure</label>
              {f.lfo && <LfoEdit value={f.lfo} onChange={(l) => put(i, { ...f, lfo: l })} depthLabel="prof. (octaves)" depthDef={0.5} />}
            </div>
          </div>
        );
      })}
      <button class="small" onClick={() => onChange(fromList([...list, { type: 'lowpass', freq: 2000 }]))}>+ Filtre</button>
    </div>
  );
}

/** Tremolo: one LFO or several (they multiply). */
export function LfoList({ value, onChange, add = { rate: 4, depth: 0.5 }, depthLabel }) {
  const list = asList(value);
  const put = (i, l) => { const a = [...list]; if (l === undefined) a.splice(i, 1); else a[i] = l; onChange(fromList(a)); };
  return (
    <div class="au-filters">
      {list.map((l, i) => (
        <div class="au-filter">
          <div class="au-fhead"><small>LFO {i + 1}</small><span class="grow" /><button class="au-mini danger" title="Supprimer" onClick={() => put(i, undefined)}>✕</button></div>
          <LfoEdit value={l} onChange={(nl) => put(i, nl)} depthLabel={depthLabel} />
        </div>
      ))}
      <button class="small" onClick={() => onChange(fromList([...list, add]))}>+ LFO</button>
    </div>
  );
}

const first = (v, d) => { const n = Array.isArray(v) ? +v[0] : +v; return v == null || !Number.isFinite(n) ? d : n; };

/** Envelope shape (attack, hold, decay to sustain, release) over the layer length. */
export function EnvGraph({ env, len, click }) {
  const W = 220, H = 46;
  const a = Math.max(0, first(env.attack, click ? 0 : 0.002)), h = Math.max(0, first(env.hold, 0)), d = Math.max(0, first(env.decay, 0.1));
  const s = Math.min(1, Math.max(0, first(env.sustain, 0))), r = Math.max(0, first(env.release, 0)), c = Math.max(0, first(env.curve, 4));
  const L = Math.max(1e-3, len ?? (s > 0 ? (a + h + d) * 1.6 + r : a + h + d));
  const ec = c > 0.01 ? Math.exp(-c) : 0, einv = ec ? 1 / (1 - ec) : 1;
  const pts = [];
  const N = 90;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * L;
    let v;
    if (t < a) v = t / a;
    else {
      const td = t - a - h;
      if (td <= 0) v = 1;
      else if (td < d) { const q = td / d; v = s + (1 - s) * (ec ? (Math.exp(-c * q) - ec) * einv : 1 - q); }
      else v = s;
    }
    if (r > 0 && L - t < r) v *= Math.max(0, (L - t) / r);
    pts.push(`${((i / N) * W).toFixed(1)},${(H - 2 - v * (H - 6)).toFixed(1)}`);
  }
  return (
    <div class="au-env">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <polyline points={`0,${H} ${pts.join(' ')} ${W},${H}`} class="fill" />
        <polyline points={pts.join(' ')} class="line" />
      </svg>
      <span>{L < 1 ? `${Math.round(L * 1000)} ms` : `${L.toFixed(2)} s`}</span>
    </div>
  );
}
