#!/usr/bin/env node
// Performance benchmark: renders a set of viewpoints (public/data/bench.json, or the defaults
// below) headless with vsync off, and reports frame / CPU / GPU ms per view. The target is
// 120+ fps on a MacBook Air M1 (~8.3 ms); this machine may be faster, so compare GPU ms against
// --budget (default 4.5 ms here ≈ 8 ms on an M1).
//
//   npm run bench -- [--mode play] [--m1] [--repeat N] [--fresh] [--views a,b] [--weapon id|none] [--quality medium] [--size 1440x900]
//                    [--seconds 3] [--json] [--query gi=0] [--res 0.5] [--pre "<js>"]
//                    [--breakdown [--only a,b] [--veg] [--switch "name::off::on"] [--pairs 2]] [--veg-stats]
// --mode play runs the real game (enemies, AI, HUD, view model) with the player flown to each view,
// holding a weapon (--weapon rifle_ak by default, --weapon none: empty hands, no view model pass).
// --m1 estimates a MacBook Air M1 (7-core GPU) conservatively: the page's CPU is throttled 2x
// through DevTools (M1 single core ≈ 1.6x slower than this M4) and the measured GPU time is
// scaled by 1.9 (M4 10-core GPU ≈ 1.86x a 7-core M1). m1fps = 1000 / max(throttled frame, gpu x 1.9).
// --res scales the render resolution (fill-rate test); --pre runs code in the page after loading
// (e, w, g = engine, world, game), e.g. --pre "e.lighting.ao.setEnabled(false)".
//
// --breakdown: what each system costs on the GPU. Its switch is turned off and on again `--pairs`
// times; each half is the median of the per-frame GPU timer samples, and saved = base - off over
// the pairs, so slow drift (thermal throttling of a fanless laptop, other apps) cancels out. --only
// picks switches; --veg adds one switch per vegetation LOD level and per species. "res 50%" tells
// fill-rate cost from geometry cost. GPU ms = WebGPU timestamps around every pass, the time they
// cover per frame (Perf.js). Without vsync a GPU-bound page runs ahead until WebGPU's command buffer
// fills and then stalls ~20-40 ms every few dozen frames: that is the `worst` column (with vsync
// the frames are even).
// --veg-stats: per view, vegetation instances submitted / in their LOD range / tiny on screen,
// vertex invocations and triangles rasterized per species and LOD (Vegetation.lodStats).
import { ensureServer, launch, openApp, frames } from './lib/browser.js';
import { readJSON } from './lib/data.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
const [w, h] = (opt.size ?? '1440x900').split('x').map(Number);
const seconds = Number(opt.seconds ?? 3);
const budget = Number(opt.budget ?? 4.5);
const list = (s) => (typeof s === 'string' ? s.split(',') : null);
// [name, switch off, switch on] (e = engine, w = world, g = game)
let SWITCHES = [
  ['res 50%', 'window.__pr = e.renderer.getPixelRatio(); e.renderer.setPixelRatio(window.__pr / 2)', 'e.renderer.setPixelRatio(window.__pr)'],
  ['shadows', 'e.lighting.sun.setEnabled(false)', 'e.lighting.sun.setEnabled(true)'],
  ['ssao', 'e.lighting.ao.setEnabled(false)', 'e.lighting.ao.setEnabled(true)'],
  ['gi', 'e.lighting.gi.setEnabled(false)', 'e.lighting.gi.setEnabled(true)'],
  ['vegetation', 'w.vegetation.group.visible = false', 'w.vegetation.group.visible = true'],
  // out of the sun cascade layers (7..9) and the SSAO occluder one (6): no longer in the cascades nor the SSAO depth pre-pass
  ['veg shadows', 'window.__vl = []; w.vegetation.group.traverse((o) => { if (o.isMesh && (o.layers.mask & 0x3c0)) { window.__vl.push([o, o.layers.mask]); o.layers.mask &= ~0x3c0; } })', 'for (const [o, m] of window.__vl) o.layers.mask = m'],
  ['terrain', 'w.terrainRenderer.group.visible = false', 'w.terrainRenderer.group.visible = true'],
  ['terrain shadows', 'w.terrainRenderer.group.traverse((o) => { if (o.isMesh) o.layers.set(2); })', 'w.terrainRenderer.group.traverse((o) => { if (o.isMesh) o.layers.set(0); })'],
  ['grass', 'if (w.grass) w.grass.group.visible = false', 'if (w.grass) w.grass.group.visible = true'],
  ['water', 'w.water.group.visible = false', 'w.water.group.visible = true'],
  ['props', 'if (w.entities.props) w.entities.props.group.visible = false', 'if (w.entities.props) w.entities.props.group.visible = true'],
  ['actors', 'for (const a of (g?.actors.list ?? [])) a.root.visible = false', 'for (const a of (g?.actors.list ?? [])) a.root.visible = true'],
  // (the weapons reset overlay.visible every frame: take the pass away instead)
  ['view model', 'window.__ov = e.overlay; e.overlay = null', 'e.overlay = window.__ov'],
  ['flare', 'e.lighting.flare.setEnabled(false)', 'e.lighting.flare.setEnabled(true)'],
  ['sky', 'e.lighting.sky.visible = false', 'e.lighting.sky.visible = true'],
];
if (opt.veg) {
  // vegetation mesh names: <field>_<species>_<variant>_lod<n>
  const hide = (re) => [`window.__vh = []; w.vegetation.group.traverse((o) => { if (o.isMesh && o.visible && ${re}.test(o.name)) { window.__vh.push(o); o.visible = false; } })`, 'for (const o of window.__vh) o.visible = true'];
  const species = readJSON('vegetation.json').species.map((s) => s.id);
  SWITCHES.push(...[0, 1, 2].map((l) => [`veg lod${l}`, ...hide(`/_lod${l}$/`)]), ...species.map((id) => [id, ...hide(`/_${id}_\\d+_lod\\d$/`)]));
}
// --switch "name::off code::on code" (several separated by |||): ad hoc experiments
if (typeof opt.switch === 'string') SWITCHES.push(...opt.switch.split("|||").map((x) => x.split('::')));
if (list(opt.only)) SWITCHES = SWITCHES.filter(([k]) => list(opt.only).includes(k));
let views = readJSON('bench.json', null)?.views ?? [
  { name: 'beach', cam: '-170,30,720,0,-0.12' },
];
if (list(opt.views)) views = views.filter((v) => list(opt.views).includes(v.name));

