// Far-LOD impostors for instanced vegetation (render/InstancedField.js, species `impostor` in
// vegetation.json). Each variant of a tree is rendered once, while loading, from GRID x GRID
// directions over the upper hemisphere (hemi-octahedral layout: the border cells are the views
// from the horizon, the centre ones from above) into an albedo atlas and a normal atlas (one
// texture array layer per variant). A far instance is then one camera-facing quad (4 vertices
// instead of 300-540) showing the baked view closest to its view direction, lit like the meshes:
// sun, probe GI, fog, the per-instance leaf tint and the light through the leaves, from the
// baked normals. Distant trees are vertex-bound (sub-pixel triangles), which this removes.
// They also cast into the sun cascades: the same quad facing the sun, cut out by the baked view
// closest to the sun's direction (an orthographic silhouette, i.e. the tree's shadow), drawn by a
// shadow-only twin of the impostor mesh (casterMaterials, InstancedField). A receiving impostor
// looks its shadow up one radius toward the sun, in front of its own card.
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, texture, attribute, varying, varyingProperty, vec2, vec3, vec4, float, normalize, cross, abs, min, max, clamp, floor, length, inverse, mat3, dot, select, step, fwidth, Discard,
  positionGeometry, modelWorldMatrix, cameraViewMatrix, screenCoordinate,
} from 'three/tsl';
import { WorldStandardMaterial, lodRangeUniform } from './WorldMaterial.js';
import { surfSpecK, fieldInstance, bayer4, leafTint } from './nodes.js';

export const GRID = 8;

const QUAD = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
})();

// direction (y >= 0) <-> hemi-octahedral square [-1, 1]^2, same formulas in the shader
const decode = (ex, ey) => {
  const tx = (ex + ey) / 2, tz = (ex - ey) / 2;
  return new THREE.Vector3(tx, Math.max(0, 1 - Math.abs(tx) - Math.abs(tz)), tz).normalize();
};

const FLAT = THREE.InterpolationSamplingType.FLAT;

/**
 * The quad of a tree instance in its local space, facing direction `dirFn(impM)` (local), with
 * the bake camera's basis (three.js lookAt with +Y up), and the closest baked view. Returns
 * { p (local position), cell, uv } nodes; FieldMesh instancing and the LOD range are applied by
 * the caller.
 */
function quad(sphere, impV0) {
  const v0 = vec3(impV0).toVar();
  v0.y.assign(max(v0.y, 0));
  const impV = normalize(v0.add(vec3(0, 1e-4, 0))).toVar();
  const a = impV.div(abs(impV.x).add(abs(impV.y)).add(abs(impV.z)));
  const cell = clamp(floor(vec2(a.x.add(a.z), a.x.sub(a.z)).mul(0.5).add(0.5).mul(GRID)), 0, GRID - 1);
  const up = select(impV.y.greaterThan(0.999), vec3(0, 0, -1), vec3(0, 1, 0));
  const X = normalize(cross(up, impV)), Y = cross(impV, X);
  const p = sphere.xyz.add(X.mul(positionGeometry.x).add(Y.mul(positionGeometry.y)).mul(sphere.w));
  return { p, cell, uv: positionGeometry.xy.mul(0.5).add(0.5) };
}

/** Instance-space position -> local position, instance applied, LOD range culled (as worldPosition). */
function placed(builder, inst, p, L) {
  if (!inst) return p;
  const out = inst.mul(vec4(p, 1)).xyz.toVar();
  const r = lodRangeUniform(), U = L.uniforms;
  const d = length(modelWorldMatrix.mul(vec4(inst.element(3).xyz, 1)).xz.sub(U.camPosW.xz));
  const cull = builder.material.mcDepth
    ? d.lessThan(r.x.add(r.y).mul(0.5)).or(d.greaterThanEqual(r.z.add(r.w).mul(0.5)))
    : d.lessThan(r.x).or(d.greaterThanEqual(r.w));
  return select(cull, vec3(0), out);
}

