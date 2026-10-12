// Dialogue editor (public/data/game/dialogue.json): speakers (name, AI voice, browser voice pitch /
// rate), dialogues = ordered lines (speaker, subtitle text, acted text with audio tags, optional
// duration). Lines are previewed with their recorded clip (public/data/voice/, generated here or
// with `mc voice generate`) or the browser's French speech synthesis + a subtitle, timed like in
// game. Shows which missions / triggers use each dialogue (renaming updates missions.json).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { S, log } from '../core.js';
import { Row } from '../ui/Fields.jsx';
import { missions as MD, dialogue as DD, sel, selDialogue, selSpeaker, voices as VM, loadVoices } from './missions/store.js';
import { Data } from '../../engine/core/Data.js';
import { radioFilter } from '../../engine/audio/Audio.js';
import { voiceClip, voiceRequest, ELEVEN_VOICES, AUDIO_TAGS, VOICE_DIR, RADIO_DELAY } from '../../game/missions/voice.js';
import { dialogueUsage, renameRefs, uniqueId, dialogueDuration } from './missions/schema.js';
import { Txt, Area, Num } from './missions/widgets.jsx';

// --- preview (recorded clip or speech synthesis + subtitle) -------------------------------------------
const preview = signal(null); // { dialogue, index, name, text, dur, radio, n }
const generating = signal(false);
let timer = null;
let audioCtx = null;
let clipSrc = null;
const clipBufs = new Map(); // url -> Promise<AudioBuffer>

/** Play an audio file (url or Blob) through the radio filter when `radio`. */
async function playAudio(src, radio, delay = 0) {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state !== 'running') await audioCtx.resume();
    let p = typeof src === 'string' ? clipBufs.get(src) : null;
    if (!p) {
      p = (typeof src === 'string' ? fetch(src).then((r) => r.arrayBuffer()) : src.arrayBuffer()).then((b) => audioCtx.decodeAudioData(b));
      if (typeof src === 'string') { clipBufs.set(src, p); p.catch(() => clipBufs.delete(src)); }
    }
    const buf = await p;
    clipSrc?.stop();
    const node = audioCtx.createBufferSource();
    node.buffer = buf;
    node.connect(radio ? radioFilter(audioCtx, audioCtx.destination) : audioCtx.destination);
    node.start(audioCtx.currentTime + delay);
    clipSrc = node;
  } catch (e) { log(`Cannot play: ${e.message}`, 'warn'); }
}

/** Record the missing voices of these dialogues (all when empty) through the dev API. */
async function generateVoices(ed, dialogues) {
  if (S.dirty.value[DD.file]) await ed.saveAll();
  generating.value = true;
  try {
    const r = await fetch('/api/voice/generate', { method: 'POST', body: JSON.stringify({ dialogues }) });
    const rep = await r.json();
    if (rep.error) throw new Error(rep.error);
    const n = rep.generated.length + rep.adopted.length;
    log(`Voices: ${n} line${n > 1 ? 's' : ''} recorded (${rep.chars} chars, ${rep.estimatedCost})${rep.failed.length ? ` — ${rep.failed.length} failed: ${rep.failed[0].error}` : ''}`, rep.failed.length ? 'warn' : undefined);
    await loadVoices();
  } catch (e) { log(`Voice generation failed: ${e.message}`, 'error'); }
  finally { generating.value = false; }
}

/** Audition a speaker's AI voice on a sample line (nothing saved). */
async function auditionVoice(speakerId, sp, text) {
  try {
    const r = await fetch('/api/voice/say', { method: 'POST', body: JSON.stringify({ speaker: speakerId, voice: sp.tts?.voice, text }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'HTTP ' + r.status);
    playAudio(await r.blob(), sp.radio !== false, sp.radio !== false ? RADIO_DELAY : 0);
    if (sp.radio !== false) beep();
  } catch (e) { log(`Cannot audition the voice: ${e.message}`, 'warn'); }
}

const frVoices = () => (typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('fr')));

function beep() {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(1450, t);
    o.frequency.setValueAtTime(1050, t + 0.06);
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.15);
  } catch { /* no audio */ }
}

