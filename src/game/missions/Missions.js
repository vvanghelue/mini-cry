// Scripted missions on top of the open world (public/data/game/missions.json, edited in the
// editor's Missions panel). See docs/MISSIONS.md for the full format.
//
// A mission = ordered objectives; each objective completes on a typed condition (goto, kill,
// pickup, interact, liberate, survive, escort, collect, destroy, wait, condition) and can run
// action lists (onStart / onComplete). Global triggers react to events (enterZone, kill,
// pickup, interact, alarm, liberate, missionComplete...) with optional conditions.
import * as THREE from 'three';

export const OBJECTIVE_TYPES = ['goto', 'kill', 'pickup', 'interact', 'liberate', 'survive', 'escort', 'collect', 'destroy', 'wait', 'condition'];
export const ACTIONS = [
  'dialogue', 'say', 'banner', 'hint', 'startMission', 'completeMission', 'failMission', 'completeObjective', 'setVar', 'incVar',
  'spawn', 'activateGroup', 'alertGroup', 'removeGroup', 'enable', 'disable', 'giveWeapon', 'giveItem', 'heal', 'teleport',
  'setTime', 'setDayLength', 'playSound', 'cinematic', 'explode', 'wait', 'checkpoint', 'follow', 'stopFollow', 'music', 'endGame', 'setMarker',
];

export class Missions {
  constructor(game, data) {
    this.game = game;
    this.data = data;
    this.defs = new Map((data.missions ?? []).map((m) => [m.id, m]));
    this.state = {}; // missionId -> { status: 'active'|'done'|'failed', obj: index, t, counters }
    this.vars = { ...(data.variables ?? {}) };
    this.firedTriggers = new Set();
    this.queue = []; // running action sequences { actions, i, waitT }
    this.events = [];
    this.focus = null; // the mission shown on the HUD
    this.extraMarkers = new Map();
  }

  // --- persistence -------------------------------------------------------------------------
  serialize() {
    return { state: structuredClone(this.state), vars: { ...this.vars }, fired: [...this.firedTriggers], focus: this.focus };
  }
  restore(s) {
    this.state = s.state ?? {};
    this.vars = { ...this.vars, ...(s.vars ?? {}) };
    this.firedTriggers = new Set(s.fired ?? []);
    this.focus = s.focus ?? null;
    this._refreshHud();
  }

  begin() {
    if (this.data.start && !this.state[this.data.start]) this.start(this.data.start);
    this._refreshHud();
  }

  // --- missions ------------------------------------------------------------------------------
  start(id) {
    const m = this.defs.get(id);
    if (!m || this.state[id]?.status === 'active' || this.state[id]?.status === 'done') return;
    this.state[id] = { status: 'active', obj: 0, t: 0, c: {} };
    if (m.type !== 'side' || !this.focus) this.focus = id;
    this.game.hud?.showBanner(m.title, m.type === 'side' ? 'Side mission' : 'New mission', 4000);
    this.game.audio?.play('objective_new', { volume: 0.6 });
    this.run(m.onStart);
    this._startObjective(m, this.state[id]);
    this.emit('missionStart', { mission: id });
    this._refreshHud();
  }

  _startObjective(m, st) {
    const o = m.objectives?.[st.obj];
    if (!o) return;
    st.t = 0;
    st.c = {};
    if (o.type === 'collect') st.c.start = this.game.collected?.[o.item] ?? 0;
    this.run(o.onStart);
    if (o.text && !o.hidden && st.obj > 0) this.game.hud?.notify(`Objective: ${o.text}`);
    this._refreshHud();
  }

  completeObjective(mid, oid) {
    const m = this.defs.get(mid), st = this.state[mid];
    if (!m || st?.status !== 'active') return;
    const o = m.objectives[st.obj];
    if (oid && o?.id !== oid) return;
    this.run(o?.onComplete);
    if (o && !o.hidden) { this.game.audio?.play('objective_complete', { volume: 0.6 }); this.game.hud?.notify(`✔ ${o.text}`); }
    this.emit('objectiveComplete', { mission: mid, objective: o?.id });
    st.obj++;
    if (st.obj >= (m.objectives?.length ?? 0)) this.complete(mid);
    else this._startObjective(m, st);
  }

