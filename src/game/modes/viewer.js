// Non-game modes of the game page, used by the editor previews and the agent tools:
//   ?mode=view   free camera over the world (?cam=x,y,z,yaw,pitch  ?at=entityId|x,z  ?tod=h)
//   ?mode=asset  turntable view of one asset (?asset=name&variant=0&quality=1&yaw=30&dist=)
//   ?mode=viewmodel  first-person weapon + arms (?weapon=id&ads=0..1&reload=0..1&tod=h&orbit=yaw,pitch,dist)
//   ?mode=characters NPC bodies side by side (?show=model|archetype,…&archetypes=1&clip=&time=&yaw=&pitch=&dist=)
import * as THREE from 'three';
import { FlyCamera } from '../../engine/core/FlyCamera.js';
import { AssetLibrary } from '../../engine/assets/AssetLibrary.js';
import { LAYERS } from '../../engine/render/layers.js';

export async function startViewMode(app, params) {
  const { engine, input, world } = app;
  const fly = new FlyCamera(engine.camera, input, { speed: 40 });
  fly.minHeightFn = (x, z) => world.terrain.heightAt(x, z) + 0.5;
  app.fly = fly;
  app.setView = (v) => {
    if (v.cam) {
      const c = String(v.cam).split(',').map(Number);
      fly.setFrom(new THREE.Vector3(c[0], c[1], c[2]), c[3] ?? 0, c[4] ?? 0);
    }
    if (v.at) {
      let x, y, z;
      const e = world.entities.get(v.at);
      if (e) [x, y, z] = e.pos;
      else { [x, z] = String(v.at).split(',').map(Number); y = world.terrain.heightAt(x, z); }
      const d = Number(v.dist ?? 25);
      const yaw = Number(v.yaw ?? 0.6);
      const pos = new THREE.Vector3(x + Math.sin(yaw) * d, y + d * 0.5, z + Math.cos(yaw) * d);
      pos.y = Math.max(pos.y, world.terrain.heightAt(pos.x, pos.z) + 2);
      fly.camera.position.copy(pos);
      fly.lookAt(new THREE.Vector3(x, y + 1.5, z));
    }
    if (v.tod !== undefined) engine.lighting.setTimeOfDay(+v.tod);
  };
  const start = world.data.player?.pos ?? [0, 60, 0];
  fly.setFrom(new THREE.Vector3(start[0], start[1] + 3, start[2]), world.data.player?.yaw ?? 0, -0.1);
  app.setView({ cam: params.get('cam'), at: params.get('at'), tod: params.get('tod') ?? undefined, dist: params.get('dist') ?? undefined, yaw: params.get('yaw') ?? undefined });
  world.advanceDay = params.has('daycycle');
  engine.addSystem({ update: (dt) => { fly.update(dt); input.endFrame(); } });
  engine.canvas.addEventListener('click', () => input.lock());
}

