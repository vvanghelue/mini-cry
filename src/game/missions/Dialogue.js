// Radio / dialogue lines (public/data/game/dialogue.json): subtitles with speaker names, a radio
// beep, and voices: recorded TTS clips (public/data/voice/, `mc voice generate`, see voice.js) or,
// for lines without an up-to-date clip, the browser's French speech synthesis (per-speaker pitch /
// rate). A recorded line lasts as long as its clip; it waits (up to 1.5 s) for the clip to be
// decoded so the voice and its subtitle start together.
import { Data } from '../../engine/core/Data.js';
import { voiceClip, lineDuration, VOICE_DIR, RADIO_DELAY } from './voice.js';

const CLIP_WAIT = 1.5; // s: max wait for a clip to decode before showing the line without it

export class Dialogue {
  constructor(game, data, voices) {
    this.game = game;
    this.data = data ?? { speakers: {}, dialogues: {} };
    this.voices = voices ?? { lines: {} }; // voice/manifest.json
    this.queue = [];
    this.current = null;
    this.t = 0;
    this.voice = game.settings?.voices ?? true;
    this._clips = new WeakMap(); // line -> { url, duration } | null
    this._clip = null; // playing clip handle
    this._holding = -1; // s spent waiting for the current line's clip (< 0: not waiting)
    this._voices = [];
    if (typeof speechSynthesis !== 'undefined') {
      const load = () => (this._voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('fr')));
      load();
      speechSynthesis.onvoiceschanged = load;
    }
  }

  lines(id) { return this.data.dialogues?.[id] ?? []; }

  /** Total duration of a dialogue (s). */
  duration(id) { return this.lines(id).reduce((s, l) => s + this._dur(l), 0); }
  _dur(l) { return lineDuration(l, this.clip(l), this._speaker(l).radio !== false); }
  _speaker(l) { return this.data.speakers?.[l.speaker] ?? { name: l.speaker }; }

  /** The recorded clip of a line ({ url, duration }) or null. */
  clip(l) {
    let c = this._clips.get(l);
    if (c === undefined) {
      const e = voiceClip(this.voices, this.data, l);
      c = e ? { url: Data.base + VOICE_DIR + e.file, duration: e.duration } : null;
      this._clips.set(l, c);
    }
    return c;
  }

  play(id) {
    const ls = this.lines(id);
    if (!ls.length) { console.warn('no dialogue', id); return; }
    this.queue.push(...ls);
    if (this.voice) for (const l of ls) { const c = this.clip(l); if (c) this.game.audio?.loadClip?.(c.url); }
  }

  say(speaker, text, duration) { this.queue.push({ speaker, text, duration }); }

  skip() { this.t = 999; this._stopVoice(); }

  /** Game paused / resumed: the clip stops and restarts where it was (subtitles are frozen meanwhile). */
  pause() {
    this._clip?.stop(0.05);
    this._clip = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.pause();
  }
  resume() {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.resume();
    if (this.current && this._holding < 0 && this.voice) this._startClip(this.current, this.t);
  }

  update(dt) {
    if (this.current) {
      if (this._holding >= 0) {
        this._holding += dt;
        const c = this.clip(this.current);
        if (!this.game.audio?.clipReady?.(c.url) && this._holding < CLIP_WAIT) return;
        this._show(this.current);
        return;
      }
      this.t += dt;
      if (this.t < this._dur(this.current)) return;
      this.current = null;
      this._clip = null;
    }
    const l = this.queue.shift();
    if (!l) return;
    this.current = l;
    this.t = 0;
    const c = this.voice && this.game.audio?.running ? this.clip(l) : null;
    if (c && !this.game.audio.clipReady(c.url)) { this._holding = 0; this.game.audio.loadClip(c.url); return; }
    this._show(l);
  }

  _show(l) {
    this._holding = -1;
    this.t = 0;
    const sp = this._speaker(l);
    const dur = this._dur(l);
    this.game.hud?.subtitle(sp.name ?? l.speaker, l.text, dur * 1000);
    if (sp.radio !== false) this.game.audio?.play('radio_beep', { volume: 0.35 });
    if (!this.voice) return;
    if (this.clip(l)) this._startClip(l, 0);
    else this._speak(l, sp);
  }

  /** Start (or resume at time t of the line) its recorded clip. */
  _startClip(l, t) {
    const c = this.clip(l), audio = this.game.audio;
    if (!c || !audio?.playClip) return;
    const radio = this._speaker(l).radio !== false;
    const delay = radio ? RADIO_DELAY : 0;
    if (t >= delay + c.duration) return;
    this._clip?.stop(0.05);
    this._clip = audio.playClip(c.url, { radio, delay: Math.max(0, delay - t), offset: Math.max(0, t - delay), volume: 1 });
  }

  _stopVoice() {
    this._clip?.stop(0.08);
    this._clip = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  /** Fallback: browser speech synthesis (lines without a recorded clip). */
  _speak(l, sp) {
    if (typeof speechSynthesis === 'undefined' || !this._voices.length) return;
    try {
      const u = new SpeechSynthesisUtterance(l.text.replace(/<[^>]+>/g, ''));
      u.lang = 'fr-FR';
      const vs = this._voices;
      u.voice = vs[(sp.voiceIndex ?? 0) % vs.length];
      u.pitch = sp.pitch ?? 1;
      u.rate = sp.rate ?? 1.05;
      u.volume = this.game.settings?.voiceVolume ?? 0.8;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* no speech */ }
  }
}
