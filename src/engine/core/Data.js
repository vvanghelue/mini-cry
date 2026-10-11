// Game data access (public/data/*). Reads go through plain fetch (works in the built game too);
// writes go through the dev server API (editor / live tools, dev only).
const BASE = (import.meta.env?.BASE_URL ?? '/') + 'data/';
const cache = new Map();

async function get(path, kind, { fresh = false } = {}) {
  const key = kind + ':' + path;
  if (!fresh && cache.has(key)) return cache.get(key);
  const p = fetch(BASE + path + (fresh || import.meta.env?.DEV ? `?t=${Date.now()}` : ''), { cache: 'no-store' }).then(async (r) => {
    if (!r.ok) throw new Error(`data ${path}: HTTP ${r.status}`);
    return kind === 'json' ? r.json() : new Uint8Array(await r.arrayBuffer());
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

export const Data = {
  base: BASE,
  json: (path, opts) => get(path, 'json', opts),
  bin: (path, opts) => get(path, 'bin', opts),
  async jsonOr(path, fallback) {
    try { return await get(path, 'json'); } catch { return fallback; }
  },
  invalidate(path) {
    for (const k of [...cache.keys()]) if (!path || k.endsWith(':' + path)) cache.delete(k);
  },
  get canSave() { return !!import.meta.env?.DEV; },
  async list(dir) {
    const r = await fetch(`/api/list?dir=${encodeURIComponent(dir)}`);
    if (!r.ok) throw new Error('list failed');
    return r.json();
  },
  /** content: object (saved as pretty JSON), string or Uint8Array */
  async save(path, content) {
    const body = content instanceof Uint8Array || typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
    const r = await fetch(`/api/write?path=${encodeURIComponent(path)}`, { method: 'POST', body });
    if (!r.ok) throw new Error(`save ${path} failed: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
    this.invalidate(path);
    return r.json();
  },
};