export async function startAssetMode(app, params) {
  const { engine } = app;
  const lighting = engine.lighting;
  lighting.setEnvironment({ timeOfDay: Number(params.get('tod') ?? 10.5), dayLengthMinutes: 0, fogDensity: 0.0004 });
  lighting.flare.setEnabled(false); // turntables: the asset only, never a sun flare / dazzle
  const assets = await new AssetLibrary(lighting).load();
  app.assets = assets;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48).rotateX(-Math.PI / 2), lighting.material({ vertexColors: false, color: 0x8a9a6a }));
  ground.layers.set(LAYERS.STATIC);
  ground.visible = params.get('ground') !== '0';
  engine.scene.add(ground);
  const colliderGroup = new THREE.Group();
  engine.scene.add(colliderGroup);
  const pivot = new THREE.Group();
  engine.scene.add(pivot);
  let mesh = null, lineupFrame = null;
  app.showAsset = (name, { variant = 0, quality = 1 } = {}) => {
    if (mesh) { pivot.remove(mesh); }
    lineupFrame = null;
    const b = assets.build(name, { quality, variant });
    mesh = new THREE.Mesh(b.geometry, assets.material(b));
    mesh.layers.set(LAYERS.STATIC);
    pivot.add(mesh);
    const size = b.bounds.getSize(new THREE.Vector3());
    const center = b.bounds.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z, 0.3);
    const dist = Number(params.get('dist') ?? r * 1.35 + 0.3);
    const yaw = (Number(params.get('yaw') ?? 35) * Math.PI) / 180;
    engine.camera.near = Math.max(0.01, r / 200);
    engine.camera.updateProjectionMatrix();
    engine.camera.position.set(center.x + Math.sin(yaw) * dist, center.y + dist * 0.45, center.z + Math.cos(yaw) * dist);
    engine.camera.lookAt(center);
    lighting.sun.setCascades([{ radius: Math.max(4, r * 1.6), res: 2048, every: 1 }]);
    colliderGroup.clear();
    if (params.get('colliders') === '1') {
      for (const c of b.colliders) {
        const geo = c.type === 'box' ? new THREE.BoxGeometry(...(c.size ?? [1, 1, 1])) : c.type === 'cylinder' ? new THREE.CylinderGeometry(c.radius ?? 0.5, c.radius ?? 0.5, c.height ?? 1, 12) : new THREE.SphereGeometry(c.radius ?? 0.5, 12, 8);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c.ladder ? 0x30ff60 : 0xff3030, wireframe: true, depthTest: false }));
        m.position.fromArray(c.pos ?? [0, 0, 0]);
        m.rotation.y = ((c.rot?.[1] ?? 0) * Math.PI) / 180;
        m.renderOrder = 10;
        colliderGroup.add(m);
      }
    }
    return { triangles: b.triangles, size: size.toArray().map((v) => +v.toFixed(2)), colliders: b.colliders };
  };
  // every variant at every LOD quality side by side (LOD coherence check): groups of
  // [q1, q0.5, q0.25] per variant, in one row, seen from the front with a narrow lens
  app.showLineup = (name, { variants = 4, qualities = [1, 0.5, 0.25] } = {}) => {
    if (mesh) { pivot.remove(mesh); }
    mesh = new THREE.Group();
    const builds = [];
    let w = 0.3, hMax = 0.3;
    for (let v = 0; v < variants; v++) for (const quality of qualities) {
      const b = assets.build(name, { quality, variant: v });
      const s = b.bounds.getSize(new THREE.Vector3());
      w = Math.max(w, s.x, s.z);
      hMax = Math.max(hMax, b.bounds.max.y);
      builds.push({ b, v, quality });
    }
    const step = w * 0.95, gap = w * 0.45;
    const total = builds.length * step + (variants - 1) * gap;
    const out = [];
    builds.forEach(({ b, v, quality }, i) => {
      const m = new THREE.Mesh(b.geometry, assets.material(b));
      m.layers.set(LAYERS.STATIC);
      m.position.set(-total / 2 + step / 2 + i * step + v * gap, 0, 0);
      mesh.add(m);
      out.push({ variant: v, quality, triangles: b.triangles, height: +b.bounds.max.y.toFixed(2) });
    });
    pivot.add(mesh);
    ground.scale.setScalar(Math.max(1, total / 100));
    // framed by width for the current aspect (the CLI resizes the page to `aspect` after load)
    const fov = 12;
    lineupFrame = () => {
      const cam = engine.camera, t = Math.tan((fov * Math.PI) / 360);
      const dist = (total * 0.52) / (t * cam.aspect);
      cam.fov = fov;
      cam.near = 1;
      cam.far = dist * 4;
      cam.updateProjectionMatrix();
      cam.position.set(0, hMax * 0.55 + dist * 0.05, dist);
      cam.lookAt(0, hMax * 0.55, 0);
    };
    lineupFrame();
    lighting.sun.setCascades([{ radius: total * 0.6, res: 4096, every: 1 }]);
    colliderGroup.clear();
    return { lineup: out, aspect: +(total / (hMax * 1.3)).toFixed(3) };
  };
  app.assetInfo = params.has('lineup')
    ? app.showLineup(params.get('asset') ?? 'palm', { variants: Number(params.get('lineup')) || 4 })
    : app.showAsset(params.get('asset') ?? 'palm', { variant: Number(params.get('variant') ?? 0), quality: Number(params.get('quality') ?? 1) });
  const spin = params.has('spin');
  engine.addSystem({ update: (dt) => { lighting.update(dt, { advanceDay: false }); lineupFrame?.(); if (spin) pivot.rotation.y += dt * 0.5; } });
}

