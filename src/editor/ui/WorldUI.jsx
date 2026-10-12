// World editing UI: tool palette, outliner, inspector, brush settings, content browser.
import { useState, useMemo } from 'preact/hooks';
import { S, log } from '../core.js';
import { ENTITY_TYPES } from '../../engine/world/Entities.js';
import { TERRAIN_MATERIALS } from '../../engine/world/TerrainData.js';
import { VEHICLE_KINDS } from '../../game/entities/index.js';
import { Row, SchemaField, NumberField, EnumField, BoolField, Vec3Field } from './Fields.jsx';

export function editorCtx(ed) {
  const w = ed.world;
  return {
    assets: w.assets.names,
    archetypes: Object.keys(w.archetypes?.archetypes ?? {}),
    items: Object.keys(w.itemsData?.items ?? {}),
    sounds: Object.keys(ed.sounds?.sounds ?? {}),
    entities: w.entities.list,
  };
}

const TOOLS = [
  { id: 'select', icon: '⬚', label: 'Select / transform (W/E/R)' },
  { id: 'sculpt', icon: '⛰', label: 'Sculpt terrain' },
  { id: 'paint', icon: '🖌', label: 'Paint terrain' },
  { id: 'foliage', icon: '🌴', label: 'Vegetation' },
  { id: 'path', icon: '⤳', label: 'Edit a path (click = add a point, Del = remove the last one)' },
];

export function ToolPalette({ ed }) {
  const tool = S.tool.value;
  return (
    <div class="tools">
      {TOOLS.map((t) => <button class={tool === t.id ? 'on' : ''} title={t.label} onClick={() => { S.tool.value = t.id; S.place.value = null; ed._makeGhost(null); ed._attachGizmo(); }}>{t.icon}</button>)}
      <span class="sep" />
      {tool === 'select' && ['translate', 'rotate', 'scale'].map((m) => <button class={S.gizmo.value === m ? 'on small' : 'small'} onClick={() => (S.gizmo.value = m)} title={m}>{{ translate: '✥', rotate: '⟳', scale: '⤢' }[m]}</button>)}
    </div>
  );
}

