// The layer stack of a recipe (add / duplicate / delete / reorder / mute / solo) and the form of
// the selected layer.
import { useState } from 'preact/hooks';
import { EnumField, BoolField, JsonField, TextField } from '../../ui/Fields.jsx';
import { P, R, Sect, bind, setKey, FilterList, LfoEdit, LfoList, EnvGraph, CodeJson } from './fields.jsx';
import { formatSection } from './format.js';
import { LAYER_TYPES, LAYER_PRESETS, LAYER_COLORS, NOISE_COLORS, DEF } from './templates.js';
import { layerSummary } from './render.js';

const TONAL = ['sine', 'square', 'saw', 'triangle', 'fm'];
const TYPE_LABEL = { sine: 'sine', noise: 'noise', click: 'click', square: 'square', saw: 'saw', triangle: 'triangle', fm: 'FM', sample: 'sample' };

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
            <button class={'au-mini' + (L?.mute ? ' on' : '')} title="Mute (saved in the recipe)" onClick={() => { const a = [...layers]; a[i] = setKey(L, 'mute', L?.mute ? undefined : true); put(a); }}>M</button>
            <button class={'au-mini' + (solo === i ? ' on solo' : '')} title="Solo (preview only, not saved)" onClick={() => onSolo(solo === i ? null : i)}>S</button>
            <button class="au-mini" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button class="au-mini" title="Move down" disabled={i === layers.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button class="au-mini" title="Duplicate the layer" onClick={() => { const a = [...layers]; a.splice(i + 1, 0, structuredClone(L)); put(a, i + 1); }}>⧉</button>
            <button class="au-mini danger" title="Delete the layer" onClick={() => { const a = layers.filter((_, k) => k !== i); put(a, Math.max(0, Math.min(sel, a.length - 1))); }}>✕</button>
          </span>
        </div>
      ))}
      {!layers.length && <p class="hint">No layers: the sound is silent.</p>}
      <div class="au-addl">
        {adding
          ? <>{Object.keys(LAYER_PRESETS).map((t) => <button class="small" onClick={() => { put([...layers, structuredClone(LAYER_PRESETS[t])], layers.length); setAdding(false); }}>{TYPE_LABEL[t]}</button>)}<button class="small" onClick={() => setAdding(false)}>Cancel</button></>
          : <button class="small" onClick={() => setAdding(true)}>+ Layer</button>}
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
    <button class={'au-mini au-rawbtn' + (raw ? ' on' : '')} title="Edit the layer as raw JSON" onClick={(e) => { e.preventDefault(); setRaw(!raw); }}>{'{ }'}</button>
  );
  if (raw) {
    return (
      <div class="au-lform raw">
        <Sect title="Layer (JSON)" extra={toggle}><CodeJson value={L} format={(v) => formatSection(v, 0)} onChange={(v) => (v && typeof v === 'object' && !Array.isArray(v) ? onChange(v) : null)} rows={12} /></Sect>
      </div>
    );
  }
  return (
    <div class="au-lform">
      <Sect title="Layer" extra={toggle}>
        <R label="type"><EnumField value={t} options={LAYER_TYPES.map((v) => ({ value: v, label: TYPE_LABEL[v] }))} onChange={(v) => onChange({ ...L, type: v ?? 'sine' })} /></R>
        <R label="start (s)" title="When the layer starts"><P {...b('start')} def={0} step={0.001} min={0} /></R>
        <R label="length (s)" title="Default: attack + hold + decay if sustain = 0, otherwise until the end of the sound"><P {...b('length')} def={lenHint != null && Number.isFinite(lenHint) ? +lenHint.toFixed(3) : undefined} step={0.005} min={0} /></R>
        <R label="gain"><P {...b('gain')} def={1} step={0.01} min={0} /></R>
        <R label="distortion" title="tanh saturation 0..1 (also compresses: punchier decays)"><P {...b('distortion')} def={0} step={0.01} min={0} max={1} /></R>
        <R label="mute"><BoolField value={L.mute} onChange={(v) => sub('mute', v || undefined)} /></R>
        {t === 'noise' && <R label="color"><EnumField value={L.noiseColor} options={NOISE_COLORS} allowEmpty onChange={(v) => sub('noiseColor', v)} /></R>}
        {t === 'click' && <R label="rate (/s)" title="Impulses per second (0 = a single impulse)"><P {...b('rate')} def={0} log step={0.1} min={0} /></R>}
        {t === 'click' && <R label="jitter" title="Timing randomness 0..1"><P {...b('jitter')} def={0} step={0.01} min={0} max={1} /></R>}
        {t === 'sample' && (
          <R label="file(s)" title="WAV path(s) relative to public/data, e.g. sfx/ak47_1.wav. Several (space separated): variation k plays file k % n">
            <TextField value={[].concat(L.file ?? []).join(' ')} placeholder="sfx/name.wav"
              onChange={(s) => { const a = s.split(/[\s,;]+/).filter(Boolean); sub('file', a.length > 1 ? a : a[0]); }} />
          </R>
        )}
        {t === 'sample' && <R label="offset (s)" title="Start position inside the file"><P {...b('offset')} def={0} step={0.001} min={0} /></R>}
        {t === 'sample' && <R label="pitch ×" title="Playback rate (also changes the length)"><P {...b('pitch')} def={1} log step={0.01} min={0.05} max={8} /></R>}
      </Sect>
      {TONAL.includes(t) && (
        <Sect title="Pitch">
          <R label="frequency (Hz)"><P {...b('freq')} def={440} log step={0.1} min={0.01} max={20000} /></R>
          <R label="→ end (Hz)" title="Exponential glide toward this frequency"><P {...b('freqEnd')} def={undefined} log step={0.1} min={0.01} max={20000} /></R>
          {L.freqEnd != null && <R label="glide (s)" title="Glide duration (default: the whole layer)"><P {...b('sweep')} def={undefined} step={0.005} min={0} /></R>}
          {L.freqEnd != null && <R label="curve" title="< 1: fast at first (kick drum); > 1: slow at first"><P {...b('curve')} def={1} log step={0.01} min={0.05} max={20} /></R>}
          {t === 'square' && <R label="duty cycle"><P {...b('duty')} def={0.5} step={0.01} min={0.02} max={0.98} /></R>}
        </Sect>
      )}
      {t === 'fm' && (
        <Sect title="FM" on={!!L.fm} onToggle={(on) => sub('fm', on ? { ratio: 1.4, index: 3 } : undefined)}>
          <R label="ratio" title="Modulator frequency = freq × ratio"><P {...bind(L.fm, (v) => sub('fm', v), 'ratio')} def={DEF.fm.ratio} log step={0.01} min={0.01} /></R>
          <R label="index"><P {...bind(L.fm, (v) => sub('fm', v), 'index')} def={DEF.fm.index} step={0.05} min={0} /></R>
          <R label="end index"><P {...bind(L.fm, (v) => sub('fm', v), 'indexEnd')} def={undefined} step={0.05} min={0} /></R>
        </Sect>
      )}
      {['sine', 'square', 'saw', 'triangle'].includes(t) && (
        <Sect title="Unison" on={!!L.unison} onToggle={(on) => sub('unison', on ? { voices: 3, detune: 12 } : undefined)}>
          <R label="voices"><P {...bind(L.unison, (v) => sub('unison', v), 'voices')} def={1} int step={0.05} min={1} max={8} /></R>
          <R label="detune (cents)"><P {...bind(L.unison, (v) => sub('unison', v), 'detune')} def={10} step={0.2} min={0} /></R>
        </Sect>
      )}
      <Sect title="Envelope" on={!!env} onToggle={(on) => sub('env', on ? { attack: 0.002, decay: 0.2, curve: 4 } : undefined)}>
        {env && <EnvGraph env={env} len={L.length != null ? +[].concat(L.length)[0] : lenHint} click={t === 'click'} />}
        {['attack', 'hold', 'decay', 'sustain', 'release', 'curve'].map((k) => (
          <R label={{ attack: 'attack (s)', hold: 'hold (s)', decay: 'decay (s)', sustain: 'sustain 0..1', release: 'release (s)', curve: 'curve' }[k]}
            title={k === 'curve' ? '0 = linear decay, higher = more exponential' : k === 'sustain' ? 'Level held after the decay (> 0: the layer lasts until the end)' : undefined}>
            <P {...bind(env, (v) => sub('env', v), k)} def={k === 'attack' && t === 'click' ? 0 : DEF.env[k]} step={k === 'curve' ? 0.05 : k === 'sustain' ? 0.01 : 0.001} min={0} max={k === 'sustain' ? 1 : undefined} />
          </R>
        ))}
      </Sect>
      <Sect title="Filters" cls="wide">
        <FilterList value={L.filter} onChange={(v) => sub('filter', v)} />
      </Sect>
      {TONAL.includes(t) && (
        <Sect title="Vibrato" on={!!L.vibrato} onToggle={(on) => sub('vibrato', on ? { rate: 5, depth: 0.3 } : undefined)}>
          <LfoEdit value={L.vibrato} onChange={(v) => sub('vibrato', v)} depthLabel="depth (semitones)" depthDef={0.5} />
        </Sect>
      )}
      <Sect title="Tremolo">
        <LfoList value={L.tremolo} onChange={(v) => sub('tremolo', v)} depthLabel="depth 0..1" />
      </Sect>
      <Sect title="Repeat" on={!!rep} onToggle={(on) => sub('repeat', on ? { count: 3, interval: 0.1 } : undefined)}>
        {['count', 'interval', 'jitter', 'pitch', 'gain'].map((k) => (
          <R label={{ count: 'count', interval: 'interval (s)', jitter: 'jitter (s)', pitch: 'pitch ×', gain: 'gain ×' }[k]}
            title={{ pitch: 'Multiplies the pitch at each copy', gain: 'Multiplies the gain at each copy', jitter: 'Random delay of 0..jitter s per copy' }[k]}>
            <P {...bind(rep, (v) => sub('repeat', v), k)} def={DEF.repeat[k]} int={k === 'count'} step={k === 'count' ? 0.1 : k === 'interval' || k === 'jitter' ? 0.001 : 0.01} min={k === 'count' ? 1 : 0} max={k === 'count' ? 256 : undefined} />
          </R>
        ))}
        <R label="notes" title="Semitones, played in a loop: replaces the pitch progression (arpeggios)">
          <TextField value={Array.isArray(rep?.notes) ? rep.notes.join(' ') : ''} placeholder="e.g. 0 4 7"
            onChange={(s) => { const a = s.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite); sub('repeat', setKey(rep, 'notes', a.length ? a : undefined)); }} />
        </R>
      </Sect>
    </div>
  );
}
