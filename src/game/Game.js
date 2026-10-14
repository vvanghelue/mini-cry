// The game: wires the engine world to the player, weapons, actors / AI, missions, HUD, audio
// and menus, and owns the open-world rules (pickups, outposts & alarms, liberation, fast travel,
// binoculars tagging, checkpoints).
import * as THREE from 'three';
import { Data } from '../engine/core/Data.js';
import { loadViewModels } from './player/ViewModels.js';
import { VOICE_MANIFEST } from './missions/voice.js';
import { CharacterLibrary, nextCharacterFrame } from '../engine/anim/Characters.js';
import { Player } from './player/Player.js';
import { Weapons } from './player/Weapons.js';
import { Effects } from './fx/Effects.js';
import { Birds } from './fx/Birds.js';
import { ActorManager } from './actors/Actors.js';
import { AIDirector } from './actors/AI.js';
import { HUD } from './ui/HUD.js';
import { TouchControls } from './ui/TouchControls.js';
import { Menus } from './ui/Menus.js';
import { Missions } from './missions/Missions.js';
import { Dialogue } from './missions/Dialogue.js';
import { Vehicles } from './vehicles/Vehicles.js';
import './entities/index.js';

const SAVE_KEY = 'minicry.save.v1';
const SETTINGS_KEY = 'minicry.settings.v1';

export const DIFFICULTY = {
  // maxShooters: enemies allowed to aim at the player at once (the others fire wide, AI.js takeShotToken)
  facile: { damageTaken: 0.6, aiAccuracy: 0.7, aiDamage: 0.7, detection: 0.7, vision: 0.85, maxShooters: 2 },
  normal: { damageTaken: 1, aiAccuracy: 1, aiDamage: 1, detection: 1, vision: 1, maxShooters: 3 },
  difficile: { damageTaken: 1.4, aiAccuracy: 1.25, aiDamage: 1.3, detection: 1.3, vision: 1.15, maxShooters: 5 },
};

export async function startGame(app, params) {
  const game = new Game(app, params);
  await game.init();
  app.game = game;
  return game;
}

export class Game {
  constructor(app, params) {
    this.app = app;
    this.params = params;
    this.engine = app.engine;
    this.world = app.world;
    this.input = app.input;
    this.world.game = this;
    this.time = 0;
    this.frame = 0;
    this.stats = { shots: 0, hits: 0, kills: 0, headshots: 0, takedowns: 0, deaths: 0, playTime: 0 };
    this.collected = {};
    this.liberated = new Set();
    this.destroyed = new Set();
    this.interacted = new Set();
    this.pickedUp = new Set();
    this.inventory = new Set();
    this.reinforcements = new Map(); // group -> pending count
    this.zonesInside = new Set();
    this.settings = { quality: this.engine.quality, sensitivity: 1, volume: 0.8, music: 0.5, voices: true, voiceVolume: 1, difficulty: 'normal', fov: 72, invertY: false, ao: true, flare: true, antialias: 'auto', fpsLimit: app.debugMode ? 60 : 0, ...(app.debugMode ? {} : loadJSON(SETTINGS_KEY)) };
    // frame rate cap (debug panel, 0 = auto: one frame per display refresh; 60 in debug mode); ?fps=N overrides it
    const fps = params.get('fps');
    this.engine.maxFps = fps !== null ? Number(fps) || 0 : this.settings.fpsLimit;
    this.engine.lighting.ao.setEnabled(this.settings.ao !== false);
    if (this.settings.flare === false) this.engine.lighting.flare.setEnabled(false);
    this.difficulty = DIFFICULTY[this.settings.difficulty] ?? DIFFICULTY.normal;
    this.paused = true;
    this.started = false;
    // debug panel (F2) toggles; timeScale is the game speed restored by resume()
    this.cheats = { infiniteAmmo: false, oneShot: false, freezeAI: false, timeScale: 1 };
    this.keepRunningOnUnlock = false; // set by the debug panel (F2) to free the mouse without pausing
  }