  complete(id) {
    const m = this.defs.get(id), st = this.state[id];
    if (!m || !st || st.status !== 'active') return;
    st.status = 'done';
    this.game.hud?.showBanner('Mission complete', m.title, 4500);
    this.game.audio?.play('mission_complete', { volume: 0.8 });
    if (this.focus === id) this.focus = Object.keys(this.state).find((k) => this.state[k].status === 'active') ?? null;
    this.run(m.onComplete);
    this.emit('missionComplete', { mission: id });
    if (m.checkpoint !== false) this.game.saveCheckpoint?.();
    this._refreshHud();
  }

  fail(id, reason) {
    const m = this.defs.get(id), st = this.state[id];
    if (!m || st?.status !== 'active') return;
    this.game.hud?.showBanner('Mission failed', reason ?? '', 4500, 'fail');
    this.run(m.onFail);
    // restart the mission from the last checkpoint
    setTimeout(() => this.game.loadCheckpoint?.(), 3500);
  }

  // --- events ------------------------------------------------------------------------------
  emit(type, detail = {}) { this.events.push({ type, ...detail }); }

  _matchEvent(when, ev) {
    if (!when) return false;
    if (when.event && when.event !== ev.type) return false;
    if (when.enterZone) return ev.type === 'enterZone' && ev.zone === when.enterZone;
    if (when.leaveZone) return ev.type === 'leaveZone' && ev.zone === when.leaveZone;
    for (const k of ['actor', 'group', 'entity', 'item', 'outpost', 'mission', 'objective', 'zone']) if (when[k] !== undefined && when[k] !== ev[k]) return false;
    return !!when.event;
  }

  // --- conditions ----------------------------------------------------------------------------
  check(c) {
    if (!c) return true;
    const g = this.game;
    if (Array.isArray(c)) return c.every((x) => this.check(x));
    if (c.all) return c.all.every((x) => this.check(x));
    if (c.any) return c.any.some((x) => this.check(x));
    if (c.not) return !this.check(c.not);
    if (c.var !== undefined) {
      const v = this.vars[c.var];
      if (c.eq !== undefined) return v === c.eq;
      if (c.gt !== undefined) return v > c.gt;
      if (c.lt !== undefined) return v < c.lt;
      if (c.gte !== undefined) return v >= c.gte;
      return !!v;
    }
    if (c.missionDone) return this.state[c.missionDone]?.status === 'done';
    if (c.missionActive) return this.state[c.missionActive]?.status === 'active';
    if (c.objectiveActive) { const { mission, id } = c.objectiveActive, st = this.state[mission]; return st?.status === 'active' && this.defs.get(mission)?.objectives?.[st.obj]?.id === id; }
    if (c.actorDead) { const a = g.actors.get(c.actorDead); return !a || !a.alive; }
    if (c.actorAlive) { const a = g.actors.get(c.actorAlive); return !!a?.alive; }
    if (c.groupDead) return g.actors.aliveInGroup(c.groupDead).length === 0 && g.actors.byGroup(c.groupDead).length > 0;
    if (c.hasItem) return !!g.inventory?.has(c.hasItem);
    if (c.hasWeapon) return g.weapons.owned.has(c.hasWeapon);
    if (c.liberated) return !!g.liberated?.has(c.liberated);
    if (c.inZone) return g.zoneContains(c.inZone, g.player.pos);
    if (c.timeBetween) { const h = g.engine.lighting.timeOfDay; const [a, b] = c.timeBetween; return a <= b ? h >= a && h <= b : h >= a || h <= b; }
    if (c.destroyed) return !!g.destroyed?.has(c.destroyed);
    if (c.interacted) return !!g.interacted?.has(c.interacted);
    if (c.collected) return (g.collected?.[c.collected.item] ?? 0) >= c.collected.count;
    return true;
  }

  // --- actions -------------------------------------------------------------------------------
  run(actions, ctx = {}) {
    if (!actions?.length) return;
    this.queue.push({ actions, i: 0, waitT: 0, ctx });
  }

