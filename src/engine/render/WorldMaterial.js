// World materials: three.js node materials (TSL) lit by the engine's own light instead of scene
// lights (render/Lighting.js):
//  - the sun with the cascaded shadows of SunShadows.js (no three.js light or shadow map),
//  - the baked probe GI of GI.js in place of the ambient / hemisphere light,
//  - half-res SSAO (SSAO.js) on the indirect light and a share of the sun,
//  - sky reflections (PBR materials): the sky gradient around the reflected direction, scaled by
//    the probe sky visibility so nothing glows under a roof or in the jungle,
//  - the display transform (tone mapping, grade, fog) inline at the output (Output.js).
// A custom lights node (no light) makes three run the lighting model, whose indirect() adds the
// sun (through the model's own BRDF: three's PBR or Lambert) and the probe irradiance; the
// formulas are three's MeshStandardMaterial / MeshLambertMaterial ones.
//
// Vertex side (positionNode, also used by the depth-only passes, which copy it): wind sway,
// per-instance transform of FieldMesh instancing (render/FieldMesh.js), LOD culling / cross-fade
// bands (LodFade.js), distance shrink (fadeMaterial), bird wings... `material.mcVertex` lists
// them; derived materials (LOD, fade) are clones with a rebuilt positionNode.
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, attribute, varying, vec2, vec3, vec4, float, dot, normalize, max, min, mix, clamp, sqrt, select, step, smoothstep, length, distance, abs,
  positionLocal, positionGeometry, positionWorld, positionView, positionViewDirection, normalView, normalGeometry, normalLocal, normalFlat, faceDirection,
  modelWorldMatrix, cameraViewMatrix, transformNormalToView, materialColor, materialNormal, materialMetalness, diffuseColor, roughness, reflect, BRDF_Lambert,
  screenCoordinate, Discard, mat3,
} from 'three/tsl';
import { surfSpecK, fieldInstance, instanceNormal, bayer4, leafTint } from './nodes.js';
import { sRough, sMetal } from './Surfaces.js';

// ---- lights: none (the lighting model computes the sun and the ambient itself) -------------

class WorldLightsNode extends THREE.LightsNode {
  get hasLights() { return true; }
  setupLightsNode() { return []; }
  getLightNodes() { return []; }
  customCacheKey() { return 0x6d63; }
}
export const worldLights = new WorldLightsNode();

/** Sun + probe GI + SSAO (+ sky reflections, + environment map) for a lighting model. */
function worldLight(model, builder, physical) {
  const L = model.L, cfg = model.cfg, S = L.sun.uniforms, A = L.ao.uniforms, m = builder.material;
  const { reflectedLight, irradiance, radiance } = builder.context;
  // the shading normal (normal maps, leaves bent toward the sky): three's `geometryNormal` in
  // the WebGL lighting chunks, which the sun, the probes and the sky reflections used
  const nG = normalView;
  const nW = normalize(vec4(nG, 0).mul(cameraViewMatrix).xyz).toVar('mcNW');
  // SSAO (view depth within its range)
  const ssao = float(1).toVar('ssao');
  if (cfg.ao) {
    const z = positionView.z.negate();
    If(A.aoEnabled.greaterThan(0.5).and(z.lessThan(A.aoFar)), () => { ssao.assign(L.ao.sampleNode()(z)); });
  }
  model.ssao = ssao;
  // sun, through the model's BRDF, shadowed by the cascades
  const NdL = dot(nW, S.sunDirW).toVar('sunNdL');
  If(NdL.greaterThan(0), () => {
    let P = positionWorld;
    // in front of the receiver's own caster (impostor cards)
    if (m.mcReceiverShift) P = P.add(S.sunDirW.mul(m.mcReceiverShift));
    let col = S.sunColor.mul(L.sun.shadowNode()(P, nW, NdL));
    if (cfg.ao) col = col.mul(mix(1, ssao, A.aoDirect));
    const dir = normalize(cameraViewMatrix.mul(vec4(S.sunDirW, 0)).xyz);
    model.direct({ lightDirection: dir, lightColor: col, reflectedLight }, builder);
  });
  // probe GI (hemisphere light without it)
  const gi = L.gi.irradianceNode()(positionWorld, nW).toVar('mcGI');
  irradiance.addAssign(gi.rgb);
  model.gi = gi;
  if (!physical) return;
  const occ = gi.a;
  // sky reflections: the gradient around the reflected direction (blurred toward its average
  // with roughness), occluded by the probes
  if (cfg.sky) {
    const K = L.skyU, U = L.uniforms;
    const rW = normalize(vec4(reflect(positionViewDirection.negate(), nG), 0).mul(cameraViewMatrix).xyz);
    const skyR = select(rW.y.greaterThan(0), mix(K.horizon, K.zenith, sqrt(max(rW.y, 0))), K.horizon.mul(mix(0.45, 0.25, min(rW.y.negate().mul(4), 1))));
    const skyAvg = mix(K.horizon, K.zenith, 0.55).mul(0.8);
    radiance.addAssign(mix(skyR, skyAvg, roughness).mul(U.skySpec).mul(occ).mul(surfSpecK));
  }
  // environment map (view models: specular only, occluded the same way)
  if (cfg.env) radiance.addAssign(cfg.env(builder).mul(occ));
}

