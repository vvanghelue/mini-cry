// Voice line generation (text-to-speech through OpenRouter's /audio/speech, key OPENROUTER_API_KEY
// in .env). Used by `mc voice ...` and by the dev API (editor 💬 "Générer les voix"). Clips go to
// public/data/voice/<key>.mp3 (or .wav for PCM-only models) and are listed in voice/manifest.json
// with their duration; the key comes from src/game/missions/voice.js. A clip file already on disk
// is adopted instead of regenerated (an interrupted run costs nothing); replaced or orphaned clips
// are moved to .mc-backup/voice/.
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON, dataPath, ROOT } from './data.js';
import { requireEnv } from './env.js';
import { voiceRequest, voiceKey, VOICE_DIR, VOICE_MANIFEST } from '../../src/game/missions/voice.js';

const API = 'https://openrouter.ai/api/v1';
const BACKUP = path.join(ROOT, '.mc-backup', 'voice');
const MAX_BACKUPS = 300;
const r3 = (v) => Math.round(v * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- audio files

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Duration (s) of an MPEG layer III stream, by walking its frames (CBR or VBR; skips ID3 and a Xing/Info frame). */
export function mp3Duration(b) {
  let p = 0;
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'ID3') p = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  let samples = 0, rate = 0, first = true;
  while (p + 4 <= b.length) {
    const h = b.readUInt32BE(p);
    const ver = (h >>> 19) & 3, layer = (h >>> 17) & 3, bi = (h >>> 12) & 15, si = (h >>> 10) & 3;
    if ((h >>> 21) !== 0x7ff || ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) { p++; continue; }
    const sr = MP3_RATES[ver][si], v1 = ver === 3;
    const len = Math.floor(((v1 ? 144000 : 72000) * (v1 ? MP3_KBPS_V1 : MP3_KBPS_V2)[bi]) / sr) + ((h >>> 9) & 1);
    const spf = v1 ? 1152 : 576;
    const tag = b.toString('latin1', p + 4, Math.min(b.length, p + 4 + 40));
    if (!(first && /Xing|Info/.test(tag))) samples += spf;
    first = false;
    rate = sr;
    p += len;
  }
  return rate ? samples / rate : 0;
}

export function wavDuration(b) {
  let p = 12, bytesPerSec = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4), n = b.readUInt32LE(p + 4);
    if (id === 'fmt ') bytesPerSec = b.readUInt32LE(p + 16);
    if (id === 'data') return bytesPerSec ? n / bytesPerSec : 0;
    p += 8 + n + (n & 1);
  }
  return 0;
}

export const clipDuration = (bytes, ext) => (ext === 'wav' ? wavDuration(bytes) : mp3Duration(bytes));

function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------------------------------------------------------------- OpenRouter

