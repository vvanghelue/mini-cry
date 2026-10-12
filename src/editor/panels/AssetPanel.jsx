// Asset editor: visual editor for the JSON models (public/data/assets/*.json).
//   left   : asset browser (search, category, thumbnails, tris) + New / Duplicate / Delete
//   centre : live 3D preview (orbit, gizmo, colliders, markers, LOD, variant, stats)
//   right  : tabs Asset (properties, LOD, weapon points, generator), Parts (list + inspector),
//            Colliders (mode + list + inspector)
// Every edit rebuilds the preview, is pushed live into the running world (AssetLibrary.set +
// re-batched props) and stages assets/<name>.json for 💾 Save. Ctrl+Z / Ctrl+Y undo inside
// the panel (history per asset). State lives in asset/session.js and survives panel switches.
import { useEffect, useMemo } from 'preact/hooks';
import { A, getSession, setView } from './asset/session.js';
import { Browser } from './asset/Browser.jsx';
import { PreviewView } from './asset/PreviewView.jsx';
import { AssetTab } from './asset/Props.jsx';
import { PartsTab } from './asset/Parts.jsx';
import { CollidersTab } from './asset/Colliders.jsx';

export function AssetPanel({ ed }) {
  const ses = useMemo(() => getSession(ed), [ed]);
  useEffect(() => {
    if (!A.name.value || !ses.lib.has(A.name.value)) { A.name.value = null; ses.open(ses.lib.has('crate') ? 'crate' : ses.names[0]); }
    const flyWas = ed.fly?.enabled;
    if (ed.fly) ed.fly.enabled = false; // WASD must not fly the hidden world camera
    const onKey = (e) => {
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      let handled = true;
      if (ctrl && e.code === 'KeyZ') e.shiftKey ? ses.redo() : ses.undo();
      else if (ctrl && e.code === 'KeyY') ses.redo();
      else if (ctrl && e.code === 'KeyD') ses.duplicateSelection();
      else if (ctrl && e.code === 'KeyS') { ses.flushLive(); handled = false; } // the core saves
      else if (ctrl || e.altKey) handled = false;
      else if (e.code === 'Delete' || e.code === 'Backspace') ses.deleteSelection();
      else if (e.code === 'KeyW') setView({ gizmo: 'translate' });
      else if (e.code === 'KeyE') setView({ gizmo: 'rotate' });
      else if (e.code === 'KeyR') setView({ gizmo: 'scale' });
      else if (e.code === 'KeyF') ses.preview?.frame();
      else if (e.code === 'Escape') A.sel.value = null;
      else if (e.code === 'KeyG' || e.code === 'KeyQ') { /* world shortcuts: swallowed */ }
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    // any click first pushes a pending edit (so 💾 Save always saves the latest version)
    const onDown = () => ses.flushLive();
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onDown, true);
    return () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('pointerdown', onDown, true);
      if (ed.fly) ed.fly.enabled = flyWas ?? true;
      ses.flushLive();
    };
  }, []);

  const d = A.def.value;
  const tab = A.tab.value;
  const tabs = [
    ['asset', 'Asset', 'Properties, LOD, generator'],
    ['parts', `Parts (${d?.parts?.length ?? 0})`, 'Part list and inspector'],
    ['colliders', `Colliders${Array.isArray(d?.collider) ? ` (${d.collider.length})` : d?.collider ? ` (${d.collider === 'none' ? 0 : d.collider})` : ''}`, 'Collision shapes'],
  ];
  return (
    <div class="ap">
      <Browser ses={ses} />
      <div class="ap-center">
        <Header ses={ses} />
        <PreviewView ses={ses} />
      </div>
      <div class="ap-right">
        <div class="ap-tabs">
          {tabs.map(([k, l, t]) => <button class={tab === k ? 'on' : ''} title={t} onClick={() => (A.tab.value = k)}>{l}</button>)}
        </div>
        <div class="ap-scroll">
          {!d && <p class="hint">Select an asset in the list.</p>}
          {d && tab === 'asset' && <AssetTab ses={ses} />}
          {d && tab === 'parts' && <PartsTab ses={ses} />}
          {d && tab === 'colliders' && <CollidersTab ses={ses} />}
        </div>
      </div>
    </div>
  );
}

function Header({ ses }) {
  const d = A.def.value, name = A.name.value;
  void A.hist.value;
  const dirty = name && ses.isDirty(name);
  return (
    <div class="ap-head">
      <b class="ap-title">{d?.label ?? name ?? '—'}</b>
      {name && <code>{name}.json</code>}
      {dirty && <span class="ap-dirty" title="Changes applied to the world but not saved yet (💾 Save or Ctrl+S)">● unsaved</span>}
      <span class="grow" />
      <button title="Undo (Ctrl+Z)" disabled={!ses.canUndo} onClick={() => ses.undo()}>↶ Undo</button>
      <button title="Redo (Ctrl+Y)" disabled={!ses.canRedo} onClick={() => ses.redo()}>↷</button>
    </div>
  );
}
