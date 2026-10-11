// Render layers. The main camera sees all of them; the sun shadow cascades only STATIC + DYNAMIC.
//   STATIC  - terrain, props, trees (cast + receive sun shadows)
//   DYNAMIC - characters, vehicles, pickups (cast + receive)
//   DETAIL  - grass, small plants, water, decals (receive only, never cast)
//   FX      - particles, tracers, editor helpers (unlit or self-lit)
//   VIEW    - first-person weapon view model (drawn in its own pass)
export const LAYERS = { STATIC: 0, DYNAMIC: 1, DETAIL: 2, FX: 3, VIEW: 4, EDITOR: 5 };

export function setLayer(obj, layer) {
  obj.traverse((o) => o.layers.set(layer));
  return obj;
}
