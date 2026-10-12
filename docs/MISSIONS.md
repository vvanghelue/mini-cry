# Mini Cry — missions, triggers & dialogue format

Runtime: `src/game/missions/Missions.js` (+ `Dialogue.js`). Data:
`public/data/game/missions.json` and `public/data/game/dialogue.json`. Edited in the editor
(🎯 Missions, 💬 Dialogue panels) or with `npm run mc -- mission ...`.

The world is open: missions only add objectives, markers and scripted events on top of it.
Every reference to a place or a thing is an **entity id** from `world.json` (markers, zones,
pickups, outposts, interactables, actors...), an actor id, `"player"`, or a literal `[x, y, z]`.

## missions.json

```json
{
  "start": "m01",                       // mission started on a new game
  "variables": { "radioFixed": false },  // script variables (setVar / incVar / conditions)
  "missions": [ Mission, ... ],
  "triggers": [ Trigger, ... ]
}
```

### Mission
```json
{
  "id": "m01", "title": "Échoué", "type": "main",      // main | side
  "description": "Texte du journal",
  "onStart": [Action...], "onComplete": [Action...], "onFail": [Action...],
  "failIf": [ { "actorDead": "npc_val", "reason": "Le Dr Val est mort" } ],
  "checkpoint": true,                                   // save when completed (default true)
  "objectives": [ Objective, ... ]                      // done in order
}
```

### Objective
Common fields: `id`, `type`, `text` (HUD), `hidden` (no HUD/marker), `noMarker`, `marker` (entity
id for the compass/map marker when it differs from `target`), `onStart`, `onComplete`.

| type | fields | completes when |
|---|---|---|
| `goto` | `target`, `radius` (6) | player within radius (2D) of target |
| `kill` | `group` or `actor` | every actor of the group (or the actor) is dead |
| `pickup` | `target` (pickup entity) or `item` | that pickup / any pickup of that item is taken |
| `interact` | `target` (interactable / alarm / npc entity) | the player used it (E) / talked to the NPC while this objective is the current one |
| `destroy` | `target` (explosive / destructible) | it was destroyed |
| `liberate` | `target` (outpost entity) | the outpost is liberated (garrison dead) |
| `survive` | `seconds` | time elapsed since the objective started |
| `wait` | `seconds` | idem, usually `hidden` (script pauses) |
| `collect` | `item` (collectible kind: `intel`, `relic`), `count` | collected that many since the objective started |
| `escort` | `actor`, `target`, `radius` | the (alive) actor is within radius of target |
| `condition` | `condition` | the condition becomes true |

### Trigger (global, any time)
```json
{ "id": "t_cave", "when": { "enterZone": "zone_cave" }, "if": Condition, "once": true, "do": [Action...] }
```
`when`: `{ "enterZone": id }`, `{ "leaveZone": id }`, `{ "always": true }` (checked each frame,
use with `if`), or `{ "event": name, ...filters }` with events:
`kill {actor, group}`, `pickup {entity, item}`, `interact {entity}`, `destroyed {entity}`,
`liberate {outpost}`, `alarm {outpost}`, `missionStart {mission}`, `missionComplete {mission}`,
`objectiveComplete {mission, objective}`, `enterZone {zone}`, `leaveZone {zone}`.

### Conditions
`{ "var": "x" }` (truthy), `{ "var": "x", "eq": 3 }` / `gt` / `lt` / `gte`, `{ "missionDone": id }`,
`{ "missionActive": id }`, `{ "objectiveActive": { "mission": id, "id": objectiveId } }` (that objective is the current one), `{ "actorDead": id }`, `{ "actorAlive": id }`, `{ "groupDead": group }`,
`{ "hasItem": item }`, `{ "hasWeapon": id }`, `{ "liberated": outpostId }`, `{ "inZone": zoneId }`,
`{ "timeBetween": [20, 5] }` (hours), `{ "destroyed": id }`, `{ "interacted": id }`, `{ "collected": { "item": "relic", "count": 3 } }`,
`{ "not": C }`, `{ "all": [C...] }`, `{ "any": [C...] }`, or an array (= all).

### Actions
Every action is `{ "do": name, ...params, "if": Condition? }`; lists run in sequence (`wait`,
`cinematic` and `dialogue` with `"wait": true` pause the list).

