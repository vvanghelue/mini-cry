#!/usr/bin/env node
// Performance benchmark: renders a set of viewpoints (public/data/bench.json, or the defaults
// below) headless with vsync off, and reports frame / CPU / GPU ms per view. The target is
// 120+ fps on a MacBook Air M1 (~8.3 ms); this machine may be faster, so compare GPU ms against
// --budget (default 4.5 ms here ≈ 8 ms on an M1).
//
//   npm run bench -- [--mode play] [--m1] [--repeat N] [--fresh] [--breakdown] [--quality medium] [--size 1440x900] [--seconds 3] [--json] [--query gi=0]
// --mode play runs the real game (enemies, AI, HUD, view model) with the player flown to each view.
// --m1 estimates a MacBook Air M1 (7-core GPU) conservatively: the page's CPU is throttled 2x
// through DevTools (M1 single core ≈ 1.6x slower than this M4) and the measured GPU time is
// scaled by 1.9 (M4 10-core GPU ≈ 1.86x a 7-core M1). m1fps = 1000 / max(throttled frame, gpu x 1.9).
import { ensureServer, launch, openApp, frames } from './lib/browser.js';
import { readJSON } from './lib/data.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
const [w, h] = (opt.size ?? '1440x900').split('x').map(Number);
const seconds = Number(opt.seconds ?? 3);
const budget = Number(opt.budget ?? 4.5);
// --breakdown: for each view, measure again with one system switched off at a time
const BREAKDOWN = {
  shadows: 'e.lighting.sun.setEnabled(false)',
  ao: 'e.lighting.ao.setEnabled(false)',
  vegetation: 'w.vegetation.group.visible = false',
  grass: 'if (w.grass) w.grass.group.visible = false',
  water: 'w.water.group.visible = false',
  props: 'if (w.entities.props) w.entities.props.group.visible = false',
  actors: 'for (const a of (window.__mc.game?.actors.list ?? [])) a.root.visible = false',
  terrain: 'w.terrainRenderer.group.visible = false',
};
const views = readJSON('bench.json', null)?.views ?? [
  { name: 'beach', cam: '-170,30,720,0,-0.12' },
];

