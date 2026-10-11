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
      <Sect title="Son">
        <R label="bus" title="sfx : effets (filtré sous l'eau) · ambient · music · ui (non spatialisé)"><EnumField value={r.bus} options={BUSES} allowEmpty onChange={(v) => sub('bus', v)} /></R>
        <R label="durée (s)" title="Longueur sèche (défaut : fin de la dernière couche). Pour une boucle : la longueur de la boucle."><P {...b('duration')} def={+dry.toFixed(3)} step={0.005} min={0.01} max={60} /></R>
        <R label="gain (crête)" title="Crête de sortie 0..1 : le mix est normalisé puis multiplié"><P {...b('gain')} def={DEF.sound.gain} step={0.01} min={0} max={4} /></R>
        <R label="normaliser" title="Désactivé : garde le niveau brut du mix (× gain)"><BoolField value={r.normalize !== false} onChange={(v) => sub('normalize', v ? undefined : false)} /></R>
        <R label="boucle" title="Rend une boucle sans couture (fondu enchaîné de la fin sur le début)"><BoolField value={!!r.loop} onChange={(v) => sub('loop', v || undefined)} /></R>
        {r.loop && <R label="fondu boucle (s)"><P {...b('loopFade')} def={+Math.min(0.5, dry / 4).toFixed(3)} step={0.005} min={0.005} /></R>}
        {!r.loop && <R label="queue (s)" title="Temps rendu après la durée pour la réverb / l'écho (défaut : automatique)"><P {...b('tail')} def={undefined} step={0.01} min={0} max={8} /></R>}
      </Sect>
      <Sect title="Effets">
        <R label="distorsion"><P {...b('distortion')} def={0} step={0.01} min={0} max={1} /></R>
        <R label="réverb"><P {...b('reverb')} def={0} step={0.01} min={0} max={1} /></R>
        {r.reverb != null && r.reverb !== 0 && <R label="taille"><P {...b('reverbSize')} def={DEF.sound.reverbSize} step={0.01} min={0} max={1} /></R>}
        {r.reverb != null && r.reverb !== 0 && <R label="amorti"><P {...b('reverbDamp')} def={DEF.sound.reverbDamp} step={0.01} min={0} max={0.95} /></R>}
        <div class="au-sub">
          <label><input type="checkbox" checked={!!echo} onChange={(e) => sub('echo', e.target.checked ? { time: 0.3, feedback: 0.35, mix: 0.4, lowpass: 2500 } : undefined)} /> Écho</label>
          {echo && ['time', 'feedback', 'mix', 'lowpass'].map((k) => (
            <R label={{ time: 'temps (s)', feedback: 'réinjection', mix: 'mix', lowpass: 'passe-bas (Hz)' }[k]}>
              <P {...bind(echo, (v) => sub('echo', v), k)} def={DEF.echo[k]} log={k === 'lowpass'} step={k === 'lowpass' ? 1 : 0.005} min={k === 'lowpass' ? 50 : 0} max={k === 'feedback' ? 0.9 : k === 'mix' ? 1 : k === 'time' ? 2 : 20000} />
            </R>
          ))}
        </div>
        <div class="au-sub">
          <small>Filtre(s) sur tout le mix</small>
          <FilterList value={r.filter} onChange={(v) => sub('filter', v)} />
        </div>
      </Sect>
      <Sect title="Variations">
        <R label="nombre" title="Variantes rendues avec des graines différentes (1..8)"><P {...vb('count')} range={false} def={r.loop ? 1 : 3} int step={0.05} min={1} max={8} /></R>
        <R label="hauteur" title="Vitesse de lecture aléatoire [min, max] tirée à chaque lecture"><P {...vb('pitch')} def={1} step={0.005} min={0.05} max={4} /></R>
        <R label="gain" title="Volume aléatoire [min, max] tiré à chaque lecture"><P {...vb('gain')} def={1} step={0.01} min={0} max={2} /></R>
      </Sect>
      <Sect title="Spatial & voix">
        <R label="distance réf. (m)" title="Distance à laquelle le son est à plein volume"><P {...b('refDistance')} range={false} def={DEF.sound.refDistance} step={0.1} min={0.1} /></R>
        <R label="distance max (m)" title="Au-delà, les sons ponctuels ne sont pas joués"><P {...b('maxDistance')} range={false} def={DEF.sound.maxDistance} step={1} min={1} /></R>
        <R label="atténuation" title="rolloff (modèle inverse)"><P {...b('rolloff')} range={false} def={DEF.sound.rolloff} step={0.01} min={0} /></R>
        <R label="priorité" title="Vol de voix : la voix de plus basse priorité × 4 + audibilité est coupée"><P {...b('priority')} range={false} def={0} int step={0.05} /></R>
        <R label="instances max" title="Nombre d'instances simultanées de ce son (la plus ancienne laisse la place)"><P {...b('maxInstances')} range={false} def={DEF.sound.maxInstances} int step={0.05} min={1} /></R>
      </Sect>
    </div>
  );
}
