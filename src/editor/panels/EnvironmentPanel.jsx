// Environment: time of day (live), sun / moon, ambient, SSAO, GI, lens flare / light halos, far fog,
// near haze, dust motes, wind, clouds, sky / ocean colours.
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
        <h2>Environment</h2>
        <h4>Time</h4>
        {slider('timeOfDay', 'Time of day', 0, 24, 0.05)}
        {slider('dayLengthMinutes', 'Day length (min, 0 = frozen)', 0, 120, 1)}
        <h4>Light</h4>
        {slider('sunIntensity', 'Sun', 0, 6, 0.05)}
        {slider('moonIntensity', 'Moon', 0, 2, 0.02)}
        {slider('ambient', 'Ambient', 0, 5, 0.05)}
        {slider('sunTilt', 'Sun path tilt', 0, 1.2, 0.01)}
        {slider('exposure', 'Exposure', 0.3, 2.5, 0.01)}
        {slider('nightExposure', 'Night exposure', 0.5, 4, 0.05)}
        <h4>Ambient occlusion (SSAO)</h4>
        {slider('ao.intensity', 'Strength', 0, 8, 0.05)}
        {slider('ao.radius', 'Radius (m)', 0.2, 4, 0.05)}
        {slider('ao.direct', 'Share applied to sunlight', 0, 1, 0.01)}
        {slider('ao.distance', 'Max distance (m)', 10, 200, 1)}
        <h4>Global illumination (probes)</h4>
        {!L.gi.loaded && <p class="hint">Not baked yet: <code>npm run mc -- gi bake</code></p>}
        {slider('gi.intensity', 'Strength', 0, 3, 0.01)}
        {slider('gi.floor', 'Floor (uniform ambient share)', 0, 1, 0.01)}
        {slider('gi.bias', 'Offset along the normal (m)', 0, 3, 0.05)}
        {slider('autoExposure.strength', 'Auto exposure: strength', 0, 1, 0.01)}
        {slider('autoExposure.max', 'Auto exposure: maximum', 1, 4, 0.05)}
        {slider('autoExposure.min', 'Auto exposure: minimum', 0.5, 1, 0.01)}
        <h4>Sun lens flare & halos</h4>
        {slider('flare.intensity', 'Lens flare: strength (0 = none)', 0, 3, 0.01)}
        {slider('flare.glare', 'Glare veil', 0, 3, 0.01)}
        {slider('flare.ghosts', 'Lens ghosts', 0, 3, 0.01)}
        {slider('flare.dazzle', 'Dazzle (exposure drop)', 0, 0.5, 0.01)}
        {slider('glows.intensity', 'Light halos (lamps, fires)', 0, 3, 0.01)}
        {slider('glows.distance', 'Halos: max distance (m)', 50, 1500, 10)}
        <h4>Atmosphere</h4>
        {slider('fogDensity', 'Far fog', 0, 0.006, 0.0001)}
        {slider('haze.density', 'Haze: density (per m, at the base)', 0, 0.02, 0.0001)}
        {slider('haze.height', 'Haze: height (m, density / e)', 5, 200, 1)}
        {slider('haze.base', 'Haze: base height (m)', -50, 100, 1)}
        {slider('haze.max', 'Haze: max opacity', 0, 0.95, 0.01)}
        {slider('haze.start', 'Haze: clear distance (m)', 0, 50, 0.5)}
        {slider('haze.brightness', 'Haze: brightness', 0, 2, 0.01)}
        {slider('haze.sun', 'Haze: glow toward the sun', 0, 3, 0.01)}
        {slider('haze.variation', 'Haze: drifting banks', 0, 1, 0.01)}
        {slider('haze.scale', 'Haze: bank size (m)', 20, 600, 5)}
        {slider('haze.drift', 'Haze: drift (m/s)', 0, 15, 0.1)}
        {slider('haze.morning', 'Haze: x at sunrise (mist)', 1, 5, 0.05)}
        {slider('haze.evening', 'Haze: x at dusk', 1, 5, 0.05)}
        {slider('haze.night', 'Haze: x at night', 1, 5, 0.05)}
        {slider('motes.intensity', 'Dust motes (0 = none)', 0, 4, 0.05)}
        {slider('motes.count', 'Dust motes: count', 0, 4000, 50)}
        {slider('motes.size', 'Dust motes: size (m)', 0.002, 0.05, 0.001)}
        {slider('motes.box', 'Dust motes: range (m)', 4, 30, 0.5)}
        {slider('motes.drift', 'Dust motes: drift (m/s)', 0, 3, 0.05)}
        {slider('clouds.coverage', 'Clouds', 0, 1, 0.01)}
        {slider('clouds.speed', 'Cloud speed', 0, 20, 0.1)}
        {slider('wind.strength', 'Wind (strength)', 0, 1.5, 0.01)}
        {slider('wind.speed', 'Wind (sway speed)', 0, 5, 0.05)}
        <h4>Sky</h4>
        {Object.keys(env.sky).map((k) => <Row label={k}><ColorField value={env.sky[k]} onChange={(v) => set('sky.' + k, v)} /></Row>)}
        <h4>Ocean & rivers</h4>
        {['shallow', 'deep', 'foam'].map((k) => <Row label={'ocean ' + k}><ColorField value={env.ocean[k]} onChange={(v) => set('ocean.' + k, v)} /></Row>)}
        {['shallow', 'deep'].map((k) => <Row label={'river ' + k}><ColorField value={env.river[k]} onChange={(v) => set('river.' + k, v)} /></Row>)}
        <div class="btns">
          <button onClick={() => { const t = (env.timeOfDay + 6) % 24; set('timeOfDay', t); }}>+6 h</button>
          <button onClick={() => ed.saveAll()}>Save</button>
        </div>
      </div>
    </div>
  );
}
