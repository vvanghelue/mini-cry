// Entities: everything placed in world.json (props, enemies, pickups, zones, paths, markers...).
//
// Each entity is plain JSON data: { id, type, name?, pos: [x,y,z], rot?: [x,y,z] (deg), scale?,
// tags?: [], group?: string, ...type specific }. A type is registered with
//   registerEntityType(type, { label, color, category, schema, defaults, create(ctx, data) -> handle })
// where `schema` drives the editor inspector and the CLI validation, and `create` returns a
// handle { object?, update?(dt), dispose?(), ... }. ctx = { world, scene, physics, assets,
// mode: 'game' | 'editor', manager }. The game registers its own types (enemy, pickup, vehicle...).
//
// Static props are not individual meshes: they are batched into an InstancedField per asset.
import * as THREE from 'three';
import { StaticBatch } from '../render/StaticBatch.js';
import { Glows } from '../render/Glows.js';
import { LAYERS } from '../render/layers.js';

export const ENTITY_TYPES = {};
const D2R = Math.PI / 180;

export function registerEntityType(type, def) {
  ENTITY_TYPES[type] = { type, label: type, color: '#ff00ff', category: 'misc', schema: {}, defaults: {}, ...def };
}

/** Schema field kinds: number, int, string, bool, vec3, color, enum(options), asset, entity(ref type), list, text, json */
export function validateEntity(e) {
  const errors = [];
  const T = ENTITY_TYPES[e.type];
  if (!e.id) errors.push('missing id');
  if (!T) { errors.push(`unknown type "${e.type}"`); return errors; }
  for (const [k, f] of Object.entries(T.schema)) {
    const v = e[k];
    if (v === undefined) { if (f.required) errors.push(`${k} is required`); continue; }
    if ((f.type === 'number' || f.type === 'int') && typeof v !== 'number') errors.push(`${k} must be a number`);
    if (f.type === 'vec3' && !(Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number'))) errors.push(`${k} must be [x,y,z]`);
    if (f.type === 'enum' && !f.options.includes(v)) errors.push(`${k} must be one of ${f.options.join(', ')}`);
    if (f.type === 'bool' && typeof v !== 'boolean') errors.push(`${k} must be true/false`);
  }
  return errors;
}

export function entityMatrix(e, out = new THREE.Matrix4()) {
  const r = e.rot ?? [0, 0, 0];
  const s = e.scale ?? 1;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'YXZ'));
  return out.compose(new THREE.Vector3(...(e.pos ?? [0, 0, 0])), q, typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s));
}

export class EntityManager {
  constructor(world, { mode = 'game' } = {}) {
    this.world = world;
    this.mode = mode;
    this.scene = world.scene;
    this.list = []; // data objects, in file order
    this.handles = new Map(); // id -> handle
    this.root = new THREE.Group();
    this.root.name = 'Entities';
    this.scene.add(this.root);
    this.propKinds = new Map(); // asset -> kind index
    this.props = null;
    // light halos of the static props' lamps / fires (asset parts with `glow`)
    this.glows = new Glows(world.lighting);
    this.root.add(this.glows.mesh);
    this.events = new EventTarget();
    this.pending = []; // entities whose type isn't registered yet (game types, created later)
  }

  get ctx() {
    return { world: this.world, scene: this.root, physics: this.world.physics, assets: this.world.assets, lighting: this.world.lighting, mode: this.mode, manager: this, engine: this.world.engine };
  }

  load(entities) {
    for (const e of entities) this.list.push(e);
    this._rebuildProps();
    for (const e of this.list) if (e.type !== 'prop' || e.dynamic) this._create(e);
    this._emit('load');
  }

  _emit(type, detail) { this.events.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.events.addEventListener(type, (e) => fn(e.detail)); }

  /** Create entities whose type got registered after load (game types). */
  createPending() {
    const list = this.pending;
    this.pending = [];
    for (const e of list) this._create(e);
  }

