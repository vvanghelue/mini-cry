#!/usr/bin/env node
// CPU profile of the running game (Chrome DevTools protocol), aggregated by function: shows
// where the frame's JS time goes. Use --prod to profile the minified build (names are kept by
// the default vite build only partially, so the dev server gives more readable output).
//
//   npm run profile -- [--spawn x,y,z,yaw] [--seconds 4] [--top 30] [--prod] [--combat] [--alert]
//                      [--size 1440x900] [--by file] [--callers fn,fn] [--load]
// --combat: enemies see the player; --alert also makes a gunshot noise so they fight.
// --size: a small window (e.g. 480x300) keeps the GPU from being the bottleneck. When the GPU is,
//   the JS waits in whichever WebGPU call fills the command buffer (a native call such as
//   writeBuffer or getCurrentTexture at the top of the list): that time is GPU backpressure, not JS work.
// --by file: self time per source file (three.js, native WebGPU calls, GC and each game file).
// --callers: the JS call chains of the given functions (e.g. native WebGPU calls), by time.
// --load: profile the loading (navigation until the game is ready) instead of frames.
import { ensureServer, launch, openApp } from './lib/browser.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
const seconds = Number(opt.seconds ?? 4), top = Number(opt.top ?? 30);
const [w, h] = (opt.size ?? '1440x900').split('x').map(Number);
const q = new URLSearchParams({ autostart: '1', nointro: '1', bot: '1', bench: '1' });
if (opt.spawn) q.set('spawn', opt.spawn);

await ensureServer();
const { browser, page } = await launch({ width: w, height: h });
try {
  const cdp = await page.context().newCDPSession(page);
  let profile, frames = 1, unit = 'ms/frame', wall = 0;
  if (opt.load) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
    const t0 = Date.now();
    await openApp(page, '/?' + q);
    wall = Date.now() - t0;
    ({ profile } = await cdp.send('Profiler.stop'));
    unit = 'ms';
  } else {
    await openApp(page, '/?' + q);
    await page.evaluate(({ combat, alert }) => {
      const g = window.__mc.game;
      g.player.godMode = true;
      if (!combat && !alert) g.player.godInvisible = true;
      if (alert) g.ai.noise(g.player.pos, 300, 'gunshot');
    }, { combat: !!opt.combat, alert: !!opt.alert });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
    const frames0 = await page.evaluate(() => window.__mc.engine.frameCount);
    await page.evaluate((s) => new Promise((r) => setTimeout(r, s * 1000)), seconds);
    frames = (await page.evaluate(() => window.__mc.engine.frameCount)) - frames0;
    ({ profile } = await cdp.send('Profiler.stop'));
  }
  const snap = opt.load ? null : await page.evaluate(() => window.__mc.engine.perf.snapshot());
  // self time per node
  const dt = new Map();
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) dt.set(samples[i], (dt.get(samples[i]) ?? 0) + (timeDeltas[i] ?? 0));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const fileOf = (cf) => (cf.url.split('/').pop() ?? '').split('?')[0];
  const label = (n) => `${n.callFrame.functionName || '(anonymous)'}  ${fileOf(n.callFrame)}:${n.callFrame.lineNumber + 1}`;
  const byFn = new Map(), byFile = new Map();
  let total = 0;
  for (const n of profile.nodes) {
    const t = (dt.get(n.id) ?? 0) / 1000;
    if (!t) continue;
    const cf = n.callFrame;
    byFn.set(label(n), (byFn.get(label(n)) ?? 0) + t);
    if (['(idle)', '(program)', '(garbage collector)'].includes(cf.functionName)) {
      if (cf.functionName !== '(idle)') byFile.set(cf.functionName, (byFile.get(cf.functionName) ?? 0) + t);
      continue;
    }
    total += t;
    const f = fileOf(cf);
    const file = !cf.url ? 'native (WebGPU / DOM calls)' : f.startsWith('three.') ? 'three.js' : f;
    byFile.set(file, (byFile.get(file) ?? 0) + t);
  }
  const per = (t) => (t / frames).toFixed(3).padStart(8);
  if (opt.load) console.log(`load: ${wall} ms until ready, JS busy ${total.toFixed(0)} ms\n`);
  else console.log(`${frames} frames in ${seconds}s (${(frames / seconds).toFixed(0)} fps), JS busy ${(total / frames).toFixed(2)} ms/frame; engine: cpu ${snap.cpuMs} ms, gpu ${snap.gpuMs} ms, marks ${JSON.stringify(snap.marks)}\n`);
  if (opt.by === 'file') {
    console.log(`${unit.padStart(8)}  self%  file`);
    for (const [k, t] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${per(t)}  ${((t / total) * 100).toFixed(1).padStart(5)}  ${k}`);
    console.log('');
  }
  console.log(`${unit.padStart(8)}  self%  function`);
  for (const [k, t] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${per(t)}  ${((t / total) * 100).toFixed(1).padStart(5)}  ${k}`);
  for (const fn of typeof opt.callers === 'string' ? opt.callers.split(',') : []) {
    const chains = new Map();
    let sum = 0;
    for (const n of profile.nodes) {
      const t = (dt.get(n.id) ?? 0) / 1000;
      if (!t || n.callFrame.functionName !== fn) continue;
      sum += t;
      const chain = [];
      for (let p = parent.get(n.id), k = 0; p !== undefined && k < 6; p = parent.get(p), k++) chain.push(label(byId.get(p)).replace(/\s+/g, ' '));
      const key = chain.join(' < ');
      chains.set(key, (chains.get(key) ?? 0) + t);
    }
    console.log(`\n${fn}: ${per(sum).trim()} ${unit}, called from`);
    for (const [k, t] of [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`${per(t)}  ${k}`);
  }
} finally {
  await browser.close();
}
