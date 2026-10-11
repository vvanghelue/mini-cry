// Non-game modes of the game page, used by the editor previews and the agent tools:
//   ?mode=view   free camera over the world (?cam=x,y,z,yaw,pitch  ?at=entityId|x,z  ?tod=h)
//   ?mode=asset  turntable view of one asset (?asset=name&variant=0&quality=1&yaw=30&dist=)
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
