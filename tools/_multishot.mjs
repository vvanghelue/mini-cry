// scratch: several bench views in one browser session
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer, launch, openApp, frames } from './lib/browser.js';
import { ROOT } from './lib/data.js';
const prefix = process.argv[2] ?? 'base';
const only = process.argv[3]?.split(',');
const views = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/bench.json'))).views.filter((v) => !only || only.includes(v.name));
await ensureServer();
const { browser, page, logs } = await launch({ width: 1280, height: 800 });
const v0 = views[0];
await openApp(page, `/?mode=view&nohud=1&cam=${v0.cam}&tod=${v0.tod}`);
for (const v of views) {
  await page.evaluate((v) => window.__mc.setView({ cam: v.cam, tod: v.tod }), v);
  await frames(page, 25);
  const out = path.join(ROOT, `shots/${prefix}_${v.name}.png`);
  await page.screenshot({ path: out });
  console.log(out);
}
console.log(logs.filter((l) => /error/i.test(l)).slice(0, 10).join('\n'));
await browser.close();