async function post(route, body, { tries = 3 } = {}) {
  const key = requireEnv('OPENROUTER_API_KEY');
  for (let i = 1; ; i++) {
    const r = await fetch(API + route, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Mini Cry' }, body: JSON.stringify(body) });
    if (r.ok || i >= tries || ![429, 500, 502, 503, 504].includes(r.status)) return r;
    await sleep(1500 * i);
  }
}

/** Speak one request ({ model, voice, input, instructions? }) -> { bytes, ext: 'mp3' | 'wav', duration }. */
export async function synthesize(req) {
  const body = { model: req.model, voice: req.voice, input: req.input, response_format: 'mp3' };
  if (req.instructions) body.instructions = req.instructions;
  let r = await post('/audio/speech', body);
  if (r.status === 400) {
    const txt = await r.text();
    if (!/pcm/i.test(txt)) throw new Error(`${req.model} 400: ${txt.slice(0, 300)}`);
    body.response_format = 'pcm'; // Gemini TTS only returns raw PCM
    r = await post('/audio/speech', body);
  }
  if (!r.ok) throw new Error(`${req.model} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const type = r.headers.get('content-type') ?? '';
  if (type.includes('pcm')) {
    const rate = +(type.match(/rate=(\d+)/)?.[1] ?? 24000);
    return { bytes: pcmToWav(bytes, rate), ext: 'wav', duration: bytes.length / 2 / rate };
  }
  return { bytes, ext: 'mp3', duration: mp3Duration(bytes) };
}

let modelsCache = null;
/** Public model list (no key needed): TTS models with pricing and supported voices. */
export async function ttsModels() {
  if (!modelsCache) {
    const r = await fetch(API + '/models?output_modalities=speech');
    if (!r.ok) throw new Error('models list: HTTP ' + r.status);
    modelsCache = (await r.json()).data ?? [];
  }
  return modelsCache;
}

/** $ estimate for `chars` characters (null when the model is not billed per character). */
export async function estimateCost(model, chars) {
  try {
    const m = (await ttsModels()).find((x) => x.id === model);
    if (!m || +m.pricing?.completion) return null;
    return Math.round(chars * +m.pricing.prompt * 1000) / 1000;
  } catch { return null; }
}

/** Ask an audio-capable chat model about a clip; returns its parsed JSON answer. */
export async function askAboutAudio(model, prompt, bytes, format) {
  const r = await post('/chat/completions', {
    model, temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: bytes.toString('base64'), format } }] }],
  });
  if (!r.ok) throw new Error(`${model} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const txt = (await r.json()).choices?.[0]?.message?.content ?? '';
  try { return JSON.parse(txt.replace(/^\s*```(?:json)?|```\s*$/g, '').trim()); } catch { return { raw: txt.slice(0, 300) }; }
}

// ---------------------------------------------------------------- plan / generate

const voiceDir = () => dataPath(VOICE_DIR);
const fileFor = (key) => ['mp3', 'wav'].map((ext) => `${key}.${ext}`).find((f) => fs.existsSync(path.join(voiceDir(), f)));

function stash(file) {
  const src = path.join(voiceDir(), file);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(BACKUP, { recursive: true });
  fs.renameSync(src, path.join(BACKUP, new Date().toISOString().replace(/[:.]/g, '-') + '__' + file));
  const all = fs.readdirSync(BACKUP).sort();
  for (const f of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) fs.rmSync(path.join(BACKUP, f));
}

export const loadDialogue = () => readJSON('game/dialogue.json', { speakers: {}, dialogues: {} });
export const loadManifest = () => readJSON(VOICE_MANIFEST, { lines: {} });

/** Every dialogue line with its TTS request, key and clip status ('ok' | 'missing' | 'novoice'). */
export function voicePlan(doc = loadDialogue(), manifest = loadManifest()) {
  const rows = [];
  for (const [dialogue, lines] of Object.entries(doc.dialogues ?? {})) {
    lines.forEach((line, index) => {
      const req = voiceRequest(doc, line);
      const key = req ? voiceKey(req) : null;
      const clip = key ? manifest.lines?.[key] : null;
      const status = !req ? 'novoice' : clip && fs.existsSync(path.join(voiceDir(), clip.file)) ? 'ok' : 'missing';
      rows.push({ id: `${dialogue}#${index}`, dialogue, index, speaker: line.speaker, text: line.text ?? '', req, key, clip, status });
    });
  }
  return rows;
}

/**
 * Generate the missing clips. opts: { dialogues?: [ids], speaker?: id, force? (re-record the
 * selection), dry? (only count), concurrency = 4, log?(msg) }. A run without a selection also
 * drops orphan clips. Returns a report.
 */
export async function generateVoices({ dialogues, speaker, force = false, dry = false, concurrency = 4, log = () => {} } = {}) {
  const doc = loadDialogue();
  const manifest = loadManifest();
  manifest.lines ??= {};
  const rows = voicePlan(doc, manifest);
  const selected = (r) => r.req && (!dialogues?.length || dialogues.includes(r.dialogue)) && (!speaker || r.speaker === speaker);
  for (const d of dialogues ?? []) if (!doc.dialogues?.[d]) throw new Error(`unknown dialogue ${d}`);
  if (speaker && !doc.speakers?.[speaker]) throw new Error(`unknown speaker ${speaker}`);
  const todo = new Map();
  for (const r of rows) if (selected(r) && (force || r.status !== 'ok')) todo.set(r.key, r);
  const jobs = [...todo.values()];
  const chars = jobs.reduce((s, r) => s + r.req.input.length, 0);
  const byModel = {};
  for (const r of jobs) byModel[r.req.model] = (byModel[r.req.model] ?? 0) + r.req.input.length;
  let cost = 0;
  for (const [m, n] of Object.entries(byModel)) { const c = await estimateCost(m, n); cost = c == null || cost == null ? null : cost + c; }
  const report = { lines: jobs.length, chars, estimatedCost: cost == null ? 'unknown (not billed per character)' : `$${cost.toFixed(3)}`, generated: [], adopted: [], failed: [], pruned: [] };
  if (dry) { report.dry = true; report.todo = jobs.map((r) => `${r.id} ${r.speaker}: ${r.req.input}`); return report; }

  fs.mkdirSync(voiceDir(), { recursive: true });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const r = jobs[next++];
      const existing = fileFor(r.key);
      try {
        if (existing && !force) {
          manifest.lines[r.key] = { file: existing, duration: r3(clipDuration(fs.readFileSync(path.join(voiceDir(), existing)), existing.split('.').pop())) };
          report.adopted.push(r.id);
          continue;
        }
        const t0 = Date.now();
        const out = await synthesize(r.req);
        if (existing) stash(existing);
        const file = `${r.key}.${out.ext}`;
        fs.writeFileSync(path.join(voiceDir(), file), out.bytes);
        manifest.lines[r.key] = { file, duration: r3(out.duration) };
        report.generated.push(r.id);
        log(`${r.id} ${r.speaker} ${out.duration.toFixed(1)} s (${Date.now() - t0} ms)`);
      } catch (e) {
        report.failed.push({ line: r.id, error: e.message });
        log(`${r.id} FAILED ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));

  // labels (first line using each clip) + orphans (only on a full run: a partial run sees everything anyway)
  const used = new Map();
  for (const r of rows) if (r.key && manifest.lines[r.key] && !used.has(r.key)) used.set(r.key, r);
  const full = !dialogues?.length && !speaker;
  const lines = {};
  for (const [key, e] of Object.entries(manifest.lines)) {
    const r = used.get(key);
    if (!r) { if (full) { stash(e.file); report.pruned.push(key); } else lines[key] = e; continue; }
    lines[key] = { file: e.file, duration: e.duration, dialogue: r.dialogue, line: r.index, speaker: r.speaker, model: r.req.model, voice: r.req.voice };
  }
  if (full) for (const f of fs.readdirSync(voiceDir())) if (/\.(mp3|wav)$/.test(f) && !lines[f.replace(/\.\w+$/, '')]) { stash(f); report.pruned.push(f); }
  const sorted = Object.fromEntries(Object.entries(lines).sort(([, a], [, b]) => `${a.dialogue}#${String(a.line).padStart(3, '0')}`.localeCompare(`${b.dialogue}#${String(b.line).padStart(3, '0')}`)));
  writeJSON(VOICE_MANIFEST, { generator: 'mc voice generate (OpenRouter text-to-speech)', lines: sorted });
  report.clips = Object.keys(sorted).length;
  report.seconds = r3(Object.values(sorted).reduce((s, e) => s + e.duration, 0));
  return report;
}
