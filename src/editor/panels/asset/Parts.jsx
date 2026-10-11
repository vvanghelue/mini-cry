// "Pièces" tab: the part list (select, add with a shape picker, duplicate, delete, reorder, toggle
// minQuality) and the selected part's inspector (shape fields, transform, colour, jitter, wind,
// emissive, LOD, repeat / radial modifiers, raw JSON).
import * as THREE from 'three';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Row, NumberField, Vec3Field, ColorField, EnumField, BoolField, JsonField } from '../../ui/Fields.jsx';
import { A } from './session.js';
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
        <button class={adding ? 'on' : ''} onClick={() => setAdding(!adding)} title="Ajouter une pièce (après la sélection)">＋ Pièce ▾</button>
        <button disabled={si < 0} onClick={() => ses.duplicatePart(si)} title="Dupliquer la pièce (Ctrl+D)">⧉ Dupliquer</button>
        <button disabled={si <= 0} onClick={() => ses.movePart(si, -1)} title="Monter">↑</button>
        <button disabled={si < 0 || si >= parts.length - 1} onClick={() => ses.movePart(si, 1)} title="Descendre">↓</button>
        <button class="danger" disabled={si < 0} onClick={() => ses.deletePart(si)} title="Supprimer la pièce (Suppr)">✕</button>
      </div>
      {adding && (
        <div class="ap-shapes">
          {SHAPES.map((s) => <button title={SHAPE_HELP[s]} onClick={() => { ses.addPart(s); setAdding(false); }}><span>{SHAPE_ICON[s]}</span>{SHAPE_LABEL[s]}</button>)}
        </div>
      )}
      {d.generator && <p class="hint">+ les pièces du générateur « {d.generator.type} » (onglet Asset → « Cuire en pièces » pour les éditer).</p>}
      <div class="ap-parts">
        {parts.map((p, i) => <PartRow ses={ses} p={p} i={i} sel={i === si} />)}
        {!parts.length && <p class="hint">Aucune pièce. « ＋ Pièce » pour en ajouter.</p>}
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
      {p.repeat && <span class="tag" title="Répétition">×{p.repeat.count ?? 2}</span>}
      {p.radial && <span class="tag" title="Copies radiales">✳{p.radial.count ?? 6}</span>}
      {p.emissive ? <span class="tag em" title={`Émissif ${p.emissive}`}>✦</span> : null}
      {p.wind ? <span class="tag wind" title={`Vent ${JSON.stringify(p.wind)}`}>≈</span> : null}
      <button class={'lodtag' + (mq ? ' on' : '')} title={mq ? `Retirée sous la qualité ${p.minQuality} (clic : toujours visible)` : 'Toujours visible (clic : retirer sous la qualité 0.5)'} onClick={(e) => { e.stopPropagation(); ses.patchPart(i, { minQuality: mq ? undefined : 0.5 }); }}>{mq ? `≥${p.minQuality}` : 'LOD'}</button>
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
          {f.optional && p[f.k] !== undefined && <button class="icon" title="Retirer (valeur par défaut)" onClick={() => set(undefined)}>✕</button>}
        </>
      );
      break;
    case 'int': field = <NumberField value={val} step={f.step} min={f.min} max={f.max} onChange={(v) => set(Math.round(v))} />; break;
    case 'vec3': field = <Vec3Field value={val} step={f.step} onChange={set} />; break;
    case 'vec2': field = <span class="vec3"><NumberField value={val[0]} step={f.step} onChange={(v) => set([v, val[1]])} /><NumberField value={val[1]} step={f.step} onChange={(v) => set([val[0], v])} /></span>; break;
    case 'bool': field = <BoolField value={p[f.k] ?? f.def ?? false} onChange={(v) => set(v === (f.def ?? false) ? undefined : v)} />; break;
    case 'json':
      return (
        <Row label={f.label} title={`${Math.floor((val?.length ?? 0) / 9)} triangles (x, y, z par sommet, sens anti-horaire = face avant)`}>
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
      <h4>Pièce {i} — {SHAPE_LABEL[p.shape] ?? p.shape}</h4>
      <Row label="Forme" title={SHAPE_HELP[p.shape]}>
        <EnumField value={p.shape} options={SHAPES.map((x) => ({ value: x, label: `${SHAPE_ICON[x]} ${SHAPE_LABEL[x]} (${x})` }))} onChange={(x) => x && x !== p.shape && put(changeShape(p, x), 'shape')} />
      </Row>
      {fields.map((f) => <ShapeField f={f} p={p} put={put} ses={ses} self={self} />)}
      {p.shape === 'ref' && !p.asset && <p class="err">Choisissez l'asset à insérer.</p>}
      {(p.shape === 'limb' || p.shape === 'frond' || p.shape === 'tris') && (
        <div class="btns"><button class="small" title="Place pos au centre de la géométrie (le gizmo se retrouve sur la pièce), sans la déplacer" onClick={() => put(recenter(p), 'recenter')}>Recentrer le pivot</button></div>
      )}

      <h4>Transformation</h4>
      <Row label="Position"><Vec3Field value={p.pos ?? [0, 0, 0]} step={0.01} onChange={(v) => set({ pos: v })} /></Row>
      <Row label="Rotation (°)" title="Appliquée dans l'ordre Y, X, Z"><Vec3Field value={p.rot ?? [0, 0, 0]} step={0.5} onChange={(v) => set({ rot: v.every((x) => x === 0) ? undefined : v })} /></Row>
      <Row label="Échelle">
        {Array.isArray(s) ? (
          <>
            <Vec3Field value={s} step={0.01} onChange={(v) => set({ scale: v })} />
            <button class="icon" title="Échelle uniforme" onClick={() => set({ scale: s[0] === 1 ? undefined : s[0] })}>=</button>
          </>
        ) : (
          <>
            <NumberField value={s ?? 1} step={0.01} onChange={(v) => set({ scale: v === 1 ? undefined : v })} />
            <button class="icon" title="Échelle par axe (x, y, z)" onClick={() => set({ scale: [s ?? 1, s ?? 1, s ?? 1] })}>xyz</button>
          </>
        )}
      </Row>

      <h4>Apparence</h4>
      <Row label="Couleur"><ColorField value={p.color ?? '#888888'} onChange={(v) => set({ color: v })} /></Row>
      <Row label="Variation" title="jitter : ± variation de luminosité par face (défaut 0.06)"><NumberField value={p.jitter ?? 0.06} step={0.002} min={0} max={0.5} onChange={(v) => set({ jitter: v === 0.06 ? undefined : v })} /></Row>
      <Row label="Vent" title="0 rigide … 1 bout de feuille ; dégradé [bas, haut] le long de la hauteur locale">
        {Array.isArray(p.wind) ? (
          <>
            <span class="ap-mini">bas</span><NumberField value={p.wind[0]} step={0.01} min={0} max={1} onChange={(v) => set({ wind: [v, p.wind[1]] })} />
            <span class="ap-mini">haut</span><NumberField value={p.wind[1]} step={0.01} min={0} max={1} onChange={(v) => set({ wind: [p.wind[0], v] })} />
            <button class="icon" title="Valeur unique" onClick={() => set({ wind: p.wind[1] || undefined })}>1</button>
          </>
        ) : (
          <>
            <NumberField value={p.wind ?? 0} step={0.01} min={0} max={1} onChange={(v) => set({ wind: v || undefined })} />
            <button class="icon" title="Dégradé bas → haut" onClick={() => set({ wind: [0, p.wind || 0.5] })}>↕</button>
          </>
        )}
      </Row>
      <Row label="Émissif" title="0..2 : auto-éclairé (ampoules, feu, écrans)"><NumberField value={p.emissive ?? 0} step={0.02} min={0} max={4} onChange={(v) => set({ emissive: v || undefined })} /></Row>
      <Row label="Feuillage" title="foliage 0..1 : ombrage doux de houppier (normales tournées vers l'extérieur de « crown », ou de la touffe elle-même) au lieu des facettes">
        <NumberField value={p.foliage ?? 0} step={0.01} min={0} max={1} onChange={(v) => set({ foliage: v || undefined })} />
      </Row>
      {p.foliage > 0 && (
        <div class="ap-indent">
          <Row label="Houppier" title="crown : [cx, cy, cz, r] ou [cx, cy, cz, rx, ry, rz], ellipsoïde commun à toutes les feuilles de l'arbre (vide = la pièce elle-même)"><JsonField value={p.crown ?? null} rows={1} onChange={(v) => set({ crown: Array.isArray(v) ? v : undefined })} /></Row>
          <Row label="Occlusion" title="ao : assombrit les feuilles au cœur et sous le houppier (défaut 0.5, avec crown)"><NumberField value={p.ao ?? 0.5} step={0.01} min={0} max={1} onChange={(v) => set({ ao: v === 0.5 ? undefined : v })} /></Row>
        </div>
      )}
      <Row label="Qualité min." title="minQuality : la pièce disparaît aux LOD de qualité inférieure (petits détails : 0.5)">
        <EnumField value={p.minQuality === undefined ? '' : String(p.minQuality)} options={[...new Set(['0.25', '0.4', '0.5', '0.6', '0.75', '1', ...(p.minQuality !== undefined ? [String(p.minQuality)] : [])])].map((x) => ({ value: x, label: `≥ ${x}` }))} allowEmpty onChange={(v) => set({ minQuality: v === undefined ? undefined : +v })} />
      </Row>

      <h4>Modificateurs</h4>
      <Row label="Répéter" title="Copies décalées (planches, poteaux, marches)"><BoolField value={!!rep} onChange={(on) => set({ repeat: on ? { count: 3, offset: [0.5, 0, 0] } : undefined })} /></Row>
      {rep && (
        <div class="ap-indent">
          <Row label="Nombre"><NumberField value={rep.count ?? 2} step={0.1} min={1} max={500} onChange={(v) => set({ repeat: { ...rep, count: Math.round(v) } }, 'repeat.count')} /></Row>
          <Row label="Décalage"><Vec3Field value={rep.offset ?? [1, 0, 0]} step={0.01} onChange={(v) => set({ repeat: { ...rep, offset: v } }, 'repeat.offset')} /></Row>
          <Row label="Rotation (°)"><Vec3Field value={rep.rot ?? [0, 0, 0]} step={0.5} onChange={(v) => set({ repeat: patchObj(rep, { rot: v.every((x) => x === 0) ? undefined : v }) }, 'repeat.rot')} /></Row>
        </div>
      )}
      <Row label="Radial" title="Copies autour de l'axe Y"><BoolField value={!!rad} onChange={(on) => set({ radial: on ? { count: 6, radius: 1 } : undefined })} /></Row>
      {rad && (
        <div class="ap-indent">
          <Row label="Nombre"><NumberField value={rad.count ?? 6} step={0.1} min={1} max={500} onChange={(v) => set({ radial: { ...rad, count: Math.round(v) } }, 'radial.count')} /></Row>
          <Row label="Rayon"><NumberField value={rad.radius ?? 0} step={0.01} min={0} onChange={(v) => set({ radial: { ...rad, radius: v } }, 'radial.radius')} /></Row>
          <Row label="Angle départ (°)"><NumberField value={rad.yaw0 ?? 0} step={0.5} onChange={(v) => set({ radial: patchObj(rad, { yaw0: v || undefined }) }, 'radial.yaw0')} /></Row>
        </div>
      )}
      <details class="ap-json">
        <summary>JSON de la pièce</summary>
        <JsonField value={p} rows={8} onChange={(np) => { if (np && typeof np === 'object' && !Array.isArray(np) && np.shape) put(np, 'json'); }} />
      </details>
    </div>
  );
}
