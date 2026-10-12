// scratch: load the editor headless, report console errors
import { ensureServer, launch, openApp, frames } from './lib/browser.js';
await ensureServer();
const { browser, page, logs } = await launch({ width: 1280, height: 800 });
page.context().on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
await openApp(page, '/editor.html', { timeout: 300000 });
await frames(page, 2);
await page.screenshot({ path: 'shots/editor.png', timeout: 300000 });
console.log(logs.filter((l) => /error|warn/i.test(l) && !/GL Driver|parallel_shader/.test(l)).slice(0, 20).join('\n') || 'no errors');
await browser.close();
