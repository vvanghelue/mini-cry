// Game entity types (registered into the engine's entity registry). Each type works in two
// modes: 'editor' (a light proxy you can see / select / move) and 'game' (the real behaviour,
// through ctx.world.game). Schemas drive the editor inspector and `mc entity` validation.
import * as THREE from 'three';
import { registerEntityType, COMMON_SCHEMA } from '../../engine/world/Entities.js';
import { LAYERS } from '../../engine/render/layers.js';

const D2R = Math.PI / 180;
const proxyMat = (color, opacity = 0.85) => new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity });

function assetMesh(ctx, name, fallback = 0.4) {
  if (ctx.assets.has(name)) {
    const b = ctx.assets.build(name, { quality: 1 });
    return new THREE.Mesh(b.geometry, ctx.assets.material(b));
  }
  return new THREE.Mesh(new THREE.BoxGeometry(fallback, fallback, fallback), proxyMat(0xff00ff));
}

function place(obj, e) {
  obj.position.fromArray(e.pos ?? [0, 0, 0]);
  obj.rotation.y = (e.rot?.[1] ?? 0) * D2R;
  return obj;
}

/** Rest a mesh on the ground at its local origin (weapons lie on their side). */
export function restOnGround(mesh, onSide) {
  mesh.rotation.z = onSide ? Math.PI / 2 : 0;
  mesh.position.y = 0;
  mesh.position.y = -new THREE.Box3().setFromObject(mesh).min.y;
  return mesh;
}

function actorProxy(e, color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.1, 3, 8).translate(0, 0.87, 0), proxyMat(color));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 6).rotateX(-Math.PI / 2).translate(0, 1.5, -0.4), proxyMat(0xffffff));
  g.add(body, nose);
  g.traverse((o) => o.layers.set(LAYERS.DYNAMIC));
  return place(g, e);
}

const ACTOR_SCHEMA = {
  ...COMMON_SCHEMA,
  rot: { type: 'vec3', label: 'Rotation (°)' },
  archetype: { type: 'archetype', label: 'Archetype', required: true },
  patrol: { type: 'entity', ref: 'path', label: 'Patrol path' },
  pose: { type: 'enum', label: 'Idle pose', options: ['stand', 'sit', 'talk', 'work', 'dance'] },
  dormant: { type: 'bool', label: 'Dormant (woken by script)' },
  team: { type: 'enum', label: 'Team', options: ['merc', 'civilian', 'ally'] },
  calm: { type: 'bool', label: 'Never flees (story NPC)' },
};

registerEntityType('enemy', {
  label: 'Enemy', color: '#e03030', category: 'Characters',
  schema: ACTOR_SCHEMA,
  defaults: { archetype: 'merc_rifle', pose: 'stand', team: 'merc' },
  create(ctx, e) {
    if (ctx.mode === 'editor') return { object: actorProxy(e, /sniper/.test(e.archetype) ? 0x8a3060 : /heavy|rocket|boss/.test(e.archetype) ? 0x801818 : 0xd03030) };
    const game = ctx.world.game;
    const a = game.actors.spawn(e);
    return { actor: a, dispose: () => a && game.actors.list.includes(a) && game.actors.remove(a) };
  },
});

registerEntityType('npc', {
  label: 'NPC', color: '#30a0e0', category: 'Characters',
  schema: {
    ...ACTOR_SCHEMA, dialogue: { type: 'string', label: 'Dialogue (talk)' }, talkPrompt: { type: 'string', label: 'Prompt text' },
    talkIf: { type: 'json', label: 'Talks only if (mission condition)' },
  },
  defaults: { archetype: 'villager', pose: 'stand', team: 'civilian' },
  create(ctx, e) {
    if (ctx.mode === 'editor') return { object: actorProxy(e, 0x3090d0) };
    const game = ctx.world.game;
    const a = game.actors.spawn(e);
    if (a && e.team) a.team = e.team;
    let talked = 0;
    // no talking while escorted (the prompt would hide the way) or outside the talkIf condition
    // (e.g. a hostage saying "I'm following you" before the mission is at that step)
    const canTalk = () => a?.alive && !a.ai.dormant && a.ai.state !== 'follow' && game.missions.check(e.talkIf);
    return {
      actor: a,
      object: a?.root,
      interact: e.dialogue ? { prompt: () => (canTalk() ? (e.talkPrompt ?? `Talk to ${e.name ?? a.arch.label}`) : null), range: 2.6 } : null,
      use() {
        if (!canTalk() || game.time - talked < 2) return;
        talked = game.time;
        a.faceTarget = game.player.pos.clone().setY(game.player.pos.y + 1.5);
        setTimeout(() => (a.faceTarget = null), 5000);
        game.dialogue.play(e.dialogue);
        game.interacted.add(e.id);
        game.missions.emit('interact', { entity: e.id });
      },
      dispose: () => a && game.actors.list.includes(a) && game.actors.remove(a),
    };
  },
});

