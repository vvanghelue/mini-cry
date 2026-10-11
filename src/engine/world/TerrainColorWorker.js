// Computes every terrain vertex colour off the main thread at load (fbm noise, slope, water...),
// so building terrain chunks while moving never pays for it.
import { TerrainData } from './TerrainData.js';

self.onmessage = (ev) => {
  const { size, res, seaLevel, heights, material, rivers } = ev.data;
  const t = new TerrainData({ size, res, seaLevel });
  t.heights.set(heights);
  t.material.set(material);
  t.rivers = rivers;
  t.buildWaterGrid();
  const out = new Float32Array(3);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) t.vertexColor(i, j, out, 0);
  self.postMessage({ cache: t._cc }, [t._cc.buffer]);
};
