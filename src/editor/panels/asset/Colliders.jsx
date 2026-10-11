// "Collisions" tab: collider mode (défaut / auto / aucune / liste), the explicit collider list
// (box / cylinder / sphere, pos, yaw, ladder, walkable) and the selected collider's inspector.
import { Row, NumberField, Vec3Field, EnumField, BoolField } from '../../ui/Fields.jsx';
import { A } from './session.js';
import { patchObj, roundDeep, rnd } from './shapes.js';

const TYPES = [{ value: 'box', label: 'Boîte' }, { value: 'cylinder', label: 'Cylindre' }, { value: 'sphere', label: 'Sphère' }];
const TYPE_LABEL = { box: 'Boîte', cylinder: 'Cylindre', sphere: 'Sphère' };
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
  const defHelp = d.category === 'prop' || d.category === undefined ? 'boîte englobante automatique (objet)' : d.generator ? 'formes fournies par le générateur' : 'aucune collision';
  return (
    <div class="ap-sec">
      <h4>Collisions</h4>
      <div class="ap-seg wide">
        {[['default', 'Défaut'], ['auto', 'Auto'], ['none', 'Aucune'], ['list', 'Liste']].map(([k, l]) => <button class={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}
      </div>
      <p class="hint">
        {mode === 'default' && <>Pas de clé <code>collider</code> : {defHelp}.</>}
        {mode === 'auto' && <>Boîte englobante calculée depuis la géométrie.</>}
        {mode === 'none' && <>Aucune collision (traversable par le joueur et les balles).</>}
        {mode === 'list' && <>Formes explicites, dans l'espace de l'asset. Les boîtes ne tournent qu'autour de Y.</>}
      </p>
      {mode !== 'list' && (
        <>
          <div class="ap-parts">
            {resolved.map((x) => <div class="ap-part ro"><span class="sh">{TYPE_LABEL[x.type] ?? x.type}</span><small class="sum">{summary(x)}</small></div>)}
            {!resolved.length && <p class="hint">— aucune forme —</p>}
          </div>
          {resolved.length > 0 && <div class="btns"><button class="small" onClick={() => setMode('list')}>Convertir en liste éditable</button></div>}
        </>
      )}
      {mode === 'list' && (
        <>
          <div class="ap-row-btns">
            <button onClick={() => ses.addCollider({ type: 'box', size: [1, 1, 1], pos: [0, 0.5, 0] })} title="Ajouter une boîte">＋ Boîte</button>
            <button onClick={() => ses.addCollider({ type: 'cylinder', radius: 0.5, height: 1, pos: [0, 0.5, 0] })} title="Ajouter un cylindre">＋ Cyl.</button>
            <button onClick={() => ses.addCollider({ type: 'sphere', radius: 0.5, pos: [0, 0.5, 0] })} title="Ajouter une sphère">＋ Sph.</button>
            <button disabled={!bounds} onClick={() => ses.addCollider(boundsBox())} title="Ajouter une boîte englobant tout l'asset">＋ Englobante</button>
            <button disabled={si < 0} onClick={() => ses.duplicateCollider(si)} title="Dupliquer (Ctrl+D)">⧉</button>
            <button class="danger" disabled={si < 0} onClick={() => ses.deleteCollider(si)} title="Supprimer (Suppr)">✕</button>
          </div>
          <div class="ap-parts">
            {c.map((x, i) => (
              <div class={'ap-part' + (i === si ? ' sel' : '')} onClick={() => (A.sel.value = { kind: 'collider', i })}>
                <span class="ix">{i}</span>
                <span class="sh">{TYPE_LABEL[x.type] ?? x.type}</span>
                <small class="sum">{summary(x)}</small>
                {x.ladder && <span class="tag ladder" title="Échelle">échelle</span>}
                {x.walkable === false && <span class="tag nowalk" title="Non praticable">⊘</span>}
              </div>
            ))}
            {!c.length && <p class="hint">Liste vide : aucune collision.</p>}
          </div>
          {si >= 0 && <ColliderInspector ses={ses} i={si} c={c[si]} />}
        </>
      )}
      <p class="hint">Aperçu : vert = solide, bleu = échelle, orange = non praticable, gris = automatique, jaune = sélection. Clic dans l'aperçu (onglet Collisions) pour sélectionner une forme. Escaliers : boîtes empilées, marche ≤ 0.35 m. Portes ≥ 1.2 × 2.1 m sans collision.</p>
    </div>
  );
}

function ColliderInspector({ ses, i, c }) {
  const set = (patch, k) => ses.setCollider(i, patchObj(c, patch), `col:${i}:${k ?? Object.keys(patch).join(',')}`);
  return (
    <div class="ap-insp">
      <h4>Forme {i}</h4>
      <Row label="Type"><EnumField value={c.type} options={TYPES} onChange={(t) => t && t !== c.type && ses.setCollider(i, convert(c, t))} /></Row>
      {c.type === 'box' && <Row label="Taille (l, h, p)"><Vec3Field value={c.size ?? [1, 1, 1]} step={0.01} onChange={(v) => set({ size: v })} /></Row>}
      {c.type !== 'box' && <Row label="Rayon"><NumberField value={c.radius ?? 0.5} step={0.01} min={0} onChange={(v) => set({ radius: v })} /></Row>}
      {c.type === 'cylinder' && <Row label="Hauteur"><NumberField value={c.height ?? 1} step={0.01} min={0} onChange={(v) => set({ height: v })} /></Row>}
      <Row label="Position"><Vec3Field value={c.pos ?? [0, 0, 0]} step={0.01} onChange={(v) => set({ pos: v })} /></Row>
      {c.type === 'box' && <Row label="Rotation Y (°)"><NumberField value={c.rot?.[1] ?? 0} step={0.5} onChange={(v) => set({ rot: v ? [0, v, 0] : undefined })} /></Row>}
      {c.type === 'box' && <Row label="Échelle" title="Le joueur grimpe en marchant dedans"><BoolField value={!!c.ladder} onChange={(v) => set({ ladder: v || undefined })} /></Row>}
      {c.type === 'box' && <Row label="Praticable" title="Décocher pour empêcher de tenir debout dessus (toits pentus)"><BoolField value={c.walkable !== false} onChange={(v) => set({ walkable: v ? undefined : false })} /></Row>}
    </div>
  );
}
