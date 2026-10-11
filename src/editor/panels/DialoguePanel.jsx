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
  } catch (e) { log(`Lecture impossible : ${e.message}`, 'warn'); }
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
    log(`Voix : ${n} réplique${n > 1 ? 's' : ''} enregistrée${n > 1 ? 's' : ''} (${rep.chars} car., ${rep.estimatedCost})${rep.failed.length ? ` — ${rep.failed.length} échec(s) : ${rep.failed[0].error}` : ''}`, rep.failed.length ? 'warn' : undefined);
    await loadVoices();
  } catch (e) { log(`Échec de la génération des voix : ${e.message}`, 'error'); }
  finally { generating.value = false; }
}

/** Audition a speaker's AI voice on a sample line (nothing saved). */
async function auditionVoice(speakerId, sp, text) {
  try {
    const r = await fetch('/api/voice/say', { method: 'POST', body: JSON.stringify({ speaker: speakerId, voice: sp.tts?.voice, text }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'HTTP ' + r.status);
    playAudio(await r.blob(), sp.radio !== false, sp.radio !== false ? RADIO_DELAY : 0);
    if (sp.radio !== false) beep();
  } catch (e) { log(`Audition impossible : ${e.message}`, 'warn'); }
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
    for (const e of ed.world.entities.list) if (e.dialogue && typeof e.dialogue === 'string') (u[e.dialogue] ??= []).push({ entity: e.id, label: `PNJ ${e.name ?? e.id} (parler)` });
    return u;
  }, [mdoc, ver]);

  if (DD.status.value === 'error') {
    return (
      <div class="panel"><div class="main">
        <h2>💬 Dialogues</h2>
        <p class="err">{DD.file} : {DD.error.value}</p>
        <p class="hint">Le fichier n'a pas été modifié. Corrigez-le (ou attendez la fin de son écriture), puis rechargez.</p>
        <button onClick={() => DD.load({ force: true })}>Recharger</button>
      </div></div>
    );
  }
  if (!doc) return <div class="panel"><p class="hint">Chargement des dialogues…</p></div>;

  const update = (next, label, key) => DD.set(ed, next, label, key);
  const speakers = doc.speakers;
  const dialogues = doc.dialogues;
  const dids = Object.keys(dialogues);
  const sids = Object.keys(speakers);
  const cur = dids.includes(selDialogue.value) ? selDialogue.value : dids[0] ?? null;
  const curSp = sids.includes(selSpeaker.value) ? selSpeaker.value : sids[0] ?? null;
  const lines = cur ? dialogues[cur] ?? [] : [];
  const setLines = (ls, label = 'Modifier les répliques', key) => update({ ...doc, dialogues: { ...dialogues, [cur]: ls } }, label, key);
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
    if (r.n) MD.set(ed, r.doc, `Renommer ${kind}`);
    return r.n;
  };

  // --- dialogues ---
  const addDialogue = () => {
    const base = cur?.match(/^(m\d+)_/)?.[1] ? `${cur.match(/^(m\d+)_/)[1]}_nouveau` : 'nouveau_dialogue';
    const id = uniqueId(base, dids);
    update({ ...doc, dialogues: insertAfter(dialogues, cur, id, [{ speaker: curSp ?? '', text: '' }]) }, 'Ajouter un dialogue');
    selDialogue.value = id;
  };
  const dupDialogue = () => {
    if (!cur) return;
    const id = uniqueId(cur + '_copie', dids);
    update({ ...doc, dialogues: insertAfter(dialogues, cur, id, structuredClone(lines)) }, 'Dupliquer le dialogue');
    selDialogue.value = id;
  };
  const delDialogue = () => {
    if (!cur) return;
    const u = usage[cur]?.length ?? 0;
    if (!confirm(`Supprimer le dialogue « ${cur} » ?${u ? `\nIl est utilisé ${u} fois dans les missions.` : ''}`)) return;
    const d = { ...dialogues };
    delete d[cur];
    update({ ...doc, dialogues: d }, 'Supprimer le dialogue');
    const i = dids.indexOf(cur);
    selDialogue.value = dids[i + 1] ?? dids[i - 1] ?? null;
  };
  const renameDialogue = (to) => {
    to = to?.trim();
    if (!cur || !to || to === cur) return;
    if (to in dialogues) { log(`Le dialogue « ${to} » existe déjà`, 'warn'); return; }
    update({ ...doc, dialogues: renameKey(dialogues, cur, to) }, 'Renommer le dialogue');
    selDialogue.value = to;
    let n = renameInMissions('dialogue', cur, to);
    for (const e of ed.world.entities.list.filter((x) => x.dialogue === cur)) { ed.updateEntity(e.id, { ...e, dialogue: to }); n++; }
    if (n) log(`Dialogue ${cur} → ${to} : ${n} référence${n > 1 ? 's' : ''} mise${n > 1 ? 's' : ''} à jour (missions / PNJ)`);
  };

  // --- speakers ---
  const addSpeaker = () => {
    const id = uniqueId('personnage', sids);
    update({ ...doc, speakers: { ...speakers, [id]: { name: 'Nouveau personnage', radio: true, pitch: 1, rate: 1.05, voiceIndex: 0 } } }, 'Ajouter un personnage');
    selSpeaker.value = id;
  };
  const delSpeaker = () => {
    if (!curSp) return;
    const used = Object.values(dialogues).reduce((s, ls) => s + ls.filter((l) => l.speaker === curSp).length, 0);
    if (!confirm(`Supprimer le personnage « ${speakers[curSp]?.name ?? curSp} » ?${used ? `\n${used} réplique(s) l'utilisent encore.` : ''}`)) return;
    const sp = { ...speakers };
    delete sp[curSp];
    update({ ...doc, speakers: sp }, 'Supprimer le personnage');
    selSpeaker.value = null;
  };
  const renameSpeaker = (to) => {
    to = to?.trim();
    if (!curSp || !to || to === curSp) return;
    if (to in speakers) { log(`Le personnage « ${to} » existe déjà`, 'warn'); return; }
    const dl = Object.fromEntries(Object.entries(dialogues).map(([k, ls]) => [k, ls.map((l) => (l.speaker === curSp ? { ...l, speaker: to } : l))]));
    update({ ...doc, speakers: renameKey(speakers, curSp, to), dialogues: dl }, 'Renommer le personnage');
    selSpeaker.value = to;
    const n = renameInMissions('speaker', curSp, to);
    if (n) log(`Personnage ${curSp} → ${to} : ${n} réplique${n > 1 ? 's' : ''} « say » mise${n > 1 ? 's' : ''} à jour dans les missions`);
  };
  const putSpeaker = (k, v) => {
    const sp = { ...speakers[curSp], [k]: v };
    if (v === undefined) delete sp[k];
    update({ ...doc, speakers: { ...speakers, [curSp]: sp } }, 'Modifier le personnage', `sp.${curSp}.${k}`);
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
          <button class={'mini' + (dirty ? ' dirty' : '')} title="Enregistrer tous les fichiers modifiés (Ctrl+S)" onClick={() => ed.saveAll()}>💾 Enregistrer</button>
        </div>
        <p class="hint file">{DD.file}{DD.status.value === 'missing' && !dirty ? ' — absent, sera créé au premier enregistrement' : ''}{dirty ? ' — modifié, non enregistré' : ''}</p>
        <h4>Personnages <small>({sids.length})</small></h4>
        <div class="list mlist">
          {sids.map((id) => (
            <div class={'it' + (id === curSp ? ' sel' : '')} onClick={() => (selSpeaker.value = id)}>
              <span class="nm">{speakers[id].radio !== false ? '📻 ' : '🗣 '}{speakers[id].name ?? id}</span><small>{id}</small>
            </div>
          ))}
          {!sids.length && <p class="hint pad">Aucun personnage.</p>}
        </div>
        <div class="btns tight">
          <button onClick={addSpeaker}>+ Personnage</button>
          <button class="danger" disabled={!curSp} onClick={delSpeaker}>✕ Supprimer</button>
        </div>
        {sp && (
          <div class="mcard">
            <Row label="Identifiant" title="Utilisé par les répliques (renommer met à jour les références)"><Txt value={curSp} onChange={renameSpeaker} /></Row>
            <Row label="Nom affiché"><Txt value={sp.name} onChange={(v) => putSpeaker('name', v)} /></Row>
            <Row label="Description" title="Le personnage et sa voix (casting, aide pour la direction d'acteur ; pas envoyé au modèle de voix)"><Area value={sp.desc} rows={2} placeholder="Âge, caractère, façon de parler…" onChange={(v) => putSpeaker('desc', v || undefined)} /></Row>
            <Row label="Radio" title="Bip radio avant chaque réplique"><input type="checkbox" checked={sp.radio !== false} onChange={(e) => putSpeaker('radio', e.target.checked)} /><small>bip + voix radio</small></Row>
            <Row label="Voix IA" title="Voix enregistrée (ElevenLabs via OpenRouter). Changer de voix rend les répliques de ce personnage à régénérer.">
              <select value={sp.tts?.voice ?? ''} onChange={(e) => putSpeaker('tts', e.target.value ? { ...sp.tts, voice: e.target.value } : undefined)}>
                <option value="">— aucune (voix du navigateur) —</option>
                {sp.tts?.voice && !(sp.tts.voice in ELEVEN_VOICES) && <option value={sp.tts.voice}>{sp.tts.voice}</option>}
                {Object.entries(ELEVEN_VOICES).map(([id, hint]) => <option value={id}>{id} · {hint}</option>)}
              </select>
            </Row>
            {sp.tts?.voice && <div class="btns"><button onClick={() => auditionVoice(curSp, sp, `Ici ${sp.name?.replace(/\s*\(.*\)/, '') ?? curSp}. Tu me reçois ?`)}>▶ Auditionner la voix IA</button></div>}
            {!sp.tts?.voice && <>
            <Row label="Hauteur"><input type="range" min="0" max="2" step="0.05" value={sp.pitch ?? 1} onInput={(e) => putSpeaker('pitch', +e.target.value)} /><Num value={sp.pitch} placeholder={1} step={0.05} onChange={(v) => putSpeaker('pitch', v)} /></Row>
            <Row label="Débit"><input type="range" min="0.5" max="2" step="0.05" value={sp.rate ?? 1.05} onInput={(e) => putSpeaker('rate', +e.target.value)} /><Num value={sp.rate} placeholder={1.05} step={0.05} onChange={(v) => putSpeaker('rate', v)} /></Row>
            <Row label="Voix" title="Index dans les voix françaises du navigateur (modulo leur nombre)">
              {voices.length
                ? <select value={(sp.voiceIndex ?? 0) % voices.length} onChange={(e) => putSpeaker('voiceIndex', +e.target.value)}>{voices.map((v, i) => <option value={i}>{i} · {v.name}</option>)}</select>
                : <Num value={sp.voiceIndex} placeholder={0} int onChange={(v) => putSpeaker('voiceIndex', v)} />}
            </Row>
            {!voices.length && <p class="hint">Aucune voix française dans ce navigateur : l'aperçu utilise la voix par défaut.</p>}
            <div class="btns"><button onClick={() => playLines(doc, [{ speaker: curSp, text: `Ici ${sp.name ?? curSp}. Tu me reçois ?` }], null, 0, true)}>▶ Tester la voix</button></div>
            </>}
          </div>
        )}
      </div>

      <div class="side dlist">
        <h4>Dialogues <small>({dids.length})</small></h4>
        <input type="search" class="filter" placeholder="Filtrer (id ou texte)…" value={filter} onInput={(e) => setFilter(e.target.value)} />
        <div class="list mlist grow">
          {shown.map((id) => {
            const n = usage[id]?.length ?? 0;
            return (
              <div class={'it' + (id === cur ? ' sel' : '')} onClick={() => (selDialogue.value = id)} title={(dialogues[id][0]?.text ?? '')}>
                <span class="nm">{id}</span>
                <small>{dialogues[id].length} · {n ? <span class="used">×{n}</span> : <span class="unused">inutilisé</span>}</small>
              </div>
            );
          })}
          {!shown.length && <p class="hint pad">{dids.length ? 'Aucun résultat.' : 'Aucun dialogue.'}</p>}
        </div>
        <div class="btns tight">
          <button onClick={addDialogue}>+ Dialogue</button>
          <button disabled={!cur} title="Dupliquer" onClick={dupDialogue}>⧉</button>
          <button disabled={!cur} class="danger" title="Supprimer" onClick={delDialogue}>✕</button>
        </div>
      </div>

      <div class="mcol dmain">
        {DD.conflict.value && (
          <div class="conflict">
            ⚠ {DD.file} a été modifié sur le disque par un autre outil pendant vos modifications.
            <button onClick={() => DD.load({ force: true })}>Recharger depuis le disque</button>
            <button onClick={() => (DD.conflict.value = false)}>Garder ma version</button>
          </div>
        )}
        {cur ? (
          <>
            <div class="mhead">
              <h3>💬</h3>
              <span class="idf"><Txt value={cur} onChange={renameDialogue} title="Identifiant (renommer met à jour les missions)" /></span>
              <small>{lines.length} réplique{lines.length > 1 ? 's' : ''} · {total.toFixed(1)} s</small>
              <span class="grow" />
              {missingHere > 0 && <button disabled={generating.value} title="Enregistrer les voix IA manquantes de ce dialogue (OpenRouter, clé dans .env)" onClick={() => generateVoices(ed, [cur])}>{generating.value ? '🎙 Génération…' : `🎙 Générer les voix (${missingHere})`}</button>}
              {pv?.dialogue === cur
                ? <button onClick={stopPreview}>■ Arrêter</button>
                : <button class="play" disabled={!lines.length} onClick={() => playLines(doc, lines, cur)}>▶ Écouter</button>}
            </div>
            <div class="usage">
              {usage[cur]?.length
                ? <>Utilisé par : {usage[cur].map((u) => <button class="mini link" title={u.entity ? 'Voir le PNJ dans le monde 3D' : 'Ouvrir dans l\'éditeur de missions'} onClick={() => goUse(u)}>{u.label}</button>)}</>
                : <span class="hint">Aucune mission, aucun déclencheur ni PNJ ne lance ce dialogue (action « dialogue » avec id = {cur}, ou champ « dialogue » d'un PNJ).</span>}
            </div>
            <Subtitle pv={pv} />
            <div class="lines">
              {lines.map((l, i) => {
                const unknown = l.speaker && !speakers[l.speaker];
                const playing = pv?.dialogue === cur && pv.index === i;
                const clip = clipOf(l);
                const wantsVoice = !clip && !!voiceRequest(doc, l);
                const put = (k, v) => { const ls = [...lines]; ls[i] = { ...l, [k]: v }; if (v === undefined) delete ls[i][k]; setLines(ls, 'Modifier la réplique', `${cur}.${i}.${k}`); };
                return (
                  <div class={'line' + (playing ? ' playing' : '')}>
                    <span class="n">{i + 1}</span>
                    <div class="lc">
                      <div class="lh">
                        <select class={unknown || !l.speaker ? 'warn' : ''} value={l.speaker ?? ''} onChange={(e) => put('speaker', e.target.value)}>
                          {(!l.speaker || unknown) && <option value={l.speaker ?? ''}>{l.speaker ? `⚠ ${l.speaker} (inconnu)` : '— personnage —'}</option>}
                          {sids.map((id) => <option value={id}>{speakers[id].name ?? id}</option>)}
                        </select>
                        <label class="dur" title="Durée d'affichage en secondes (vide = automatique selon la longueur)">durée <Num value={l.duration} step={0.1} placeholder={'auto ' + dialogueDuration({ text: l.text }, clip, isRadio(l)).toFixed(1)} onChange={(v) => put('duration', v)} /></label>
                        <small>{(l.text ?? '').length} car.</small>
                        {clip && <small class="voice ok" title={`Voix enregistrée : ${clip.file}`}>🎙 {clip.duration.toFixed(1)} s</small>}
                        {wantsVoice && <small class="voice warn" title="Le texte, le jeu ou la voix ont changé : cliquez sur « Générer les voix » (sinon, voix du navigateur en jeu)">⚠ voix à générer</small>}
                        <span class="grow" />
                        <button class="mini" title="Écouter cette réplique" onClick={() => playLines(doc, lines, cur, i, true)}>▶</button>
                        <button class="mini" title="Écouter à partir d'ici" onClick={() => playLines(doc, lines, cur, i)}>▶▶</button>
                        <button class="mini" title="Monter" disabled={i === 0} onClick={() => { const ls = [...lines]; [ls[i - 1], ls[i]] = [ls[i], ls[i - 1]]; setLines(ls, 'Déplacer la réplique'); }}>↑</button>
                        <button class="mini" title="Descendre" disabled={i === lines.length - 1} onClick={() => { const ls = [...lines]; [ls[i + 1], ls[i]] = [ls[i], ls[i + 1]]; setLines(ls, 'Déplacer la réplique'); }}>↓</button>
                        <button class="mini" title="Dupliquer" onClick={() => setLines([...lines.slice(0, i + 1), structuredClone(l), ...lines.slice(i + 1)], 'Dupliquer la réplique')}>⧉</button>
                        <button class="mini danger" title="Supprimer" onClick={() => setLines(lines.filter((_, j) => j !== i), 'Supprimer la réplique')}>✕</button>
                      </div>
                      <Area value={l.text} rows={2} placeholder="Texte de la réplique (sous-titre et voix)" onChange={(v) => put('text', v ?? '')} />
                      {speakers[l.speaker]?.tts?.voice && <Area value={l.spoken} rows={2} placeholder={`Jeu d'acteur (voix IA) : le texte prononcé avec des balises d'émotion, ex. [sighs] Rien… [shouts] VAL ! — vide = texte ci-dessus`} onChange={(v) => put('spoken', v || undefined)} />}
                    </div>
                  </div>
                );
              })}
            </div>
            <div class="btns">
              <button onClick={() => setLines([...lines, { speaker: lines[lines.length - 1]?.speaker ?? curSp ?? '', text: '' }], 'Ajouter une réplique')}>+ Réplique</button>
            </div>
            <p class="hint">Durée par défaut : celle de la voix enregistrée, sinon 65 ms par caractère (minimum 2,2 s). Balises de jeu utiles : {AUDIO_TAGS.join(' ')}. Une réplique sans voix enregistrée à jour utilise la voix du navigateur en jeu.</p>
            {missingAll > missingHere && <p class="hint">{missingAll} réplique{missingAll > 1 ? 's' : ''} sans voix à jour dans tout le fichier. <button class="mini" disabled={generating.value} onClick={() => generateVoices(ed, [])}>🎙 Tout générer</button></p>}
          </>
        ) : <p class="hint">Aucun dialogue. Créez-en un avec « + Dialogue ».</p>}
      </div>
    </div>
  );
}

function Subtitle({ pv }) {
  if (!pv) return <div class="subtitle idle"><span class="hint">L'aperçu du sous-titre s'affiche ici pendant l'écoute.</span></div>;
  return (
    <div class="subtitle">
      <div><b>{pv.radio ? '📻 ' : ''}{pv.name}</b> : {pv.text}</div>
      <div class="bar" key={pv.t0} style={{ animationDuration: `${pv.dur}s` }} />
      <small>{pv.dialogue ? `${pv.index + 1}/${pv.n} · ` : ''}{pv.dur.toFixed(1)} s</small>
    </div>
  );
}
