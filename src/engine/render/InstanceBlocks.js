// Incremental instance uploads for an InstancedMesh fed by blocks of matrices (one block per
// sector / tile). Each block keeps its slot range while it stays wanted; a block that leaves is
// zeroed (a zero matrix collapses the instance to a point, nothing is rasterized) and its slots
// are reused. Only changed ranges are uploaded; the mesh is repacked contiguously only when it
// must grow or holes pile up. This keeps streaming (moving camera) uploads to a few KB per frame.
// Meshes are InstancedBatch (render/Instancing.js): `instanceMatrix` is their instance buffer,
// `instances` the drawn count, resize(capacity) a new, bigger buffer.

/**
 * mesh.userData.capacity must hold the instance buffer capacity (instances).
 * want: Map(key -> value); lenOf(key, value) -> instance count;
 * write(key, value, dst: Float32Array, dstInstance) copies the block's matrices.
 * changed: the keys that may have come into / gone out of `want` since the last sync (null: all
 * of them), so a sync costs what changed, not every block of the mesh.
 */
export function syncBlocks(m, want, lenOf, write, changed = null) {
  const u = m.userData;
  const blocks = (u.blocks ??= new Map()), free = (u.free ??= []);
  u.hw ??= 0; u.holes ??= 0;
  const attr = m.instanceMatrix;
  let arr = attr.array, touched = !!u.repack, add = 0;
  if (u.repack) { blocks.clear(); free.length = 0; changed = null; }
  for (const bk of changed ?? blocks.keys()) {
    const b = blocks.get(bk);
    if (!b || want.has(bk)) continue;
    arr.fill(0, b.start * 16, (b.start + b.len) * 16);
    attr.addUpdateRange(b.start * 16, b.len * 16);
    free.push(b);
    u.holes += b.len;
    blocks.delete(bk);
    touched = true;
  }
  for (const bk of changed ?? want.keys()) if (!blocks.has(bk) && want.has(bk)) add += lenOf(bk, want.get(bk));
  if (add || u.repack) {
    touched = true;
    if (u.repack || u.hw + add > u.capacity || u.holes + add > Math.max(512, (u.hw + add) * 0.4)) {
      u.repack = false;
      let total = 0;
      for (const [bk, v] of want) total += lenOf(bk, v);
      const fresh = total > u.capacity;
      if (fresh) m.resize(Math.ceil(total * 1.5));
      const a2 = m.instanceMatrix.array;
      blocks.clear(); free.length = 0;
      let o = 0;
      for (const [bk, v] of want) {
        const len = lenOf(bk, v);
        write(bk, v, a2, o);
        blocks.set(bk, { start: o, len });
        o += len;
      }
      if (!fresh) {
        if (o < u.hw) a2.fill(0, o * 16, u.hw * 16);
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, Math.max(o, u.hw) * 16);
      }
      m.instanceMatrix.needsUpdate = true;
      u.hw = o; u.holes = 0;
      setCount(m, o);
      setVisible(m, o > 0);
      return;
    }
    for (const bk of changed ?? want.keys()) {
      if (blocks.has(bk) || !want.has(bk)) continue;
      const v = want.get(bk), len = lenOf(bk, v);
      let start = -1;
      for (let i = 0; i < free.length; i++) {
        const f = free[i];
        if (f.len < len) continue;
        start = f.start;
        if (f.len === len) free.splice(i, 1); else { f.start += len; f.len -= len; }
        u.holes -= len;
        break;
      }
      if (start < 0) { start = u.hw; u.hw += len; }
      write(bk, v, arr, start);
      attr.addUpdateRange(start * 16, len * 16);
      blocks.set(bk, { start, len });
    }
  }
  if (!touched) return;
  // drop free space at the end
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < free.length; i++) {
      if (free[i].start + free[i].len !== u.hw) continue;
      u.hw = free[i].start; u.holes -= free[i].len;
      free.splice(i, 1);
      again = true;
      break;
    }
  }
  attr.needsUpdate = true;
  setCount(m, u.hw);
  setVisible(m, u.hw > u.holes);
}

function setCount(m, n) {
  m.instances = n;
  for (const t of m.userData.twins ?? []) t.instances = n;
}

// (twins: shadow-only meshes drawing the same instances; userData.hidden: switched off from the
// debug panel, Vegetation.setLodVisible; userData.live: has instances to draw)
function setVisible(m, v) {
  for (const o of [m, ...(m.userData.twins ?? [])]) {
    o.userData.live = v;
    o.visible = v && !o.userData.hidden;
  }
}

/** Live instances of a mesh driven by syncBlocks (count minus zeroed holes). */
export const liveCount = (m) => m.instances - (m.userData.holes ?? 0);
