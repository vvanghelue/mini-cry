// Live 3D preview of the asset being edited: its own small WebGPU renderer, OrbitControls, a ground
// grid at y = 0 with a -Z "front" arrow, collider wireframes, weapon / vehicle point markers, the
// selected part highlighted (wire + box) and a TransformControls gizmo writing back pos / rot /
// scale (parts), pos / yaw / size (colliders) or pos (points). Click picks a part (or a collider /
// a marker). Rendering is on demand (camera moves, edits, turntable).
import * as THREE from 'three/webgpu';
import { attribute, normalGeometry, normalFlat, transformNormalToView, diffuseColor, vertexColor, uniform, vec3, mix, clamp } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { buildAsset } from '../../../engine/assets/ModelBuilder.js';
import { POINT_KEYS, POINT_LIST_KEYS, rnd } from './shapes.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const COL = { solid: 0x5dff8a, auto: 0xa9b8c6, ladder: 0x4fb3ff, noWalk: 0xff9d4d, sel: 0xffd34d };

function circle(out, r, y, axis, n = 32) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    for (const a of [a0, a1]) {
      const c = Math.cos(a) * r, s = Math.sin(a) * r;
      if (axis === 'y') out.push(c, y, s);
      else if (axis === 'x') out.push(y, c, s);
      else out.push(c, s, y);
    }
  }
}
function linesGeo(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
function colliderLines(c) {
  if (c.type === 'cylinder') {
    const r = c.radius ?? 0.5, h = c.height ?? 1, p = [];
    circle(p, r, -h / 2, 'y');
    circle(p, r, h / 2, 'y');
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; p.push(Math.cos(a) * r, -h / 2, Math.sin(a) * r, Math.cos(a) * r, h / 2, Math.sin(a) * r); }
    return linesGeo(p);
  }
  if (c.type === 'sphere') {
    const r = c.radius ?? 0.5, p = [];
    circle(p, r, 0, 'y'); circle(p, r, 0, 'x'); circle(p, r, 0, 'z');
    return linesGeo(p);
  }
  const box = new THREE.BoxGeometry(...(c.size ?? [1, 1, 1]));
  const g = new THREE.EdgesGeometry(box);
  box.dispose();
  return g;
}
function colliderSolid(c) {
  if (c.type === 'cylinder') return new THREE.CylinderGeometry(c.radius ?? 0.5, c.radius ?? 0.5, c.height ?? 1, 12);
  if (c.type === 'sphere') return new THREE.SphereGeometry(c.radius ?? 0.5, 12, 8);
  return new THREE.BoxGeometry(...(c.size ?? [1, 1, 1]));
}
function textSprite(text, color = '#ffffff') {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 28px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  cv.width = w; cv.height = 40;
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(15,18,22,.72)';
  ctx.fillRect(0, 0, w, 40);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, 21);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.userData.aspect = w / 40;
  s.renderOrder = 20;
  return s;
}
/** Empty geometry with the attributes of a built asset (a WebGPU shader is built for the attributes
 *  of the first geometry it draws, and kept when the mesh gets another one). */
function emptyAssetGeometry() {
  const g = new THREE.BufferGeometry();
  for (const [k, n] of [['position', 3], ['normal', 3], ['color', 3], ['aWind', 1], ['aEmis', 1]]) g.setAttribute(k, new THREE.Float32BufferAttribute([], n));
  return g;
}

function disposeTree(o) {
  o.traverse((x) => {
    x.geometry?.dispose();
    if (x.material) { x.material.map?.dispose(); x.material.dispose(); }
  });
}

export class AssetPreview {
  /** cb: { onSelect(sel|null), onGizmo(sel, patch, dragId), newDragId() } */
  constructor(el, cb) {
    this.el = el;
    this.cb = cb;
    const r = (this.renderer = new THREE.WebGPURenderer({ antialias: true }));
    this.ready = false;
    r.init().then(() => { this.ready = true; this.needs = true; });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.setClearColor(0x2a313a, 1);
    r.domElement.className = 'ap-canvas';
    r.domElement.tabIndex = 0;
    el.appendChild(r.domElement);
    const scene = (this.scene = new THREE.Scene());
    const cam = (this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 5000));
    cam.position.set(3, 2.5, -4);
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x6b5a3a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.position.set(4, 7, -5);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
    fill.position.set(-5, 3, 4);
    scene.add(fill);
    this.root = new THREE.Group();
    scene.add(this.root);