  _create(e) {
    const T = ENTITY_TYPES[e.type];
    if (!T) { this.pending.push(e); return null; }
    if (e.disabled && this.mode === 'game') return null;
    try {
      const h = T.create?.(this.ctx, e) ?? {};
      h.data = e;
      h.type = T;
      if (h.object) {
        h.object.userData.entityId = e.id;
        if (!h.object.parent) this.root.add(h.object);
      }
      this.handles.set(e.id, h);
      // in game, pure editor helpers (markers, zones, paths, outpost rings) leave the scene graph
      if (this.mode === 'game' && h.helper && h.helper === h.object) {
        h.object.updateMatrixWorld(true);
        h.object.removeFromParent();
      }
      return h;
    } catch (err) {
      console.error(`entity ${e.id} (${e.type}) failed:`, err);
      return null;
    }
  }

  _destroy(id) {
    const h = this.handles.get(id);
    if (!h) return;
    h.dispose?.();
    h.object?.removeFromParent();
    this.world.physics?.removeOwner(id);
    this.handles.delete(id);
  }

  // --- static props (batched) -------------------------------------------------------------
  _rebuildProps() {
    const assets = this.world.assets;
    if (!this.props || this._propsVersion !== assets.version) {
      this.props?.dispose();
      this.props = new StaticBatch({ name: 'Props', assets, lighting: this.world.lighting, worldSize: this.world.terrain.size, sector: 128 });
      this._propsVersion = assets.version;
      this.root.add(this.props.group);
    }
    this.props.clear();
    const physics = this.world.physics;
    physics?.clearOwnersWithPrefix('prop:');
    const m = new THREE.Matrix4();
    const glows = [];
    for (const e of this.list) {
      if (e.type !== 'prop' || e.dynamic || !assets.has(e.asset)) continue;
      this.props.add(e.asset, entityMatrix(e, m), e.id);
      const b = assets.build(e.asset, { quality: 1 });
      if (b.glows.length) Glows.place(b.glows, m, glows);
      if (physics && e.collide !== false) {
        const s = typeof e.scale === 'number' ? e.scale : 1;
        physics.addLocal(b.colliders, { x: e.pos[0], y: e.pos[1], z: e.pos[2], yaw: (e.rot?.[1] ?? 0) * D2R, scale: s, owner: 'prop:' + e.id, material: assets.get(e.asset)?.material ?? 'wood' });
      }
    }
    this.glows.set(glows);
  }

  // --- CRUD (editor, scripts, CLI live) ---------------------------------------------------
  get(id) { return this.list.find((e) => e.id === id); }
  handle(id) { return this.handles.get(id); }
  byType(type) { return this.list.filter((e) => e.type === type); }
  byGroup(group) { return this.list.filter((e) => e.group === group); }
  byTag(tag) { return this.list.filter((e) => e.tags?.includes(tag)); }

