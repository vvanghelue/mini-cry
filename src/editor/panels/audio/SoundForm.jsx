// Sound-level settings of a recipe: timing / level, effects, variations, spatial & voices.
import { EnumField, BoolField } from '../../ui/Fields.jsx';
import { P, R, Sect, bind, setKey, FilterList } from './fields.jsx';
import { BUSES, DEF } from './templates.js';

export function SoundForm({ r, onChange, dry }) {
  const b = (k) => bind(r, onChange, k);
  const sub = (k, v) => onChange(setKey(r, k, v));
  const echo = r.echo, va = r.variations;
  const vb = (k) => bind(va, (v) => sub('variations', Object.keys(v).length ? v : undefined), k);
  return (
    <div class="au-sform">
      <Sect title="Sound">
        <R label="bus" title="sfx: effects (filtered underwater) · ambient · music · ui (not spatialized)"><EnumField value={r.bus} options={BUSES} allowEmpty onChange={(v) => sub('bus', v)} /></R>
        <R label="duration (s)" title="Dry length (default: end of the last layer). For a loop: the loop length."><P {...b('duration')} def={+dry.toFixed(3)} step={0.005} min={0.01} max={60} /></R>
        <R label="gain (peak)" title="Output peak 0..1: the mix is normalized then multiplied"><P {...b('gain')} def={DEF.sound.gain} step={0.01} min={0} max={4} /></R>
        <R label="normalize" title="Off: keeps the raw level of the mix (× gain)"><BoolField value={r.normalize !== false} onChange={(v) => sub('normalize', v ? undefined : false)} /></R>
        <R label="loop" title="Renders a seamless loop (crossfades the end into the start)"><BoolField value={!!r.loop} onChange={(v) => sub('loop', v || undefined)} /></R>
        {r.loop && <R label="loop fade (s)"><P {...b('loopFade')} def={+Math.min(0.5, dry / 4).toFixed(3)} step={0.005} min={0.005} /></R>}
        {!r.loop && <R label="tail (s)" title="Time rendered after the duration for the reverb / echo (default: automatic)"><P {...b('tail')} def={undefined} step={0.01} min={0} max={8} /></R>}
      </Sect>
      <Sect title="Effects">
        <R label="distortion"><P {...b('distortion')} def={0} step={0.01} min={0} max={1} /></R>
        <R label="reverb"><P {...b('reverb')} def={0} step={0.01} min={0} max={1} /></R>
        {r.reverb != null && r.reverb !== 0 && <R label="size"><P {...b('reverbSize')} def={DEF.sound.reverbSize} step={0.01} min={0} max={1} /></R>}
        {r.reverb != null && r.reverb !== 0 && <R label="damping"><P {...b('reverbDamp')} def={DEF.sound.reverbDamp} step={0.01} min={0} max={0.95} /></R>}
        <div class="au-sub">
          <label><input type="checkbox" checked={!!echo} onChange={(e) => sub('echo', e.target.checked ? { time: 0.3, feedback: 0.35, mix: 0.4, lowpass: 2500 } : undefined)} /> Echo</label>
          {echo && ['time', 'feedback', 'mix', 'lowpass'].map((k) => (
            <R label={{ time: 'time (s)', feedback: 'feedback', mix: 'mix', lowpass: 'lowpass (Hz)' }[k]}>
              <P {...bind(echo, (v) => sub('echo', v), k)} def={DEF.echo[k]} log={k === 'lowpass'} step={k === 'lowpass' ? 1 : 0.005} min={k === 'lowpass' ? 50 : 0} max={k === 'feedback' ? 0.9 : k === 'mix' ? 1 : k === 'time' ? 2 : 20000} />
            </R>
          ))}
        </div>
        <div class="au-sub">
          <small>Filter(s) on the whole mix</small>
          <FilterList value={r.filter} onChange={(v) => sub('filter', v)} />
        </div>
      </Sect>
      <Sect title="Variations">
        <R label="count" title="Variants rendered with different seeds (1..8)"><P {...vb('count')} range={false} def={r.loop ? 1 : 3} int step={0.05} min={1} max={8} /></R>
        <R label="pitch" title="Random playback rate [min, max] drawn on each play"><P {...vb('pitch')} def={1} step={0.005} min={0.05} max={4} /></R>
        <R label="gain" title="Random volume [min, max] drawn on each play"><P {...vb('gain')} def={1} step={0.01} min={0} max={2} /></R>
      </Sect>
      <Sect title="Spatial & voices">
        <R label="ref. distance (m)" title="Distance at which the sound is at full volume"><P {...b('refDistance')} range={false} def={DEF.sound.refDistance} step={0.1} min={0.1} /></R>
        <R label="max distance (m)" title="Beyond it, one-shot sounds are not played"><P {...b('maxDistance')} range={false} def={DEF.sound.maxDistance} step={1} min={1} /></R>
        <R label="rolloff" title="rolloff (inverse distance model)"><P {...b('rolloff')} range={false} def={DEF.sound.rolloff} step={0.01} min={0} /></R>
        <R label="priority" title="Voice stealing: the voice with the lowest priority × 4 + audibility is cut"><P {...b('priority')} range={false} def={0} int step={0.05} /></R>
        <R label="max instances" title="Number of simultaneous instances of this sound (the oldest one makes way)"><P {...b('maxInstances')} range={false} def={DEF.sound.maxInstances} int step={0.05} min={1} /></R>
      </Sect>
    </div>
  );
}
