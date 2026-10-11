// sounds.json is hand-formatted (one line per layer, recipe settings packed on a few lines, blank
// lines between groups of sounds). The Audio panel saves it as text in the same layout: unchanged
// sounds / sections are copied verbatim from the file as it was loaded, edited ones are re-laid out
// in that compact style. Keeps diffs small and the file readable by hand.

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Compact one-line JSON: { "a": 1, "b": [1, 2] }. */
export function inline(v) {
  if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']';
  if (isObj(v)) {
    const e = Object.entries(v).filter(([, x]) => x !== undefined);
    return e.length ? '{ ' + e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ') + ' }' : '{}';
  }
  return JSON.stringify(v ?? null);
}

/**
 * Remember how the loaded file laid out each sound and each top-level section, so unchanged
 * parts can be written back byte for byte. Returns { sounds: Map, sections: Map, blank: Set }.
 */
export function scanLayout(text) {
  const out = { sounds: new Map(), sections: new Map(), blank: new Set() };
  if (typeof text !== 'string') return out;
  const lines = text.split('\n');
  const grab = (i, indent) => {
    // block starting at line i ("<indent>"key": {"), ends at "<indent>}" (with or without a comma)
    const close = new RegExp(`^ {${indent}}\\},?\\s*$`);
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*$/.test(lines[j])) continue;
      if (close.test(lines[j])) {
        const head = lines[i].slice(lines[i].indexOf('{'));
        const src = [head, ...lines.slice(i + 1, j), ' '.repeat(indent) + '}'].join('\n');
        try { return { src, key: JSON.stringify(JSON.parse(src)), end: j }; } catch { return null; }
      }
      if (new RegExp(`^ {0,${indent}}\\S`).test(lines[j])) return null; // dedent: not our layout
    }
    return null;
  };
  let inSounds = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let m = /^ {2}("(?:[^"\\]|\\.)*"): \{\s*$/.exec(L);
    if (m) {
      const k = JSON.parse(m[1]);
      if (k === 'sounds') { inSounds = true; continue; }
      inSounds = false;
      const b = grab(i, 2);
      if (b) { out.sections.set(k, b); i = b.end; }
      continue;
    }
    if (/^ {2}\S/.test(L)) { inSounds = false; continue; }
    if (!inSounds) continue;
    m = /^ {4}("(?:[^"\\]|\\.)*"): \{\s*$/.exec(L);
    if (m) {
      const k = JSON.parse(m[1]);
      if (i > 0 && /^\s*$/.test(lines[i - 1])) out.blank.add(k);
      const b = grab(i, 4);
      if (b) { out.sounds.set(k, b); i = b.end; }
    }
  }
  return out;
}

/** A recipe in the compact layout (settings packed on lines, one layer per line). */
export function formatRecipe(r, indent = 4) {
  if (!isObj(r)) return inline(r);
  const pad = ' '.repeat(indent + 2), pad2 = ' '.repeat(indent + 4);
  const lines = [];
  let cur = [];
  const flush = () => { if (cur.length) lines.push(cur.join(', ')); cur = []; };
  for (const [k, v] of Object.entries(r)) {
    if (k === 'layers' || v === undefined) continue;
    const s = `${JSON.stringify(k)}: ${inline(v)}`;
    const packable = !isObj(v) && !(Array.isArray(v) && v.some((x) => x && typeof x === 'object'));
    if (!packable) { flush(); lines.push(s); continue; }
    const len = cur.reduce((n, x) => n + x.length + 2, 0);
    if (cur.length && len + s.length > 100) flush();
    cur.push(s);
  }
  flush();
  if (r.layers !== undefined) {
    if (Array.isArray(r.layers) && r.layers.length) {
      lines.push('"layers": [\n' + r.layers.map((L) => pad2 + inline(L)).join(',\n') + '\n' + pad + ']');
    } else lines.push(`"layers": ${inline(r.layers)}`);
  }
  if (!lines.length) return '{}';
  return '{\n' + lines.map((l) => pad + l).join(',\n') + '\n' + ' '.repeat(indent) + '}';
}

/** A top-level section ("music", "ambient"...): one key per line, values inline. */
export function formatSection(v, indent = 2) {
  if (!isObj(v)) return inline(v);
  const e = Object.entries(v).filter(([, x]) => x !== undefined);
  if (!e.length) return '{}';
  const pad = ' '.repeat(indent + 2);
  return '{\n' + e.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${inline(x)}`).join(',\n') + '\n' + ' '.repeat(indent) + '}';
}

/** The whole sounds.json text. `layout` (from scanLayout) keeps unchanged parts verbatim. */
export function formatSoundsFile(doc, layout) {
  const out = ['{'];
  const top = Object.keys(doc).filter((k) => doc[k] !== undefined);
  top.forEach((k, ti) => {
    const last = ti === top.length - 1;
    const comma = last ? '' : ',';
    if (k === 'sounds' && isObj(doc.sounds)) {
      const names = Object.keys(doc.sounds);
      if (!names.length) out.push(`  "sounds": {}${comma}`);
      else {
        out.push('  "sounds": {');
        names.forEach((n, i) => {
          if (i > 0 && layout?.blank.has(n)) out.push('');
          const r = doc.sounds[n];
          const o = layout?.sounds.get(n);
          const body = o && o.key === JSON.stringify(r) ? o.src : formatRecipe(r, 4);
          out.push(`    ${JSON.stringify(n)}: ${body}${i < names.length - 1 ? ',' : ''}`);
        });
        out.push('  }' + comma);
      }
    } else {
      const o = layout?.sections.get(k);
      const body = o && o.key === JSON.stringify(doc[k]) ? o.src : formatSection(doc[k], 2);
      out.push(`  ${JSON.stringify(k)}: ${body}${comma}`);
    }
    if (!last) out.push('');
  });
  out.push('}');
  return out.join('\n') + '\n';
}
