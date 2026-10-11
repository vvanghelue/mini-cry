// Island layout (terrain/layout.json): islands, mountains, plateaus, lagoons, rivers, roads,
// building sites; regenerate the heightfield and re-scatter the vegetation in the browser.
import { useEffect, useState } from 'preact/hooks';
import { Data } from '../../engine/core/Data.js';
import { generateTerrain } from '../../engine/world/TerrainGen.js';
import { scatterVegetation } from '../../engine/world/VegetationScatter.js';
import { smoothPath } from '../../engine/world/TerrainGen.js';
import { RecordForm } from './DataPanel.jsx';
import { log, S } from '../core.js';

const SECTIONS = [['islands', 'Îles'], ['mountains', 'Montagnes'], ['plateaus', 'Plateaux'], ['lagoons', 'Lagons'], ['rivers', 'Rivières'], ['roads', 'Routes'], ['flats', 'Sites aplanis']];
const TEMPLATES = {
  islands: { name: 'Île', x: 0, z: 0, rx: 150, rz: 120, rot: 0, height: 20 },
  mountains: { name: 'Montagne', x: 0, z: 0, r: 150, height: 80, ridged: 0.4 },
  plateaus: { name: 'Plateau', x: 0, z: 0, r: 60, height: 40 },
  lagoons: { name: 'Lagon', x: 0, z: 0, r: 120, depth: 2 },
  rivers: { name: 'Rivière', points: [[0, 0], [100, 100]], width: 12, depth: 2, source: 20, mouth: 0.1, bank: 24 },
  roads: { name: 'Route', points: [[0, 0], [100, 0]], width: 6 },
  flats: { name: 'Site', x: 0, z: 0, r: 20, material: 'dirt' },
};

export function TerrainPanel({ ed }) {
  const [layout, setLayout] = useState(null);
  const [sec, setSec] = useState('islands');
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState('');
  useEffect(() => { Data.json('terrain/layout.json', { fresh: true }).then(setLayout); }, []);
  if (!layout) return <div class="panel">Chargement…</div>;
  const list = layout[sec] ?? [];
  const put = (l) => { setLayout(l); ed.stageFile('terrain/layout.json', l); };
  const regenerate = async (veg) => {
    if (!confirm('Régénérer le terrain écrase la sculpture manuelle (une sauvegarde est gardée dans .mc-backup). Continuer ?')) return;
    setBusy('Génération du terrain…');
    await new Promise((r) => setTimeout(r, 30));
    const w = ed.world;
    const t = generateTerrain(layout);
    w.terrain.heights.set(t.heights);
    w.terrain.material.set(t.material);
    w.terrain.rivers = t.rivers;
    w.terrain.buildWaterGrid();
    w.terrain.invalidateColors();
    w.terrainRenderer.invalidateAll();
    w.water.buildRivers();
    ed.markDirty('terrain');
    if (veg) {
      setBusy('Répartition de la végétation…');
      await new Promise((r) => setTimeout(r, 30));
      const circles = (layout.flats ?? []).map((f) => ({ x: f.x, z: f.z, r: f.r + 4 }));
      for (const e of w.entities.list) if (e.clearRadius && e.pos) circles.push({ x: e.pos[0], z: e.pos[2], r: e.clearRadius });
      const r = scatterVegetation(w.terrain, w.vegetation.def, { circles, paths: (layout.roads ?? []).map((rd) => ({ points: smoothPath(rd.points, 6), width: rd.width })) });
      w.vegetation.rebuild(r.bytes);
      ed.markDirty('vegetation.bin');
      log(`Végétation : ${r.count} instances`);
    }
    ed._terrainChanged();
    setBusy('');
    log('Terrain régénéré (pensez à enregistrer)');
    S.version.value++;
  };
  return (
    <div class="panel split">
      <div class="side">
        <h2>Île</h2>
        <Row2 label="Graine"><input type="number" value={layout.seed} onChange={(e) => put({ ...layout, seed: +e.target.value })} /></Row2>
        <div class="tabs v">{SECTIONS.map(([k, l]) => <button class={sec === k ? 'on' : ''} onClick={() => { setSec(k); setIdx(0); }}>{l} <small>{(layout[k] ?? []).length}</small></button>)}</div>
        <div class="list">
          {list.map((it, i) => <div class={'it' + (i === idx ? ' sel' : '')} onClick={() => setIdx(i)} onDblClick={() => focus(ed, it)}>{it.name ?? `${sec} ${i}`}</div>)}
        </div>
        <div class="btns">
          <button onClick={() => { const c = ed.engine.camera.position; const t = { ...structuredClone(TEMPLATES[sec]) }; if ('x' in t) { t.x = Math.round(c.x); t.z = Math.round(c.z); } if (t.points) t.points = t.points.map((p) => [p[0] + Math.round(c.x), p[1] + Math.round(c.z)]); put({ ...layout, [sec]: [...list, t] }); setIdx(list.length); }}>+ Ajouter (à la caméra)</button>
          <button class="danger" onClick={() => { put({ ...layout, [sec]: list.filter((_, i) => i !== idx) }); setIdx(0); }}>Supprimer</button>
        </div>
        {list[idx] && <RecordForm rec={list[idx]} onChange={(r) => { const l = [...list]; l[idx] = r; put({ ...layout, [sec]: l }); }} />}
        <div class="btns">
          <button disabled={!!busy} onClick={() => regenerate(false)}>⟳ Régénérer le terrain</button>
          <button disabled={!!busy} onClick={() => regenerate(true)}>⟳ Terrain + végétation</button>
        </div>
        {busy && <p class="hint">{busy}</p>}
        <p class="hint">Double-clic sur un élément pour y placer la caméra. Les sites aplanis (« flats ») et les routes sont gardés libres de végétation.</p>
      </div>
    </div>
  );
}

function Row2({ label, children }) { return <label class="row"><span class="lbl">{label}</span><span class="val">{children}</span></label>; }

function focus(ed, it) {
  const x = it.x ?? it.points?.[0]?.[0], z = it.z ?? it.points?.[0]?.[1];
  if (x === undefined) return;
  const h = ed.world.terrain.heightAt(x, z);
  ed.engine.camera.position.set(x + 60, h + 70, z + 60);
  ed.fly.lookAt(new ed.THREE.Vector3(x, h, z));
}
