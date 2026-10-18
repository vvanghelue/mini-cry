// Far sun shadows: the shadows of the terrain and of the trees across the whole island, past the
// sun cascades (which stop at the quality preset's shadow distance, 110-220 m) and, for the terrain,
// on top of them (a mountain 500 m toward the sun is outside every cascade's box). Mountains shadow
// the valleys, the sea and the forests below them; every tree shadows the ground, to the horizon.
//
// - Terrain: a horizon sweep on the GPU (compute). The heightfield is walked along lines parallel to
//   the sun's azimuth, one thread per line, from the sun's side: the horizon height carried along
//   the line, H(p) = max(h(p + d) - d·tanE, H(p + d) - d·tanE) one sample (d) earlier, is exactly how
//   high the terrain's shadow reaches above p — one texture fetch per texel instead of a ray march
//   (~100x cheaper). Per texel: D = H - ground (a receiver y m above the ground is lit when y > D:
//   one value covers any receiver height, a crown or a plane as well as the ground) and W, the
//   penumbra half-width (grows with the distance to the occluder that sets H).
// - Trees: an island-wide sun shadow map (ortho, fitted to the island in light space) of every tree
//   with an impostor, drawn as its impostor's sun-facing silhouette (Impostors.islandCasterMaterials:
//   the cascades' far casters without their LOD / distance culling). The receivers past the
//   cascades compare against it (4 hardware PCF taps); inside them the cascades have the real trees.
// - Re-baked as the light moves (every ~0.03°, ~0.2 s of a 40 min day), spread over 8 frames (an
//   eighth of every line's walk each; the tree map with the last, every other bake): the sweep keeps
//   the previous bake next to the new one in the same texel (RGBA16F: old D, W, new D, W) and the
//   materials blend them over the next bake's interval, so the terrain's shadows slide instead of
//   stepping.
// - Shader side (SunShadows.shadowFn): the terrain's share everywhere (min with the cascades), the
//   trees' past the cascades' fade (or everywhere with the cascades off).
//
// WebGPU only (compute + storage textures); with the WebGL 2 backend the shadows stop at the cascades.
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, float, int, ivec2, uvec2, vec2, vec3, vec4, max, min, mix, round, select, smoothstep, instanceIndex, instancedArray, textureStore, texture } from 'three/tsl';
import { U, T, tex, ndcToUv } from './tsl.js';
import { InstancedBatch } from './Instancing.js';

const SOFT = 0.006; // penumbra half-width per m of occluder distance (the sun's disc is ~0.0093 rad wide)
const REBAKE = 0.0005; // rad of light motion between bakes (~0.03°)
const TREE_EVERY = 2; // the tree map with every other bake (each draw is a full-map pass)
const TREE_TEXEL = 1.2; // m: the island tree shadow map's texels (at most), power-of-two sides
const TREE_MAP = [1024, 4096]; // texels a side of the island tree shadow map: min, max
const TREE_BIAS = 0.6; // m (light depth): the ground at a trunk's foot
const CHUNKS = 8; // frames a bake is spread over

export class FarShadows {
  constructor(renderer) {
    this.renderer = renderer;
    this.supported = !!renderer.backend?.isWebGPUBackend && !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('farshadow') === '0');
    this.enabled = this.supported;
    this._shown = new THREE.Vector3(0, 0, 0); // light direction of the newest bake
    const H = THREE.DataUtils.toHalfFloat;
    const dummy = new THREE.DataTexture(new Uint16Array([H(-100), H(0.2), H(-100), H(0.2)]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    dummy.needsUpdate = true;
    this.dummy = dummy;
    this.treeRT = this._treeTarget(4); // a stand-in until setWorld (bindings stay valid)
    this.uniforms = {
      farOn: U(0),
      farTrees: U(0), // the tree map is drawn
      farMix: U(1), // 0: previous bake .. 1: newest (both in the same texel)
      farRect: U(new THREE.Vector4(0, 0, 1, 1)), // world -> uv: x0, z0 of texel 0's corner, 1 / span, 1 / res
      farSea: U(0), // sea level: the receiving ground over the seabed
      farTex: T(tex(dummy), 'FarShadow'),
      farHeight: T(tex(dummy), 'FarHeight'), // ground height (R): receivers above the ground
      farMat: U(new THREE.Matrix4()), // world -> tree map clip
      farTexel: U(new THREE.Vector2(1 / 4, 0)), // x: 1 / res, y: depth bias
      farTreeMap: T(tex(this.treeRT.depthTexture), 'FarTreeMap'),
    };
    this.stats = { bakes: 0, ms: 0, trees: 0 };
  }

  _treeTarget(res) {
    const rt = new THREE.RenderTarget(res, res, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false });
    rt.depthTexture = new THREE.DepthTexture(res, res, THREE.UnsignedIntType);
    rt.depthTexture.format = THREE.DepthFormat;
    rt.depthTexture.compareFunction = THREE.LessEqualCompare;
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.LinearFilter;
    return rt;
  }

