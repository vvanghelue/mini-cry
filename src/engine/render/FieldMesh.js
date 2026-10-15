// Instanced mesh for the streamed fields (vegetation, grass, birds), without THREE.InstancedMesh:
// a plain Mesh drawing an InstancedBufferGeometry that shares the source geometry's buffers and
// reads each instance's matrix from four instanced vec4 attributes (iM0..iM3) of one interleaved
// buffer. The world materials apply it themselves (WorldMaterial.js worldPosition), after the
// per-instance vertex work in asset space (wind, LOD culling, shrink, bird wings).
// Why not InstancedMesh with WebGPURenderer: it builds every instanced mesh's shaders on their
// own (object id in the material cache key), keeps small instance counts in a uniform array
// sized by the count (a new program when the capacity grows) and refreshes dynamic instances
// fully every frame. Here every mesh of a material shares one program, the buffer grows without
// recompiling, and only the changed ranges are uploaded (InstanceBlocks.js).
//
// Close to InstancedMesh for InstanceBlocks / InstancedField: drawCount (instances drawn; not
// `count`, which three reads as an InstancedMesh and keys the shaders per object),
// instanceMatrix (.array, addUpdateRange, clearUpdateRanges, needsUpdate), setCapacity().
import * as THREE from 'three/webgpu';

export class FieldMesh extends THREE.Mesh {
  /** geometry: source geometry (its attributes / index are shared, not copied). */
  constructor(geometry, material, capacity = 16) {
    const g = new THREE.InstancedBufferGeometry();
    super(g, material);
    this.isFieldMesh = true;
    this.frustumCulled = false;
    this.matrixAutoUpdate = false;
    this.setSource(geometry);
    this.setCapacity(capacity);
    this.drawCount = 0;
  }

  /** Share another geometry's attributes and index (keeps the instance buffer). */
  setSource(geometry) {
    const g = this.geometry;
    for (const k of Object.keys(g.attributes)) if (!k.startsWith('iM') && k !== 'iColor') g.deleteAttribute(k);
    for (const [k, a] of Object.entries(geometry.attributes)) g.setAttribute(k, a);
    g.setIndex(geometry.index);
    g.boundingSphere = geometry.boundingSphere?.clone() ?? null;
    g.boundingBox = geometry.boundingBox?.clone() ?? null;
    g.userData.shared = Object.keys(geometry.attributes);
    return this;
  }

  /** (Re)allocate the instance buffer for n instances (contents are lost). */
  setCapacity(n) {
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(Math.max(1, n) * 16), 16, 1).setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < 4; i++) this.geometry.setAttribute('iM' + i, new THREE.InterleavedBufferAttribute(buf, 4, i * 4));
    this.instanceMatrix = buf;
    this.userData.capacity = Math.max(1, n);
    return this;
  }

  /** Optional per-instance colour (birds): attribute `iColor` (read by the world materials). */
  setInstanceColor(attr) {
    this.geometry.setAttribute('iColor', attr);
    this.instanceColorAttr = attr;
  }

  get drawCount() { return this.geometry.instanceCount; }
  set drawCount(n) { this.geometry.instanceCount = n; }

  setMatrixAt(i, m) { m.toArray(this.instanceMatrix.array, i * 16); }
  getMatrixAt(i, m) { return m.fromArray(this.instanceMatrix.array, i * 16); }

  /** Free the instance buffer (the shared source buffers stay with their owner). */
  dispose() {
    const g = this.geometry;
    for (const k of g.userData.shared ?? []) g.deleteAttribute(k);
    g.setIndex(null);
    g.dispose();
  }
}