registerEntityType('pickup', {
  label: 'Pickup', color: '#ffd030', category: 'Gameplay', cullDistance: 90,
  schema: {
    ...COMMON_SCHEMA, rot: { type: 'vec3', label: 'Rotation (°)' }, item: { type: 'item', label: 'Item', required: true }, auto: { type: 'bool', label: 'Auto pickup' },
    respawn: { type: 'number', label: 'Respawn (s, 0 = never)' }, still: { type: 'bool', label: 'Lying on the ground (no spin)' },
    rounds: { type: 'int', min: 0, label: 'Rounds in the weapon (0 = default)' },
  },
  defaults: { item: 'medkit', auto: false, respawn: 0 },
  create(ctx, e) {
    const game = ctx.world.game;
    const item = game?.data.items.items[e.item] ?? ctx.world.itemsData?.items?.[e.item];
    const mesh = assetMesh(ctx, item?.asset ?? 'pickup_ammo', 0.3);
    mesh.layers.set(LAYERS.DYNAMIC);
    if (e.still) restOnGround(mesh, !!item?.weapon);
    const g = new THREE.Group();
    g.add(mesh);
    place(g, e);
    if (ctx.mode === 'editor') return { object: g };
    const base = g.position.y + 0.25;
    let t = Math.random() * 6, taken = false, respawnT = 0, life = 0;
    const h = {
      object: g,
      interact: item?.weapon || item?.collectible || item?.key || !e.auto ? { prompt: () => `Pick up ${item?.label ?? e.item}`, range: 2.2 } : null,
      use() { if (!taken && game.pickupItem(e.item, e.id)) take(); },
      update(dt) {
        // temporary loot (ttl, game time) vanishes unless picked up
        if (e.ttl && (life += dt) > e.ttl) { game.world.entities.remove(e.id); return; }
        if (taken) { if (e.respawn > 0 && (respawnT -= dt) <= 0) { taken = false; h.hidden = false; g.visible = true; } return; }
        if (!e.still) {
          t += dt;
          mesh.rotation.y = t * 1.2;
          mesh.position.y = 0.25 + Math.sin(t * 2) * 0.06 + 0.05;
          g.position.y = base - 0.25;
        }
        if (!h.interact) {
          const p = game.player.pos;
          if (Math.abs(p.x - g.position.x) < 1.3 && Math.abs(p.z - g.position.z) < 1.3 && Math.abs(p.y - g.position.y) < 1.8 && game.pickupItem(e.item, e.id, true)) take();
        }
      },
    };
    const take = () => {
      if (e.temp) { game.world.entities.remove(e.id); return; }
      taken = true; h.hidden = true; g.visible = false; respawnT = e.respawn ?? 0; if (!e.respawn) game.world.entities.handle(e.id) && (h.active = false);
    };
    return h;
  },
});

