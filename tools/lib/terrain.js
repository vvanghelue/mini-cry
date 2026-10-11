// Terrain load / save / preview for the Node tools.
import { TerrainData, TERRAIN_MATERIALS } from '../../src/engine/world/TerrainData.js';
import { readJSON, readBin, writeJSON, writeBin, exists } from './data.js';
import { encodePNG } from './png.js';

export function loadTerrain() {
  if (!exists('terrain/terrain.json')) throw new Error('no terrain yet: run `npm run mc -- terrain generate`');
  const meta = readJSON('terrain/terrain.json');
  return TerrainData.decode(meta, readBin('terrain/height.bin'), readBin('terrain/material.bin'));
}

export function saveTerrain(t) {
  const { meta, heightBytes, materialBytes } = t.encode();
  writeBin('terrain/height.bin', heightBytes);
  writeBin('terrain/material.bin', materialBytes);
  writeJSON('terrain/terrain.json', meta);
  return meta;
}

/** Top-down shaded map (what the in-game map screen shows too). markers: [{x, z, color:[r,g,b], r}] */
export function terrainPreview(t, size = 1024, markers = [], view = null) {
  const px = new Uint8Array(size * size * 3);
  const col = new Float32Array(3);
  const v = view ?? { x0: -t.half, z0: -t.half, span: t.size };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const wx = v.x0 + (x + 0.5) / size * v.span, wz = v.z0 + (y + 0.5) / size * v.span;
      const i = Math.max(0, Math.min(t.res - 1, Math.round(t.gx(wx)))), j = Math.max(0, Math.min(t.res - 1, Math.round(t.gz(wz))));
      t.vertexColor(i, j, col, 0);
      let r = Math.sqrt(col[0]), g = Math.sqrt(col[1]), b = Math.sqrt(col[2]);
      // hill shade from the north-west
      const n = t.normalAt(wx, wz);
      const shade = Math.max(0.35, Math.min(1.25, 0.75 + (-n.x * 0.6 - n.z * 0.6 + n.y * 0.3) * 0.9));
      r *= shade; g *= shade; b *= shade;
      const h = t.heightAt(wx, wz), wl = t.waterLevelAt(wx, wz);
      if (h < wl) {
        const d = Math.min(1, (wl - h) / 18);
        const wr = 0.25 - d * 0.2, wg = 0.75 - d * 0.45, wb = 0.78 - d * 0.25;
        const a = 0.55 + d * 0.4;
        r = r * (1 - a) + wr * a; g = g * (1 - a) + wg * a; b = b * (1 - a) + wb * a;
      }
      // contour lines every 20 m
      if (h > 0 && Math.abs((h % 20) - 10) > 9.3) { r *= 0.85; g *= 0.85; b *= 0.85; }
      const o = (y * size + x) * 3;
      px[o] = Math.min(255, r * 255); px[o + 1] = Math.min(255, g * 255); px[o + 2] = Math.min(255, b * 255);
    }
  }
  for (const m of markers) {
    const cx = (m.x - v.x0) / v.span * size, cy = (m.z - v.z0) / v.span * size, rr = m.r ?? 3;
    for (let y = Math.floor(cy - rr); y <= cy + rr; y++) for (let x = Math.floor(cx - rr); x <= cx + rr; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size || Math.hypot(x - cx, y - cy) > rr) continue;
      const o = (y * size + x) * 3;
      px[o] = m.color[0]; px[o + 1] = m.color[1]; px[o + 2] = m.color[2];
    }
  }
  return encodePNG(size, size, px, 3);
}

export { TERRAIN_MATERIALS };
