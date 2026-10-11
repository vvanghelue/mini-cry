// "Asset" tab: name / label / category / material / tags, LODs, weapon points (muzzle, sight,
// magazine), the generator section (type + params form from its defaults, bake to parts), extra
// keys (vehicle wheels / seats…) and the full JSON.
import { useMemo, useState } from 'preact/hooks';
import { Row, NumberField, TextField, Vec3Field, ColorField, EnumField, BoolField, JsonField, ListField } from '../../ui/Fields.jsx';
import { GENERATORS } from '../../../engine/assets/generators.js';
import { A } from './session.js';
import { CATEGORIES, MATERIALS, POINT_KEYS, POINT_LIST_KEYS, patchObj } from './shapes.js';

const KNOWN = new Set(['name', 'category', 'label', 'material', 'tags', 'doubleSided', 'lods', 'muzzle', 'sight', 'magazine', 'generator', 'parts', 'collider']);
const DEFAULT_POINT = { muzzle: [0, 0.05, -0.6], sight: [0, 0.12, -0.1], magazine: [0, -0.05, -0.1] };
const DEFAULT_LODS = [{ distance: 160, quality: 1 }, { distance: 900, quality: 0.5 }];
const INT_PARAM = /count|segments|fronds|branches|canopy$|buttress|lianas|blobs|berries|leaves|blades|stalks|coconuts|dead|detail/i;
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');

