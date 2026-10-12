// "Colliders" tab: collider mode (default / auto / none / list), the explicit collider list
// (box / cylinder / sphere, pos, yaw, ladder, walkable) and the selected collider's inspector.
import { Row, NumberField, Vec3Field, EnumField, BoolField } from '../../ui/Fields.jsx';
import { A } from './session.js';
import { patchObj, roundDeep, rnd } from './shapes.js';

const TYPES = [{ value: 'box', label: 'Box' }, { value: 'cylinder', label: 'Cylinder' }, { value: 'sphere', label: 'Sphere' }];
const TYPE_LABEL = { box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere' };
const f2 = (v) => +(+v).toFixed(2);

function convert(c, type) {
  const n = { type, pos: c.pos ?? [0, 0, 0] };
  const sz = c.size ?? [1, 1, 1];
  const r = c.radius ?? Math.max(sz[0], sz[2]) / 2;
  if (type === 'box') n.size = c.type === 'box' ? sz : [rnd(r * 2), rnd(c.height ?? r * 2), rnd(r * 2)];
  if (type === 'cylinder') { n.radius = rnd(r); n.height = rnd(c.height ?? (c.type === 'box' ? sz[1] : r * 2)); }
  if (type === 'sphere') n.radius = rnd(c.type === 'box' ? Math.max(...sz) / 2 : r);
  return n;
}

function summary(c) {
  const p = (c.pos ?? [0, 0, 0]).map(f2).join(', ');
  if (c.type === 'box') return `${(c.size ?? [1, 1, 1]).map(f2).join('×')} @ ${p}${c.rot?.[1] ? ` ↻${f2(c.rot[1])}°` : ''}`;
  if (c.type === 'cylinder') return `r ${f2(c.radius ?? 0.5)} h ${f2(c.height ?? 1)} @ ${p}`;
  return `r ${f2(c.radius ?? 0.5)} @ ${p}`;
}

export function CollidersTab({ ses }) {
  const d = A.def.value;
  if (!d) return null;
  const c = d.collider;
  const mode = Array.isArray(c) ? 'list' : c === 'auto' ? 'auto' : c === 'none' ? 'none' : 'default';
  const resolved = ses.preview?.colliders ?? [];
  void A.stats.value; // refresh the resolved summary after rebuilds
  const setMode = (m) => {
    if (m === mode) return;
    if (m === 'list') ses.commit({ ...d, collider: roundDeep(resolved, 3) });
    else ses.commit(patchObj(d, { collider: m === 'default' ? undefined : m }));
    A.sel.value = null;
  };
  const sel = A.sel.value;
  const si = mode === 'list' && sel?.kind === 'collider' && c[sel.i] ? sel.i : -1;
  const bounds = ses.preview?.bounds;
  const boundsBox = () => {
    const s = bounds.max.clone().sub(bounds.min), m = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
    return { type: 'box', size: [rnd(s.x), rnd(s.y), rnd(s.z)], pos: [rnd(m.x), rnd(m.y), rnd(m.z)] };
  };
  const defHelp = d.category === 'prop' || d.category === undefined ? 'automatic bounding box (prop)' : d.generator ? 'shapes provided by the generator' : 'no collision';
  return (
    <div class="ap-sec">
      <h4>Colliders</h4>
      <div class="ap-seg wide">
        {[['default', 'Default'], ['auto', 'Auto'], ['none', 'None'], ['list', 'List']].map(([k, l]) => <button class={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}
      </div>
      <p class="hint">
        {mode === 'default' && <>No <code>collider</code> key: {defHelp}.</>}
        {mode === 'auto' && <>Bounding box computed from the geometry.</>}
        {mode === 'none' && <>No collision (the player and bullets go through).</>}
        {mode === 'list' && <>Explicit shapes, in asset space. Boxes only rotate around Y.</>}
      </p>
      {mode !== 'list' && (
        <>
          <div class="ap-parts">
            {resolved.map((x) => <div class="ap-part ro"><span class="sh">{TYPE_LABEL[x.type] ?? x.type}</span><small class="sum">{summary(x)}</small></div>)}
            {!resolved.length && <p class="hint">— no shapes —</p>}
          </div>
          {resolved.length > 0 && <div class="btns"><button class="small" onClick={() => setMode('list')}>Convert to an editable list</button></div>}
        </>
      )}
      {mode === 'list' && (
        <>
          <div class="ap-row-btns">
            <button onClick={() => ses.addCollider({ type: 'box', size: [1, 1, 1], pos: [0, 0.5, 0] })} title="Add a box">＋ Box</button>
            <button onClick={() => ses.addCollider({ type: 'cylinder', radius: 0.5, height: 1, pos: [0, 0.5, 0] })} title="Add a cylinder">＋ Cyl.</button>
            <button onClick={() => ses.addCollider({ type: 'sphere', radius: 0.5, pos: [0, 0.5, 0] })} title="Add a sphere">＋ Sph.</button>
            <button disabled={!bounds} onClick={() => ses.addCollider(boundsBox())} title="Add a box enclosing the whole asset">＋ Bounds</button>
            <button disabled={si < 0} onClick={() => ses.duplicateCollider(si)} title="Duplicate (Ctrl+D)">⧉</button>
            <button class="danger" disabled={si < 0} onClick={() => ses.deleteCollider(si)} title="Delete (Del)">✕</button>
          </div>
          <div class="ap-parts">
            {c.map((x, i) => (
              <div class={'ap-part' + (i === si ? ' sel' : '')} onClick={() => (A.sel.value = { kind: 'collider', i })}>
                <span class="ix">{i}</span>
                <span class="sh">{TYPE_LABEL[x.type] ?? x.type}</span>
                <small class="sum">{summary(x)}</small>
                {x.ladder && <span class="tag ladder" title="Ladder">ladder</span>}
                {x.walkable === false && <span class="tag nowalk" title="Not walkable">⊘</span>}
              </div>
            ))}
            {!c.length && <p class="hint">Empty list: no collision.</p>}
          </div>
          {si >= 0 && <ColliderInspector ses={ses} i={si} c={c[si]} />}
        </>
      )}
      <p class="hint">Preview: green = solid, blue = ladder, orange = not walkable, grey = automatic, yellow = selection. Click in the preview (Colliders tab) to select a shape. Stairs: stacked boxes, step ≤ 0.35 m. Doors ≥ 1.2 × 2.1 m, free of colliders.</p>
    </div>
  );
}

function ColliderInspector({ ses, i, c }) {
  const set = (patch, k) => ses.setCollider(i, patchObj(c, patch), `col:${i}:${k ?? Object.keys(patch).join(',')}`);
  return (
    <div class="ap-insp">
      <h4>Shape {i}</h4>
      <Row label="Type"><EnumField value={c.type} options={TYPES} onChange={(t) => t && t !== c.type && ses.setCollider(i, convert(c, t))} /></Row>
      {c.type === 'box' && <Row label="Size (w, h, d)"><Vec3Field value={c.size ?? [1, 1, 1]} step={0.01} onChange={(v) => set({ size: v })} /></Row>}
      {c.type !== 'box' && <Row label="Radius"><NumberField value={c.radius ?? 0.5} step={0.01} min={0} onChange={(v) => set({ radius: v })} /></Row>}
      {c.type === 'cylinder' && <Row label="Height"><NumberField value={c.height ?? 1} step={0.01} min={0} onChange={(v) => set({ height: v })} /></Row>}
      <Row label="Position"><Vec3Field value={c.pos ?? [0, 0, 0]} step={0.01} onChange={(v) => set({ pos: v })} /></Row>
      {c.type === 'box' && <Row label="Rotation Y (°)"><NumberField value={c.rot?.[1] ?? 0} step={0.5} onChange={(v) => set({ rot: v ? [0, v, 0] : undefined })} /></Row>}
      {c.type === 'box' && <Row label="Ladder" title="The player climbs by walking into it"><BoolField value={!!c.ladder} onChange={(v) => set({ ladder: v || undefined })} /></Row>}
      {c.type === 'box' && <Row label="Walkable" title="Uncheck to prevent standing on it (sloped roofs)"><BoolField value={c.walkable !== false} onChange={(v) => set({ walkable: v ? undefined : false })} /></Row>}
    </div>
  );
}