    // model: lambert, vertex colours, flat shading; emissive attribute + optional wind heat-map
    this.viewU = uniform(0);
    this.mat = new THREE.MeshLambertNodeMaterial({ flatShading: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const wind = attribute('aWind', 'float'), emis = attribute('aEmis', 'float');
    this.mat.colorNode = this.viewU.greaterThan(0.5).select(mix(vec3(0.08, 0.12, 0.45), vec3(1.0, 0.25, 0.05), clamp(wind, 0.0, 1.0)), vertexColor());
    // leaves: same crown-normal shading as the game (Lighting.material foliage: normals longer than
    // sqrt 2 mark them), smooth instead of flat
    const fol = normalGeometry.dot(normalGeometry).greaterThan(2.0).select(1.0, 0.0).toVarying('vFol');
    const folN = transformNormalToView(normalGeometry).toVarying('vFolN');
    this.mat.normalNode = fol.greaterThan(0.5).select(folN.normalize(), normalFlat);
    this.mat.emissiveNode = diffuseColor.rgb.mul(emis);
    this.mesh = new THREE.Mesh(emptyAssetGeometry(), this.mat);
    this.root.add(this.mesh);
    this.wire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x0b0e12, transparent: true, opacity: 0.5 }));
    this.wire.visible = false;
    this.root.add(this.wire);
    this.helpers = new THREE.Group();
    scene.add(this.helpers);
    this.colGroup = new THREE.Group();
    this.root.add(this.colGroup);
    this.markGroup = new THREE.Group();
    this.root.add(this.markGroup);
    this.selWire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.55, depthTest: false }));
    this.selWire.renderOrder = 10;
    this.root.add(this.selWire);
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0xffd34d);
    this.selBox.visible = false;
    this.root.add(this.selBox);

    // gizmo before the orbit controls so it gets the pointerdown first
    this.target = new THREE.Object3D();
    this.target.rotation.order = 'YXZ';
    this.root.add(this.target);
    const g = (this.gizmo = new TransformControls(cam, r.domElement));
    g.setSize(0.85);
    scene.add(g.getHelper());
    g.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this._drag = { sel: this.sel, id: this.cb.newDragId(), c0: this.selCollider ? structuredClone(this.selCollider) : null };
      else { this._drag = null; this._dragEndT = performance.now(); this.needs = true; }
    });
    g.addEventListener('objectChange', () => this._gizmoChange());
    g.addEventListener('change', () => (this.needs = true));
    const o = (this.orbit = new OrbitControls(cam, r.domElement));
    o.enableDamping = true;
    o.dampingFactor = 0.18;
    o.autoRotateSpeed = 1.6;
    o.addEventListener('change', () => (this.needs = true));

    // click picking (no drag, not on the gizmo)
    this.raycaster = new THREE.Raycaster();
    r.domElement.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, y: e.clientY, b: e.button, axis: g.axis }; });
    r.domElement.addEventListener('pointerup', (e) => {
      const d = this._down;
      this._down = null;
      if (!d || d.b !== 0 || d.axis || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      if (performance.now() - (this._dragEndT ?? 0) < 150) return;
      this._pick(e);
    });
    r.domElement.addEventListener('dblclick', () => this.frame(this.selBox.visible ? this.selBox.box : null));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    this.needs = true;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const moved = this.orbit.update();
      if (this.ready && (moved || this.needs || this.orbit.autoRotate)) {
        this.needs = false;
        this.renderer.render(scene, cam);
      }
    };
    loop();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needs = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this._disposePick();
    disposeTree(this.scene);
    this.renderer.dispose(); // (frees the device now: the panel can be reopened many times)
    this.renderer.domElement.remove();
  }

  // --- model -----------------------------------------------------------------------------------
  /** Rebuild the mesh. Returns { triangles, bounds, colliders, ms } or { error }. */
  build(def, opts) {
    const t0 = performance.now();
    let b;
    try { b = buildAsset(def, opts); } catch (e) { return { error: e.message }; }
    const g = b.geometry;
    g.setAttribute('aWind', g.getAttribute('wind'));
    g.setAttribute('aEmis', g.getAttribute('emissive'));
    g.deleteAttribute('wind');
    g.deleteAttribute('emissive');
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.def = def;
    this.opts = opts;
    this.bounds = b.bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5)) : b.bounds.clone();
    this.colliders = b.colliders;
    this._updateWire();
    this._updateGround();
    this._updateColliders();
    this._updateMarkers();
    this._disposePick();
    this.needs = true;
    return { triangles: b.triangles, bounds: b.bounds, colliders: b.colliders, ms: performance.now() - t0 };
  }

  setOptions(v) {
    this.view = v;
    this.wire.visible = !!v.wire;
    this._updateWire();
    this.viewU.value = v.wind ? 1 : 0;
    this.orbit.autoRotate = !!v.turntable;
    this.colGroup.visible = !!v.colliders;
    this.markGroup.visible = v.markers !== false;
    this.gizmo.setSpace(v.space ?? 'world');
    this._applyGizmoMode();
    this.needs = true;
  }

  _updateWire() {
    this.wire.geometry.dispose();
    this.wire.geometry = this.wire.visible ? new THREE.WireframeGeometry(this.mesh.geometry) : new THREE.BufferGeometry();
  }

  _updateGround() {
    const b = this.bounds, s = b.getSize(new THREE.Vector3());
    const dim = Math.max(s.x, s.y, s.z, 0.05);
    const cell = dim < 1.5 ? 0.1 : dim < 4 ? 0.25 : dim < 14 ? 1 : dim < 40 ? 2 : 5;
    const ext = Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z), dim * 0.5);
    const n = Math.max(4, Math.ceil((ext * 2.6) / cell / 2) * 2);
    const key = `${cell}|${n}|${rnd(b.min.z, 2)}`;
    if (key === this._groundKey) return;
    this._groundKey = key;
    disposeTree(this.helpers);
    this.helpers.clear();
    const grid = new THREE.GridHelper(n * cell, n, 0x6d7a88, 0x3e4752);
    grid.material.transparent = true;
    grid.material.opacity = 0.75;
    this.helpers.add(grid);
    // front (-Z) arrow + label
    const len = Math.max(dim * 0.3, cell * 2);
    const z0 = Math.min(b.min.z, 0) - dim * 0.03;
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.002, z0), len, 0xff6a4d, len * 0.22, len * 0.12);
    this.helpers.add(arrow);
    const lbl = textSprite('FRONT  −Z', '#ff9a85');
    const h = Math.max(dim * 0.04, 0.02);
    lbl.scale.set(h * lbl.userData.aspect, h, 1);
    lbl.position.set(0, h * 1.2, z0 - len * 0.75);
    this.helpers.add(lbl);
    this.cell = cell;
  }

  _updateColliders() {
    disposeTree(this.colGroup);
    this.colGroup.clear();
    const list = this.colliders ?? [];
    const explicit = Array.isArray(this.def?.collider);
    list.forEach((c, i) => {
      const sel = explicit && this.sel?.kind === 'collider' && this.sel.i === i;
      const color = sel ? COL.sel : c.ladder ? COL.ladder : c.walkable === false ? COL.noWalk : explicit ? COL.solid : COL.auto;
      const m = new THREE.LineSegments(colliderLines(c), new THREE.LineBasicMaterial({ color, transparent: true, opacity: sel ? 1 : 0.8, depthTest: false }));
      m.renderOrder = sel ? 7 : 5;
      m.position.fromArray(c.pos ?? [0, 0, 0]);
      if (c.type === 'box') m.rotation.y = (c.rot?.[1] ?? 0) * D2R;
      m.userData.i = i;
      this.colGroup.add(m);
    });
  }

  _updateMarkers() {
    disposeTree(this.markGroup);
    this.markGroup.clear();
    const d = this.def;
    if (!d) return;
    const s = this.bounds.getSize(new THREE.Vector3());
    const r = Math.max(0.012, Math.max(s.x, s.y, s.z) * 0.022);
    const add = (p, color, label, sel) => {
      if (!Array.isArray(p) || p.length !== 3 || p.some((x) => typeof x !== 'number')) return;
      const isSel = this.sel?.kind === 'point' && this.sel.key === sel.key && this.sel.i === sel.i;
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(r * (isSel ? 1.5 : 1)), new THREE.MeshBasicMaterial({ color: isSel ? COL.sel : color, depthTest: false, transparent: true, opacity: 0.95 }));
      m.position.fromArray(p);
      m.renderOrder = 8;
      m.userData.sel = sel;
      this.markGroup.add(m);
      const t = textSprite(label, '#' + new THREE.Color(color).getHexString());
      t.scale.set(r * 1.3 * t.userData.aspect, r * 1.3, 1);
      t.position.set(p[0], p[1] + r * 2, p[2]);
      this.markGroup.add(t);
    };
    for (const k of POINT_KEYS) add(d[k.k], k.color, k.label, { kind: 'point', key: k.k });
    for (const k of POINT_LIST_KEYS) if (Array.isArray(d[k.k])) d[k.k].forEach((p, i) => add(p, k.color, `${k.label.slice(0, -1)} ${i + 1}`, { kind: 'point', key: k.k, i }));
  }

  // --- selection + gizmo -----------------------------------------------------------------------
  setSelection(def, sel) {
    this.sel = sel;
    this.selCollider = null;
    this.selWire.geometry.dispose();
    this.selWire.geometry = new THREE.BufferGeometry();
    this.selBox.visible = false;
    let pos = null, rot = [0, 0, 0], scale = [1, 1, 1];
    if (sel?.kind === 'part' && def?.parts?.[sel.i]) {
      const p = def.parts[sel.i];
      try {
        const b = buildAsset({ name: def.name, parts: [p] }, this.opts ?? {});
        this.selWire.geometry = new THREE.WireframeGeometry(b.geometry);
        b.geometry.dispose();
        if (!b.bounds.isEmpty()) { this.selBox.box.copy(b.bounds).expandByScalar(0.005); this.selBox.visible = true; }
      } catch { /* invalid part: no highlight */ }
      pos = p.pos ?? [0, 0, 0];
      rot = p.rot ?? [0, 0, 0];
      scale = p.scale === undefined ? [1, 1, 1] : typeof p.scale === 'number' ? [p.scale, p.scale, p.scale] : p.scale;
    } else if (sel?.kind === 'collider' && Array.isArray(def?.collider) && def.collider[sel.i]) {
      const c = (this.selCollider = def.collider[sel.i]);
      pos = c.pos ?? [0, 0, 0];
      rot = [0, c.type === 'box' ? c.rot?.[1] ?? 0 : 0, 0];
    } else if (sel?.kind === 'point') {
      const p = sel.i === undefined ? def?.[sel.key] : def?.[sel.key]?.[sel.i];
      if (Array.isArray(p)) pos = p;
    }
    this._updateColliders();
    this._updateMarkers();
    if (!pos) { this.gizmo.detach(); this.needs = true; return; }
    if (!this._drag) {
      this.target.position.fromArray(pos);
      this.target.rotation.set(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R, 'YXZ');
      this.target.scale.fromArray(scale.map((v) => (Math.abs(v) < 1e-4 ? 1e-4 : v)));
    }
    if (this.gizmo.object !== this.target) this.gizmo.attach(this.target);
    this._applyGizmoMode();
    this.needs = true;
  }

  _applyGizmoMode() {
    const g = this.gizmo, s = this.sel;
    let mode = this.view?.gizmo ?? 'translate';
    if (s?.kind === 'point') mode = 'translate';
    if (s?.kind === 'collider' && mode === 'rotate' && this.selCollider?.type !== 'box') mode = 'translate';
    g.setMode(mode);
    const yOnly = s?.kind === 'collider' && mode === 'rotate';
    g.showX = !yOnly;
    g.showZ = !yOnly;
    g.setTranslationSnap(this.view?.snap ? this.cell ?? 0.1 : null);
    g.setRotationSnap(this.view?.snap ? 15 * D2R : null);
  }

  _gizmoChange() {
    const d = this._drag;
    if (!d?.sel) return;
    const t = this.target, mode = this.gizmo.mode, s = d.sel;
    const patch = {};
    if (mode === 'translate') patch.pos = [rnd(t.position.x), rnd(t.position.y), rnd(t.position.z)];
    else if (mode === 'rotate') {
      if (s.kind === 'collider') patch.rot = [0, rnd(t.rotation.y * R2D, 1), 0];
      else patch.rot = [rnd(t.rotation.x * R2D, 1), rnd(t.rotation.y * R2D, 1), rnd(t.rotation.z * R2D, 1)];
    } else if (mode === 'scale') {
      const sc = t.scale;
      if (s.kind === 'part') {
        const u = Math.abs(sc.x - sc.y) < 1e-3 && Math.abs(sc.x - sc.z) < 1e-3;
        patch.scale = u ? rnd(sc.x) : [rnd(sc.x), rnd(sc.y), rnd(sc.z)];
      } else if (s.kind === 'collider' && d.c0) {
        const c = d.c0;
        if (c.type === 'box') { const z = c.size ?? [1, 1, 1]; patch.size = [rnd(z[0] * sc.x), rnd(z[1] * sc.y), rnd(z[2] * sc.z)]; }
        else if (c.type === 'cylinder') { patch.radius = rnd((c.radius ?? 0.5) * Math.max(sc.x, sc.z)); patch.height = rnd((c.height ?? 1) * sc.y); }
        else patch.radius = rnd((c.radius ?? 0.5) * Math.max(sc.x, sc.y, sc.z));
      }
    }
    if (Object.keys(patch).length) this.cb.onGizmo(s, patch, d.id);
  }

  get dragging() { return !!this._drag; }

  // --- camera ----------------------------------------------------------------------------------
  frame(box) {
    const b = box && !box.isEmpty() ? box : this.bounds;
    if (!b) return;
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.getSize(new THREE.Vector3()).length() * 0.5, 0.05);
    const dist = (r / Math.sin((this.camera.fov * D2R) / 2)) * (box ? 1.25 : 1.45);
    const dir = this.camera.position.clone().sub(this.orbit.target);
    if (dir.lengthSq() < 1e-8 || !box) dir.set(0.8, 0.55, -1);
    dir.normalize();
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.005, dist / 200);
    this.camera.far = dist * 50 + 100;
    this.camera.updateProjectionMatrix();
    this.orbit.target.copy(c);
    this.orbit.update();
    this.needs = true;
  }

  // --- picking ---------------------------------------------------------------------------------
  _disposePick() {
    for (const m of this._pickParts ?? []) m.geometry.dispose();
    this._pickParts = null;
  }

  _pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const rc = this.raycaster;
    rc.setFromCamera(ndc, this.camera);
    const d = this.def;
    if (!d) return;
    // markers first (small, drawn on top)
    if (this.markGroup.visible) {
      const h = rc.intersectObjects(this.markGroup.children.filter((m) => m.isMesh), false)[0];
      if (h) return this.cb.onSelect(h.object.userData.sel);
    }
    // colliders when the collider tab is active
    if (this.pickColliders && this.colGroup.visible && Array.isArray(d.collider)) {
      const meshes = d.collider.map((c, i) => {
        const m = new THREE.Mesh(colliderSolid(c), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        m.position.fromArray(c.pos ?? [0, 0, 0]);
        if (c.type === 'box') m.rotation.y = (c.rot?.[1] ?? 0) * D2R;
        m.updateMatrixWorld();
        m.userData.i = i;
        return m;
      });
      const h = rc.intersectObjects(meshes, false)[0];
      meshes.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
      if (h) return this.cb.onSelect({ kind: 'collider', i: h.object.userData.i });
    }
    // parts (each part built on its own, cached until the next rebuild)
    if (!this._pickParts) {
      this._pickMat ??= new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      this._pickParts = [];
      (d.parts ?? []).forEach((p, i) => {
        try {
          const b = buildAsset({ name: d.name, parts: [p] }, this.opts ?? {});
          if (!b.triangles) { b.geometry.dispose(); return; }
          const m = new THREE.Mesh(b.geometry, this._pickMat);
          m.userData.i = i;
          this._pickParts.push(m);
        } catch { /* skip */ }
      });
    }
    const h = rc.intersectObjects(this._pickParts, false)[0];
    this.cb.onSelect(h ? { kind: 'part', i: h.object.userData.i } : null);
  }
}