export function AssetTab({ ses }) {
  const d = A.def.value;
  if (!d) return null;
  const set = (k, v, key) => ses.update((x) => patchObj(x, { [k]: v }), key ?? 'prop:' + k);
  const uses = ses.usage(d.name);
  const vegN = useMemo(() => ses.vegetationUsage(d.name), [d.name]);
  const showPoints = d.category === 'weapon' || POINT_KEYS.some((k) => d[k.k] !== undefined);
  return (
    <div class="ap-sec">
      <h4>Asset</h4>
      <Row label="Nom"><code class="ap-name">{d.name}</code></Row>
      <Row label="Libellé"><TextField value={d.label} placeholder="Nom affiché (français)" onChange={(v) => set('label', v || undefined)} /></Row>
      <Row label="Catégorie"><EnumField value={d.category ?? 'prop'} options={CATEGORIES} onChange={(v) => set('category', v)} /></Row>
      <Row label="Matériau" title="Matériau d'impact et de pas"><EnumField value={d.material} options={MATERIALS} allowEmpty onChange={(v) => set('material', v)} /></Row>
      <Row label="Tags"><ListField value={d.tags ?? []} onChange={(v) => set('tags', v.length ? v : undefined)} /></Row>
      <Row label="Double face" title="Rendu des deux faces (par défaut pour la végétation)"><BoolField value={d.doubleSided ?? d.category === 'vegetation'} onChange={(v) => set('doubleSided', v === (d.category === 'vegetation') ? undefined : v)} /></Row>
      <p class="hint">
        Placé {uses} fois dans le monde{vegN !== null ? ` · ${vegN} instances de végétation peinte` : ''}.{' '}
        <button class="small" onClick={() => ses.placeInWorld()} title="Retourner au monde et placer cet asset">Placer dans le monde</button>
      </p>

      <h4>Niveaux de détail (LOD)</h4>
      {!d.lods ? (
        <p class="hint">Par défaut : qualité 1 jusqu'à 160 m, 0.5 jusqu'à 900 m. <button class="small" onClick={() => set('lods', DEFAULT_LODS)}>Personnaliser</button></p>
      ) : (
        <>
          {d.lods.map((l, i) => (
            <div class="ap-lod">
              <span>jusqu'à</span>
              <NumberField value={l.distance} step={5} min={0} onChange={(v) => set('lods', d.lods.map((x, j) => (j === i ? { ...x, distance: v } : x)), `lod:${i}:d`)} />
              <span>m → qualité</span>
              <NumberField value={l.quality} step={0.01} min={0.05} max={1} onChange={(v) => set('lods', d.lods.map((x, j) => (j === i ? { ...x, quality: v } : x)), `lod:${i}:q`)} />
              <button class="icon danger" title="Retirer ce niveau" onClick={() => set('lods', d.lods.length > 1 ? d.lods.filter((_, j) => j !== i) : undefined)}>✕</button>
            </div>
          ))}
          <div class="btns">
            <button class="small" onClick={() => { const last = d.lods[d.lods.length - 1]; set('lods', [...d.lods, { distance: Math.round((last?.distance ?? 100) * 2.5), quality: Math.max(0.25, (last?.quality ?? 1) / 2) }]); }}>+ niveau</button>
            <button class="small" onClick={() => set('lods', undefined)}>Par défaut</button>
          </div>
        </>
      )}

      {showPoints && (
        <>
          <h4>Repères de l'arme</h4>
          {POINT_KEYS.map((k) => <PointRow ses={ses} d={d} k={k.k} label={k.label} color={k.color} set={set} />)}
          <p class="hint">Origine à la poignée, canon vers −Z, visée vers +Y. Cliquez ◎ (ou le repère dans l'aperçu) pour le déplacer au gizmo.</p>
        </>
      )}

      <Generator ses={ses} d={d} set={set} />
      <Extras ses={ses} d={d} set={set} />
      <FullJson ses={ses} d={d} />
    </div>
  );
}

function PointRow({ d, k, label, color, set }) {
  const v = d[k];
  const on = A.sel.value?.kind === 'point' && A.sel.value.key === k;
  return (
    <Row label={<span><i class="ap-pt" style={{ background: '#' + color.toString(16).padStart(6, '0') }} />{label}</span>}>
      {v ? (
        <>
          <Vec3Field value={v} step={0.005} onChange={(x) => set(k, x)} />
          <button class={'icon' + (on ? ' on' : '')} title="Sélectionner dans l'aperçu (gizmo)" onClick={() => (A.sel.value = { kind: 'point', key: k })}>◎</button>
          <button class="icon danger" title="Retirer" onClick={() => set(k, undefined)}>✕</button>
        </>
      ) : <button class="small" onClick={() => { set(k, DEFAULT_POINT[k] ?? [0, 0, 0]); A.sel.value = { kind: 'point', key: k }; }}>+ Ajouter</button>}
    </Row>
  );
}

// --- generator -----------------------------------------------------------------------------------
function Generator({ ses, d, set }) {
  const gen = d.generator;
  const G = gen ? GENERATORS[gen.type] : null;
  const params = gen?.params ?? {};
  const setParam = (k, v) => set('generator', { ...gen, params: patchObj(params, { [k]: v }) }, 'gen:' + k);
  const opts = Object.entries(GENERATORS).map(([k, g]) => ({ value: k, label: `${g.label} (${k})` }));
  return (
    <>
      <h4>Générateur</h4>
      <Row label="Type" title="Un générateur produit des pièces procédurales (une variante par graine)">
        <EnumField value={gen?.type ?? ''} options={opts} allowEmpty onChange={(t) => set('generator', t ? { type: t, params: t === gen?.type ? params : {} } : undefined)} />
      </Row>
      {gen && !G && <p class="err">Générateur inconnu « {gen.type} »</p>}
      {G && (
        <>
          {Object.entries(G.defaults).map(([k, dv]) => <GenParam k={k} dv={dv} v={params[k]} onChange={(v) => setParam(k, v)} />)}
          <Row label="seed" title="Graine utilisée quand aucune variante n'est imposée (le monde impose variante + 1)">
            <NumberField value={params.seed ?? 1} step={0.2} onChange={(v) => setParam('seed', Math.round(v) === 1 ? undefined : Math.round(v))} />
          </Row>
          <div class="btns">
            <button onClick={() => ses.bake()} title={`Remplace le générateur par ses pièces (variante d'aperçu ${A.view.value.variant}, qualité 1) pour les éditer à la main`}>Cuire en pièces</button>
            <button class="small" disabled={!Object.keys(params).length} onClick={() => set('generator', { ...gen, params: {} })}>Paramètres par défaut</button>
          </div>
          <p class="hint">Variante d'aperçu : {A.view.value.variant} (‹ › dans la barre de l'aperçu). Le générateur peut produire moins de pièces aux LOD bas.</p>
        </>
      )}
    </>
  );
}

