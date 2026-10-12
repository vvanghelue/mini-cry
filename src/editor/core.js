// Editor core (no UI): engine + world in editor mode, camera, picking, gizmo, placement, terrain /
// paint / foliage brushes, path editing, undo / redo, saving, and the live commands the agent CLI
// uses (`mc live ...`). The Preact UI (ui/*.jsx) only reads the signals in S and calls methods.
import * as THREE from 'three';
import { signal } from '@preact/signals';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Engine } from '../engine/core/Engine.js';
import { Input } from '../engine/core/Input.js';
import { FlyCamera } from '../engine/core/FlyCamera.js';
import { Live } from '../engine/core/Live.js';
import { Data } from '../engine/core/Data.js';
import { World } from '../engine/world/World.js';
import { ENTITY_TYPES, validateEntity } from '../engine/world/Entities.js';
import { MATERIAL_ID, TERRAIN_MATERIALS } from '../engine/world/TerrainData.js';
import { LAYERS } from '../engine/render/layers.js';
import { restOnGround, VEHICLE_KINDS } from '../game/entities/index.js';

const D2R = Math.PI / 180;

export const S = {
  ready: signal(false),
  loading: signal('Loading…'),
  selection: signal([]),
  tool: signal('select'), // select | place | sculpt | paint | foliage | path
  gizmo: signal('translate'), // translate | rotate | scale
  brush: signal({ op: 'raise', radius: 14, strength: 0.5, falloff: 0.5, material: 'grass', species: 0, density: 0.3, erase: false, height: null }),
  place: signal(null), // { type, asset? , archetype? , item? }
  panel: signal('world'),
  dirty: signal({}),
  log: signal([]),
  version: signal(0),
  cursor: signal(null),
  snap: signal({ grid: 0, angle: 15, ground: true }),
  helpers: signal(true),
  camInfo: signal(''),
  perf: signal(null),
  paths: signal({ editing: null }),
};

export function log(msg, level = 'info') {
  S.log.value = [...S.log.value.slice(-80), { msg, level, t: new Date().toLocaleTimeString() }];
  if (level === 'error') console.error(msg); else console.info('[editor]', msg);
}

