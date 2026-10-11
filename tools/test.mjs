#!/usr/bin/env node
// Runs every tests/*.play scenario headless (production build) and reports pass / fail.
//   npm test [-- name-filter] [--dev]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/data.js';

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const files = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.play') && (!filter || f.includes(filter))).sort();
let failed = 0;
const prod = !process.argv.includes('--dev');
if (prod) spawnSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' });
for (const f of files) {
  const t0 = Date.now();
  // the first test builds; the others reuse the running preview (no --prod rebuild: pass the port)
  const r = spawnSync('node', ['tools/play.mjs', '--file', `tests/${f}`, ...(prod ? ['--prod', '--nobuild'] : [])], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let rep;
  try { rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{\n'))); } catch { rep = { fatal: (r.stderr || r.stdout).slice(-400) }; }
  const ok = rep.ok;
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✘'} ${f.padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)}s${rep.lateShaders ? `  (${rep.lateShaders} late shader compiles)` : ''}${ok ? '' : '\n    ' + JSON.stringify({ failed: rep.failed, errors: rep.errors?.slice(0, 3), fatal: rep.fatal }).slice(0, 600)}`);
}
console.log(`\n${files.length - failed}/${files.length} passed`);
process.exit(failed ? 1 : 0);
