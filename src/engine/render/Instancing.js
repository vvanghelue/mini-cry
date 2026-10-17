// Instanced meshes drawn with our own instance attributes (iM0..iM3: the columns of each
// instance's matrix, one interleaved buffer), applied by the materials' position node (Lighting.js
// vertexNode). three.js' InstancedMesh keys its shaders per object (every instanced mesh would
// build and compile its own pipeline); these share one per material.
//
// The API mirrors what the engine used on InstancedMesh: `instanceMatrix` (.array, addUpdateRange,
// needsUpdate), `instances` (the drawn count, InstancedMesh.count), resize(capacity), setMatrixAt.
import * as THREE from 'three/webgpu';
import { INSTANCE_ATTRS } from './tsl.js';

/** An InstancedBufferGeometry sharing `geometry`'s vertex attributes and index, with instance
 *  matrix attributes on `buffer` (an InstancedInterleavedBuffer of 16 floats per instance). */
export function instancedGeometry(geometry, buffer) {
  const g = new THREE.InstancedBufferGeometry();
  for (const [k, a] of Object.entries(geometry.attributes)) g.setAttribute(k, a);
  if (geometry.index) g.setIndex(geometry.index);
  g.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  g.boundingBox = geometry.boundingBox?.clone() ?? null;
  g.drawRange = geometry.drawRange;
  g.userData.shared = Object.keys(geometry.attributes);
  setInstanceBuffer(g, buffer);
  g.instanceCount = 0;
  return g;
}

export function setInstanceBuffer(g, buffer) {
  INSTANCE_ATTRS.forEach((k, i) => g.setAttribute(k, new THREE.InterleavedBufferAttribute(buffer, 4, i * 4)));
}

/** (Static usage: WebGPU three re-uploads DynamicDrawUsage buffers whole at every draw; changes go
 *  up through needsUpdate + update ranges instead, InstanceBlocks.js.) */
export function instanceBuffer(capacity) {
  return new THREE.InstancedInterleavedBuffer(new Float32Array(Math.max(1, capacity) * 16), 16, 1);
}

export class InstancedBatch extends THREE.Mesh {
  /** geometry: a plain geometry (its attributes are shared, not copied) */
  constructor(geometry, material, capacity = 16) {
    const buffer = instanceBuffer(capacity);
    super(instancedGeometry(geometry, buffer), material);
    this.isInstancedBatch = true;
    this.frustumCulled = false;
    this.userData.capacity = capacity;
    this._buffer = buffer;
  }

  get instanceMatrix() { return this._buffer; }

  /** Number of instances drawn (InstancedMesh.count). */
  get instances() { return this.geometry.instanceCount; }
  set instances(n) { this.geometry.instanceCount = n; }

  /** New, empty instance buffer of `capacity` instances. */
  resize(capacity) {
    this._buffer = instanceBuffer(capacity);
    setInstanceBuffer(this.geometry, this._buffer);
    this.userData.capacity = capacity;
    for (const t of this.userData.twins ?? []) t.shareInstances(this);
    return this._buffer;
  }

  /** Draw another mesh's instances (shadow-only twin of an impostor mesh): same buffer, same count. */
  shareInstances(src) {
    this._buffer = src._buffer;
    setInstanceBuffer(this.geometry, src._buffer);
    this.geometry.instanceCount = src.geometry.instanceCount;
    (src.userData.twins ??= new Set()).add(this);
  }

  setMatrixAt(i, m) {
    m.toArray(this._buffer.array, i * 16);
  }

  getMatrixAt(i, m) {
    return m.fromArray(this._buffer.array, i * 16);
  }

  /** Free the geometry without the vertex buffers it shares with its source. */
  disposeShared() {
    const g = this.geometry;
    for (const k of g.userData.shared ?? []) g.deleteAttribute(k);
    g.setIndex(null);
    g.dispose();
  }
}
