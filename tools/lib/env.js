// Secrets for the Node tools: <project>/.env (KEY=value lines, gitignored, never shipped) is merged
// into process.env without overriding variables already set in the shell.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './data.js';

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function requireEnv(name) {
  loadEnv();
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: add a line ${name}=... to ${path.join(ROOT, '.env')} (gitignored)`);
  return v;
}
