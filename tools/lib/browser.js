// Headless Chrome (real GPU through ANGLE/Metal, vsync off) driving the game or the editor.
// Used by tools/shot.mjs, tools/bench.mjs and `mc run`.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ROOT } from './data.js';

export const PORT = Number(process.env.MC_PORT ?? 5190);
export const PROD_PORT = 5191;
export let BASE = `http://localhost:${PORT}`;
const PROD = process.argv.includes('--prod');

export async function serverUp() {
  try {
    const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** --prod: build the game and serve dist/ with `vite preview` (no HMR reloads, minified code). */
async function ensurePreview() {
  const { execSync } = await import('node:child_process');
  if (!process.argv.includes('--nobuild')) execSync('npx vite build --logLevel error', { cwd: ROOT, stdio: 'inherit' });
  BASE = `http://localhost:${PROD_PORT}`;
  try { const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(1500) }); if (r.ok) return { started: false }; } catch { /* start it */ }
  const child = spawn('npx', ['vite', 'preview', '--port', String(PROD_PORT), '--strictPort'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(1000) }); if (r.ok) return { started: true }; } catch { /* wait */ }
  }
  throw new Error('could not start vite preview on ' + PROD_PORT);
}

/** Make sure the vite dev server runs (starts a detached one if needed). With --prod: a built preview. */
export async function ensureServer() {
  if (PROD) return ensurePreview();
  if (await serverUp()) return { started: false };
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serverUp()) return { started: true, pid: child.pid };
  }
  throw new Error('could not start the vite dev server on port ' + PORT);
}

export async function launch({ width = 1440, height = 900, dpr = 1, headless = true } = {}) {
  // macOS: Chrome on the real GPU (ANGLE / Metal). Elsewhere (Linux CI / cloud containers without
  // Chrome or a GPU): the bundled Chromium (MC_CHROMIUM overrides its path), WebGL through ANGLE
  // (SwiftShader when there is no GPU) — slow but pixel-correct, fine for shots and tests.
  const mac = process.platform === 'darwin';
  const exe = process.env.MC_CHROMIUM ?? (!mac && fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : { channel: 'chrome' }),
    headless,
    args: ['--enable-gpu', mac ? '--use-angle=metal' : '--use-angle=default', '--enable-unsafe-swiftshader', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`));
  page.__logs = logs;
  return { browser, page, logs };
}

/** Open a page and wait until window.__mc.ready (set by the game / editor boot). */
export async function openApp(page, path, { timeout = 90000 } = {}) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => window.__mc?.ready === true, null, { timeout, polling: 250 });
  } catch (e) {
    const errs = (page.__logs ?? []).filter((l) => /error|warn/i.test(l)).slice(-15).join('\n');
    throw new Error(`app not ready after ${timeout / 1000}s (${path})\n${errs}`);
  }
}

export async function frames(page, n = 60) {
  await page.evaluate((n) => new Promise((res) => {
    let k = 0;
    const f = () => (++k >= n ? res() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  }), n);
}