/** Impostors of the variants of one asset (one texture array layer per variant). */
export class Impostors {
  /** builds: one AssetLibrary build per variant (geometry in asset space). cell: px per view. */
  constructor(lighting, builds, { cell = 64 } = {}) {
    this.lighting = lighting;
    this.builds = builds;
    this.cell = cell;
    this.baked = false;
    const size = GRID * cell, n = builds.length;
    this.layers = n;
    const rt = (srgb) => new THREE.RenderTarget(size, size, {
      depth: n, depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace, anisotropy: 1,
    });
    this.albedo = rt(true);
    this.normal = rt(false);
    this.albedoTex = texture(this.albedo.texture);
    this.normalTex = texture(this.normal.texture);
    this.geometry = QUAD;
    this.materials = builds.map((b, v) => this._material(b, v));
    this.casterMaterials = builds.map((b, v) => this._casterMaterial(b, v));
  }

  get triangles() { return 2; }

  /** Atlas texel of a layer (layered only with several variants). */
  _sample(tex, uv, layer) { return this.layers > 1 ? tex.sample(uv).depth(layer) : tex.sample(uv); }

  _material(build, layer) {
    const L = this.lighting, S = L.sun.uniforms, U = L.uniforms;
    const s = build.geometry.boundingSphere;
    const sphere = uniform(new THREE.Vector4(s.center.x, s.center.y, s.center.z, s.radius * 1.04));
    // uniforms, not constants: one shader (pipeline) for every variant and species
    const inset = uniform(0.5 / this.cell), layerU = uniform(layer, 'int');
    const m = new WorldStandardMaterial(L, { ao: true, sky: true, env: null }, { roughness: 0.9, metalness: 0 });
    m.alphaToCoverage = true;
    m.vertexColors = false;
    m.name = 'impostor';
    // per instance (the same for the 4 vertices): baked view, radius, rotation, leaf tint
    const vCell = varyingProperty('vec2', 'vImpCell'), vR = varyingProperty('float', 'vImpR'), vTint = varyingProperty('vec3', 'vImpTint');
    const rot = [0, 1, 2].map((i) => varyingProperty('vec3', 'vImpRot' + i));
    // vertex: the quad facing the camera
    m.positionNode = Fn((builder) => {
      const inst = fieldInstance(builder);
      const impM = (inst ? modelWorldMatrix.mul(inst) : modelWorldMatrix).toVar();
      const q = quad(sphere, inverse(impM).mul(vec4(U.camPosW, 1)).xyz.sub(sphere.xyz));
      vCell.assign(q.cell);
      vR.assign(sphere.w.mul(length(impM.element(0).xyz)));
      rot.forEach((r, i) => r.assign(normalize(impM.element(i).xyz)));
      // per-instance leaf tint (same hash as the foliage meshes, WorldMaterial.js)
      vTint.assign(inst ? leafTint(inst.element(3).xz) : vec3(1));
      return placed(builder, inst, q.p, L);
    })();
    // rows of a baked view run down the texture (its top first): v flips within the cell
    const vUv = varying(vec2(positionGeometry.x.mul(0.5).add(0.5), positionGeometry.y.mul(-0.5).add(0.5)), 'vImpUv');
    const atlasUv = () => vCell.add(clamp(vUv, vec2(inset), vec2(inset.oneMinus()))).div(GRID);
    m.mcReceiverShift = vR; // its shadow is looked up in front of its own caster card
    // fragment: albedo + cut-out from the atlas (alpha sharpened around the cut like the leaf
    // cards: crisp at every mip, smooth with alpha to coverage), leaf tint and transmission
    m.colorNode = Fn((builder) => {
      lodDither(L);
      const uv = atlasUv();
      const ta = this._sample(this.albedoTex, uv, layerU).toVar();
      const tn = this._sample(this.normalTex, uv, layerU).toVar('impTN');
      // cut a bit below 0.5: the averaged alpha of the coarse mips would erode the crowns
      const a = ta.a.sub(0.4).div(max(fwidth(ta.a), 1e-4)).add(0.5).toVar();
      const alpha = float(1).toVar();
      if (builder.renderer.currentSamples > 1) {
        If(a.lessThanEqual(0), () => { Discard(); });
        alpha.assign(clamp(a, 0, 1));
      } else {
        If(a.lessThan(0.5), () => { Discard(); });
      }
      const isLeaf = tn.a.greaterThan(0.5);
      const nW = normalize(mat3(rot[0], rot[1], rot[2]).mul(tn.xyz.mul(2).sub(1))).toVar('impNW');
      const c = ta.rgb.toVar();
      If(isLeaf, () => {
        const back = clamp(float(0.25).sub(dot(nW, S.sunDirW)), 0, 1).mul(step(0, S.sunDirW.y));
        c.mulAssign(vTint.mul(vec3(1.9, 2.0, 1.2).mul(U.foliageTransmission.mul(back)).add(1)));
      });
      surfSpecK.assign(select(isLeaf, float(0.15), float(0.5)));
      return vec4(c, alpha);
    })();
    // the baked normal (thin leaves also get light from above)
    m.normalNode = Fn(() => {
      const tn = this._sample(this.normalTex, atlasUv(), layerU);
      const nW = normalize(mat3(rot[0], rot[1], rot[2]).mul(tn.xyz.mul(2).sub(1)));
      const n = normalize(cameraViewMatrix.mul(vec4(nW, 0)).xyz).toVar();
      If(tn.a.greaterThan(0.5), () => { n.assign(normalize(n.add(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz.mul(0.9)))); });
      return n;
    })();
    return m;
  }

