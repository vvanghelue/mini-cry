// GLB -> asset JSON: one `tris` part per material colour (flat-coloured CC0 models such as the
// Quaternius guns, no textures). The model is rotated / scaled to the asset conventions
// (docs/ASSETS.md: metres, +Y up, front toward -Z) and its origin moved to a chosen point.
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const D2R = Math.PI / 180;

export async function loadGLB(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
}

/**
 * opts: rot [x,y,z] deg (Euler YXZ, applied first), length (m, size along Z after rotation) or
 * scale, origin [x,y,z] (point of the scaled model that becomes the asset origin, in the frame
 * where the bounding box is centred on X / Z with its bottom at y = 0), decimals, brightness
 * (multiplier on the sRGB colour), minLight (floor of the sRGB channels, so black parts still
 * show their facets), jitter.
 */
export async function importGLB(file, opts = {}) {
  const gltf = await loadGLB(file);
  gltf.scene.updateMatrixWorld(true);
  const r = opts.rot ?? [0, 0, 0];
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'YXZ'));
  const groups = new Map(); // colour hex -> flat positions
  const box = new THREE.Box3();
  const v = new THREE.Vector3(), m = new THREE.Matrix4();
  let textured = 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat.map) textured++;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    m.multiplyMatrices(R, o.matrixWorld);
    const flip = m.determinant() < 0;
    const pos = g.attributes.position;
    const key = '#' + mat.color.getHexString();
    const out = groups.get(key) ?? [];
    for (let i = 0; i < pos.count; i += 3) {
      for (const k of flip ? [0, 2, 1] : [0, 1, 2]) {
        v.fromBufferAttribute(pos, i + k).applyMatrix4(m);
        box.expandByPoint(v);
        out.push(v.x, v.y, v.z);
      }
    }
    groups.set(key, out);
  });
  if (textured) throw new Error(`${textured} textured material(s): only flat-coloured models are supported`);
  const size = box.getSize(new THREE.Vector3());
  const s = opts.scale ?? (opts.length ? opts.length / size.z : 1);
  // frame: bbox centred on X / Z, bottom at y = 0, then the origin point moved to 0
  const base = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const o = new THREE.Vector3(...(opts.origin ?? [0, 0, 0]));
  const f = 10 ** (opts.decimals ?? 4);
  const round = (x) => Math.round(x * f) / f || 0;
  const parts = [];
  let tris = 0;
  const lo = opts.minLight ?? 0, k = opts.brightness ?? 1;
  for (const [hex, P] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const c = new THREE.Color(hex).getRGB({}, THREE.SRGBColorSpace);
    const srgb = [c.r, c.g, c.b].map((x) => Math.min(1, Math.max(lo, x * k)));
    const color = '#' + srgb.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
    const positions = new Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      positions[i] = round((P[i] - base.x) * s - o.x);
      positions[i + 1] = round((P[i + 1] - base.y) * s - o.y);
      positions[i + 2] = round((P[i + 2] - base.z) * s - o.z);
    }
    tris += P.length / 9;
    parts.push({ shape: 'tris', color, jitter: opts.jitter ?? 0.03, positions });
  }
  // the scaled model's extent in the output frame (to pick muzzle / sight / hand points)
  const min = [(box.min.x - base.x) * s - o.x, -o.y, (box.min.z - base.z) * s - o.z].map(round);
  const max = [(box.max.x - base.x) * s - o.x, size.y * s - o.y, (box.max.z - base.z) * s - o.z].map(round);
  return { parts, tris, bounds: { min, max }, scale: s };
}

/** JSON with number arrays kept on one line (raw triangle lists stay compact). */
export function stringifyCompact(obj) {
  const flat = (v) => typeof v === 'number' || (Array.isArray(v) && v.every((x) => typeof x === 'number'));
  return JSON.stringify(obj, (k, val) => (Array.isArray(val) && val.length && val.every(flat) ? '\u0000' + JSON.stringify(val) : val), 2)
    .replace(/"\\u0000(\[[^"]*\])"/g, '$1') + '\n';
}
