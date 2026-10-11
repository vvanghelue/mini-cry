// Environment: time of day (live), sun / moon, ambient, SSAO, GI, lens flare / light halos, fog, wind,
// clouds, sky / ocean colours.
// The 3D viewport stays visible on the left half so changes are seen immediately.
import { useState } from 'preact/hooks';
import { Row, NumberField, ColorField } from '../ui/Fields.jsx';

export function EnvironmentPanel({ ed }) {
  const L = ed.world.lighting;
  const [env, setEnv] = useState(structuredClone(L.env));
  const apply = (next) => {
    setEnv(next);
    L.setEnvironment(next);
    ed.markDirty('environment.json');
  };
  const set = (path, v) => {
    const next = structuredClone(env);
    const ks = path.split('.');
    let o = next;
    for (const k of ks.slice(0, -1)) o = o[k];
    o[ks[ks.length - 1]] = v;
    apply(next);
  };
  const slider = (path, label, min, max, step) => {
    const v = path.split('.').reduce((o, k) => o[k], env);
    return <Row label={label}><input type="range" min={min} max={max} step={step} value={v} onInput={(e) => set(path, +e.target.value)} /><NumberField value={+(+v).toFixed(4)} step={step} onChange={(x) => set(path, x)} /></Row>;
  };
  return (
    <div class="panel split">
      <div class="side">
        <h2>Ambiance</h2>
        <h4>Temps</h4>
        {slider('timeOfDay', 'Heure', 0, 24, 0.05)}
        {slider('dayLengthMinutes', 'Durée d\'une journée (min, 0 = figé)', 0, 120, 1)}
        <h4>Lumière</h4>
        {slider('sunIntensity', 'Soleil', 0, 6, 0.05)}
        {slider('moonIntensity', 'Lune', 0, 2, 0.02)}
        {slider('ambient', 'Ambiante', 0, 5, 0.05)}
        {slider('sunTilt', 'Inclinaison de la course du soleil', 0, 1.2, 0.01)}
        {slider('exposure', 'Exposition', 0.3, 2.5, 0.01)}
        {slider('nightExposure', 'Exposition nocturne', 0.5, 4, 0.05)}
        <h4>Occlusion ambiante (SSAO)</h4>
        {slider('ao.intensity', 'Intensité', 0, 8, 0.05)}
        {slider('ao.radius', 'Rayon (m)', 0.2, 4, 0.05)}
        {slider('ao.direct', 'Part sur le soleil', 0, 1, 0.01)}
        {slider('ao.distance', 'Distance max (m)', 10, 200, 1)}
        <h4>Illumination globale (probes)</h4>
        {!L.gi.loaded && <p class="hint">Pas encore calculée : <code>npm run mc -- gi bake</code></p>}
        {slider('gi.intensity', 'Intensité', 0, 3, 0.01)}
        {slider('gi.floor', 'Plancher (part d\'ambiante uniforme)', 0, 1, 0.01)}
        {slider('gi.bias', 'Décalage le long de la normale (m)', 0, 3, 0.05)}
        {slider('autoExposure.strength', 'Exposition auto : force', 0, 1, 0.01)}
        {slider('autoExposure.max', 'Exposition auto : maximum', 1, 4, 0.05)}
        {slider('autoExposure.min', 'Exposition auto : minimum', 0.5, 1, 0.01)}
        <h4>Reflets du soleil (lens flare) & halos</h4>
        {slider('flare.intensity', 'Lens flare : intensité (0 = aucun)', 0, 3, 0.01)}
        {slider('flare.glare', 'Voile lumineux', 0, 3, 0.01)}
        {slider('flare.ghosts', 'Reflets dans l\'objectif', 0, 3, 0.01)}
        {slider('flare.dazzle', 'Éblouissement (baisse d\'exposition)', 0, 0.5, 0.01)}
        {slider('glows.intensity', 'Halos des lumières (lampes, feux)', 0, 3, 0.01)}
        {slider('glows.distance', 'Halos : distance max (m)', 50, 1500, 10)}
        <h4>Atmosphère</h4>
        {slider('fogDensity', 'Brouillard', 0, 0.006, 0.0001)}
        {slider('clouds.coverage', 'Nuages', 0, 1, 0.01)}
        {slider('clouds.speed', 'Vitesse des nuages', 0, 20, 0.1)}
        {slider('wind.strength', 'Vent (force)', 0, 1.5, 0.01)}
        {slider('wind.speed', 'Vent (rythme)', 0, 5, 0.05)}
        <h4>Ciel</h4>
        {Object.keys(env.sky).map((k) => <Row label={k}><ColorField value={env.sky[k]} onChange={(v) => set('sky.' + k, v)} /></Row>)}
        <h4>Océan & rivières</h4>
        {['shallow', 'deep', 'foam'].map((k) => <Row label={'océan ' + k}><ColorField value={env.ocean[k]} onChange={(v) => set('ocean.' + k, v)} /></Row>)}
        {['shallow', 'deep'].map((k) => <Row label={'rivière ' + k}><ColorField value={env.river[k]} onChange={(v) => set('river.' + k, v)} /></Row>)}
        <div class="btns">
          <button onClick={() => { const t = (env.timeOfDay + 6) % 24; set('timeOfDay', t); }}>+6 h</button>
          <button onClick={() => ed.saveAll()}>Enregistrer</button>
        </div>
      </div>
    </div>
  );
}
