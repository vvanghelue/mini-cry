// The game world shared by the game and the editor: terrain (data + renderer), water,
// environment (lighting), vegetation, entities and the static collision world.
import * as THREE from 'three';
import { Data } from '../core/Data.js';
import { LAYERS } from '../render/layers.js';
import { fadeMaterial } from '../render/InstancedField.js';
import { lodMaterial } from '../render/LodFade.js';
import { FieldMesh } from '../render/FieldMesh.js';
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
    await gi;
    this.applyQuality();
    this.engine.on('quality', () => this.applyQuality());
    onProgress(1, 'ready');
    return this;
  }

  heightAt(x, z) { return this.terrain.heightAt(x, z); }

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
    if (this.entities?.props) this.entities.props.drawScale = Math.max(0.8, Q.drawScale);
    this.grass?.setDensityScale(Q.grass);
    if (this.terrainRenderer) this.terrainRenderer.lodDistances = [160, 340, 700, 1100].map((d) => d * Math.max(0.7, Q.drawScale));
  }

  /**
   * Compile every pipeline the game can draw, main pass and depth passes, during loading instead
   * of hitching the first time one shows up: everything in the scene (hidden pools, LODs and far
   * meshes included), a stand-in per cached world material (as the plain mesh a prop batch uses
   * and as a FieldMesh instance), and `extras` (a character, ...). Pipelines compile in parallel
   * (compileAsync), then one frame is drawn with every object shown and culling off (sun
   * cascades, SSAO pre-pass, view model), and the state is restored.
   */
  async warmUp(camera = this.engine.camera, extras = []) {
    const e = this.engine, r = e.renderer, scene = this.scene;
    const t0 = performance.now(), p0 = e.pipelineCount();
    // the streamed content (terrain tiles, vegetation sectors, grass...) around the camera first
    this.update(0, e);
    const stand = new THREE.Group();
    stand.name = 'WarmUp';
    // the asset layout (ModelBuilder): every attribute a prop / plant build carries
    const geo = new THREE.BufferGeometry();
    const tri = (n, v) => new THREE.Float32BufferAttribute(Array.from({ length: 3 * n }, (_, i) => v[i % n]), n);
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1e-3, 0, 0, 0, 1e-3, 0], 3));
    geo.setAttribute('normal', tri(3, [0, 1, 0]));
    geo.setAttribute('color', tri(3, [1, 1, 1]));
    geo.setAttribute('uv', tri(2, [0, 0]));
    geo.setAttribute('surface', tri(1, [0]));
    geo.setAttribute('wind', tri(1, [0]));
    geo.setAttribute('emissive', tri(1, [0]));
    const idx = geo.clone().setIndex([0, 1, 2]); // instanced fields draw indexed geometry
    // every option combination AssetLibrary.material() can ask for, even if nothing used it yet
    for (let k = 0; k < 32; k++) this.lighting.material({ textured: true, cutout: !!(k & 16), wind: !!(k & 1), emissive: !!(k & 2), doubleSided: !!(k & 4) || !!(k & 16), foliage: !!(k & 8) });
    const tmp = [];
    const add = (m, plain) => {
      const f = new FieldMesh(idx, m, 1);
      f.drawCount = 1;
      f.layers.set(LAYERS.STATIC);
      stand.add(f);
      tmp.push(f);
      if (!plain) return;
      const a = new THREE.Mesh(geo, m);
      a.layers.set(LAYERS.STATIC);
      stand.add(a);
    };
    for (const m of this.lighting.materials.values()) add(m, true);
    for (const m of fadeMaterial.cache?.values() ?? []) add(m, false); // instanced only
    for (const m of lodMaterial.cache?.values() ?? []) add(m, false);
    for (const x of extras) stand.add(x);
    camera.getWorldDirection(stand.position).multiplyScalar(3).add(camera.position);
    scene.add(stand);
    const saved = [];
    // (meshes without vertices yet, e.g. no light halo placed, stay as they are; shadow-only
    // casters out of reach join their passes: userData.warmUpLayers)
    const show = (root) => root.traverse((o) => {
      if (o.geometry && !o.geometry.attributes.position) return;
      saved.push(o, o.visible, o.frustumCulled, o.layers.mask);
      o.visible = true; o.frustumCulled = false;
      if (o.userData.warmUpLayers) o.layers.mask |= o.userData.warmUpLayers;
    });
    show(scene);
    if (e.overlay?.scene) show(e.overlay.scene);
    try {
      // the main pass draws into the frame target when FXAA / SSR need one (Engine.js)
      const prev = r.getRenderTarget();
      r.setRenderTarget(e._frameTarget());
      await r.compileAsync(scene, camera);
      if (e.overlay?.scene) await r.compileAsync(e.overlay.scene, e.overlay.camera);
      for (const s of this.lighting.flare.scenes) await r.compileAsync(s, camera); // drawn only when the sun shows
      r.setRenderTarget(prev);
      // depth-pass (override) variants: draw the cascades once
      for (const c of this.lighting.sun.cascades ?? []) c.rendered = false;
      e.render();
    } catch (err) { console.warn('warm-up', err); }
    for (let i = 0; i < saved.length; i += 4) { saved[i].visible = saved[i + 1]; saved[i].frustumCulled = saved[i + 2]; saved[i].layers.mask = saved[i + 3]; }
    stand.removeFromParent();
    for (const x of extras) x.removeFromParent();
    for (const b of tmp) b.dispose();
    geo.dispose();
    idx.dispose();
    for (const c of this.lighting.sun.cascades ?? []) c.rendered = false;
    this.warmUpStats = { pipelines: e.pipelineCount() - p0, total: e.pipelineCount(), ms: Math.round(performance.now() - t0) };
    // which pipelines exist now (tests list the late ones: World.latePipelines)
    this._warmKeys = new Set(e.renderer._pipelines?.caches.keys() ?? []);
  }

  /** Render pipelines created after the warm-up: [material name, object name] (frame hitches). */
  latePipelines() {
    const out = [];
    for (const [k, p] of this.engine.renderer._pipelines?.caches ?? []) if (!this._warmKeys?.has(k)) out.push(p.vertexProgram?.name || p.fragmentProgram?.name || '?');
    return out;
  }

  /** world.json content with the current entities. */
  serialize() {
    return { ...this.data, entities: this.entities.serialize() };
  }

  update(dt, engine) {
    this.lighting.update(dt, { advanceDay: this.advanceDay });
    this.terrainRenderer.update(engine.camera);
    this.water.update(engine.camera);
    this.vegetation?.update(engine.camera);
    this.grass?.update(engine.camera);
    this.entities?.update(dt, engine);
  }
}
