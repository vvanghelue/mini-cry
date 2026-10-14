// Render layers. The main camera sees all of them but EDITOR and CASCADE; sun cascade i only STATIC +
// DYNAMIC + CASCADE + i, the SSAO depth pre-pass STATIC + DYNAMIC + OCCLUDER.
//   STATIC   - terrain, props (cast into every cascade + receive sun shadows)
//   DYNAMIC  - characters, vehicles, pickups (cast + receive)
//   DETAIL   - grass, small plants, water, decals (receive only, never cast)
//   FX       - particles, tracers, editor helpers (unlit or self-lit)
//   VIEW     - first-person weapon view model (drawn in its own pass)
//   OCCLUDER - LOD'd instance fields (vegetation) in the SSAO depth pre-pass
//   CASCADE  - CASCADE + i (i < 3): LOD'd instance fields cast into sun cascade i only (InstancedField
//              picks, per LOD mesh, the cascades it can land in); alone, a shadow-only caster
export const LAYERS = { STATIC: 0, DYNAMIC: 1, DETAIL: 2, FX: 3, VIEW: 4, EDITOR: 5, OCCLUDER: 6, CASCADE: 7 };

export function setLayer(obj, layer) {
  obj.traverse((o) => o.layers.set(layer));
  return obj;
}