  /** The heightfield (TerrainData) and the instance fields whose impostor kinds cast tree shadows. */
  setWorld(terrain, fields = []) {
    if (!this.supported) return;
    this.terrain = terrain;
    const res = terrain.res, u = this.uniforms;
    if (this.res !== res) {
      this.res = res;
      for (const t of this.targets ?? []) t.dispose();
      // ping-pong: each bake reads the other one's new values as its "previous"
      this.targets = [0, 1].map(() => {
        const t = new THREE.StorageTexture(res, res);
        t.type = THREE.HalfFloatType;
        t.format = THREE.RGBAFormat;
        t.minFilter = t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        t.mipmapsAutoUpdate = false;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        return t;
      });
      this.heightTex?.dispose();
      this.heightTex = new THREE.DataTexture(new Uint16Array(res * res), res, res, THREE.RedFormat, THREE.HalfFloatType);
      this.heightTex.minFilter = this.heightTex.magFilter = THREE.LinearFilter;
      this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
      this.passes = [this._sweepPass(this.targets[0], this.targets[1]), this._sweepPass(this.targets[1], this.targets[0])];
      this._cur = 1;
    }
    const hd = this.heightTex.image.data, h = terrain.heights;
    let minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < h.length; k++) {
      hd[k] = THREE.DataUtils.toHalfFloat(h[k]);
      if (h[k] < minY) minY = h[k];
      if (h[k] > maxY) maxY = h[k];
    }
    this.heightTex.needsUpdate = true;
    this.heightRange = [Math.min(minY, terrain.seaLevel), maxY];
    // texel (i, j) = heightfield vertex (i, j): uv = (gx + 0.5) / res
    const span = terrain.cell * res;
    u.farRect.value.set(terrain.x0 - terrain.cell / 2, terrain.z0 - terrain.cell / 2, 1 / span, 1 / res);
    u.farSea.value = terrain.seaLevel;
    u.farHeight.value = this.heightTex;
    // the real textures before the loading warm-up compiles the materials: a material built later
    // with another kind of texture there (the dummy) generates other code (a late pipeline)
    u.farTex.value = this.targets[this._cur];
    this._setCasters(fields);
    this.invalidate();
  }

  /** The island tree map's casters: every instance of every impostor kind, per variant. */
  _setCasters(fields) {
    for (const b of this.casters ?? []) { b.removeFromParent(); b.disposeShared(); }
    this.casters = [];
    this.casterScene ??= new THREE.Scene();
    let top = this.heightRange[1], n = 0;
    const B = (this.treeBox = [Infinity, Infinity, -Infinity, -Infinity]); // x0, z0, x1, z1 of the trunks
    for (const f of fields) {
      if (f.dirty) f._bucket();
      for (const k of f.kinds) {
        if (!k.impostor?.islandCasterMaterials) continue;
        k.variants.forEach((v, vi) => {
          const count = v.matrices ? v.matrices.length / 16 : 0;
          if (!count) return;
          const b = new InstancedBatch(k.impostor.geometry, k.impostor.islandCasterMaterials[vi] ?? k.impostor.islandCasterMaterials[0], count);
          b.instanceMatrix.array.set(v.matrices);
          b.instanceMatrix.needsUpdate = true;
          for (let o = 12; o < v.matrices.length; o += 16) {
            const x = v.matrices[o], z = v.matrices[o + 2];
            if (x < B[0]) B[0] = x;
            if (z < B[1]) B[1] = z;
            if (x > B[2]) B[2] = x;
            if (z > B[3]) B[3] = z;
          }
          b.instances = count;
          b.matrixAutoUpdate = false;
          this.casterScene.add(b);
          this.casters.push(b);
          n += count;
        });
        top = Math.max(top, this.heightRange[1] + k.height * 1.5);
      }
    }
    this.treeTop = top;
    this.stats.trees = n;
    const side = Math.max(B[2] - B[0], B[3] - B[1]) + 24;
    const map = Math.min(TREE_MAP[1], Math.max(TREE_MAP[0], 2 ** Math.ceil(Math.log2(side / TREE_TEXEL))));
    if (n && this.treeRT.width !== map) {
      this.treeRT.dispose();
      this.treeRT = this._treeTarget(map);
      this.uniforms.farTreeMap.value = this.treeRT.depthTexture;
    }
    this.uniforms.farTexel.value.set(1 / this.treeRT.width, 0);
    this.treeCam ??= new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10);
  }

  /** The sweep (compute) writing `target` (previous bake: `prev`): one thread per line. */
  _sweepPass(target, prev) {
    const N = this.res;
    const u = (this.sweepU ??= {
      zMajor: U(0, 'int'), // lines walk along z (else x)
      fromEnd: U(0, 'int'), // the sun is on the high side of the major axis: start there
      q: U(0), // minor texels per major texel, away from the sun
      c0: U(0), // minor coordinate of line 0 at its start
      lines: U(0, 'int'),
      rise: U(0), // m the ray climbs per sample (tanE x the sample spacing)
      step: U(1), // m between samples
      sea: U(0),
      i0: U(0, 'int'), // samples [i0, i1) of every line in this dispatch (a bake runs in CHUNKS)
      i1: U(0, 'int'),
    });
    // per line, between dispatches: carried horizon, distance to its occluder, previous height
    this.lineState ??= instancedArray(2 * N + 4, 'vec4');
    const st = this.lineState;
    const hNode = texture(this.heightTex), prevNode = texture(prev);
    return Fn(() => {
      const l = int(instanceIndex);
      If(l.lessThan(u.lines), () => {
        const s0 = select(u.i0.equal(0), vec4(-1e4, 1e4, -1e4, 0.0), st.element(l)).toVar();
        const Hc = s0.x.toVar(); // horizon height carried along the line (absolute)
        const ts = s0.y.toVar(); // distance to the occluder that set it
        const hPrev = s0.z.toVar();
        Loop({ start: u.i0, end: u.i1, type: 'int', condition: '<' }, ({ i }) => {
          const a = select(u.fromEnd.equal(1), int(N - 1).sub(i), i).toVar();
          const m = float(l).add(u.c0).sub(u.q.mul(float(i))).toVar();
          const px = select(u.zMajor.equal(1), m, float(a)), pz = select(u.zMajor.equal(1), float(a), m);
          const g = hNode.sample(vec2(px.add(0.5), pz.add(0.5)).div(N)).level(0).x.toVar();
          // the previous sample (toward the sun) or the horizon it carried, whichever is higher here
          const cand = hPrev.sub(u.rise), carried = Hc.sub(u.rise);
          If(cand.greaterThanEqual(carried), () => { Hc.assign(cand); ts.assign(u.step); }).Else(() => { Hc.assign(carried); ts.addAssign(u.step); });
          hPrev.assign(g);
          const mi = int(round(m));
          If(mi.greaterThanEqual(0).and(mi.lessThan(N)), () => {
            const tx = select(u.zMajor.equal(1), mi, a), tz = select(u.zMajor.equal(1), a, mi);
            const old = prevNode.load(ivec2(tx, tz)).zw;
            const D = Hc.sub(max(g, u.sea));
            textureStore(target, uvec2(tx, tz), vec4(old, min(D, 1e4), ts.mul(SOFT).add(0.25))).toWriteOnly();
          });
        });
        st.element(l).assign(vec4(Hc, ts, hPrev, 0.0));
      });
    })().compute(2 * N + 4);
  }

  /** Re-bake from scratch (terrain / vegetation edits, a jump of the light). */
  invalidate() { this._fresh = 0; }

  setEnabled(on) {
    this.enabled = on && this.supported;
    if (!this.enabled) this.uniforms.farOn.value = 0;
  }

  /** Per frame: blend toward the newest bake; once the light moved ~0.03°, bake again over the next
   *  CHUNKS frames (an eighth of every line's walk each frame, the tree map with the last one, every
   *  other bake: no frame pays for a whole bake); all at once on a jump (loading, a time change,
   *  sun -> moon). */
  update(dir) {
    const u = this.uniforms;
    if (!this.enabled || !this.passes || dir.y < -0.05) { u.farOn.value = 0; this._job = null; return; }
    u.farMix.value = Math.min(1, u.farMix.value + 1 / 24);
    if (!this._job) {
      const moved = this._shown.angleTo(dir);
      if (this._fresh && moved < REBAKE) return;
      this._job = { dir: dir.clone(), k: 0, jump: !this._fresh || moved > 0.02 };
      this._setSweep(this._job.dir);
    }
    const job = this._job, t0 = performance.now();
    const n = job.jump ? CHUNKS : 1;
    for (let i = 0; i < n; i++) this._sweepChunk(job.k++);
    if (job.k < CHUNKS) return;
    if (job.jump || this.stats.bakes % TREE_EVERY === 0) this._renderTrees(job.dir);
    this._cur ^= 1;
    u.farTex.value = this.targets[this._cur];
    this._shown.copy(job.dir);
    u.farMix.value = job.jump ? 1 : 0;
    // the first bake has no previous one: bake again so both halves of the texel hold it
    if (!this._fresh) {
      for (let i = 0; i < CHUNKS; i++) this._sweepChunk(i);
      this._cur ^= 1;
      u.farTex.value = this.targets[this._cur];
    }
    this._job = null;
    this._fresh++;
    this.stats.bakes++;
    this.stats.ms = performance.now() - t0;
    u.farOn.value = 1;
  }

  /** Chunk k of the bake under way (an eighth of every line's walk, the lines run in parallel and
   *  each walk is sequential), into the texture not shown. */
  _sweepChunk(k) {
    const s = this.sweepU, per = Math.ceil(this.res / CHUNKS);
    s.i0.value = k * per;
    s.i1.value = Math.min(this.res, (k + 1) * per);
    this.renderer.compute(this.passes[this._cur ^ 1], this._lines);
  }

  _setSweep(dir) {
    const N = this.res, s = this.sweepU, t = this.terrain;
    const zMajor = Math.abs(dir.z) > Math.abs(dir.x);
    const major = zMajor ? dir.z : dir.x, minor = zMajor ? dir.x : dir.z;
    const q = minor / Math.abs(major);
    const c0 = Math.floor(Math.min(0, q * (N - 1))) - 1;
    s.zMajor.value = zMajor ? 1 : 0;
    s.fromEnd.value = major > 0 ? 1 : 0;
    s.q.value = q;
    s.c0.value = c0;
    s.lines.value = this._lines = N - c0 + Math.ceil(Math.max(0, q * (N - 1))) + 1;
    s.step.value = t.cell * Math.hypot(1, q);
    s.rise.value = s.step.value * (dir.y / Math.max(Math.hypot(dir.x, dir.z), 1e-4));
    s.sea.value = t.seaLevel;
  }

  /** The island tree map: ortho from the light, fitted to the trees' box in light space. */
  _renderTrees(dir) {
    const u = this.uniforms;
    if (!this.casters?.length) { u.farTrees.value = 0; return; }
    const cam = this.treeCam, B = this.treeBox, R = 12; // m: crowns past the trunks
    const [y0, y1] = [this.heightRange[0] - 2, this.treeTop + 2];
    const cx = (B[0] + B[2]) / 2, cz = (B[1] + B[3]) / 2, h = Math.max(B[2] - B[0], B[3] - B[1]) / 2 + R;
    cam.up.copy(Math.abs(dir.y) > 0.99 ? _Z : _Y);
    cam.position.set(cx, (y0 + y1) / 2, cz).addScaledVector(dir, 4 * h);
    cam.lookAt(cx, (y0 + y1) / 2, cz);
    cam.updateMatrixWorld(true);
    _box.makeEmpty();
    for (const x of [B[0] - R, B[2] + R]) for (const y of [y0, y1]) for (const z of [B[1] - R, B[3] + R]) _box.expandByPoint(_p.set(x, y, z).applyMatrix4(cam.matrixWorldInverse));
    // square texels (~1-1.4 m): at a low sun the island is a thin band in light space, which a
    // stretched fit would cover with 4x the fragments (crowns 4x taller in texels)
    const S = Math.max(_box.max.x - _box.min.x, _box.max.y - _box.min.y) / 2, lx = (_box.min.x + _box.max.x) / 2, ly = (_box.min.y + _box.max.y) / 2;
    cam.left = lx - S; cam.right = lx + S; cam.bottom = ly - S; cam.top = ly + S;
    cam.near = -_box.max.z - 1; cam.far = -_box.min.z + 1;
    cam.updateProjectionMatrix();
    const r = this.renderer, prevTarget = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(this.treeRT);
    r.render(this.casterScene, cam);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    u.farMat.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    u.farTexel.value.set(1 / this.treeRT.width, TREE_BIAS / (cam.far - cam.near));
    u.farTrees.value = 1;
  }

  /** fn(P world, k) -> vec2(terrain visibility, tree visibility) at P, for a receiver `kind`: 'ground'
   *  (the terrain: on the heightfield, whatever its LOD mesh's height), 'crown' / 'any' (its height
   *  above the ground counts). The tree map is only read where k > 0 (past the cascades). Lit (1, 1)
   *  off the map. */
  sampleFn(kind = 'any') {
    const fns = (this._fns ??= {});
    if (fns[kind]) return fns[kind];
    const u = this.uniforms;
    fns[kind] = Fn(([P, k]) => {
      const out = vec2(1.0).toVar();
      const uv = P.xz.sub(u.farRect.xy).mul(u.farRect.z).toVar();
      If(uv.x.greaterThan(0.0).and(uv.y.greaterThan(0.0)).and(uv.x.lessThan(1.0)).and(uv.y.lessThan(1.0)), () => {
        const f = u.farTex.sample(uv).toVar();
        const d = mix(f.xy, f.zw, u.farMix);
        const above = kind === 'ground' ? float(0.0) : max(P.y.sub(max(u.farHeight.sample(uv).x, u.farSea)), 0.0);
        // (faded out near the heightfield's border: no hard edge where a shadow crosses it)
        const edge = min(min(uv.x, uv.y), min(uv.x.oneMinus(), uv.y.oneMinus()));
        out.x.assign(mix(1.0, smoothstep(d.x.sub(d.y), d.x.add(d.y), above.add(0.3)), smoothstep(0.0, 0.04, edge)));
        If(u.farTrees.greaterThan(0.5).and(k.greaterThan(0.0)), () => {
          const c4 = u.farMat.mul(vec4(P, 1.0));
          const c = vec3(ndcToUv(c4), c4.z.sub(u.farTexel.y)).toVar();
          If(c.z.lessThan(1.0).and(c.z.greaterThan(0.0)), () => {
            const t = u.farTexel.x, m = u.farTreeMap;
            const tap = (dx, dy) => m.sample(c.xy.add(vec2(t.mul(dx), t.mul(dy)))).compare(c.z);
            out.y.assign(tap(-1, -0.5).add(tap(0.5, -1)).add(tap(1, 0.5)).add(tap(-0.5, 1)).mul(0.25));
          });
        });
      });
      return out;
    }).setLayout({ name: `farShadow_${kind}`, type: 'vec2', inputs: [{ name: 'P', type: 'vec3' }, { name: 'k', type: 'float' }] });
    return fns[kind];
  }

  dispose() {
    for (const t of this.targets ?? []) t.dispose();
    for (const b of this.casters ?? []) b.disposeShared();
    this.heightTex?.dispose();
    this.treeRT.dispose();
    this.dummy.dispose();
  }
}

const _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1), _p = new THREE.Vector3(), _box = new THREE.Box3();
