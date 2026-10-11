// Editor layout: top bar (panels, save, play), left (tools + outliner), centre (3D viewport or a
// full panel), right (inspector), bottom (content browser + console), status bar.
import { useEffect, useRef, useState } from 'preact/hooks';
import { S } from '../core.js';
import { ToolPalette, Outliner, Inspector, ContentBrowser } from './WorldUI.jsx';
import { PANELS } from '../panels/index.js';

export function App({ ed }) {
  const vp = useRef(null);
  useEffect(() => { ed.init(vp.current).catch((e) => { S.loading.value = 'Erreur : ' + e.message; console.error(e); }); }, []);
  const panel = S.panel.value;
  const ready = S.ready.value;
  const P = PANELS.find((p) => p.id === panel);
  return (
    <div class={'ed' + (panel !== 'world' ? ' panel-mode' : '')}>
      <TopBar ed={ed} />
      <div class="left">{ready && panel === 'world' && <><ToolPalette ed={ed} /><Outliner ed={ed} /></>}</div>
      <div class="center">
        <div class="viewport" ref={vp} />
        {!ready && <div class="loading">{S.loading.value}</div>}
        {ready && P && P.component && <div class="fullpanel"><P.component ed={ed} /></div>}
      </div>
      <div class="right">{ready && panel === 'world' && <Inspector ed={ed} />}</div>
      <div class="bottom">{ready && panel === 'world' && <ContentBrowser ed={ed} />}</div>
      <StatusBar ed={ed} />
    </div>
  );
}

function TopBar({ ed }) {
  const dirty = Object.keys(S.dirty.value);
  return (
    <div class="top">
      <span class="brand">MINI<b>CRY</b> <small>éditeur</small></span>
      <nav>
        {PANELS.map((p) => <button class={S.panel.value === p.id ? 'on' : ''} title={p.help} onClick={() => (S.panel.value = p.id)}>{p.icon} {p.label}</button>)}
      </nav>
      <span class="grow" />
      <label class="tg" title="Afficher les aides (zones, chemins, marqueurs)"><input type="checkbox" checked={S.helpers.value} onChange={(e) => (S.helpers.value = e.target.checked)} /> Aides</label>
      <label class="tg" title="Magnétisme de la grille (m)">Grille <select value={S.snap.value.grid} onChange={(e) => (S.snap.value = { ...S.snap.value, grid: +e.target.value })}>{[0, 0.25, 0.5, 1, 2, 5].map((g) => <option value={g}>{g || 'off'}</option>)}</select></label>
      <button title="Annuler (Ctrl+Z)" onClick={() => ed.undo()}>↶</button>
      <button title="Rétablir (Ctrl+Y)" onClick={() => ed.redo()}>↷</button>
      <button class={'save' + (dirty.length ? ' dirty' : '')} title={dirty.join('\n') || 'Tout est enregistré'} onClick={() => ed.saveAll()}>💾 Enregistrer{dirty.length ? ` (${dirty.length})` : ''}</button>
      <button class="play" title="Jouer depuis la caméra (ouvre le jeu)" onClick={() => ed.playHere()}>▶ Jouer ici</button>
      <button title="Jouer depuis le début" onClick={() => ed.playFromStart()}>▶▶</button>
    </div>
  );
}

function StatusBar() {
  const [showLog, setShowLog] = useState(false);
  const logs = S.log.value;
  const last = logs[logs.length - 1];
  const p = S.perf.value;
  const c = S.cursor.value;
  return (
    <div class="status">
      <span class={'msg ' + (last?.level ?? '')} onClick={() => setShowLog(!showLog)} title="Afficher la console">{last ? `${last.t}  ${last.msg}` : 'Prêt'}</span>
      <span class="grow" />
      {c && <span>curseur {c.join(', ')}</span>}
      <span>caméra {S.camInfo.value}</span>
      {p && <span>{p.fps.toFixed(0)} fps · gpu {p.gpuMs ?? '-'} ms · {p.calls} appels · {(p.triangles / 1000).toFixed(0)}k tris</span>}
      {showLog && (
        <div class="console" onClick={(e) => e.stopPropagation()}>
          {logs.slice().reverse().map((l) => <div class={l.level}>{l.t} {l.msg}</div>)}
        </div>
      )}
    </div>
  );
}
