// The game world shared by the game and the editor: terrain (data + renderer), water,
// environment (lighting), vegetation, entities and the static collision world.
import * as THREE from 'three/webgpu';
import { Data } from '../core/Data.js';
import { LAYERS } from '../render/layers.js';
import { fadeMaterial } from '../render/InstancedField.js';
import { InstancedBatch } from '../render/Instancing.js';
import { lodMaterial } from '../render/LodFade.js';
import { TerrainData } from './TerrainData.js';
import { TerrainRenderer } from './TerrainRenderer.js';
import { Water } from './Water.js';
import { AssetLibrary } from '../assets/AssetLibrary.js';
import { Vegetation } from './Vegetation.js';
import { Grass } from './Grass.js';
import { Physics } from '../physics/Physics.js';
import { EntityManager } from './Entities.js';
import { GI_VERSION } from '../render/GIField.js';

export class World {
  constructor(engine, { mode = 'game' } = {}) {
    this.engine = engine;
    this.mode = mode;
    this.scene = engine.scene;
    this.lighting = engine.lighting;
    this.advanceDay = true;
  }

  async load({ onProgress = () => {} } = {}) {
    onProgress(0.05, 'terrain');
    const [meta, hbin, mbin, env] = await Promise.all([
      Data.json('terrain/terrain.json'),
      Data.bin('terrain/height.bin'),
      Data.bin('terrain/material.bin'),
      Data.jsonOr('environment.json', {}),
    ]);
    const gi = this.loadGI(); // baked probe GI (optional), decoded while the rest loads
    this.terrain = TerrainData.decode(meta, hbin, mbin);
    // view distance: the whole world square from anywhere in it (its diagonal; the fog hides the edge)
    const cam = this.engine.camera;
    cam.far = Math.max(cam.far, Math.ceil(Math.SQRT2 * this.terrain.size));
    cam.updateProjectionMatrix();
    const colors = this.terrain.precomputeColors(); // in a worker, while the rest loads
    this.envData = env;
    this.lighting.setEnvironment(env);
    // texture arrays (terrain splatting, asset surfaces, foliage) load meanwhile
    const S = this.lighting.surfaces;
    S._loading ??= S.load(this.engine.renderer);
    onProgress(0.3, 'water');
    this.water = new Water(this.terrain, this.lighting, this.scene);
    this.lighting.onEnvironment = (e) => this.water?.setColors(e);
    onProgress(0.4, 'assets');
    this.assets = await new AssetLibrary(this.lighting).load();
    onProgress(0.6, 'vegetation');
    const [vegDef, vegBin] = await Promise.all([Data.jsonOr('vegetation.json', { species: [] }), Data.bin('vegetation.bin').catch(() => new Uint8Array(0))]);
    this.vegetationDef = vegDef;
    this.vegetation = new Vegetation(this, this.assets, vegDef, vegBin);
    this.scene.add(this.vegetation.group);
    if (vegDef.grass) {
      this.grass = new Grass(this, this.assets, vegDef.grass);
      this.scene.add(this.grass.group);
    }
    onProgress(0.8, 'physics');
    this.physics = new Physics(this.terrain);
    this.addVegetationColliders();
    onProgress(0.9, 'entities');
    this.data = await Data.jsonOr('world.json', { entities: [] });
    this.entities = new EntityManager(this, { mode: this.mode });
    this.entities.load(this.data.entities ?? []);
    await colors;
    await S._loading;
    this.vegetation.bakeImpostors(this.engine.renderer); // far tree LODs (render/Impostors.js)
    // after the colour worker: the splatting texture reads every vertex's resolved material
    this.terrainRenderer = new TerrainRenderer(this.terrain, this.lighting);
    this.scene.add(this.terrainRenderer.group);
    // the sun cascades sit on the ground (or the sea) and grow with the camera's height above it
    this.lighting.sun.groundAt = (x, z) => Math.max(this.terrain.heightAt(x, z), this.terrain.seaLevel);
    this.refreshFarShadows();
    await gi;
    this.applyQuality();
    this.engine.on('quality', () => this.applyQuality());
    onProgress(1, 'ready');
    return this;
  }

