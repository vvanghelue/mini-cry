// Debug panel (lil-gui, F2 toggles): live stats, cheats and game actions, missions, time and
// weather, graphics / world toggles. Shown by default (?debug=0 hides it; automated runs with
// ?bot / ?bench / ?nohud start without it = app.debugMode), built on first open. In debug mode
// nothing is persisted: a reload starts from the default settings (no localStorage). Opening it
// mid-game (F2) frees the mouse without pausing so values can be tweaked live (click the game to
// capture the mouse again); Esc still pauses, and the panel stays usable above the pause menu.
import { LAYERS } from '../../engine/render/layers.js';
import { GIProbeView } from '../../engine/render/GIProbeView.js';
import { FOG_STRENGTH } from '../../engine/render/Haze.js';
import { pipelineCount } from '../../engine/world/World.js';

export class DebugPanel {
  constructor(app, perfOverlay) {
    this.app = app;
    this.overlay = perfOverlay;
    this.gui = null;
    this.open = false;
    this.info = {};
    addEventListener('keydown', (e) => { if (e.code === 'F2') { e.preventDefault(); this.setOpen(!this.open); } });
    if (app.debugMode) this.setOpen(true);
    setInterval(() => this._refresh(), 250);
  }

  async setOpen(v) {
    this.open = v;
    // free the mouse so the panel can be used; the game keeps running
    if (v && document.pointerLockElement) {
      if (this.app.game) this.app.game.keepRunningOnUnlock = true;
      document.exitPointerLock();
    }
    if (v && !this.gui) await this._build();
    this.gui?.show(this.open);
  }

  async _build() {
    const { default: GUI } = await import('three/addons/libs/lil-gui.module.min.js');
    const gui = (this.gui = new GUI({ title: 'Debug (F2)', width: 310 }));
    gui.domElement.style.zIndex = 60; // above the menus and the stats overlay
    gui.domElement.style.maxHeight = '100vh';
    this._stats(gui);
    if (this.app.game) { this._game(gui); this._missions(gui); }
    if (this.app.world) { this._time(gui); this._fog(gui); }
    this._graphics(gui);
    for (const f of gui.folders) if (f !== this.statsFolder) f.close(); // compact: only the stats open
    this._refresh();
  }

  // ---- Stats (read-only, refreshed 4x per second) ----------------------------------------
  _stats(gui) {
    const f = (this.statsFolder = gui.addFolder('Stats'));
    const keys = ['fps', 'frame', 'cpu', 'gpu', 'res', 'calls', 'triangles', 'geometries', 'textures', 'programs', 'lateShaders', 'heap', 'marks'];
    if (this.app.game) keys.push('pos', 'actors', 'mission');
    if (this.app.world) keys.push('time');
    for (const k of keys) { this.info[k] = ''; f.add(this.info, k).disable(); }
  }

  _refresh() {
    if (!this.open || !this.gui) return;
    const { engine, world, game } = this.app, r = engine.renderer, s = engine.perf.snapshot(), I = this.info;
    I.fps = s.fps.toFixed(0);
    I.frame = `${s.frameMs.toFixed(2)} ms`;
    I.cpu = `${s.cpuMs.toFixed(2)} ms`;
    I.gpu = s.gpuMs === null ? 'n/a' : `${s.gpuMs.toFixed(2)} ms`;
    I.res = `${(engine.resScale * engine.maxDpr).toFixed(2)} (${engine.canvas.width}×${engine.canvas.height})`;
    I.calls = s.calls;
    I.triangles = `${(s.triangles / 1000).toFixed(1)}k`;
    I.geometries = r.info.memory.geometries;
    I.textures = r.info.memory.textures;
    I.programs = pipelineCount(r); // render pipelines (WebGPU)
    I.lateShaders = world?.warmUpStats ? I.programs - world.warmUpStats.total : '-';
    const m = performance.memory; // Chromium only
    I.heap = m ? `${(m.usedJSHeapSize / 1048576).toFixed(0)} / ${(m.totalJSHeapSize / 1048576).toFixed(0)} MB` : 'n/a';
    I.marks = Object.entries(s.marks).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · ') || '-';
    if (game) {
      const p = game.player;
      I.pos = `${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(1)}  yaw ${p.yaw.toFixed(2)}`;
      const list = game.actors.list;
      I.actors = `${list.filter((a) => a.alive).length} alive / ${list.length} · ${list.filter((a) => a.alive && a.ai?.state === 'combat').length} combat`;
      I.mission = game.missions.focus ?? '-';
    }
    if (world) {
      const h = world.lighting.timeOfDay;
      I.time = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
    }
    // reflect changes made elsewhere (live commands, keys), except the field being edited
    const focus = document.activeElement;
    for (const c of this.gui.controllersRecursive()) if (!c.domElement.contains(focus)) c.updateDisplay();
  }

