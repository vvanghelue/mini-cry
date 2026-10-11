#!/usr/bin/env node
// Chrome trace of a fast straight flight across the island: lists the long frames (> --min ms)
// with what ran inside them (GC, JS functions, GPU work). Diagnoses streaming hitches.
//
//   node tools/trace-flight.mjs [--prod] [--speed 30] [--seconds 8] [--min 12]
import { ensureServer, launch, openApp } from './lib/browser.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
const speed = Number(opt.speed ?? 30), seconds = Number(opt.seconds ?? 8), min = Number(opt.min ?? 12);
const q = new URLSearchParams({ autostart: '1', nointro: '1', bot: '1', bench: '1', spawn: '-600,12,300,0' });

await ensureServer();
const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await openApp(page, '/?' + q);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,v8.gc,disabled-by-default-devtools.timeline,gpu,blink.user_timing', transferMode: 'ReportEvents' });
  await page.evaluate(({ speed, seconds }) => new Promise((res) => {
    const g = window.__mc.game;
    g.player.godMode = true; g.player.godInvisible = true; g.player.noclip = true; g.player.pitch = -0.08;
    const t0 = performance.now();
    const f = (t) => {
      const k = (t - t0) / 1000;
      const x = -600 + k * speed * Math.cos(0.3), z = 300 - k * speed * Math.sin(0.3);
      g.player.yaw = -Math.PI / 2 - 0.3;
      g.player.pos.set(x, g.world.terrain.heightAt(x, z) + 12, z);
      performance.mark('frame');
      if (k < seconds) requestAnimationFrame(f); else res();
    };
    requestAnimationFrame(f);
  }), { speed, seconds });
  await cdp.send('Tracing.end');
  await done;
  // main thread = the thread with the most FunctionCall events
  const counts = new Map();
  for (const e of events) if (e.name === 'FunctionCall' || e.name === 'FireAnimationFrame') counts.set(`${e.pid}:${e.tid}`, (counts.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const onMain = events.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X' && e.dur);
  const tasks = onMain.filter((e) => e.name === 'RunTask' && e.dur / 1000 > min).sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const t of tasks) {
    const inner = onMain.filter((e) => e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && e !== t);
    const agg = new Map();
    for (const e of inner) {
      if (!/GC|Scavenge|MarkCompact|FunctionCall|FireAnimationFrame|Paint|Commit|Layout|Compile|ParseHTML|EvaluateScript|GPUTask|CpuProfiler|v8\.compile|V8\.GC|Minor|Major/i.test(e.name)) continue;
      agg.set(e.name, (agg.get(e.name) ?? 0) + e.dur / 1000);
    }
    out.push({ ms: +(t.dur / 1000).toFixed(1), parts: Object.fromEntries([...agg.entries()].filter(([, v]) => v > 0.5).map(([k, v]) => [k, +v.toFixed(1)])) });
  }
  // GPU process long tasks
  const gpu = events.filter((e) => e.ph === 'X' && e.dur / 1000 > min && /GPUTask|CommandBuffer|Swap|Gpu/i.test(e.name)).map((e) => ({ name: e.name, ms: +(e.dur / 1000).toFixed(1) }));
  console.log(JSON.stringify({ longTasks: out.length, tasks: out.slice(0, 40), gpu: gpu.slice(0, 20) }, null, 1));
} finally {
  await browser.close();
}
