// Per-instance LOD selection with dithered cross-fades (no popping), for the instanced fields
// (FieldMesh, InstancedField.js).
//
// Each LOD mesh carries its range (mesh.userData.lodRange: inA, inB, outA, outB, read per draw as
// an object uniform): the instance (horizontal distance d from camPosW to its origin) fades in
// over [inA, inB], is solid up to outA and fades out over [outA, outB]. The CPU only picks which
// sectors each LOD mesh may need (every LOD whose range overlaps the sector); the shader collapses
// the instances outside the range (WorldMaterial.js worldPosition). Inside a band the two LODs
// fill complementary pixels of a 4x4 Bayer pattern (the fading-in one uses the mirrored
// threshold), so a pixel is never empty or drawn twice. Depth-only passes (sun cascades, SSAO
// pre-pass) switch hard at the middle of the band: stipple in a shadow map would only add noise.
import * as THREE from 'three/webgpu';
import { deriveMaterial } from './WorldMaterial.js';

export const LOD_BLEND = 0.12; // band width, as a fraction of the switch distance

/** Ranges [inA, inB, outA, outB] per LOD for switch distances `lods[i].distance`. shrink: the last
 *  LOD fades out by shrinking (fadeMaterial) instead of dithering. */
export function lodRanges(lods, { blend = LOD_BLEND, shrink = false } = {}) {
  const d = lods.map((l) => l.distance);
  // band width per boundary, capped so that the two bands of one LOD never overlap
  const w = d.map((b, i) => {
    const prev = i ? d[i - 1] : 0, next = d[i + 1];
    let x = Math.min(b * blend, (b - prev) / 2);
    if (next !== undefined) x = Math.min(x, (next - b) / 2);
    return x;
  });
  return d.map((e, i) => {
    const last = i === d.length - 1;
    const inA = i ? d[i - 1] - w[i - 1] / 2 : -1, inB = i ? d[i - 1] + w[i - 1] / 2 : -1;
    const [outA, outB] = !last ? [e - w[i] / 2, e + w[i] / 2] : shrink ? [e, e] : [e - w[i], e];
    return [inA, inB, outA, outB];
  });
}

/** Set a LOD mesh's range (its object uniform). */
export function setLodRange(mesh, [a, b, c, d]) {
  (mesh.userData.lodRange ??= new THREE.Vector4()).set(a, b, c, d);
}

/** Clone of a world material that draws only its LOD's instances and dithers the bands. */
export function lodMaterial(base) {
  const cache = (lodMaterial.cache ??= new Map());
  let m = cache.get(base.uuid);
  if (!m) cache.set(base.uuid, (m = base.mcSetup ? deriveMaterial(base, { lod: true }) : base));
  return m;
}
