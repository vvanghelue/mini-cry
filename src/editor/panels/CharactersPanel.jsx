// Characters: preview every archetype (model(s) + palette + held weapon) animated, browse / play all
// clips (pack + retargeted UAL), aim pitch, and edit palettes live (game/archetypes.json).
import { useEffect, useRef, useState } from 'preact/hooks';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createRenderer } from '../../engine/core/Engine.js';
import { Data } from '../../engine/core/Data.js';
import { Lighting } from '../../engine/render/Lighting.js';
import { CharacterLibrary, archetypeModels } from '../../engine/anim/Characters.js';
import { AssetLibrary } from '../../engine/assets/AssetLibrary.js';
import { Row, ColorField, NumberField } from '../ui/Fields.jsx';

class CharPreview {
  constructor(canvas) {
    this.renderer = createRenderer({ canvas, antialias: true });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
    this.camera.position.set(2.2, 1.7, 3.2);
    this.lighting = new Lighting(this.renderer, this.scene, this.camera, { quality: 'medium' });
    this.lighting.setEnvironment({ timeOfDay: 10.5, dayLengthMinutes: 0, fogDensity: 0.0005, haze: { density: 0 }, motes: { intensity: 0 } });
    this.lighting.sun.setCascades([{ radius: 4, res: 1024, every: 1 }]);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 40).rotateX(-Math.PI / 2), this.lighting.material({ vertexColors: false, color: 0x8a9a6a }));
    this.scene.add(ground);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.95, 0);
    this.controls.update();
    this.clock = new THREE.Timer();
    this.speed = 1;
    this.pitch = 0;
  }

  async init() {
    await this.renderer.init();
    const loop = (t) => { this.raf = requestAnimationFrame(loop); this.frame(t); };
    this.raf = requestAnimationFrame(loop);
    const arch = await Data.json('game/archetypes.json', { fresh: true });
    const models = archetypeModels(arch.archetypes);
    this.lib = await new CharacterLibrary(this.lighting).load(models);
    this.assets = await new AssetLibrary(this.lighting).load();
    this.weapons = (await Data.json('game/weapons.json')).weapons;
    return arch;
  }

  show(arch, key, palette, model) {
    if (this.char) this.char.dispose();
    const a = arch.archetypes[key];
    model ??= a.models?.[0] ?? a.model;
    const tpl = palette ? this.lib.variant(model, palette, `${key}_${JSON.stringify(palette)}`) : model;
    const c = (this.char = this.lib.create(tpl));
    if (a.scale) c.model.scale.multiplyScalar(a.scale);
    this.scene.add(c.root);
    const w = a.weapon && this.weapons[a.weapon];
    if (w && this.assets.has(w.asset)) {
      const b = this.assets.build(w.asset, { quality: 1 });
      const mesh = new THREE.Mesh(b.geometry, this.assets.material(b));
      const holder = c.attachToHand(mesh);
      holder?.quaternion.copy(c.solveGrip('Pistol_Aim_Neutral'));
      holder?.position.copy(c.grip.R);
    }
    c.root.rotation.y = Math.PI * 0.15;
    this.play(a.weapon ? 'Idle_Gun' : 'Idle');
    return Object.keys(c.actions).sort();
  }

  play(name) { this.char?.play(name, { fade: 0.2 }); this.current = name; }

  /** Material names of a model (palette slots). */
  slots(model) {
    const t = this.lib.templates[model];
    let parts = [];
    t?.scene.traverse((o) => { if (o.isSkinnedMesh) parts = o.geometry.userData.parts ?? []; });
    return [...new Set(parts.map((p) => p.name))];
  }

  frame(t) {
    this.clock.update(t);
    const dt = Math.min(0.05, this.clock.getDelta());
    const cv = this.renderer.domElement;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.floor(w * devicePixelRatio) || cv.height !== Math.floor(h * devicePixelRatio)) {
      this.renderer.setPixelRatio(devicePixelRatio);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.lighting.update(dt, { advanceDay: false });
    if (this.char) {
      this.char.setAimPitch(this.pitch, dt);
      this.char.update(dt * this.speed);
    }
    this.scene.updateMatrixWorld();
    this.lighting.prepass(this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

export function CharactersPanel({ ed }) {
  const cv = useRef(null);
  const pv = useRef(null);
  const [arch, setArch] = useState(null);
  const [sel, setSel] = useState(null);
  const [model, setModel] = useState(null); // one of the archetype's `models`
  const [clips, setClips] = useState([]);
  const [cur, setCur] = useState(null);
  const [q, setQ] = useState('');
  const [, force] = useState(0);
  useEffect(() => {
    const p = (pv.current = new CharPreview(cv.current));
    window.__charPreview = p;
    p.init().then((a) => { setArch(a); const k = Object.keys(a.archetypes)[0]; setSel(k); });
    return () => p.dispose();
  }, []);
  const pal = (a, k) => (a.archetypes[k].palette ? a.palettes?.[a.archetypes[k].palette] : null);
  useEffect(() => {
    if (!arch || !sel || !pv.current?.lib) return;
    setClips(pv.current.show(arch, sel, pal(arch, sel), model ?? undefined));
  }, [arch, sel, model]);
  if (!arch) {
    // same tree as below so the preview canvas element is kept when the data arrives
    return (
      <div class="panel chars">
        <div class="side narrow"><h2>Characters</h2><p class="hint">Loading characters and retargeting animations…</p></div>
        <div class="main charmain"><canvas ref={cv} class="charcv" /><div class="charbar" /></div>
        <div class="side" />
      </div>
    );
  }
  const a = arch.archetypes[sel] ?? {};
  const shown = model ?? a.models?.[0] ?? a.model;
  const palName = a.palette;
  const palette = palName ? arch.palettes?.[palName] ?? {} : null;
  const setPalette = (slot, hex) => {
    const next = structuredClone(arch);
    next.palettes ??= {};
    next.palettes[palName] = { ...(next.palettes[palName] ?? {}), [slot]: hex };
    setArch(next);
    ed.stageFile('game/archetypes.json', next);
  };
  return (
    <div class="panel chars">
      <div class="side narrow">
        <h2>Characters</h2>
        <div class="list tall">{Object.entries(arch.archetypes).map(([k, x]) => <div class={'it' + (k === sel ? ' sel' : '')} onClick={() => { setSel(k); setModel(null); }}>{x.label}<small>{k}</small></div>)}</div>
        <p class="hint">Stats (health, accuracy, vision…): 📊 Gameplay tab → Enemies & NPCs.</p>
      </div>
      <div class="main charmain">
        <canvas ref={cv} class="charcv" />
        <div class="charbar">
          <span>{a.label} — model {a.models?.length > 1 ? a.models.map((m) => <button class={m === shown ? 'on' : ''} onClick={() => setModel(m)}>{m}</button>) : <b>{shown}</b>}{a.weapon ? <> · weapon <b>{a.weapon}</b></> : null} · animation <b>{cur ?? '—'}</b></span>
          <Row label="Speed"><input type="range" min="0" max="2" step="0.05" value={pv.current?.speed ?? 1} onInput={(e) => { pv.current.speed = +e.target.value; force((x) => x + 1); }} /></Row>
          <Row label="Aim up/down"><input type="range" min="-1" max="1" step="0.05" value={pv.current?.pitch ?? 0} onInput={(e) => { pv.current.pitch = +e.target.value; force((x) => x + 1); }} /></Row>
        </div>
      </div>
      <div class="side">
        <h4>Palette {palName ? `"${palName}"` : '(none)'}</h4>
        {palette ? pv.current.slots(shown).map((slot) => (
          <Row label={slot}><ColorField value={palette[slot] ?? '#888888'} onChange={(v) => setPalette(slot, v)} /></Row>
        )) : <p class="hint">This archetype keeps the model's original colours. Add a palette in 📊 Gameplay.</p>}
        {palette && <button onClick={() => setClips(pv.current.show(arch, sel, arch.palettes[palName], shown))}>Apply to preview</button>}
        <h4>Animations ({clips.length})</h4>
        <input class="search" placeholder="Filter…" value={q} onInput={(e) => setQ(e.target.value)} />
        <div class="list">
          {clips.filter((c) => !q || c.toLowerCase().includes(q.toLowerCase())).map((c) => <div class={'it' + (c === cur ? ' sel' : '')} onClick={() => { pv.current.play(c); setCur(c); }}>{c}</div>)}
        </div>
        <p class="hint">The "_Loop", Pistol_*, Crouch_*, Swim_*, Driving_Loop… animations come from the Universal Animation Library, retargeted on load; *_Aim and Aim_*_Add are derived.</p>
      </div>
    </div>
  );
}
void NumberField;