export function Outliner({ ed }) {
  void S.version.value;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState({ prop: false });
  const sel = S.selection.value;
  const groups = useMemo(() => {
    const g = {};
    for (const e of ed.world.entities.list) {
      if (q && !(`${e.id} ${e.name ?? ''} ${e.asset ?? ''} ${e.archetype ?? ''} ${e.group ?? ''}`.toLowerCase().includes(q.toLowerCase()))) continue;
      (g[e.type] ??= []).push(e);
    }
    return g;
  }, [S.version.value, q]);
  return (
    <div class="outliner">
      <input class="search" placeholder="Search…" value={q} onInput={(e) => setQ(e.target.value)} />
      <div class="tree">
        {Object.entries(groups).sort().map(([type, list]) => (
          <div class="grp">
            <div class="gh" onClick={() => setOpen({ ...open, [type]: !(open[type] ?? true) })}>
              <span style={{ color: ENTITY_TYPES[type]?.color }}>●</span> {ENTITY_TYPES[type]?.label ?? type} <small>{list.length}</small>
            </div>
            {(open[type] ?? (list.length < 60 || !!q)) && list.map((e) => (
              <div class={'it' + (sel.includes(e.id) ? ' sel' : '')} onClick={(ev) => ed.select(ev.shiftKey ? [...sel, e.id] : [e.id])} onDblClick={() => { ed.select([e.id]); ed.frameSelection(); }}>
                {e.name || e.id}<small>{e.asset ?? e.archetype ?? e.item ?? ''}</small>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Inspector({ ed }) {
  void S.version.value;
  const sel = S.selection.value;
  const tool = S.tool.value;
  if (tool === 'sculpt' || tool === 'paint' || tool === 'foliage') return <BrushPanel ed={ed} />;
  if (!sel.length) return <div class="inspector empty"><p>No selection.</p><p class="hint">Click: select · Shift+click: multi · F: frame · Ctrl+D: duplicate · Del: delete · G: drop to ground · Hold right click + WASD/ZQSD: fly · Wheel: move forward</p><PlayerStart ed={ed} /></div>;
  if (sel.length > 1) return <div class="inspector"><h3>{sel.length} entities</h3><button onClick={() => ed.deleteSelection()}>Delete</button><button onClick={() => ed.duplicate()}>Duplicate</button><button onClick={() => ed.dropToGround()}>Drop to ground</button></div>;
  const e = ed.world.entities.get(sel[0]);
  if (!e) return null;
  const T = ENTITY_TYPES[e.type];
  const ctx = editorCtx(ed);
  const set = (k, v) => ed.updateEntity(e.id, { ...e, [k]: v });
  return (
    <div class="inspector">
      <h3><span style={{ color: T?.color }}>●</span> {T?.label ?? e.type}</h3>
      <Row label="Id"><input type="text" value={e.id} onBlur={(ev) => ev.target.value && ev.target.value !== e.id && ed.updateEntity(e.id, { ...e, id: ev.target.value })} /></Row>
      {Object.entries(T?.schema ?? {}).map(([k, f]) => <Row label={f.label ?? k} title={k}><SchemaField f={f} value={e[k]} ctx={ctx} onChange={(v) => set(k, v)} /></Row>)}
      <div class="btns">
        <button onClick={() => ed.frameSelection()}>Frame</button>
        <button onClick={() => ed.dropToGround()}>Drop to ground</button>
        <button onClick={() => ed.duplicate()}>Duplicate</button>
        <button class="danger" onClick={() => ed.deleteSelection()}>Delete</button>
      </div>
      <details><summary>JSON</summary><pre>{JSON.stringify(e, null, 2)}</pre></details>
      {e.type === 'path' && <p class="hint">Path tool (⤳): click the terrain to add points.</p>}
    </div>
  );
}

function PlayerStart({ ed }) {
  void S.version.value;
  const w = ed.world;
  const p = w.data.player ?? { pos: [0, 0, 0], yaw: 0 };
  return (
    <div class="sub">
      <h4>Player start</h4>
      <Row label="Position"><Vec3Field value={p.pos} onChange={(v) => { w.data.player = { ...p, pos: v }; ed.markDirty('world.json'); S.version.value++; }} /></Row>
      <Row label="Heading (rad)"><NumberField value={p.yaw} onChange={(v) => { w.data.player = { ...p, yaw: v }; ed.markDirty('world.json'); S.version.value++; }} /></Row>
      <button onClick={() => { const c = ed.engine.camera; const h = w.terrain.heightAt(c.position.x, c.position.z); w.data.player = { pos: [+c.position.x.toFixed(1), +(h + 0.1).toFixed(2), +c.position.z.toFixed(1)], yaw: +ed.fly.yaw.toFixed(2) }; ed.markDirty('world.json'); S.version.value++; log('Player start = camera'); }}>Place at camera</button>
    </div>
  );
}

function BrushPanel({ ed }) {
  const b = S.brush.value, tool = S.tool.value;
  const set = (k, v) => (S.brush.value = { ...b, [k]: v });
  const species = ed.world.vegetation.def.species;
  return (
    <div class="inspector">
      <h3>{{ sculpt: 'Sculpt', paint: 'Paint', foliage: 'Vegetation' }[tool]}</h3>
      {tool === 'sculpt' && (
        <div class="ops">{['raise', 'lower', 'smooth', 'flatten', 'noise'].map((op) => <button class={b.op === op ? 'on' : ''} onClick={() => set('op', op)}>{{ raise: 'Raise', lower: 'Lower', smooth: 'Smooth', flatten: 'Flatten', noise: 'Noise' }[op]}</button>)}</div>
      )}
      <Row label="Radius (Alt+wheel)"><NumberField value={+b.radius.toFixed(1)} step={0.5} min={1} max={200} onChange={(v) => set('radius', v)} /></Row>
      {tool !== 'paint' && <Row label={tool === 'foliage' ? 'Density' : 'Strength'}><input type="range" min="0.02" max="1" step="0.02" value={tool === 'foliage' ? b.density : b.strength} onInput={(e) => set(tool === 'foliage' ? 'density' : 'strength', +e.target.value)} /></Row>}
      {tool !== 'foliage' && <Row label="Falloff"><input type="range" min="0" max="1" step="0.05" value={b.falloff} onInput={(e) => set('falloff', +e.target.value)} /></Row>}
      {tool === 'sculpt' && b.op === 'flatten' && <Row label="Height (empty = at click)"><NumberField value={b.height ?? ''} onChange={(v) => set('height', v)} /></Row>}
      {tool === 'paint' && (
        <div class="swatches">
          {TERRAIN_MATERIALS.map((m) => <button class={b.material === m.name ? 'on' : ''} title={m.name} style={{ background: m.id ? `rgb(${m.color.map((c) => Math.round(c * 255)).join(',')})` : 'repeating-linear-gradient(45deg,#666 0 6px,#999 6px 12px)' }} onClick={() => set('material', m.name)}>{m.name}</button>)}
        </div>
      )}
      {tool === 'foliage' && (
        <>
          <Row label="Species"><EnumField value={String(b.species)} options={species.map((s, i) => ({ value: String(i), label: s.id }))} onChange={(v) => set('species', Number(v))} /></Row>
          <Row label="Erase"><BoolField value={b.erase} onChange={(v) => set('erase', v)} /></Row>
          <p class="hint">Erase only removes the selected species. Instances: {ed.world.vegetation.data.n}</p>
          <button onClick={() => set('species', -1)}>Erase all species</button>
        </>
      )}
      <p class="hint">Hold left click to apply. Ctrl+Z undoes the last brush stroke.</p>
    </div>
  );
}

const CATS = [
  ['building', 'Buildings'], ['prop', 'Props'], ['vegetation', 'Vegetation'], ['vehicle', 'Vehicles'], ['weapon', 'Weapons'], ['pickup', 'Pickups'],
];

export function ContentBrowser({ ed }) {
  const [tab, setTab] = useState('building');
  const [q, setQ] = useState('');
  const w = ed.world;
  const place = S.place.value;
  const entityTypes = Object.values(ENTITY_TYPES).filter((t) => t.type !== 'prop');
  let items = [];
  if (tab === 'entities') items = entityTypes.map((t) => ({ key: t.type, label: t.label, color: t.color, spec: { type: t.type } }));
  else if (tab === 'actors') items = Object.entries(w.archetypes?.archetypes ?? {}).map(([k, a]) => ({ key: k, label: a.label, spec: { type: a.civilian ? 'npc' : 'enemy', archetype: k } }));
  // weapons and pickups are placed as pickup entities (an item the player can take), not as props;
  // weapons lie on the ground
  else if (tab === 'weapon' || tab === 'pickup') items = Object.entries(w.itemsData?.items ?? {}).filter(([, it]) => !!it.weapon === (tab === 'weapon'))
    .map(([k, it]) => ({ key: k, label: it.label, asset: it.asset, spec: { type: 'pickup', item: k, ...(it.weapon ? { still: true } : {}) } }));
  else items = w.assets.names.filter((n) => (w.assets.get(n).category ?? 'prop') === tab).map((n) => ({ key: n, label: w.assets.get(n).label ?? n, asset: n, spec: { type: 'prop', asset: n } }));
  // drivable vehicles are vehicle entities; the vehicle assets themselves are static decor (no wheels)
  if (tab === 'vehicle') {
    items = [
      ...Object.entries(VEHICLE_KINDS).map(([k, v]) => ({ key: `vehicle:${k}`, label: `${v.label} (drivable)`, asset: v.asset, spec: { type: 'vehicle', vehicle: k } })),
      ...items.map((i) => ({ ...i, label: `${i.label} — decor` })),
    ];
  }
  if (q) items = items.filter((i) => `${i.key} ${i.label}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="content">
      <div class="tabs">
        {CATS.map(([k, l]) => <button class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        <button class={tab === 'entities' ? 'on' : ''} onClick={() => setTab('entities')}>Logic</button>
        <button class={tab === 'actors' ? 'on' : ''} onClick={() => setTab('actors')}>Characters</button>
        <input class="search" placeholder="Filter…" value={q} onInput={(e) => setQ(e.target.value)} />
        {place && <span class="placing">Placing: {place.asset ?? place.archetype ?? place.item ?? place.vehicle ?? place.type} — click to place, Shift+click to place several, Shift+wheel to rotate, Esc to cancel</span>}
      </div>
      <div class="grid">
        {items.map((i) => (
          <div key={i.key} class={'card' + (place && JSON.stringify(place) === JSON.stringify(i.spec) ? ' on' : '')} title={i.key} onClick={() => ed.startPlace(i.spec)}>
            {i.asset ? <Thumb ed={ed} name={i.asset} /> : <div class="ico" style={{ background: i.color ?? '#556' }}>{(i.label ?? i.key).slice(0, 2)}</div>}
            <span>{i.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Asset thumbnail rendered once with an offscreen renderer (cached data URL). */
const thumbCache = new Map();
function Thumb({ ed, name }) {
  const [url, setUrl] = useState(thumbCache.get(name));
  if (!url) queueMicrotask(() => ed.thumbnail(name).then((u) => { thumbCache.set(name, u); setUrl(u); }));
  return url ? <img src={url} /> : <div class="ico">…</div>;
}