function worldAO(model, builder) {
  if (!model.cfg.ao) return;
  const { reflectedLight } = builder.context;
  reflectedLight.indirectDiffuse.mulAssign(model.ssao);
  reflectedLight.indirectSpecular.mulAssign(model.ssao);
}

/** Debug views (debug panel): AO term only, probe irradiance only, cascades tint. */
function worldDebug(model, builder) {
  const L = model.L, { outgoingLight } = builder.context;
  if (model.cfg.ao) {
    const A = L.ao.uniforms;
    If(A.aoDebug.greaterThan(0.5).and(A.aoEnabled.greaterThan(0.5)), () => { outgoingLight.assign(vec3(model.ssao)); });
  }
  If(L.gi.uniforms.giDebug.greaterThan(0.5), () => { outgoingLight.assign(model.gi.rgb.mul(1 / Math.PI)); });
  If(L.sun.uniforms.sunDebug.greaterThan(0.5), () => { outgoingLight.mulAssign(L.sun.cascadeTintNode()(positionWorld)); });
}

class WorldPhysicalModel extends THREE.PhysicalLightingModel {
  constructor(L, cfg) { super(); this.L = L; this.cfg = cfg; }
  indirect(builder) {
    worldLight(this, builder, true);
    super.indirect(builder);
  }
  ambientOcclusion(builder) { worldAO(this, builder); }
  finish(builder) { super.finish(builder); worldDebug(this, builder); }
}

class WorldLambertModel extends THREE.PhongLightingModel {
  constructor(L, cfg) { super(false); this.L = L; this.cfg = cfg; }
  indirect(builder) {
    worldLight(this, builder, false);
    const { irradiance, reflectedLight } = builder.context;
    reflectedLight.indirectDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })));
    worldAO(this, builder);
  }
  finish(builder) { worldDebug(this, builder); }
}

// ---- material classes ----------------------------------------------------------------------

const MC_FIELDS = ['mcL', 'mcCfg', 'mcOpts', 'mcVertex', 'mcReceiverShift', 'mcSetup'];

function worldClass(Base, physical) {
  return class extends Base {
    constructor(L, cfg, params) {
      super(params);
      this.isWorldMaterial = true;
      this.mcL = L ?? null;
      this.mcCfg = cfg ?? { ao: true, sky: physical, env: null };
      this.mcOpts = null;
      this.mcVertex = {};
      this.mcReceiverShift = null;
      this.mcSetup = null; // (material) => rebuild the nodes (clones)
      this.lightsNode = worldLights;
    }

    setupLightingModel() {
      return physical ? new WorldPhysicalModel(this.mcL, this.mcCfg) : new WorldLambertModel(this.mcL, this.mcCfg);
    }

    copy(source) {
      super.copy(source);
      for (const k of MC_FIELDS) this[k] = source[k];
      this.mcVertex = { ...source.mcVertex };
      this.isWorldMaterial = true;
      this.lightsNode = worldLights;
      return this;
    }
  };
}

