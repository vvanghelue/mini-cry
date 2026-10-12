// The game world shared by the game and the editor: terrain (data + renderer), water,
// environment (lighting), vegetation, entities and the static collision world.
import * as THREE from 'three';
import { Data } from '../core/Data.js';
import { LAYERS } from '../render/layers.js';
import { fadeMaterial } from '../render/InstancedField.js';
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
    // after the colour worker: the splatting texture reads every vertex's resolved material
    this.terrainRenderer = new TerrainRenderer(this.terrain, this.lighting);
    this.scene.add(this.terrainRenderer.group);
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
   * Compile every shader variant the game can draw, main pass and shadow pass, during loading
   * instead of hitching (100+ ms with ANGLE / Metal) the first time one shows up: everything in
   * the scene (hidden pools, LODs and far meshes included), a stand-in per cached lit material
   * (as the plain mesh a prop batch uses and as an instanced mesh), and `extras` (a character,
   * ...). One frame is drawn with every object shown and culling off, then the state is restored.
   */
  async warmUp(camera = this.engine.camera, extras = []) {
    const e = this.engine, r = e.renderer, scene = this.scene;
    const t0 = performance.now(), p0 = r.info.programs.length;
    const stand = new THREE.Group();
    stand.name = 'WarmUp';
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1e-3, 0, 0, 0, 1e-3, 0], 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    // foliage assets carry baked normals (another program variant). The depth passes (sun cascades,
    // SSAO pre-pass) draw everything with one shared override material, and three.js only rebuilds
    // its program when instancing (not the normals) changes from one object to the next: draw
    // plain / instanced / with / without normals alternately, last, so every variant compiles here
    const geo0 = geo.clone(); // without normals
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geo.setAttribute('surface', new THREE.Float32BufferAttribute([0, 0, 0], 1));
    const geoN = geo; // textured assets: normals + uv + surface
    // every option combination AssetLibrary.material() can ask for, even if nothing used it yet
    for (let k = 0; k < 32; k++) this.lighting.material({ textured: true, cutout: !!(k & 16), wind: !!(k & 1), emissive: !!(k & 2), doubleSided: !!(k & 4) || !!(k & 16), foliage: !!(k & 8) });
    const tmp = [];
    const add = (m, plain) => {
      const b = new THREE.InstancedMesh(geo, m, 1);
      b.layers.set(LAYERS.STATIC);
      stand.add(b);
      tmp.push(b);
      if (!plain) return;
      const a = new THREE.Mesh(geo, m);
      a.layers.set(LAYERS.STATIC);
      stand.add(a);
    };
    for (const m of this.lighting.materials.values()) add(m, true);
    for (const m of fadeMaterial.cache?.values() ?? []) add(m, false); // instanced only (reads instanceMatrix)
    for (const m of lodMaterial.cache?.values() ?? []) add(m, false);
    const fol = this.lighting.material({ textured: true, cutout: false, wind: false, emissive: false, doubleSided: true, foliage: true });
    [[geo0, false], [geoN, true], [geoN, false], [geo0, true]].forEach(([g, inst], i) => {
      const b = inst ? new THREE.InstancedMesh(g, fol, 1) : new THREE.Mesh(g, fol);
      b.layers.set(LAYERS.STATIC);
      b.renderOrder = 1e6 + i;
      stand.add(b);
      if (inst) tmp.push(b);
    });
    for (const x of extras) stand.add(x);
    camera.getWorldDirection(stand.position).multiplyScalar(3).add(camera.position);
    scene.add(stand);
    const saved = [];
    const show = (root) => root.traverse((o) => { saved.push(o, o.visible, o.frustumCulled); o.visible = true; o.frustumCulled = false; });
    show(scene);
    if (e.overlay?.scene) show(e.overlay.scene);
    try {
      // main-pass programs compile in parallel (KHR_parallel_shader_compile) when supported
      await r.compileAsync(scene, camera);
      if (e.overlay?.scene) await r.compileAsync(e.overlay.scene, e.overlay.camera);
      for (const s of this.lighting.flare.scenes) await r.compileAsync(s, camera); // drawn only when the sun shows
      // shadow-pass (depth override) variants: draw the cascades once
      for (const c of this.lighting.sun.cascades ?? []) c.rendered = false;
      e.render();
    } catch (err) { console.warn('warm-up', err); }
    for (let i = 0; i < saved.length; i += 3) { saved[i].visible = saved[i + 1]; saved[i].frustumCulled = saved[i + 2]; }
    stand.removeFromParent();
    for (const x of extras) x.removeFromParent();
    for (const b of tmp) b.dispose();
    geo.dispose();
    geo0.dispose();
    for (const c of this.lighting.sun.cascades ?? []) c.rendered = false;
    this.warmUpStats = { programs: r.info.programs.length - p0, total: r.info.programs.length, ms: Math.round(performance.now() - t0) };
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