  newId(type) {
    let i = 1;
    const base = type.replace(/[^a-z0-9]/gi, '_');
    while (this.list.some((e) => e.id === `${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  add(data) {
    const T = ENTITY_TYPES[data.type];
    const e = { ...(T ? structuredClone(T.defaults) : {}), ...data };
    e.id ??= this.newId(e.type);
    this.list.push(e);
    if (e.type === 'prop' && !e.dynamic) this._rebuildProps(); else this._create(e);
    this._emit('change', { op: 'add', id: e.id });
    return e;
  }

  /** Replace an entity's data (re-creates its handle). */
  set(id, data) {
    const i = this.list.findIndex((e) => e.id === id);
    if (i < 0) return null;
    const old = this.list[i];
    const e = { ...data, id: data.id ?? id };
    this.list[i] = e;
    const wasProp = old.type === 'prop' && !old.dynamic, isProp = e.type === 'prop' && !e.dynamic;
    if (!wasProp) this._destroy(id);
    if (wasProp || isProp) this._rebuildProps();
    if (!isProp) this._create(e);
    this._emit('change', { op: 'set', id: e.id });
    return e;
  }

  /** Shallow-merge changes into an entity. */
  patch(id, changes) {
    const e = this.get(id);
    return e ? this.set(id, { ...e, ...changes }) : null;
  }

  remove(id) {
    const i = this.list.findIndex((e) => e.id === id);
    if (i < 0) return false;
    const [e] = this.list.splice(i, 1);
    if (e.type === 'prop' && !e.dynamic) this._rebuildProps(); else this._destroy(id);
    this._emit('change', { op: 'remove', id });
    return true;
  }

  serialize() { return structuredClone(this.list); }

  update(dt, engine) {
    this.props?.update(engine.camera);
    const cp = engine.camera.position;
    const cull = this.mode === 'game';
    for (const h of this.handles.values()) {
      if (cull && h.object && !h.actor && h.helper !== h.object) {
        // small dynamic objects (pickups, barrels, alarms, vehicles) vanish past their cull distance
        const d = h.object.position.distanceToSquared(cp);
        const max = h.cullDistance ?? h.type?.cullDistance ?? 250;
        const vis = d < max * max && !h.hidden;
        if (h.object.visible !== vis) h.object.visible = vis;
      }
      if (h.update && h.active !== false) h.update(dt, engine);
    }
  }

  /** Editor helpers on/off (markers, zones, paths are invisible in game). */
  setHelpersVisible(v) {
    for (const h of this.handles.values()) if (h.helper) h.helper.visible = v;
  }

  dispose() {
    for (const id of [...this.handles.keys()]) this._destroy(id);
    this.props?.dispose();
    this.glows.dispose();
    this.root.removeFromParent();
  }
}

// ---------------------------------------------------------------------------------------------
// Core entity types (engine level). Helpers live on the EDITOR layer: invisible in game.
const helperMat = (color, opts = {}) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 0.35, depthWrite: false, wireframe: !!opts.wireframe });
function editorOnly(obj) { obj.traverse((o) => o.layers.set(LAYERS.EDITOR)); return obj; }
function place(obj, e) {
  obj.position.fromArray(e.pos ?? [0, 0, 0]);
  const r = e.rot ?? [0, 0, 0];
  obj.rotation.set(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'YXZ');
  const s = e.scale ?? 1;
  if (typeof s === 'number') obj.scale.setScalar(s); else obj.scale.fromArray(s);
  return obj;
}

const COMMON = {
  name: { type: 'string', label: 'Name' },
  pos: { type: 'vec3', label: 'Position', required: true },
  tags: { type: 'list', label: 'Tags' },
  group: { type: 'string', label: 'Group' },
};
export { COMMON as COMMON_SCHEMA };

registerEntityType('prop', {
  label: 'Prop', color: '#c8a060', category: 'Decor',
  schema: { ...COMMON, asset: { type: 'asset', label: 'Asset', required: true }, rot: { type: 'vec3', label: 'Rotation (°)' }, scale: { type: 'number', label: 'Scale', min: 0.05, max: 20, step: 0.05 }, collide: { type: 'bool', label: 'Collision' }, dynamic: { type: 'bool', label: 'Individual mesh' }, clearRadius: { type: 'number', label: 'Clear vegetation (m)' } },
  defaults: { rot: [0, 0, 0], scale: 1, collide: true },
  create(ctx, e) {
    // only dynamic props get here (static ones are batched)
    const b = ctx.assets.build(e.asset, { quality: 1 });
    const mesh = new THREE.Mesh(b.geometry, ctx.assets.material(b));
    place(mesh, e);
    mesh.layers.set(LAYERS.STATIC);
    if (e.collide !== false) ctx.physics?.addLocal(b.colliders, { x: e.pos[0], y: e.pos[1], z: e.pos[2], yaw: (e.rot?.[1] ?? 0) * D2R, scale: e.scale ?? 1, owner: e.id });
    return { object: mesh };
  },
});

registerEntityType('marker', {
  label: 'Marker', color: '#ffffff', category: 'Logic',
  schema: { ...COMMON, rot: { type: 'vec3', label: 'Rotation (°)' }, label: { type: 'string', label: 'Map label' }, icon: { type: 'enum', label: 'Map icon', options: ['none', 'objective', 'camp', 'village', 'tower', 'cave', 'boat', 'collectible'] } },
  defaults: { icon: 'none' },
  create(ctx, e) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2, 6).translate(0, 1, 0), helperMat('#ffffff', { opacity: 0.8 }));
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.6, 4).rotateX(Math.PI / 2).translate(0, 2, 0.4), helperMat('#ffcc00', { opacity: 0.9 }));
    g.add(pole, arrow);
    place(g, e);
    editorOnly(g);
    return { object: g, helper: g };
  },
});

registerEntityType('zone', {
  label: 'Zone (trigger)', color: '#3080ff', category: 'Logic',
  schema: { ...COMMON, shape: { type: 'enum', label: 'Shape', options: ['sphere', 'box'] }, radius: { type: 'number', label: 'Radius', min: 0.5 }, size: { type: 'vec3', label: 'Size (box)' }, rot: { type: 'vec3', label: 'Rotation (°)' } },
  defaults: { shape: 'sphere', radius: 8, size: [10, 6, 10] },
  create(ctx, e) {
    const geo = e.shape === 'box' ? new THREE.BoxGeometry(...(e.size ?? [10, 6, 10])).translate(0, (e.size?.[1] ?? 6) / 2, 0) : new THREE.SphereGeometry(e.radius ?? 8, 16, 10);
    const m = new THREE.Mesh(geo, helperMat('#3080ff', { opacity: 0.18 }));
    const w = new THREE.Mesh(geo, helperMat('#60a0ff', { wireframe: true, opacity: 0.5 }));
    const g = new THREE.Group();
    g.add(m, w);
    g.position.fromArray(e.pos);
    g.rotation.y = (e.rot?.[1] ?? 0) * D2R;
    editorOnly(g);
    const _l = new THREE.Vector3();
    return {
      object: g, helper: g,
      /** is a world point inside the zone? */
      contains(p) {
        if (e.shape === 'box') {
          _l.set(p.x, p.y, p.z);
          g.worldToLocal(_l);
          const s = e.size ?? [10, 6, 10];
          return Math.abs(_l.x) <= s[0] / 2 && Math.abs(_l.z) <= s[2] / 2 && _l.y >= -1 && _l.y <= s[1];
        }
        return (p.x - e.pos[0]) ** 2 + (p.y - e.pos[1]) ** 2 + (p.z - e.pos[2]) ** 2 <= (e.radius ?? 8) ** 2;
      },
    };
  },
});

registerEntityType('path', {
  label: 'Path (patrol)', color: '#30ff90', category: 'Logic',
  schema: { ...COMMON, points: { type: 'points', label: 'Points' }, loop: { type: 'bool', label: 'Loop' }, wait: { type: 'number', label: 'Wait at points (s)' } },
  defaults: { points: [], loop: true, wait: 2 },
  create(ctx, e) {
    const pts = (e.points ?? []).map((p) => new THREE.Vector3(...p).add(new THREE.Vector3(0, 0.3, 0)));
    const g = new THREE.Group();
    if (pts.length > 1) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(e.loop ? [...pts, pts[0]] : pts), new THREE.LineBasicMaterial({ color: '#30ff90' }));
      g.add(line);
    }
    for (const p of pts) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), helperMat('#30ff90', { opacity: 0.8 }));
      s.position.copy(p);
      g.add(s);
    }
    editorOnly(g);
    return { object: g, helper: g, points: (e.points ?? []).map((p) => new THREE.Vector3(...p)) };
  },
});

registerEntityType('spawn', {
  label: 'Spawn point', color: '#00ff80', category: 'Logic',
  schema: { ...COMMON, rot: { type: 'vec3', label: 'Rotation (°)' }, checkpoint: { type: 'string', label: 'Checkpoint (id)' } },
  defaults: {},
  create(ctx, e) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.8, 10).translate(0, 0.9, 0), helperMat('#00ff80', { opacity: 0.5 }));
    const dir = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.6, 6).rotateX(-Math.PI / 2).translate(0, 1.5, -0.5), helperMat('#00ff80', { opacity: 0.9 }));
    g.add(body, dir);
    place(g, e);
    editorOnly(g);
    return { object: g, helper: g };
  },
});
