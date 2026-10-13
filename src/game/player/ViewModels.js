// First-person models (public/models/fp/*.glb, built by `mc viewmodel build` from the sources in
// public/data/viewmodels.json): the arms (`arms_<name>.glb`) and the realistic weapons
// (`<asset>.glb`, weapon space = the asset's: same origin, muzzle, sight and hands). Loaded once at
// start; a weapon without one keeps its low-poly asset in first person.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const BASE = (import.meta.env?.BASE_URL ?? '/') + 'models/fp/';

/** manifest: viewmodels.json; arms: player.json arms.model. -> { arms: gltf | null, weapons: { asset: gltf } } */
export async function loadViewModels(manifest, arms, renderer) {
  const loader = new GLTFLoader();
  const aniso = Math.min(8, renderer?.capabilities.getMaxAnisotropy() ?? 1);
  const load = async (file) => {
    try {
      const g = await loader.loadAsync(BASE + file + '.glb');
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (o.material[k]) o.material[k].anisotropy = aniso;
      });
      return g;
    } catch (e) { console.warn('view model', file, e); return null; }
  };
  const out = { arms: null, weapons: {} };
  await Promise.all([
    manifest.arms?.[arms] ? load('arms_' + arms).then((g) => (out.arms = g)) : null,
    ...Object.keys(manifest.weapons ?? {}).map((k) => load(k).then((g) => { if (g) out.weapons[k] = g; })),
  ]);
  return out;
}

/** Bounds of a loaded model (its own frame). */
export function modelBounds(scene) {
  scene.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(scene);
}
