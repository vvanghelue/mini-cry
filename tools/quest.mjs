#!/usr/bin/env node
// Drive the game in a Meta Quest's browser from this machine (USB, developer mode, adb): open it,
// enter VR, measure, profile, look at the headset's screen. The Quest browser is reached through
// Chrome DevTools (adb forward), the dev server through adb reverse (localhost is a secure context:
// WebXR works).
//
//   npm run quest -- setup                     adb forward / reverse, keep the headset awake (no wearer)
//   npm run quest -- open [path]               open the game in the Quest browser, wait for loading
//   npm run quest -- enter                     enter VR (as a user gesture), start / resume the game
//   npm run quest -- fps [label=js[|undo] ...] frame rate, GPU ms (VrApi App=), CPU&GPU ms, JS ms
//   npm run quest -- breakdown [sys,...]       GPU ms of each system: toggled on / off five times
//   npm run quest -- calls                     draws per scene group and pass, WebGL calls per frame
//   npm run quest -- profile [s]               JS profile: self and inclusive time per frame
//   npm run quest -- trace [s]                 Chrome trace: busy ms per frame of each thread
//   npm run quest -- shot [out.png]            screenshot of the headset (both eyes)
//   npm run quest -- eval "<js>"               run JS in the game page (app = window.__mc)
//   npm run quest -- release                   give the proximity sensor back
//
// Numbers vary with where the headset looks (lying on a desk: wherever it points): compare states
// interleaved (breakdown), not runs minutes apart. `fps` turns: "east=__mc.game.vr.turn(Math.PI/2)".
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { ROOT } from './lib/data.js';

const PORT = 9333; // the Quest's DevTools socket, forwarded
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd = 'help', ...args] = process.argv.slice(2);

/** The visible game tab (hidden duplicates closed). */
async function gamePage() {
  const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages().filter((p) => /^http:\/\/localhost:519\d/.test(p.url()));
  let best = null;
  for (const p of pages) {
    const v = await p.evaluate(() => document.visibilityState).catch(() => 'gone');
    if (v === 'visible') best = p;
    else if (pages.length > 1) await p.close().catch(() => {});
  }
  if (!best && !pages[0]) throw new Error('no game tab in the Quest browser: npm run quest -- open');
  return { browser, page: best ?? pages[0] };
}

