// Far-LOD impostors for instanced vegetation (render/InstancedField.js, species `impostor` in
// vegetation.json). Each variant of a tree is rendered once, while loading, from GRID x GRID
// directions over the upper hemisphere (hemi-octahedral layout: the border cells are the views
// from the horizon, the centre ones from above) into an albedo atlas and a normal atlas (one
// texture array layer per variant). A far instance is then one camera-facing quad (4 vertices
// instead of 300-540, covering only that view's silhouette rectangle) showing the baked view closest
// to its view direction, lit like the meshes:
// sun, probe GI, fog, the per-instance leaf tint and the light through the leaves, from the
// baked normals. Distant trees are vertex-bound (sub-pixel triangles), which this removes.
// They also cast into the sun cascades: the same quad facing the sun, cut out by the baked view
// closest to the sun's direction (an orthographic silhouette, i.e. the tree's shadow), drawn by a
// shadow-only twin of the impostor mesh (casterMaterials, InstancedField). A receiving impostor
// looks its shadow up one radius toward the sun, in front of its own card.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Discard, float, int, ivec2, vec2, vec3, vec4, mat3, max, mix, clamp, normalize, cross, dot, length, select, floor, abs, fwidth, step,
  attribute, varying, positionGeometry, normalGeometry, modelWorldMatrix, cameraViewMatrix, inverse,
} from 'three/tsl';
import { U, instanceMatrix, instanceTint, tex } from './tsl.js';
import { lodVisible, lodDist } from './LodFade.js';
import { ST } from './Lighting.js';

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

/** The bake camera's basis for a view direction (three.js lookAt: +Y up, -Z straight above). */
const basis = (d) => {
  const up = d.y > 0.999 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const X = new THREE.Vector3().crossVectors(up, d).normalize();
  return [X, new THREE.Vector3().crossVectors(d, X)];
};

/** The quad, in the tree's local space, facing direction `dir` (local) with the bake camera's basis,
 *  and the closest baked view; the quad covers that view's silhouette rectangle (rects: a texel per
 *  view and variant, in units of the sphere's radius), not the whole bounding sphere: the
 *  fragments outside the tree are never rasterized. -> { p: local position, cell, uv } */
function facing(sphere, d, rects, layer) {
  const v = normalize(vec3(d.x, max(d.y, 0.0).add(1e-4), d.z));
  const a = v.div(abs(v.x).add(abs(v.y)).add(abs(v.z)));
  const cell = clamp(floor(vec2(a.x.add(a.z), a.x.sub(a.z)).mul(0.5).add(0.5).mul(GRID)), 0.0, GRID - 1);
  const up = select(v.y.greaterThan(0.999), vec3(0.0, 0.0, -1.0), vec3(0.0, 1.0, 0.0));
  const X = normalize(cross(up, v)), Y = cross(v, X);
  const r = rects.load(ivec2(int(cell.x).add(int(cell.y).mul(GRID)), int(layer)));
  const q = mix(r.xy, r.zw, positionGeometry.xy.mul(0.5).add(0.5));
  const p = sphere.xyz.add(X.mul(q.x).add(Y.mul(q.y)).mul(sphere.w));
  return { p, cell, uv: vec2(q.x.mul(0.5).add(0.5), q.y.mul(-0.5).add(0.5)) }; // texture rows run down
}