  _exec(a, seq) {
    const g = this.game;
    const pos = (ref) => g.resolvePos(ref);
    switch (a.do) {
      case 'dialogue': g.dialogue?.play(a.id); if (a.wait) seq.waitT = g.dialogue?.duration(a.id) ?? 0; break;
      case 'say': g.dialogue?.say(a.speaker, a.text, a.duration); break;
      case 'banner': g.hud?.showBanner(a.title ?? '', a.subtitle ?? '', (a.duration ?? 4) * 1000); break;
      case 'hint': g.hud?.notify(a.text, (a.duration ?? 5) * 1000); break;
      case 'startMission': this.start(a.id); break;
      case 'completeMission': this.complete(a.id ?? this.focus); break;
      case 'failMission': this.fail(a.id ?? this.focus, a.reason); break;
      case 'completeObjective': this.completeObjective(a.mission ?? this.focus, a.id); break;
      case 'setVar': this.vars[a.name] = a.value; break;
      case 'incVar': this.vars[a.name] = (this.vars[a.name] ?? 0) + (a.by ?? 1); break;
      case 'spawn': g.spawnGroup?.(a); break;
      case 'activateGroup': g.activateGroup?.(a.group); break;
      case 'alertGroup': for (const x of g.actors.aliveInGroup(a.group)) { x.ai.lastKnown.copy(g.player.pos); x.ai.lastSeenT = g.time; x.ai.awareness = 1; x.ai.enterCombat(true); } break;
      case 'removeGroup': for (const x of g.actors.byGroup(a.group)) g.actors.remove(x); break;
      case 'enable': g.setEntityEnabled?.(a.entity, true); break;
      case 'disable': g.setEntityEnabled?.(a.entity, false); break;
      case 'giveWeapon': g.weapons.give(a.weapon, { ammo: a.ammo ?? {} }); break;
      case 'giveItem': g.giveItem?.(a.item, a.count ?? 1); break;
      case 'heal': g.player.heal(a.amount ?? 100); break;
      case 'teleport': { const p = pos(a.to); if (p) g.player.teleport(p, a.yaw); break; }
      case 'setTime': g.engine.lighting.setTimeOfDay(a.hour); break;
      case 'setDayLength': g.engine.lighting.env.dayLengthMinutes = a.minutes; break;
      case 'playSound': g.audio?.play(a.sound, { position: a.at ? pos(a.at) : undefined, volume: a.volume ?? 1 }); break;
      case 'cinematic': g.cinematic?.(a); seq.waitT = a.duration ?? 4; break;
      case 'explode': { const p = pos(a.at); if (p) g.weapons.explode(new THREE.Vector3(...p), a.radius ?? 6, a.damage ?? 150, 'script'); break; }
      case 'wait': seq.waitT = a.seconds ?? 1; break;
      case 'checkpoint': g.saveCheckpoint?.(); break;
      case 'follow': { const x = g.actors.get(a.actor); if (x) { x.ai.setState('follow'); } break; }
      case 'stopFollow': { const x = g.actors.get(a.actor); if (x) { x.ai.home.copy(x.pos); x.ai.setState('idle'); } break; }
      case 'music': g.musicOverride = a.intensity; break;
      case 'setMarker': if (a.id) { if (a.at) this.extraMarkers.set(a.id, { id: a.id, at: a.at }); else this.extraMarkers.delete(a.id); } break;
      case 'endGame': g.endGame?.(a); break;
      default: console.warn('unknown action', a.do);
    }
  }

  // --- per frame -----------------------------------------------------------------------------
  update(dt) {
    const g = this.game;
    // action sequences
    for (let k = this.queue.length - 1; k >= 0; k--) {
      const seq = this.queue[k];
      if (seq.waitT > 0) { seq.waitT -= dt; continue; }
      while (seq.i < seq.actions.length && seq.waitT <= 0) {
        const a = seq.actions[seq.i++];
        if (a.if && !this.check(a.if)) continue;
        try { this._exec(a, seq); } catch (e) { console.error('mission action failed', a, e); }
      }
      if (seq.i >= seq.actions.length && seq.waitT <= 0) this.queue.splice(k, 1);
    }
    // objectives
    for (const [id, st] of Object.entries(this.state)) {
      if (st.status !== 'active') continue;
      const m = this.defs.get(id);
      if (!m) continue;
      st.t += dt;
      for (const f of m.failIf ?? []) if (this.check(f)) { st.status = 'failing'; this.fail(id, f.reason ?? 'Objective compromised'); }
      const o = m.objectives?.[st.obj];
      if (o && this._objectiveDone(o, st, dt)) this.completeObjective(id, o.id);
    }
    // triggers
    const evs = this.events;
    this.events = [];
    for (const t of this.data.triggers ?? []) {
      if (t.once !== false && this.firedTriggers.has(t.id)) continue;
      let fire = false;
      if (t.when?.always) fire = true;
      else for (const ev of evs) if (this._matchEvent(t.when, ev)) { fire = true; break; }
      if (fire && this.check(t.if)) {
        this.firedTriggers.add(t.id);
        this.run(t.do);
      }
    }
    // objective events consumed by objectives this frame
    this._frameEvents = evs;
    void g;
  }