await ensureServer();
const { browser, page, logs } = await launch({ width: w, height: h });
const results = [];
try {
  const play = opt.mode === 'play';
  const q = new URLSearchParams(play ? { autostart: '1', nointro: '1', bot: '1', quality: opt.quality ?? 'medium', bench: '1' } : { mode: 'view', nohud: '1', quality: opt.quality ?? 'medium', bench: '1' });
  if (typeof opt.query === 'string') for (const [k, v] of new URLSearchParams(opt.query)) q.set(k, v); // e.g. --query gi=0 (A/B)
  await openApp(page, `/?${q}`);
  if (opt.m1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
  }
  if (play) await page.evaluate(() => { const g = window.__mc.game; g.player.godMode = true; g.engine.lighting.env.dayLengthMinutes = 0; });
  const repeat = Number(opt.repeat ?? 1);
  const runs = [];
  for (let rep = 0; rep < repeat; rep++) for (const v of views) runs.push(v);
  for (const v of runs) {
    // --fresh: a new page per measurement (no fights / loot carried over from the previous view)
    if (opt.fresh && results.length) {
      await openApp(page, `/?${q}`);
      if (opt.m1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 }); }
      if (play) await page.evaluate(() => { const g = window.__mc.game; g.player.godMode = true; g.engine.lighting.env.dayLengthMinutes = 0; });
    }
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
      const e = window.__mc.engine;
      const t0 = performance.now();
      let n = 0, worst = 0, last = t0;
      await new Promise((res) => {
        const f = () => {
          const now = performance.now();
          worst = Math.max(worst, now - last);
          last = now;
          n++;
          if (now - t0 < sec * 1000) requestAnimationFrame(f); else res();
        };
        requestAnimationFrame(f);
      });
      const s = e.perf.snapshot();
      // p95 frame time (ignores one-off hitches like a teleport)
      return { fps: +(n / ((performance.now() - t0) / 1000)).toFixed(1), worstMs: +worst.toFixed(1), cpuMs: s.cpuMs, gpuMs: s.gpuMs, calls: s.calls, tris: s.triangles, marks: s.marks };
    }, seconds);
    results.push({ view: v.name, ...r });
    if (opt.breakdown) {
      for (const [k, code] of Object.entries(BREAKDOWN)) {
        await page.evaluate((code) => { const e = window.__mc.engine, w = window.__mc.world; window.__undo = () => location.reload(); (new Function('e', 'w', code))(e, w); }, code);
        await frames(page, 30);
        const rb = await page.evaluate(async (sec) => {
          const e = window.__mc.engine;
          await new Promise((res) => setTimeout(res, sec * 1000));
          const s = e.perf.snapshot();
          return { cpuMs: s.cpuMs, gpuMs: s.gpuMs, calls: s.calls };
        }, Math.min(2, seconds));
        results.push({ view: `  -${k}`, fps: '', worstMs: '', ...rb, tris: 0 });
        // restore everything for the next toggle
        await page.evaluate(() => { const e = window.__mc.engine, w = window.__mc.world; e.lighting.sun.setEnabled(true); e.lighting.ao.setEnabled(true); w.vegetation.group.visible = true; if (w.grass) w.grass.group.visible = true; w.water.group.visible = true; if (w.entities.props) w.entities.props.group.visible = true; w.terrainRenderer.group.visible = true; for (const a of (window.__mc.game?.actors.list ?? [])) a.root.visible = true; });
        await frames(page, 20);
      }
    }
  }
} finally {
  await browser.close();
}
// median over repeats (GPU timer queries include time the GPU spends on other apps: repeat to denoise)
if (Number(opt.repeat ?? 1) > 1) {
  const by = new Map();
  for (const r of results) { if (!by.has(r.view)) by.set(r.view, []); by.get(r.view).push(r); }
  const med = (a) => { const b = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : a[0]; };
  results.length = 0;
  for (const [view, list] of by) results.push({ view, fps: med(list.map((r) => r.fps)), worstMs: med(list.map((r) => r.worstMs)), cpuMs: med(list.map((r) => r.cpuMs)), gpuMs: med(list.map((r) => r.gpuMs)), calls: med(list.map((r) => r.calls)), tris: med(list.map((r) => r.tris)), marks: list[0].marks });
}
if (opt.json) console.log(JSON.stringify(results, null, 2));
else {
  console.log(`view               fps   worst  cpu   gpu   calls  tris${opt.m1 ? '   M1 fps (est.)' : ''}`);
  for (const r of results) {
    let flag = r.gpuMs != null ? (r.gpuMs <= budget ? 'OK ' : 'SLOW') : '';
    if (opt.m1 && r.fps !== '') {
      r.m1fps = Math.round(Math.min(r.fps, 1000 / (r.gpuMs * 1.9)));
      flag = `${String(r.m1fps).padStart(6)} ${r.m1fps >= 120 ? 'OK' : 'SLOW'}`;
    }
    console.log(`${r.view.padEnd(16)} ${String(r.fps).padStart(6)} ${String(r.worstMs).padStart(6)} ${String(r.cpuMs).padStart(5)} ${String(r.gpuMs).padStart(5)} ${String(r.calls).padStart(6)} ${String(Math.round(r.tris / 1000) + 'k').padStart(6)} ${flag}`);
  }
  if (opt.m1) {
    const worst = results.filter((r) => r.m1fps).sort((a, b) => a.m1fps - b.m1fps)[0];
    console.log(`\nM1 estimate: worst view ${worst?.view} = ${worst?.m1fps} fps (target 120)${Number(opt.repeat ?? 1) > 1 ? ` — median of ${opt.repeat} runs` : ''}`);
  }
  const errs = logs.filter((l) => /error/i.test(l));
  if (errs.length) console.log('\nconsole errors:\n' + errs.slice(0, 8).join('\n'));
}