await ensureServer();
const { browser, page, logs } = await launch({ width: w, height: h });
const results = [], breakdown = [], vegStats = [];
try {
  const play = opt.mode === 'play';
  const q = new URLSearchParams(play ? { autostart: '1', nointro: '1', bot: '1', quality: opt.quality ?? 'medium', bench: '1' } : { mode: 'view', nohud: '1', quality: opt.quality ?? 'medium', bench: '1' });
  if (typeof opt.query === 'string') for (const [k, v] of new URLSearchParams(opt.query)) q.set(k, v); // e.g. --query gi=0 (A/B)
  const run = (code) => page.evaluate((code) => (new Function('e', 'w', 'g', code))(window.__mc.engine, window.__mc.world, window.__mc.game), code);
  const open = async () => {
    await openApp(page, `/?${q}`);
    if (opt.m1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
    }
    if (play) await page.evaluate((weapon) => { const g = window.__mc.game; g.player.godMode = true; g.engine.lighting.env.dayLengthMinutes = 0; if (weapon !== 'none') g.weapons.give(weapon, { select: true }); }, typeof opt.weapon === 'string' ? opt.weapon : 'rifle_ak');
    if (opt.res) await run(`e.renderer.setPixelRatio(e.renderer.getPixelRatio() * ${Number(opt.res)})`);
    if (typeof opt.pre === 'string') await run(opt.pre);
  };
  // median of the per-frame GPU timer samples over `sec` (after 20 frames to settle)
  const gpuMedian = (sec) => page.evaluate(async (sec) => {
    const perf = window.__mc.engine.perf, s = [], prev = perf.onGpu;
    await new Promise((r) => { let n = 0; const f = () => (++n >= 20 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    perf.onGpu = (ms) => { s.push(ms); prev?.(ms); };
    await new Promise((r) => setTimeout(r, sec * 1000));
    perf.onGpu = prev;
    s.sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  }, sec);
  await open();
  const repeat = Number(opt.repeat ?? 1);
  const runs = [];
  for (let rep = 0; rep < repeat; rep++) for (const v of views) runs.push({ v, rep });
  for (const { v, rep } of runs) {
    // --fresh: a new page per measurement (no fights / loot carried over from the previous view)
    if (opt.fresh && results.length) await open();
    if (play) await page.evaluate((v) => {
      const g = window.__mc.game, c = String(v.cam).split(',').map(Number);
      g.player.noclip = true;
      g.player.pos.set(c[0], c[1] - 1.65, c[2]);
      g.player.yaw = c[3] ?? 0; g.player.pitch = c[4] ?? 0;
      if (v.tod !== undefined) g.engine.lighting.setTimeOfDay(+v.tod);
    }, v);
    else await page.evaluate((v) => window.__mc.setView(v), v);
    await frames(page, 60); // settle (LODs, shader compiles, shadow cascades)
    const r = await page.evaluate(async (sec) => {
      // rendered frames (not rAF ticks: Engine's frame pacing may hold a frame back, Engine.start)
      const e = window.__mc.engine, prev = e.perf.onFrame;
      const t0 = performance.now(), f0 = e.frameCount;
      let worst = 0;
      e.perf.onFrame = (cpu, fm) => { worst = Math.max(worst, fm); prev?.(cpu, fm); };
      await new Promise((res) => setTimeout(res, sec * 1000));
      e.perf.onFrame = prev;
      const n = e.frameCount - f0;
      const s = e.perf.snapshot();
      // p95 frame time (ignores one-off hitches like a teleport)
      return { fps: +(n / ((performance.now() - t0) / 1000)).toFixed(1), worstMs: +worst.toFixed(1), cpuMs: s.cpuMs, gpuMs: s.gpuMs, calls: s.calls, tris: s.triangles, marks: s.marks };
    }, seconds);
    results.push({ view: v.name, ...r });
    if (opt['veg-stats'] && rep === 0) {
      vegStats.push({ view: v.name, rows: await page.evaluate(() => { const e = window.__mc.engine; return window.__mc.world.vegetation.lodStats(e.camera, e.renderer.domElement.height); }) });
    }
    if (opt.breakdown || opt.veg) {
      const sec = Math.min(1.5, seconds), pairs = Number(opt.pairs ?? 2);
      for (const [k, off, on] of SWITCHES) {
        let base = 0, without = 0;
        for (let p = 0; p < pairs; p++) {
          base += await gpuMedian(sec);
          await run(off);
          without += await gpuMedian(sec);
          await run(on);
        }
        breakdown.push({ view: v.name, switch: k, base: base / pairs, off: without / pairs });
      }
    }
  }
} finally {
  await browser.close();
}
const med = (a) => { const b = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : a[0]; };
// median over repeats (GPU timer queries include time the GPU spends on other apps: repeat to denoise)
if (Number(opt.repeat ?? 1) > 1) {
  const by = new Map();
  for (const r of results) { if (!by.has(r.view)) by.set(r.view, []); by.get(r.view).push(r); }
  results.length = 0;
  for (const [view, list] of by) results.push({ view, fps: med(list.map((r) => r.fps)), worstMs: med(list.map((r) => r.worstMs)), cpuMs: med(list.map((r) => r.cpuMs)), gpuMs: med(list.map((r) => r.gpuMs)), calls: med(list.map((r) => r.calls)), tris: med(list.map((r) => r.tris)), marks: list[0].marks });
  const bb = new Map();
  for (const b of breakdown) { const key = b.view + '\n' + b.switch; if (!bb.has(key)) bb.set(key, []); bb.get(key).push(b); }
  breakdown.length = 0;
  for (const l of bb.values()) breakdown.push({ view: l[0].view, switch: l[0].switch, base: med(l.map((b) => b.base)), off: med(l.map((b) => b.off)) });
}
for (const b of breakdown) { b.saved = +(b.base - b.off).toFixed(2); b.share = +((b.saved / b.base) * 100).toFixed(1); b.base = +b.base.toFixed(2); b.off = +b.off.toFixed(2); }
for (const s of vegStats) s.rows.sort((a, b) => b.vertexInvocations - a.vertexInvocations);
if (opt.json) console.log(JSON.stringify({ views: results, breakdown, vegStats }, null, 2));
else {
  console.log(`view               fps   worst  cpu   gpu   calls  tris${opt.m1 ? '   M1 fps (est.)' : ''}`);
  for (const r of results) {
    let flag = r.gpuMs != null ? (r.gpuMs <= budget ? 'OK ' : 'SLOW') : '';
    if (opt.m1) {
      r.m1fps = Math.round(Math.min(r.fps, 1000 / (r.gpuMs * 1.9)));
      flag = `${String(r.m1fps).padStart(6)} ${r.m1fps >= 120 ? 'OK' : 'SLOW'}`;
    }
    console.log(`${r.view.padEnd(16)} ${String(r.fps).padStart(6)} ${String(r.worstMs).padStart(6)} ${String(r.cpuMs).padStart(5)} ${String(r.gpuMs).padStart(5)} ${String(r.calls).padStart(6)} ${String(Math.round(r.tris / 1000) + 'k').padStart(6)} ${flag}`);
  }
  if (opt.m1) {
    const worst = results.filter((r) => r.m1fps).sort((a, b) => a.m1fps - b.m1fps)[0];
    console.log(`\nM1 estimate: worst view ${worst?.view} = ${worst?.m1fps} fps (target 120)${Number(opt.repeat ?? 1) > 1 ? ` — median of ${opt.repeat} runs` : ''}`);
  }
  if (breakdown.length) {
    console.log('\nGPU cost per system (ms, median per-frame GPU time; saved = base - off)');
    let view = null;
    for (const b of breakdown) {
      if (b.view !== view) { view = b.view; console.log(`${view.padEnd(18)}  base    off   saved  share`); }
      console.log(`  ${b.switch.padEnd(16)} ${b.base.toFixed(2).padStart(5)}  ${b.off.toFixed(2).padStart(5)}  ${b.saved.toFixed(2).padStart(6)}  ${b.share.toFixed(0).padStart(4)}%`);
    }
  }
  for (const s of vegStats) {
    const t = s.rows.reduce((a, r) => ({ sub: a.sub + r.submitted, inr: a.inr + r.inRange, tiny: a.tiny + r.tiny, vi: a.vi + r.vertexInvocations, tris: a.tris + r.triangles }), { sub: 0, inr: 0, tiny: 0, vi: 0, tris: 0 });
    console.log(`\nvegetation at ${s.view}: ${t.sub} instances submitted, ${t.inr} in their LOD range, ${t.tiny} of them < 12 px tall; ${(t.vi / 1e6).toFixed(2)}M vertex invocations, ${(t.tris / 1e6).toFixed(2)}M triangles rasterized (per pass)`);
    console.log('  species / lod          submitted  in range  median px  < 12 px  tris/inst  M vert inv  k tris  shadow');
    for (const r of s.rows.slice(0, Number(opt.top ?? 16))) console.log(`  ${(r.kind + ' lod' + r.lod).padEnd(22)} ${String(r.submitted).padStart(9)} ${String(r.inRange).padStart(9)} ${String(r.medianPx).padStart(10)} ${String(r.tiny).padStart(8)} ${String(Math.round(r.triangles / Math.max(1, r.inRange))).padStart(10)} ${(r.vertexInvocations / 1e6).toFixed(2).padStart(11)} ${String(Math.round(r.triangles / 1000)).padStart(7)}  ${r.shadow}`);
  }
  const errs = logs.filter((l) => /error/i.test(l));
  if (errs.length) console.log('\nconsole errors:\n' + errs.slice(0, 8).join('\n'));
}
