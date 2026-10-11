#!/usr/bin/env node
// mc — Mini Cry command line for agents (and humans). Edits the game data under public/data
// directly (no browser needed), or talks to a running game / editor through the dev server.
//
//   npm run mc -- help
//
// Every command prints JSON or short text, so an AI agent can chain them.
import fs from 'node:fs';
import path from 'node:path';
import { commands } from './lib/commands.js';

function parseArgs(argv) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opts[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

const { pos, opts } = parseArgs(process.argv.slice(2));
const name = pos.slice(0, 2).join(' ');
let cmd = commands[name] ? name : commands[pos[0]] ? pos[0] : null;
const rest = cmd ? pos.slice(cmd.split(' ').length) : pos;

if (!cmd || opts.help && !rest.length) {
  if (cmd && commands[cmd]) { console.log(`mc ${cmd} ${commands[cmd].usage ?? ''}\n  ${commands[cmd].help}`); process.exit(0); }
  console.log('mc — Mini Cry agent CLI\n');
  const groups = {};
  for (const [k, c] of Object.entries(commands)) (groups[k.split(' ')[0]] ??= []).push([k, c]);
  for (const [g, list] of Object.entries(groups)) {
    console.log(`[${g}]`);
    for (const [k, c] of list) console.log(`  mc ${k} ${c.usage ?? ''}\n      ${c.help}`);
  }
  process.exit(cmd ? 0 : pos.length ? 1 : 0);
}

try {
  const out = await commands[cmd].run(rest, opts);
  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
} catch (err) {
  console.error('error:', err.message);
  if (opts.debug) console.error(err.stack);
  process.exit(1);
}
void fs; void path;
