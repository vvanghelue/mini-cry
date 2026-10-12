// Bake scene: the static world as ray-traceable data — the full-resolution terrain heightfield, every static
// prop (and other placed asset entities) and the vegetation species that matter for light (trees,
// rocks; not ferns / flowers / small bushes). Built from public/data like the game builds it.
import * as THREE from 'three';
import { buildAsset } from '../../../src/engine/assets/ModelBuilder.js';
import { decodeVegetation } from '../../../src/engine/world/VegetationScatter.js';
import { entityMatrix } from '../../../src/engine/world/Entities.js';
import { buildMesh, buildScene, buildHeightfield } from './bvh.js';

// entity types drawn with a static asset mesh, and their default asset
export const ASSET_TYPES = { prop: null, interactable: 'radio_table', destructible: 'generator', explosive: 'barrel_explosive', alarm: 'alarm' };
// vegetation species whose shadow distance says they are big enough to shape the light
export const VEG_MIN_SHADOW = 30;
const VEG_QUALITY = 0.5;

/** Terrain as a heightfield (traced with its max-height pyramid) + linear vertex colours. */
export function terrainField(t) {
  const n = t.res * t.res;
  const col = new Float32Array(n * 3), c = new Float32Array(3);
  for (let j = 0; j < t.res; j++) for (let i = 0; i < t.res; i++) { t.vertexColor(i, j, c, 0); col.set(c, (j * t.res + i) * 3); }
  return buildHeightfield(t.heights, col, t.res, t.size);
}

function assetMesh(build) {
  const g = build.geometry;
  const p = g.attributes.position.array, cl = g.attributes.color.array, sf = g.attributes.surface?.array;
  const n = p.length / 9;
  // alpha-cut leaf cards / fronds (surface >= 64) are quads drawn as two triangles: keep one of the
  // two, about the share of the card the leaves really cover
  const keep = [];
  for (let t = 0; t < n; t++) if (!(sf && sf[t * 3] >= 64 && t % 2)) keep.push(t);
  const pos = new Float32Array(keep.length * 9), col = new Float32Array(keep.length * 3);
  keep.forEach((t, k) => {
    pos.set(p.subarray(t * 9, t * 9 + 9), k * 9);
    col[k * 3] = cl[t * 9]; col[k * 3 + 1] = cl[t * 9 + 1]; col[k * 3 + 2] = cl[t * 9 + 2];
  });
  return { pos, col };
}

const boundsOf = (pos) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], pos[k + a]); b[a + 3] = Math.max(b[a + 3], pos[k + a]); }
  return b;
};

/**
 * { meshes: [{ nodes, tris, colors, doubleSided }], tlas, inst, stats } ready to share with workers.
 * terrain: TerrainData, assets: all asset defs, world: world.json, vegDef / vegBytes: vegetation.
 */
export function buildBakeScene({ terrain, assets, world, vegDef, vegBytes, log = () => {} }) {
  const meshes = [], meshBounds = [], instances = [];
  const t0 = Date.now();
  const hf = terrainField(terrain);
  log(`terrain: heightfield ${terrain.res}x${terrain.res}, ${Date.now() - t0} ms`);

  const cache = new Map();
  const meshFor = (name, quality, variant) => {
    const key = `${name}|${quality}|${variant}`;
    if (cache.has(key)) return cache.get(key);
    let id = -1;
    try {
      const b = buildAsset(assets[name], { quality, seed: variant + 1, assets });
      const m = assetMesh(b);
      if (m.pos.length) {
        id = meshes.length;
        meshes.push(buildMesh(m.pos, m.col, { doubleSided: b.doubleSided }));
        meshBounds.push(boundsOf(m.pos));
      }
      b.geometry.dispose();
    } catch (err) { log(`asset ${name}: ${err.message}`); }
    cache.set(key, id);
    return id;
  };

  let props = 0;
  const m4 = new THREE.Matrix4();
  for (const e of world.entities ?? []) {
    if (!(e.type in ASSET_TYPES) || e.disabled) continue;
    const name = e.asset ?? ASSET_TYPES[e.type];
    if (!name || !assets[name]) continue;
    const id = meshFor(name, 1, 0);
    if (id < 0) continue;
    instances.push({ mesh: id, matrix: entityMatrix(e, m4).elements.slice() });
    props++;
  }

  let veg = 0;
  if (vegBytes?.length) {
    const d = decodeVegetation(vegBytes);
    const species = vegDef.species ?? [];
    const keep = species.map((s) => !!assets[s.asset] && (s.castShadow ?? 0) >= VEG_MIN_SHADOW);
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < d.n; k++) {
      const sp = d.species[k];
      if (!keep[sp]) continue;
      const id = meshFor(species[sp].asset, VEG_QUALITY, d.variant[k]);
      if (id < 0) continue;
      q.setFromAxisAngle(up, d.yaw[k]);
      m4.compose(p.set(d.x[k], terrain.heightAt(d.x[k], d.z[k]) - 0.05, d.z[k]), q, s.setScalar(d.scale[k]));
      instances.push({ mesh: id, matrix: m4.elements.slice() });
      veg++;
    }
  }
  const sc = buildScene(instances, meshBounds);
  const tris = meshes.reduce((a, m) => a + m.triCount, 0);
  log(`scene: ${meshes.length} meshes, ${props} props, ${veg} plants, ${tris} triangles, ${Date.now() - t0} ms`);
  return { hf, meshes, tlas: sc.tlas, inst: sc.inst, stats: { meshes: meshes.length, props, plants: veg, triangles: tris } };
}