  /** Shadow-only material: the quad facing the sun, cut out by the closest baked view. Keeps its own
   *  material in the depth passes (allowOverride), culls the instances outside its LOD there like
   *  the depth override does. */
  _casterMaterial(build, layer) {
    const L = this.lighting, S = L.sun.uniforms, s = build.geometry.boundingSphere;
    const sphere = uniform(new THREE.Vector4(s.center.x, s.center.y, s.center.z, s.radius * 1.04));
    const inset = uniform(0.5 / this.cell), layerU = uniform(layer, 'int');
    const m = new THREE.MeshBasicNodeMaterial({ colorWrite: false, side: THREE.DoubleSide, fog: false });
    m.allowOverride = false;
    m.mcDepth = true;
    m.name = 'impostorCaster';
    const vCell = varyingProperty('vec2', 'vImpCell');
    m.positionNode = Fn((builder) => {
      const inst = fieldInstance(builder);
      const impM = inst ? modelWorldMatrix.mul(inst) : modelWorldMatrix;
      const q = quad(sphere, inverse(mat3(impM)).mul(S.sunDirW));
      vCell.assign(q.cell);
      const p = placed(builder, inst, q.p, L);
      if (!inst) return p;
      // past the shadow distance (+ a crown) nothing receives its shadow
      const d = length(modelWorldMatrix.mul(vec4(inst.element(3).xyz, 1)).xz.sub(L.uniforms.camPosW.xz));
      return select(d.greaterThan(S.sunFade.y.add(sphere.w.mul(2).mul(length(inst.element(0).xyz)))), vec3(0), p);
    })();
    // rows of a baked view run down the texture (its top first): v flips within the cell
    const vUv = varying(vec2(positionGeometry.x.mul(0.5).add(0.5), positionGeometry.y.mul(-0.5).add(0.5)), 'vImpUv');
    m.colorNode = Fn(() => {
      const uv = vCell.add(clamp(vUv, vec2(inset), vec2(inset.oneMinus()))).div(GRID);
      If(this._sample(this.albedoTex, uv, layerU).a.lessThan(0.4), () => { Discard(); });
      return vec4(0, 0, 0, 1);
    })();
    return m;
  }

