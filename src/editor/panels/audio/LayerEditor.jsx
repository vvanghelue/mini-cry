// The layer stack of a recipe (add / duplicate / delete / reorder / mute / solo) and the form of
// the selected layer.
import { useState } from 'preact/hooks';
import { EnumField, BoolField, JsonField, TextField } from '../../ui/Fields.jsx';
import { P, R, Sect, bind, setKey, FilterList, LfoEdit, LfoList, EnvGraph, CodeJson } from './fields.jsx';
import { formatSection } from './format.js';
import { LAYER_TYPES, LAYER_PRESETS, LAYER_COLORS, NOISE_COLORS, DEF } from './templates.js';
import { layerSummary } from './render.js';

const TONAL = ['sine', 'square', 'saw', 'triangle', 'fm'];
const TYPE_LABEL = { sine: 'sinus', noise: 'bruit', click: 'clic', square: 'carré', saw: 'dent de scie', triangle: 'triangle', fm: 'FM' };

export function LayerStack({ layers, sel, onSelect, onChange, solo, onSolo }) {
  const [adding, setAdding] = useState(false);
  const put = (a, nsel) => { onChange(a); if (nsel !== undefined) onSelect(nsel); };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= layers.length) return;
    const a = [...layers];
    [a[i], a[j]] = [a[j], a[i]];
    put(a, sel === i ? j : sel === j ? i : sel);
  };
  return (
    <div class="au-stack">
      {layers.map((L, i) => (
        <div class={'au-lrow' + (i === sel ? ' sel' : '') + (L?.mute ? ' muted' : '') + (solo != null && solo !== i ? ' dimmed' : '')} onClick={() => onSelect(i)}>
          <span class="au-dot" style={{ background: LAYER_COLORS[i % LAYER_COLORS.length] }} />
          <b>{i + 1}</b>
          <span class="au-ltype">{TYPE_LABEL[L?.type ?? 'sine'] ?? L?.type}</span>
          <small class="au-lsum">{layerSummary(L)}</small>
          <span class="au-lbtns" onClick={(e) => e.stopPropagation()}>
            <button class={'au-mini' + (L?.mute ? ' on' : '')} title="Muet (enregistré dans la recette)" onClick={() => { const a = [...layers]; a[i] = setKey(L, 'mute', L?.mute ? undefined : true); put(a); }}>M</button>
            <button class={'au-mini' + (solo === i ? ' on solo' : '')} title="Solo (aperçu seulement, non enregistré)" onClick={() => onSolo(solo === i ? null : i)}>S</button>
            <button class="au-mini" title="Monter" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button class="au-mini" title="Descendre" disabled={i === layers.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button class="au-mini" title="Dupliquer la couche" onClick={() => { const a = [...layers]; a.splice(i + 1, 0, structuredClone(L)); put(a, i + 1); }}>⧉</button>
            <button class="au-mini danger" title="Supprimer la couche" onClick={() => { const a = layers.filter((_, k) => k !== i); put(a, Math.max(0, Math.min(sel, a.length - 1))); }}>✕</button>
          </span>
        </div>
      ))}
      {!layers.length && <p class="hint">Aucune couche : le son est silencieux.</p>}
      <div class="au-addl">
        {adding
          ? <>{Object.keys(LAYER_PRESETS).map((t) => <button class="small" onClick={() => { put([...layers, structuredClone(LAYER_PRESETS[t])], layers.length); setAdding(false); }}>{TYPE_LABEL[t]}</button>)}<button class="small" onClick={() => setAdding(false)}>Annuler</button></>
          : <button class="small" onClick={() => setAdding(true)}>+ Couche</button>}
      </div>
    </div>
  );
}

