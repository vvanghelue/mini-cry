# Mini Cry: procedural audio

Apart from the recorded dialogue voices (`public/data/voice/`, see docs/MISSIONS.md), there are no
audio files. Every sound is a JSON **recipe** in `public/data/sounds.json`, rendered
to samples by `src/engine/audio/synth.js`. That module is pure JS with no AudioContext, so it runs in
the browser, in a Web Worker and in Node. `src/engine/audio/Audio.js` (`AudioSystem`) plays the
rendered sounds through Web Audio. It also runs the ambient soundscape and a light generative
music layer.

```
sounds.json ──synth.js (worker)──> Float32 samples ──> AudioBuffers (cached, 1-8 variations)
                                                         │
play(name) ─> source ─> gain ─> [air lowpass ─> panner] ─> bus ─> master ─> limiter ─> out
```

## Recipe format

```json
"rifle_shot": {
  "bus": "sfx", "refDistance": 12, "maxDistance": 650, "priority": 6, "maxInstances": 8,
  "gain": 1, "reverb": 0.28, "reverbSize": 0.55, "distortion": 0.2,
  "variations": { "count": 4, "pitch": [0.95, 1.04], "gain": [0.9, 1] },
  "layers": [
    { "type": "noise", "gain": 1.4, "env": { "attack": 0, "decay": 0.028, "curve": 6 }, "filter": { "type": "highpass", "freq": 1500 } },
    { "type": "sine", "freq": 125, "freqEnd": 40, "curve": 0.45, "env": { "decay": 0.16 }, "distortion": 0.4 }
  ]
}
```

**Sound fields** (all optional except `layers`)

| field | meaning |
|---|---|
| `duration` | dry length in s (default: end of the last layer). For loops this is the loop length. |
| `gain` | output peak, 0..1. The mix is peak-normalised, then scaled. Use `normalize: false` to keep raw levels. |
| `loop` | render a seamless loop. The overhang is cross-faded into the head over `loopFade` s, and LFO rates and steady pitches snap to whole cycles. |
| `reverb`, `reverbSize`, `reverbDamp` | small room / plate (0..1). Its tail is added after `duration` (override with `tail`). |
| `echo` | `{ time, feedback, mix, lowpass }`: slap-back or valley echo. |
| `filter`, `distortion` | filter(s) or saturation on the whole mix. |
| `variations` | `count`: variants rendered with different seeds (default 3, loops 1). `pitch` and `gain`: random playback ranges picked at each play. |
| `bus` | `sfx` (default), `ambient`, `music` or `ui`. |
| `refDistance`, `maxDistance`, `rolloff` | spatial falloff (inverse model). One-shots beyond `maxDistance` are not played. |
| `priority`, `maxInstances` | voice stealing (default 0) and the per-sound cap (default 8; the oldest instance makes room). |

**Layer fields**

| field | meaning |
|---|---|
| `type` | `noise`, `sine`, `square`, `saw`, `triangle`, `fm` or `click` (a one-sample impulse, auto-scaled so its filtered ring peaks near 1) |
| `start` (alias `delay`), `length`, `gain`, `mute` | timing in s. The default length is attack+hold+decay when `env.sustain` is 0, otherwise until the end. |
| `freq`, `freqEnd`, `sweep`, `curve` | exponential glide over `sweep` s (default: the whole layer). `curve` < 1 front-loads the glide (kick drums). |
| `noiseColor` | `white`, `pink` or `brown` |
| `duty`, `unison: { voices, detune }` | pulse width; detuned copies (cents) |
| `fm: { ratio, index, indexEnd }` | sine carrier phase-modulated at `freq * ratio`; bells and metal |
| `rate`, `jitter` | click trains (impulses per s, timing randomness): engines, crackle, sand grains, frogs |
| `env: { attack, hold, decay, sustain, release, curve }` | s. `curve` 0 is a linear decay; higher values are more exponential (default 4). |
| `filter` | `{ type: lowpass\|highpass\|bandpass\|notch, freq, freqEnd, q, sweep, curve, lfo }` or an array of these. Filters run in series. |
| `distortion` | 0..1 tanh drive (it also compresses, which makes decays punchier) |
| `vibrato`, `tremolo` | LFO `{ rate, depth, shape: sine\|triangle\|square\|saw\|noise, phase, duty }`. Vibrato depth is in semitones and tremolo depth is 0..1. `tremolo` can be an array; the LFOs multiply. |
| `repeat` | `{ count, interval, jitter, pitch, gain, notes }`. Re-triggers the layer. `pitch` and `gain` multiply per copy; `notes` (semitones, cycled) makes arpeggios. |

Any number can be written as `[min, max]` to draw a random value per variation (and per repeat).
Bird chirps use this so they never sing the same phrase twice.

`sounds.json` also has two optional tuning sections. `music` holds bpm, chords (MIDI), scale,
levels, 16-step patterns (`x` hit, `o` soft, `?` random, `.` rest) and phrase / rest lengths.
`ambient` holds `oceanRange`, bed levels, birds / gulls / owls per minute, and `sounds` to rename
the sounds a bed uses. These spot sounds stand for unseen birds; the visible flocks
(`src/game/fx/Birds.js`, `game/birds.json`) also play their species' `call` and `bird_takeoff`
when they are startled.