  /** Render the atlases (needs the surface textures loaded). Restores the renderer state. */
  bake(renderer) {
    const L = this.lighting, S = L.surfaces;
    const t0 = performance.now();
    const albedoMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    albedoMat.colorNode = Fn((builder) => {
      const c = builder.geometry.hasAttribute('color') ? vec3(attribute('color', 'vec3')) : vec3(1);
      return vec4(c.mul(S.surfaceColor({ a2c: false })), 1);
    })();
    albedoMat.name = 'impostorBakeAlbedo';
    const normalMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    const nAttr = attribute('normal', 'vec3');
    const vN = varying(nAttr, 'vBakeN');
    const vLeaf = varying(select(dot(nAttr, nAttr).greaterThan(2), float(1), float(0)), 'vBakeLeaf').setInterpolation(FLAT); // crown normals have length 2 (ModelBuilder)
    normalMat.colorNode = Fn((builder) => {
      S.depthCut(builder);
      return vec4(normalize(vN).mul(0.5).add(0.5), vLeaf);
    })();
    normalMat.blending = THREE.NoBlending; // keeps the leaf flag in alpha (opaque materials write 1)
    normalMat.name = 'impostorBakeNormal';
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(undefined, albedoMat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    const prevTarget = renderer.getRenderTarget(), prevLayer = renderer.getActiveCubeFace(), prevMip = renderer.getActiveMipmapLevel();
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    const c = this.cell, size = GRID * c, center = new THREE.Vector3();
    // allocated with their mip chain, then rendered without regenerating it after every view
    for (const t of [this.albedo, this.normal]) { renderer.initRenderTarget(t); t.texture.generateMipmaps = false; }
    this.builds.forEach((b, layer) => {
      const s = b.geometry.boundingSphere, R = s.radius * 1.04;
      center.copy(s.center);
      mesh.geometry = b.geometry;
      cam.left = cam.bottom = -R; cam.right = cam.top = R;
      cam.near = 0.01; cam.far = 4 * R;
      cam.updateProjectionMatrix();
      // albedo: transparent black around the crowns, as the WebGL version's clear left it (three
      // premultiplied its clear colour by alpha 0): the coarse mips darken the crown rims a little
      for (const [t, mat, clear] of [[this.albedo, albedoMat, [0, 0, 0, 0]], [this.normal, normalMat, [0.5, 1, 0.5, 1]]]) {
        mesh.material = mat;
        t.viewport.set(0, 0, size, size);
        t.scissorTest = false;
        renderer.setRenderTarget(t, layer);
        renderer.setClearColor(new THREE.Color().setRGB(clear[0], clear[1], clear[2], THREE.LinearSRGBColorSpace), clear[3]);
        renderer.clear(true, true, false);
        for (let j = 0; j < GRID; j++) {
          for (let i = 0; i < GRID; i++) {
            const d = decode(((i + 0.5) / GRID) * 2 - 1, ((j + 0.5) / GRID) * 2 - 1);
            cam.up.set(0, 1, 0);
            if (d.y > 0.999) cam.up.set(0, 0, -1);
            cam.position.copy(center).addScaledVector(d, 2 * R);
            cam.lookAt(center);
            cam.updateMatrixWorld();
            // cell (i, j) of the atlas, rows counted from the top of the texture (uv convention)
            t.viewport.set(i * c, j * c, c, c);
            renderer.setRenderTarget(t, layer);
            renderer.render(scene, cam);
          }
        }
        t.viewport.set(0, 0, size, size);
      }
    });
    // mipmaps of every layer at once: one empty pass with mipmapping on
    const empty = new THREE.Scene();
    for (const t of [this.albedo, this.normal]) {
      t.texture.generateMipmaps = true;
      renderer.setRenderTarget(t, 0);
      renderer.render(empty, cam);
    }
    renderer.setRenderTarget(prevTarget, prevLayer, prevMip);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    albedoMat.dispose();
    normalMat.dispose();
    this.baked = true;
    this.bakeMs = performance.now() - t0;
  }

  dispose() {
    this.albedo.dispose();
    this.normal.dispose();
    for (const m of [...this.materials, ...this.casterMaterials]) m.dispose();
  }
}

/** The impostor LOD's own cross-fade with the mesh LOD before it (as WorldMaterial lodDither). */
function lodDither(L) {
  const fade = varying(Fn((b) => {
    const inst = fieldInstance(b);
    if (!inst) return float(1);
    const r = lodRangeUniform(), U = L.uniforms;
    const d = length(modelWorldMatrix.mul(vec4(inst.element(3).xyz, 1)).xz.sub(U.camPosW.xz));
    const fin = select(r.y.greaterThan(r.x), d.sub(r.x).div(r.y.sub(r.x)), float(1));
    const fout = select(r.w.greaterThan(r.z), r.w.sub(d).div(r.w.sub(r.z)), float(1));
    return select(fin.lessThan(1), fin.negate(), min(fout, 1));
  })(), 'vLodFade').setInterpolation(FLAT);
  If(fade.lessThan(1), () => {
    const t = bayer4(screenCoordinate);
    If(select(fade.lessThan(0), t.oneMinus(), t).greaterThanEqual(abs(fade)), () => { Discard(); });
  });
}