registerEntityType('outpost', {
  label: 'Outpost', color: '#b030d0', category: 'Gameplay',
  schema: {
    ...COMMON_SCHEMA, radius: { type: 'number', label: 'Radius (m)' }, alarm: { type: 'entity', ref: 'alarm', label: 'Alarm' },
    reinforcements: { type: 'json', label: 'Reinforcements [{archetype, count}]' }, reinforceFrom: { type: 'entity', ref: 'marker', label: 'Reinforcements come from' },
    fastTravel: { type: 'bool', label: 'Fast travel once liberated' }, reward: { type: 'json', label: 'Reward (items)' },
  },
  defaults: { radius: 45, reinforcements: [{ archetype: 'merc_rifle', count: 3 }], fastTravel: true },
  create(ctx, e) {
    const ring = new THREE.Mesh(new THREE.RingGeometry((e.radius ?? 45) - 0.6, e.radius ?? 45, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xb030d0, transparent: true, opacity: 0.5, depthWrite: false }));
    ring.position.y = 0.6;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6, 6).translate(0, 3, 0), proxyMat(0xb030d0));
    const g = new THREE.Group();
    g.add(ring, pole);
    g.traverse((o) => o.layers.set(LAYERS.EDITOR));
    place(g, e);
    if (ctx.mode === 'editor') return { object: g, helper: g };
    const game = ctx.world.game;
    const h = {
      object: g, helper: g, alarmed: false,
      get liberated() { return game.liberated.has(e.id); },
      update() {
        if (game.liberated.has(e.id) || !e.group) return;
        const all = game.actors.byGroup(e.group);
        if (!all.length) return;
        if (all.every((a) => !a.alive) && !game.pendingReinforcements(e.group)) {
          const d = Math.hypot(game.player.pos.x - e.pos[0], game.player.pos.z - e.pos[2]);
          if (d < (e.radius ?? 45) * 1.6) game.liberate(e);
        }
      },
      raiseAlarm() {
        if (h.alarmed || game.liberated.has(e.id)) return;
        h.alarmed = true;
        game.raiseAlarm(e);
      },
    };
    return h;
  },
});

registerEntityType('alarm', {
  label: 'Alarm', color: '#ff4040', category: 'Gameplay', cullDistance: 160,
  schema: { ...COMMON_SCHEMA, rot: { type: 'vec3', label: 'Rotation (°)' }, outpost: { type: 'entity', ref: 'outpost', label: 'Outpost' } },
  defaults: {},
  create(ctx, e) {
    const mesh = assetMesh(ctx, 'alarm', 0.5);
    place(mesh, e);
    mesh.layers.set(LAYERS.STATIC);
    if (ctx.mode === 'editor') return { object: mesh };
    const game = ctx.world.game;
    const h = {
      object: mesh, disabled: false, ringing: false,
      interact: { prompt: () => (h.disabled ? null : 'Sabotage the alarm'), range: 2 },
      use() { if (h.disabled) return; h.disabled = true; h.stop(); game.hud.notify('Alarm sabotaged'); game.audio?.play('glass_break', { position: mesh.position }); game.missions.emit('interact', { entity: e.id }); },
      trigger() {
        if (h.disabled || h.ringing) return false;
        h.ringing = true;
        h.sound = game.audio?.play('alarm_siren', { position: mesh.position, loop: true, volume: 1, priority: 3 });
        game.world.entities.handle(e.outpost)?.raiseAlarm?.();
        return true;
      },
      stop() { h.ringing = false; h.sound?.stop?.(0.5); },
    };
    return h;
  },
});

registerEntityType('explosive', {
  label: 'Explosive barrel', color: '#ff6020', category: 'Gameplay', cullDistance: 180,
  schema: { ...COMMON_SCHEMA, rot: { type: 'vec3', label: 'Rotation (°)' }, asset: { type: 'asset', label: 'Asset' }, health: { type: 'number', label: 'Health' }, radius: { type: 'number', label: 'Blast radius' }, damage: { type: 'number', label: 'Damage' } },
  defaults: { asset: 'barrel_explosive', health: 30, radius: 6, damage: 180 },
  create(ctx, e) {
    const mesh = assetMesh(ctx, e.asset ?? 'barrel_explosive', 0.8);
    place(mesh, e);
    mesh.layers.set(LAYERS.STATIC);
    if (ctx.mode === 'editor') return { object: mesh };
    const game = ctx.world.game;
    const b = ctx.assets.has(e.asset) ? ctx.assets.build(e.asset, { quality: 1 }) : null;
    ctx.physics.addLocal(b?.colliders?.length ? b.colliders : [{ type: 'cylinder', radius: 0.35, height: 1, pos: [0, 0.5, 0] }], { x: e.pos[0], y: e.pos[1], z: e.pos[2], yaw: (e.rot?.[1] ?? 0) * D2R, owner: e.id, material: 'metal' });
    let hp = e.health ?? 30, dead = false, burnT = -1;
    const h = {
      object: mesh,
      onHit(dmg) { if (dead) return; hp -= dmg; if (hp <= 0 && burnT < 0) burnT = 0.35; },
      onExplosionNear(d) { if (!dead && d < (e.radius ?? 6) * 0.9 && burnT < 0) burnT = 0.15 + Math.random() * 0.2; },
      update(dt) {
        if (burnT < 0 || dead) return;
        game.effects.fire(mesh.position.clone().setY(mesh.position.y + 1), 0.6);
        burnT -= dt;
        if (burnT <= 0) {
          dead = true;
          mesh.visible = false;
          h.hidden = true;
          ctx.physics.removeOwner(e.id);
          game.weapons.explode(mesh.position.clone().setY(mesh.position.y + 0.6), e.radius ?? 6, e.damage ?? 180, 'barrel');
          game.markDestroyed(e.id);
        }
      },
    };
    return h;
  },
});

