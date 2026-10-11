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
const NOTE = ['do', 'do#', 'ré', 'ré#', 'mi', 'fa', 'fa#', 'sol', 'sol#', 'la', 'la#', 'si'];
const noteName = (m) => `${NOTE[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const STEP_NEXT = { '.': 'x', x: 'o', o: '?', '?': '.' };
const STEP_LABEL = { x: 'frappe', o: 'douce', '?': 'aléatoire', '.': 'silence' };

function Steps({ value, onChange }) {
  const s = String(value ?? '').padEnd(16, '.').slice(0, 16).split('');
  return (
    <span class="au-steps">
      {s.map((c, i) => (
        <button class={'au-step s' + ({ x: 'x', o: 'o', '?': 'q', '.': 'r' }[c] ?? 'r') + (i % 4 === 0 ? ' beat' : '')} title={`pas ${i + 1} : ${STEP_LABEL[c] ?? c} (clic : changer, clic droit : silence)`}
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
        <h3>Musique & ambiance</h3>
        <span class="hint">Réglages globaux de sounds.json (sections <code>music</code> et <code>ambient</code>). Les sons eux-mêmes (music_*, ocean_waves…) s'éditent dans la liste.</span>
      </div>
      <div class="au-mixgrid">
        <div class="au-col">
          <Sect title="Musique générative">
            <R label="tempo (bpm)"><P value={m.bpm} onChange={(v) => setM('bpm', v)} range={false} def={MUSIC.bpm} step={0.5} min={30} max={240} /></R>
            <R label="mesures / accord"><P value={m.barsPerChord} onChange={(v) => setM('barsPerChord', v)} range={false} def={MUSIC.barsPerChord} int step={0.05} min={1} /></R>
            <R label="accords (MIDI)" title="Accords séparés par |, notes MIDI séparées par des espaces">
              <TextField value={(m.chords ?? []).map((c) => c.join(' ')).join(' | ')} placeholder={MUSIC.chords.map((c) => c.join(' ')).join(' | ')}
                onChange={(s) => { const c = s.split('|').map(parseNums).filter((a) => a.length); setM('chords', c.length ? c : undefined); }} />
            </R>
            <p class="hint au-notes">{chords.map((c) => c.map(noteName).join(' ')).join('  |  ')}</p>
            <R label="gamme (MIDI)" title="Notes des pincements (kalimba)">
              <TextField value={(m.scale ?? []).join(' ')} placeholder={MUSIC.scale.join(' ')} onChange={(s) => { const a = parseNums(s); setM('scale', a.length ? a : undefined); }} />
            </R>
            <R label="racines" title="Note MIDI de référence des sons music_pad / music_pluck / music_bass (hauteur à vitesse 1)">
              <span class="au-p">
                <P value={m.padRoot} onChange={(v) => setM('padRoot', v)} range={false} def={MUSIC.padRoot} int step={0.1} title="pad" />
                <P value={m.pluckRoot} onChange={(v) => setM('pluckRoot', v)} range={false} def={MUSIC.pluckRoot} int step={0.1} title="pluck" />
                <P value={m.bassRoot} onChange={(v) => setM('bassRoot', v)} range={false} def={MUSIC.bassRoot} int step={0.1} title="basse" />
              </span>
            </R>
            <R label="phrase (accords)"><P value={m.phraseChords} onChange={(v) => setM('phraseChords', v)} def={8} int step={0.05} min={1} /></R>
            <R label="silence (s)" title="Silence entre deux phrases calmes"><P value={m.restSeconds} onChange={(v) => setM('restSeconds', v)} def={30} step={0.5} min={0} /></R>
            <R label="1re attente (s)"><P value={m.firstDelay} onChange={(v) => setM('firstDelay', v)} range={false} def={MUSIC.firstDelay} step={0.1} min={0} /></R>
            <R label="densité pincements"><P value={m.pluckDensity} onChange={(v) => setM('pluckDensity', v)} range={false} def={MUSIC.pluckDensity} step={0.005} min={0} max={1} /></R>
          </Sect>
          <Sect title="Niveaux">
            {Object.keys(MUSIC.levels).map((k) => (
              <R label={k}><P value={m.levels?.[k]} onChange={(v) => setLevel(k, v)} range={false} def={MUSIC.levels[k]} step={0.005} min={0} max={2} /></R>
            ))}
          </Sect>
          <Sect title="Motifs de combat (16 pas)">
            <p class="hint">x frappe · o douce · ? aléatoire (plus fréquent quand l'intensité monte) · clic droit : silence</p>
            {Object.keys(MUSIC.patterns).map((k) => (
              <div class="au-patrow"><span class="lbl">{k}</span><Steps value={m.patterns?.[k] ?? MUSIC.patterns[k]} onChange={(v) => setPat(k, v)} /></div>
            ))}
          </Sect>
        </div>
        <div class="au-col">
          <Sect title="Ambiance">
            <R label="portée océan (m)" title="Le ressac s'éteint à cette distance de la côte"><P value={am.oceanRange} onChange={(v) => setA('oceanRange', v)} range={false} def={AMB.oceanRange} step={1} min={1} /></R>
            <R label="oiseaux / min"><P value={am.birdsPerMinute} onChange={(v) => setA('birdsPerMinute', v)} range={false} def={AMB.birdsPerMinute} step={0.1} min={0} /></R>
            <R label="part perroquets"><P value={am.parrotShare} onChange={(v) => setA('parrotShare', v)} range={false} def={AMB.parrotShare} step={0.01} min={0} max={1} /></R>
            <R label="mouettes / min"><P value={am.gullsPerMinute} onChange={(v) => setA('gullsPerMinute', v)} range={false} def={AMB.gullsPerMinute} step={0.1} min={0} /></R>
            <R label="chouettes / min"><P value={am.owlsPerMinute} onChange={(v) => setA('owlsPerMinute', v)} range={false} def={AMB.owlsPerMinute} step={0.05} min={0} /></R>
          </Sect>
          <Sect title="Niveaux des nappes">
            {Object.keys(AMB.beds).map((k) => (
              <R label={k}><P value={am.beds?.[k]} onChange={(v) => setBed(k, v)} range={false} def={AMB.beds[k]} step={0.01} min={0} max={2} /></R>
            ))}
          </Sect>
          <Sect title="Sons utilisés">
            {Object.keys(AMB.sounds).map((k) => (
              <R label={k}>
                <select value={am.sounds?.[k] ?? ''} onChange={(e) => setSnd(k, e.target.value === '' || e.target.value === AMB.sounds[k] ? undefined : e.target.value)}>
                  <option value="">{AMB.sounds[k]} (défaut)</option>
                  {names.filter((n) => n !== AMB.sounds[k]).map((n) => <option value={n}>{n}</option>)}
                </select>
                {!(am.sounds?.[k] ?? AMB.sounds[k]) || doc.sounds[am.sounds?.[k] ?? AMB.sounds[k]] ? null : <small class="err" title="Son introuvable">!</small>}
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
    <Sect title="Test en direct" cls="au-test">
      <div class="btns">
        {on
          ? <button class="on" onClick={stopTest}>⏹ Arrêter le test</button>
          : <button onClick={() => startTest(A.doc.value)}>▶ Écouter musique & ambiance</button>}
      </div>
      {!compact && <p class="hint">Joue la musique générative et l'ambiance avec les réglages en cours (les modifications s'appliquent en direct, y compris aux sons des nappes). La musique calme alterne phrases et silences.</p>}
      <R label="intensité musique" title="setMusicIntensity : 0 = nappes calmes, 1 = percussions de combat">
        <input type="range" min={0} max={1} step={0.01} value={test.intensity.value} onInput={(e) => { test.intensity.value = +e.target.value; test.sys?.setMusicIntensity(+e.target.value); }} />
        <code class="au-sv">{test.intensity.value.toFixed(2)}</code>
      </R>
      <R label="volume musique">
        <input type="range" min={0} max={1.5} step={0.01} value={test.musicVol.value} onInput={(e) => { test.musicVol.value = +e.target.value; test.sys?.setVolume('music', +e.target.value); }} />
        <code class="au-sv">{test.musicVol.value.toFixed(2)}</code>
      </R>
      <R label="volume ambiance">
        <input type="range" min={0} max={1.5} step={0.01} value={test.ambientVol.value} onInput={(e) => { test.ambientVol.value = +e.target.value; test.sys?.setVolume('ambient', +e.target.value); }} />
        <code class="au-sv">{test.ambientVol.value.toFixed(2)}</code>
      </R>
      {slider('nuit', 'night', 0, 1, 0.01, '0 = jour (cigales, oiseaux), 1 = nuit (grenouilles, grillons, chouettes)')}
      {slider('jungle', 'inJungle', 0, 1, 0.01, 'Densité de la jungle (insectes, oiseaux, perroquets ; atténue le vent)')}
      {slider('distance côte (m)', 'coastDistance', 0, 400, 1, 'Ressac et mouettes près de la côte')}
      {slider('altitude (m)', 'height', 0, 200, 1, 'Le vent forcit de 15 m à 140 m')}
      {slider('combat', 'combat', 0, 1, 0.01, 'Fait taire la faune et monte l\'intensité musicale')}
      <R label="sous l'eau"><BoolField value={st.underwater} onChange={(v) => set('underwater', v)} /></R>
      <R label="intérieur"><BoolField value={st.indoor} onChange={(v) => set('indoor', v)} /></R>
      {on && stats && (
        <div class="au-stats">
          <div><small>état</small> {stats.state} · voix {stats.voices} · notes {stats.musicNotes}</div>
          <div><small>musique</small> intensité {stats.music.intensity} · calme {stats.music.calm}{stats.music.resting ? ' (silence)' : ''} · combat {stats.music.combat}</div>
          {Object.entries(stats.beds).map(([k, v]) => (
            <div class="au-bed"><span>{k}</span><i style={{ width: Math.min(100, v * 100) + '%' }} /><code>{v}</code></div>
          ))}
        </div>
      )}
    </Sect>
  );
}