export const WorldStandardMaterial = worldClass(THREE.MeshStandardNodeMaterial, true);
export const WorldLambertMaterial = worldClass(THREE.MeshLambertNodeMaterial, false);

// ---- vertex side -------------------------------------------------------------------------------

/**
 * Local position (instance applied) of a world mesh vertex: wind, bird wings, distance shrink,
 * FieldMesh instance transform, LOD culling. v = material.mcVertex:
 *   wind, wing: Vector2 uniform (shoulder, half span), fade: Vector2 uniform (shrink between),
 *   lod: true (object uniform `lodRange` per mesh, LodFade.js)
 */
export function worldPosition(L, v) {
  return Fn((builder) => {
    const U = L.uniforms, inst = fieldInstance(builder);
    const p = vec3(positionLocal).toVar('mcPos');
    const originW = modelWorldMatrix.mul(inst ? vec4(inst.element(3).xyz, 1) : vec4(0, 0, 0, 1)).xyz;
    if (v.wind && builder.geometry.hasAttribute('wind')) {
      const w = attribute('wind', 'float');
      const ph = U.uTime.mul(U.windSpeed).add(dot(originW.xz, vec2(0.071, 0.093))).toVar();
      const gust = float(0.65).add(U.uTime.mul(0.37).add(originW.x.mul(0.01)).sin().mul(0.35));
      const sway = ph.sin().mul(0.7).add(ph.mul(2.31).add(1.7).sin().mul(0.3)).mul(U.windStrength).mul(gust).mul(w);
      p.xz.addAssign(U.windDir.mul(sway));
      const pg = positionGeometry;
      p.y.addAssign(ph.mul(4.7).add(pg.x.mul(2)).add(pg.z.mul(2)).sin().mul(0.04).mul(w).mul(U.windStrength));
    }
    if (v.wing) wingFold(p, v.wing, builder);
    if (v.fade) p.mulAssign(float(1).sub(smoothstep(v.fade.x, v.fade.y, distance(originW, U.camPosW))));
    if (inst) p.assign(inst.mul(vec4(p, 1)).xyz);
    if (v.lod && inst) {
      // instances outside the LOD's range collapse to one point (no triangle is rasterized)
      const r = lodRangeUniform();
      const d = length(originW.xz.sub(U.camPosW.xz));
      const out = builder.material.mcDepth
        // depth-only passes (sun cascades, SSAO pre-pass): hard switch at the middle of each band
        ? d.lessThan(r.x.add(r.y).mul(0.5)).or(d.greaterThanEqual(r.z.add(r.w).mul(0.5)))
        : d.lessThan(r.x).or(d.greaterThanEqual(r.w));
      p.assign(select(out, vec3(0), p));
    }
    return p;
  })();
}

let _lodRange = null;
/** Per-mesh LOD range [inA, inB, outA, outB] (mesh.userData.lodRange, LodFade.js). */
export function lodRangeUniform() {
  return (_lodRange ??= uniform(new THREE.Vector4(-1, -1, 1e9, 1e9)).onObjectUpdate(({ object }) => object.userData.lodRange ?? _noRange));
}
const _noRange = new THREE.Vector4(-1, -1, 1e9, 1e9);

