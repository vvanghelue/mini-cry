// "Parts" tab: the part list (select, add with a shape picker, duplicate, delete, reorder, toggle
// minQuality) and the selected part's inspector (shape fields, transform, colour, texture surface,
// jitter, wind, emissive, LOD, repeat / radial modifiers, raw JSON).
import * as THREE from 'three';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Row, NumberField, Vec3Field, ColorField, EnumField, BoolField, JsonField } from '../../ui/Fields.jsx';
import { A } from './session.js';
import { surfaceNames } from '../../../engine/assets/surfaces.js';
import { defaultSurface } from '../../../engine/assets/ModelBuilder.js';
import { SHAPES, SHAPE_LABEL, SHAPE_ICON, SHAPE_HELP, SHAPE_FIELDS, changeShape, partSummary, patchObj, rnd } from './shapes.js';

const D2R = Math.PI / 180;

export function PartsTab({ ses }) {
  const d = A.def.value;
  const [adding, setAdding] = useState(false);
  if (!d) return null;
  const parts = d.parts ?? [];
  const sel = A.sel.value;
  const si = sel?.kind === 'part' && parts[sel.i] ? sel.i : -1;
  return (
    <div class="ap-sec">
      <div class="ap-row-btns">
        <button class={adding ? 'on' : ''} onClick={() => setAdding(!adding)} title="Add a part (after the selection)">＋ Part ▾</button>
        <button disabled={si < 0} onClick={() => ses.duplicatePart(si)} title="Duplicate the part (Ctrl+D)">⧉ Duplicate</button>
        <button disabled={si <= 0} onClick={() => ses.movePart(si, -1)} title="Move up">↑</button>
        <button disabled={si < 0 || si >= parts.length - 1} onClick={() => ses.movePart(si, 1)} title="Move down">↓</button>
        <button class="danger" disabled={si < 0} onClick={() => ses.deletePart(si)} title="Delete the part (Del)">✕</button>
      </div>
      {adding && (
        <div class="ap-shapes">
          {SHAPES.map((s) => <button title={SHAPE_HELP[s]} onClick={() => { ses.addPart(s); setAdding(false); }}><span>{SHAPE_ICON[s]}</span>{SHAPE_LABEL[s]}</button>)}
        </div>
      )}
      {d.generator && <p class="hint">+ the parts of the "{d.generator.type}" generator (Asset tab → "Bake to parts" to edit them).</p>}
      <div class="ap-parts">
        {parts.map((p, i) => <PartRow ses={ses} p={p} i={i} sel={i === si} />)}
        {!parts.length && <p class="hint">No parts. "＋ Part" to add one.</p>}
      </div>
      {si >= 0 && <PartInspector ses={ses} i={si} p={parts[si]} self={d.name} />}
    </div>
  );
}

