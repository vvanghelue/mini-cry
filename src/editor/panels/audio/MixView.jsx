// Top-level `music` and `ambient` tuning of sounds.json, and a live test of the generative music
// (intensity) and of the ambient soundscape (night / jungle / coast / underwater...).
import { useEffect, useState } from 'preact/hooks';
import { TextField, BoolField } from '../../ui/Fields.jsx';
import { P, R, Sect, setKey } from './fields.jsx';
import { A, setSection } from './store.js';
import { test, startTest, stopTest } from './player.js';

// Mirrors of the defaults in Audio.js (placeholders only)
const MUSIC = {
  bpm: 96, padRoot: 57, pluckRoot: 69, bassRoot: 33, barsPerChord: 2,
  chords: [[57, 60, 64, 71], [53, 57, 60, 64], [55, 60, 64, 71], [55, 59, 62, 64]],
  scale: [69, 72, 74, 76, 79, 81, 84],
  phraseChords: [6, 10], restSeconds: [25, 50], firstDelay: 6, pluckDensity: 0.12,
  levels: { pad: 0.14, pluck: 0.18, drum_low: 0.45, drum_high: 0.3, shaker: 0.18, log: 0.25, bass: 0.35, drone: 0.3 },
  patterns: { drum_low: 'x..x..x...x.x...', drum_high: '....x.......x.o?', shaker: 'xoxoxoxoxoxoxoxo', log: '..?...x...?..x.?', bass: 'x.......x..?....' },
};
const AMB = {
  oceanRange: 220,
  beds: { ocean: 1, wind: 0.8, cicadas: 0.55, frogs: 0.6, crickets: 0.5, underwater: 0.9 },
  sounds: { ocean: 'ocean_waves', wind: 'wind', cicadas: 'cicadas', frogs: 'frogs', crickets: 'crickets', underwater: 'underwater', bird: 'bird_chirp', parrot: 'parrot_call', gull: 'gull_call', owl: 'owl_hoot' },
  birdsPerMinute: 16, parrotShare: 0.25, gullsPerMinute: 6, owlsPerMinute: 1.5,
};
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m) => `${NOTE[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const STEP_NEXT = { '.': 'x', x: 'o', o: '?', '?': '.' };
const STEP_LABEL = { x: 'hit', o: 'soft', '?': 'random', '.': 'rest' };

function Steps({ value, onChange }) {
  const s = String(value ?? '').padEnd(16, '.').slice(0, 16).split('');
  return (
    <span class="au-steps">
      {s.map((c, i) => (
        <button class={'au-step s' + ({ x: 'x', o: 'o', '?': 'q', '.': 'r' }[c] ?? 'r') + (i % 4 === 0 ? ' beat' : '')} title={`step ${i + 1}: ${STEP_LABEL[c] ?? c} (click: change, right-click: rest)`}
          onClick={() => { const a = [...s]; a[i] = STEP_NEXT[c] ?? 'x'; onChange(a.join('')); }}
          onContextMenu={(e) => { e.preventDefault(); const a = [...s]; a[i] = '.'; onChange(a.join('')); }}>{c === '.' ? '' : c}</button>
      ))}
    </span>
  );
}

const parseNums = (s) => s.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite);

export function MixView({ ed, actions }) {
  const doc = A.doc.value;
  if (actions) actions.current.toggle = () => (test.on.value ? stopTest() : startTest(A.doc.value));
  const m = doc.music ?? {}, am = doc.ambient ?? {};
  const setM = (k, v) => setSection(ed, 'music', setKey(m, k, v));
  const setA = (k, v) => setSection(ed, 'ambient', setKey(am, k, v));
  const sub = (obj, setTop, k) => (kk, v) => setTop(k, Object.keys(setKey(obj, kk, v)).length ? setKey(obj, kk, v) : undefined);
  const setLevel = sub(m.levels, setM, 'levels'), setPat = sub(m.patterns, setM, 'patterns');
  const setBed = sub(am.beds, setA, 'beds'), setSnd = sub(am.sounds, setA, 'sounds');
  const names = Object.keys(doc.sounds);
  const chords = m.chords ?? MUSIC.chords;
  return (
    <div class="au-main au-mix">
      <div class="au-head">
        <h3>Music & ambience</h3>
        <span class="hint">Global settings of sounds.json (<code>music</code> and <code>ambient</code> sections). The sounds themselves (music_*, ocean_waves…) are edited in the list.</span>
      </div>
      <div class="au-mixgrid">
        <div class="au-col">
          <Sect title="Generative music">
            <R label="tempo (bpm)"><P value={m.bpm} onChange={(v) => setM('bpm', v)} range={false} def={MUSIC.bpm} step={0.5} min={30} max={240} /></R>
            <R label="bars / chord"><P value={m.barsPerChord} onChange={(v) => setM('barsPerChord', v)} range={false} def={MUSIC.barsPerChord} int step={0.05} min={1} /></R>
            <R label="chords (MIDI)" title="Chords separated by |, MIDI notes separated by spaces">
              <TextField value={(m.chords ?? []).map((c) => c.join(' ')).join(' | ')} placeholder={MUSIC.chords.map((c) => c.join(' ')).join(' | ')}
                onChange={(s) => { const c = s.split('|').map(parseNums).filter((a) => a.length); setM('chords', c.length ? c : undefined); }} />
            </R>
            <p class="hint au-notes">{chords.map((c) => c.map(noteName).join(' ')).join('  |  ')}</p>
            <R label="scale (MIDI)" title="Pluck notes (kalimba)">
              <TextField value={(m.scale ?? []).join(' ')} placeholder={MUSIC.scale.join(' ')} onChange={(s) => { const a = parseNums(s); setM('scale', a.length ? a : undefined); }} />
            </R>
            <R label="roots" title="Reference MIDI note of the music_pad / music_pluck / music_bass sounds (pitch at playback rate 1)">
              <span class="au-p">
                <P value={m.padRoot} onChange={(v) => setM('padRoot', v)} range={false} def={MUSIC.padRoot} int step={0.1} title="pad" />
                <P value={m.pluckRoot} onChange={(v) => setM('pluckRoot', v)} range={false} def={MUSIC.pluckRoot} int step={0.1} title="pluck" />
                <P value={m.bassRoot} onChange={(v) => setM('bassRoot', v)} range={false} def={MUSIC.bassRoot} int step={0.1} title="bass" />
              </span>
            </R>
            <R label="phrase (chords)"><P value={m.phraseChords} onChange={(v) => setM('phraseChords', v)} def={8} int step={0.05} min={1} /></R>
            <R label="rest (s)" title="Silence between two calm phrases"><P value={m.restSeconds} onChange={(v) => setM('restSeconds', v)} def={30} step={0.5} min={0} /></R>
            <R label="first delay (s)"><P value={m.firstDelay} onChange={(v) => setM('firstDelay', v)} range={false} def={MUSIC.firstDelay} step={0.1} min={0} /></R>
            <R label="pluck density"><P value={m.pluckDensity} onChange={(v) => setM('pluckDensity', v)} range={false} def={MUSIC.pluckDensity} step={0.005} min={0} max={1} /></R>
          </Sect>
          <Sect title="Levels">
            {Object.keys(MUSIC.levels).map((k) => (
              <R label={k}><P value={m.levels?.[k]} onChange={(v) => setLevel(k, v)} range={false} def={MUSIC.levels[k]} step={0.005} min={0} max={2} /></R>
            ))}
          </Sect>
          <Sect title="Combat patterns (16 steps)">
            <p class="hint">x hit · o soft · ? random (more frequent as the intensity rises) · right-click: rest</p>
            {Object.keys(MUSIC.patterns).map((k) => (
              <div class="au-patrow"><span class="lbl">{k}</span><Steps value={m.patterns?.[k] ?? MUSIC.patterns[k]} onChange={(v) => setPat(k, v)} /></div>
            ))}
          </Sect>
        </div>
        <div class="au-col">
          <Sect title="Ambience">
            <R label="ocean range (m)" title="The surf fades out at this distance from the coast"><P value={am.oceanRange} onChange={(v) => setA('oceanRange', v)} range={false} def={AMB.oceanRange} step={1} min={1} /></R>
            <R label="birds / min"><P value={am.birdsPerMinute} onChange={(v) => setA('birdsPerMinute', v)} range={false} def={AMB.birdsPerMinute} step={0.1} min={0} /></R>
            <R label="parrot share"><P value={am.parrotShare} onChange={(v) => setA('parrotShare', v)} range={false} def={AMB.parrotShare} step={0.01} min={0} max={1} /></R>
            <R label="gulls / min"><P value={am.gullsPerMinute} onChange={(v) => setA('gullsPerMinute', v)} range={false} def={AMB.gullsPerMinute} step={0.1} min={0} /></R>
            <R label="owls / min"><P value={am.owlsPerMinute} onChange={(v) => setA('owlsPerMinute', v)} range={false} def={AMB.owlsPerMinute} step={0.05} min={0} /></R>
          </Sect>
          <Sect title="Bed levels">
            {Object.keys(AMB.beds).map((k) => (
              <R label={k}><P value={am.beds?.[k]} onChange={(v) => setBed(k, v)} range={false} def={AMB.beds[k]} step={0.01} min={0} max={2} /></R>
            ))}
          </Sect>
          <Sect title="Sounds used">
            {Object.keys(AMB.sounds).map((k) => (
              <R label={k}>
                <select value={am.sounds?.[k] ?? ''} onChange={(e) => setSnd(k, e.target.value === '' || e.target.value === AMB.sounds[k] ? undefined : e.target.value)}>
                  <option value="">{AMB.sounds[k]} (default)</option>
                  {names.filter((n) => n !== AMB.sounds[k]).map((n) => <option value={n}>{n}</option>)}
                </select>
                {!(am.sounds?.[k] ?? AMB.sounds[k]) || doc.sounds[am.sounds?.[k] ?? AMB.sounds[k]] ? null : <small class="err" title="Sound not found">!</small>}
              </R>
            ))}
          </Sect>
        </div>
        <div class="au-col">
          <TestPanel />
        </div>
      </div>
    </div>
  );
}

/** Live test of music intensity and ambient states (an AudioSystem updated every frame by the panel). */
export function TestPanel({ compact }) {
  const on = test.on.value;
  const st = test.state.value;
  const set = (k, v) => (test.state.value = { ...test.state.value, [k]: v });
  const stats = test.stats.value;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => { test.stats.value = test.sys?.stats ?? null; tick((n) => n + 1); }, 250);
    return () => clearInterval(id);
  }, [on]);
  const slider = (label, k, min, max, step, title) => (
    <R label={label} title={title}>
      <input type="range" min={min} max={max} step={step} value={st[k]} onInput={(e) => set(k, +e.target.value)} />
      <code class="au-sv">{st[k]}</code>
    </R>
  );
  return (
    <Sect title="Live test" cls="au-test">
      <div class="btns">
        {on
          ? <button class="on" onClick={stopTest}>⏹ Stop the test</button>
          : <button onClick={() => startTest(A.doc.value)}>▶ Play music & ambience</button>}
      </div>
      {!compact && <p class="hint">Plays the generative music and the ambience with the current settings (changes apply live, including to the bed sounds). The calm music alternates phrases and silences.</p>}
      <R label="music intensity" title="setMusicIntensity: 0 = calm pads, 1 = combat percussion">
        <input type="range" min={0} max={1} step={0.01} value={test.intensity.value} onInput={(e) => { test.intensity.value = +e.target.value; test.sys?.setMusicIntensity(+e.target.value); }} />
        <code class="au-sv">{test.intensity.value.toFixed(2)}</code>
      </R>
      <R label="music volume">
        <input type="range" min={0} max={1.5} step={0.01} value={test.musicVol.value} onInput={(e) => { test.musicVol.value = +e.target.value; test.sys?.setVolume('music', +e.target.value); }} />
        <code class="au-sv">{test.musicVol.value.toFixed(2)}</code>
      </R>
      <R label="ambience volume">
        <input type="range" min={0} max={1.5} step={0.01} value={test.ambientVol.value} onInput={(e) => { test.ambientVol.value = +e.target.value; test.sys?.setVolume('ambient', +e.target.value); }} />
        <code class="au-sv">{test.ambientVol.value.toFixed(2)}</code>
      </R>
      {slider('night', 'night', 0, 1, 0.01, '0 = day (cicadas, birds), 1 = night (frogs, crickets, owls)')}
      {slider('jungle', 'inJungle', 0, 1, 0.01, 'Jungle density (insects, birds, parrots; dampens the wind)')}
      {slider('coast distance (m)', 'coastDistance', 0, 400, 1, 'Surf and gulls near the coast')}
      {slider('altitude (m)', 'height', 0, 200, 1, 'The wind picks up from 15 m to 140 m')}
      {slider('combat', 'combat', 0, 1, 0.01, 'Silences the wildlife and raises the music intensity')}
      <R label="underwater"><BoolField value={st.underwater} onChange={(v) => set('underwater', v)} /></R>
      <R label="indoor"><BoolField value={st.indoor} onChange={(v) => set('indoor', v)} /></R>
      {on && stats && (
        <div class="au-stats">
          <div><small>state</small> {stats.state} · voices {stats.voices} · notes {stats.musicNotes}</div>
          <div><small>music</small> intensity {stats.music.intensity} · calm {stats.music.calm}{stats.music.resting ? ' (resting)' : ''} · combat {stats.music.combat}</div>
          {Object.entries(stats.beds).map(([k, v]) => (
            <div class="au-bed"><span>{k}</span><i style={{ width: Math.min(100, v * 100) + '%' }} /><code>{v}</code></div>
          ))}
        </div>
      )}
    </Sect>
  );
}