## CLI

```
npm run mc -- sound list [--bus sfx]
npm run mc -- sound render <name> [--out shots/<name>.wav] [--variation N] [--loops N]
npm run mc -- sound check [name] [--layers] [--problems]
```

`sound check` renders every variation of every recipe. It reports duration, peak, RMS and render
time, and flags NaN, silence, too-quiet output, clipping, DC offset and loop seams. With a name and
`--layers`, it shows the solo level of each layer, which helps balance a mix without listening.

## Runtime API (`src/engine/audio/Audio.js`)

```js
import { AudioSystem } from '../engine/audio/Audio.js';
const audio = new AudioSystem({ sounds: await Data.json('sounds.json') }); // the parsed file (or its `sounds` map)
audio.resume();                                   // from a click / key handler (also automatic on the first gesture)
audio.update(dt, camera, ambientState);           // every frame, also while paused (dt = 0)
const h = audio.play('jeep_engine', { position: v.pos, loop: true, volume: 0.7, pitch: 1, priority: 2 });
h.setPosition(v.pos); h.setPitch(rpm); h.setVolume(0.5); h.stop(0.3);  // h.playing
audio.setVolume('master' | 'sfx' | 'ambient' | 'music' | 'ui' | 'voice', 0..2);
await audio.loadClip(url); audio.clipReady(url);  // recorded file (fetch + decode once, cached)
const c = audio.playClip(url, { radio: true, delay: 0.15, offset: 0, volume: 1, duck: true }); // voice bus, ducks music + ambience
c.stop(0.05); c.playing; c.duration; audio.running;
audio.setMusicIntensity(0..1);                    // 0 = calm pads, 1 = tribal combat percussion
audio.reload(json);                               // editor live edit: changed recipes re-render; loops and beds swap
audio.preview(recipe, opts);                      // play an unsaved recipe (stops the previous preview)
audio.preload(names?); audio.stopAll(fade); audio.stats; audio.dispose(); audio.setListener(camera);
```

- **Never throws.** Unknown sounds, a missing Web Audio, Node or headless runs, and calls made
  before the first gesture all return a no-op handle. A one-shot played before audio has started
  is dropped. A loop played then is kept and starts when audio starts.
- **Rendering.** Recipes render in a module Web Worker (`synth.js` itself). The whole library
  renders shortly after boot (about 0.7 s of worker time). If a short one-shot is played before its
  buffer exists, it is rendered on the spot (1-3 ms). Longer sounds start when ready, and one-shots
  that wait more than 250 ms are dropped.
- **Spatial sounds.** Passing `position` makes a sound spatial: a PannerNode (`equalpower`,
  `inverse`) plus a distance lowpass for air absorption. Without `position` the sound plays flat
  (the player's own weapon, footsteps and UI).
- **Voices.** Up to 32 voices, not counting music and ambient beds. When the limit is hit, the voice
  with the lowest `priority*4 + audibility` is stolen. Stolen or out-of-range loops become virtual
  and come back by themselves.
- **Pitch.** `pitch` is the playback rate, so it also changes the length (sampler-style, e.g.
  engine rpm).

### Ambient state

`update(dt, camera, { coastDistance, underwater, night, inJungle, height, indoor, combat })`

| field | effect |
|---|---|
| `coastDistance` (m) | ocean surf bed, which fades out by `ambient.oceanRange` (220 m). Gulls appear near the coast. |
| `height` (m) | wind grows from about 15 m to 140 m. The jungle canopy damps it (`inJungle`). |
| `night` 0..1 | day: cicadas, birds, parrot calls. Night: frogs, crickets, owls. |
| `inJungle` 0..1 | denser insects, birds and frogs, and more parrots |
| `underwater` | surface beds go quiet, an underwater rumble plays, and sfx + ambient are lowpassed (550 Hz) |
| `indoor` | outdoor ambience is muffled (1.5 kHz lowpass, -45 %) |
| `combat` 0..1 | wildlife goes quiet and recovers about 30 s after the fight. It also raises the music intensity (`max(setMusicIntensity, combat)`). |

Beds are mono loops played as two decorrelated copies panned left and right. Birds and other spot
sounds are positioned randomly around the listener. The ambient logic runs at 10 Hz, and `update()`
does no allocation in the steady state.

### Music

- **Calm layer.** Pad chords (A minor / F / C / G) with sparse pentatonic kalimba plucks. It plays
  in phrases of 6-10 chords separated by 25-50 s of silence.
- **Combat layer.** Djembe-like drums, shaker, log drum, a bass that follows the chord root, and a
  low drone.
- **Mixing.** The two layers cross-fade with intensity: it rises in about 1.5 s and falls slowly
  (about 6 s), so the music never cuts abruptly. Notes are scheduled 120 ms ahead on the audio
  clock, using the `music_*` recipes pitched by playback rate.