/** Impostors of the variants of one asset (one texture array layer per variant). */
export class Impostors {
  /** builds: one AssetLibrary build per variant (geometry in asset space). cell: px per view. */
  constructor(lighting, builds, { cell = 64 } = {}) {
    this.lighting = lighting;
    this.builds = builds;
    this.cell = cell;
    this.baked = false;
    const size = GRID * cell, n = Math.max(2, builds.length); // >= 2 layers: an array texture
    const rt = (srgb) => {
      const t = new THREE.RenderTarget(size, size, { depth: n, depthBuffer: true, generateMipmaps: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
      t.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.texture.anisotropy = 1;
      // a full mip chain, generated once after the bake (three sizes the GPU texture from
      // mipmaps.length; with generateMipmaps: false and no mipmaps it would get one level, and
      // generateMipmaps: true would rebuild them after each of the 64 view renders). Without mips
      // far trees sample the full-size atlas: ~20 % noisier than the meshes, shimmering in motion
      t.texture.mipmaps = Array.from({ length: Math.log2(size) + 1 }, () => ({}));
      return t;
    };
    this.albedo = rt(true);
    this.normal = rt(false);
    this.geometry = QUAD;
    this.albedoTex = tex(this.albedo.texture);
    this.normalTex = tex(this.normal.texture);
    this.rects = this._rects();
    this.materials = builds.map((b, v) => this._material(b, v));
    this.casterMaterials = builds.map((b, v) => this._casterMaterial(b, v));
    this.islandCasterMaterials = builds.map((b, v) => this._casterMaterial(b, v, { island: true }));
  }

  get triangles() { return 2; }

  /** Per variant and baked view: the rectangle its geometry covers in that view (x0, y0, x1, y1 in
   *  units of the bounding radius, a texel of margin), one texel each (GRID² x variants). */
  _rects() {
    const n = GRID * GRID, data = new Float32Array(n * Math.max(2, this.builds.length) * 4).fill(0);
    const P = new THREE.Vector3(), margin = 2 / this.cell;
    this.builds.forEach((b, layer) => {
      const s = b.geometry.boundingSphere, R = s.radius * 1.04, pos = b.geometry.attributes.position;
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const [X, Y] = basis(decode(((i + 0.5) / GRID) * 2 - 1, ((j + 0.5) / GRID) * 2 - 1));
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let k = 0; k < pos.count; k++) {
            P.fromBufferAttribute(pos, k).sub(s.center);
            const x = P.dot(X) / R, y = P.dot(Y) / R;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
          data.set([Math.max(-1, x0 - margin), Math.max(-1, y0 - margin), Math.min(1, x1 + margin), Math.min(1, y1 + margin)], ((layer * n) + j * GRID + i) * 4);
        }
      }
    });
    const t = new THREE.DataTexture(data, n, Math.max(2, this.builds.length), THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    this.rectTex = t;
    return tex(t);
  }

  _sphere(build) {
    const s = build.geometry.boundingSphere;
    return U(new THREE.Vector4(s.center.x, s.center.y, s.center.z, s.radius * 1.04));
  }

  _material(build, layer) {
    const L = this.lighting, LU = L.uniforms, sunU = L.sun.uniforms;
    const sphere = this._sphere(build), inset = 0.5 / this.cell;
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    m.alphaToCoverage = true;
    m.vertexColors = false;
    const impM = () => modelWorldMatrix.mul(instanceMatrix());
    // facing the camera, in the tree's local space
    const view = () => facing(sphere, inverse(impM()).mul(vec4(LU.camPosW, 1.0)).xyz.sub(sphere.xyz), this.rects, layer);
    m.positionNode = Fn(() => {
      const M = instanceMatrix().toVar();
      const q = M.mul(vec4(view().p, 1.0)).xyz;
      return select(lodVisible(LU.camPosW), q, vec3(0.0));
    })();
    const vCell = varying(view().cell, 'vImpCell').setInterpolation('flat');
    const vUv = varying(view().uv, 'vImpUv');
    const vTint = varying(instanceTint(attribute('iM3', 'vec4').xyz), 'vImpTint').setInterpolation('flat');
    const vR = varying(sphere.w.mul(length(impM()[0].xyz)), 'vImpR').setInterpolation('flat');
    const rot = () => impM();
    const vRx = varying(normalize(rot()[0].xyz), 'vImpRx').setInterpolation('flat');
    const vRy = varying(normalize(rot()[1].xyz), 'vImpRy').setInterpolation('flat');
    const vRz = varying(normalize(rot()[2].xyz), 'vImpRz').setInterpolation('flat');
    m.colorNode = Fn(() => {
      const tuv = vCell.add(clamp(vUv, vec2(inset), vec2(1.0 - inset))).div(GRID).toVar();
      const ta = this.albedoTex.sample(tuv).depth(layer).toVar();
      const tn = this.normalTex.sample(tuv).depth(layer).toVar();
      // cut a bit below 0.5: the averaged alpha of the coarse mips would erode the crowns
      const a = ta.a.sub(0.4).div(max(fwidth(ta.a), 1e-4)).add(0.5).toVar();
      If(a.lessThanEqual(0.0), () => { Discard(); });
      const leaf = tn.a.greaterThan(0.5).toVar();
      const nW = normalize(mat3(vRx, vRy, vRz).mul(tn.xyz.mul(2.0).sub(1.0))).toVar();
      const c = ta.rgb.toVar();
      If(leaf, () => {
        const back = clamp(float(0.25).sub(dot(nW, sunU.sunDirW)), 0.0, 1.0).mul(step(0.0, sunU.sunDirW.y));
        c.mulAssign(vTint.mul(vec3(1.9, 2.0, 1.2).mul(LU.foliageTransmission.mul(back)).add(1.0)));
      });
      ST.specK.assign(select(leaf, float(0.15), float(0.5)));
      ST.leaf.assign(select(leaf, float(1.0), float(0.0)));
      // the baked normal (thin leaves also get light from above)
      const n = normalize(cameraViewMatrix.mul(vec4(nW, 0.0)).xyz).toVar();
      If(leaf, () => { n.assign(normalize(n.add(cameraViewMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz.mul(0.9)))); });
      ST.normal.assign(n);
      return vec4(c, clamp(a, 0.0, 1.0));
    })();
    m.normalNode = ST.normal;
    m.mcSpecK = ST.specK;
    m.mcLeaf = ST.leaf; // no sun specular on leaves, like the near LODs
    m.mcSunShift = vR; // receivers look their shadow up in front of their own card
    m.mcFarKind = 'crown'; // far shadows: the light reaching the top of the crowns (FarShadows.js)
    m.mcCustomVertex = true; // its own position node (LodFade.lodMaterial keeps it)
    // sun, cascades, SSAO, probe GI, sky reflections
    L.light(m);
    return m;
  }

  /** Shadow-only material: the quad facing the sun, cut out by the closest baked view. Keeps its own
   *  material in the depth passes (allowOverride: false), culls the instances outside its LOD there
   *  like the depth override does (lodPassMode = 1 during the cascades). island: every instance
   *  (the island-wide tree shadow map of FarShadows.js: no LOD, no distance). */
  _casterMaterial(build, layer, { island = false } = {}) {
    const L = this.lighting, LU = L.uniforms, sunU = L.sun.uniforms;
    const sphere = this._sphere(build), inset = 0.5 / this.cell;
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, colorWrite: false, fog: false });
    m.lights = false;
    m.allowOverride = false;
    const impM = () => modelWorldMatrix.mul(instanceMatrix());
    const view = () => facing(sphere, inverse(mat3(impM())).mul(sunU.sunDirW), this.rects, layer);
    m.positionNode = Fn(() => {
      const M = instanceMatrix().toVar();
      const q = M.mul(vec4(view().p, 1.0)).xyz;
      if (island) return q;
      // past the shadow distance (+ a crown) nothing receives its shadow
      const near = lodDist(LU.camPosW).lessThanEqual(sunU.sunFade.y.add(sphere.w.mul(2.0).mul(length(M[0].xyz))));
      return select(lodVisible(LU.camPosW).and(near), q, vec3(0.0));
    })();
    const vCell = varying(view().cell, 'vImpCell').setInterpolation('flat');
    const vUv = varying(view().uv, 'vImpUv');
    m.maskNode = Fn(() => {
      const tuv = vCell.add(clamp(vUv, vec2(inset), vec2(1.0 - inset))).div(GRID);
      return this.albedoTex.sample(tuv).depth(layer).a.greaterThanEqual(0.4);
    })();
    return m;
  }

  /** Render the atlases (needs the surface textures loaded). Restores the renderer state. */
  bake(renderer) {
    const L = this.lighting, S = L.surfaces;
    const t0 = performance.now();
    // albedo: the asset's textured colour (vertex colours x surface detail), unlit
    const albedoMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    albedoMat.toneMapped = false;
    albedoMat.colorNode = Fn((builder) => {
      ST.color.assign(builder.geometry?.attributes?.color ? varying(attribute('color', 'vec3'), 'vColor') : vec3(1.0));
      ST.alpha.assign(1.0);
      ST.rough.assign(1.0); ST.metal.assign(0.0); ST.leaf.assign(0.0); ST.specK.assign(1.0);
      ST.normal.assign(vec3(0.0, 0.0, 1.0));
      if (builder.geometry?.attributes?.surface) S.sample(ST, {});
      return vec4(ST.color, 1.0);
    })();
    // normal: the baked normals (crown normals have length 2 on leaves, ModelBuilder), A = leaf
    const normalMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    normalMat.toneMapped = false;
    normalMat.maskNode = S.leafMaskNode();
    const vN = varying(normalGeometry, 'vBakeN');
    normalMat.colorNode = vec4(normalize(vN).mul(0.5).add(0.5), select(dot(vN, vN).greaterThan(2.0), float(1.0), float(0.0)));
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(undefined, albedoMat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    const prevTarget = renderer.getRenderTarget(), prevLayer = renderer.getActiveCubeFace(), prevMip = renderer.getActiveMipmapLevel();
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
    const prevScissor = renderer.getScissorTest();
    renderer.autoClear = false;
    const c = this.cell, size = GRID * c, center = new THREE.Vector3();
    this.builds.forEach((b, layer) => {
      const s = b.geometry.boundingSphere, R = s.radius * 1.04;
      center.copy(s.center);
      mesh.geometry = b.geometry;
      cam.left = cam.bottom = -R; cam.right = cam.top = R;
      cam.near = 0.01; cam.far = 4 * R;
      cam.updateProjectionMatrix();
      for (const [t, mat, clear] of [[this.albedo, albedoMat, [0.06, 0.09, 0.035, 0]], [this.normal, normalMat, [0.5, 1, 0.5, 1]]]) {
        mesh.material = mat;
        t.viewport.set(0, 0, size, size);
        t.scissor.set(0, 0, size, size);
        renderer.setScissorTest(false);
        renderer.setRenderTarget(t, layer);
        renderer.setClearColor(new THREE.Color().setRGB(clear[0], clear[1], clear[2], THREE.LinearSRGBColorSpace), clear[3]);
        renderer.clear(true, true, false);
        renderer.setScissorTest(true);
        for (let j = 0; j < GRID; j++) {
          for (let i = 0; i < GRID; i++) {
            const d = decode(((i + 0.5) / GRID) * 2 - 1, ((j + 0.5) / GRID) * 2 - 1);
            cam.up.set(0, 1, 0);
            if (d.y > 0.999) cam.up.set(0, 0, -1);
            cam.position.copy(center).addScaledVector(d, 2 * R);
            cam.lookAt(center);
            cam.updateMatrixWorld();
            // cell (i, j) of the atlas, rows counted from the top of the texture (uv v down)
            t.viewport.set(i * c, j * c, c, c);
            t.scissor.set(i * c, j * c, c, c);
            renderer.setRenderTarget(t, layer);
            renderer.render(scene, cam);
          }
        }
        renderer.setScissorTest(false);
        t.viewport.set(0, 0, size, size);
        t.scissor.set(0, 0, size, size);
      }
    });
    // mipmaps of every layer at once
    for (const t of [this.albedo, this.normal]) renderer.backend.textureUtils?.generateMipmaps?.(t.texture);
    renderer.setRenderTarget(prevTarget, prevLayer, prevMip);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setScissorTest(prevScissor);
    renderer.autoClear = prevAuto;
    albedoMat.dispose();
    normalMat.dispose();
    this.baked = true;
    this.bakeMs = performance.now() - t0;
  }

  dispose() {
    this.albedo.dispose();
    this.normal.dispose();
    this.rectTex.dispose();
    for (const m of [...this.materials, ...this.casterMaterials]) m.dispose();
  }
}