| do | params |
|---|---|
| `dialogue` | `id` (dialogue.json), `wait` (bool) |
| `say` | `speaker`, `text`, `duration` |
| `banner` | `title`, `subtitle`, `duration` |
| `hint` | `text`, `duration` |
| `startMission` / `completeMission` / `failMission` | `id` (`reason` for fail) |
| `completeObjective` | `mission`, `id` |
| `setVar` / `incVar` | `name`, `value` / `by` |
| `spawn` | `archetype`, `at`, `count`, `group`, `behavior` (`attack`/`idle`/`patrol`), `patrol` (path id) |
| `activateGroup` | `group` (wakes actors placed with `dormant: true`) |
| `alertGroup` / `removeGroup` | `group` |
| `enable` / `disable` | `entity` |
| `giveWeapon` | `weapon`, `ammo: { type: n }` |
| `giveItem` | `item`, `count` |
| `heal` | `amount` |
| `teleport` | `to`, `yaw` |
| `setTime` | `hour` ; `setDayLength`: `minutes` |
| `playSound` | `sound`, `at`, `volume` |
| `cinematic` | `from`, `to` (camera positions), `lookAt`, `duration`, `text` |
| `explode` | `at`, `radius`, `damage` |
| `wait` | `seconds` |
| `checkpoint` | — |
| `follow` / `stopFollow` | `actor` (NPC follows the player: escorts) |
| `music` | `intensity` (0..1, null = automatic) |
| `setMarker` | `id`, `at` (null removes) — extra map/compass marker |
| `endGame` | `title`, `text` |

## dialogue.json
```json
{
  "tts": { "model": "elevenlabs/eleven-v4" },
  "speakers": {
    "mara": { "name": "Mara", "desc": "Jeune femme, meneuse de la résistance…", "radio": true,
              "tts": { "voice": "jessica" }, "pitch": 1.2, "rate": 1.05, "voiceIndex": 0 }
  },
  "dialogues": {
    "m01_intro": [ { "speaker": "mara", "text": "Tu m'entends ?", "spoken": "[nervous] Tu m'entends ?", "duration": 3 } ]
  }
}
```
- `text` is the subtitle. `duration` is optional: by default a line lasts as long as its recorded
  clip (+0.35 s), otherwise ~65 ms per character (min 2.2 s).
- `radio` speakers get a beep and a band-limited radio filter on their voice.
- `desc` describes the character and their voice (casting, `mc voice check`). It is never sent to the TTS model.

### Voices (recorded TTS)
Each speaker with `tts.voice` has its lines recorded offline through OpenRouter's text-to-speech
API (`OPENROUTER_API_KEY` in `.env` at the project root, gitignored). The default model is
`elevenlabs/eleven-v4`: French, expressive, about $0.04 per 1000 characters.
- **Acting.** `spoken` is the text actually spoken. It carries inline audio tags
  (`[whispers] [shouts] [sighs] [laughs] [chuckles] [nervous] [urgent] [angry] [sad] [excited]
  [sarcastic] [pause]`…), and it can differ from the subtitle (e.g. no "(B)" key hints).
- **Instructions.** `tts.model` / `tts.instructions` can be set per speaker. Instructions are
  free-text delivery direction for models that support it (Gemini TTS, OpenAI).
- **Clip files.** Clips are stored as `public/data/voice/<key>.mp3`, listed in `voice/manifest.json`
  with their duration. The key hashes model + voice + instructions + spoken text
  (`src/game/missions/voice.js`). Editing a line or recasting a speaker therefore makes the clip
  stale: the game falls back to the browser voice for that line, and `mc validate` warns.
- **Commands.**
  - `mc voice list` shows the status of every line.
  - `mc voice generate [dialogueId…] [--force] [--dry]` records missing or stale clips. Old takes
    and orphans go to `.mc-backup/voice/`.
  - `mc voice say <speaker> "<text>" --voice x --judge` auditions a voice into `shots/`.
  - `mc voice voices` lists the voices of the current model; `mc voice models` lists other models.
  - `mc voice check` has an audio model transcribe and rate each clip (accent, naturalness,
    acting), so an agent can "listen".
- **Editor (💬).** Choose the voice, edit the acting, audition, and generate the missing voices.

In game the clips play on the `voice` bus. Music and ambience are ducked while a clip plays. A
paused game pauses the voice. Options: "Dialogue voices", "Voice volume".

## World entities used by scripts
`marker` (named points, map labels), `zone` (sphere/box triggers), `path` (patrol routes),
`enemy` / `npc` (`group`, `patrol`, `dormant`, `pose`; npc: `dialogue` played when talked to,
`talkPrompt`, `talkIf` = condition to be able to talk, e.g. a hostage only at the objective that
frees them; an NPC under `follow` walks to the player, retracing his footsteps around walls, and
can't be talked to), `pickup` (`item`, `still` = lies on the ground, `rounds` = ammo left in a weapon;
killed enemies always drop their held weapon this way), `outpost` (`group` =
its garrison, `alarm`, `reinforcements`), `alarm`, `interactable` (`prompt`, `requires`),
`explosive`, `destructible`, `vehicle`, `sound`. See `src/game/entities/index.js` for schemas.
