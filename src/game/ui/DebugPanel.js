// Debug panel (lil-gui, F2 toggles): live stats, cheats and game actions, missions, time and
// weather, graphics / world toggles. Shown by default (?debug=0 hides it; automated runs with
// ?bot / ?bench / ?nohud start without it = app.debugMode), built on first open. In debug mode
// nothing is persisted: a reload starts from the default settings (no localStorage). Opening it
// mid-game (F2) frees the mouse without pausing so values can be tweaked live (click the game to
// capture the mouse again); Esc still pauses, and the panel stays usable above the pause menu.
import { LAYERS } from '../../engine/render/layers.js';
import { GIProbeView } from '../../engine/render/GIProbeView.js';

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
    if (this.app.world) this._time(gui);
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
    I.programs = r.info.programs?.length ?? 0;
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
      get fog() { return L.env.fogDensity * 1000; }, set fog(v) { L.env.fogDensity = v / 1000; relight(); },
      get exposure() { return L.env.exposure; }, set exposure(v) { L.env.exposure = v; relight(); },
      get wind() { return L.uniforms.windStrength.value; }, set wind(v) { L.env.wind.strength = L.uniforms.windStrength.value = v; },
      get clouds() { return L.skyU.cloudCoverage.value; }, set clouds(v) { L.env.clouds.coverage = L.skyU.cloudCoverage.value = v; },
      get advance() { return w.advanceDay !== false; }, set advance(v) { w.advanceDay = v; },
    };
    const f = gui.addFolder('Time & weather');
    f.add(t, 'hour', 0, 24, 0.05).name('hour');
    f.add(t, 'advance').name('day / night cycle');
    f.add(t, 'dayLength', 1, 120, 1).name('day length (min)');
    f.add(t, 'fog', 0, 6, 0.05).name('fog (‰)');
    f.add(t, 'exposure', 0.2, 3, 0.01).name('exposure');
    f.add(t, 'wind', 0, 2, 0.01).name('wind');
    f.add(t, 'clouds', 0, 1, 0.01).name('clouds');
    f.close();
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
      get stats() { return overlay?.visible ?? false; }, set stats(v) { overlay?.setVisible(v); },
      get maxFps() { return engine.maxFps; }, set maxFps(v) { if (game) game.saveSettings({ fpsLimit: v }); else engine.maxFps = v; },
      wireframe: false,
    };
    f.add(gfx, 'stats').name('stats (F3)');
    f.add(gfx, 'maxFps', { auto: 0, '30 fps': 30, '60 fps': 60, '90 fps': 90, '120 fps': 120, '144 fps': 144 }).name('FPS limit');
    f.add(gfx, 'quality', ['low', 'medium', 'high', 'ultra']).name('quality');
    f.add(gfx, 'resScale', 0.3, 1, 0.01).name('resolution scale');
    f.add(gfx, 'shadows').name('sun shadows');
    const ao = L.ao, aoU = ao.aoMat.uniforms;
    const fa = f.addFolder('SSAO');
    fa.add(gfx, 'ao').name('enabled');
    fa.add(aoU.intensity, 'value', 0, 8, 0.05).name('intensity');
    fa.add(aoU.radius, 'value', 0.05, 4, 0.05).name('radius (m)');
    fa.add(aoU.maxPx, 'value', 4, 200, 1).name('max radius (px)');
    fa.add(aoU.fadeFar, 'value', 10, 300, 1).name('max distance (m)');
    fa.add(ao.uniforms.aoDirect, 'value', 0, 1, 0.01).name('on direct light');
    fa.add({ get v() { return ao.uniforms.aoDebug.value > 0.5; }, set v(x) { ao.uniforms.aoDebug.value = x ? 1 : 0; } }, 'v').name('AO only view');
    fa.close();
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
    // probe GI + auto exposure (values live in lighting.env.gi / autoExposure, saved by the editor)
    const gi = L.gi, relight = () => L.setTimeOfDay(L.timeOfDay);
    const fg = f.addFolder('GI (probes)');
    const g = {
      get on() { return gi.enabled; }, set on(v) { gi.setEnabled(v); relight(); },
      get intensity() { return L.env.gi.intensity; }, set intensity(v) { L.env.gi.intensity = v; gi.setConfig(L.env); relight(); },
      get bias() { return L.env.gi.bias; }, set bias(v) { L.env.gi.bias = v; gi.setConfig(L.env); },
      get floor() { return L.env.gi.floor; }, set floor(v) { L.env.gi.floor = v; gi.setConfig(L.env); },
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
