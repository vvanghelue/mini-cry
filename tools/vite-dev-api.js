// Dev-server API used by the editor and by the agent tools (tools/*.mjs).
//
//   GET  /api/ping                     -> { ok, clients }
//   GET  /api/list?dir=assets          -> [relative paths] under public/data (recursive)
//   GET  /api/read?path=world.json     -> raw file
//   POST /api/write?path=world.json    -> writes the raw body (a backup of the old file is kept)
//   POST /api/delete?path=assets/x.json
//   POST /api/voice/generate {dialogues?, speaker?, force?} -> records dialogue voices (tools/lib/voice.js)
//   POST /api/voice/say {speaker, text, spoken?, voice?} -> audio bytes (audition, nothing saved)
//
// Live channel: a running game / editor tab connects to /api/live/events (SSE) and executes the
// commands an agent posts to /api/live/cmd ({ target: 'editor' | 'game' | 'any', cmd, args }).
// The tab answers on /api/live/result and the HTTP call returns that answer. This is how the
// CLI drives a running editor (select, move, eval, screenshot...) without a browser automation.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'public', 'data');
const BACKUP = path.resolve(import.meta.dirname, '..', '.mc-backup'); // outside public/: never shipped
const MAX_BACKUPS = 200;

function safePath(rel) {
  const p = path.resolve(ROOT, rel || '');
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error('path outside public/data');
  return p;
}

function listDir(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(BACKUP, stamp + '__' + path.relative(ROOT, file).split(path.sep).join('__'));
  fs.mkdirSync(BACKUP, { recursive: true });
  fs.copyFileSync(file, dst);
  const all = fs.readdirSync(BACKUP).sort();
  for (const f of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) fs.rmSync(path.join(BACKUP, f));
}

const send = (res, code, body, type = 'application/json') => {
  res.statusCode = code;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

export function devApi() {
  const clients = new Map(); // id -> { res, kind }
  const pending = new Map(); // cmd id -> { resolve, timer }
  let nextId = 1;

  return {
    name: 'mini-cry-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith('/api/')) return next();
        const url = new URL(req.url, 'http://x');
        const q = Object.fromEntries(url.searchParams);
        try {
          switch (url.pathname) {
            case '/api/ping':
              return send(res, 200, { ok: true, clients: [...clients.values()].map((c) => c.kind) });
            case '/api/list':
              return send(res, 200, listDir(safePath(q.dir)));
            case '/api/read': {
              const f = safePath(q.path);
              if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
              return send(res, 200, fs.readFileSync(f), 'application/octet-stream');
            }
            case '/api/write': {
              if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
              const f = safePath(q.path);
              const body = await readBody(req);
              fs.mkdirSync(path.dirname(f), { recursive: true });
              backup(f);
              fs.writeFileSync(f, body);
              server.ws.send({ type: 'custom', event: 'mc:data-changed', data: { path: q.path } });
              return send(res, 200, { ok: true, bytes: body.length });
            }
            case '/api/delete': {
              const f = safePath(q.path);
              backup(f);
              if (fs.existsSync(f)) fs.rmSync(f);
              return send(res, 200, { ok: true });
            }
            case '/api/live/events': {
              const id = nextId++;
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
              res.write(`event: hello\ndata: ${JSON.stringify({ id })}\n\n`);
              clients.set(id, { res, kind: q.kind || 'unknown' });
              const ping = setInterval(() => res.write(': ping\n\n'), 15000);
              req.on('close', () => { clearInterval(ping); clients.delete(id); });
              return;
            }
            case '/api/live/cmd': {
              const body = JSON.parse((await readBody(req)).toString() || '{}');
              const target = body.target || 'any';
              const list = [...clients.entries()].filter(([, c]) => target === 'any' || c.kind === target);
              if (!list.length) return send(res, 503, { error: `no live ${target} client connected (open the game or editor in a browser)` });
              const [, client] = list[list.length - 1]; // most recent tab
              const id = nextId++;
              const result = await new Promise((resolve) => {
                const timer = setTimeout(() => { pending.delete(id); resolve({ error: 'timeout' }); }, body.timeout || 20000);
                pending.set(id, { resolve, timer });
                client.res.write(`event: cmd\ndata: ${JSON.stringify({ id, cmd: body.cmd, args: body.args ?? {} })}\n\n`);
              });
              return send(res, result.error ? 500 : 200, result);
            }
            case '/api/voice/generate': {
              const body = JSON.parse((await readBody(req)).toString() || '{}');
              const { generateVoices } = await import('./lib/voice.js');
              const report = await generateVoices({ dialogues: body.dialogues, speaker: body.speaker, force: !!body.force });
              server.ws.send({ type: 'custom', event: 'mc:data-changed', data: { path: 'voice/manifest.json' } });
              return send(res, report.failed.length ? 207 : 200, report);
            }
            case '/api/voice/say': {
              const body = JSON.parse((await readBody(req)).toString() || '{}');
              const { synthesize, loadDialogue } = await import('./lib/voice.js');
              const { voiceRequest } = await import('../src/game/missions/voice.js');
              const doc = loadDialogue();
              const sp = { ...(doc.speakers?.[body.speaker] ?? {}), tts: { ...doc.speakers?.[body.speaker]?.tts, ...(body.voice ? { voice: body.voice } : {}) } };
              const r = voiceRequest({ ...doc, speakers: { ...doc.speakers, [body.speaker]: sp } }, { speaker: body.speaker, text: body.text, spoken: body.spoken });
              if (!r) return send(res, 400, { error: 'no voice for this speaker' });
              const out = await synthesize(r);
              return send(res, 200, out.bytes, out.ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
            }
            case '/api/live/result': {
              const body = JSON.parse((await readBody(req)).toString() || '{}');
              const p = pending.get(body.id);
              if (p) { clearTimeout(p.timer); pending.delete(body.id); p.resolve(body); }
              return send(res, 200, { ok: true });
            }
          }
          return send(res, 404, { error: 'unknown endpoint' });
        } catch (err) {
          return send(res, 500, { error: String(err.message || err) });
        }
      });
    },
  };
}