/** LOD cross-fade of the fragment: flat varying (+ fading out, - fading in), 4x4 Bayer dither. */
function lodDither(L) {
  const fade = varying(Fn((builder) => {
    const inst = fieldInstance(builder);
    if (!inst) return float(1);
    const r = lodRangeUniform(), U = L.uniforms;
    const d = length(modelWorldMatrix.mul(vec4(inst.element(3).xyz, 1)).xz.sub(U.camPosW.xz));
    const fin = select(r.y.greaterThan(r.x), d.sub(r.x).div(r.y.sub(r.x)), float(1));
    const fout = select(r.w.greaterThan(r.z), r.w.sub(d).div(r.w.sub(r.z)), float(1));
    // fading in: negative, so the fragment side mirrors the threshold
    return select(fin.lessThan(1), fin.negate(), min(fout, 1));
  })(), 'vLodFade').setInterpolation(THREE.InterpolationSamplingType.FLAT);
  If(fade.lessThan(1), () => {
    const t = bayer4(screenCoordinate);
    If(select(fade.lessThan(0), t.oneMinus(), t).greaterThanEqual(abs(fade)), () => { Discard(); });
  });
}

/** Bird wings (Birds.js): vertices past the shoulder flap / fold from the per-instance aWing (angle, fold). */
function wingFold(p, wing, builder) {
  if (!builder.geometry.hasAttribute('aWing')) return;
  const aw = attribute('aWing', 'vec2');
  const ax = abs(p.x);
  If(ax.greaterThan(wing.x), () => {
    const s = select(p.x.lessThan(0), float(-1), float(1));
    const len = max(wing.y.sub(wing.x), 1e-3);
    const d = ax.sub(wing.x).toVar();
    const k = d.div(len), fold = aw.y;
    // folded: the wing closes along the body (span shrinks, the tip swept back and down)
    p.z.addAssign(fold.mul(k).mul(len).mul(0.55));
    p.y.subAssign(fold.mul(k).mul(0.03));
    d.mulAssign(float(1).sub(fold.mul(0.93)));
    const a = aw.x.mul(k.mul(0.8).add(0.6)); // the outer wing bends more
    p.x.assign(s.mul(wing.x.add(d.mul(a.cos()))));
    p.y.addAssign(d.mul(a.sin()));
  });
}

// ---- fragment side -------------------------------------------------------------------------

/** Vertex colour (+ instance colour), leaves tinted per instance and lit through on the shaded
 *  side of the crown (foliage), folded into one varying (flat with flatColor). */
function worldVertexColor(L, opts) {
  return Fn((builder) => {
    const g = builder.geometry;
    let c = g.hasAttribute('color') && opts.vertexColors !== false ? vec3(attribute('color', 'vec3')) : vec3(1);
    if (g.hasAttribute('iColor')) c = c.mul(attribute('iColor', 'vec3'));
    if (opts.foliage && g.hasAttribute('normal')) {
      const inst = fieldInstance(builder), n = normalGeometry, S = L.sun.uniforms;
      const leaf = dot(n, n).greaterThan(2);
      const tint = inst ? leafTint(inst.element(3).xz) : vec3(1);
      const nW = mat3(modelWorldMatrix).mul(inst ? mat3(inst).mul(n) : n);
      const back = clamp(float(0.25).sub(dot(normalize(nW), S.sunDirW)), 0, 1).mul(step(0, S.sunDirW.y));
      c = select(leaf, c.mul(tint).mul(vec3(1.9, 2.0, 1.2).mul(L.uniforms.foliageTransmission.mul(back)).add(1)), c);
    }
    return c;
  })();
}

/**
 * Set up the nodes of a world material for its options (Lighting.material):
 *  textured, cutout, wind, emissive, doubleSided, foliage, flatColor, smooth, vertexColors
 * and its vertex options (m.mcVertex: lod, fade). Rebuilt on clones (lodMaterial, fadeMaterial).
 */