  async init() {
    const t0 = performance.now();
    const [player, weapons, archetypes, items, missions, dialogue, sounds, voices, birds, viewModels] = await Promise.all([
      Data.json('game/player.json'), Data.json('game/weapons.json'), Data.json('game/archetypes.json'), Data.json('game/items.json'),
      Data.jsonOr('game/missions.json', { missions: [] }), Data.jsonOr('game/dialogue.json', { speakers: {}, dialogues: {} }), Data.jsonOr('sounds.json', { sounds: {} }),
      Data.jsonOr(VOICE_MANIFEST, { lines: {} }), Data.jsonOr('game/birds.json', { species: {} }), Data.jsonOr('viewmodels.json', {}),
    ]);
    this.data = { player, weapons, archetypes, items, missions, dialogue, sounds, birds };
    // characters (all archetype models)
    const models = [...new Set(Object.values(archetypes.archetypes).map((a) => a.model))];
    this.app.onLoadProgress?.(0.85, 'Characters and animations');
    // + the first-person arms and weapons (public/models/fp)
    [this.characters, this.viewModels] = await Promise.all([
      new CharacterLibrary(this.engine.lighting).load(models),
      loadViewModels(viewModels, player.arms?.model, this.engine.renderer),
    ]);
    this.app.onLoadProgress?.(0.95, 'Audio');
    // audio (optional module)
    try {
      const { AudioSystem } = await import('../engine/audio/Audio.js');
      this.audio = new AudioSystem({ sounds });
      this.audio.setVolume?.('master', this.settings.volume);
      this.audio.setVolume?.('music', this.settings.music);
      this.audio.setVolume?.('voice', this.settings.voiceVolume);
    } catch (e) { console.warn('audio unavailable', e); this.audio = null; }

    this.effects = new Effects(this);
    this.birds = new Birds(this, birds);
    this.player = new Player(this, { ...player, mouseSensitivity: player.mouseSensitivity * this.settings.sensitivity, fov: this.settings.fov });
    this.input.invertY = !!this.settings.invertY;
    this.hud = new HUD(this);
    this.hud.buildMapImage();
    this.weapons = new Weapons(this, weapons);
    this.actors = new ActorManager(this);
    this.ai = new AIDirector(this);
    this.missions = new Missions(this, missions);
    this.dialogue = new Dialogue(this, dialogue, voices);
    this.vehicles = new Vehicles(this);
    this.menus = new Menus(this);
    if (this.app.mobile) this.touch = new TouchControls(this); // phones / tablets
    // game entity types can be created now
    this.world.entities.mode = 'game';
    this.world.entities.createPending();

    // spawn
    const w = this.world.data.player ?? {};
    this.player.teleport(w.pos ?? [0, 20, 0], w.yaw ?? 0);
    for (const id of player.startWeapons ?? []) this.weapons.give(id, { select: true });
    for (const [t, n] of Object.entries(player.startAmmo ?? {})) this.weapons.addAmmo(t, n);
    this.weapons.grenades = player.startGrenades ?? 0;

    this.engine.addSystem(this);
    this._registerLive();
    this.loadMs = performance.now() - t0;
    this.hud.setVisible(false);
    this.engine.canvas.addEventListener('click', () => { if (this.started && !this.paused) this.input.lock(); });
    document.addEventListener('pointerlockchange', () => {
      if (this.input.locked) return;
      if (this.keepRunningOnUnlock) { this.keepRunningOnUnlock = false; return; }
      if (this.started && !this.paused && this.player.alive && !this.menus.mapOpen) this.pause();
    });
    // direct start (tools, editor "play here")
    if (this.params.has('autostart') || this.params.has('at') || this.params.has('spawn')) {
      const sp = this.params.get('spawn');
      if (sp) { const [x, y, z, yaw] = sp.split(',').map(Number); this.player.teleport([x, y, z], yaw ?? 0); }
      this.newGame({ skipIntro: this.params.has('nointro'), fromCheckpoint: false, keepPosition: !!sp });
      const mid = this.params.get('mission'); // editor mission test button: start this mission and focus it
      if (mid) { this.missions.start(mid); if (this.missions.state[mid]) this.missions.focus = mid; }
    } else this.menus.showMain();
  }

  // --- flow ----------------------------------------------------------------------------------
  /** Objects for the loading-time shader warm-up: a skinned character, every weapon's view model. */
  warmUpExtras() {
    const out = [];
    try {
      const name = Object.keys(this.characters?.templates ?? {})[0];
      if (name) out.push(this.characters.create(name).root);
      for (const id of Object.keys(this.weapons?.defs ?? {})) this.weapons._vmFor(id);
    } catch (e) { console.warn('warm-up extras', e); }
    return out;
  }

  newGame({ fromCheckpoint = false, keepPosition = false, skipIntro = false } = {}) {
    this.started = true;
    this.hud.setVisible(true);
    this.menus.hideAll();
    if (fromCheckpoint && this.restore(loadJSON(SAVE_KEY))) {
      this.hud.notify('Game loaded');
    } else {
      if (!keepPosition) { const w = this.world.data.player ?? {}; this.player.teleport(w.pos ?? [0, 20, 0], w.yaw ?? 0); }
      // nointro (tools, editor "play here"): free roam, no story start (a ?mission= can still start one)
      if (!skipIntro) this.missions.begin();
    }
    this.resume();
  }