  // ---- Cheats / game ---------------------------------------------------------------------
  _game(gui) {
    const g = this.app.game, p = g.player, C = g.cheats;
    const f = gui.addFolder('Game');
    p.godInvisible ??= false;
    f.add(p, 'godMode').name('god mode');
    f.add(p, 'godInvisible').name('invisible (AI)');
    f.add(p, 'noclip');
    f.add(C, 'infiniteAmmo').name('infinite ammo');
    f.add(C, 'oneShot').name('one-shot kills');
    f.add(C, 'freezeAI').name('freeze AI');
    f.add(C, 'timeScale', 0.05, 3, 0.05).name('game speed').onChange((v) => { if (!g.paused) g.engine.timeScale = v; });
    if (g.birds) f.add(g.birds, 'enabled').name('birds');

    const ammoTypes = Object.keys(g.data.weapons.ammoTypes ?? {});
    const act = {
      heal: () => { p.health = p.maxHealth; p.armor = p.cfg.maxArmor ?? p.armor; },
      refill: () => {
        for (const t of ammoTypes) g.weapons.addAmmo(t, Infinity);
        for (const id of g.weapons.owned) g.weapons.clip[id] = g.weapons.defs[id].mag ?? 0;
        g.weapons.grenades = Math.max(g.weapons.grenades, g.data.player.maxGrenades ?? 5);
        g.hud.refreshWeapon();
      },
      weapon: Object.keys(g.weapons.defs)[0],
      give: () => g.weapons.give(act.weapon, { select: true, ammo: { [g.weapons.defs[act.weapon].ammo]: 999 } }),
      flashlight: () => g.toggleFlashlight(),
      killRadius: 100,
      kill: () => { for (const a of g.actors.list) if (a.alive && a.team === 'merc' && a.pos.distanceTo(p.pos) < act.killRadius) a.die({ attacker: 'player' }); },
      archetype: 'merc_rifle',
      count: 3,
      aggressive: true,
      spawn: () => {
        const fw = p.forward(), x = p.pos.x + fw.x * 25, z = p.pos.z + fw.z * 25;
        g.spawnGroup({ archetype: act.archetype, count: act.count, group: 'debug', behavior: act.aggressive ? 'attack' : undefined, at: [x, g.world.terrain.heightAt(x, z) + 0.5, z] });
      },
      target: '',
      teleport: () => { const pos = g.resolvePos(act.target); if (pos) p.teleport([pos[0], pos[1] + 1, pos[2]]); },
    };
    f.add(act, 'heal').name('heal (health + armor)');
    f.add(act, 'refill').name('refill ammo');
    f.add(act, 'weapon', Object.keys(g.weapons.defs)).name('weapon');
    f.add(act, 'give').name('give weapon');
    f.add(act, 'flashlight').name('flashlight');

    const fe = f.addFolder('Enemies');
    fe.add(act, 'archetype', Object.keys(g.data.archetypes.archetypes)).name('archetype');
    fe.add(act, 'count', 1, 10, 1).name('count');
    fe.add(act, 'aggressive').name('attack at once');
    fe.add(act, 'spawn').name('spawn (25 m ahead)');
    fe.add(act, 'killRadius', 10, 2000, 10).name('radius (m)');
    fe.add(act, 'kill').name('kill enemies in radius');
    fe.close();

    // teleport targets: markers and outposts (label -> entity id)
    const targets = {};
    for (const e of g.world.entities.list) if (e.type === 'marker' || e.type === 'outpost') targets[`${e.label ?? e.name ?? e.id} (${e.type})`] = e.id;
    const ft = f.addFolder('Teleport');
    act.target = Object.values(targets)[0] ?? '';
    ft.add(act, 'target', targets).name('to');
    ft.add(act, 'teleport').name('teleport');
    ft.close();
  }

