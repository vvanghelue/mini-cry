#!/usr/bin/env node
// Screenshot the game (or editor) from a camera pose, headless on the real GPU, and print the
// perf counters. Lets an agent *look* at what it changed.
//
//   npm run shot -- --cam x,y,z,yaw,pitch [--tod 17.5] [--out shots/view.png] [--quality medium]
//                   [--page /] [--eval "js run before the shot"] [--frames 90] [--size 1440x900]
//                   [--query "extra=url&params"]
//   npm run shot -- --at <entityId|x,z>      look at an entity / a ground position from 25 m away
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer, launch, openApp, frames } from './lib/browser.js';
import { ROOT } from './lib/data.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    opt[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
}
const [w, h] = (opt.size ?? '1440x900').split('x').map(Number);
const q = new URLSearchParams(opt.query ?? '');
q.set('mode', opt.mode ?? 'view');
if (opt.cam) q.set('cam', opt.cam);
if (opt.at) q.set('at', opt.at);
if (opt.tod) q.set('tod', opt.tod);
if (opt.quality) q.set('quality', opt.quality);
q.set('nohud', opt.hud ? '0' : '1');
const page0 = opt.page ?? '/';
const out = path.resolve(ROOT, opt.out ?? 'shots/shot.png');
fs.mkdirSync(path.dirname(out), { recursive: true });

await ensureServer();
const { browser, page, logs } = await launch({ width: w, height: h });
try {
  await openApp(page, `${page0}?${q}`);
  if (opt.eval) await page.evaluate(opt.eval);
  await frames(page, Number(opt.frames ?? 90));
  const perf = await page.evaluate(() => window.__mc.engine.perf.snapshot());
  await page.screenshot({ path: out });
  const errors = logs.filter((l) => /error/i.test(l));
  console.log(JSON.stringify({ file: out, perf, errors: errors.slice(0, 10) }, null, 2));
} finally {
  await browser.close();
}