function speak(text, sp) {
  if (typeof speechSynthesis === 'undefined') return;
  try {
    const u = new SpeechSynthesisUtterance(String(text ?? '').replace(/<[^>]+>/g, ''));
    u.lang = 'fr-FR';
    const vs = frVoices();
    if (vs.length) u.voice = vs[(sp.voiceIndex ?? 0) % vs.length];
    u.pitch = sp.pitch ?? 1;
    u.rate = sp.rate ?? 1.05;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* no speech */ }
}

export function stopPreview() {
  clearTimeout(timer);
  timer = null;
  try { clipSrc?.stop(); } catch { /* */ }
  clipSrc = null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  preview.value = null;
}

/** Play lines in sequence, each for its in-game duration (like Dialogue.js). */
function playLines(doc, lines, dialogueId, from = 0, only = false) {
  const speakers = doc.speakers;
  stopPreview();
  let i = from;
  const end = only ? from + 1 : lines.length;
  const next = () => {
    if (i >= end) { preview.value = null; return; }
    const l = lines[i];
    const sp = speakers[l.speaker] ?? { name: l.speaker };
    const radio = sp.radio !== false;
    const clip = voiceClip(VM.value, doc, l);
    const dur = dialogueDuration(l, clip, radio);
    preview.value = { dialogue: dialogueId, index: i, name: sp.name ?? l.speaker, text: l.text ?? '', dur, radio, n: lines.length, t0: performance.now(), clip: !!clip };
    if (radio) beep();
    if (clip) playAudio(Data.base + VOICE_DIR + clip.file, radio, radio ? RADIO_DELAY : 0);
    else speak(l.text, sp);
    i++;
    timer = setTimeout(next, dur * 1000);
  };
  next();
}