  _missions(gui) {
    const g = this.app.game;
    const list = g.data.missions.missions ?? [];
    const ms = { id: list[0]?.id ?? '', start: () => { g.missions.start(ms.id); if (g.missions.state[ms.id]) g.missions.focus = ms.id; }, complete: () => g.missions.completeObjective(g.missions.focus) };
    const f = gui.addFolder('Missions');
    f.add(ms, 'id', Object.fromEntries(list.map((m) => [`${m.id} · ${m.title ?? ''}`, m.id]))).name('mission');
    f.add(ms, 'start').name('start');
    f.add(ms, 'complete').name('complete current objective');
    f.close();
  }

  // ---- Time & weather (getters / setters: the editor can swap lighting.env) --------------
  _time(gui) {
    const L = this.app.world.lighting, w = this.app.world;
    const relight = () => L.setTimeOfDay(L.timeOfDay);
    const t = {
      get hour() { return L.timeOfDay; }, set hour(v) { L.setTimeOfDay(v); },
      get dayLength() { return L.env.dayLengthMinutes; }, set dayLength(v) { L.env.dayLengthMinutes = v; },
      get exposure() { return L.env.exposure; }, set exposure(v) { L.env.exposure = v; relight(); },
      get wind() { return L.uniforms.windStrength.value; }, set wind(v) { L.env.wind.strength = L.uniforms.windStrength.value = v; },
      get clouds() { return L.skyU.cloudCoverage.value; }, set clouds(v) { L.env.clouds.coverage = L.skyU.cloudCoverage.value = v; },
      get advance() { return w.advanceDay !== false; }, set advance(v) { w.advanceDay = v; },
    };
    const f = gui.addFolder('Time & weather');
    f.add(t, 'hour', 0, 24, 0.05).name('hour');
    f.add(t, 'advance').name('day / night cycle');
    f.add(t, 'dayLength', 1, 120, 1).name('day length (min)');
    f.add(t, 'exposure', 0.2, 3, 0.01).name('exposure');
    f.add(t, 'wind', 0, 2, 0.01).name('wind');
    f.add(t, 'clouds', 0, 1, 0.01).name('clouds');
    f.close();
  }

