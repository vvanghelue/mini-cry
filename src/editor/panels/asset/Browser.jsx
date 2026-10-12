// Left column: asset browser (search, category filter, thumbnails, triangle counts) and the
// New (templates) / Duplicate / Delete buttons.
import { useEffect, useRef, useState } from 'preact/hooks';
import { S } from '../../core.js';
import { A } from './session.js';
import { CATEGORIES, CATEGORY_LABEL, TEMPLATES } from './shapes.js';

const infoCache = new Map(); // `${name}@${version}` -> { url, tris }

function useAssetInfo(ses, name, ver) {
  const key = `${name}@${ver}`;
  const [info, setInfo] = useState(() => infoCache.get(key) ?? infoCache.get(`${name}@${ver - 1}`));
  useEffect(() => {
    const c = infoCache.get(key);
    if (c) { setInfo(c); return; }
    let alive = true;
    ses.ed.thumbnail(name).then((url) => {
      let tris = null;
      try { tris = ses.lib.has(name) ? ses.lib.build(name, { quality: 1 }).triangles : null; } catch { /* invalid */ }
      const v = { url, tris };
      infoCache.set(key, v);
      if (alive) setInfo(v);
    });
    return () => { alive = false; };
  }, [key]);
  return info;
}

function AssetRow({ ses, name, sel }) {
  const def = ses.lib.get(name) ?? {};
  const info = useAssetInfo(ses, name, A.thumbs.value[name] ?? 0);
  const ref = useRef(null);
  useEffect(() => { if (sel) ref.current?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const dirty = ses.isDirty(name);
  return (
    <div ref={ref} class={'ap-item' + (sel ? ' sel' : '')} title={`${name}${def.tags?.length ? '\nTags: ' + def.tags.join(', ') : ''}`} onClick={() => ses.open(name)}>
      {info?.url ? <img src={info.url} alt="" /> : <div class="ap-thumb">…</div>}
      <div class="ap-meta">
        <b>{def.label ?? name}{dirty && <span class="ap-dot" title="Modified, unsaved"> ●</span>}</b>
        <small>{name}</small>
        <small>{CATEGORY_LABEL[def.category ?? 'prop'] ?? def.category}{def.generator ? ' · gen.' : ''} · {info?.tris ?? '…'} tri</small>
      </div>
    </div>
  );
}

export function Browser({ ses }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [menu, setMenu] = useState(false);
  void A.lib.value; void S.dirty.value; // re-render on list / dirty changes
  const lib = ses.lib;
  const names = ses.names;
  const counts = {};
  for (const n of names) { const c = lib.get(n)?.category ?? 'prop'; counts[c] = (counts[c] ?? 0) + 1; }
  const ql = q.trim().toLowerCase();
  const list = names.filter((n) => {
    const d = lib.get(n) ?? {};
    if (cat && (d.category ?? 'prop') !== cat) return false;
    return !ql || `${n} ${d.label ?? ''} ${(d.tags ?? []).join(' ')} ${d.generator?.type ?? ''}`.toLowerCase().includes(ql);
  });
  const cur = A.name.value;
  return (
    <div class="ap-left">
      <div class="ap-btns">
        <span class="ap-menu-wrap">
          <button class={menu ? 'on' : ''} onClick={() => setMenu(!menu)} title="Create an asset from a template">＋ New ▾</button>
          {menu && (
            <div class="ap-menu" onMouseLeave={() => setMenu(false)}>
              {TEMPLATES.map((t) => <button title={t.help} onClick={() => { setMenu(false); ses.create(t.id); }}>{t.label}<small>{t.help}</small></button>)}
            </div>
          )}
        </span>
        <button disabled={!cur} onClick={() => ses.duplicate()} title="Copy the asset under a new name">Duplicate</button>
        <button class="danger" disabled={!cur} onClick={() => ses.remove()} title="Delete the asset file">Delete</button>
      </div>
      <input class="ap-search" type="text" placeholder="Search (name, label, tag)…" value={q} onInput={(e) => setQ(e.target.value)} />
      <select class="ap-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
        <option value="">All categories ({names.length})</option>
        {CATEGORIES.filter((c) => counts[c.value] || c.value === cat).map((c) => <option value={c.value}>{c.label} ({counts[c.value] ?? 0})</option>)}
      </select>
      <div class="ap-list">
        {list.map((n) => <AssetRow key={n} ses={ses} name={n} sel={n === cur} />)}
        {!list.length && <p class="hint">No assets.</p>}
      </div>
      <p class="hint ap-count">{list.length} / {names.length} assets</p>
    </div>
  );
}
