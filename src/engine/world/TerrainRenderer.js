// Terrain renderer: CDLOD (Strugar 2009, "Continuous Distance-Dependent Level of Detail").
//
// A quadtree over the heightfield is walked on the CPU every frame (node boxes from a min / max
// height pyramid, frustum culled); every selected quadrant is one instance of a single shared grid
// patch (PATCH x PATCH quads), all of them in ONE instanced draw. A patch of level L has cells of
// 2^L heightfield cells (2 m at level 0, 128 m at level 6) and covers the ground between
// range(L - 1) and range(L) = range0 x 2^L from the camera. Near the end of its range each vertex
// morphs (in the vertex shader, by its distance to the camera) onto the coarser grid: the odd
// vertices slide onto their even neighbours, so at the range's end the patch IS the next level's
// grid — no cracks, no skirts, no popping. Level 0 within ~0.7 x range0 is the heightfield itself,
// split along heightAt()'s diagonal: physics and what you see agree there.
//
// The heights (R32F, exact loads), the normals (RGBA8, full resolution, sampled per pixel: the coarse
// levels keep the fine shading) and the vertex tint (RGBA8 + mips, sampled at the patch's level)
// are textures; an edit re-uploads them (invalidate). The splatting reads the material ids from
// their own texture (render/TerrainMaterial.js).
//
// The sun cascades need casters out of the camera's view (a hill behind you shades the ground in
// front): a second instance list, same ranges and morph (no self-shadowing mismatch), selected by
// distance alone within the cascades' reach, drawn into the cascades only (shadowMesh).
import * as THREE from 'three/webgpu';
import { Fn, float, int, ivec2, vec2, vec3, vec4, mix, clamp, fract, round, exp2, distance, select, attribute, positionLocal, varyingProperty, cameraPosition } from 'three/tsl';
import { LAYERS } from '../render/layers.js';
import { terrainMaterial } from '../render/TerrainMaterial.js';
import { U, tex } from '../render/tsl.js';

const PATCH = 8; // quads per patch side
const MORPH = 0.7; // morph over the last 30 % of a level's range
const MAX_PATCHES = 4096;
// a level's range must be >= ~4 node sizes: the far edge of a patch stays within the next level's
// unmorphed start (1 + MORPH ranges), else a patch fully morphed meets one already morphing (cracks)
const MIN_RANGE = (2 * 1.42) / MORPH + 0.1;

export class TerrainRenderer {
  constructor(terrain, lighting, { range0 = 160 } = {}) {
    this.terrain = terrain;
    this.lighting = lighting;
    this._range0 = range0;
    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    const t = terrain, res = t.res;
    // level 0 node = 2 patches of PATCH cells of 1 heightfield cell; the root covers the map
    this.leaf = 2 * PATCH * t.cell;
    this.levels = Math.ceil(Math.log2((res - 1) / (2 * PATCH)));
    this.rootSize = this.leaf * 2 ** this.levels;
    this.range0 = range0;
    this._textures();
    this.material = terrainMaterial(lighting, terrain, { normalTex: this.normalTex });
    this.idTex = this.material.userData.terrainIds;
    this.fillIds();
    this.u = { range0: U(range0), cam: U(new THREE.Vector3()) };
    this.material.positionNode = this._positionNode();
    this.mesh = this._mesh('terrain');
    // main view + the SSAO pre-pass (OCCLUDER), not the cascades (they draw shadowMesh)
    this.mesh.layers.set(LAYERS.DETAIL);
    this.mesh.layers.enable(LAYERS.OCCLUDER);
    this.shadowMesh = this._mesh('terrain_shadow');
    this.shadowMesh.layers.mask = 0;
    for (let i = 0; i < 3; i++) this.shadowMesh.layers.enable(LAYERS.CASCADE + i);
    this.group.add(this.mesh, this.shadowMesh);
    this._frustum = new THREE.Frustum();
    this._pm = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this.stats = { triangles: 0, patches: 0, shadowPatches: 0 };
    // patches before the first update: the loading warm-up compiles what it draws (World.warmUp)
    for (const m of [this.mesh, this.shadowMesh]) this._select(m, _a.set(0, 1e4, 0), null, Infinity);
  }

  /** m: level 0's range (World.applyQuality: from the draw scale), at least MIN_RANGE nodes. */
  get range0() { return this._range0; }
  set range0(v) { this._range0 = Math.max(v, MIN_RANGE * this.leaf); }