// --- panel -------------------------------------------------------------------------------------
export function DialoguePanel({ ed }) {
  useEffect(() => { DD.load(); MD.load(); loadVoices(); return () => stopPreview(); }, []);
  const [voices, setVoices] = useState(frVoices());
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const f = () => setVoices(frVoices());
    speechSynthesis.addEventListener?.('voiceschanged', f);
    return () => speechSynthesis.removeEventListener?.('voiceschanged', f);
  }, []);
  const [filter, setFilter] = useState('');
  const doc = DD.doc.value;
  const mdoc = MD.doc.value;
  const ver = S.version.value; // world entities changed
  const usage = useMemo(() => {
    const u = dialogueUsage(mdoc);
    // NPCs the player can talk to (world entity field "dialogue")
    for (const e of ed.world.entities.list) if (e.dialogue && typeof e.dialogue === 'string') (u[e.dialogue] ??= []).push({ entity: e.id, label: `NPC ${e.name ?? e.id} (talk)` });
    return u;
  }, [mdoc, ver]);

  if (DD.status.value === 'error') {
    return (
      <div class="panel"><div class="main">
        <h2>💬 Dialogues</h2>
        <p class="err">{DD.file}: {DD.error.value}</p>
        <p class="hint">The file was not modified. Fix it (or wait until it has been fully written), then reload.</p>
        <button onClick={() => DD.load({ force: true })}>Reload</button>
      </div></div>
    );
  }
  if (!doc) return <div class="panel"><p class="hint">Loading dialogues…</p></div>;

  const update = (next, label, key) => DD.set(ed, next, label, key);
  const speakers = doc.speakers;
  const dialogues = doc.dialogues;
  const dids = Object.keys(dialogues);
  const sids = Object.keys(speakers);
  const cur = dids.includes(selDialogue.value) ? selDialogue.value : dids[0] ?? null;
  const curSp = sids.includes(selSpeaker.value) ? selSpeaker.value : sids[0] ?? null;
  const lines = cur ? dialogues[cur] ?? [] : [];
  const setLines = (ls, label = 'Edit lines', key) => update({ ...doc, dialogues: { ...dialogues, [cur]: ls } }, label, key);
  const dirty = !!S.dirty.value[DD.file];

  // keeps the key order of an object while renaming / inserting
  const renameKey = (obj, from, to) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]));
  const insertAfter = (obj, after, key, val) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) { out[k] = v; if (k === after) out[key] = val; }
    if (!(key in out)) out[key] = val;
    return out;
  };
  /** Also update missions.json (dialogue / say actions). */
  const renameInMissions = (kind, from, to) => {
    if (!mdoc) return 0;
    const r = renameRefs(mdoc, kind, from, to);
    if (r.n) MD.set(ed, r.doc, `Rename ${kind}`);
    return r.n;
  };

  // --- dialogues ---
  const addDialogue = () => {
    const base = cur?.match(/^(m\d+)_/)?.[1] ? `${cur.match(/^(m\d+)_/)[1]}_new` : 'new_dialogue';
    const id = uniqueId(base, dids);
    update({ ...doc, dialogues: insertAfter(dialogues, cur, id, [{ speaker: curSp ?? '', text: '' }]) }, 'Add dialogue');
    selDialogue.value = id;
  };
  const dupDialogue = () => {
    if (!cur) return;
    const id = uniqueId(cur + '_copy', dids);
    update({ ...doc, dialogues: insertAfter(dialogues, cur, id, structuredClone(lines)) }, 'Duplicate dialogue');
    selDialogue.value = id;
  };
  const delDialogue = () => {
    if (!cur) return;
    const u = usage[cur]?.length ?? 0;
    if (!confirm(`Delete dialogue "${cur}"?${u ? `\nIt is used ${u} time${u > 1 ? 's' : ''} (missions / NPCs).` : ''}`)) return;
    const d = { ...dialogues };
    delete d[cur];
    update({ ...doc, dialogues: d }, 'Delete dialogue');
    const i = dids.indexOf(cur);
    selDialogue.value = dids[i + 1] ?? dids[i - 1] ?? null;
  };
  const renameDialogue = (to) => {
    to = to?.trim();
    if (!cur || !to || to === cur) return;
    if (to in dialogues) { log(`Dialogue "${to}" already exists`, 'warn'); return; }
    update({ ...doc, dialogues: renameKey(dialogues, cur, to) }, 'Rename dialogue');
    selDialogue.value = to;
    let n = renameInMissions('dialogue', cur, to);
    for (const e of ed.world.entities.list.filter((x) => x.dialogue === cur)) { ed.updateEntity(e.id, { ...e, dialogue: to }); n++; }
    if (n) log(`Dialogue ${cur} → ${to}: ${n} reference${n > 1 ? 's' : ''} updated (missions / NPCs)`);
  };

  // --- speakers ---
  const addSpeaker = () => {
    const id = uniqueId('speaker', sids);
    update({ ...doc, speakers: { ...speakers, [id]: { name: 'Nouveau personnage', radio: true, pitch: 1, rate: 1.05, voiceIndex: 0 } } }, 'Add speaker');
    selSpeaker.value = id;
  };
  const delSpeaker = () => {
    if (!curSp) return;
    const used = Object.values(dialogues).reduce((s, ls) => s + ls.filter((l) => l.speaker === curSp).length, 0);
    if (!confirm(`Delete speaker "${speakers[curSp]?.name ?? curSp}"?${used ? `\n${used} line${used > 1 ? 's' : ''} still use${used > 1 ? '' : 's'} it.` : ''}`)) return;
    const sp = { ...speakers };
    delete sp[curSp];
    update({ ...doc, speakers: sp }, 'Delete speaker');
    selSpeaker.value = null;
  };
  const renameSpeaker = (to) => {
    to = to?.trim();
    if (!curSp || !to || to === curSp) return;
    if (to in speakers) { log(`Speaker "${to}" already exists`, 'warn'); return; }
    const dl = Object.fromEntries(Object.entries(dialogues).map(([k, ls]) => [k, ls.map((l) => (l.speaker === curSp ? { ...l, speaker: to } : l))]));
    update({ ...doc, speakers: renameKey(speakers, curSp, to), dialogues: dl }, 'Rename speaker');
    selSpeaker.value = to;
    const n = renameInMissions('speaker', curSp, to);
    if (n) log(`Speaker ${curSp} → ${to}: ${n} "say" line${n > 1 ? 's' : ''} updated in the missions`);
  };
  const putSpeaker = (k, v) => {
    const sp = { ...speakers[curSp], [k]: v };
    if (v === undefined) delete sp[k];
    update({ ...doc, speakers: { ...speakers, [curSp]: sp } }, 'Edit speaker', `sp.${curSp}.${k}`);
  };

  const f = filter.trim().toLowerCase();
  const shown = f ? dids.filter((id) => id.toLowerCase().includes(f) || dialogues[id].some((l) => (l.text ?? '').toLowerCase().includes(f))) : dids;
  const vm = VM.value;
  const clipOf = (l) => voiceClip(vm, doc, l);
  const isRadio = (l) => speakers[l.speaker]?.radio !== false;
  const total = lines.reduce((s, l) => s + dialogueDuration(l, clipOf(l), isRadio(l)), 0);
  const missingIn = (ls) => ls.filter((l) => voiceRequest(doc, l) && !clipOf(l)).length;
  const missingHere = missingIn(lines);
  const missingAll = Object.values(dialogues).reduce((n, ls) => n + missingIn(ls), 0);
  const sp = curSp ? speakers[curSp] : null;
  const pv = preview.value;
  const goUse = (u) => {
    if (u.entity) { ed.select([u.entity]); ed.frameSelection(); S.panel.value = 'world'; return; }
    sel.value = u.t !== undefined ? { kind: 'trigger', i: u.t, obj: null } : { kind: 'mission', i: u.m, obj: u.o ?? null };
    S.panel.value = 'missions';
  };

  return (
    <div class="panel dpanel">
      <div class="side dside">
        <div class="mtitle">
          <h2>💬 Dialogues</h2>
          <span class="grow" />
          <button class={'mini' + (dirty ? ' dirty' : '')} title="Save all modified files (Ctrl+S)" onClick={() => ed.saveAll()}>💾 Save</button>
        </div>
        <p class="hint file">{DD.file}{DD.status.value === 'missing' && !dirty ? ' — missing, will be created on first save' : ''}{dirty ? ' — modified, not saved' : ''}</p>
        <h4>Speakers <small>({sids.length})</small></h4>
        <div class="list mlist">
          {sids.map((id) => (
            <div class={'it' + (id === curSp ? ' sel' : '')} onClick={() => (selSpeaker.value = id)}>
              <span class="nm">{speakers[id].radio !== false ? '📻 ' : '🗣 '}{speakers[id].name ?? id}</span><small>{id}</small>
            </div>
          ))}
          {!sids.length && <p class="hint pad">No speakers.</p>}
        </div>
        <div class="btns tight">
          <button onClick={addSpeaker}>+ Speaker</button>
          <button class="danger" disabled={!curSp} onClick={delSpeaker}>✕ Delete</button>
        </div>
        {sp && (
          <div class="mcard">
            <Row label="ID" title="Used by the lines (renaming updates the references)"><Txt value={curSp} onChange={renameSpeaker} /></Row>
            <Row label="Display name"><Txt value={sp.name} onChange={(v) => putSpeaker('name', v)} /></Row>
            <Row label="Description" title="The character and their voice (casting, a guide for directing the acting; not sent to the voice model)"><Area value={sp.desc} rows={2} placeholder="Age, personality, way of speaking…" onChange={(v) => putSpeaker('desc', v || undefined)} /></Row>
            <Row label="Radio" title="Radio beep before each line"><input type="checkbox" checked={sp.radio !== false} onChange={(e) => putSpeaker('radio', e.target.checked)} /><small>beep + radio voice</small></Row>
            <Row label="AI voice" title="Recorded voice (ElevenLabs via OpenRouter). Changing the voice means this speaker's lines must be generated again.">
              <select value={sp.tts?.voice ?? ''} onChange={(e) => putSpeaker('tts', e.target.value ? { ...sp.tts, voice: e.target.value } : undefined)}>
                <option value="">— none (browser voice) —</option>
                {sp.tts?.voice && !(sp.tts.voice in ELEVEN_VOICES) && <option value={sp.tts.voice}>{sp.tts.voice}</option>}
                {Object.entries(ELEVEN_VOICES).map(([id, hint]) => <option value={id}>{id} · {hint}</option>)}
              </select>
            </Row>
            {sp.tts?.voice && <div class="btns"><button onClick={() => auditionVoice(curSp, sp, `Ici ${sp.name?.replace(/\s*\(.*\)/, '') ?? curSp}. Tu me reçois ?`)}>▶ Audition the AI voice</button></div>}
            {!sp.tts?.voice && <>
            <Row label="Pitch"><input type="range" min="0" max="2" step="0.05" value={sp.pitch ?? 1} onInput={(e) => putSpeaker('pitch', +e.target.value)} /><Num value={sp.pitch} placeholder={1} step={0.05} onChange={(v) => putSpeaker('pitch', v)} /></Row>
            <Row label="Rate"><input type="range" min="0.5" max="2" step="0.05" value={sp.rate ?? 1.05} onInput={(e) => putSpeaker('rate', +e.target.value)} /><Num value={sp.rate} placeholder={1.05} step={0.05} onChange={(v) => putSpeaker('rate', v)} /></Row>
            <Row label="Voice" title="Index into the browser's French voices (modulo their count)">
              {voices.length
                ? <select value={(sp.voiceIndex ?? 0) % voices.length} onChange={(e) => putSpeaker('voiceIndex', +e.target.value)}>{voices.map((v, i) => <option value={i}>{i} · {v.name}</option>)}</select>
                : <Num value={sp.voiceIndex} placeholder={0} int onChange={(v) => putSpeaker('voiceIndex', v)} />}
            </Row>
            {!voices.length && <p class="hint">No French voice in this browser: the preview uses the default voice.</p>}
            <div class="btns"><button onClick={() => playLines(doc, [{ speaker: curSp, text: `Ici ${sp.name ?? curSp}. Tu me reçois ?` }], null, 0, true)}>▶ Test the voice</button></div>
            </>}
          </div>
        )}
      </div>

      <div class="side dlist">
        <h4>Dialogues <small>({dids.length})</small></h4>
        <input type="search" class="filter" placeholder="Filter (id or text)…" value={filter} onInput={(e) => setFilter(e.target.value)} />
        <div class="list mlist grow">
          {shown.map((id) => {
            const n = usage[id]?.length ?? 0;
            return (
              <div class={'it' + (id === cur ? ' sel' : '')} onClick={() => (selDialogue.value = id)} title={(dialogues[id][0]?.text ?? '')}>
                <span class="nm">{id}</span>
                <small>{dialogues[id].length} · {n ? <span class="used">×{n}</span> : <span class="unused">unused</span>}</small>
              </div>
            );
          })}
          {!shown.length && <p class="hint pad">{dids.length ? 'No results.' : 'No dialogues.'}</p>}
        </div>
        <div class="btns tight">
          <button onClick={addDialogue}>+ Dialogue</button>
          <button disabled={!cur} title="Duplicate" onClick={dupDialogue}>⧉</button>
          <button disabled={!cur} class="danger" title="Delete" onClick={delDialogue}>✕</button>
        </div>
      </div>

      <div class="mcol dmain">
        {DD.conflict.value && (
          <div class="conflict">
            ⚠ {DD.file} was modified on disk by another tool while you were editing it.
            <button onClick={() => DD.load({ force: true })}>Reload from disk</button>
            <button onClick={() => (DD.conflict.value = false)}>Keep my version</button>
          </div>
        )}
        {cur ? (
          <>
            <div class="mhead">
              <h3>💬</h3>
              <span class="idf"><Txt value={cur} onChange={renameDialogue} title="ID (renaming updates the missions)" /></span>
              <small>{lines.length} line{lines.length > 1 ? 's' : ''} · {total.toFixed(1)} s</small>
              <span class="grow" />
              {missingHere > 0 && <button disabled={generating.value} title="Record the missing AI voices of this dialogue (OpenRouter, key in .env)" onClick={() => generateVoices(ed, [cur])}>{generating.value ? '🎙 Generating…' : `🎙 Generate voices (${missingHere})`}</button>}
              {pv?.dialogue === cur
                ? <button onClick={stopPreview}>■ Stop</button>
                : <button class="play" disabled={!lines.length} onClick={() => playLines(doc, lines, cur)}>▶ Play</button>}
            </div>
            <div class="usage">
              {usage[cur]?.length
                ? <>Used by: {usage[cur].map((u) => <button class="mini link" title={u.entity ? 'Show the NPC in the 3D world' : 'Open in the missions editor'} onClick={() => goUse(u)}>{u.label}</button>)}</>
                : <span class="hint">No mission, trigger or NPC starts this dialogue ("dialogue" action with id = {cur}, or the "dialogue" field of an NPC).</span>}
            </div>
            <Subtitle pv={pv} />
            <div class="lines">
              {lines.map((l, i) => {
                const unknown = l.speaker && !speakers[l.speaker];
                const playing = pv?.dialogue === cur && pv.index === i;
                const clip = clipOf(l);
                const wantsVoice = !clip && !!voiceRequest(doc, l);
                const put = (k, v) => { const ls = [...lines]; ls[i] = { ...l, [k]: v }; if (v === undefined) delete ls[i][k]; setLines(ls, 'Edit line', `${cur}.${i}.${k}`); };
                return (
                  <div class={'line' + (playing ? ' playing' : '')}>
                    <span class="n">{i + 1}</span>
                    <div class="lc">
                      <div class="lh">
                        <select class={unknown || !l.speaker ? 'warn' : ''} value={l.speaker ?? ''} onChange={(e) => put('speaker', e.target.value)}>
                          {(!l.speaker || unknown) && <option value={l.speaker ?? ''}>{l.speaker ? `⚠ ${l.speaker} (unknown)` : '— speaker —'}</option>}
                          {sids.map((id) => <option value={id}>{speakers[id].name ?? id}</option>)}
                        </select>
                        <label class="dur" title="Display time in seconds (empty = automatic, from the length)">duration <Num value={l.duration} step={0.1} placeholder={'auto ' + dialogueDuration({ text: l.text }, clip, isRadio(l)).toFixed(1)} onChange={(v) => put('duration', v)} /></label>
                        <small>{(l.text ?? '').length} chars</small>
                        {clip && <small class="voice ok" title={`Recorded voice: ${clip.file}`}>🎙 {clip.duration.toFixed(1)} s</small>}
                        {wantsVoice && <small class="voice warn" title='The text, acting or voice changed: click "Generate voices" (until then the game uses the browser voice)'>⚠ voice to generate</small>}
                        <span class="grow" />
                        <button class="mini" title="Play this line" onClick={() => playLines(doc, lines, cur, i, true)}>▶</button>
                        <button class="mini" title="Play from here" onClick={() => playLines(doc, lines, cur, i)}>▶▶</button>
                        <button class="mini" title="Move up" disabled={i === 0} onClick={() => { const ls = [...lines]; [ls[i - 1], ls[i]] = [ls[i], ls[i - 1]]; setLines(ls, 'Move line'); }}>↑</button>
                        <button class="mini" title="Move down" disabled={i === lines.length - 1} onClick={() => { const ls = [...lines]; [ls[i + 1], ls[i]] = [ls[i], ls[i + 1]]; setLines(ls, 'Move line'); }}>↓</button>
                        <button class="mini" title="Duplicate" onClick={() => setLines([...lines.slice(0, i + 1), structuredClone(l), ...lines.slice(i + 1)], 'Duplicate line')}>⧉</button>
                        <button class="mini danger" title="Delete" onClick={() => setLines(lines.filter((_, j) => j !== i), 'Delete line')}>✕</button>
                      </div>
                      <Area value={l.text} rows={2} placeholder="Line text (subtitle and voice)" onChange={(v) => put('text', v ?? '')} />
                      {speakers[l.speaker]?.tts?.voice && <Area value={l.spoken} rows={2} placeholder={`Acting (AI voice): the spoken text with emotion tags, e.g. [sighs] Rien… [shouts] VAL ! — empty = text above`} onChange={(v) => put('spoken', v || undefined)} />}
                    </div>
                  </div>
                );
              })}
            </div>
            <div class="btns">
              <button onClick={() => setLines([...lines, { speaker: lines[lines.length - 1]?.speaker ?? curSp ?? '', text: '' }], 'Add line')}>+ Line</button>
            </div>
            <p class="hint">Default duration: the recorded voice's, otherwise 65 ms per character (minimum 2.2 s). Useful acting tags: {AUDIO_TAGS.join(' ')}. In game, a line without an up-to-date recorded voice uses the browser voice.</p>
            {missingAll > missingHere && <p class="hint">{missingAll} line{missingAll > 1 ? 's' : ''} without an up-to-date voice in the whole file. <button class="mini" disabled={generating.value} onClick={() => generateVoices(ed, [])}>🎙 Generate all</button></p>}
          </>
        ) : <p class="hint">No dialogues. Create one with "+ Dialogue".</p>}
      </div>
    </div>
  );
}

function Subtitle({ pv }) {
  if (!pv) return <div class="subtitle idle"><span class="hint">The subtitle preview shows here during playback.</span></div>;
  return (
    <div class="subtitle">
      <div><b>{pv.radio ? '📻 ' : ''}{pv.name}</b>: {pv.text}</div>
      <div class="bar" key={pv.t0} style={{ animationDuration: `${pv.dur}s` }} />
      <small>{pv.dialogue ? `${pv.index + 1}/${pv.n} · ` : ''}{pv.dur.toFixed(1)} s</small>
    </div>
  );
}