/**
 * ?mode=viewmodel: the first-person view of one weapon (realistic model + arms on its grips, the
 * same overlay pass and light as in game) over the sky, to tune the asset `hands` / `sight` and
 * the weapons.json `view` (?weapon=rifle_ak&ads=0..1&reload=0..1&tod=h). `mc viewmodel shot`.
 */
export async function startViewModelMode(app, params) {
  const { engine } = app;
  const lighting = engine.lighting;
  lighting.setEnvironment({ timeOfDay: Number(params.get('tod') ?? 10.5), dayLengthMinutes: 0, fogDensity: 0.0004 });
  lighting.flare.setEnabled(false);
  const { Data } = await import('../../engine/core/Data.js');
  const { loadViewModels } = await import('../player/ViewModels.js');
  const [assets, player, weapons, manifest] = await Promise.all([
    new AssetLibrary(lighting).load(), Data.json('game/player.json'), Data.json('game/weapons.json'), Data.jsonOr('viewmodels.json', {}),
  ]);
  const viewModels = await loadViewModels(manifest, player.arms?.model, engine.renderer);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 48).rotateX(-Math.PI / 2), lighting.material({ vertexColors: false, color: 0xb8a77a }));
  ground.layers.set(LAYERS.STATIC);
  engine.scene.add(ground);
  engine.camera.position.set(0, 1.65, 0);
  engine.camera.rotation.set(-0.05, 0, 0);
  const { Weapons } = await import('../player/Weapons.js');
  const W = new Weapons({ engine, viewModels, data: { player }, world: { assets }, app }, weapons);
  app.weapons = W;
  const D2R = Math.PI / 180;
  let pose = null;
  app.showWeapon = (id, { ads = 0, reload = 0 } = {}) => {
    const d = W.defs[id];
    if (!d) throw new Error('no weapon ' + id);
    W._showVM(id);
    const info = W.vmInfo, view = d.view ?? { pos: [0.2, -0.25, -0.5], rot: [0, 0, 0] };
    const t = ads * ads * (3 - 2 * ads);
    W.vmRoot.position.set(...view.pos).lerp(new THREE.Vector3(-info.sight.x, -info.sight.y, -(view.adsDist ?? 0.32)), t);
    W.vmRoot.rotation.set((view.rot[0] ?? 0) * D2R, (view.rot[1] ?? 0) * D2R * (1 - ads), (view.rot[2] ?? 0) * D2R * (1 - ads));
    W.vm.camera.fov = 58;
    W.vm.camera.updateProjectionMatrix();
    pose = { id, info, leftAway: reload ? Math.sin(reload * Math.PI) : 0, shell: !!d.reloadPerShell };
    // ?grips=1: the grip targets (wrist dot, fingers arrow red, thumb side arrow blue)
    W.vmGroup.getObjectByName('gripDebug')?.removeFromParent();
    if (params.get('grips') === '1' && info.hands) {
      const dbg = new THREE.Group();
      dbg.name = 'gripDebug';
      for (const h of Object.values(info.hands)) {
        const p0 = new THREE.Vector3(...h.pos);
        dbg.add(new THREE.ArrowHelper(new THREE.Vector3(...h.fingers).normalize(), p0, 0.09, 0xff3030, 0.02, 0.012));
        dbg.add(new THREE.ArrowHelper(new THREE.Vector3(...h.thumb).normalize(), p0, 0.06, 0x3060ff, 0.02, 0.012));
      }
      dbg.traverse((o) => { o.layers.set(LAYERS.VIEW); if (o.material) { o.material.depthTest = false; o.renderOrder = 10; } });
      W.vmGroup.add(dbg);
    }
    return { id, real: !!viewModels.weapons[d.asset], arms: !!W.arms?.visible, sight: info.sight.toArray(), muzzle: info.muzzle.toArray() };
  };
  engine.addSystem({
    update: (dt) => {
      lighting.update(dt, { advanceDay: false });
      W.vmLight.update();
      if (pose && W.arms?.visible) {
        W.vm.camera.updateMatrixWorld(true);
        const away = pose.shell ? new THREE.Vector3(0.03, -0.12, 0.1) : new THREE.Vector3(-0.05, -0.35, 0.15);
        W.arms.update(W.vmGroup, pose.info.hands, { leftAway: pose.leftAway, awayOffset: away });
        // how far each wrist is from its grip (m): > 0.01 = out of reach (move the weapons.json view)
        const err = {};
        for (const [k, h] of Object.entries(pose.info.hands ?? {})) {
          if (k === 'left' && pose.leftAway) continue;
          const tgt = new THREE.Vector3(...h.pos).applyMatrix4(W.vmGroup.matrixWorld);
          err[k] = +W.arms.sides[k[0].toUpperCase()].wrist.getWorldPosition(new THREE.Vector3()).distanceTo(tgt).toFixed(4);
        }
        if (app.viewModelInfo) app.viewModelInfo.gripError = err;
      }
    },
  });
  // ?orbit=yaw,pitch,dist: look at the view model from outside (deg, m around the weapon origin)
  const orbit = params.get('orbit')?.split(',').map(Number);
  if (orbit) {
    const cam = new THREE.PerspectiveCamera(35, engine.camera.aspect, 0.01, 20);
    cam.layers.enableAll();
    W.vm.scene.add(cam);
    engine.overlay = { scene: W.vm.scene, camera: cam };
    engine.addSystem({
      lateUpdate: () => {
        const c = W.vmWeapon.getWorldPosition(new THREE.Vector3());
        const [yaw, pitch, dist = 0.9] = orbit, y = yaw * D2R, p = pitch * D2R;
        cam.position.set(c.x + Math.sin(y) * Math.cos(p) * dist, c.y + Math.sin(p) * dist, c.z + Math.cos(y) * Math.cos(p) * dist);
        cam.lookAt(c);
      },
    });
  }
  app.viewModelInfo = app.showWeapon(params.get('weapon') ?? 'rifle_ak', { ads: Number(params.get('ads') ?? 0), reload: Number(params.get('reload') ?? 0) });
}

