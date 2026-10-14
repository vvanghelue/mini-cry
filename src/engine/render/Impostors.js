// Far-LOD impostors for instanced vegetation (render/InstancedField.js, species `impostor` in
// vegetation.json). Each variant of a tree is rendered once, while loading, from GRID x GRID
// directions over the upper hemisphere (hemi-octahedral layout: the border cells are the views
// from the horizon, the centre ones from above) into an albedo atlas and a normal atlas (one
// texture array layer per variant). A far instance is then one camera-facing quad (4 vertices
// instead of 300-540) showing the baked view closest to its view direction, lit like the meshes:
// sun, probe GI, fog, the per-instance leaf tint and the light through the leaves, from the
// baked normals. Distant trees are vertex-bound (sub-pixel triangles), which this removes.
import * as THREE from 'three';
import { FOLIAGE_BASE } from '../assets/surfaces.js';

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

const VERT_PARS = /* glsl */ `
uniform vec4 impSphere; // local bounding sphere: centre, radius
uniform vec3 camPosW;
varying vec2 vImpUv;
flat varying vec2 vImpCell;
flat varying vec3 vImpTint;
flat varying mat3 vImpRot;
`;

// replaces begin_vertex: the quad, in the tree's local space, facing the camera with the bake
// camera's basis (three.js lookAt with +Y up), and the closest baked view
const VERT_QUAD = /* glsl */ `
#ifdef USE_INSTANCING
  mat4 impM = modelMatrix * instanceMatrix;
#else
  mat4 impM = modelMatrix;
#endif
vec3 impV = (inverse(impM) * vec4(camPosW, 1.0)).xyz - impSphere.xyz;
impV.y = max(impV.y, 0.0);
impV = normalize(impV + vec3(0.0, 1e-4, 0.0));
vec3 impA = impV / (abs(impV.x) + abs(impV.y) + abs(impV.z));
vImpCell = clamp(floor((vec2(impA.x + impA.z, impA.x - impA.z) * 0.5 + 0.5) * ${GRID.toFixed(1)}), 0.0, ${(GRID - 1).toFixed(1)});
vec3 impUp = impV.y > 0.999 ? vec3(0.0, 0.0, -1.0) : vec3(0.0, 1.0, 0.0);
vec3 impX = normalize(cross(impUp, impV)), impY = cross(impV, impX);
vec3 transformed = impSphere.xyz + (impX * position.x + impY * position.y) * impSphere.w;
vImpUv = position.xy * 0.5 + 0.5;
vImpRot = mat3(normalize(impM[0].xyz), normalize(impM[1].xyz), normalize(impM[2].xyz));
// per-instance leaf tint (same hash as the foliage meshes, Lighting.patch)
vImpTint = vec3(1.0);
#ifdef USE_INSTANCING
{
  uvec2 hq = uvec2(ivec2(floor(instanceMatrix[3].xz * 4.0)) + 1048576);
  uint hh = hq.x * 1597334677u ^ hq.y * 3812015801u;
  hh = hh * 747796405u + 2891336453u; hh ^= hh >> 16u; hh *= 2246822519u; hh ^= hh >> 13u;
  float h1 = float(hh & 1023u) / 1023.0, h2 = float((hh >> 10u) & 1023u) / 1023.0;
  vImpTint = (0.86 + 0.28 * h1) * mix(vec3(1.07, 1.03, 0.8), vec3(0.9, 1.0, 1.1), h2);
}
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform highp sampler2DArray impAlbedo;
uniform highp sampler2DArray impNormal;
uniform float impLayer, impInset, foliageTransmission; // sunDirW: declared by the sun (SunShadows.js)
varying vec2 vImpUv;
flat varying vec2 vImpCell;
flat varying vec3 vImpTint;
flat varying mat3 vImpRot;
bool impLeaf;
vec3 impNW;
`;

// replaces map_fragment: albedo + cut-out from the atlas (alpha sharpened around the cut like the
// leaf cards: crisp at every mip, smooth with alpha to coverage), leaf tint and transmission
const FRAG_ALBEDO = /* glsl */ `
{
  vec2 uv = (vImpCell + clamp(vImpUv, vec2(impInset), vec2(1.0 - impInset))) / ${GRID.toFixed(1)};
  vec4 ta = texture(impAlbedo, vec3(uv, impLayer));
  vec4 tn = texture(impNormal, vec3(uv, impLayer));
  // cut a bit below 0.5: the averaged alpha of the coarse mips would erode the crowns
  float a = (ta.a - 0.4) / max(fwidth(ta.a), 1e-4) + 0.5;
  #ifdef OPAQUE
    if (a < 0.5) discard;
  #else
    if (a <= 0.0) discard;
    diffuseColor.a = clamp(a, 0.0, 1.0);
  #endif
  impLeaf = tn.a > 0.5;
  impNW = normalize(vImpRot * (tn.xyz * 2.0 - 1.0));
  diffuseColor.rgb *= ta.rgb;
  if (impLeaf) {
    float back = clamp(0.25 - dot(impNW, sunDirW), 0.0, 1.0) * step(0.0, sunDirW.y);
    diffuseColor.rgb *= vImpTint * (1.0 + vec3(1.9, 2.0, 1.2) * (foliageTransmission * back));
  }
  surfSpecK = impLeaf ? 0.15 : 0.5;
}
`;