  // ---- Fog & haze (Haze.js, Motes.js): on / off + strength are player settings (saved with the
  // game's options); the rest is lighting.env (haze, fogDensity, motes), saved by the editor ------
  _fog(gui) {
    const L = this.app.world.lighting, game = this.app.game;
    const relight = () => L.setTimeOfDay(L.timeOfDay); // colours + time of day factors
    const setting = (key, apply) => ({
      get v() { return game ? game.settings[key] ?? (key === 'fogStrength' ? FOG_STRENGTH : true) : key === 'fogStrength' ? L.haze.strength : key === 'motes' ? L.motes.enabled : L.haze.enabled; },
      set v(x) { if (game) game.saveSettings({ [key]: x }); else apply(x); },
    });
    const env = (group, key, scale = 1) => ({
      get v() { return (group ? L.env[group][key] : L.env[key]) * scale; },
      set v(x) { if (group) L.env[group][key] = x / scale; else L.env[key] = x / scale; relight(); },
    });
    const motes = (key) => ({ get v() { return L.env.motes[key]; }, set v(x) { L.env.motes[key] = x; L.motes.setConfig(L.env.motes); } });
    const f = gui.addFolder('Fog & haze');
    f.add(setting('fog', (x) => L.haze.setEnabled(x)), 'v').name('fog (haze + far fog)').listen();
    f.add(setting('fogStrength', (x) => L.haze.setStrength(x)), 'v', 0, 2, 0.01).name('strength').listen();
    f.add(env(null, 'fogDensity', 1000), 'v', 0, 6, 0.05).name('far fog (‰)');
    const fh = f.addFolder('Near haze');
    fh.add(env('haze', 'density', 1000), 'v', 0, 20, 0.1).name('density (‰ per m)');
    fh.add(env('haze', 'height'), 'v', 5, 200, 1).name('height (m)');
    fh.add(env('haze', 'base'), 'v', -50, 100, 1).name('base height (m)');
    fh.add(env('haze', 'max'), 'v', 0, 0.95, 0.01).name('max opacity');
    fh.add(env('haze', 'start'), 'v', 0, 50, 0.5).name('clear distance (m)');
    fh.add(env('haze', 'brightness'), 'v', 0, 2, 0.01).name('brightness');
    fh.add(env('haze', 'sun'), 'v', 0, 3, 0.01).name('glow toward the sun');
    fh.add(env('haze', 'variation'), 'v', 0, 1, 0.01).name('drifting banks');
    fh.add(env('haze', 'scale'), 'v', 20, 600, 5).name('bank size (m)');
    fh.add(env('haze', 'drift'), 'v', 0, 15, 0.1).name('drift (m/s)');
    fh.add(env('haze', 'morning'), 'v', 1, 5, 0.05).name('x at sunrise');
    fh.add(env('haze', 'evening'), 'v', 1, 5, 0.05).name('x at dusk');
    fh.add(env('haze', 'night'), 'v', 1, 5, 0.05).name('x at night');
    fh.add({ get v() { return +L.haze.factor.toFixed(2); }, set v(_) {} }, 'v').name('time of day x (now)').listen().disable();
    const fm = f.addFolder('Dust motes');
    fm.add(setting('motes', (x) => L.motes.setEnabled(x)), 'v').name('enabled').listen();
    fm.add(motes('intensity'), 'v', 0, 4, 0.05).name('intensity');
    fm.add(motes('count'), 'v', 0, 4000, 50).name('count');
    fm.add(motes('size'), 'v', 0.002, 0.05, 0.001).name('size (m)');
    fm.add(motes('box'), 'v', 4, 30, 0.5).name('range (m)');
    fm.add(motes('drift'), 'v', 0, 3, 0.05).name('drift (m/s)');
    fm.close();
    fh.close();
    f.close();
  }

