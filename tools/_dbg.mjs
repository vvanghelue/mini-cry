// scratch: one view, small, long timeouts (SwiftShader)
import { ensureServer, launch, openApp, frames } from './lib/browser.js';
await ensureServer();
const [W, H] = (process.env.SIZE ?? '960x600').split('x').map(Number);
const { browser, page, logs } = await launch({ width: W, height: H });
const t0 = Date.now();
await openApp(page, `/?mode=view&nohud=1&${process.argv[2]}`, { timeout: 300000 });
console.log('ready', Date.now() - t0);
await frames(page, Number(process.env.FRAMES ?? 3));
console.log(JSON.stringify(await page.evaluate(() => window.__mc.engine.perf.snapshot())));
await page.screenshot({ path: process.argv[3] ?? 'shots/dbg.png', timeout: 300000 });
console.log(logs.filter((l) => /error/i.test(l)).slice(0, 20).join('\n'));
await browser.close();