  pause() {
    if (!this.started) return;
    this.paused = true;
    this.engine.timeScale = 0;
    this.input.unlock();
    this.menus.showPause();
    this.audio?.setVolume?.('sfx', 0.3);
    this.dialogue?.pause();
  }

  resume() {
    this.paused = false;
    this.engine.timeScale = this.cheats.timeScale;
    this.menus.hideAll();
    this.input.clear();
    this.input.lock();
    this.audio?.resume?.();
    this.audio?.setVolume?.('sfx', 1);
    this.dialogue?.resume();
  }

  onPlayerDeath() {
    this.stats.deaths++;
    this.hud.showBanner('You died', '', 3000, 'fail');
    setTimeout(() => { this.input.unlock(); this.menus.showDeath(); }, 2200);
  }

  // --- per frame -----------------------------------------------------------------------------
  update(dt) {
    this.frame++;
    nextCharacterFrame();
    const inp = this.input;
    if (inp.hit('map') && this.started && this.player.alive) this.menus.toggleMap();
    if (this.paused || !this.started) { inp.endFrame(); this.audio?.update?.(0, this.engine.camera, this._ambientState()); return; }
    this.time += dt;
    this.stats.playTime += dt;
    const p = this.player;
    // vehicles take the input when driven
    if (p.inVehicle) this.vehicles.updateDriving(dt, inp);
    else p.update(dt, inp);
    this._binoculars(dt);
    this.weapons.update(dt, inp);
    this._interact(inp);
    if (!this.cheats.freezeAI) {
      this.engine.perf.mark('actors', () => this.actors.update(dt));
      this.engine.perf.mark('ai', () => this.ai.update(dt));
    }
    this.vehicles.update(dt);
    this._zones();
    this.missions.update(dt);
    this.dialogue.update(dt);
    this.effects.update(dt);
    this._reinforcementWaves(dt);
    // camera
    if (this._cine) this._updateCinematic(dt);
    else if (p.inVehicle) this.vehicles.applyCamera(this.engine.camera, dt);
    else p.applyCamera(this.engine.camera, dt);
    if (this.effects.shake > 0) {
      const s = this.effects.shake * 0.08;
      this.engine.camera.rotation.x += (Math.random() - 0.5) * s;
      this.engine.camera.rotation.y += (Math.random() - 0.5) * s;
    }
    this.engine.perf.mark('birds', () => this.birds.update(dt)); // after the camera: spawns / startles around where it is now
    this.hud.update(dt);
    this.audio?.setMusicIntensity?.(this.musicOverride ?? this.ai.combatLevel);
    this.audio?.update?.(dt, this.engine.camera, this._ambientState());
    if (inp.hit('flashlight')) this.toggleFlashlight();
    inp.endFrame();
  }

