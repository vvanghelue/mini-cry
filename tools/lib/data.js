// File access to the game data (public/data) for the Node tools. Writes keep a backup like the
// dev API does, so an agent can always roll back (.mc-backup/ at the project root).
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DATA = path.join(ROOT, 'public', 'data');

export const dataPath = (rel) => {
  const p = path.resolve(DATA, rel);
  if (!p.startsWith(DATA)) throw new Error('outside public/data: ' + rel);
  return p;
};
export const exists = (rel) => fs.existsSync(dataPath(rel));
export const readJSON = (rel, fallback) => {
  const p = dataPath(rel);
  if (!fs.existsSync(p)) { if (fallback !== undefined) return fallback; throw new Error('missing ' + rel); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};
export const readBin = (rel) => new Uint8Array(fs.readFileSync(dataPath(rel)));

function backup(p) {
  if (!fs.existsSync(p)) return;
  const dir = path.join(ROOT, '.mc-backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, path.join(dir, stamp + '__' + path.relative(DATA, p).split(path.sep).join('__')));
  const all = fs.readdirSync(dir).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 200))) fs.rmSync(path.join(dir, f));
}
export function writeJSON(rel, obj, stringify = (o) => JSON.stringify(o, null, 2) + '\n') {
  const p = dataPath(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  backup(p);
  fs.writeFileSync(p, stringify(obj));
}
export function writeBin(rel, bytes) {
  const p = dataPath(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  backup(p);
  fs.writeFileSync(p, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}
export function listData(dir = '') {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else out.push(path.relative(DATA, full).split(path.sep).join('/'));
    }
  };
  walk(dataPath(dir));
  return out.sort();
}