registerEntityType('interactable', {
  label: 'Interactable', color: '#40e0a0', category: 'Gameplay', cullDistance: 160,
  schema: { ...COMMON_SCHEMA, rot: { type: 'vec3', label: 'Rotation (°)' }, asset: { type: 'asset', label: 'Asset' }, prompt: { type: 'string', label: 'Prompt text' }, requires: { type: 'item', label: 'Required item' }, once: { type: 'bool', label: 'Once only' }, range: { type: 'number', label: 'Range' } },
  defaults: { asset: 'radio_table', prompt: 'Use', once: true, range: 2.2 },
  create(ctx, e) {
    const mesh = assetMesh(ctx, e.asset ?? 'radio_table', 0.6);
    place(mesh, e);
    mesh.layers.set(LAYERS.STATIC);
    if (ctx.mode === 'editor') return { object: mesh };
    const game = ctx.world.game;
    const b = ctx.assets.has(e.asset) ? ctx.assets.build(e.asset, { quality: 1 }) : null;
    if (b?.colliders?.length) ctx.physics.addLocal(b.colliders, { x: e.pos[0], y: e.pos[1], z: e.pos[2], yaw: (e.rot?.[1] ?? 0) * D2R, owner: e.id });
    let used = false;
    const h = {
      object: mesh,
      interact: { prompt: () => (used && e.once !== false ? null : e.requires && !game.inventory.has(e.requires) ? `${e.prompt} (requires: ${game.data.items.items[e.requires]?.label ?? e.requires})` : e.prompt), range: e.range ?? 2.2 },
      use() {
        if (used && e.once !== false) return;
        if (e.requires && !game.inventory.has(e.requires)) { game.audio?.play('dry_fire'); return; }
        used = true;
        game.interacted.add(e.id);
        game.audio?.play('ui_click', { position: mesh.position });
        game.missions.emit('interact', { entity: e.id });
      },
    };
    return h;
  },
});

registerEntityType('destructible', {
  label: 'Destructible', color: '#e0a040', category: 'Gameplay',
  schema: { ...COMMON_SCHEMA, rot: { type: 'vec3', label: 'Rotation (°)' }, asset: { type: 'asset', label: 'Asset' }, health: { type: 'number', label: 'Health' }, explosiveOnly: { type: 'bool', label: 'Explosives only' }, explode: { type: 'bool', label: 'Explodes' } },
  defaults: { asset: 'generator', health: 200, explosiveOnly: false, explode: true },
  create(ctx, e) {
    const mesh = assetMesh(ctx, e.asset ?? 'generator', 1);
    place(mesh, e);
    mesh.layers.set(LAYERS.STATIC);
    if (ctx.mode === 'editor') return { object: mesh };
    const game = ctx.world.game;
    const b = ctx.assets.has(e.asset) ? ctx.assets.build(e.asset, { quality: 1 }) : null;
    if (b?.colliders?.length) ctx.physics.addLocal(b.colliders, { x: e.pos[0], y: e.pos[1], z: e.pos[2], yaw: (e.rot?.[1] ?? 0) * D2R, owner: e.id, material: 'metal' });
    let hp = e.health ?? 200, dead = false;
    const kill = () => {
      if (dead) return;
      dead = true;
      if (e.explode !== false) game.weapons.explode(mesh.position.clone().setY(mesh.position.y + 0.8), 5, 120, 'object');
      mesh.scale.y = 0.35; mesh.rotation.z = 0.3;
      game.markDestroyed(e.id);
    };
    return {
      object: mesh,
      onHit(dmg, kind) { if (dead || (e.explosiveOnly && kind !== 'explosion')) return; hp -= dmg; if (hp <= 0) kill(); },
      onExplosionNear(d, dmg) { if (!dead && d < 6) { hp -= dmg * (1 - d / 6); if (hp <= 0) kill(); } },
    };
  },
});