export function LayerForm({ L, onChange, lenHint }) {
  const [raw, setRaw] = useState(false);
  if (!L || typeof L !== 'object') return <JsonField value={L} onChange={onChange} rows={6} />;
  const t = L.type ?? 'sine';
  const b = (k) => bind(L, onChange, k);
  const sub = (k, v) => onChange(setKey(L, k, v));
  const env = L.env, rep = L.repeat;
  const toggle = (
    <button class={'au-mini au-rawbtn' + (raw ? ' on' : '')} title="Éditer la couche en JSON brut" onClick={(e) => { e.preventDefault(); setRaw(!raw); }}>{'{ }'}</button>
  );
  if (raw) {
    return (
      <div class="au-lform raw">
        <Sect title="Couche (JSON)" extra={toggle}><CodeJson value={L} format={(v) => formatSection(v, 0)} onChange={(v) => (v && typeof v === 'object' && !Array.isArray(v) ? onChange(v) : null)} rows={12} /></Sect>
      </div>
    );
  }
  return (
    <div class="au-lform">
      <Sect title="Couche" extra={toggle}>
        <R label="type"><EnumField value={t} options={LAYER_TYPES.map((v) => ({ value: v, label: TYPE_LABEL[v] }))} onChange={(v) => onChange({ ...L, type: v ?? 'sine' })} /></R>
        <R label="début (s)" title="Quand la couche démarre"><P {...b('start')} def={0} step={0.001} min={0} /></R>
        <R label="longueur (s)" title="Défaut : attaque + maintien + déclin si sustain = 0, sinon jusqu'à la fin du son"><P {...b('length')} def={lenHint != null && Number.isFinite(lenHint) ? +lenHint.toFixed(3) : undefined} step={0.005} min={0} /></R>
        <R label="gain"><P {...b('gain')} def={1} step={0.01} min={0} /></R>
        <R label="distorsion" title="Saturation tanh 0..1 (compresse aussi : déclins plus percutants)"><P {...b('distortion')} def={0} step={0.01} min={0} max={1} /></R>
        <R label="muet"><BoolField value={L.mute} onChange={(v) => sub('mute', v || undefined)} /></R>
        {t === 'noise' && <R label="couleur"><EnumField value={L.noiseColor} options={NOISE_COLORS} allowEmpty onChange={(v) => sub('noiseColor', v)} /></R>}
        {t === 'click' && <R label="cadence (/s)" title="Impulsions par seconde (0 = une seule impulsion)"><P {...b('rate')} def={0} log step={0.1} min={0} /></R>}
        {t === 'click' && <R label="irrégularité" title="Aléa temporel 0..1"><P {...b('jitter')} def={0} step={0.01} min={0} max={1} /></R>}
      </Sect>
      {TONAL.includes(t) && (
        <Sect title="Hauteur">
          <R label="fréquence (Hz)"><P {...b('freq')} def={440} log step={0.1} min={0.01} max={20000} /></R>
          <R label="→ fin (Hz)" title="Glissement exponentiel vers cette fréquence"><P {...b('freqEnd')} def={undefined} log step={0.1} min={0.01} max={20000} /></R>
          {L.freqEnd != null && <R label="glissement (s)" title="Durée du glissement (défaut : toute la couche)"><P {...b('sweep')} def={undefined} step={0.005} min={0} /></R>}
          {L.freqEnd != null && <R label="courbe" title="< 1 : rapide au début (grosse caisse) ; > 1 : lent au début"><P {...b('curve')} def={1} log step={0.01} min={0.05} max={20} /></R>}
          {t === 'square' && <R label="rapport cyclique"><P {...b('duty')} def={0.5} step={0.01} min={0.02} max={0.98} /></R>}
        </Sect>
      )}
      {t === 'fm' && (
        <Sect title="FM" on={!!L.fm} onToggle={(on) => sub('fm', on ? { ratio: 1.4, index: 3 } : undefined)}>
          <R label="ratio" title="Fréquence du modulateur = freq × ratio"><P {...bind(L.fm, (v) => sub('fm', v), 'ratio')} def={DEF.fm.ratio} log step={0.01} min={0.01} /></R>
          <R label="index"><P {...bind(L.fm, (v) => sub('fm', v), 'index')} def={DEF.fm.index} step={0.05} min={0} /></R>
          <R label="index fin"><P {...bind(L.fm, (v) => sub('fm', v), 'indexEnd')} def={undefined} step={0.05} min={0} /></R>
        </Sect>
      )}
      {['sine', 'square', 'saw', 'triangle'].includes(t) && (
        <Sect title="Unisson" on={!!L.unison} onToggle={(on) => sub('unison', on ? { voices: 3, detune: 12 } : undefined)}>
          <R label="voix"><P {...bind(L.unison, (v) => sub('unison', v), 'voices')} def={1} int step={0.05} min={1} max={8} /></R>
          <R label="désaccord (cents)"><P {...bind(L.unison, (v) => sub('unison', v), 'detune')} def={10} step={0.2} min={0} /></R>
        </Sect>
      )}
      <Sect title="Enveloppe" on={!!env} onToggle={(on) => sub('env', on ? { attack: 0.002, decay: 0.2, curve: 4 } : undefined)}>
        {env && <EnvGraph env={env} len={L.length != null ? +[].concat(L.length)[0] : lenHint} click={t === 'click'} />}
        {['attack', 'hold', 'decay', 'sustain', 'release', 'curve'].map((k) => (
          <R label={{ attack: 'attaque (s)', hold: 'maintien (s)', decay: 'déclin (s)', sustain: 'sustain 0..1', release: 'relâche (s)', curve: 'courbe' }[k]}
            title={k === 'curve' ? '0 = déclin linéaire, plus haut = plus exponentiel' : k === 'sustain' ? 'Niveau tenu après le déclin (> 0 : la couche dure jusqu\'à la fin)' : undefined}>
            <P {...bind(env, (v) => sub('env', v), k)} def={k === 'attack' && t === 'click' ? 0 : DEF.env[k]} step={k === 'curve' ? 0.05 : k === 'sustain' ? 0.01 : 0.001} min={0} max={k === 'sustain' ? 1 : undefined} />
          </R>
        ))}
      </Sect>
      <Sect title="Filtres" cls="wide">
        <FilterList value={L.filter} onChange={(v) => sub('filter', v)} />
      </Sect>
      {TONAL.includes(t) && (
        <Sect title="Vibrato" on={!!L.vibrato} onToggle={(on) => sub('vibrato', on ? { rate: 5, depth: 0.3 } : undefined)}>
          <LfoEdit value={L.vibrato} onChange={(v) => sub('vibrato', v)} depthLabel="prof. (demi-tons)" depthDef={0.5} />
        </Sect>
      )}
      <Sect title="Trémolo">
        <LfoList value={L.tremolo} onChange={(v) => sub('tremolo', v)} depthLabel="prof. 0..1" />
      </Sect>
      <Sect title="Répétition" on={!!rep} onToggle={(on) => sub('repeat', on ? { count: 3, interval: 0.1 } : undefined)}>
        {['count', 'interval', 'jitter', 'pitch', 'gain'].map((k) => (
          <R label={{ count: 'nombre', interval: 'intervalle (s)', jitter: 'aléa (s)', pitch: 'hauteur ×', gain: 'gain ×' }[k]}
            title={{ pitch: 'Multiplie la hauteur à chaque copie', gain: 'Multiplie le gain à chaque copie', jitter: 'Retard aléatoire 0..aléa s par copie' }[k]}>
            <P {...bind(rep, (v) => sub('repeat', v), k)} def={DEF.repeat[k]} int={k === 'count'} step={k === 'count' ? 0.1 : k === 'interval' || k === 'jitter' ? 0.001 : 0.01} min={k === 'count' ? 1 : 0} max={k === 'count' ? 256 : undefined} />
          </R>
        ))}
        <R label="notes" title="Demi-tons, joués en boucle : remplace la progression de hauteur (arpèges)">
          <TextField value={Array.isArray(rep?.notes) ? rep.notes.join(' ') : ''} placeholder="ex. 0 4 7"
            onChange={(s) => { const a = s.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite); sub('repeat', setKey(rep, 'notes', a.length ? a : undefined)); }} />
        </R>
      </Sect>
    </div>
  );
}