export class EditorCore {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
    this.THREE = THREE;
  }

  async init(container) {
    const params = new URLSearchParams(location.search);
    const engine = (this.engine = new Engine({ container, quality: params.get('quality') ?? 'medium' }));
    engine.camera.layers.enable(LAYERS.EDITOR);
    engine.dynamicResolution.enabled = false;
    this.input = new Input(engine.canvas);
    this.input.requireLock = false;
    const world = (this.world = new World(engine, { mode: 'editor' }));
    await world.load({ onProgress: (p, l) => (S.loading.value = `Loading: ${l} (${Math.round(p * 100)}%)`) });
    world.advanceDay = false;
    engine.addSystem(world);
    // items data for pickups previews
    world.itemsData = await Data.jsonOr('game/items.json', { items: {} });
    world.archetypes = await Data.jsonOr('game/archetypes.json', { archetypes: {} });
    world.entities.createPending();

    // camera
    this.fly = new FlyCamera(engine.camera, this.input, { speed: 35 });
    this.fly.lookActive = () => this.rmb;
    const p = world.data.player?.pos ?? [0, 50, 0];
    this.fly.setFrom(new THREE.Vector3(p[0] + 20, p[1] + 25, p[2] + 30), 0.6, -0.5);
    if (params.get('cam')) { const c = params.get('cam').split(',').map(Number); this.fly.setFrom(new THREE.Vector3(c[0], c[1], c[2]), c[3] ?? 0, c[4] ?? 0); }
    this._initPointer();
    this._initGizmo();
    this._initBrushCursor();
    engine.addSystem({ update: (dt) => this.update(dt) });
    engine.start();
    this.live = new Live('editor', this);
    this._registerLive();
    import.meta.hot?.on('mc:data-changed', (d) => this._externalChange(d.path));
    world.entities.on('change', () => (S.version.value++));
    S.ready.value = true;
    log(`World loaded: ${world.entities.list.length} entities, ${world.vegetation.data.n} plants`);
    window.__mc = { engine, world, editor: this, THREE, ready: true };
  }

  // --- camera / pointer ---------------------------------------------------------------------
  _initPointer() {
    const c = this.engine.canvas;
    this.rmb = false;
    this.mouse = new THREE.Vector2();
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      if (e.button === 2) { this.rmb = true; c.setPointerCapture(e.pointerId); this.input.mouseDX = this.input.mouseDY = 0; return; }
      if (e.button === 0) this._leftDown(e);
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      if (this.rmb) { this.input.mouseDX += e.movementX; this.input.mouseDY += e.movementY; }
    });
    addEventListener('pointerup', (e) => {
      if (e.button === 2) this.rmb = false;
      if (e.button === 0) this._leftUp();
    });
    c.addEventListener('wheel', (e) => {
      if (S.tool.value !== 'select' && S.tool.value !== 'place' && S.tool.value !== 'path' && e.altKey) {
        const b = S.brush.value;
        S.brush.value = { ...b, radius: Math.max(1, Math.min(200, b.radius * (e.deltaY > 0 ? 0.9 : 1.1))) };
        return;
      }
      if (S.place.value && e.shiftKey) { this.placeYaw = (this.placeYaw ?? 0) + Math.sign(e.deltaY) * 15; return; }
      const fwd = this.engine.camera.getWorldDirection(new THREE.Vector3());
      this.engine.camera.position.addScaledVector(fwd, -Math.sign(e.deltaY) * Math.max(2, this.fly.speed * 0.15));
    }, { passive: true });
    addEventListener('keydown', (e) => this._key(e));
  }

  _key(e) {
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
    if (ctrl && e.code === 'KeyS') { e.preventDefault(); this.saveAll(); return; }
    if (ctrl && e.code === 'KeyD') { e.preventDefault(); this.duplicate(); return; }
    if (this.rmb) return; // WASD flies
    if (e.code === 'Delete' || e.code === 'Backspace') { if (S.tool.value === 'path') this.pathPop(); else this.deleteSelection(); }
    if (e.code === 'KeyF') this.frameSelection();
    if (e.code === 'KeyW') S.gizmo.value = 'translate';
    if (e.code === 'KeyE') S.gizmo.value = 'rotate';
    if (e.code === 'KeyR') S.gizmo.value = 'scale';
    if (e.code === 'Escape') { S.place.value = null; S.tool.value = 'select'; this.select([]); }
    if (e.code === 'KeyG') this.dropToGround();
  }

  ray() { return this.engine.rayFromNdc(this.mouse.x, this.mouse.y); }

  /** World point under the mouse (terrain / shapes). */
  groundHit(ray = this.ray()) {
    const h = this.world.physics.raycast(ray.origin, ray.direction, 4000, { water: false });
    return h ? new THREE.Vector3(h.x, h.y, h.z) : null;
  }

  /** Entity under the mouse: entity objects (proxies, helpers, dynamic meshes) + batched props. */
  pickEntity(ray = this.ray()) {
    const rc = new THREE.Raycaster(ray.origin, ray.direction, 0, 3000);
    rc.layers.enableAll();
    const objs = [];
    for (const h of this.world.entities.handles.values()) if (h.object?.visible !== false && h.object) objs.push(h.object);
    let best = null, bd = Infinity;
    for (const hit of rc.intersectObjects(objs, true)) {
      let o = hit.object;
      while (o && o.userData.entityId === undefined) o = o.parent;
      if (o && hit.distance < bd) { bd = hit.distance; best = o.userData.entityId; }
    }
    const prop = this.world.entities.props?.pick(ray, bd);
    if (prop) {
      const pd = ray.origin.distanceTo(new THREE.Vector3(prop.matrix[12], prop.matrix[13], prop.matrix[14]));
      if (pd < bd) best = prop.id;
    }
    return best;
  }

  _leftDown(e) {
    const tool = S.tool.value;
    if (this.gizmo.dragging || this.gizmo.axis) return;
    if (S.place.value) { this.placeAtCursor(e.shiftKey); return; }
    if (tool === 'select') {
      const id = this.pickEntity();
      if (e.shiftKey && id) this.select(S.selection.value.includes(id) ? S.selection.value.filter((x) => x !== id) : [...S.selection.value, id]);
      else this.select(id ? [id] : []);
      return;
    }
    if (tool === 'sculpt' || tool === 'paint' || tool === 'foliage') { this._strokeBegin(); return; }
    if (tool === 'path') this.pathAdd();
  }

  _leftUp() { if (this.stroke) this._strokeEnd(); }

  frameSelection() {
    const e = this.world.entities.get(S.selection.value[0]);
    if (!e?.pos) return;
    const t = new THREE.Vector3(...e.pos);
    const cam = this.engine.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    cam.position.copy(t).addScaledVector(dir, -18).add(new THREE.Vector3(0, 4, 0));
    this.fly.lookAt(t);
  }

  // --- selection & gizmo ------------------------------------------------------------------------
  select(ids) {
    S.selection.value = ids.filter((id) => this.world.entities.get(id));
    this._attachGizmo();
    this._updateSelectionBox();
  }

  _initGizmo() {
    const g = (this.gizmo = new TransformControls(this.engine.camera, this.engine.canvas));
    this.gizmoTarget = new THREE.Object3D();
    this.engine.scene.add(this.gizmoTarget);
    const helper = g.getHelper();
    this.engine.scene.add(helper);
    g.addEventListener('dragging-changed', (ev) => {
      if (ev.value) this._dragStart = S.selection.value.map((id) => structuredClone(this.world.entities.get(id)));
      else this._commitGizmo();
    });
    g.addEventListener('objectChange', () => this._gizmoMoved());
    S.gizmo.subscribe((m) => g.setMode(m));
    S.snap.subscribe((s) => { g.setTranslationSnap(s.grid || null); g.setRotationSnap(s.angle ? s.angle * D2R : null); });
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0xffd34d);
    this.selBox.layers.set(LAYERS.EDITOR);
    this.selBox.visible = false;
    this.engine.scene.add(this.selBox);
  }

  _attachGizmo() {
    const e = this.world.entities.get(S.selection.value[0]);
    if (!e?.pos || S.tool.value !== 'select') { this.gizmo.detach(); return; }
    this.gizmoTarget.position.fromArray(e.pos);
    const r = e.rot ?? [0, 0, 0];
    this.gizmoTarget.rotation.set(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'YXZ');
    this.gizmoTarget.scale.setScalar(typeof e.scale === 'number' ? e.scale : 1);
    this.gizmo.attach(this.gizmoTarget);
  }

  _updateSelectionBox() {
    const ids = S.selection.value;
    if (!ids.length) { this.selBox.visible = false; return; }
    const box = new THREE.Box3();
    for (const id of ids) {
      const h = this.world.entities.handle(id);
      if (h?.object) box.expandByObject(h.object);
      else {
        const e = this.world.entities.get(id);
        if (e?.type === 'prop' && this.world.assets.has(e.asset)) {
          const b = this.world.assets.build(e.asset).bounds.clone();
          const m = new THREE.Matrix4().compose(new THREE.Vector3(...e.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(e.rot ?? [0, 0, 0]).map((v) => v * D2R), 'YXZ')), new THREE.Vector3().setScalar(e.scale ?? 1));
          box.union(b.applyMatrix4(m));
        } else if (e?.pos) box.expandByPoint(new THREE.Vector3(...e.pos));
      }
    }
    this.selBox.box.copy(box.expandByScalar(0.1));
    this.selBox.visible = true;
  }

  _gizmoMoved() {
    // live preview: move the first selected entity (others follow by the same delta)
    const t = this.gizmoTarget;
    const ids = S.selection.value;
    const first = this._dragStart?.[0];
    if (!first) return;
    const d = [t.position.x - first.pos[0], t.position.y - first.pos[1], t.position.z - first.pos[2]];
    const rot = [t.rotation.x / D2R, t.rotation.y / D2R, t.rotation.z / D2R].map((v) => Math.round(v * 100) / 100);
    ids.forEach((id, i) => {
      const s0 = this._dragStart[i];
      const pos = [s0.pos[0] + d[0], s0.pos[1] + d[1], s0.pos[2] + d[2]].map((v) => Math.round(v * 1000) / 1000);
      if (S.snap.value.ground && S.gizmo.value === 'translate' && Math.abs(d[1]) < 1e-6) pos[1] = +this.world.terrain.heightAt(pos[0], pos[2]).toFixed(3);
      const patch = { pos };
      if (S.gizmo.value === 'rotate') patch.rot = i === 0 ? rot : s0.rot;
      if (S.gizmo.value === 'scale') patch.scale = +(t.scale.x).toFixed(3);
      const h = this.world.entities.handle(id);
      if (h?.object && h.object.userData.entityId === id && !h.actor) {
        h.object.position.fromArray(pos);
        if (patch.rot) h.object.rotation.set(patch.rot[0] * D2R, patch.rot[1] * D2R, patch.rot[2] * D2R, 'YXZ');
        if (patch.scale) h.object.scale.setScalar(patch.scale);
        this._pendingPatch = { ...(this._pendingPatch ?? {}), [id]: patch };
      } else {
        this._pendingPatch = { ...(this._pendingPatch ?? {}), [id]: patch };
        this._throttledApply();
      }
    });
    this._updateSelectionBox();
  }

  _throttledApply() {
    if (this._applyQueued) return;
    this._applyQueued = true;
    requestAnimationFrame(() => {
      this._applyQueued = false;
      for (const [id, patch] of Object.entries(this._pendingPatch ?? {})) this.world.entities.patch(id, patch);
      this._pendingPatch = {};
    });
  }

  _commitGizmo() {
    const before = this._dragStart ?? [];
    for (const [id, patch] of Object.entries(this._pendingPatch ?? {})) this.world.entities.patch(id, patch);
    this._pendingPatch = {};
    const after = S.selection.value.map((id) => structuredClone(this.world.entities.get(id)));
    if (JSON.stringify(before) !== JSON.stringify(after)) this.pushUndo({ label: 'Transform', undo: () => before.forEach((e) => this.world.entities.set(e.id, e)), redo: () => after.forEach((e) => this.world.entities.set(e.id, e)) });
    this.markDirty('world.json');
    this._dragStart = null;
    this._attachGizmo();
    this._updateSelectionBox();
  }

  // --- entity commands (undoable) -------------------------------------------------------------
  pushUndo(cmd) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    S.version.value++;
  }

  undo() {
    const c = this.undoStack.pop();
    if (!c) return;
    c.undo();
    this.redoStack.push(c);
    log(`Undo: ${c.label}`);
    this._afterChange(c);
  }

  redo() {
    const c = this.redoStack.pop();
    if (!c) return;
    c.redo();
    this.undoStack.push(c);
    log(`Redo: ${c.label}`);
    this._afterChange(c);
  }

  _afterChange(c) {
    this.markDirty(c.file ?? 'world.json');
    this.select(S.selection.value);
    S.version.value++;
  }

  addEntity(data, { select = true } = {}) {
    const e = this.world.entities.add(data);
    const snap = structuredClone(e);
    this.pushUndo({ label: `Add ${e.id}`, undo: () => this.world.entities.remove(snap.id), redo: () => this.world.entities.add(structuredClone(snap)) });
    this.markDirty('world.json');
    if (select) this.select([e.id]);
    return e;
  }

  updateEntity(id, data) {
    const before = structuredClone(this.world.entities.get(id));
    if (!before) return null;
    const errs = validateEntity({ ...data, id: data.id ?? id });
    if (errs.length) log(`${id}: ${errs.join(', ')}`, 'warn');
    const e = this.world.entities.set(id, data);
    const after = structuredClone(e);
    this.pushUndo({ label: `Edit ${id}`, undo: () => { this.world.entities.remove(after.id); this.world.entities.add(structuredClone(before)); }, redo: () => { this.world.entities.remove(before.id); this.world.entities.add(structuredClone(after)); } });
    this.markDirty('world.json');
    if (after.id !== id) this.select([after.id]); else this._updateSelectionBox();
    return e;
  }

  deleteSelection() {
    const ids = S.selection.value;
    if (!ids.length) return;
    const snaps = ids.map((id) => structuredClone(this.world.entities.get(id))).filter(Boolean);
    for (const s of snaps) this.world.entities.remove(s.id);
    this.pushUndo({ label: `Delete ${snaps.length}`, undo: () => snaps.forEach((s) => this.world.entities.add(structuredClone(s))), redo: () => snaps.forEach((s) => this.world.entities.remove(s.id)) });
    this.markDirty('world.json');
    this.select([]);
  }

  duplicate() {
    const ids = S.selection.value;
    const out = [];
    for (const id of ids) {
      const e = structuredClone(this.world.entities.get(id));
      if (!e) continue;
      delete e.id;
      e.pos = [e.pos[0] + 2, e.pos[1], e.pos[2] + 2];
      e.pos[1] = this.world.terrain.heightAt(e.pos[0], e.pos[2]);
      out.push(this.addEntity(e, { select: false }).id);
    }
    this.select(out);
  }

  dropToGround() {
    for (const id of S.selection.value) {
      const e = this.world.entities.get(id);
      if (!e?.pos) continue;
      this.updateEntity(id, { ...e, pos: [e.pos[0], +this.world.terrain.heightAt(e.pos[0], e.pos[2]).toFixed(3), e.pos[2]] });
    }
  }

  // --- placement ------------------------------------------------------------------------------
  startPlace(spec) {
    S.place.value = spec;
    S.tool.value = 'select';
    this.gizmo.detach();
    this._makeGhost(spec);
  }

  _makeGhost(spec) {
    this.ghost?.removeFromParent();
    this.ghost = null;
    if (!spec) return;
    let obj;
    const assets = this.world.assets;
    const assetName = spec.asset ?? (spec.type === 'pickup' ? this.world.itemsData.items[spec.item]?.asset : spec.type === 'vehicle' ? VEHICLE_KINDS[spec.vehicle ?? 'jeep']?.asset : null);
    if (assetName && assets.has(assetName)) {
      const b = assets.build(assetName);
      obj = new THREE.Mesh(b.geometry, new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.45, wireframe: false, depthWrite: false }));
      if (spec.still) obj = new THREE.Group().add(restOnGround(obj, !!this.world.itemsData.items[spec.item]?.weapon)); // pickup lying on the ground
    } else obj = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.8, 10).translate(0, 0.9, 0), new THREE.MeshBasicMaterial({ color: ENTITY_TYPES[spec.type]?.color ?? '#fff', transparent: true, opacity: 0.5 }));
    obj.traverse((o) => o.layers.set(LAYERS.EDITOR));
    this.ghost = obj;
    this.engine.scene.add(obj);
  }

  placeAtCursor(keep) {
    const spec = S.place.value;
    const p = this.groundHit();
    if (!spec || !p) return;
    const grid = S.snap.value.grid;
    if (grid) { p.x = Math.round(p.x / grid) * grid; p.z = Math.round(p.z / grid) * grid; }
    const data = { ...spec, pos: [+p.x.toFixed(2), +p.y.toFixed(3), +p.z.toFixed(2)], rot: [0, this.placeYaw ?? 0, 0] };
    if (spec.type === 'path') data.points = [data.pos.slice()];
    const e = this.addEntity(data, { select: !keep });
    log(`Placed ${e.id}`);
    if (!keep) { S.place.value = null; this._makeGhost(null); this.select([e.id]); }
  }

  // --- brushes --------------------------------------------------------------------------------
  _initBrushCursor() {
    const n = 64;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.brushRing = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false }));
    this.brushRing.layers.set(LAYERS.EDITOR);
    this.brushRing.renderOrder = 999;
    this.brushRing.frustumCulled = false;
    this.engine.scene.add(this.brushRing);
  }

  _updateBrushRing(p) {
    const on = !!p && ['sculpt', 'paint', 'foliage'].includes(S.tool.value);
    this.brushRing.visible = on;
    if (!on) return;
    const r = S.brush.value.radius, T = this.world.terrain;
    const a = this.brushRing.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const t = (i / a.count) * Math.PI * 2;
      const x = p.x + Math.cos(t) * r, z = p.z + Math.sin(t) * r;
      a.setXYZ(i, x, T.heightAt(x, z) + 0.3, z);
    }
    a.needsUpdate = true;
  }

  _strokeBegin() {
    const T = this.world.terrain;
    this.stroke = { rect: null, beforeH: T.heights.slice(), beforeM: T.material.slice(), tool: S.tool.value, added: 0, removed: 0, vegBefore: this.world.vegetation.encode() };
    const b = S.brush.value;
    if (S.tool.value === 'sculpt' && b.op === 'flatten' && b.height == null) { const c = this.groundHit(); this.stroke.flatH = c ? c.y : 0; }
  }

  _strokeApply(dt) {
    const p = this.groundHit();
    if (!p) return;
    const b = S.brush.value, T = this.world.terrain;
    const st = this.stroke;
    let rect = null;
    if (st.tool === 'sculpt') {
      const k = b.op === 'smooth' || b.op === 'flatten' ? Math.min(1, b.strength * dt * 6) : b.strength * dt * 12;
      rect = T.sculpt(b.op, p.x, p.z, b.radius, k, { falloff: b.falloff, height: b.height ?? st.flatH });
    } else if (st.tool === 'paint') {
      rect = T.sculpt('paint', p.x, p.z, b.radius, 1, { material: b.material === 'auto' ? 0 : MATERIAL_ID[b.material], falloff: b.falloff });
    } else if (st.tool === 'foliage') {
      const veg = this.world.vegetation;
      if (b.erase) st.removed += veg.erase(p.x, p.z, b.radius, b.species ?? -1);
      else {
        const n = Math.max(1, Math.round(b.density * b.radius * b.radius * dt * 0.6));
        const sp = veg.def.species[b.species] ?? veg.def.species[0];
        const list = [];
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * b.radius;
          const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
          if (T.waterLevelAt(x, z) > T.heightAt(x, z) - 0.2) continue;
          const [s0, s1] = sp.scatter?.scale ?? [0.8, 1.2];
          list.push({ species: b.species, variant: Math.floor(Math.random() * (sp.variants ?? 1)), x, z, yaw: Math.random() * Math.PI * 2, scale: s0 + Math.random() * (s1 - s0) });
        }
        veg.addInstances(list);
        st.added += list.length;
      }
      this._vegDirty = true;
      return;
    }
    if (rect) {
      st.rect = st.rect ? { i0: Math.min(st.rect.i0, rect.i0), i1: Math.max(st.rect.i1, rect.i1), j0: Math.min(st.rect.j0, rect.j0), j1: Math.max(st.rect.j1, rect.j1) } : rect;
      this.world.terrainRenderer.invalidate(rect);
    }
  }

  _strokeEnd() {
    const st = this.stroke;
    this.stroke = null;
    const T = this.world.terrain, w = this.world;
    if (st.tool === 'foliage') {
      w.vegetation.rebuild();
      w.addVegetationColliders();
      const before = st.vegBefore, after = w.vegetation.encode();
      this.pushUndo({ label: 'Vegetation', file: 'vegetation.bin', undo: () => { w.vegetation.rebuild(before); w.addVegetationColliders(); }, redo: () => { w.vegetation.rebuild(after); w.addVegetationColliders(); } });
      this.markDirty('vegetation.bin');
      log(st.added ? `+${st.added} plants` : `-${st.removed} plants`);
      return;
    }
    if (!st.rect) return;
    const afterH = T.heights.slice(), afterM = T.material.slice();
    const apply = (H, M) => { T.heights.set(H); T.material.set(M); T.buildWaterGrid(); T.invalidateColors(st.rect); T.version++; w.terrainRenderer.invalidate(st.rect); this._terrainChanged(); };
    this.pushUndo({ label: st.tool === 'paint' ? 'Paint terrain' : 'Sculpt', file: 'terrain', undo: () => apply(st.beforeH, st.beforeM), redo: () => apply(afterH, afterM) });
    this._terrainChanged();
    this.markDirty('terrain');
  }

  /** Follow-ups after a heightfield edit: water depth texture, vegetation & entities on the ground. */
  _terrainChanged() {
    const w = this.world;
    w.water.refreshHeights();
    w.grass?.invalidate();
    w.vegetation.rebuild();
    w.addVegetationColliders();
  }

  // --- paths ----------------------------------------------------------------------------------
  pathAdd() {
    const id = S.selection.value[0];
    const e = this.world.entities.get(id);
    const p = this.groundHit();
    if (!e || e.type !== 'path' || !p) { log('Select a path, then click the terrain to add points', 'warn'); return; }
    this.updateEntity(id, { ...e, points: [...(e.points ?? []), [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]] });
  }

  pathPop() {
    const id = S.selection.value[0];
    const e = this.world.entities.get(id);
    if (e?.type === 'path' && e.points?.length) this.updateEntity(id, { ...e, points: e.points.slice(0, -1) });
  }

  // --- saving ---------------------------------------------------------------------------------
  markDirty(file) { S.dirty.value = { ...S.dirty.value, [file]: true }; }

  async saveAll() {
    const d = S.dirty.value;
    const w = this.world;
    this._saving = true;
    try {
      if (d['world.json']) { await Data.save('world.json', w.serialize()); }
      if (d.terrain) {
        const { meta, heightBytes, materialBytes } = w.terrain.encode();
        await Data.save('terrain/height.bin', heightBytes);
        await Data.save('terrain/material.bin', materialBytes);
        await Data.save('terrain/terrain.json', meta);
      }
      if (d['vegetation.bin']) await Data.save('vegetation.bin', w.vegetation.encode());
      if (d['environment.json']) await Data.save('environment.json', w.lighting.env);
      for (const [file, content] of Object.entries(this.pendingFiles ?? {})) await Data.save(file, content);
      this.pendingFiles = {};
      const n = Object.keys(d).length;
      S.dirty.value = {};
      this._savedAt = Date.now();
      log(n ? `Saved (${n} file${n > 1 ? 's' : ''})` : 'Nothing to save');
    } catch (e) {
      log(`Save failed: ${e.message}`, 'error');
    } finally {
      this._saving = false;
      this._savedAt = Date.now();
    }
  }

  /** Stage a JSON/text data file edited by a panel (saved with saveAll). */
  stageFile(path, content) {
    this.pendingFiles = { ...(this.pendingFiles ?? {}), [path]: content };
    this.markDirty(path);
  }

  async _externalChange(path) {
    if (this._saving || Date.now() - (this._savedAt ?? 0) < 2500) return; // our own save
    if (path === 'assets/index.json' || path.startsWith('voice/')) return;
    if (path === 'world.json' && !S.dirty.value['world.json']) {
      const data = await Data.json('world.json', { fresh: true });
      const ents = this.world.entities;
      for (const e of [...ents.list]) ents.remove(e.id);
      ents.load(data.entities ?? []);
      this.world.data = data;
      log('world.json changed externally: reloaded');
    } else if (path.startsWith('assets/')) {
      const name = path.slice(7, -5);
      const def = await Data.json(path, { fresh: true }).catch(() => null);
      if (def) { this.world.assets.set(name, def); this.world.entities._rebuildProps(); log(`Asset ${name} reloaded`); }
    } else log(`${path} changed externally`, 'warn');
  }

  // --- per frame ------------------------------------------------------------------------------
  update(dt) {
    this.fly.update(dt);
    this.input.endFrame();
    const p = this.groundHit();
    if (this.frameN++ % 6 === 0) S.cursor.value = p ? [p.x, p.y, p.z].map((v) => +v.toFixed(1)) : null;
    this._updateBrushRing(p);
    if (this.stroke) this._strokeApply(dt);
    if (this.ghost) {
      if (p) {
        const grid = S.snap.value.grid;
        this.ghost.position.set(grid ? Math.round(p.x / grid) * grid : p.x, p.y, grid ? Math.round(p.z / grid) * grid : p.z);
        this.ghost.rotation.y = (this.placeYaw ?? 0) * D2R;
        this.ghost.visible = true;
      } else this.ghost.visible = false;
    }
    if (this.frameN % 15 === 0) {
      const c = this.engine.camera.position;
      S.camInfo.value = `${c.x.toFixed(0)}, ${c.y.toFixed(0)}, ${c.z.toFixed(0)}`;
      S.perf.value = this.engine.perf.snapshot();
    }
    this.world.entities.setHelpersVisible(S.helpers.value);
  }
  frameN = 0;

  // --- live commands for agents ---------------------------------------------------------------
  _registerLive() {
    const L = this.live, w = this.world, ents = w.entities;
    L.register('state', () => ({ entities: ents.list.length, selection: S.selection.value, dirty: Object.keys(S.dirty.value), camera: this.engine.camera.position.toArray().map((v) => +v.toFixed(1)), tool: S.tool.value, panel: S.panel.value, perf: this.engine.perf.snapshot() }));
    L.register('select', ({ ids }) => { this.select(ids ?? []); return S.selection.value; });
    L.register('get', ({ id }) => ents.get(id));
    L.register('add', ({ entity }) => this.addEntity(entity));
    L.register('set', ({ id, entity }) => this.updateEntity(id, entity));
    L.register('patch', ({ id, changes }) => this.updateEntity(id, { ...ents.get(id), ...changes }));
    L.register('remove', ({ id }) => { this.select([id]); this.deleteSelection(); return true; });
    L.register('camera', ({ pos, lookAt, yaw, pitch }) => { if (pos) this.engine.camera.position.fromArray(pos); if (yaw !== undefined) { this.fly.yaw = yaw; this.fly.pitch = pitch ?? this.fly.pitch; this.fly.apply(); } if (lookAt) this.fly.lookAt(new THREE.Vector3(...lookAt)); return this.engine.camera.position.toArray(); });
    L.register('focus', ({ id }) => { this.select([id]); this.frameSelection(); return true; });
    L.register('setEnv', ({ env }) => { w.lighting.setEnvironment({ ...w.lighting.env, ...env }); this.markDirty('environment.json'); return w.lighting.env; });
    L.register('sculpt', ({ op, x, z, radius, strength, material, height }) => { const r = w.terrain.sculpt(op, x, z, radius, strength ?? 1, { material: material ? MATERIAL_ID[material] : undefined, height }); w.terrainRenderer.invalidate(r); this._terrainChanged(); this.markDirty('terrain'); return true; });
    L.register('save', async () => { await this.saveAll(); return true; });
    L.register('undo', () => { this.undo(); return true; });
    L.register('panel', ({ name }) => (S.panel.value = name));
    L.register('materials', () => TERRAIN_MATERIALS.map((m) => m.name));
  }
}