  heightAt(x, z) { return this.terrain.heightAt(x, z); }

  /** The far shadows' occluders (render/FarShadows.js): the heightfield + the trees with impostors. */
  refreshFarShadows() {
    const v = this.vegetation;
    this.lighting.sun.far.setWorld(this.terrain, v ? [v.fieldFar, v.fieldNear] : []);
    this._farKey = this._farEditKey();
    this._farAt = 0;
  }

  _farEditKey() { return `${this.terrain.version}|${this.vegetation?.version ?? 0}`; }

  /** Load gi/probes.* if baked (`mc gi bake`); without it the hemisphere light stays. */
  async loadGI() {
    const L = this.lighting;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('gi') === '0') return; // A/B, benches
    try {
      const meta = await Data.json('gi/probes.json', { fresh: true });
      if (meta.version !== GI_VERSION) { console.warn(`gi: baked with format v${meta.version}, expected v${GI_VERSION}: run \`npm run mc -- gi bake\``); return; }
      await L.gi.load(meta, await Data.bin('gi/probes.bin', { fresh: true }));
      L.setTimeOfDay(L.timeOfDay); // relight with the loaded keys
      L.gi.snapExposure(this.engine.camera.position);
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn('gi:', err.message);
    }
  }

  addVegetationColliders() {
    this.physics.clearOwnersWithPrefix('veg:');
    const D2R = Math.PI / 180;
    this.vegetation?.forEachCollider((c, x, y, z, yaw, scale, k) => {
      this.physics.addLocal([c], { x, y, z, yaw, scale, owner: 'veg:' + k, material: c.material ?? 'wood' });
    });
    void D2R;
  }

  /** Draw distances / densities from the engine quality preset (low / medium / high / ultra). */
  applyQuality() {
    const Q = this.lighting.Q;
    if (this.vegetation) this.vegetation.drawScale = Q.drawScale;
    if (this.entities?.props) this.entities.props.drawScale = Q.propScale ?? Math.max(0.8, Q.drawScale);
    this.grass?.setDensityScale(Q.grass);
    if (this.terrainRenderer) this.terrainRenderer.range0 = 160 * Math.max(0.7, Q.drawScale); // (CDLOD level 0, at least ~134 m)
  }

  /**
   * Build every pipeline the game can draw, main pass and depth passes, during loading instead of
   * hitching (node build + WGSL + Metal pipeline: tens of ms) the first time one shows up:
   * everything in the scene (hidden pools, LODs and far meshes included), a stand-in per cached lit
   * material (as the plain mesh a prop batch uses and as an instanced mesh) with the attributes the
   * asset builds carry, and `extras` (a character, ...). Pipelines compile in parallel
   * (compileAsync), then one frame is drawn with every object shown and culling off (the sun
   * cascades and the SSAO pre-pass included), then the state is restored.
   */
  async warmUp(camera = this.engine.camera, extras = []) {
    const e = this.engine, r = e.renderer, scene = this.scene;
    const t0 = performance.now(), p0 = pipelineCount(r);
    const restore = this.warmUpShow(camera, extras);
    try {
      // main-pass pipelines compile in parallel
      await r.compileAsync(scene, camera);
      if (e.overlay?.scene) await r.compileAsync(e.overlay.scene, e.overlay.camera);
      for (const s of this.lighting.flare.scenes) await r.compileAsync(s, camera); // drawn only when the sun shows
      // depth-pass (override material) variants: draw the cascades and the SSAO pre-pass once
      e.render();
    } catch (err) { console.warn('warm-up', err); }
    restore();
    const total = pipelineCount(r);
    this.warmUpStats = { programs: total - p0, total, ms: Math.round(performance.now() - t0) };
  }

  /** The warm-up's scene: a stand-in per cached material and `extras` in front of the camera, every
   *  object shown with culling off, the cascades due. Returns the function that puts it all back.
   *  (VR: shown for one frame of the session, which compiles the multiview pipelines at once.) */
  warmUpShow(camera = this.engine.camera, extras = []) {
    const e = this.engine, scene = this.scene;
    const stand = new THREE.Group();
    stand.name = 'WarmUp';
    // the attributes every asset build has (ModelBuilder): the materials' code depends on them
    const geo = new THREE.BufferGeometry();
    const tri = (n, v) => new THREE.Float32BufferAttribute(Array.from({ length: 3 * n }, (_, i) => v[i % n]), n);
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1e-3, 0, 0, 0, 1e-3, 0], 3));
    geo.setAttribute('normal', tri(3, [0, 1, 0]));
    geo.setAttribute('color', tri(3, [1, 1, 1]));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geo.setAttribute('surface', tri(1, [0]));
    geo.setAttribute('wind', tri(1, [0]));
    geo.setAttribute('emissive', tri(1, [0]));
    // every option combination AssetLibrary.material() can ask for, even if nothing used it yet
    for (let k = 0; k < 8; k++) this.lighting.material({ textured: true, cutout: !!(k & 4), emissive: !!(k & 2), doubleSided: !!(k & 1) });
    const tmp = [];
    const add = (m, plain) => {
      const b = new InstancedBatch(geo, m, 1);
      b.instances = 1;
      b.layers.set(LAYERS.STATIC);
      stand.add(b);
      tmp.push(b);
      if (!plain) return;
      const a = new THREE.Mesh(geo, m);
      a.layers.set(LAYERS.STATIC);
      stand.add(a);
    };
    for (const m of this.lighting.materials.values()) add(m, true);
    for (const m of fadeMaterial.cache?.values() ?? []) add(m, false); // instanced only (reads the instance origin)
    for (const m of lodMaterial.cache?.values() ?? []) add(m, false);
    for (const x of extras) stand.add(x);
    camera.getWorldDirection(stand.position).multiplyScalar(3).add(camera.position);
    scene.add(stand);
    const saved = [];
    const show = (root) => root.traverse((o) => { saved.push(o, o.visible, o.frustumCulled); o.visible = true; o.frustumCulled = false; });
    show(scene);
    if (e.overlay?.scene) show(e.overlay.scene);
    for (const c of this.lighting.sun.cascades ?? []) c.rendered = false;
    return () => {
      for (let i = 0; i < saved.length; i += 3) { saved[i].visible = saved[i + 1]; saved[i].frustumCulled = saved[i + 2]; }
      stand.removeFromParent();
      for (const x of extras) x.removeFromParent();
      for (const b of tmp) b.disposeShared();
      geo.dispose();
      for (const c of this.lighting.sun.cascades ?? []) c.rendered = false;
    };
  }

  /** world.json content with the current entities. */
  serialize() {
    return { ...this.data, entities: this.entities.serialize() };
  }

  update(dt, engine) {
    // terrain / vegetation edits (editor): the far shadows' occluders again, once the brush rests
    const fk = this._farEditKey();
    if (fk !== this._farKey) { this._farKey = fk; this._farAt = performance.now(); }
    if (this._farAt && performance.now() - this._farAt > 400) this.refreshFarShadows();
    this.lighting.update(dt, { advanceDay: this.advanceDay });
    this.terrainRenderer.update(engine.camera);
    this.water.update(engine.camera);
    this.vegetation?.update(engine.camera);
    this.grass?.update(engine.camera);
    this.entities?.update(dt, engine);
  }
}

/** Render pipelines the renderer has built (each one a shader compile + pipeline creation). */
export function pipelineCount(r) { return r._pipelines?.caches?.size ?? r.info.memory?.programs ?? 0; }