  // ---- Sun shadows (SunShadows.js; live only, a quality change restores the preset's cascades) --
  _sunShadows(f, gfx) {
    const L = this.app.engine.lighting, sun = L.sun, U = sun.uniforms;
    const fs = f.addFolder('Sun shadows');
    const o = {
      get debug() { return U.sunDebug.value > 0.5 && U.sunDebug.value < 1.5; }, set debug(v) { U.sunDebug.value = v ? 1 : 0; },
      get distance() { return Number.isFinite(sun.maxDistance) ? sun.maxDistance : 0; },
      set distance(v) { sun.maxDistance = v > 0 ? v : Infinity; sun.refresh(); },
      get clamp() { return sun.clampToCasters; }, set clamp(v) { sun.clampToCasters = v; sun.refresh(); },
      get impostors() { return sun.impostorCasters; }, set impostors(v) { sun.impostorCasters = v; sun.refresh(); },
      get scale() { return `x ${sun.scale.toFixed(2)}`; }, set scale(_) {},
      get actual() {
        const d = Number.isFinite(sun.distance) ? `${Math.round(sun.distance)} m` : 'far cascade border';
        return Number.isFinite(sun.split) ? `${d}, far cascade only from ${Math.round(sun.split)} m` : d;
      },
      set actual(_) {},
      get fade() { return sun.fade; }, set fade(v) { sun.fade = v; sun.refresh(); },
      get bias() { return sun.bias; }, set bias(v) { sun.bias = v; sun.refresh(); },
      get softness() { return sun.softness; }, set softness(v) { sun.softness = v; sun.refresh(); },
      get levels() { return sun.cascades.length; },
      set levels(n) {
        // levels removed then added back come from the quality preset
        const cur = sun.config();
        sun.setCascades([...cur, ...L.Q.cascades.slice(cur.length)].slice(0, n), { distance: sun.maxDistance });
      },
    };
    // shadows end at the last cascade's border whatever the distance: that cascade spans ~0.8 of
    // the distance to each side (at least the preset's radius), refitted when the distance changes
    const fit = { on: true };
    const fitLast = () => {
      const last = sun.cascades.length - 1, d = sun.distance / sun.scale; // at ground level
      if (!fit.on || last < 0 || !Number.isFinite(d)) return;
      const r = Math.max(L.Q.cascades[last]?.radius ?? 0, Math.round(d * 0.8));
      if (r !== sun.cascades[last].radius) sun.setCascade(last, { radius: r });
    };
    fs.add(gfx, 'shadows').name('enabled');
    fs.add(o, 'debug').name('cascades view (R / G / B)');
    fs.add(o, 'distance', 0, 600, 5).name('max distance (m, 0 = ∞)').onFinishChange(fitLast).listen();
    fs.add(o, 'impostors').name('far trees cast (impostors)').onChange(fitLast);
    fs.add(o, 'clamp').name('no impostor shadow: stop there').onChange(fitLast);
    fs.add(fit, 'on').name('far cascade fits distance').onChange(fitLast);
    fs.add(o, 'actual').name('shadow distance').listen().disable();
    fs.add(o, 'fade', 0.02, 1, 0.01).name('fade (fraction of distance)');
    // in the air the cascades, their depth and the distance grow with the height above the ground
    fs.add(sun.altitude, 'ref', 5, 200, 5).name('altitude: grow from (m)');
    fs.add(sun.altitude, 'max', 1, 16, 1).name('altitude: max growth x');
    fs.add(o, 'scale').name('altitude scale').listen().disable();
    fs.add(U.sunBlend, 'value', 0.005, 0.25, 0.005).name('cascade blend band');
    fs.add(o, 'bias', 0.1, 4, 0.05).name('bias x');
    fs.add(o, 'softness', 0.25, 4, 0.05).name('softness x');
    fs.add(o, 'levels', { '1': 1, '2': 2, '3': 3 }).name('levels').listen();
    // static cache: world-anchored maps of the static casters, drawn again only when out of date
    const fcache = fs.addFolder('static cache');
    fcache.add({ get v() { return sun.cached; }, set v(x) { sun.setCached(x); } }, 'v').name('enabled').listen();
    fcache.add(sun, 'margin', 0, 1, 0.05).name('margin (x cascade)').onFinishChange(() => sun.setCached(sun.cached));
    fcache.add(sun, 'refreshHeight', 1, 60, 1).name('refresh: caster height (m)');
    fcache.add(sun, 'refreshTexels', 0.25, 8, 0.25).name('refresh: its shadow moved (texels)');
    fcache.add(sun, 'refreshTurn', 2, 90, 1).name('refresh: view turned (°)');
    fcache.add({ get v() { return sun.stats.refresh.join(' / '); }, set v(_) {} }, 'v').name('refreshes').listen().disable();
    fcache.add({ get v() { return sun.stats.dynamic.join(' / '); }, set v(_) {} }, 'v').name('dynamic passes').listen().disable();
    fcache.close();
    // per cascade: radius / resolution rebuild the cascades once the control is released
    ['near', 'mid', 'far'].forEach((name, i) => {
      const fc = fs.addFolder(`${name} (cascade ${i})`);
      const rebuild = (key) => {
        let pending = null;
        const c = { get v() { return pending ?? sun.cascades[i]?.[key] ?? 0; }, set v(x) { pending = x; } };
        return [c, () => { if (pending !== null) sun.setCascade(i, { [key]: pending }); pending = null; }];
      };
      const [radius, applyRadius] = rebuild('radius'), [res, applyRes] = rebuild('res');
      fc.add(radius, 'v', 2, [80, 250, 600][i], 1).name('radius (m)').onFinishChange(applyRadius).listen();
      fc.add(res, 'v', { 512: 512, 1024: 1024, 1536: 1536, 2048: 2048, 4096: 4096 }).name('resolution').onFinishChange(applyRes).listen();
      fc.add({ get v() { return sun.cascades[i]?.every ?? 0; }, set v(x) { sun.setCascade(i, { every: x }); } }, 'v', 1, 16, 1).name('render every N frames').listen();
      fc.add({ get v() { const c = sun.cascades[i]; return c ? `${(c.texel * 100).toFixed(1)} cm, reach ${Math.round(sun.reach(i))} m` : '-'; }, set v(_) {} }, 'v').name('texel, ground reach').listen().disable();
      fc.close();
    });
    // far shadows: the terrain's horizon sweep + the island-wide tree map (FarShadows.js)
    const far = sun.far, ff = fs.addFolder('far shadows (terrain + trees)');
    ff.add({ get v() { return far.enabled; }, set v(x) { far.setEnabled(x); } }, 'v').name('enabled');
    ff.add({ get v() { return U.sunDebug.value > 1.5; }, set v(x) { U.sunDebug.value = x ? 2 : 0; } }, 'v').name('sun visibility view').listen();
    ff.add({ get v() { return far.supported ? `${far.stats.bakes} bakes (${far.stats.ms.toFixed(2)} ms CPU), ${far.stats.trees} trees` : 'WebGPU only'; }, set v(_) {} }, 'v').name('bakes').listen().disable();
    ff.close();
    fs.close();
  }

