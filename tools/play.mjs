#!/usr/bin/env node
// Headless play test: boots the game on the real GPU and runs a scripted list of steps (keys,
// clicks, looking around, live commands, JS, screenshots), then prints a JSON report (state
// snapshots, perf, console errors). Lets an agent check gameplay changes without a human.
//
//   npm run play -- --spawn x,y,z,yaw --steps "wait 2; key KeyW 1.5; look 0.5 -0.1; click 0.6; shot fight; state"
//   npm run play -- --file tests/scenario.txt [--size 1280x720] [--query "tod=21"]
//
// Steps (separated by ';' or new lines):
//   wait <s>                 let the game run
//   key <Code> <s>           hold a key (KeyW, ShiftLeft, Space, KeyE, KeyR, Digit3...)
//   press <Code>             tap a key
//   click [s] / rclick [s]   hold the left / right mouse button (fire / aim)
//   adsfire <s>              aim down sights and hold fire
//   aimbot on|off            keep the view on the nearest living enemy's chest (tests)
//   look <yaw> <pitch>       set the view (radians; yaw 0 = north / -z)
//   turn <dyaw> [dpitch]     rotate the view relatively
//   live <command> [json]    run a live command (state, teleport, give, god, spawn, setTime, killAll, startMission...)
//   eval <js>                run JS in the page (window.__mc = app, app.game = the game)
//   shot <name>              screenshot -> shots/play_<name>.png
//   state                    record the game state
//   expect <js>              assertion: the expression must be truthy (report.ok = false otherwise)
// A scenario file may start with "# spawn: x,y,z,yaw" / "# query: k=v&..." header lines.
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer, launch, openApp } from './lib/browser.js';
import { ROOT } from './lib/data.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
const src = opt.file ? fs.readFileSync(path.resolve(ROOT, opt.file), 'utf8') : (opt.steps ?? 'wait 2; state; shot start');
// steps split on new lines, or on ';' followed by a step keyword (JS in eval may contain ';')
for (const m of src.matchAll(/^#\s*(spawn|query|mission):\s*(.+)$/gm)) opt[m[1]] ??= m[2].trim();
const steps = src.split(/\n|;\s*(?=(?:wait|key|press|click|rclick|adsfire|aimbot|look|turn|live|eval|expect|shot|state)\b)/).map((s) => s?.trim()).filter((s) => s && !s.startsWith('#'));
const [w, h] = (opt.size ?? '1280x720').split('x').map(Number);
const q = new URLSearchParams(opt.query && opt.query !== true ? opt.query : '');
q.set('autostart', '1'); q.set('nointro', '1'); q.set('bot', '1');
if (opt.spawn) q.set('spawn', opt.spawn);
if (opt.mission) q.set('mission', opt.mission);

await ensureServer();
const { browser, page, logs } = await launch({ width: w, height: h });
const report = { steps: [], errors: [] };
const runFor = (sec) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), sec * 1000);
try {
  await openApp(page, '/?' + q);
  await page.evaluate(() => new Promise((r) => { const t0 = performance.now(); const f = () => (window.__mc.game?.started && performance.now() - t0 > 300 ? r() : requestAnimationFrame(f)); f(); }));
  for (const step of steps) {
    const [cmd, ...rest] = step.split(/\s+/);
    const arg = rest.join(' ');
    const entry = { step };
    switch (cmd) {
      case 'wait': await runFor(Number(rest[0] ?? 1)); break;
      case 'key': await page.keyboard.down(rest[0]); await runFor(Number(rest[1] ?? 0.5)); await page.keyboard.up(rest[0]); break;
      case 'press': await page.keyboard.press(rest[0]); await runFor(0.1); break;
      case 'click': case 'rclick': {
        const button = cmd === 'click' ? 'left' : 'right';
        await page.mouse.move(w / 2, h / 2);
        await page.mouse.down({ button }); await runFor(Number(rest[0] ?? 0.15)); await page.mouse.up({ button });
        break;
      }
      case 'adsfire': {
        await page.mouse.move(w / 2, h / 2);
        await page.mouse.down({ button: 'right' }); await runFor(0.3);
        await page.mouse.down({ button: 'left' }); await runFor(Number(rest[0] ?? 0.5));
        await page.mouse.up({ button: 'left' }); await page.mouse.up({ button: 'right' });
        break;
      }
      case 'aimbot': await page.evaluate((on) => {
        const g = window.__mc.game;
        clearInterval(window.__aimbot);
        if (!on) return;
        window.__aimbot = setInterval(() => {
          const e = g.player.eye;
          let best = null, bd = 1e9;
          for (const a of g.actors.list) { if (!a.alive || a.team !== 'merc') continue; const d = a.pos.distanceTo(g.player.pos); if (d < bd) { bd = d; best = a; } }
          if (!best) return;
          const c = best.chest(new window.__mc.THREE.Vector3());
          g.player.yaw = Math.atan2(-(c.x - e.x), -(c.z - e.z));
          g.player.pitch = Math.atan2(c.y - e.y, Math.hypot(c.x - e.x, c.z - e.z)) - g.player.recoilPitch;
        }, 16);
      }, rest[0] !== 'off'); break;
      case 'look': await page.evaluate(([y, p]) => { const g = window.__mc.game; g.player.yaw = y; g.player.pitch = p ?? 0; }, [Number(rest[0]), Number(rest[1] ?? 0)]); break;
      case 'turn': await page.evaluate(([y, p]) => { const g = window.__mc.game; g.player.yaw += y; g.player.pitch += p ?? 0; }, [Number(rest[0]), Number(rest[1] ?? 0)]); break;
      case 'live': {
        const name = rest[0];
        const a = rest.slice(1).join(' ');
        entry.result = await page.evaluate(async ([n, j]) => { const f = window.__mc.live.commands[n]; if (!f) return { error: 'unknown live command ' + n }; return JSON.parse(JSON.stringify(await f(j ? JSON.parse(j) : {}) ?? null)); }, [name, a]);
        break;
      }
      case 'expect': {
        const r = await page.evaluate(async (code) => { const app = window.__mc; try { return !!(await (new Function('app', 'game', `return (async () => (${code}))()`))(app, app.game)); } catch (e) { return 'error: ' + e.message; } }, arg);
        entry.result = r;
        if (r !== true) (report.failed ??= []).push(step);
        break;
      }
      case 'eval': entry.result = await page.evaluate(async (code) => { const app = window.__mc; const r = await (new Function('app', 'game', `return (async () => (${code}))()`))(app, app.game); return JSON.parse(JSON.stringify(r ?? null)); }, arg); break;
      case 'shot': { const file = path.resolve(ROOT, `shots/play_${rest[0] ?? report.steps.length}.png`); fs.mkdirSync(path.dirname(file), { recursive: true }); await page.screenshot({ path: file, timeout: 300000 }); entry.file = file; break; }
      case 'state': entry.result = await page.evaluate(() => window.__mc.live.commands.state()); break;
      default: entry.error = 'unknown step';
    }
    report.steps.push(entry);
  }
  report.final = await page.evaluate(() => window.__mc.live.commands.state());
  // render pipelines created after the loading warm-up (each one is a frame hitch in game)
  report.lateShaders = await page.evaluate(() => { const w = window.__mc.world; return w?.warmUpStats ? window.__mc.engine.pipelineCount() - w.warmUpStats.total : null; });
  if (report.lateShaders) report.latePipelines = await page.evaluate(() => window.__mc.world.latePipelines?.()); // their material names
} catch (e) {
  report.fatal = String(e.message ?? e);
} finally {
  report.errors = logs.filter((l) => /error/i.test(l) && !/404|Failed to load resource/.test(l)).slice(0, 20);
  report.ok = !report.fatal && !report.failed?.length && !report.errors.length;
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