export function setupWorldNodes(m, L, opts) {
  m.mcOpts = opts;
  m.mcSetup = (mm) => setupWorldNodes(mm, L, opts);
  m.vertexColors = false; // the colour node reads them (with the leaf tint)
  m.mcVertex.wind = !!opts.wind;
  m.positionNode = worldPosition(L, m.mcVertex);
  const v = m.mcVertex, surf = L.surfaces;
  const vc = varying(worldVertexColor(L, opts), 'vColorW');
  if (opts.flatColor) vc.setInterpolation(THREE.InterpolationSamplingType.FLAT);
  m.colorNode = Fn((builder) => {
    if (v.lod) lodDither(L);
    surfSpecK.assign(1);
    const c = vec3(vc).mul(materialColor.rgb).toVar('mcCol');
    const alpha = float(1).toVar('mcAlpha');
    if (opts.textured) c.mulAssign(surf.surfaceColor({ a2c: !!opts.cutout && builder.renderer.currentSamples > 1, alpha }));
    return vec4(c, alpha);
  })();
  m.normalNode = Fn((builder) => {
    if (builder.isFlatShading()) return normalFlat;
    const inst = fieldInstance(builder);
    const objN = inst ? instanceNormal(inst, normalGeometry) : normalLocal;
    const vn = normalize(varying(transformNormalToView(objN), 'vNormalW'));
    // a leaf's both sides share the outward normal (no back-face flip)
    const nGeo = (opts.doubleSided && !opts.foliage ? vn.mul(faceDirection) : vn).toVar('mcNG');
    return opts.textured ? surf.surfaceNormal(nGeo, positionView, !!opts.doubleSided) : nGeo;
  })();
  if (opts.textured) {
    m.roughnessNode = sRough;
    m.metalnessNode = max(materialMetalness, sMetal);
  }
  if (opts.emissive) {
    m.emissiveNode = Fn((builder) => (builder.geometry.hasAttribute('emissive') ? diffuseColor.rgb.mul(varying(attribute('emissive', 'float'))).mul(3) : vec3(0)))();
  }
  m.needsUpdate = true;
  return m;
}

/** A three.js material (MeshStandardMaterial / MeshLambertMaterial: glTF, characters, effects)
 *  as a world material: same maps and parameters, lit by the world (Lighting.patch). */
export function convertMaterial(L, src, { vertex = {} } = {}) {
  if (src.isWorldMaterial) return src;
  const physical = !!(src.isMeshStandardMaterial || src.isMeshStandardNodeMaterial || src.isMeshPhysicalMaterial);
  const M = physical ? WorldStandardMaterial : WorldLambertMaterial;
  const m = new M(L, { ao: true, sky: physical, env: null });
  const keys = ['name', 'color', 'map', 'opacity', 'transparent', 'alphaTest', 'alphaToCoverage', 'side', 'vertexColors', 'flatShading', 'depthWrite', 'depthTest', 'emissive', 'emissiveIntensity', 'emissiveMap',
    'normalMap', 'normalMapType', 'normalScale', 'aoMap', 'aoMapIntensity', 'alphaMap', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'fog', 'visible', 'blending'];
  if (physical) keys.push('roughness', 'metalness', 'roughnessMap', 'metalnessMap', 'envMapIntensity');
  for (const k of keys) {
    const val = src[k];
    if (val === undefined) continue;
    if (val?.isColor || val?.isVector2) m[k].copy(val); else m[k] = val;
  }
  m.userData = { ...src.userData };
  Object.assign(m.mcVertex, vertex);
  setupConvertedNodes(m, L);
  return m;
}

function setupConvertedNodes(m, L) {
  m.mcSetup = (mm) => setupConvertedNodes(mm, L);
  if (Object.keys(m.mcVertex).some((k) => m.mcVertex[k])) m.positionNode = worldPosition(L, m.mcVertex);
  m.colorNode = Fn((builder) => {
    surfSpecK.assign(1);
    // per-instance colour of a FieldMesh (birds)
    return builder.geometry.hasAttribute('iColor') ? vec4(materialColor).mul(vec4(attribute('iColor', 'vec3'), 1)) : materialColor;
  })();
  // the maps over the geometry normal (flat: derivatives; else interpolated, flipped on back faces)
  m.normalNode = materialNormal;
  m.needsUpdate = true;
  return m;
}

/** A clone of a world material with extra vertex options (LOD culling, fade...): new nodes, so a
 *  different program (and the depth passes copy its positionNode). */
export function deriveMaterial(base, vertex) {
  const m = base.clone();
  Object.assign(m.mcVertex, vertex);
  m.mcSetup?.(m);
  return m;
}
