// mc voice commands: recorded dialogue voices (text-to-speech through OpenRouter, key in .env).
// Casting lives in game/dialogue.json (speaker.tts.voice, line.spoken = acted text with audio
// tags); clips in public/data/voice/ (see tools/lib/voice.js). `voice check` lets an agent "listen":
// an audio-capable model transcribes and rates every clip.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, dataPath } from './data.js';
import { voicePlan, generateVoices, synthesize, ttsModels, askAboutAudio, loadDialogue, estimateCost } from './voice.js';
import { voiceRequest, DEFAULT_TTS_MODEL, ELEVEN_VOICES, VOICE_DIR } from '../../src/game/missions/voice.js';

const DEFAULT_JUDGE = 'google/gemini-3.8-flash';

const words = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
/** Word-level similarity 0..1 (1 - edit distance / longest). */
function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.length && !y.length) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.round((1 - prev[y.length] / Math.max(x.length, y.length)) * 100) / 100;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const positionalIds = (args) => args.filter(Boolean);

export const voiceCommands = {
  'voice list': {
    usage: '[dialogueId...] [--missing]',
    help: 'Dialogue lines and their recorded voice: ✓ clip (seconds), ✗ to generate (missing or stale after an edit), - speaker without tts.voice (browser voice).',
    async run(args, opts) {
      const ids = positionalIds(args);
      const rows = voicePlan().filter((r) => (!ids.length || ids.includes(r.dialogue)) && (!opts.missing || r.status === 'missing'));
      const mark = { ok: '✓', missing: '✗', novoice: '-' };
      const out = rows.map((r) => `${mark[r.status]} ${r.id.padEnd(18)} ${String(r.speaker).padEnd(10)} ${r.status === 'ok' ? (r.clip.duration.toFixed(1) + ' s').padStart(6) : '      '}  ${r.req?.input ?? r.text}`);
      const n = (s) => rows.filter((r) => r.status === s).length;
      const missing = rows.filter((r) => r.status === 'missing');
      const chars = missing.reduce((s, r) => s + r.req.input.length, 0);
      const cost = missing.length ? await estimateCost(missing[0].req.model, chars) : 0;
      out.push(`\n${n('ok')} recorded, ${n('missing')} to generate (${chars} chars${cost != null ? `, ~$${cost.toFixed(3)}` : ''}), ${n('novoice')} without voice`);
      return out.join('\n');
    },
  },
  'voice generate': {
    usage: '[dialogueId...] [--speaker id] [--force] [--dry] [--concurrency 4]',
    help: 'Record the missing / stale voice clips through OpenRouter TTS (OPENROUTER_API_KEY in .env) and update voice/manifest.json. --force re-records the selection (new take), --dry only counts characters and cost. A run without selection also moves orphan clips to .mc-backup/voice/.',
    async run(args, opts) {
      return generateVoices({
        dialogues: positionalIds(args), speaker: opts.speaker, force: !!opts.force, dry: !!opts.dry,
        concurrency: +(opts.concurrency ?? 4), log: (m) => process.stderr.write(m + '\n'),
      });
    },
  },
  'voice say': {
    usage: '<speaker> <text...> [--spoken "[sighs] text"] [--voice id] [--model id] [--out shots/voice/x.mp3]',
    help: 'Audition: record one line with a speaker\'s voice (or another --voice / --model) into shots/ without touching the game data. Then `voice check`-style rating with --judge.',
    async run([speaker, ...text], opts) {
      const doc = loadDialogue();
      if (!doc.speakers?.[speaker]) throw new Error(`unknown speaker ${speaker} (${Object.keys(doc.speakers ?? {}).join(', ')})`);
      const sp = doc.speakers[speaker];
      const tts = { ...sp.tts, ...(opts.voice ? { voice: opts.voice } : {}), ...(opts.model ? { model: opts.model } : {}) };
      const line = { speaker, text: text.join(' '), spoken: opts.spoken };
      const req = voiceRequest({ ...doc, speakers: { ...doc.speakers, [speaker]: { ...sp, tts } } }, line);
      if (!req) throw new Error(`no voice for ${speaker}: set speakers.${speaker}.tts.voice or pass --voice (mc voice voices)`);
      const out = await synthesize(req);
      const file = path.resolve(ROOT, opts.out ?? `shots/voice/${speaker}-${req.voice}.${out.ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, out.bytes);
      const res = { file: path.relative(ROOT, file), duration: Math.round(out.duration * 100) / 100, model: req.model, voice: req.voice, chars: req.input.length };
      if (opts.judge) res.rating = await rate(opts.judge === true ? DEFAULT_JUDGE : opts.judge, sp, line, out.bytes, out.ext);
      return res;
    },
  },
  'voice voices': {
    usage: '[--model id]',
    help: 'Voices of a TTS model (default: dialogue.json tts.model) with casting hints, for speakers.<id>.tts.voice.',
    async run(_, opts) {
      const model = opts.model ?? loadDialogue().tts?.model ?? DEFAULT_TTS_MODEL;
      const m = (await ttsModels()).find((x) => x.id === model);
      if (!m) throw new Error(`unknown TTS model ${model} (mc voice models)`);
      const voices = m.supported_voices ?? [];
      return `${model}: ${voices.length} voices\n` + voices.map((v) => `  ${v.padEnd(16)} ${ELEVEN_VOICES[v] ?? ''}`).join('\n');
    },
  },
  'voice models': {
    help: 'Text-to-speech models available on OpenRouter (price per character, voice count).',
    async run() {
      return (await ttsModels()).map((m) => `${m.id.padEnd(40)} ${+m.pricing?.prompt ? `$${(m.pricing.prompt * 1e6).toFixed(2)}/M in` : ''}${+m.pricing?.completion ? ` $${(m.pricing.completion * 1e6).toFixed(2)}/M out` : ''}  ${(m.supported_voices ?? []).length} voices`).join('\n');
    },
  },
  'voice check': {
    usage: '[dialogueId...] [--speaker id] [--judge google/gemini-3.8-flash] [--all]',
    help: 'Listen to the recorded clips with an audio model: transcript vs text (similarity), French accent, naturalness and acting (1-10), problems (tag read aloud, stutter...). Prints the flagged lines (--all: every line).',
    async run(args, opts) {
      const ids = positionalIds(args);
      const judge = typeof opts.judge === 'string' ? opts.judge : DEFAULT_JUDGE;
      const doc = loadDialogue();
      const seen = new Set();
      const rows = voicePlan(doc).filter((r) => r.status === 'ok' && (!ids.length || ids.includes(r.dialogue)) && (!opts.speaker || r.speaker === opts.speaker) && !seen.has(r.key) && seen.add(r.key));
      const out = [];
      await pool(rows, 4, async (r) => {
        const line = doc.dialogues[r.dialogue][r.index];
        const bytes = fs.readFileSync(path.join(dataPath(VOICE_DIR), r.clip.file));
        try { out.push({ line: r.id, speaker: r.speaker, ...(await rate(judge, doc.speakers[r.speaker], line, bytes, r.clip.file.split('.').pop())) }); }
        catch (e) { out.push({ line: r.id, speaker: r.speaker, flags: ['error: ' + e.message] }); }
      });
      out.sort((a, b) => rows.findIndex((r) => r.id === a.line) - rows.findIndex((r) => r.id === b.line));
      const flagged = out.filter((x) => x.flags.length);
      const avg = (k) => Math.round((out.reduce((s, x) => s + (x[k] ?? 0), 0) / Math.max(1, out.length)) * 10) / 10;
      return { judge, checked: out.length, averages: { similarity: avg('similarity'), french: avg('french'), natural: avg('natural'), acting: avg('acting') }, flagged: flagged.length, lines: opts.all ? out : flagged };
    },
  },
};

/** Rate one clip with an audio model. */
async function rate(judge, sp, line, bytes, format) {
  const prompt = `Tu es directeur de casting voix pour un jeu vidéo d'action en français. Écoute ce clip et note-le sévèrement.
Personnage : ${sp?.name ?? line.speaker}${sp?.desc ? ` — ${sp.desc}` : ''}${sp?.radio !== false ? ' (parle à la radio)' : ''}
Texte attendu : "${line.text}"
Jeu demandé (balises d'émotion entre crochets, à jouer et non à lire) : "${line.spoken || line.text}"
Réponds UNIQUEMENT en JSON : {"transcript": "transcription exacte", "french": 1-10 (10 = francophone natif sans accent étranger), "natural": 1-10 (10 = indiscernable d'un vrai acteur), "acting": 1-10 (respect du jeu demandé et du personnage), "problems": "mots manquants ou ajoutés, balise lue à voix haute, bégaiement, artefact, coupure… ou chaîne vide"}`;
  const v = await askAboutAudio(judge, prompt, bytes, format);
  if (v.raw !== undefined) return { flags: ['unreadable judge answer: ' + v.raw] };
  const sim = similarity(v.transcript, line.spoken || line.text);
  const flags = [];
  if (sim < 0.85) flags.push(`text differs (similarity ${sim})`);
  if (v.french < 7) flags.push(`accent (${v.french}/10)`);
  if (v.natural < 6) flags.push(`unnatural (${v.natural}/10)`);
  if (v.acting < 6) flags.push(`acting (${v.acting}/10)`);
  const pb = String(v.problems ?? '').trim();
  if (pb && !/^(aucun|rien|néant|none|n\/a|-)/i.test(pb)) flags.push(pb);
  return { similarity: sim, french: v.french, natural: v.natural, acting: v.acting, flags, ...(flags.length ? { transcript: v.transcript } : {}) };
}
