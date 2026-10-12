// Recorded voice lines for dialogue.json: text-to-speech clips generated offline through OpenRouter
// (`mc voice generate`, docs/MISSIONS.md "Voices") into public/data/voice/. Shared by the game
// (Dialogue.js), the editor and the Node tools. A clip is keyed by a hash of exactly what was sent
// to the TTS model (model, voice, instructions, spoken text), so editing a line or recasting a
// speaker makes its clip stale: the game then falls back to the browser voice, `mc validate` warns
// and `mc voice generate` records it again.
export const VOICE_DIR = 'voice/';
export const VOICE_MANIFEST = 'voice/manifest.json';
export const DEFAULT_TTS_MODEL = 'elevenlabs/eleven-v4';
/** s of silence after a recorded line before the next one starts. */
export const LINE_GAP = 0.35;
/** s between the radio beep and a radio speaker's voice. */
export const RADIO_DELAY = 0.15;

/** ElevenLabs premade voices (ids accepted by elevenlabs/* models), with casting hints. */
export const ELEVEN_VOICES = {
  adam: 'male, 40-50, deep, firm',
  alice: 'female, 40, clear, composed',
  bella: 'female, 35, warm, bright',
  bill: 'old male, wise, mature voice',
  brian: 'male, 45, deep, resonant',
  callum: 'male, 40, husky, mischievous',
  charlie: 'young male, confident, energetic',
  chris: 'male, 35, natural, friendly',
  daniel: 'male, 45, steady, authoritative (newsreader)',
  eric: 'male, 40, soft, reassuring',
  george: 'male, 50, warm, storyteller',
  harry: 'young male, intense, warrior',
  jessica: 'young female, lively, warm',
  laura: 'young female, playful, quirky',
  liam: 'young male, energetic',
  lily: 'female, 40, velvety, actress',
  matilda: 'female, 40, professional',
  river: 'neutral, relaxed',
  roger: 'male, 45, laid-back, resonant',
  sarah: 'female, 30, mature, reassuring',
  will: 'young male, relaxed, optimistic',
};

/** ElevenLabs v3/v4 inline audio tags that work well for game dialogue (written in the `spoken` text). */
export const AUDIO_TAGS = ['[whispers]', '[shouts]', '[sighs]', '[laughs]', '[chuckles]', '[nervous]', '[urgent]', '[angry]', '[sad]', '[excited]', '[sarcastic]', '[curious]', '[tired]', '[pause]'];

const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/**
 * The TTS request for a line ({ model, voice, input, instructions? }), or null when its speaker has
 * no recorded voice (speaker.tts.voice). `line.spoken` (acting: the text with audio tags) overrides
 * `line.text` (the subtitle).
 */
export function voiceRequest(doc, line) {
  const v = doc?.speakers?.[line?.speaker]?.tts;
  if (!v?.voice) return null;
  const input = clean(line.spoken || line.text);
  if (!input) return null;
  const req = { model: v.model ?? doc.tts?.model ?? DEFAULT_TTS_MODEL, voice: v.voice, input };
  if (v.instructions) req.instructions = String(v.instructions);
  return req;
}

/** Stable 16-hex-digit key of a request (same result in the browser and in Node). */
export function voiceKey(req) {
  const s = JSON.stringify([req.model, req.voice, req.instructions ?? '', req.input]);
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** The manifest entry of a line's clip ({ file, duration, ... }), or null (no voice / not generated / stale). */
export function voiceClip(manifest, doc, line) {
  const req = voiceRequest(doc, line);
  return (req && manifest?.lines?.[voiceKey(req)]) || null;
}

/**
 * On-screen time of a line (s): `duration` if set, else its clip length (+ the radio beep delay)
 * + a gap, else ~65 ms per character.
 */
export function lineDuration(line, clip, radio = false) {
  if (line.duration != null) return line.duration;
  if (clip) return clip.duration + LINE_GAP + (radio ? RADIO_DELAY : 0);
  return Math.max(2.2, clean(line.text).length * 0.065);
}