function GenParam({ k, dv, v, onChange }) {
  const val = v ?? dv;
  const changed = v !== undefined && JSON.stringify(v) !== JSON.stringify(dv);
  let field;
  if (typeof dv === 'number') {
    const int = INT_PARAM.test(k) && Number.isInteger(dv);
    const step = int ? 0.1 : Math.abs(dv) >= 10 ? 0.2 : Math.abs(dv) >= 1 ? 0.02 : 0.005;
    field = <NumberField value={val} step={step} onChange={(x) => onChange(int ? Math.round(x) : x)} />;
  } else if (typeof dv === 'string' && /^#[0-9a-f]{6}$/i.test(dv)) field = <ColorField value={val} onChange={onChange} />;
  else if (Array.isArray(dv) && dv.every((x) => typeof x === 'string')) {
    field = (
      <span class="ap-colors">
        {val.map((c, i) => <input type="color" value={c} title={c} onInput={(e) => onChange(val.map((x, j) => (j === i ? e.target.value : x)))} />)}
        <button class="icon" title="Ajouter une couleur" onClick={() => onChange([...val, val[val.length - 1] ?? '#888888'])}>+</button>
        {val.length > 1 && <button class="icon" title="Retirer la dernière couleur" onClick={() => onChange(val.slice(0, -1))}>−</button>}
      </span>
    );
  } else if (isVec3(dv)) field = <Vec3Field value={val} step={0.02} onChange={onChange} />;
  else if (typeof dv === 'boolean') field = <BoolField value={val} onChange={onChange} />;
  else field = <JsonField value={val} rows={2} onChange={onChange} />;
  return (
    <Row label={<span class={changed ? 'ap-changed' : ''}>{k}</span>} title={changed ? `Défaut : ${JSON.stringify(dv)}` : 'Valeur par défaut'}>
      {field}
      {changed && <button class="icon" title={`Revenir au défaut (${JSON.stringify(dv)})`} onClick={() => onChange(undefined)}>↺</button>}
    </Row>
  );
}

// --- other keys --------------------------------------------------------------------------------
function Extras({ d, set }) {
  const keys = Object.keys(d).filter((k) => !KNOWN.has(k));
  const [nk, setNk] = useState('');
  return (
    <>
      <h4>Autres propriétés</h4>
      {keys.map((k) => {
        const v = d[k];
        const listMeta = POINT_LIST_KEYS.find((x) => x.k === k);
        let field;
        if (Array.isArray(v) && v.length && v.every(isVec3)) {
          return (
            <fieldset class="ap-pts">
              <legend>{k}{listMeta ? ` — ${listMeta.label}` : ''} <button class="icon danger" title="Retirer la propriété" onClick={() => set(k, undefined)}>✕</button></legend>
              {v.map((p, i) => (
                <div class="ap-lod">
                  <span>{i + 1}</span>
                  <Vec3Field value={p} step={0.01} onChange={(x) => set(k, v.map((q, j) => (j === i ? x : q)), `x:${k}:${i}`)} />
                  <button class="icon" title="Sélectionner dans l'aperçu (gizmo)" onClick={() => (A.sel.value = { kind: 'point', key: k, i })}>◎</button>
                  <button class="icon danger" title="Retirer" onClick={() => set(k, v.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button class="small" onClick={() => set(k, [...v, [...v[v.length - 1]]])}>+ point</button>
            </fieldset>
          );
        }
        if (typeof v === 'number') field = <NumberField value={v} step={0.01} onChange={(x) => set(k, x)} />;
        else if (typeof v === 'string') field = <TextField value={v} onChange={(x) => set(k, x)} />;
        else if (typeof v === 'boolean') field = <BoolField value={v} onChange={(x) => set(k, x)} />;
        else if (isVec3(v)) field = <Vec3Field value={v} step={0.01} onChange={(x) => set(k, x)} />;
        else field = <JsonField value={v} rows={3} onChange={(x) => set(k, x)} />;
        return <Row label={k}>{field}<button class="icon danger" title="Retirer la propriété" onClick={() => set(k, undefined)}>✕</button></Row>;
      })}
      {!keys.length && <p class="hint">Aucune (les véhicules utilisent wheels / seats).</p>}
      <div class="ap-lod">
        <input type="text" placeholder="nouvelle propriété" value={nk} onInput={(e) => setNk(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
        <button class="small" disabled={!nk || nk in d} onClick={() => { set(nk, 0); setNk(''); }}>+ Ajouter</button>
      </div>
    </>
  );
}

function FullJson({ ses, d }) {
  const [open, setOpen] = useState(false);
  return (
    <details class="ap-json" open={open} onToggle={(e) => setOpen(e.target.open)}>
      <summary>JSON complet</summary>
      {open && <JsonField value={d} rows={18} onChange={(v) => { if (v && typeof v === 'object' && !Array.isArray(v)) ses.commit({ ...v, name: d.name }); }} />}
    </details>
  );
}