/** Evaluate as a user gesture (WebXR sessions need one). */
async function gesture(page, expression) {
  const cdp = await page.context().newCDPSession(page);
  const r = await cdp.send('Runtime.evaluate', { expression, userGesture: true, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}

/** Mean of the last `n` VrApi lines of the browser: fps, App (GPU ms), CPU&GPU ms. */
function vrapi(n = 3) {
  const pid = sh('adb shell pidof com.oculus.browser').split(/\s+/)[0];
  const lines = sh(`adb logcat -d -s VrApi --pid=${pid}`).split('\n').filter((l) => l.includes('FPS=')).slice(-n);
  const avg = (re) => { const v = lines.map((l) => Number((re.exec(l) ?? [])[1])).filter((x) => !isNaN(x)); return +(v.reduce((s, x) => s + x, 0) / Math.max(1, v.length)).toFixed(1); };
  return { fps: avg(/FPS=(\d+)/), gpu: avg(/App=([\d.]+)ms/), cpugpu: avg(/CPU&GPU=([\d.]+)ms/) };
}

const SYSTEMS = {
  vegetation: (on) => `__mc.world.vegetation.group.visible = ${on}`,
  veg_lod0: (on) => `__mc.world.vegetation.setLodVisible('lod0', ${on})`,
  veg_lod1: (on) => `__mc.world.vegetation.setLodVisible('lod1', ${on})`,
  veg_lod2: (on) => `__mc.world.vegetation.setLodVisible('lod2', ${on})`,
  veg_impostor: (on) => `__mc.world.vegetation.setLodVisible('impostor', ${on})`,
  terrain: (on) => `__mc.world.terrainRenderer.group.visible = ${on}`,
  water: (on) => `__mc.world.water.group.visible = ${on}`,
  grass: (on) => `__mc.world.grass.group.visible = ${on}`,
  props: (on) => `__mc.world.entities.props.group.visible = ${on}`,
  shadows: (on) => `__mc.engine.lighting.sun.setEnabled(${on})`,
  gi: (on) => `__mc.engine.lighting.gi.setEnabled(${on})`,
  haze: (on) => `__mc.engine.lighting.haze.setEnabled(${on})`,
  foveation: (on) => `__mc.engine.renderer.xr.setFoveation(${on ? 0 : 1})`,
};

const commands = {
  async setup() {
    sh(`adb forward tcp:${PORT} localabstract:chrome_devtools_remote`);
    for (const p of [5190, 5191]) sh(`adb reverse tcp:${p} tcp:${p}`);
    sh('adb shell am broadcast -a com.oculus.vrpowermanager.prox_close');
    sh('adb shell input keyevent KEYCODE_WAKEUP');
    console.log(sh('adb devices -l'));
  },

  async release() { sh('adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable'); },

  async open(p = '/') {
    sh(`adb shell am start -a android.intent.action.VIEW -d "http://localhost:5190${p}" com.oculus.browser`);
    const t0 = Date.now();
    for (;;) {
      await sleep(5000);
      try {
        const { page } = await gamePage();
        if (await page.evaluate(() => window.__mc?.ready === true)) break;
      } catch { /* compiling: DevTools doesn't answer */ }
      if (Date.now() - t0 > 300000) throw new Error('not ready after 5 min');
    }
    const { page } = await gamePage();
    console.log(JSON.stringify({ s: Math.round((Date.now() - t0) / 1000), warmUp: await page.evaluate(() => __mc.world?.warmUpStats) }));
  },

  async enter() {
    const { page } = await gamePage();
    const r = await gesture(page, `(async () => {
      const g = __mc.game, e = __mc.engine;
      if (!g.vr.presenting) await g.vr.enter();
      await new Promise((r) => setTimeout(r, 3000));
      if (!g.started) g.newGame({ skipIntro: true }); else if (g.paused) g.resume();
      await new Promise((r) => setTimeout(r, 8000));
      const x = e.renderer.xr;
      return { presenting: x.isPresenting, eye: [x._glProjLayer?.textureWidth, x._glProjLayer?.textureHeight], multiview: x._useMultiview, xrWarmUp: g.vr.warmUpStats, rate: g.vr.session?.frameRate };
    })()`);
    console.log(JSON.stringify(r));
  },

  async fps(...states) {
    const { page } = await gamePage();
    for (const s of states.length ? states : ['now=0']) {
      const i = s.indexOf('='), label = s.slice(0, i), [js, undo] = s.slice(i + 1).split('|');
      await page.evaluate(js);
      await sleep(3500);
      const cpu = await page.evaluate(() => __mc.engine.perf.snapshot());
      console.log(label.padEnd(14), JSON.stringify({ ...vrapi(3), js: cpu.cpuMs, calls: cpu.calls }));
      if (undo) await page.evaluate(undo);
    }
  },

  async breakdown(list) {
    const { page } = await gamePage();
    const names = list ? list.split(',') : Object.keys(SYSTEMS);
    for (const k of names) {
      const f = SYSTEMS[k];
      if (!f) { console.log(k, '?'); continue; }
      const on = [], off = [];
      for (let i = 0; i < 5; i++) {
        await page.evaluate(f(i % 2 === 0));
        await sleep(2600);
        (i % 2 === 0 ? on : off).push(vrapi(2).gpu);
      }
      await page.evaluate(f(true));
      const m = (a) => a.reduce((s, x) => s + x, 0) / a.length;
      console.log(k.padEnd(14), JSON.stringify({ on: +m(on).toFixed(1), off: +m(off).toFixed(1), gpuMs: +(m(on) - m(off)).toFixed(1) }));
    }
  },

  async calls() {
    const { page } = await gamePage();
    console.log(JSON.stringify(await page.evaluate(async () => {
      const r = __mc.engine.renderer, b = r.backend, gl = b.gl, cat = new Map(), glc = new Map();
      const draw = b.draw.bind(b);
      b.draw = (ro, info) => {
        let top = ro.object; while (top.parent && top.parent.type !== 'Scene') top = top.parent;
        const rt = r.getRenderTarget(), k = `${rt && !rt.isXRRenderTarget ? 'offscreen' : 'main'} ${top.name || top.type}`;
        cat.set(k, (cat.get(k) ?? 0) + 1);
        return draw(ro, info);
      };
      const proto = Object.getPrototypeOf(gl), wrapped = [];
      for (const k of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, k);
        if (!d || typeof d.value !== 'function' || k === 'constructor') continue;
        const f = gl[k]; wrapped.push(k);
        gl[k] = function (...a) { glc.set(k, (glc.get(k) ?? 0) + 1); return f.apply(gl, a); };
      }
      const n0 = __mc.engine.frameCount;
      await new Promise((res) => setTimeout(res, 1000));
      const nf = __mc.engine.frameCount - n0;
      delete b.draw; for (const k of wrapped) delete gl[k];
      const per = (m) => [...m].sort((a, c) => c[1] - a[1]).map(([k, n]) => `${(n / nf).toFixed(1)} ${k}`);
      return { draws: per(cat), gl: per(glc).slice(0, 12) };
    }), null, 1));
  },

  async profile(secs = 4) {
    const { page } = await gamePage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    const f0 = await page.evaluate(() => __mc.engine.frameCount);
    await cdp.send('Profiler.start');
    await sleep(secs * 1000);
    const { profile } = await cdp.send('Profiler.stop');
    const nf = (await page.evaluate(() => __mc.engine.frameCount)) - f0;
    const byId = new Map(profile.nodes.map((n) => [n.id, n])), parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const name = (cf) => `${cf.functionName || '(anon)'} ${(cf.url.split('/').pop() || '(native)').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
    const self = new Map(), incl = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      const dt = profile.timeDeltas[i] ?? 0, id = profile.samples[i];
      const k = name(byId.get(id).callFrame);
      self.set(k, (self.get(k) ?? 0) + dt);
      const seen = new Set();
      for (let j = id; j !== undefined; j = parent.get(j)) {
        const kk = name(byId.get(j).callFrame);
        if (!seen.has(kk)) { seen.add(kk); incl.set(kk, (incl.get(kk) ?? 0) + dt); }
      }
    }
    const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => `${(us / 1000 / nf).toFixed(2).padStart(6)} ms/frame  ${k}`).join('\n');
    console.log(`frames ${nf}\n--- self\n${top(self, 25)}\n--- inclusive (src/)\n${top(new Map([...incl].filter(([k]) => /\.jsx?:\d+$/.test(k) && !/three|vite|\(native\)/.test(k))), 25)}`);
  },

  async trace(secs = 3) {
    const { browser, page } = await gamePage();
    const out = path.join(ROOT, 'shots/quest-trace.json');
    await browser.startTracing(page, { path: out, categories: ['toplevel', 'gpu', 'xr', 'v8', 'blink'] });
    const f0 = await page.evaluate(() => __mc.engine.frameCount);
    await sleep(secs * 1000);
    const nf = (await page.evaluate(() => __mc.engine.frameCount)) - f0;
    await browser.stopTracing();
    const ev = JSON.parse(fs.readFileSync(out, 'utf8')).traceEvents;
    const tn = new Map(), pn = new Map(), busy = new Map();
    for (const e of ev) if (e.ph === 'M') (e.name === 'thread_name' ? tn.set(`${e.pid}:${e.tid}`, e.args.name) : e.name === 'process_name' && pn.set(e.pid, e.args.name));
    for (const e of ev) if (e.ph === 'X' && e.dur && (e.cat === 'toplevel' || e.name === 'ThreadControllerImpl::RunTask')) busy.set(`${e.pid}:${e.tid}`, (busy.get(`${e.pid}:${e.tid}`) ?? 0) + e.dur);
    console.log(`frames ${nf} in ${secs} s (${out})`);
    for (const [k, us] of [...busy].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${(us / 1000 / nf).toFixed(2).padStart(7)} ms/frame  ${pn.get(Number(k.split(':')[0])) ?? ''} / ${tn.get(k) ?? k}`);
  },

  async shot(out = 'shots/quest.png') {
    const file = path.resolve(ROOT, out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await sharp(execSync('adb exec-out screencap -p', { maxBuffer: 64 * 1024 * 1024 })).resize({ width: 1600 }).toFile(file);
    console.log(file);
  },

  async eval(js) {
    const { page } = await gamePage();
    console.log(JSON.stringify(await page.evaluate(js), null, 1));
  },

  async help() { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); },
};

if (!commands[cmd]) { console.log(`unknown command ${cmd}`); await commands.help(); process.exit(1); }
await commands[cmd](...args);
process.exit(0);