  /** Height (R32F), normal (RGBA8) and tint (RGBA8, mipmapped) textures, one texel per vertex. */
  _textures() {
    const t = this.terrain, res = t.res;
    this.heightTex = new THREE.DataTexture(new Float32Array(res * res), res, res, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter;
    this.normalTex = new THREE.DataTexture(new Uint8Array(res * res * 4), res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.normalTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.normalTex.magFilter = THREE.LinearFilter;
    this.normalTex.generateMipmaps = true;
    this.tintTex = new THREE.DataTexture(new Uint8Array(res * res * 4), res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tintTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tintTex.magFilter = THREE.LinearFilter;
    this.tintTex.generateMipmaps = true;
    for (const x of [this.heightTex, this.normalTex, this.tintTex]) x.wrapS = x.wrapT = THREE.ClampToEdgeWrapping;
    this._fill();
  }

  /** Fill the textures (a grid rect {i0, i1, j0, j1}, or everything) + the height pyramid. */
  _fill(rect) {
    const t = this.terrain, res = t.res, h = t.heights, c2 = 2 * t.cell;
    const i0 = Math.max(0, rect?.i0 ?? 0), i1 = Math.min(res - 1, rect?.i1 ?? res - 1);
    const j0 = Math.max(0, rect?.j0 ?? 0), j1 = Math.min(res - 1, rect?.j1 ?? res - 1);
    const H = this.heightTex.image.data, N = this.normalTex.image.data, C = this.tintTex.image.data;
    const tint = new Float32Array(3);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * res + i;
        H[k] = h[k];
        // the old per-vertex normals: central differences of the full-resolution heightfield
        const nx = (t.h(i - 1, j) - t.h(i + 1, j)) / c2, nz = (t.h(i, j - 1) - t.h(i, j + 1)) / c2;
        const l = Math.hypot(nx, 1, nz);
        N[k * 4] = Math.round((nx / l * 0.5 + 0.5) * 255);
        N[k * 4 + 1] = Math.round((1 / l * 0.5 + 0.5) * 255);
        N[k * 4 + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
        N[k * 4 + 3] = 255;
        // tint (linear, 0..2) / 2
        t.vertexTint(i, j, tint, 0);
        C[k * 4] = Math.round(Math.min(1, tint[0] / 2) * 255);
        C[k * 4 + 1] = Math.round(Math.min(1, tint[1] / 2) * 255);
        C[k * 4 + 2] = Math.round(Math.min(1, tint[2] / 2) * 255);
        C[k * 4 + 3] = 255;
      }
    }
    for (const x of [this.heightTex, this.normalTex, this.tintTex]) x.needsUpdate = true;
    this._pyramid(rect && { i0, i1, j0, j1 });
  }

  /** Min / max height per node of every level (node boxes for the selection and culling); after an
   *  edit only the nodes over the grid rect. */
  _pyramid(rect) {
    const t = this.terrain, res = t.res, span = this.leaf / t.cell; // grid cells per level 0 node
    if (!this.pyr) {
      this.pyr = [];
      for (let L = 0; L <= this.levels; L++) {
        const n = Math.ceil(this.rootSize / (this.leaf * 2 ** L));
        this.pyr.push({ n, mn: new Float32Array(n * n).fill(Infinity), mx: new Float32Array(n * n).fill(-Infinity) });
      }
      rect = null;
    }
    // level 0 nodes over the rect (a vertex on a node border belongs to both nodes)
    const n0 = this.pyr[0].n;
    let a0 = 0, a1 = n0 - 1, b0 = 0, b1 = n0 - 1;
    if (rect) {
      a0 = Math.max(0, Math.floor((rect.i0 - 1) / span)); a1 = Math.min(n0 - 1, Math.floor(rect.i1 / span));
      b0 = Math.max(0, Math.floor((rect.j0 - 1) / span)); b1 = Math.min(n0 - 1, Math.floor(rect.j1 / span));
    }
    const P0 = this.pyr[0];
    for (let nj = b0; nj <= b1; nj++) {
      for (let ni = a0; ni <= a1; ni++) {
        let mn = Infinity, mx = -Infinity;
        const i1 = Math.min(res - 1, (ni + 1) * span), j1 = Math.min(res - 1, (nj + 1) * span);
        for (let j = nj * span; j <= j1; j++) {
          for (let i = ni * span; i <= i1; i++) {
            const v = t.heights[j * res + i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        P0.mn[nj * n0 + ni] = mn;
        P0.mx[nj * n0 + ni] = mx;
      }
    }
    // the levels above, over the same area
    for (let L = 1; L <= this.levels; L++) {
      const P = this.pyr[L], C = this.pyr[L - 1], n = P.n;
      a0 >>= 1; a1 >>= 1; b0 >>= 1; b1 >>= 1;
      for (let j = b0; j <= Math.min(b1, n - 1); j++) {
        for (let i = a0; i <= Math.min(a1, n - 1); i++) {
          let mn = Infinity, mx = -Infinity;
          for (let q = 0; q < 4; q++) {
            const ci = 2 * i + (q & 1), cj = 2 * j + (q >> 1);
            if (ci >= C.n || cj >= C.n) continue;
            mn = Math.min(mn, C.mn[cj * C.n + ci]);
            mx = Math.max(mx, C.mx[cj * C.n + ci]);
          }
          P.mn[j * n + i] = mn;
          P.mx[j * n + i] = mx;
        }
      }
    }
  }

  _mesh(name) {
    const n = PATCH + 1, pos = new Float32Array(n * n * 3), nrm = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { pos.set([i, 0, j], (j * n + i) * 3); nrm[(j * n + i) * 3 + 1] = 1; }
    const idx = [];
    for (let j = 0; j < PATCH; j++) {
      for (let i = 0; i < PATCH; i++) {
        // heightAt()'s diagonal, from (i + 1, j) to (i, j + 1) (morphing keeps it at every level)
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); // (the shading normal is per pixel)
    g.setIndex(idx);
    const inst = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PATCHES * 4), 4);
    g.setAttribute('terPatch', inst);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const m = new THREE.Mesh(g, this.material);
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.name = name;
    m.userData.inst = inst;
    return m;
  }

  /** Vertex stage: the patch instance's vertex on the heightfield, morphed toward the next level. */
  _positionNode() {
    const t = this.terrain, u = this.u, hT = tex(this.heightTex), tintT = tex(this.tintTex);
    const half = t.half, cell = t.cell, res = t.res;
    const hAt = (xz) => hT.load(ivec2(round(xz.add(half).div(cell))).clamp(ivec2(0), ivec2(res - 1))).x;
    return Fn(() => {
      const p = attribute('terPatch', 'vec4'); // x0, z0, cell size (m), level
      const g = positionLocal.xz;
      const w = p.xy.add(g.mul(p.z)).toVar();
      const h0 = hAt(w).toVar();
      const range = u.range0.mul(exp2(p.w)).toVar();
      const start = mix(select(p.w.greaterThan(0.5), range.mul(0.5), float(0.0)), range, MORPH);
      const k = clamp(distance(u.cam, vec3(w.x, h0, w.y)).sub(start).div(range.sub(start)), 0.0, 1.0).toVar();
      // odd vertices slide onto their even neighbour (at k = 1 the patch is the coarser grid)
      const target = w.sub(fract(g.mul(0.5)).mul(2.0).mul(p.z)).toVar();
      const xz = mix(w, target, k).toVar();
      const y = mix(h0, hAt(target), k);
      // the vertex tint, from the mip level of this cell size
      const uv = xz.add(half).div(cell).add(0.5).div(res);
      varyingProperty('vec3', 'vTerrTint').assign(tintT.sample(uv).level(p.w).rgb.mul(2.0));
      return vec3(xz.x, y, xz.y);
    })();
  }

  /** Select the patches for the camera (call every frame: a few hundred box tests). */
  update(camera) {
    const cp = camera.position;
    this.u.range0.value = this.range0;
    this.u.cam.value.copy(cp);
    this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._pm);
    this.stats.patches = this._select(this.mesh, cp, this._frustum, Infinity);
    // shadow casters: by distance alone, as far as the cascades reach
    const sun = this.lighting.sun, last = sun.cascades.length - 1;
    const reach = last >= 0 && sun.enabled ? sun.reach(last) + 60 : 0;
    this.stats.shadowPatches = this._select(this.shadowMesh, cp, null, reach);
    this.stats.triangles = this.stats.patches * PATCH * PATCH * 2;
  }

  _select(mesh, cp, frustum, reach) {
    const out = (this._out ??= []);
    out.length = 0;
    this._walk(out, 0, 0, this.levels, cp, frustum, reach);
    const attr = mesh.userData.inst, a = attr.array, n = Math.min(out.length / 4, MAX_PATCHES);
    // upload only when the selection changed
    let same = n === mesh.geometry.instanceCount;
    for (let i = 0; same && i < n * 4; i++) same = a[i] === out[i];
    if (!same) {
      a.set(n * 4 === out.length ? out : out.slice(0, n * 4));
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * 4);
      attr.needsUpdate = true;
      mesh.geometry.instanceCount = n;
    }
    mesh.visible = n > 0;
    return n;
  }

  _nodeBox(L, i, j) {
    const t = this.terrain, P = this.pyr[L], s = this.leaf * 2 ** L, k = j * P.n + i;
    if (!(P.mn[k] <= P.mx[k])) return null; // past the heightfield
    return this._box.set(_a.set(i * s - t.half, P.mn[k], j * s - t.half), _b.set((i + 1) * s - t.half, P.mx[k], (j + 1) * s - t.half));
  }

  /** CDLOD selection (the reference's): a node in range of the next finer level splits; the
   *  quadrants of a split node that the finer level doesn't reach are drawn at this node's level. */
  _walk(out, i, j, L, cp, frustum, reach) {
    const box = this._nodeBox(L, i, j);
    if (!box) return;
    const d = box.distanceToPoint(cp);
    if (d > reach) return;
    if (frustum && !frustum.intersectsBox(box)) return;
    if (L === 0 || d >= this.range0 * 2 ** (L - 1)) { this._emitNode(out, i, j, L, cp, frustum, reach); return; }
    for (let q = 0; q < 4; q++) {
      const ci = 2 * i + (q & 1), cj = 2 * j + (q >> 1), cb = this._nodeBox(L - 1, ci, cj);
      if (!cb) continue;
      const cd = cb.distanceToPoint(cp);
      if (cd < this.range0 * 2 ** (L - 1)) this._walk(out, ci, cj, L - 1, cp, frustum, reach);
      else if (cd <= reach && (!frustum || frustum.intersectsBox(cb))) this._emit(out, ci, cj, L - 1, L);
    }
  }

  /** A node drawn whole: its four quadrants (patches), each culled. */
  _emitNode(out, i, j, L, cp, frustum, reach) {
    for (let q = 0; q < 4; q++) {
      if (L === 0) { this._emitQuad(out, i, j, q, cp, frustum, reach); continue; }
      const ci = 2 * i + (q & 1), cj = 2 * j + (q >> 1), cb = this._nodeBox(L - 1, ci, cj);
      if (!cb || cb.distanceToPoint(cp) > reach || (frustum && !frustum.intersectsBox(cb))) continue;
      this._emit(out, ci, cj, L - 1, L);
    }
  }

  /** Level 0 node: its quadrants have no pyramid entries of their own (the node's box). */
  _emitQuad(out, i, j, q, cp, frustum, reach) {
    const t = this.terrain, s = this.leaf / 2, P = this.pyr[0], k = j * P.n + i;
    const x0 = i * this.leaf - t.half + (q & 1) * s, z0 = j * this.leaf - t.half + (q >> 1) * s;
    const b = this._box.set(_a.set(x0, P.mn[k], z0), _b.set(x0 + s, P.mx[k], z0 + s));
    if (b.distanceToPoint(cp) > reach || (frustum && !frustum.intersectsBox(b))) return;
    out.push(x0, z0, s / PATCH, 0);
  }

  /** One patch: the area of node (i, j) of level `child` drawn at level `L` (cells: 2^L hf cells). */
  _emit(out, i, j, child, L) {
    const t = this.terrain, s = this.leaf * 2 ** child;
    if (out.length >= MAX_PATCHES * 4) return;
    out.push(i * s - t.half, j * s - t.half, s / PATCH, L);
  }

  /** Material id per vertex -> the splatting texture (all of it, or a grid rect after an edit). */
  fillIds(rect) {
    const t = this.terrain, res = t.res, d = this.idTex.image.data;
    const i0 = Math.max(0, rect?.i0 ?? 0), i1 = Math.min(res - 1, rect?.i1 ?? res - 1);
    const j0 = Math.max(0, rect?.j0 ?? 0), j1 = Math.min(res - 1, rect?.j1 ?? res - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) d[j * res + i] = t.resolvedMaterial(i, j);
    this.idTex.needsUpdate = true;
  }

  /** After sculpting / painting a grid rect {i0, i1, j0, j1}: its heights, normals, tints, ids. */
  invalidate(rect) {
    const r = rect && { i0: rect.i0 - 3, i1: rect.i1 + 3, j0: rect.j0 - 3, j1: rect.j1 + 3 };
    this.fillIds(r);
    this._fill(r);
  }

  invalidateAll() {
    this.fillIds();
    this._fill();
  }

  dispose() {
    for (const m of [this.mesh, this.shadowMesh]) m.geometry.dispose();
    for (const x of [this.heightTex, this.normalTex, this.tintTex]) x.dispose();
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