  _objectiveDone(o, st, dt) {
    const g = this.game, p = g.player;
    const evs = this._frameEvents ?? [];
    switch (o.type) {
      case 'goto': {
        const t = g.resolvePos(o.target);
        return !!t && Math.hypot(t[0] - p.pos.x, t[2] - p.pos.z) < (o.radius ?? 6) && Math.abs(t[1] - p.pos.y) < Math.max(6, o.radius ?? 6);
      }
      case 'kill': {
        if (o.group) { const all = g.actors.byGroup(o.group); return all.length > 0 && all.every((a) => !a.alive); }
        if (o.actor) { const a = g.actors.get(o.actor); return !!a && !a.alive; }
        return false;
      }
      case 'pickup': return evs.some((e) => e.type === 'pickup' && (e.entity === o.target || e.item === o.item)) || (!!o.target && !!g.pickedUp?.has(o.target));
      case 'interact': {
        if (evs.some((e) => e.type === 'interact' && e.entity === o.target)) return true;
        // one-shot interactables used before the objective started still count (NPCs can be talked to again)
        return g.world.entities.get(o.target)?.type !== 'npc' && !!g.interacted?.has(o.target);
      }
      case 'destroy': return evs.some((e) => e.type === 'destroyed' && e.entity === o.target) || !!g.destroyed?.has(o.target);
      case 'liberate': return !!g.liberated?.has(o.target);
      case 'survive': st.c.t = (st.c.t ?? 0) + dt; return st.c.t >= (o.seconds ?? 60);
      case 'wait': st.c.t = (st.c.t ?? 0) + dt; return st.c.t >= (o.seconds ?? 2);
      case 'collect': return (g.collected?.[o.item] ?? 0) - (o.absolute ? 0 : st.c.start ?? 0) >= (o.count ?? 1);
      case 'escort': {
        const a = g.actors.get(o.actor), t = g.resolvePos(o.target);
        return !!a && a.alive && !!t && Math.hypot(t[0] - a.pos.x, t[2] - a.pos.z) < (o.radius ?? 6);
      }
      case 'condition': return this.check(o.condition);
      default: return false;
    }
  }

  /** Current objective text of the focused mission (HUD). */
  _refreshHud() {
    const g = this.game;
    const id = this.focus;
    const m = id && this.defs.get(id), st = id && this.state[id];
    if (!m || st?.status !== 'active') { g.hud?.setObjective('', ''); return; }
    const o = m.objectives?.[st.obj];
    let text = o?.hidden ? '' : o?.text ?? '';
    if (o?.type === 'collect') text += ` (${Math.max(0, (g.collected?.[o.item] ?? 0) - (o.absolute ? 0 : st.c.start ?? 0))}/${o.count})`;
    g.hud?.setObjective(m.title, text);
  }

  /** World positions to show on the compass / minimap / map: [{ id, x, y, z }] */
  markers() {
    if (this._markersFrame === this.game.frame) return this._markers;
    this._markersFrame = this.game.frame;
    const out = [];
    const g = this.game;
    for (const [id, st] of Object.entries(this.state)) {
      if (st.status !== 'active') continue;
      if (id !== this.focus && this.defs.get(id)?.type !== 'side') continue;
      const o = this.defs.get(id)?.objectives?.[st.obj];
      if (!o || o.hidden || o.noMarker) continue;
      let ref = o.marker ?? o.target;
      if (o.type === 'kill' && o.group && !o.marker) {
        const alive = g.actors.aliveInGroup(o.group);
        if (alive.length && alive.length <= 3) for (const a of alive) out.push({ id: id + a.id, x: a.pos.x, y: a.pos.y + 2, z: a.pos.z });
        continue;
      }
      if (o.type === 'escort') ref = o.target;
      const p = ref ? g.resolvePos(ref) : null;
      if (p) out.push({ id: id + o.id, x: p[0], y: p[1], z: p[2] });
    }
    for (const m of this.extraMarkers.values()) { const p = g.resolvePos(m.at); if (p) out.push({ id: m.id, x: p[0], y: p[1], z: p[2] }); }
    this._markers = out;
    if (this.game.frame % 15 === 0) this._refreshHud();
    return out;
  }
}