registerEntityType('sound', {
  label: 'Ambient sound', color: '#a0a0ff', category: 'Ambience',
  schema: { ...COMMON_SCHEMA, sound: { type: 'sound', label: 'Sound' }, volume: { type: 'number', label: 'Volume' }, radius: { type: 'number', label: 'Activation radius' } },
  defaults: { sound: 'radio_static', volume: 0.6, radius: 40 },
  create(ctx, e) {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.4), new THREE.MeshBasicMaterial({ color: 0xa0a0ff, wireframe: true }));
    m.layers.set(LAYERS.EDITOR);
    place(m, e);
    if (ctx.mode === 'editor') return { object: m, helper: m };
    const game = ctx.world.game;
    let h = null;
    return {
      object: m, helper: m,
      update() {
        const d = game.player.pos.distanceTo(m.position);
        if (d < (e.radius ?? 40) && !h) h = game.audio?.play(e.sound, { position: m.position, loop: true, volume: e.volume ?? 0.6 });
        else if (d > (e.radius ?? 40) * 1.2 && h) { h.stop?.(0.5); h = null; }
      },
      dispose() { h?.stop?.(0); },
    };
  },
});

// drivable kinds (driving specs in game/vehicles/Vehicles.js); the editor's vehicles tab lists them
export const VEHICLE_KINDS = {
  jeep: { label: 'Jeep', asset: 'jeep_body', wheels: 'jeep_wheel' },
  boat: { label: 'Boat', asset: 'boat_patrol' },
  plane: { label: 'Plane', asset: 'plane', propeller: 'plane_propeller', cullDistance: 900 },
};

registerEntityType('vehicle', {
  label: 'Vehicle', color: '#ff9020', category: 'Gameplay', cullDistance: 400,
  schema: { ...COMMON_SCHEMA, rot: { type: 'vec3', label: 'Rotation (°)' }, vehicle: { type: 'enum', label: 'Type', options: Object.keys(VEHICLE_KINDS) } },
  defaults: { vehicle: 'jeep' },
  create(ctx, e) {
    const kind = VEHICLE_KINDS[e.vehicle] ?? VEHICLE_KINDS.jeep;
    const body = assetMesh(ctx, kind.asset, 2);
    const g = new THREE.Group();
    g.add(body);
    if (kind.wheels && ctx.assets.has(kind.wheels)) {
      const wp = ctx.assets.get(kind.asset)?.wheels;
      const list = Array.isArray(wp) && wp.length >= 4 ? wp.map((p) => (Array.isArray(p) ? p : [p.x, p.y, p.z])) : [[-0.72, 0.38, -1.1], [0.72, 0.38, -1.1], [-0.72, 0.38, 1.1], [0.72, 0.38, 1.1]];
      // front wheels (-Z) first: they steer
      list.sort((a, b) => a[2] - b[2]);
      for (const [x, y, z] of list) {
        const w = assetMesh(ctx, kind.wheels);
        w.position.set(x, y ?? 0.38, z);
        w.name = 'wheel';
        g.add(w);
      }
    }
    if (kind.propeller && ctx.assets.has(kind.propeller)) {
      const pr = assetMesh(ctx, kind.propeller);
      pr.position.fromArray(ctx.assets.get(kind.asset)?.propeller ?? [0, 1.3, -3.4]);
      pr.name = 'propeller';
      g.add(pr);
    }
    place(g, e);
    g.traverse((o) => o.layers.set(LAYERS.DYNAMIC));
    if (ctx.mode === 'editor') return { object: g };
    const game = ctx.world.game;
    const h = game.createVehicle ? game.createVehicle(e, g) : { object: g };
    if (kind.cullDistance) h.cullDistance = kind.cullDistance;
    return h;
  },
});