  // ---- Graphics ---------------------------------------------------------------------------
  _graphics(gui) {
    const { engine, world, game } = this.app, L = engine.lighting, cam = engine.camera, overlay = this.overlay;
    const f = gui.addFolder('Graphics');
    const gfx = {
      get quality() { return engine.quality; },
      set quality(v) { if (game) game.saveSettings({ quality: v }); else engine.setQuality(v); },
      get resScale() { return engine.resScale; },
      set resScale(v) { engine.resScale = v; engine.renderer.setPixelRatio(engine.maxDpr * v); },
      get shadows() { return L.sun.enabled; }, set shadows(v) { L.sun.setEnabled(v); },
      get ao() { return L.ao.enabled; }, set ao(v) { L.ao.setEnabled(v); },
      get flare() { return L.flare.enabled; }, set flare(v) { if (game) game.saveSettings({ flare: v }); else L.flare.setEnabled(v); },
      get ssr() { return L.ssr.level; }, set ssr(v) { if (game) game.saveSettings({ ssr: v }); else L.ssr.setLevel(v); },
      get stats() { return overlay?.visible ?? false; }, set stats(v) { overlay?.setVisible(v); },
      get maxFps() { return engine.maxFps; }, set maxFps(v) { if (game) game.saveSettings({ fpsLimit: v }); else engine.maxFps = v; },
      // fixed when the renderer is created: reload with ?aa=
      get aa() { return engine.aaMode; }, set aa(v) { const u = new URL(location.href); u.searchParams.set('aa', v); location.href = u.href; },
      wireframe: false,
    };
    f.add(gfx, 'stats').name('stats (F3)');
    f.add(gfx, 'maxFps', { auto: 0, '30 fps': 30, '60 fps': 60, '90 fps': 90, '120 fps': 120, '144 fps': 144 }).name('FPS limit');
    f.add(gfx, 'quality', ['low', 'medium', 'high', 'ultra']).name('quality');
    f.add(gfx, 'aa', ['msaa4', 'fxaa', 'off']).name('antialias (reloads)');
    f.add(gfx, 'resScale', 0.3, 1, 0.01).name('resolution scale');
    this._sunShadows(f, gfx);
    const ao = L.ao, aoU = ao.u;
    const fa = f.addFolder('SSAO');
    fa.add(gfx, 'ao').name('enabled');
    fa.add(aoU.intensity, 'value', 0, 8, 0.05).name('intensity');
    fa.add(aoU.radius, 'value', 0.05, 4, 0.05).name('radius (m)');
    fa.add(aoU.maxPx, 'value', 4, 200, 1).name('max radius (px)');
    fa.add(aoU.fadeFar, 'value', 10, 300, 1).name('max distance (m)');
    fa.add(ao.uniforms.aoDirect, 'value', 0, 1, 0.01).name('on direct light');
    fa.add({ get v() { return ao.uniforms.aoDebug.value > 0.5; }, set v(x) { ao.uniforms.aoDebug.value = x ? 1 : 0; } }, 'v').name('AO only view');
    fa.close();
    // screen-space reflections on the water (level = settings; intensity / blur live in lighting.env.ssr)
    const fr = f.addFolder('Water reflections (SSR)');
    const ssrKey = (key) => ({ get v() { return L.env.ssr[key]; }, set v(x) { L.env.ssr[key] = x; L.ssr.set({ [key]: x }); } });
    const ssrU = L.ssr.uniforms;
    fr.add(gfx, 'ssr', { off: 'off', 'ultra low': 'ultralow', low: 'low', medium: 'medium', high: 'high' }).name('level').listen();
    fr.add(ssrKey('intensity'), 'v', 0, 1.5, 0.01).name('intensity');
    fr.add(ssrKey('blur'), 'v', 0, 1, 0.01).name('blur');
    // live overrides of the level's values (reset when the level changes)
    fr.add(L.ssr, 'distance', 40, 400, 5).name('depth range (m)').listen();
    fr.add(ssrU.ssrRay, 'value', 10, 400, 5).name('max ray (m)').listen();
    fr.add(ssrU.ssrSteps, 'value', 4, 32, 1).name('steps per ray').listen();
    fr.add({ get v() { return ssrU.ssrDebug.value > 0.5; }, set v(x) { ssrU.ssrDebug.value = x ? 1 : 0; } }, 'v').name('reflections only view');
    fr.close();
    // sun lens flare + light halos (values live in lighting.env.flare / glows, saved by the editor)
    const fl = f.addFolder('Lens flare & halos');
    const envKey = (group, key) => ({ get v() { return L.env[group][key]; }, set v(x) { L.env[group][key] = x; } });
    fl.add(gfx, 'flare').name('lens flare');
    fl.add(envKey('flare', 'intensity'), 'v', 0, 3, 0.01).name('intensity');
    fl.add(envKey('flare', 'glare'), 'v', 0, 3, 0.01).name('glare');
    fl.add(envKey('flare', 'ghosts'), 'v', 0, 3, 0.01).name('ghosts');
    fl.add(envKey('flare', 'dazzle'), 'v', 0, 0.5, 0.01).name('dazzle');
    fl.add({ get v() { return +L.flare.visible.toFixed(2); }, set v(_) {} }, 'v').name('sun visibility').listen().disable();
    fl.add(envKey('glows', 'intensity'), 'v', 0, 3, 0.01).name('light halos');
    fl.add(envKey('glows', 'distance'), 'v', 50, 1500, 10).name('halos: distance (m)');
    fl.close();
    // textured PBR surfaces (values live in lighting.env.surface; detail 0 = plain vertex colours, A/B)
    const fs = f.addFolder('Textures');
    const su = L.surfaces.uniforms;
    fs.add(su.surfDetail, 'value', 0, 1, 0.01).name('texture detail');
    fs.add(su.surfNormalScale, 'value', 0, 2, 0.01).name('normal maps');
    fs.add({ get v() { return L.env.surface.skySpecular; }, set v(x) { L.env.surface.skySpecular = x; L.setTimeOfDay(L.timeOfDay); } }, 'v', 0, 3, 0.01).name('sky reflections');
    fs.close();
    // probe GI + auto exposure (values live in lighting.env.gi / autoExposure, saved by the editor)
    const gi = L.gi, relight = () => L.setTimeOfDay(L.timeOfDay);
    const fg = f.addFolder('GI (probes)');
    const g = {
      get on() { return gi.enabled; }, set on(v) { gi.setEnabled(v); relight(); },
      get intensity() { return L.env.gi.intensity; }, set intensity(v) { L.env.gi.intensity = v; gi.setConfig(L.env); relight(); },
      get bias() { return L.env.gi.bias; }, set bias(v) { L.env.gi.bias = v; gi.setConfig(L.env); },
      get floor() { return L.env.gi.floor; }, set floor(v) { L.env.gi.floor = v; gi.setConfig(L.env); },
      get volumes() { return gi.volumesEnabled; }, set volumes(v) { gi.setVolumesEnabled(v); },
      get debug() { return gi.uniforms.giDebug.value > 0.5; }, set debug(v) { gi.uniforms.giDebug.value = v ? 1 : 0; },
      get ae() { return L.env.autoExposure.enabled; }, set ae(v) { L.env.autoExposure.enabled = v; gi.setConfig(L.env); },
      get strength() { return L.env.autoExposure.strength; }, set strength(v) { L.env.autoExposure.strength = v; gi.setConfig(L.env); },
      get max() { return L.env.autoExposure.max; }, set max(v) { L.env.autoExposure.max = v; gi.setConfig(L.env); },
      get exposure() { return +gi.exposure.toFixed(2); }, set exposure(_) {},
      get open() { return +gi.openness.toFixed(2); }, set open(_) {},
    };
    if (!gi.loaded) fg.add({ info: 'not baked: npm run mc -- gi bake' }, 'info').name('GI').disable();
    fg.add(g, 'on').name('enabled');
    fg.add(g, 'intensity', 0, 3, 0.01).name('intensity');
    fg.add(g, 'floor', 0, 1, 0.01).name('ambient floor');
    fg.add(g, 'bias', 0, 3, 0.05).name('normal bias (m)');
    fg.add(g, 'volumes').name('interior volumes');
    fg.add(g, 'debug').name('irradiance only view');
    // probe spheres around the camera (an engine system only while shown)
    const pv = (this.probeView ??= new GIProbeView(gi, engine.scene, world ? (x, z) => world.heightAt(x, z) : null));
    const probes = {
      get on() { return pv.visible; },
      set on(v) { pv.setVisible(v); engine.removeSystem(pv); if (v) engine.addSystem(pv); },
      get layer() { return pv.layer; }, set layer(v) { pv.layer = +v; },
    };
    fg.add(probes, 'on').name('show probes');
    fg.add(pv, 'radius', 8, 128, 8).name('probe radius (m)');
    fg.add(pv, 'size', 0.1, 2, 0.05).name('probe size (m)');
    fg.add(probes, 'layer', { all: -1, '1.5 m': 0, '3.75 m': 1, '9.4 m': 2, '23.4 m': 3 }).name('probe layer');
    fg.add(g, 'ae').name('auto exposure');
    fg.add(g, 'strength', 0, 1, 0.01).name('auto exposure strength');
    fg.add(g, 'max', 1, 4, 0.05).name('auto exposure max');
    fg.add(g, 'exposure').name('current auto exposure').listen().disable();
    fg.add(g, 'open').name('sky openness (camera)').listen().disable();
    fg.close();
    const wired = new Set();
    f.add(gfx, 'wireframe').onChange((v) => {
      if (v) engine.scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && 'wireframe' in m && !m.isShaderMaterial && !m.wireframe) { m.wireframe = true; wired.add(m); }
      });
      else { for (const m of wired) m.wireframe = false; wired.clear(); }
    });

    // what gets drawn (to isolate the cost of each part of the frame)
    const fv = f.addFolder('Display');
    const vis = (label, getObj) => {
      if (!getObj()) return;
      const o = { get v() { return getObj()?.visible ?? false; }, set v(x) { const obj = getObj(); if (obj) obj.visible = x; } };
      fv.add(o, 'v').name(label);
    };
    vis('sky', () => L.sky);
    if (world) {
      vis('terrain', () => world.terrainRenderer?.group);
      vis('water', () => world.water?.group);
      vis('vegetation', () => world.vegetation?.group);
      const veg = world.vegetation;
      if (veg?.setLodVisible) {
        const fl = fv.addFolder('vegetation LODs');
        for (const [k, label] of [['lod0', 'LOD 0 (full meshes)'], ['lod1', 'LOD 1 (mid meshes)'], ['lod2', 'LOD 2 (far meshes: bushes, rocks)'], ['impostor', 'impostors (far trees)'], ['impostorShadow', 'impostor shadow cards']]) {
          fl.add({ get v() { return veg.lodVisible[k]; }, set v(x) { veg.setLodVisible(k, x); } }, 'v').name(label);
        }
      }
      vis('grass', () => world.grass?.group);
      vis('props (batch)', () => world.entities?.props?.group);
    }
    const layer = (label, l) => {
      const o = { get v() { return cam.layers.isEnabled(l); }, set v(x) { if (x) cam.layers.enable(l); else cam.layers.disable(l); } };
      fv.add(o, 'v').name(label);
    };
    layer('dynamic (characters, vehicles)', LAYERS.DYNAMIC);
    layer('effects (FX)', LAYERS.FX);
    if (game) fv.add({ get v() { return engine.overlay?.visible !== false; }, set v(x) { if (engine.overlay) engine.overlay.visible = x; } }, 'v').name('weapon (FPS view)');
    fv.close();
    f.close();
  }
}