function PartRow({ ses, p, i, sel }) {
  const ref = useRef(null);
  useEffect(() => { if (sel) ref.current?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const mq = p.minQuality !== undefined;
  return (
    <div ref={ref} class={'ap-part' + (sel ? ' sel' : '')} onClick={() => (A.sel.value = { kind: 'part', i })}>
      <span class="ix">{i}</span>
      <span class="sw" style={{ background: p.color ?? '#888888' }} />
      <span class="sh" title={SHAPE_LABEL[p.shape] ?? p.shape}>{SHAPE_ICON[p.shape] ?? '?'} {p.shape}</span>
      <small class="sum">{partSummary(p)}</small>
      {p.repeat && <span class="tag" title="Repeat">×{p.repeat.count ?? 2}</span>}
      {p.radial && <span class="tag" title="Radial copies">✳{p.radial.count ?? 6}</span>}
      {p.emissive ? <span class="tag em" title={`Emissive ${p.emissive}`}>✦</span> : null}
      {p.wind ? <span class="tag wind" title={`Wind ${JSON.stringify(p.wind)}`}>≈</span> : null}
      <button class={'lodtag' + (mq ? ' on' : '')} title={mq ? `Removed below quality ${p.minQuality} (click: always visible)` : 'Always visible (click: remove below quality 0.5)'} onClick={(e) => { e.stopPropagation(); ses.patchPart(i, { minQuality: mq ? undefined : 0.5 }); }}>{mq ? `≥${p.minQuality}` : 'LOD'}</button>
    </div>
  );
}

/** Move the part's pivot to the centre of its geometry (limb from/to, frond base, tris positions). */
function recenter(p) {
  let c, np = { ...p };
  if (p.shape === 'limb') {
    const a = p.from ?? [0, 0, 0], b = p.to ?? [0, 1, 0];
    c = [0, 1, 2].map((k) => (a[k] + b[k]) / 2);
    np.from = a.map((v, k) => rnd(v - c[k], 4));
    np.to = b.map((v, k) => rnd(v - c[k], 4));
  } else if (p.shape === 'frond') {
    c = p.base ?? [0, 0, 0];
    np.base = [0, 0, 0];
  } else if (p.shape === 'tris') {
    const P = p.positions ?? [], n = P.length / 3;
    if (!n) return p;
    c = [0, 0, 0];
    for (let i = 0; i < P.length; i++) c[i % 3] += P[i] / n;
    np.positions = P.map((v, i) => rnd(v - c[i % 3], 4));
  } else return p;
  const rot = p.rot ?? [0, 0, 0];
  const sc = p.scale === undefined ? [1, 1, 1] : typeof p.scale === 'number' ? [p.scale, p.scale, p.scale] : p.scale;
  const v = new THREE.Vector3(...c).multiply(new THREE.Vector3(...sc)).applyEuler(new THREE.Euler(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R, 'YXZ'));
  const pos = p.pos ?? [0, 0, 0];
  np.pos = [rnd(pos[0] + v.x, 4), rnd(pos[1] + v.y, 4), rnd(pos[2] + v.z, 4)];
  return np;
}

function ShapeField({ f, p, put, ses, self }) {
  const val = f.get ? f.get(p) : p[f.k] ?? f.def;
  const set = (v) => put(f.set ? f.set(p, v) : patchObj(p, { [f.k]: v }), f.k);
  let field;
  switch (f.type) {
    case 'num':
      field = (
        <>
          <NumberField value={val} step={f.step} min={f.min} max={f.max} onChange={set} />
          {f.optional && p[f.k] !== undefined && <button class="icon" title="Remove (default value)" onClick={() => set(undefined)}>✕</button>}
        </>
      );
      break;
    case 'int': field = <NumberField value={val} step={f.step} min={f.min} max={f.max} onChange={(v) => set(Math.round(v))} />; break;
    case 'vec3': field = <Vec3Field value={val} step={f.step} onChange={set} />; break;
    case 'vec2': field = <span class="vec3"><NumberField value={val[0]} step={f.step} onChange={(v) => set([v, val[1]])} /><NumberField value={val[1]} step={f.step} onChange={(v) => set([val[0], v])} /></span>; break;
    case 'bool': field = <BoolField value={p[f.k] ?? f.def ?? false} onChange={(v) => set(v === (f.def ?? false) ? undefined : v)} />; break;
    case 'json':
      return (
        <Row label={f.label} title={`${Math.floor((val?.length ?? 0) / 9)} triangles (x, y, z per vertex, counter-clockwise = front face)`}>
          <JsonField value={val} rows={5} onChange={(v) => Array.isArray(v) && set(v)} />
        </Row>
      );
    case 'asset': field = <EnumField value={p.asset} options={ses.names.filter((n) => n !== self)} allowEmpty onChange={(v) => set(v ?? '')} />; break;
    default: field = <JsonField value={val} rows={2} onChange={set} />;
  }
  return <Row label={f.label} title={f.title}>{field}</Row>;
}

export function PartInspector({ ses, i, p, self }) {
  const key = (k) => `part:${i}:${k}`;
  const put = (np, k) => ses.setPart(i, np, key(k));
  const set = (patch, k) => put(patchObj(p, patch), k ?? Object.keys(patch).join(','));
  const fields = SHAPE_FIELDS[p.shape] ?? [];
  const s = p.scale;
  const rep = p.repeat, rad = p.radial;
  return (
    <div class="ap-insp">
      <h4>Part {i} — {SHAPE_LABEL[p.shape] ?? p.shape}</h4>
      <Row label="Shape" title={SHAPE_HELP[p.shape]}>
        <EnumField value={p.shape} options={SHAPES.map((x) => ({ value: x, label: `${SHAPE_ICON[x]} ${SHAPE_LABEL[x]} (${x})` }))} onChange={(x) => x && x !== p.shape && put(changeShape(p, x), 'shape')} />
      </Row>
      {fields.map((f) => <ShapeField f={f} p={p} put={put} ses={ses} self={self} />)}
      {p.shape === 'ref' && !p.asset && <p class="err">Choose the asset to insert.</p>}
      {(p.shape === 'limb' || p.shape === 'frond' || p.shape === 'tris') && (
        <div class="btns"><button class="small" title="Moves pos to the center of the geometry (the gizmo ends up on the part) without moving the part" onClick={() => put(recenter(p), 'recenter')}>Recenter pivot</button></div>
      )}

      <h4>Transform</h4>
      <Row label="Position"><Vec3Field value={p.pos ?? [0, 0, 0]} step={0.01} onChange={(v) => set({ pos: v })} /></Row>
      <Row label="Rotation (°)" title="Applied in Y, X, Z order"><Vec3Field value={p.rot ?? [0, 0, 0]} step={0.5} onChange={(v) => set({ rot: v.every((x) => x === 0) ? undefined : v })} /></Row>
      <Row label="Scale">
        {Array.isArray(s) ? (
          <>
            <Vec3Field value={s} step={0.01} onChange={(v) => set({ scale: v })} />
            <button class="icon" title="Uniform scale" onClick={() => set({ scale: s[0] === 1 ? undefined : s[0] })}>=</button>
          </>
        ) : (
          <>
            <NumberField value={s ?? 1} step={0.01} onChange={(v) => set({ scale: v === 1 ? undefined : v })} />
            <button class="icon" title="Per-axis scale (x, y, z)" onClick={() => set({ scale: [s ?? 1, s ?? 1, s ?? 1] })}>xyz</button>
          </>
        )}
      </Row>

      <h4>Appearance</h4>
      <Row label="Color"><ColorField value={p.color ?? '#888888'} onChange={(v) => set({ color: v })} /></Row>
      <Row label="Surface" title="Texture layer (textures.json). Empty: the asset's default surface (from its material)">
        <EnumField value={p.surface} options={surfaceNames().map((n) => ({ value: n, label: n }))} allowEmpty placeholder={defaultSurface(A.def.value)} onChange={(v) => set({ surface: v || undefined })} />
      </Row>
      <Row label="Texture scale" title="uvScale: metres per texture repeat (default: the layer's)"><NumberField value={p.uvScale ?? 0} step={0.05} min={0} onChange={(v) => set({ uvScale: v || undefined })} /></Row>
      <Row label="Smooth" title="Smooth shading (default for round shapes) or facets"><BoolField value={p.smooth ?? ['cylinder', 'cone', 'sphere', 'lump', 'limb', 'frond'].includes(p.shape)} onChange={(v) => set({ smooth: v })} /></Row>
      <Row label="Variation" title="jitter: ± brightness variation of the part (default 0.06)"><NumberField value={p.jitter ?? 0.06} step={0.002} min={0} max={0.5} onChange={(v) => set({ jitter: v === 0.06 ? undefined : v })} /></Row>
      <Row label="Wind" title="0 rigid … 1 leaf tip; [bottom, top] gradient along the local height">
        {Array.isArray(p.wind) ? (
          <>
            <span class="ap-mini">bottom</span><NumberField value={p.wind[0]} step={0.01} min={0} max={1} onChange={(v) => set({ wind: [v, p.wind[1]] })} />
            <span class="ap-mini">top</span><NumberField value={p.wind[1]} step={0.01} min={0} max={1} onChange={(v) => set({ wind: [p.wind[0], v] })} />
            <button class="icon" title="Single value" onClick={() => set({ wind: p.wind[1] || undefined })}>1</button>
          </>
        ) : (
          <>
            <NumberField value={p.wind ?? 0} step={0.01} min={0} max={1} onChange={(v) => set({ wind: v || undefined })} />
            <button class="icon" title="Bottom → top gradient" onClick={() => set({ wind: [0, p.wind || 0.5] })}>↕</button>
          </>
        )}
      </Row>
      <Row label="Emissive" title="0..2: self-lit (bulbs, fire, screens)"><NumberField value={p.emissive ?? 0} step={0.02} min={0} max={4} onChange={(v) => set({ emissive: v || undefined })} /></Row>
      <Row label="Foliage" title="foliage 0..1: soft crown shading (normals pointing out of the crown ellipsoid, or of the clump itself) instead of facets">
        <NumberField value={p.foliage ?? 0} step={0.01} min={0} max={1} onChange={(v) => set({ foliage: v || undefined })} />
      </Row>
      {p.foliage > 0 && (
        <div class="ap-indent">
          <Row label="Crown" title="crown: [cx, cy, cz, r] or [cx, cy, cz, rx, ry, rz], ellipsoid shared by every leaf of the tree (empty = the part itself)"><JsonField value={p.crown ?? null} rows={1} onChange={(v) => set({ crown: Array.isArray(v) ? v : undefined })} /></Row>
          <Row label="Occlusion" title="ao: darkens the leaves deep inside and under the crown (default 0.5, with crown)"><NumberField value={p.ao ?? 0.5} step={0.01} min={0} max={1} onChange={(v) => set({ ao: v === 0.5 ? undefined : v })} /></Row>
        </div>
      )}
      <Row label="Min. quality" title="minQuality: the part disappears at lower-quality LODs (small details: 0.5)">
        <EnumField value={p.minQuality === undefined ? '' : String(p.minQuality)} options={[...new Set(['0.25', '0.4', '0.5', '0.6', '0.75', '1', ...(p.minQuality !== undefined ? [String(p.minQuality)] : [])])].map((x) => ({ value: x, label: `≥ ${x}` }))} allowEmpty onChange={(v) => set({ minQuality: v === undefined ? undefined : +v })} />
      </Row>

      <h4>Modifiers</h4>
      <Row label="Repeat" title="Offset copies (planks, posts, steps)"><BoolField value={!!rep} onChange={(on) => set({ repeat: on ? { count: 3, offset: [0.5, 0, 0] } : undefined })} /></Row>
      {rep && (
        <div class="ap-indent">
          <Row label="Count"><NumberField value={rep.count ?? 2} step={0.1} min={1} max={500} onChange={(v) => set({ repeat: { ...rep, count: Math.round(v) } }, 'repeat.count')} /></Row>
          <Row label="Offset"><Vec3Field value={rep.offset ?? [1, 0, 0]} step={0.01} onChange={(v) => set({ repeat: { ...rep, offset: v } }, 'repeat.offset')} /></Row>
          <Row label="Rotation (°)"><Vec3Field value={rep.rot ?? [0, 0, 0]} step={0.5} onChange={(v) => set({ repeat: patchObj(rep, { rot: v.every((x) => x === 0) ? undefined : v }) }, 'repeat.rot')} /></Row>
        </div>
      )}
      <Row label="Radial" title="Copies around the Y axis"><BoolField value={!!rad} onChange={(on) => set({ radial: on ? { count: 6, radius: 1 } : undefined })} /></Row>
      {rad && (
        <div class="ap-indent">
          <Row label="Count"><NumberField value={rad.count ?? 6} step={0.1} min={1} max={500} onChange={(v) => set({ radial: { ...rad, count: Math.round(v) } }, 'radial.count')} /></Row>
          <Row label="Radius"><NumberField value={rad.radius ?? 0} step={0.01} min={0} onChange={(v) => set({ radial: { ...rad, radius: v } }, 'radial.radius')} /></Row>
          <Row label="Start angle (°)"><NumberField value={rad.yaw0 ?? 0} step={0.5} onChange={(v) => set({ radial: patchObj(rad, { yaw0: v || undefined }) }, 'radial.yaw0')} /></Row>
        </div>
      )}
      <details class="ap-json">
        <summary>Part JSON</summary>
        <JsonField value={p} rows={8} onChange={(np) => { if (np && typeof np === 'object' && !Array.isArray(np) && np.shape) put(np, 'json'); }} />
      </details>
    </div>
  );
}
