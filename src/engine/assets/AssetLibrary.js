// Runtime asset library: loads the asset definitions (public/data/assets/*.json, listed in
// assets/index.json), builds and caches their geometries per (quality, variant seed), and hands
// out the matching shared material.
import { Data } from '../core/Data.js';
import { buildAsset } from './ModelBuilder.js';

export class AssetLibrary {
  constructor(lighting) {
    this.lighting = lighting;
    this.defs = {};
    this.cache = new Map();
    this.version = 0;
  }

  async load() {
    let names;
    try { names = (await Data.json('assets/index.json', { fresh: true })).assets; }
    catch { names = []; }
    if (Data.canSave) {
      // dev: pick up files added by the CLI / editor even if the index is stale
      try { names = [...new Set([...names, ...(await Data.list('assets')).filter((f) => f.endsWith('.json') && !f.endsWith('index.json')).map((f) => f.slice(7, -5))])]; } catch { /* static build */ }
    }
    const defs = await Promise.all(names.map((n) => Data.json(`assets/${n}.json`, { fresh: true }).catch(() => null)));
    names.forEach((n, i) => { if (defs[i]) this.defs[n] = { name: n, ...defs[i] }; });
    return this;
  }

  get names() { return Object.keys(this.defs).sort(); }
  get(name) { return this.defs[name]; }
  has(name) { return !!this.defs[name]; }

  /** Replace / add a definition (editor, live tools) and drop its cached builds (and of assets that ref it). */
  set(name, def) {
    this.defs[name] = { ...def, name };
    for (const k of [...this.cache.keys()]) {
      const n = k.split('|')[0];
      if (n === name || JSON.stringify(this.defs[n] ?? {}).includes(`"${name}"`)) { this.cache.get(k).geometry.dispose(); this.cache.delete(k); }
    }
    this.version++;
  }

  /** { geometry, bounds, colliders, triangles, hasWind, hasEmissive, hasFoliage, glows } (cached, shared: don't dispose) */
  build(name, { quality = 1, variant = 0 } = {}) {
    const key = `${name}|${quality}|${variant}`;
    let b = this.cache.get(key);
    if (b) return b;
    const def = this.defs[name];
    if (!def) throw new Error(`unknown asset "${name}"`);
    b = buildAsset(def, { quality, seed: variant + 1, assets: this.defs });
    this.cache.set(key, b);
    return b;
  }

  /** Shared lit material for an asset's build. */
  material(b, extra = {}) {
    return this.lighting.material({ wind: b.hasWind, emissive: b.hasEmissive, doubleSided: b.doubleSided, foliage: !!b.hasFoliage, ...extra });
  }
}