/**
 * ?mode=characters: NPC bodies side by side under the game lighting, facing the camera:
 * ?show=a,b,… (character models and / or archetype ids: palette + held weapon), ?archetypes=1
 * (every archetype; with `models`, each of its models), ?clip=Idle paused at ?time=s (default:
 * Idle_Gun when armed, else Idle), ?yaw / ?pitch (deg) / ?dist (m) move the camera, ?face (deg)
 * turns the characters (toward the sun), ?lod=i draws LOD i of the realistic bodies. `mc character shot`.
 */
export async function startCharactersMode(app, params) {
  const { engine } = app;
  const lighting = engine.lighting;
  lighting.setEnvironment({ timeOfDay: Number(params.get('tod') ?? 10.5), dayLengthMinutes: 0, fogDensity: 0.0004 });
  lighting.flare.setEnabled(false);
  const { Data } = await import('../../engine/core/Data.js');
  const { CharacterLibrary, nextCharacterFrame } = await import('../../engine/anim/Characters.js');
  const [arch, weapons, manifest, assets] = await Promise.all([
    Data.json('game/archetypes.json'), Data.json('game/weapons.json'), Data.jsonOr('characters.json', { characters: {} }), new AssetLibrary(lighting).load(),
  ]);
  // what to show: [{ label, model, arch }]
  const items = [];
  const add = (k) => {
    const a = arch.archetypes[k];
    if (a) for (const m of a.models?.length ? a.models : [a.model]) items.push({ label: k, model: m, arch: a });
    else items.push({ label: k, model: k, arch: null });
  };
  if (params.get('archetypes') === '1') Object.keys(arch.archetypes).forEach(add);
  for (const k of (params.get('show') ?? '').split(',').filter(Boolean)) add(k);
  if (!items.length) Object.keys(manifest.characters ?? {}).forEach(add);
  const lib = await new CharacterLibrary(lighting).load([...new Set(items.map((i) => i.model))]);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48).rotateX(-Math.PI / 2), lighting.material({ vertexColors: false, color: 0x8a9a6a }));
  ground.layers.set(LAYERS.STATIC);
  engine.scene.add(ground);
  const step = 0.95, total = items.length * step;
  const chars = [], info = [];
  items.forEach((it, i) => {
    const a = it.arch, pal = a?.palette && arch.palettes?.[a.palette];
    const c = lib.create(pal ? lib.variant(it.model, pal, a.palette) : it.model);
    if (a?.scale) c.model.scale.multiplyScalar(a.scale);
    c.root.position.set(-total / 2 + step / 2 + i * step, 0, 0);
    c.root.rotation.y = (Number(params.get('face') ?? 0) * Math.PI) / 180;
    engine.scene.add(c.root);
    const w = a?.weapon && weapons.weapons[a.weapon];
    if (w && assets.has(w.asset)) {
      const b = assets.build(w.asset, { quality: 1 });
      const holder = c.attachToHand(new THREE.Mesh(b.geometry, assets.material(b)));
      holder?.quaternion.copy(c.solveGrip('Pistol_Aim_Neutral'));
      holder?.position.copy(c.grip.R);
    }
    if (params.has('lod')) c.setLod(Number(params.get('lod')));
    const clip = params.get('clip') ?? (w ? 'Idle_Gun' : 'Idle');
    c.play(clip, { fade: 0 });
    c.update(Number(params.get('time') ?? 0.5));
    chars.push(c);
    let tris = 0;
    c.model.traverse((o) => { if (o.isMesh) tris += (c.lods ? c.lods[c.lod].count : o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
    info.push({ label: it.label, model: it.model, tris, clip, playing: !!c.actions[clip], height: +(lib.templates[it.model].scene.userData.height ?? 0) });
  });
  // camera: framed by width from the front (?yaw / ?pitch / ?dist override)
  const D2R = Math.PI / 180, fov = 24;
  const frame = () => {
    const cam = engine.camera, t = Math.tan((fov * D2R) / 2);
    const dist = Number(params.get('dist') ?? Math.max(2.2, (total * 0.55) / (t * cam.aspect)));
    const yaw = Number(params.get('yaw') ?? 0) * D2R, pitch = Number(params.get('pitch') ?? 4) * D2R;
    cam.fov = fov;
    cam.near = 0.05;
    cam.far = dist * 6 + 50;
    cam.updateProjectionMatrix();
    cam.position.set(Math.sin(yaw) * Math.cos(pitch) * dist, 1.0 + Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
    cam.lookAt(0, 1.0, 0);
  };
  frame();
  lighting.sun.setCascades([{ radius: Math.max(4, total * 0.7), res: 4096, every: 1 }]);
  engine.addSystem({ update: (dt) => { nextCharacterFrame(); lighting.update(dt, { advanceDay: false }); frame(); } });
  app.characters = chars;
  app.charactersInfo = { characters: info, loadMs: Math.round(lib.loadMs) };
}
