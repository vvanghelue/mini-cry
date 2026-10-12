// Centre column: the live 3D preview (asset/Preview.js) + toolbar (gizmo mode, toggles, LOD,
// variant) + stats overlay. Rebuilds on every definition / view change (next frame, or debounced
// 60 ms when the last build was slow) and recomputes the per-LOD stats a bit later.
import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import { buildAsset, resolveParts } from '../../../engine/assets/ModelBuilder.js';
import { A, setView } from './session.js';
import { AssetPreview } from './Preview.js';
import { rnd } from './shapes.js';

const BUDGET = { prop: 400, building: 1500, vegetation: 1500, vehicle: 1500, weapon: 600, pickup: 300, fx: 400 };

export function PreviewView({ ses }) {
  const host = useRef(null);
  useEffect(() => {
    const p = new AssetPreview(host.current, {
      onSelect: (sel) => {
        A.sel.value = sel;
        if (sel?.kind === 'part') A.tab.value = 'parts';
        else if (sel?.kind === 'collider') A.tab.value = 'colliders';
        else if (sel?.kind === 'point') A.tab.value = 'asset';
      },
      onGizmo: (sel, patch, id) => ses.applyGizmo(sel, patch, id),
      newDragId: () => ses.newDragId(),
    });
    ses.preview = p;
    let framed = null, timer = 0, raf = 0, statsTimer = 0, lastDef = null, lastKey = '';
    const opts = (def, v) => ({ quality: v.quality, seed: v.variant + 1, assets: { ...ses.lib.defs, [def.name]: def } });
    const stats = () => {
      const def = A.def.peek(), v = A.view.peek();
      if (!def) return;
      const tris = {};
      let size = null, colliders = 0, gen = 0;
      for (const q of [1, 0.5, 0.25]) {
        try {
          const b = buildAsset(def, { ...opts(def, v), quality: q });
          tris[q] = b.triangles;
          if (q === 1) { const s = b.bounds.isEmpty() ? null : b.bounds.max.clone().sub(b.bounds.min); size = s && [rnd(s.x, 2), rnd(s.y, 2), rnd(s.z, 2)]; colliders = b.colliders.length; }
          b.geometry.dispose();
        } catch { tris[q] = null; }
      }
      try { if (def.generator) gen = resolveParts(def, opts(def, v).assets, v.variant + 1, 1).length - (def.parts?.length ?? 0); } catch { /* shown as error */ }
      A.stats.value = { tris, size, colliders, parts: def.parts?.length ?? 0, gen, ms: p.lastMs };
    };
    const rebuild = () => {
      timer = raf = 0;
      const def = A.def.peek(), v = A.view.peek();
      if (!def) return;
      const r = p.build(def, opts(def, v));
      if (r.error) { A.err.value = r.error; return; }
      p.lastMs = r.ms;
      A.err.value = null;
      p.setSelection(def, A.sel.peek());
      if (framed !== A.name.peek()) { framed = A.name.peek(); p.frame(); }
      clearTimeout(statsTimer);
      statsTimer = setTimeout(stats, p.dragging ? 400 : 180);
    };
    const offs = [
      effect(() => {
        const def = A.def.value, v = A.view.value;
        const key = `${v.quality}|${v.variant}`;
        if (!def || (def === lastDef && key === lastKey)) return;
        lastDef = def;
        lastKey = key;
        if ((p.lastMs ?? 0) > 12) { clearTimeout(timer); cancelAnimationFrame(raf); raf = 0; timer = setTimeout(rebuild, 60); }
        else if (!raf && !timer) raf = requestAnimationFrame(rebuild);
      }),
      effect(() => { const sel = A.sel.value; if (A.def.peek()) p.setSelection(A.def.peek(), sel); }),
      effect(() => p.setOptions(A.view.value)),
      effect(() => { p.pickColliders = A.tab.value === 'colliders'; }),
    ];
    return () => {
      offs.forEach((f) => f());
      clearTimeout(timer);
      clearTimeout(statsTimer);
      cancelAnimationFrame(raf);
      p.dispose();
      ses.preview = null;
    };
  }, []);

  const v = A.view.value;
  const tg = (k, label, title) => <button class={'tgl' + (v[k] ? ' on' : '')} title={title} onClick={() => setView({ [k]: !v[k] })}>{label}</button>;
  return (
    <>
      <div class="ap-toolbar">
        <span class="ap-seg">
          {[['translate', '✥', 'Move (W)'], ['rotate', '⟳', 'Rotate (E)'], ['scale', '⤢', 'Scale (R)']].map(([m, ic, t]) => <button class={v.gizmo === m ? 'on' : ''} title={t} onClick={() => setView({ gizmo: m })}>{ic}</button>)}
        </span>
        <button class="tgl" title="Gizmo space (global = asset axes, local = part axes)" onClick={() => setView({ space: v.space === 'local' ? 'world' : 'local' })}>{v.space === 'local' ? 'Local' : 'Global'}</button>
        {tg('snap', 'Snap', 'Snap: grid step / 15°')}
        <span class="sep" />
        {tg('wire', 'Wireframe', 'Show the triangle edges')}
        {tg('colliders', 'Colliders', 'Show the collision shapes (green solid, blue ladder, orange not walkable, grey automatic)')}
        {tg('markers', 'Markers', 'Muzzle / sight / magazine markers, wheels, seats')}
        {tg('wind', 'Wind', 'Color by wind weight (blue rigid → red flexible)')}
        {tg('turntable', 'Turntable', 'Automatic camera rotation')}
        <span class="sep" />
        <span class="ap-lbl">LOD</span>
        <span class="ap-seg">{[1, 0.5, 0.25].map((q) => <button class={v.quality === q ? 'on' : ''} title={`Quality ${q}`} onClick={() => setView({ quality: q })}>{q}</button>)}</span>
        <span class="ap-lbl" title="Variant (seed) for generators: the world uses variants 0…n-1">Var.</span>
        <span class="ap-seg">
          <button title="Previous variant" onClick={() => setView({ variant: Math.max(0, v.variant - 1) })}>‹</button>
          <button class="ap-var" title="Preview variant (seed = variant + 1)" onClick={() => setView({ variant: 0 })}>{v.variant}</button>
          <button title="Next variant" onClick={() => setView({ variant: v.variant + 1 })}>›</button>
        </span>
        <button title="Frame the asset (F) — double-click: frame the selection" onClick={() => ses.preview?.frame()}>⌖</button>
      </div>
      <div class="ap-view">
        <div class="ap-host" ref={host} />
        <Stats />
        {A.err.value && <div class="ap-err">⚠ {A.err.value}</div>}
        <div class="ap-help">Click: select · Drag: orbit · Right-click: pan · Wheel: zoom · Double-click: frame · W/E/R: gizmo · Del · Ctrl+D · Ctrl+Z/Y</div>
      </div>
    </>
  );
}

function Stats() {
  const st = A.stats.value, d = A.def.value;
  if (!st || !d) return null;
  const budget = BUDGET[d.category ?? 'prop'] ?? 1000;
  const t = st.tris;
  const mode = Array.isArray(d.collider) ? 'list' : d.collider ?? 'default';
  return (
    <div class="ap-stats">
      <span title={`Triangles per LOD quality (recommended budget for ${d.category ?? 'prop'}: ${budget})`}>Triangles <b class={t[1] > budget ? 'over' : ''}>{t[1] ?? '—'}</b> · ½ {t[0.5] ?? '—'} · ¼ {t[0.25] ?? '—'}</span>
      {st.size && <span>Size {st.size[0]} × {st.size[1]} × {st.size[2]} m</span>}
      <span>Parts {st.parts}{st.gen ? ` + ${st.gen} generated` : ''}</span>
      <span>Colliders {st.colliders} ({mode})</span>
      {st.ms !== undefined && <span class="dim">{st.ms.toFixed(1)} ms</span>}
    </div>
  );
}