  _ambientState() {
    const p = this.player, T = this.world.terrain;
    if (!p) return {};
    this._coastT = (this._coastT ?? 0) - 1;
    if (this._coastT <= 0) {
      this._coastT = 30;
      // cheap coast distance: probe 8 directions
      let best = 300;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        for (let d = 10; d < best; d += 20) if (T.heightAt(p.pos.x + Math.cos(a) * d, p.pos.z + Math.sin(a) * d) < 0) { best = d; break; }
      }
      this._coast = best;
      this._jungle = Math.min(1, this.ai.foliageAt(p.pos.x, p.pos.z) / 3 + (T.materialAtWorld(p.pos.x, p.pos.z) === 4 ? 0.6 : 0));
    }
    return { coastDistance: this._coast, underwater: p.underwater, night: this.engine.lighting.night, inJungle: this._jungle, height: p.pos.y, indoor: false, combat: this.ai.combatLevel };
  }

  // --- interaction ---------------------------------------------------------------------------
  _interact(inp) {
    const p = this.player;
    if (!p.alive) { this.hud.setPrompt(null); return; }
    let best = null, bd = Infinity;
    const fwd = p.forward();
    const eye = p.eye;
    for (const h of p.inVehicle ? [] : this.world.entities.handles.values()) {
      if (!h.interact || h.active === false || !h.object?.visible) continue;
      const o = h.object.position;
      const dx = o.x - eye.x, dz = o.z - eye.z, dy = o.y + 0.5 - eye.y;
      const d = Math.hypot(dx, dz);
      if (d > (h.interact.range ?? 2) || Math.abs(dy) > 2) continue;
      const facing = d < 0.8 ? 1 : (dx * fwd.x + dz * fwd.z) / d;
      if (facing < 0.5) continue;
      const score = d - facing;
      if (score < bd) { bd = score; best = h; }
    }
    const vehicle = !best && !p.inVehicle ? this.vehicles.nearby(p) : null;
    const canExit = p.inVehicle && this.vehicles.canExit();
    const text = best ? best.interact.prompt?.() : vehicle ? `${vehicle.spec.verb ?? 'Drive'} (${vehicle.label})` : canExit ? 'Exit vehicle' : null;
    this.hud.setPrompt(text ? `<kbd>E</kbd>${text}` : null);
    if (inp.hit('use')) {
      if (p.inVehicle) { if (canExit) this.vehicles.exit(); }
      else if (best && text) best.use?.();
      else if (vehicle) this.vehicles.enter(vehicle);
    }
  }

  // --- items -------------------------------------------------------------------------------
  /** Apply an item. auto: only take it if useful (ammo when not full...). Returns true if consumed. */
  pickupItem(itemId, entityId, auto = false) {
    const it = this.data.items.items[itemId];
    if (!it) return false;
    const p = this.player, w = this.weapons;
    if (auto) {
      if (it.heal && p.health >= p.maxHealth) return false;
      if (it.armor && p.armor >= p.cfg.maxArmor) return false;
      if (it.ammo && Object.entries(it.ammo).every(([t]) => (w.ammo[t] ?? 0) >= (this.data.weapons.ammoTypes[t]?.max ?? 999))) return false;
      if (it.grenades && w.grenades >= p.cfg.maxGrenades) return false;
    }
    if (it.heal) p.heal(it.heal);
    if (it.armor) p.addArmor(it.armor);
    const ent = entityId ? this.world.entities.get(entityId) : null;
    if (it.weapon) w.give(it.weapon, ent?.rounds > 0 ? { rounds: ent.rounds } : { ammo: it.ammo ?? {} }); // rounds: what a dropped weapon still holds
    else if (it.ammo) for (const [t, n] of Object.entries(it.ammo)) w.addAmmo(t, n);
    if (it.grenades) w.grenades = Math.min(p.cfg.maxGrenades, w.grenades + it.grenades);
    if (it.collectible) { this.collected[it.collectible] = (this.collected[it.collectible] ?? 0) + 1; this.hud.notify(`${it.label} (${this.collected[it.collectible]})`); }
    if (it.key || it.tool) this.inventory.add(itemId);
    if (it.tool === 'binoculars') this.hud.notify('Binoculars: press B to scout and tag enemies', 6000);
    this.hud.notify(`+ ${it.label}`, 2000);
    this.audio?.play(it.sound ?? 'pickup_item', { volume: 0.6 });
    this.hud.refreshWeapon();
    if (entityId && !ent?.temp) this.pickedUp.add(entityId);
    this.missions.emit('pickup', { entity: entityId, item: itemId });
    return true;
  }

  giveItem(itemId, n = 1) { for (let i = 0; i < n; i++) this.pickupItem(itemId, null); }

  /** Temporary pickup in the world (enemy loot), gone after `temporary` s of game time (0 = stays). */
  spawnPickup(itemId, pos, { temporary = 0, ...fields } = {}) {
    return this.world.entities.add({ type: 'pickup', item: itemId, pos, auto: !this.data.items.items[itemId]?.weapon, temp: true, ttl: temporary, ...fields });
  }

  // --- world events ------------------------------------------------------------------------
  onActorKilled(actor, info) {
    if (info.attacker === 'player') {
      this.stats.kills++;
      if (info.part === 'head') this.stats.headshots++;
    }
    this.missions.emit('kill', { actor: actor.id, group: actor.group });
    if (actor.team === 'civilian' && info.attacker === 'player') this.hud.notify('Don\'t kill civilians!');
  }

  onShapeHit(shape, dmg, point, attacker) {
    const h = this.world.entities.handle(shape.owner);
    h?.onHit?.(dmg, 'bullet', attacker);
  }

  onExplosion(pos, radius, owner) {
    for (const h of this.world.entities.handles.values()) {
      if (!h.onExplosionNear || !h.object) continue;
      const d = h.object.position.distanceTo(pos);
      if (d < radius * 1.2) h.onExplosionNear(d, 200);
    }
    this.vehicles.onExplosion?.(pos, radius);
    void owner;
  }

  onAlert(actor) {
    // the nearest enemy of an outpost with an alarm runs the alarm (if close enough)
    if (!actor.group) return;
    const outpost = this.world.entities.byType('outpost').find((o) => o.group === actor.group);
    if (!outpost?.alarm || this.liberated.has(outpost.id)) return;
    const alarm = this.world.entities.handle(outpost.alarm);
    if (!alarm || alarm.disabled || alarm.ringing || this._alarmRunner?.alive) return;
    const runner = this.actors.aliveInGroup(actor.group).filter((a) => a.weapon).sort((a, b) => a.pos.distanceTo(alarm.object.position) - b.pos.distanceTo(alarm.object.position))[0];
    if (!runner || runner.pos.distanceTo(alarm.object.position) > 60) return;
    this._alarmRunner = runner;
    this.hud.notify('An enemy is running for the alarm!', 3500);
    const t0 = this.time;
    const tick = () => {
      if (!runner.alive || alarm.disabled || this.liberated.has(outpost.id) || this.time - t0 > 25) { this._alarmRunner = null; return; }
      const d = runner.pos.distanceTo(alarm.object.position);
      if (d < 2.4) {
        // operating the alarm takes a moment: the player can still stop him
        runner.moveTarget = null;
        runner.ai.path = null;
        runner.faceTarget = alarm.object.position.clone().setY(alarm.object.position.y + 1.4);
        runner.character.play('Interact', { once: true, fade: 0.1 });
        runner.flinchT = 1.5;
        setTimeout(() => { if (runner.alive && !alarm.disabled && !this.liberated.has(outpost.id)) alarm.trigger(); this._alarmRunner = null; }, 1500);
        return;
      }
      runner.ai.goal = { x: alarm.object.position.x, z: alarm.object.position.z };
      runner.ai.goalSpeed = runner.arch.runSpeed;
      runner.ai.path = [[alarm.object.position.x, alarm.object.position.z]];
      runner.ai.pathIdx = 0;
      runner.ai.repositionT = 3;
      setTimeout(tick, 300);
    };
    tick();
  }

  raiseAlarm(outpost) {
    this.hud.showBanner('Alarm!', 'Reinforcements incoming', 3000, 'fail');
    const n = (outpost.reinforcements ?? []).reduce((s, r) => s + (r.count ?? 1), 0);
    this.reinforcements.set(outpost.group, { outpost, left: n, t: 8 });
    this.missions.emit('alarm', { outpost: outpost.id });
  }

  pendingReinforcements(group) { return (this.reinforcements.get(group)?.left ?? 0) > 0; }

  _reinforcementWaves(dt) {
    for (const [group, r] of this.reinforcements) {
      if (r.left <= 0) continue;
      r.t -= dt;
      if (r.t > 0) continue;
      const o = r.outpost;
      const from = o.reinforceFrom ? this.resolvePos(o.reinforceFrom) : null;
      const ang = Math.random() * Math.PI * 2;
      const base = from ?? [o.pos[0] + Math.cos(ang) * (o.radius ?? 45) * 1.6, o.pos[1], o.pos[2] + Math.sin(ang) * (o.radius ?? 45) * 1.6];
      for (const rf of o.reinforcements ?? []) {
        for (let i = 0; i < (rf.count ?? 1) && r.left > 0; i++, r.left--) {
          const a = this.actors.spawn({ id: `${group}_rf_${Math.random().toString(36).slice(2, 7)}`, archetype: rf.archetype, group, pos: [base[0] + (Math.random() - 0.5) * 6, base[1], base[2] + (Math.random() - 0.5) * 6] });
          if (a) { a.ai.lastKnown.copy(this.player.pos); a.ai.lastSeenT = this.time - 3; a.ai.awareness = 1; a.ai.enterCombat(true); }
        }
      }
      r.left = 0;
    }
  }

  liberate(outpost) {
    if (this.liberated.has(outpost.id)) return;
    this.liberated.add(outpost.id);
    const alarm = outpost.alarm && this.world.entities.handle(outpost.alarm);
    alarm?.stop?.();
    this.hud.showBanner('Outpost liberated', outpost.name ?? '', 5000);
    this.audio?.play('mission_complete', { volume: 0.8 });
    for (const it of outpost.reward ?? []) this.giveItem(it);
    if (outpost.fastTravel !== false) this.hud.notify('Fast travel unlocked (map: M)', 5000);
    this.missions.emit('liberate', { outpost: outpost.id });
    this.saveCheckpoint();
  }

  markDestroyed(id) {
    this.destroyed.add(id);
    this.missions.emit('destroyed', { entity: id });
  }

  activateGroup(group) {
    for (const a of this.actors.byGroup(group)) if (a.ai.dormant) { a.ai.dormant = false; a.root.visible = true; }
  }

  setEntityEnabled(id, on) {
    const ents = this.world.entities;
    const e = ents.get(id);
    if (!e) return;
    if (on) { if (e.disabled) ents.set(id, { ...e, disabled: false }); }
    else ents.set(id, { ...e, disabled: true });
  }

  /** Mission 'spawn' action: { archetype, at, group, count, behavior: attack|idle|patrol, patrol } */
  spawnGroup(a) {
    const at = this.resolvePos(a.at) ?? [this.player.pos.x + 30, this.player.pos.y, this.player.pos.z];
    for (let i = 0; i < (a.count ?? 1); i++) {
      const act = this.actors.spawn({ id: `${a.group ?? 'spawn'}_${Math.random().toString(36).slice(2, 7)}`, archetype: a.archetype, group: a.group, patrol: a.patrol, pos: [at[0] + (Math.random() - 0.5) * 5, at[1], at[2] + (Math.random() - 0.5) * 5] });
      if (act && a.behavior === 'attack') { act.ai.lastKnown.copy(this.player.pos); act.ai.lastSeenT = this.time - 3; act.ai.awareness = 1; act.ai.enterCombat(true); }
    }
  }

  zoneContains(id, p) { return !!this.world.entities.handle(id)?.contains?.(p); }

  _zones() {
    if (this.frame % 6) return;
    const p = this.player.pos;
    for (const e of this.world.entities.byType('zone')) {
      const h = this.world.entities.handle(e.id);
      const inside = !!h?.contains?.(p);
      const was = this.zonesInside.has(e.id);
      if (inside && !was) { this.zonesInside.add(e.id); this.missions.emit('enterZone', { zone: e.id }); }
      else if (!inside && was) { this.zonesInside.delete(e.id); this.missions.emit('leaveZone', { zone: e.id }); }
    }
  }

  /** Position reference: [x,y,z] | entity id | actor id | 'player' -> [x,y,z] */
  resolvePos(ref) {
    if (!ref) return null;
    if (Array.isArray(ref)) return ref;
    if (ref === 'player') return this.player.pos.toArray();
    const a = this.actors.get(ref);
    if (a) return a.pos.toArray();
    const e = this.world.entities.get(ref);
    if (e?.pos) return e.pos;
    return null;
  }

  // --- binoculars & tagging ------------------------------------------------------------------
  _binoculars(dt) {
    const has = this.inventory.has('binoculars') || this.params.has('cheats');
    this.binoculars ??= { active: false, aimT: 0 };
    const b = this.binoculars;
    if (this.input.hit('binoculars') && has && this.player.alive && !this.player.inVehicle) {
      b.active = !b.active;
      this.audio?.play('binoculars_zoom', { volume: 0.4 });
    }
    if (!b.active) return;
    if (!this.player.alive) { b.active = false; return; }
    // tag the enemy under the crosshair after a short look
    const cam = this.engine.camera;
    const ray = new THREE.Ray(cam.getWorldPosition(new THREE.Vector3()), cam.getWorldDirection(new THREE.Vector3()));
    let target = null, best = 0.035;
    for (const a of this.actors.list) {
      if (!a.alive || a.tagged || a.team !== 'merc') continue;
      const c = a.chest(new THREE.Vector3());
      const d = c.distanceTo(ray.origin);
      if (d > 400) continue;
      const ang = Math.sqrt(ray.distanceSqToPoint(c)) / d;
      if (ang < best && this.world.physics.visible(ray.origin, c, a.id)) { best = ang; target = a; }
    }
    if (target && target === b.target) b.aimT += dt; else { b.target = target; b.aimT = 0; }
    if (target && b.aimT > 0.35) {
      target.tagged = true;
      b.aimT = 0;
      this.audio?.play('tag_enemy', { volume: 0.5 });
      this.hud.notify(`Tagged: ${target.arch.label}`, 1500);
    }
    const info = this.hud.binoEl.querySelector('.bino-info');
    const hit = this.world.physics.raycast(ray.origin, ray.direction, 1500);
    info.textContent = `${hit ? Math.round(hit.dist) + ' m' : '---'}${target ? '  ·  ' + target.arch.label : ''}`;
  }

  toggleFlashlight() {
    // a cheap "torch": brighter ambient around the player at night, visible to the AI
    this.flashlight ??= { on: false };
    this.flashlight.on = !this.flashlight.on;
    this.hud.notify(this.flashlight.on ? 'Flashlight on' : 'Flashlight off', 1200);
    const L = this.engine.lighting;
    L.env.ambient = this.flashlight.on ? (this._ambBase = L.env.ambient) * 1.8 : this._ambBase ?? L.env.ambient;
    L.setTimeOfDay(L.timeOfDay);
  }

  // --- cinematic camera ----------------------------------------------------------------------
  cinematic(a) {
    const from = this.resolvePos(a.from) ?? this.player.eye.toArray();
    const to = this.resolvePos(a.to) ?? from;
    const look = this.resolvePos(a.lookAt) ?? this.player.pos.toArray();
    this._cine = { from: new THREE.Vector3(...from), to: new THREE.Vector3(...to), look: new THREE.Vector3(...look), t: 0, dur: a.duration ?? 4 };
    if (a.text) this.hud.subtitle('', a.text, (a.duration ?? 4) * 1000);
    this.hud.root.classList.add('cine');
  }

  _updateCinematic(dt) {
    const c = this._cine;
    c.t += dt;
    const k = Math.min(1, c.t / c.dur), s = k * k * (3 - 2 * k);
    const cam = this.engine.camera;
    cam.position.lerpVectors(c.from, c.to, s);
    cam.lookAt(c.look);
    if (c.t >= c.dur || this.input.hit('use')) { this._cine = null; this.hud.root.classList.remove('cine'); }
  }

  // --- save / load ---------------------------------------------------------------------------
  snapshot() {
    const p = this.player, w = this.weapons;
    return {
      v: 1, t: Date.now(),
      player: { pos: p.pos.toArray(), yaw: p.yaw, health: p.health, armor: p.armor },
      weapons: { owned: [...w.owned], ammo: { ...w.ammo }, clip: { ...w.clip }, grenades: w.grenades, current: w.currentId },
      inventory: [...this.inventory], collected: { ...this.collected },
      liberated: [...this.liberated], destroyed: [...this.destroyed], interacted: [...this.interacted], pickedUp: [...this.pickedUp],
      dead: this.actors.list.filter((a) => !a.alive && a.data.id && this.world.entities.get(a.data.id)).map((a) => a.data.id),
      missions: this.missions.serialize(), time: this.engine.lighting.timeOfDay, stats: { ...this.stats },
    };
  }

  saveCheckpoint() {
    if (!this.player.alive) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.snapshot())); } catch { /* storage unavailable */ }
    this.hud.notify('Checkpoint', 1800);
    this.audio?.play('checkpoint', { volume: 0.4 });
  }

  hasSave() { return !!loadJSON(SAVE_KEY)?.player; }

  restore(s) {
    if (!s?.player) return false;
    const p = this.player, w = this.weapons;
    p.teleport(s.player.pos, s.player.yaw);
    p.health = Math.max(50, s.player.health);
    p.armor = s.player.armor ?? 0;
    w.owned = new Set(s.weapons.owned);
    w.ammo = s.weapons.ammo; w.clip = s.weapons.clip; w.grenades = s.weapons.grenades;
    if (s.weapons.current) { w.currentId = null; w.select(s.weapons.current); }
    this.inventory = new Set(s.inventory ?? []);
    this.collected = s.collected ?? {};
    this.liberated = new Set(s.liberated ?? []);
    this.destroyed = new Set(s.destroyed ?? []);
    this.interacted = new Set(s.interacted ?? []);
    this.pickedUp = new Set(s.pickedUp ?? []);
    for (const id of this.pickedUp) { const h = this.world.entities.handle(id); if (h) { h.active = false; h.hidden = true; if (h.object) h.object.visible = false; } }
    this.stats = { ...this.stats, ...(s.stats ?? {}) };
    for (const id of s.dead ?? []) { const a = this.actors.get(id); if (a) this.actors.remove(a); }
    // liberated outposts: their garrison is gone
    for (const o of this.world.entities.byType('outpost')) if (this.liberated.has(o.id) && o.group) for (const a of this.actors.byGroup(o.group)) this.actors.remove(a);
    for (const id of this.destroyed) { const h = this.world.entities.handle(id); if (h) h.hidden = true; if (h?.object) h.object.visible = false; this.world.physics.removeOwner(id); }
    this.engine.lighting.setTimeOfDay(s.time ?? 10);
    this.missions.restore(s.missions ?? {});
    this.hud.refreshWeapon();
    return true;
  }

  loadCheckpoint() {
    const url = new URL(location.href);
    url.searchParams.set('continue', '1');
    location.href = url.toString();
  }

  fastTravel(outpostId) {
    const o = this.world.entities.get(outpostId);
    if (!o || !this.liberated.has(outpostId)) return;
    const ang = Math.random() * Math.PI * 2;
    this.player.teleport([o.pos[0] + Math.cos(ang) * 6, o.pos[1] + 1, o.pos[2] + Math.sin(ang) * 6]);
    this.engine.lighting.setTimeOfDay(this.engine.lighting.timeOfDay + 1);
    this.hud.notify(`Fast travel: ${o.name ?? outpostId}`);
  }

  endGame(a) {
    this.started = false;
    this.input.unlock();
    this.menus.showEnd(a);
  }

  saveSettings(s) {
    Object.assign(this.settings, s);
    // debug mode: every reload starts from the defaults
    if (!this.app.debugMode) try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* */ }
    this.difficulty = DIFFICULTY[this.settings.difficulty] ?? DIFFICULTY.normal;
    this.player.cfg.mouseSensitivity = this.data.player.mouseSensitivity * this.settings.sensitivity;
    this.player.cfg.fov = this.settings.fov;
    this.input.invertY = !!this.settings.invertY;
    this.audio?.setVolume?.('master', this.settings.volume);
    this.audio?.setVolume?.('music', this.settings.music);
    this.audio?.setVolume?.('voice', this.settings.voiceVolume);
    this.dialogue.voice = this.settings.voices;
    if (this.settings.quality !== this.engine.quality) this.engine.setQuality(this.settings.quality);
    this.engine.lighting.ao.setEnabled(this.settings.ao !== false);
    this.engine.lighting.flare.setEnabled(this.settings.flare !== false);
    if ('fpsLimit' in s) this.engine.maxFps = this.settings.fpsLimit;
    if ('antialias' in s) this.hud?.notify?.('Antialiasing: applies on the next start');
  }

  // --- agent / debug commands ----------------------------------------------------------------
  _registerLive() {
    const L = this.app.live;
    const g = this;
    L.register('state', () => ({
      player: { pos: g.player.pos.toArray().map((v) => +v.toFixed(2)), yaw: +g.player.yaw.toFixed(2), health: Math.round(g.player.health), armor: Math.round(g.player.armor), weapons: [...g.weapons.owned], current: g.weapons.currentId, ammo: g.weapons.ammo, grenades: g.weapons.grenades },
      time: +g.engine.lighting.timeOfDay.toFixed(2), missions: g.missions.serialize(), liberated: [...g.liberated], collected: g.collected,
      actors: { total: g.actors.list.length, alive: g.actors.list.filter((a) => a.alive).length, combat: g.actors.list.filter((a) => a.ai?.state === 'combat').length },
      perf: g.engine.perf.snapshot(),
    }));
    L.register('teleport', ({ x, y, z, yaw, to }) => { const p = to ? g.resolvePos(to) : [x, y ?? g.world.terrain.heightAt(x, z) + 1, z]; g.player.teleport(p, yaw); return p; });
    L.register('give', ({ weapon, item, ammo }) => { if (weapon) g.weapons.give(weapon, { ammo: ammo ?? {} }); if (item) g.giveItem(item); return [...g.weapons.owned]; });
    L.register('god', ({ on = true }) => (g.player.godMode = on));
    L.register('noclip', ({ on = true }) => (g.player.noclip = on));
    L.register('setTime', ({ hour }) => g.engine.lighting.setTimeOfDay(hour));
    L.register('startMission', ({ id }) => g.missions.start(id));
    L.register('completeObjective', ({ mission }) => g.missions.completeObjective(mission ?? g.missions.focus));
    L.register('spawn', (a) => g.spawnGroup(a));
    L.register('killAll', ({ group, radius = 100 }) => { let n = 0; for (const a of g.actors.list) if (a.alive && a.team === 'merc' && (group ? a.group === group : a.pos.distanceTo(g.player.pos) < radius)) { a.die({ attacker: 'player' }); n++; } return n; });
    L.register('start', () => { if (!g.started) g.newGame({ skipIntro: true }); else g.resume(); return true; });
    L.register('look', ({ yaw, pitch }) => { if (yaw !== undefined) g.player.yaw = yaw; if (pitch !== undefined) g.player.pitch = pitch; return true; });
    L.register('birds', ({ on, startle } = {}) => { if (on !== undefined) g.birds.enabled = on; if (startle) for (const f of [...g.birds.flocks]) g.birds.startle(f, g.engine.camera.position); return g.birds.stats(); });
  }
}

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? {}; } catch { return {}; }
}
