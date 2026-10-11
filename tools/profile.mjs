#!/usr/bin/env node
// CPU profile of the running game (Chrome DevTools protocol), aggregated by function: shows
// where the frame's JS time goes. Use --prod to profile the minified build (names are kept by
// the default vite build only partially, so the dev server gives more readable output).
//
//   npm run profile -- [--spawn x,y,z,yaw] [--seconds 4] [--top 30] [--prod] [--combat]
import { ensureServer, launch, openApp } from './lib/browser.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
const seconds = Number(opt.seconds ?? 4), top = Number(opt.top ?? 30);
const q = new URLSearchParams({ autostart: '1', nointro: '1', bot: '1', bench: '1' });
if (opt.spawn) q.set('spawn', opt.spawn);

await ensureServer();
const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await openApp(page, '/?' + q);
  await page.evaluate((combat) => { const g = window.__mc.game; g.player.godMode = true; if (!combat) g.player.godInvisible = true; }, !!opt.combat);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const frames0 = await page.evaluate(() => window.__mc.engine.frameCount);
  await page.evaluate((s) => new Promise((r) => setTimeout(r, s * 1000)), seconds);
  const frames = (await page.evaluate(() => window.__mc.engine.frameCount)) - frames0;
  const { profile } = await cdp.send('Profiler.stop');
  // self time per node
  const dt = new Map();
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) dt.set(samples[i], (dt.get(samples[i]) ?? 0) + (timeDeltas[i] ?? 0));
  const byFn = new Map();
  let total = 0;
  for (const n of profile.nodes) {
    const t = (dt.get(n.id) ?? 0) / 1000;
    if (!t) continue;
    const cf = n.callFrame;
    const file = (cf.url.split('/').pop() ?? '').split('?')[0];
    const key = `${cf.functionName || '(anonymous)'}  ${file}:${cf.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) ?? 0) + t);
    if (!['(idle)', '(program)', '(garbage collector)'].includes(cf.functionName)) total += t;
  }
  const rows = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`${frames} frames in ${seconds}s (${(frames / seconds).toFixed(0)} fps), JS busy ${(total / frames).toFixed(2)} ms/frame\n`);
  console.log('ms/frame  self%  function');
  for (const [k, t] of rows) console.log(`${(t / frames).toFixed(3).padStart(8)}  ${((t / total) * 100).toFixed(1).padStart(5)}  ${k}`);
} finally {
  await browser.close();
}