// after normal_fragment_begin: the baked normal (thin leaves also get light from above)
const FRAG_NORMAL = /* glsl */ `
normal = normalize((viewMatrix * vec4(impNW, 0.0)).xyz);
if (impLeaf) normal = normalize(normal + (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz * 0.9);
`;

/** Impostors of the variants of one asset (one texture array layer per variant). */
export class Impostors {
  /** builds: one AssetLibrary build per variant (geometry in asset space). cell: px per view. */
  constructor(lighting, builds, { cell = 64 } = {}) {
    this.lighting = lighting;
    this.builds = builds;
    this.cell = cell;
    this.baked = false;
    const size = GRID * cell, n = builds.length;
    const rt = (srgb) => {
      const t = new THREE.WebGLArrayRenderTarget(size, size, n, { depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
      t.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.texture.anisotropy = 1;
      return t;
    };
    this.albedo = rt(true);
    this.normal = rt(false);
    this.geometry = QUAD;
    this.materials = builds.map((b, v) => this._material(b, v));
  }

  get triangles() { return 2; }

  _material(build, layer) {
    const L = this.lighting;
    const s = build.geometry.boundingSphere;
    const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, alphaToCoverage: true });
    const U = {
      impSphere: { value: new THREE.Vector4(s.center.x, s.center.y, s.center.z, s.radius * 1.04) },
      impAlbedo: { value: this.albedo.texture },
      impNormal: { value: this.normal.texture },
      impLayer: { value: layer },
      impInset: { value: 0.5 / this.cell },
    };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.uniforms.camPosW = (L.uniforms.camPosW ??= { value: new THREE.Vector3() });
      sh.uniforms.foliageTransmission = L.uniforms.foliageTransmission;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', VERT_QUAD)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = vec3(0.0, 0.0, 1.0);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', FRAG_ALBEDO)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${FRAG_NORMAL}`);
    };
    m.customProgramCacheKey = () => 'impostor';
    // sun, cascades, SSAO, probe GI, sky reflections (Lighting.patch chains the code above first)
    L.patch(m, {});
    return m;
  }

  /** Render the atlases (needs the surface textures loaded). Restores the renderer state. */
  bake(renderer) {
    const L = this.lighting, S = L.surfaces;
    const t0 = performance.now();
    const albedoMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
    albedoMat.onBeforeCompile = (sh) => {
      S.inject(sh);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nfloat surfSpecK = 1.0;');
    };
    albedoMat.customProgramCacheKey = () => 'impostor-bake-albedo';
    const normalMat = new THREE.ShaderMaterial({
      uniforms: { folAlbedo: S.uniforms.folAlbedo, folCut: S.uniforms.folCut },
      vertexShader: /* glsl */ `
        attribute float surface;
        varying vec2 vSurfUv;
        varying vec3 vN;
        flat varying int vSurf;
        flat varying float vLeaf;
        void main() {
          vSurfUv = uv;
          vSurf = int(surface + 0.5);
          vN = normal;
          vLeaf = dot(normal, normal) > 2.0 ? 1.0 : 0.0; // crown normals have length 2 (ModelBuilder)
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform highp sampler2DArray folAlbedo;
        uniform float folCut;
        varying vec2 vSurfUv;
        varying vec3 vN;
        flat varying int vSurf;
        flat varying float vLeaf;
        void main() {
          if (vSurf >= ${FOLIAGE_BASE} && texture(folAlbedo, vec3(vSurfUv, float(vSurf - ${FOLIAGE_BASE}))).a < folCut) discard;
          gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, vLeaf);
        }`,
      side: THREE.DoubleSide,
    });
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
      for (const [t, mat, clear] of [[this.albedo, albedoMat, [0.06, 0.09, 0.035, 0]], [this.normal, normalMat, [0.5, 1, 0.5, 1]]]) {
        mesh.material = mat;
        t.viewport.set(0, 0, size, size);
        t.scissorTest = false;
        renderer.setRenderTarget(t, layer);
        renderer.setClearColor(new THREE.Color().setRGB(clear[0], clear[1], clear[2], THREE.LinearSRGBColorSpace), clear[3]);
        renderer.clear(true, true, false);
        t.scissorTest = true;
        for (let j = 0; j < GRID; j++) {
          for (let i = 0; i < GRID; i++) {
            const d = decode(((i + 0.5) / GRID) * 2 - 1, ((j + 0.5) / GRID) * 2 - 1);
            cam.up.set(0, 1, 0);
            if (d.y > 0.999) cam.up.set(0, 0, -1);
            cam.position.copy(center).addScaledVector(d, 2 * R);
            cam.lookAt(center);
            cam.updateMatrixWorld();
            t.viewport.set(i * c, j * c, c, c);
            t.scissor.set(i * c, j * c, c, c);
            renderer.setRenderTarget(t, layer);
            renderer.render(scene, cam);
          }
        }
        t.scissorTest = false;
        t.viewport.set(0, 0, size, size);
      }
    });
    // mipmaps of every layer at once
    const gl = renderer.getContext();
    for (const t of [this.albedo, this.normal]) {
      t.texture.generateMipmaps = true;
      renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, renderer.properties.get(t.texture).__webglTexture);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    }
    renderer.state.unbindTexture();
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
    for (const m of this.materials) m.dispose();
  }
}
