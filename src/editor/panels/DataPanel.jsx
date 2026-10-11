// Gameplay data editor: weapons, enemy archetypes, player, items, vegetation species, ammo.
// Generic: any JSON object of records is shown as a list + a form inferred from the values
// (numbers, strings, booleans, colours, arrays of numbers, nested objects as JSON).
import { useEffect, useState } from 'preact/hooks';
import { Data } from '../../engine/core/Data.js';
import { Row, NumberField, TextField, BoolField, ColorField, JsonField, Vec3Field } from '../ui/Fields.jsx';
import { log } from '../core.js';

const FILES = [
  { file: 'game/weapons.json', path: 'weapons', label: 'Armes' },
  { file: 'game/weapons.json', path: 'ammoTypes', label: 'Munitions' },
  { file: 'game/weapons.json', path: 'grenade', label: 'Grenade', single: true },
  { file: 'game/archetypes.json', path: 'archetypes', label: 'Ennemis & PNJ' },
  { file: 'game/archetypes.json', path: 'palettes', label: 'Palettes de couleurs' },
  { file: 'game/player.json', path: '', label: 'Joueur', single: true },
  { file: 'game/items.json', path: 'items', label: 'Objets' },
  { file: 'vegetation.json', path: 'species', label: 'Espèces végétales', array: true },
  { file: 'vegetation.json', path: 'grass', label: 'Herbe', single: true },
];

const get = (o, path) => (path ? path.split('.').reduce((a, k) => a?.[k], o) : o);
function set(o, path, v) {
  if (!path) return v;
  const ks = path.split('.');
  const c = structuredClone(o);
  let x = c;
  for (const k of ks.slice(0, -1)) x = x[k];
  x[ks[ks.length - 1]] = v;
  return c;
}

export function DataPanel({ ed }) {
  const [sec, setSec] = useState(0);
  const [docs, setDocs] = useState({});
  const [key, setKey] = useState(null);
  const S = FILES[sec];
  useEffect(() => {
    if (docs[S.file]) return;
    Data.json(S.file, { fresh: true }).then((d) => setDocs((x) => ({ ...x, [S.file]: d })));
  }, [sec]);
  const doc = docs[S.file];
  if (!doc) return <div class="panel">Chargement…</div>;
  const coll = get(doc, S.path);
  const update = (newColl) => {
    const nd = set(doc, S.path, newColl);
    setDocs({ ...docs, [S.file]: nd });
    ed.stageFile(S.file, nd);
  };
  const keys = S.single ? [] : S.array ? coll.map((s, i) => i) : Object.keys(coll);
  const curKey = S.single ? null : keys.includes(key) ? key : keys[0];
  const rec = S.single ? coll : coll[curKey];
  const setRec = (r) => {
    if (S.single) return update(r);
    if (S.array) { const a = [...coll]; a[curKey] = r; return update(a); }
    update({ ...coll, [curKey]: r });
  };
  return (
    <div class="panel data">
      <div class="side narrow">
        <h2>Gameplay</h2>
        {FILES.map((f, i) => <button class={'navbtn' + (i === sec ? ' on' : '')} onClick={() => { setSec(i); setKey(null); }}>{f.label}</button>)}
        <p class="hint">Les modifications sont appliquées en jeu au prochain lancement (▶ Jouer ici). Fichier : {S.file}</p>
      </div>
      {!S.single && (
        <div class="side list">
          {keys.map((k) => <div class={'it' + (k === curKey ? ' sel' : '')} onClick={() => setKey(k)}>{S.array ? coll[k].id : k}<small>{(S.array ? coll[k] : coll[k])?.label ?? ''}</small></div>)}
          <div class="btns">
            <button onClick={() => {
              const name = S.array ? null : prompt('Identifiant du nouvel élément ?');
              if (S.array) update([...coll, structuredClone(coll[curKey] ?? {})]);
              else if (name && !coll[name]) { update({ ...coll, [name]: structuredClone(coll[curKey] ?? {}) }); setKey(name); }
            }}>+ Dupliquer</button>
            <button class="danger" onClick={() => {
              if (!confirm('Supprimer ' + curKey + ' ?')) return;
              if (S.array) update(coll.filter((_, i) => i !== curKey));
              else { const c = { ...coll }; delete c[curKey]; update(c); }
              setKey(null);
            }}>Supprimer</button>
          </div>
        </div>
      )}
      <div class="main form">
        {rec ? <RecordForm rec={rec} onChange={setRec} /> : <p>Rien à éditer.</p>}
        <div class="btns"><button onClick={() => ed.saveAll().then(() => log(`${S.file} enregistré`))}>Enregistrer</button></div>
      </div>
    </div>
  );
}

/** Form inferred from a record's values. */
export function RecordForm({ rec, onChange, depth = 0 }) {
  return (
    <div class={'rec d' + depth}>
      {Object.entries(rec).map(([k, v]) => {
        const put = (nv) => onChange({ ...rec, [k]: nv });
        let field;
        if (typeof v === 'number') field = <NumberField value={v} step={Math.abs(v) >= 50 ? 1 : Math.abs(v) >= 5 ? 0.5 : 0.01} onChange={put} />;
        else if (typeof v === 'boolean') field = <BoolField value={v} onChange={put} />;
        else if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) field = <ColorField value={v} onChange={put} />;
        else if (typeof v === 'string') field = <TextField value={v} onChange={put} />;
        else if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')) field = <Vec3Field value={v} onChange={put} />;
        else if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')) field = <span class="vec3"><NumberField value={v[0]} onChange={(n) => put([n, v[1]])} /><NumberField value={v[1]} onChange={(n) => put([v[0], n])} /></span>;
        else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1 && Object.values(v).every((x) => typeof x !== 'object' || x === null || Array.isArray(x))) return <fieldset><legend>{k}</legend><RecordForm rec={v} onChange={put} depth={depth + 1} /></fieldset>;
        else field = <JsonField value={v} onChange={put} rows={Math.min(8, JSON.stringify(v, null, 2).split('\n').length)} />;
        return <Row label={k}>{field}</Row>;
      })}
      <button class="small" onClick={() => { const k = prompt('Nouvelle propriété ?'); if (k) onChange({ ...rec, [k]: 0 }); }}>+ propriété</button>
    </div>
  );
}
