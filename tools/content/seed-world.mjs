#!/usr/bin/env node
// Content seed for Isla Sombra: writes world.json (sites, garrisons, patrols, NPCs, pickups,
// collectibles, markers, zones, vehicles), game/missions.json and game/dialogue.json.
//
// This is a one-shot authoring script (run by the agent that designed the content):
//   node tools/content/seed-world.mjs [--force]
// After seeding, world.json / missions.json / dialogue.json are the source of truth and are
// edited in the editor or with `npm run mc -- entity ...`. Re-running overwrites them (backups
// are kept in .mc-backup/), so it refuses to run on a non-empty world without --force.
import { readJSON, writeJSON } from '../lib/data.js';
import { loadTerrain } from '../lib/terrain.js';

const force = process.argv.includes('--force');
const existing = readJSON('world.json', { entities: [] });
if (existing.entities?.length && !force) { console.error('world.json already has entities; use --force to overwrite'); process.exit(1); }

const T = loadTerrain();
const H = (x, z) => +T.heightAt(x, z).toFixed(3);
const R2D = 180 / Math.PI;
const ents = [];
const ids = new Set();
const uid = (base) => { let i = 1, id = base; while (ids.has(id)) id = `${base}_${++i}`; ids.add(id); return id; };
const add = (e) => { e.id = e.id ? (ids.has(e.id) ? uid(e.id) : (ids.add(e.id), e.id)) : uid(e.type); ents.push(e); return e; };
/** yaw (deg) so that the asset front (-Z) faces (tx, tz) */
const face = (x, z, tx, tz) => Math.round(Math.atan2(-(tx - x), -(tz - z)) * R2D);
/** yaw (deg) so that the asset +Z axis points along (dx, dz) */
const along = (dx, dz) => Math.round(Math.atan2(dx, dz) * R2D);

/** A site: local coordinates rotated by rot (deg) around (cx, cz). */
function site(cx, cz, rot = 0) {
  const r = (rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const w = (lx, lz) => [cx + lx * c + lz * s, cz - lx * s + lz * c];
  return {
    w,
    prop(asset, lx, lz, yaw = 0, extra = {}) { const [x, z] = w(lx, lz); return add({ type: 'prop', asset, pos: [x, extra.y ?? H(x, z), z], rot: [0, yaw + rot, 0], scale: extra.scale ?? 1, ...(extra.e ?? {}) }); },
    ent(type, lx, lz, extra = {}) { const [x, z] = w(lx, lz); return add({ type, pos: [x, extra.y ?? H(x, z) + (extra.dy ?? 0), z], ...extra, y: undefined, dy: undefined, rot: extra.yaw !== undefined ? [0, extra.yaw + rot, 0] : extra.rot }); },
    enemy(archetype, lx, lz, group, extra = {}) { const [x, z] = w(lx, lz); return add({ type: 'enemy', archetype, group, team: 'merc', pose: 'stand', pos: [x, extra.y ?? H(x, z) + (extra.dy ?? 0), z], rot: [0, (extra.yaw ?? 0) + rot, 0], ...extra, y: undefined, dy: undefined, yaw: undefined }); },
    path(id, pts, extra = {}) { return add({ id, type: 'path', pos: (() => { const [x, z] = w(pts[0][0], pts[0][1]); return [x, H(x, z), z]; })(), points: pts.map(([lx, lz]) => { const [x, z] = w(lx, lz); return [+x.toFixed(2), H(x, z), +z.toFixed(2)]; }), loop: true, wait: 3, ...extra }); },
  };
}
const clean = (e) => { for (const k of Object.keys(e)) if (e[k] === undefined || k === 'yaw' || k === 'dy' || k === 'y') delete e[k]; return e; };
const marker = (id, x, z, label, extra = {}) => add({ id, type: 'marker', pos: [x, H(x, z) + (extra.dy ?? 0), z], label, icon: extra.icon ?? 'none', ...extra, dy: undefined });
const zone = (id, x, z, radius, extra = {}) => add({ id, type: 'zone', shape: 'sphere', radius, pos: [x, H(x, z), z], ...extra });
const pickup = (item, x, z, extra = {}) => add({ type: 'pickup', item, pos: [x, (extra.y ?? H(x, z)) + 0.05, z], auto: extra.auto ?? !/weapon_|intel|relic|key_card|binoculars/.test(item), respawn: 0, ...extra, y: undefined });

// ============================================================================================
// 1. The wreck (start) — south-west beach
const wreck = site(-525, 515, 0);
wreck.prop('boat_wreck', -7, -6, 35);
wreck.prop('crate', 4, -8, 20);
wreck.prop('crate_small', 6, -6, 50);
wreck.prop('barrel', -1, 7, 0);
wreck.prop('jerrycan', 2, 6, 80);
wreck.ent('interactable', 4.5, -2.5, { id: 'radio_wreck', asset: 'radio_table', prompt: 'Allumer la radio de bord', once: true, range: 2.4, yaw: 120 });
pickup('weapon_machete', ...wreck.w(1.5, -4), { id: 'pk_machete' });
pickup('medkit', ...wreck.w(5, -10));
marker('mk_wreck', -523, 513, 'Épave du Marlin', { icon: 'boat' });
const startPos = [-510, H(-510, 524) + 0.1, 524];

// 2. Beach camp — pirates between the wreck and the village
const bc = site(-380, 568, 15);
bc.prop('tent', 0, -7, 0);
bc.prop('campfire', 0, 0, 0);
bc.prop('crate_stack', 6, -3, -60);
bc.prop('barrel', -6, 3, 0);
bc.prop('log_pile', -4, -3, 30);
bc.prop('canoe', 3, 9, 75);
bc.enemy('merc_rifle', -2, 2, 'beach_patrol', { pose: 'sit', yaw: 120 });
bc.enemy('merc_smg', 2.2, 1.5, 'beach_patrol', { pose: 'talk', yaw: -120 });
pickup('weapon_pistol', ...bc.w(6, -1.5), { y: H(...bc.w(6, -1.5)) + 2.05, id: 'pk_pistol' });
pickup('ammo_pistol', ...bc.w(5, -5));
marker('mk_beach_camp', ...bc.w(0, 0), 'Campement de plage');

// 3. Puerto Viejo — fishing village on the lagoon (outpost)
const vc = [-170, 600];
const v = site(...vc, 0);
v.prop('hut_ground', -26, -15, -90);
v.prop('hut_ground', 25, -16, 90);
v.prop('hut_ground', -27, 12, -90);
v.prop('house_wood', 24, 12, 90);
const mara = v.prop('hut_stilt', -5, 52, 0);
v.prop('hut_stilt', -30, 48, 10);
v.prop('hut_stilt', 20, 49, -8);
v.prop('market_stall', -6, -2, 180);
v.prop('market_stall', 6, -1, 180);
v.prop('table', 0, 8, 0);
v.prop('bench', -2, 10, 0);
v.prop('bench', 2, 6, 180);
v.prop('string_lights', 0, -10, 0);
v.prop('lamp_post', -12, -20, 0);
v.prop('lamp_post', 12, 20, 0);
v.prop('lamp_post', -10, 30, 0);
v.prop('crate', 10, -5, 15);
v.prop('crate_small', 11, -3, 40);
v.prop('barrel_stack', -12, 5, 0);
v.prop('flagpole', 0, -25, 0);
v.prop('sandbags', -4, -44, 0);
v.prop('sandbags', 5, -44, 0);
v.prop('watchtower', -35, -35, 45);
v.prop('fence_wood', -40, -10, 90);
v.prop('fence_wood', -40, -6, 90);
v.prop('hammock', 30, 30, 90);
v.prop('sign_post', 2, -48, 180);
v.prop('dock', 50, 60, 0, { y: 0 });
v.prop('dock', 50, 70, 0, { y: 0 });
v.prop('dock_end', 50, 77.5, 0, { y: 0 });
v.prop('boat_fishing', 56, 66, 10, { y: 0 });
v.prop('boat_fishing', -45, 66, -20, { y: 0 });
v.prop('canoe', -15, 64, 80, { y: 0 });
add({ id: 'boat_village', type: 'vehicle', vehicle: 'boat', pos: [vc[0] + 44, 0, vc[1] + 72], rot: [0, 0, 0] });
v.ent('alarm', 3, -24, { id: 'alarm_village', outpost: 'outpost_village', yaw: 180 });
marker('mk_village', ...vc, 'Puerto Viejo', { icon: 'village' });
marker('mk_village_edge', -228, 588, null);
marker('mk_village_rf', -150, 520, null);
v.path('path_village', [[-15, -15], [15, -15], [15, 20], [-15, 20]], { wait: 4 });
v.enemy('merc_rifle', -10, -12, 'village_mercs', { patrol: 'path_village' });
v.enemy('merc_smg', 14, 2, 'village_mercs', { pose: 'talk', yaw: -90 });
v.enemy('merc_rifle', -18, 6, 'village_mercs', { pose: 'sit', yaw: 90 });
v.enemy('merc_shotgun', 6, -27, 'village_mercs', { yaw: 180 });
v.enemy('merc_sniper', -35, -35, 'village_mercs', { dy: 5.7, yaw: 200 });
v.enemy('merc_rifle', 2, -40, 'village_mercs', { yaw: 180 });
add({ id: 'outpost_village', type: 'outpost', name: 'Puerto Viejo', pos: [vc[0], H(...vc), vc[1]], radius: 55, group: 'village_mercs', alarm: 'alarm_village', reinforcements: [{ archetype: 'merc_rifle', count: 2 }, { archetype: 'merc_smg', count: 1 }], reinforceFrom: 'mk_village_rf', fastTravel: true, reward: ['ammo_rifle'] });
const mx = mara.pos[0], mz = mara.pos[2];
add({ id: 'npc_mara', type: 'npc', name: 'Mara', archetype: 'villager', team: 'ally', calm: true, pose: 'sit', dialogue: 'mara_meet', pos: [mx, mara.pos[1] + 1.9, mz + 1], rot: [0, 180, 0] });
add({ id: 'npc_abuelo', type: 'npc', name: 'Abuelo Tomás', archetype: 'villager', team: 'civilian', calm: true, pose: 'sit', dialogue: 'abuelo_relics', group: 'village_civ', dormant: true, ...(() => { const [x, z] = v.w(-1, 9); return { pos: [x, H(x, z), z] }; })(), rot: [0, 180, 0] });
for (const [lx, lz, pose] of [[-8, 0, 'talk'], [9, 14, 'stand'], [-20, 30, 'work']]) { const [x, z] = v.w(lx, lz); add({ type: 'npc', name: 'Villageois', archetype: 'villager', team: 'civilian', group: 'village_civ', dormant: true, pose, pos: [x, H(x, z), z], rot: [0, Math.round(Math.random() * 360), 0] }); }
pickup('intel', ...v.w(24, 14), { id: 'intel_village', y: H(...v.w(24, 14)) + 0.9 });
pickup('medkit', ...v.w(-25, -14));
zone('zone_village', ...vc, 70);

// 4. River outpost (on the road north)
const rc = [10, 50];
const r = site(...rc, -30);
r.prop('watchtower', -18, -12, 30);
r.prop('tent', 14, -14, 0);
r.prop('tent', 20, 4, -90);
r.prop('tarp', -4, 14, 0);
r.prop('sandbags', -10, 26, 0);
r.prop('sandbags', 8, 27, 10);
r.prop('sandbags_round', 22, 20, 180);
r.prop('crate_stack', 6, 12, 20);
r.prop('ammo_box', 4, 10, 0);
r.prop('barrel_stack', -14, 6, 0);
r.prop('generator', 14, -24, 0);
r.prop('fuel_tank', 6, -26, 0);
r.prop('flagpole', 0, 0, 0);
r.prop('radio_table', -6, 15, 180);
r.prop('fence_wire', -25, -20, 90);
r.prop('fence_wire', -25, -16, 90);
r.prop('fence_wire', 28, -18, 90);
r.prop('sign_post', -14, 34, 160);
for (const [lx, lz] of [[18, -22], [11, -21], [20, -28]]) r.ent('explosive', lx, lz, { asset: 'barrel_explosive', health: 30, radius: 6, damage: 180 });
r.ent('alarm', -2, -8, { id: 'alarm_river', outpost: 'outpost_river', yaw: 90 });
add({ id: 'jeep_river', type: 'vehicle', vehicle: 'jeep', ...(() => { const [x, z] = r.w(-12, 18); return { pos: [x, H(x, z), z] }; })(), rot: [0, 40, 0] });
r.path('path_river', [[-20, -20], [22, -20], [24, 22], [-20, 22]]);
r.enemy('merc_rifle', -18, -16, 'river_mercs', { patrol: 'path_river' });
r.enemy('merc_rifle', 3, 18, 'river_mercs', { yaw: 0 });
r.enemy('merc_smg', 15, 6, 'river_mercs', { pose: 'talk', yaw: -100 });
r.enemy('merc_shotgun', 18, 0, 'river_mercs', { pose: 'talk', yaw: 80 });
r.enemy('merc_sniper', -18, -12, 'river_mercs', { dy: 5.7, yaw: 180 });
r.enemy('merc_heavy', -2, -4, 'river_mercs', { yaw: 160 });
r.enemy('merc_rifle', 10, -18, 'river_mercs', { pose: 'sit', yaw: 0 });
marker('mk_river', ...rc, 'Avant-poste du Fleuve', { icon: 'camp' });
marker('mk_river_rf', 80, 150, null);
add({ id: 'outpost_river', type: 'outpost', name: 'Avant-poste du Fleuve', pos: [rc[0], H(...rc), rc[1]], radius: 45, group: 'river_mercs', alarm: 'alarm_river', reinforcements: [{ archetype: 'merc_rifle', count: 2 }, { archetype: 'merc_smg', count: 2 }], reinforceFrom: 'mk_river_rf', fastTravel: true, reward: ['grenades'] });
pickup('weapon_shotgun', ...r.w(4, 11), { y: H(...r.w(4, 11)) + 0.4 });
pickup('ammo_shells', ...r.w(6, 9));
pickup('intel', ...r.w(-6, 15), { id: 'intel_river', y: H(...r.w(-6, 15)) + 0.85 });
pickup('grenades', ...r.w(20, 6));
// a bridge where the antenna road crosses the river
{
  const road = readJSON('terrain/layout.json').roads.find((x) => x.name === 'Ruta Antena').points;
  const riv = T.rivers[0].points;
  let best = null;
  for (let k = 0; k < road.length - 1; k++) for (let s = 0; s <= 40; s++) {
    const x = road[k][0] + (road[k + 1][0] - road[k][0]) * s / 40, z = road[k][1] + (road[k + 1][1] - road[k][1]) * s / 40;
    for (const p of riv) { const d = Math.hypot(p[0] - x, p[1] - z); if (!best || d < best.d) best = { d, x, z, dx: road[k + 1][0] - road[k][0], dz: road[k + 1][1] - road[k][1] }; }
  }
  if (best && best.d < 12) add({ type: 'prop', asset: 'bridge_road', pos: [best.x, H(best.x, best.z) - 0.25, best.z], rot: [0, along(best.dx, best.dz), 0], scale: 1, collide: true });
}

// 5. Cerro Antena — radio tower with the jammer
const ac = [-470, -90];
const an = site(...ac, 0);
an.prop('radio_tower', 0, -2, 0);
an.prop('shack_tin', 11, 8, face(11, 8, 0, 0));
an.prop('antenna_small', -9, 7, 0);
an.prop('sandbags', -6, 14, 0);
an.prop('crate', 6, -9, 10);
an.prop('barrel', 8, -10, 0);
an.ent('destructible', -8, -6, { id: 'jammer', asset: 'generator', health: 160, explode: true, yaw: 30 });
an.prop('satellite_dish', -11, -8, 120);
an.ent('interactable', 11, 8, { id: 'radio_antenna', asset: 'radio_table', prompt: 'Émettre sur la fréquence de Mara', once: true, range: 2.6, yaw: face(11, 8, 0, 0) });
an.enemy('merc_rifle', -4, 10, 'antenna_mercs', { yaw: 180 });
an.enemy('merc_rifle', 9, -4, 'antenna_mercs', { yaw: 90 });
an.enemy('merc_smg', 4, 12, 'antenna_mercs', { pose: 'talk' });
an.enemy('merc_sniper', 24, 22, 'antenna_mercs', { yaw: 135 });
add({ id: 'outpost_antenna', type: 'outpost', name: 'Cerro Antena', pos: [ac[0], H(...ac), ac[1]], radius: 38, group: 'antenna_mercs', fastTravel: true, reinforcements: [] });
marker('mk_antenna', ...ac, 'Cerro Antena', { icon: 'tower' });

// 6. La Granja — farm (side outpost)
const fc = [-330, 160];
const f = site(...fc, 10);
f.prop('house_wood', -14, -8, 90);
f.prop('water_tower', 14, -14, 0);
f.prop('log_pile', -4, -18, 0);
f.prop('wooden_cart', 8, 6, 60);
f.prop('tire_stack', 12, 10, 0);
f.prop('barrel_stack', 16, -2, 0);
f.prop('tarp', 4, -10, 0);
for (let i = 0; i < 7; i++) f.prop('fence_wood', -20 + i * 4, 22, 0);
for (let i = 0; i < 5; i++) f.prop('fence_wood', 26, 20 - i * 4 - 2, 90);
f.ent('alarm', 6, -16, { id: 'alarm_farm', outpost: 'outpost_farm', yaw: 0 });
add({ id: 'jeep_farm', type: 'vehicle', vehicle: 'jeep', ...(() => { const [x, z] = f.w(-2, 12); return { pos: [x, H(x, z), z] }; })(), rot: [0, 100, 0] });
f.enemy('merc_rifle', -6, 2, 'farm_mercs', { pose: 'talk', yaw: 90 });
f.enemy('merc_smg', -2, 3, 'farm_mercs', { pose: 'talk', yaw: -90 });
f.enemy('merc_rifle', 14, -10, 'farm_mercs', { yaw: 0 });
f.enemy('merc_shotgun', -14, 6, 'farm_mercs', { yaw: 200 });
f.path('path_farm', [[-24, -24], [24, -24], [24, 24], [-24, 24]]);
f.enemy('merc_rifle', -24, -20, 'farm_mercs', { patrol: 'path_farm' });
add({ id: 'outpost_farm', type: 'outpost', name: 'La Granja', pos: [fc[0], H(...fc), fc[1]], radius: 45, group: 'farm_mercs', alarm: 'alarm_farm', reinforcements: [{ archetype: 'merc_rifle', count: 2 }], fastTravel: true, reward: ['medkit'] });
add({ id: 'npc_pedro', type: 'npc', name: 'Pedro', archetype: 'villager', team: 'civilian', calm: true, pose: 'work', dialogue: 'pedro_thanks', group: 'farm_civ', dormant: true, ...(() => { const [x, z] = f.w(-8, -10); return { pos: [x, H(x, z), z] }; })(), rot: [0, 0, 0] });
pickup('intel', ...f.w(-14, -6), { id: 'intel_farm', y: H(...f.w(-14, -6)) + 0.9 });
marker('mk_farm', ...fc, 'La Granja', { icon: 'village' });

// 7. The laboratory (north-west coast)
const lc = [-430, -470];
const l = site(...lc, 0);
l.prop('lab_building', 0, 0, 180);
l.prop('warehouse', 35, -15, -90);
l.prop('helipad', -38, -18, 0);
l.prop('container', 28, 22, 10);
l.prop('container', 33, 26, 80);
l.prop('container', 24, 28, 0);
l.prop('guard_tower', -45, 25, 0);
l.prop('guard_tower', 45, -35, 180);
l.prop('satellite_dish', -14, -6, 200);
l.prop('generator', 20, 2, 90);
l.prop('fuel_tank', 22, 8, 90);
l.prop('lamp_post', -10, 22, 0);
l.prop('lamp_post', 10, 22, 0);
l.prop('lamp_post', -30, 0, 0);
l.prop('sandbags', -6, 40, 0);
l.prop('sandbags', 6, 40, 0);
l.prop('crate_stack', 40, -5, 90, {});
for (let i = 0; i < 9; i++) { l.prop('fence_wire', -54 + i * 4, 44, 0); l.prop('fence_wire', 22 + i * 4, 44, 0); }
for (let i = 0; i < 18; i++) { l.prop('fence_wire', -56, 42 - i * 4 - 2, 90); l.prop('fence_wire', 56, 42 - i * 4 - 2, 90); }
l.prop('dock', 0, -60, 0, { y: 0 });
l.prop('dock', 0, -70, 0, { y: 0 });
l.prop('dock_end', 0, -77.5, 0, { y: 0 });
add({ id: 'boat_lab', type: 'vehicle', vehicle: 'boat', pos: [lc[0] + 6, 0, lc[1] - 72], rot: [0, 0, 0] });
marker('mk_lab_boat', lc[0], lc[1] - 58, null, { dy: 0 });
marker('mk_lab_approach', lc[0], lc[1] + 70, null);
marker('mk_lab_rf', lc[0] + 60, lc[1] + 50, null);
l.ent('alarm', -18, 12, { id: 'alarm_lab', outpost: 'outpost_lab', yaw: 180 });
l.ent('interactable', 6, 10.5, { id: 'lab_door', asset: 'radio_table', prompt: 'Ouvrir la porte du laboratoire', requires: 'key_card', once: true, range: 2.6, yaw: 180 });
pickup('key_card', ...l.w(36, -12), { id: 'pk_keycard', y: H(...l.w(36, -12)) + 0.9 });
l.prop('table', 36, -12, 0);
add({ id: 'npc_val', type: 'npc', name: 'Valérie', archetype: 'scientist', team: 'ally', calm: true, pose: 'sit', dialogue: 'val_found', group: 'val', ...(() => { const [x, z] = l.w(0, -4); return { pos: [x, H(x, z) + 0.2, z] }; })(), rot: [0, 180, 0] });
l.path('path_lab_a', [[-30, 35], [30, 35], [30, -30], [-30, -30]]);
l.path('path_lab_b', [[-48, 30], [-48, -40], [0, -48], [48, -40], [48, 30]], { loop: false });
l.enemy('merc_rifle', -30, 35, 'lab_guards', { patrol: 'path_lab_a' });
l.enemy('merc_rifle', 30, -30, 'lab_guards', { patrol: 'path_lab_a' });
l.enemy('merc_smg', -48, 20, 'lab_guards', { patrol: 'path_lab_b' });
l.enemy('merc_shotgun', 4, 14, 'lab_guards', { yaw: 180 });
l.enemy('merc_heavy', -4, 14, 'lab_guards', { yaw: 180 });
l.enemy('merc_sniper', -45, 25, 'lab_guards', { dy: 8.3, yaw: 180 });
l.enemy('merc_sniper', 45, -35, 'lab_guards', { dy: 8.3, yaw: 90 });
l.enemy('merc_rifle', 34, -6, 'lab_guards', { pose: 'talk', yaw: -90 });
l.enemy('merc_smg', 31, -8, 'lab_guards', { pose: 'talk', yaw: 90 });
l.enemy('merc_rifle', -36, -12, 'lab_guards', { yaw: 0 });
add({ id: 'outpost_lab', type: 'outpost', name: 'Laboratoire', pos: [lc[0], H(...lc), lc[1]], radius: 60, group: 'lab_guards', alarm: 'alarm_lab', reinforcements: [{ archetype: 'merc_rifle', count: 3 }, { archetype: 'merc_heavy', count: 1 }], reinforceFrom: 'mk_lab_rf', fastTravel: true });
pickup('intel', ...l.w(-6, 2), { id: 'intel_lab', y: H(...l.w(-6, 2)) + 0.9 });
pickup('medkit', ...l.w(10, 2), { y: H(...l.w(10, 2)) + 0.3 });
pickup('weapon_sniper', ...l.w(38, -14), { y: H(...l.w(38, -14)) + 0.3 });
marker('mk_lab', ...lc, 'Laboratoire', { icon: 'objective' });
zone('zone_lab', ...lc, 110);

// 8. Airfield + hangar
const hc = [300, 250];
const h = site(...hc, 0);
h.prop('hangar', 0, 6, 180);
h.prop('watchtower', -32, -16, 20);
h.prop('container', 22, 18, 90);
h.prop('container', 26, 12, 0);
h.prop('crate_stack', -18, 12, 0);
h.prop('truck_body', -14, -6, 70);
h.prop('sandbags_round', 10, -18, 0);
h.prop('gas_pump', 18, -8, 0);
h.prop('lamp_post', -24, -6, 0);
h.prop('lamp_post', 24, -6, 0);
h.prop('oil_drum_rack', 30, -4, 90);
for (let i = 0; i < 3; i++) h.ent('destructible', 18 + i * 5, -12, { id: `fuel_${i + 1}`, asset: 'fuel_tank', health: 120, explode: true, yaw: 90 });
h.ent('alarm', -6, -10, { id: 'alarm_airfield', outpost: 'outpost_airfield', yaw: 180 });
h.path('path_air', [[-140, -30], [160, -48]], { loop: false, wait: 6 });
h.enemy('merc_rifle', -60, -32, 'airfield_mercs', { patrol: 'path_air' });
h.enemy('merc_rifle', 4, -6, 'airfield_mercs', { pose: 'talk', yaw: 90 });
h.enemy('merc_smg', 7, -6, 'airfield_mercs', { pose: 'talk', yaw: -90 });
h.enemy('merc_rocket', 10, -18, 'airfield_mercs', { yaw: 180 });
h.enemy('merc_sniper', -32, -16, 'airfield_mercs', { dy: 5.7, yaw: 180 });
h.enemy('merc_heavy', 22, 2, 'airfield_mercs', { yaw: 200 });
h.enemy('merc_rifle', -10, 20, 'airfield_mercs', { pose: 'work', yaw: 0 });
add({ id: 'outpost_airfield', type: 'outpost', name: 'Aérodrome', pos: [hc[0], H(...hc), hc[1]], radius: 60, group: 'airfield_mercs', alarm: 'alarm_airfield', reinforcements: [{ archetype: 'merc_rifle', count: 2 }, { archetype: 'merc_rocket', count: 1 }], fastTravel: true, reward: ['ammo_rocket'] });
pickup('intel', ...h.w(-18, 14), { id: 'intel_airfield', y: H(...h.w(-18, 14)) + 2.1 });
pickup('weapon_rifle_m4', ...h.w(-4, 14));
marker('mk_airfield', ...hc, 'Aérodrome', { icon: 'camp' });

// 9. La Fortaleza (plateau, east) — final assault
const fo = [520, -40];
const F = site(...fo, 0);
const HALF = 25;
for (const x of [-20, -10, 0, 10, 20]) F.prop('fort_wall', x, -HALF, 0);
for (const z of [-20, -10, 0, 10, 20]) { F.prop('fort_wall', HALF, z, -90); F.prop('fort_wall', -HALF, z, 90); }
for (const x of [-20, -11, 11, 20]) F.prop('fort_wall', x, HALF, 180);
F.prop('fort_gate', 0, HALF, 180);
for (const [x, z] of [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]) F.prop('fort_tower', x, z, face(x, z, 0, 0) + 180);
F.prop('bunker', 0, -12, 180);
F.prop('guard_tower', 14, 8, 0);
F.prop('tent', -14, 4, 90);
F.prop('tent', -14, 14, 90);
F.prop('helipad', 12, -10, 0);
F.prop('flagpole', 0, 4, 0);
F.prop('crate_stack', -8, 18, 0);
F.prop('sandbags_round', 0, 18, 0);
F.prop('generator', 18, 18, 0);
F.prop('container', -18, -14, 0);
F.prop('lamp_post', -6, 10, 0);
F.prop('lamp_post', 6, 10, 0);
F.ent('interactable', 3, -16, { id: 'radio_fort', asset: 'radio_table', prompt: 'Appeler les secours', once: true, range: 2.6, yaw: 180 });
F.ent('alarm', 6, 20, { id: 'alarm_fort', outpost: 'outpost_fort', yaw: 0 });
for (const [lx, lz] of [[16, 16], [18, 13], [-16, -10]]) F.ent('explosive', lx, lz, { asset: 'barrel_explosive', health: 30, radius: 6, damage: 180 });
const fy = H(...fo);
F.enemy('merc_rifle', -6, 14, 'fort_mercs', { yaw: 180 });
F.enemy('merc_rifle', 8, 14, 'fort_mercs', { yaw: 180 });
F.enemy('merc_heavy', 0, 8, 'fort_mercs', { yaw: 180 });
F.enemy('merc_heavy', -10, -4, 'fort_mercs', { yaw: 160 });
F.enemy('merc_shotgun', 4, -6, 'fort_mercs', { yaw: 180 });
F.enemy('merc_rocket', -12, 20, 'fort_mercs', { yaw: 180 });
F.enemy('merc_sniper', -HALF, HALF, 'fort_mercs', { y: fy + 6.1, yaw: 160 });
F.enemy('merc_sniper', HALF, HALF, 'fort_mercs', { y: fy + 6.1, yaw: 200 });
F.enemy('merc_sniper', 14, 8, 'fort_mercs', { y: fy + 8.3, yaw: 180 });
F.enemy('merc_smg', -4, HALF + 8, 'fort_mercs', { yaw: 180 });
F.enemy('merc_smg', 5, HALF + 8, 'fort_mercs', { yaw: 180 });
F.enemy('merc_rifle', 12, -4, 'fort_mercs', { pose: 'talk' });
F.enemy('boss_vargas', 0, -6, 'fort_boss', { id: 'boss_vargas', yaw: 180 });
add({ id: 'outpost_fort', type: 'outpost', name: 'La Fortaleza', pos: [fo[0], fy, fo[1]], radius: 50, group: 'fort_mercs', alarm: 'alarm_fort', reinforcements: [{ archetype: 'merc_rifle', count: 3 }, { archetype: 'merc_heavy', count: 1 }], fastTravel: false });
marker('mk_fort', ...fo, 'La Fortaleza', { icon: 'objective' });
marker('mk_fort_gate', ...F.w(0, HALF + 14), null);
marker('mk_helipad', ...F.w(12, -10), null);
pickup('armor', ...F.w(-8, 18), { y: fy + 2.1 });
pickup('ammo_rifle', ...F.w(-6, 18), { y: fy + 2.1 });
// approach: a checkpoint on the climb
const fa = site(500, 10, 0);
fa.prop('sandbags', 0, 0, 0);
fa.prop('watchtower', 10, 6, 0);
fa.enemy('merc_rifle', -2, -2, 'fort_approach', { yaw: 180 });
fa.enemy('merc_rifle', 3, -1, 'fort_approach', { yaw: 180 });
fa.enemy('merc_sniper', 10, 6, 'fort_approach', { dy: 5.7, yaw: 180 });

// 10. Lighthouse islet (east)
const lh = [800, 350];
const L = site(...lh, 0);
L.prop('lighthouse', 0, 0, 200);
L.prop('shack_tin', -10, 8, 70);
L.prop('crate', 7, 6, 0);
L.prop('barrel', 8, 4, 0);
L.prop('sandbags', -4, 14, 0);
L.enemy('merc_rifle', -6, 10, 'lighthouse_mercs', { yaw: 200 });
L.enemy('merc_smg', 6, 8, 'lighthouse_mercs', { pose: 'talk' });
L.enemy('merc_sniper', 12, -6, 'lighthouse_mercs', { yaw: 250 });
add({ id: 'outpost_lighthouse', type: 'outpost', name: 'Le Phare', pos: [lh[0], H(...lh), lh[1]], radius: 30, group: 'lighthouse_mercs', fastTravel: true, reward: ['armor'] });
marker('mk_lighthouse', ...lh, 'Le Phare', { icon: 'tower' });

// 11. Temple of Sombra (jungle ruins, smugglers)
const tc = [-250, -390];
const t = site(...tc, 0);
t.prop('temple', 0, -2, 180);
t.prop('ruin_arch', 0, 26, 0);
t.prop('ruin_pillar', -14, 18, 0);
t.prop('ruin_pillar', 14, 18, 20);
t.prop('ruin_wall', -20, 4, 90);
t.prop('ruin_wall', 21, -6, -80);
t.prop('ruin_pillar', -18, -18, 0);
t.prop('tent', 18, 16, -120);
t.prop('campfire', 10, 20, 0);
t.prop('crate_stack', 22, 8, 90);
t.enemy('merc_rifle', 8, 22, 'temple_mercs', { pose: 'sit', yaw: 60 });
t.enemy('merc_smg', 12, 23, 'temple_mercs', { pose: 'talk', yaw: -60 });
t.enemy('merc_shotgun', -10, 20, 'temple_mercs', { yaw: 180 });
t.enemy('merc_rifle', 0, -4, 'temple_mercs', { y: H(...tc) + 9.2, yaw: 180 });
add({ id: 'outpost_temple', type: 'outpost', name: 'Temple de Sombra', pos: [tc[0], H(...tc), tc[1]], radius: 38, group: 'temple_mercs', fastTravel: true, reward: ['grenades'] });
marker('mk_temple', ...tc, 'Temple de Sombra', { icon: 'cave' });

// 12. Camp de la Loma (east jungle, smugglers)
const kc = [400, 350];
const k = site(...kc, 25);
k.prop('tent', -8, -6, 30);
k.prop('tent', 8, -8, -30);
k.prop('tarp', 0, 6, 0);
k.prop('campfire', 0, -1, 0);
k.prop('container', 14, 8, 100);
k.prop('crate_stack', -12, 8, 0);
k.prop('hammock', -14, -12, 90);
k.enemy('merc_rifle', -3, 1, 'loma_mercs', { pose: 'talk', yaw: 90 });
k.enemy('merc_rifle', 3, 0, 'loma_mercs', { pose: 'talk', yaw: -90 });
k.enemy('merc_rocket', 10, 4, 'loma_mercs', { yaw: 0 });
k.enemy('merc_smg', -10, -14, 'loma_mercs', { pose: 'sit', yaw: 180 });
add({ id: 'outpost_loma', type: 'outpost', name: 'Camp de la Loma', pos: [kc[0], H(...kc), kc[1]], radius: 32, group: 'loma_mercs', fastTravel: true, reward: ['ammo_rocket'] });
pickup('weapon_rpg', ...k.w(1, 7), { y: H(...k.w(1, 7)) + 0.4 });
pickup('intel', ...k.w(14, 4), { id: 'intel_loma', y: H(...k.w(14, 4)) + 2.7 });
marker('mk_loma', ...kc, 'Camp de la Loma', { icon: 'camp' });

// 13. Road patrols + junction signs
const rp1 = add({ id: 'path_road_1', type: 'path', pos: [-160, H(-160, 470), 470], points: [[-160, 470], [-140, 330], [-80, 200], [-20, 110]].map(([x, z]) => [x, H(x, z), z]), loop: false, wait: 5 });
add({ type: 'enemy', archetype: 'merc_rifle', group: 'road_patrol_1', team: 'merc', patrol: rp1.id, pos: [-140, H(-140, 330), 330], rot: [0, 0, 0] });
add({ type: 'enemy', archetype: 'merc_smg', group: 'road_patrol_1', team: 'merc', patrol: rp1.id, pos: [-142, H(-142, 334), 334], rot: [0, 0, 0] });
const rp2 = add({ id: 'path_road_2', type: 'path', pos: [-120, H(-120, -20), -20], points: [[-120, -20], [-300, -60], [-420, -100]].map(([x, z]) => [x, H(x, z), z]), loop: false, wait: 5 });
add({ type: 'enemy', archetype: 'merc_rifle', group: 'road_patrol_2', team: 'merc', patrol: rp2.id, pos: [-300, H(-300, -60), -60], rot: [0, 0, 0] });
add({ type: 'enemy', archetype: 'merc_shotgun', group: 'road_patrol_2', team: 'merc', patrol: rp2.id, pos: [-303, H(-303, -58), -58], rot: [0, 0, 0] });
for (const [x, z, yaw] of [[-20, 110, 30], [150, 225, 100], [-300, -60, 60], [-420, -100, 200], [-330, 160, 0]]) add({ type: 'prop', asset: 'sign_post', pos: [x + 5, H(x + 5, z + 4), z + 4], rot: [0, yaw, 0], scale: 1 });

// 14. Collectibles: 8 golden relics + extra intel
const relics = [
  [tc[0], tc[1] - 4, H(...tc) + 9.1], [300, -330, null], [-770, -560, null], [330, 760, null],
  [806, 343, null], [-600, 150, null], [-462, -100, null], [128, -214, null],
];
relics.forEach(([x, z, y], i) => pickup('relic', x, z, { id: `relic_${i + 1}`, y: y ?? H(x, z) }));
marker('mk_volcano', 260, -330, 'El Cono', { icon: 'cave' });
zone('zone_crater', 260, -330, 70);
marker('mk_islet', -770, -560, 'Islote Norte');
marker('mk_cayo', 330, 760, 'Cayo Sur');
// a few supply caches along the way
for (const [x, z, it] of [[-260, 420, 'medkit'], [-60, 230, 'ammo_rifle'], [120, 120, 'grenades'], [-380, -250, 'ammo_rifle'], [200, -150, 'medkit'], [450, 120, 'armor'], [-520, -300, 'ammo_sniper'], [60, 400, 'ammo_shells']]) pickup(it, x, z);
// ambient sound emitters
add({ type: 'sound', sound: 'radio_static', volume: 0.35, radius: 25, pos: [...v.w(24, 12).slice(0, 1), H(...v.w(24, 12)) + 1, v.w(24, 12)[1]] });
add({ type: 'sound', sound: 'radio_static', volume: 0.3, radius: 25, pos: [r.w(-6, 15)[0], H(...r.w(-6, 15)) + 1, r.w(-6, 15)[1]] });

for (const e of ents) clean(e);
// ============================================================================================
// World file
const world = { version: 1, name: 'Isla Sombra', player: { pos: startPos, yaw: Math.atan2(-(-523 - startPos[0]), -(513 - startPos[2])) }, entities: ents };
writeJSON('world.json', world);

// ============================================================================================
// Missions
const M = {
  start: 'm01',
  variables: {},
  missions: [
    {
      id: 'm01', title: 'Échoué', type: 'main',
      description: 'Le Marlin a été coulé par des mercenaires. Valérie a disparu. Survivre, trouver de l\'aide.',
      onStart: [
        { do: 'setTime', hour: 6.4 },
        { do: 'cinematic', from: [-470, 30, 470], to: [-500, 6, 530], lookAt: 'mk_wreck', duration: 6, text: 'Isla Sombra — quelque part dans le Pacifique Sud' },
        { do: 'dialogue', id: 'm01_wake' },
      ],
      objectives: [
        { id: 'wreck', type: 'goto', text: 'Fouiller l\'épave du Marlin', target: 'mk_wreck', radius: 9 },
        { id: 'machete', type: 'pickup', text: 'Ramasser la machette', target: 'pk_machete' },
        { id: 'radio', type: 'interact', text: 'Allumer la radio de bord', target: 'radio_wreck', onComplete: [{ do: 'dialogue', id: 'm01_mara', wait: true }] },
        { id: 'camp', type: 'goto', text: 'Longer la plage vers l\'est', target: 'mk_beach_camp', radius: 35, onStart: [{ do: 'hint', text: 'Accroupi (Ctrl), dans les buissons, vous êtes presque invisible. Une attaque à la machette par derrière tue sans bruit.', duration: 8 }] },
        { id: 'pirates', type: 'kill', text: 'Neutraliser les mercenaires du campement', group: 'beach_patrol', onComplete: [{ do: 'dialogue', id: 'm01_after' }] },
        { id: 'village', type: 'goto', text: 'Rejoindre Puerto Viejo', target: 'mk_village_edge', radius: 25 },
      ],
      onComplete: [{ do: 'startMission', id: 'm02' }],
    },
    {
      id: 'm02', title: 'Puerto Viejo', type: 'main',
      description: 'Le village de pêcheurs est tenu par les hommes de Vargas.',
      onStart: [{ do: 'dialogue', id: 'm02_intro' }],
      objectives: [
        { id: 'free', type: 'liberate', text: 'Libérer Puerto Viejo', target: 'outpost_village', onStart: [{ do: 'hint', text: 'Sabotez l\'alarme (E) avant d\'ouvrir le feu, sinon des renforts arriveront.', duration: 7 }] },
        { id: 'mara', type: 'interact', text: 'Retrouver Mara (maison sur pilotis)', target: 'npc_mara' },
      ],
      onComplete: [
        { do: 'giveItem', item: 'binoculars' },
        { do: 'giveWeapon', weapon: 'rifle_ak', ammo: { rifle: 60 } },
        { do: 'startMission', id: 'm03' },
        { do: 'startMission', id: 's01' },
      ],
    },
    {
      id: 'm03', title: 'Ondes courtes', type: 'main',
      description: 'Un brouilleur sur le Cerro Antena coupe toutes les communications de l\'île.',
      onStart: [{ do: 'dialogue', id: 'm03_intro' }],
      objectives: [
        { id: 'reach', type: 'goto', text: 'Monter au Cerro Antena', target: 'mk_antenna', radius: 50 },
        { id: 'jammer', type: 'destroy', text: 'Détruire le brouilleur', target: 'jammer' },
        { id: 'call', type: 'interact', text: 'Émettre depuis la radio de l\'antenne', target: 'radio_antenna', onComplete: [{ do: 'dialogue', id: 'm03_vargas', wait: true }] },
      ],
      onComplete: [{ do: 'startMission', id: 'm04' }, { do: 'startMission', id: 's02' }],
    },
    {
      id: 'm04', title: 'Le fleuve', type: 'main',
      description: 'La route du nord passe par l\'avant-poste du fleuve.',
      onStart: [{ do: 'dialogue', id: 'm04_intro' }],
      objectives: [
        { id: 'river', type: 'liberate', text: 'Libérer l\'avant-poste du fleuve', target: 'outpost_river' },
      ],
      onComplete: [{ do: 'dialogue', id: 'm04_done' }, { do: 'hint', text: 'Une jeep est garée à l\'avant-poste (E pour conduire).', duration: 6 }, { do: 'startMission', id: 'm05' }],
    },
    {
      id: 'm05', title: 'Le laboratoire', type: 'main',
      description: 'Valérie est retenue au laboratoire de la côte nord.',
      onStart: [{ do: 'dialogue', id: 'm05_intro' }],
      failIf: [{ actorDead: 'npc_val', reason: 'Valérie est morte' }],
      objectives: [
        { id: 'approach', type: 'goto', text: 'Approcher du laboratoire', target: 'mk_lab_approach', radius: 18, onComplete: [{ do: 'setTime', hour: 22 }, { do: 'dialogue', id: 'm05_night' }, { do: 'checkpoint' }] },
        { id: 'card', type: 'pickup', text: 'Voler la carte d\'accès dans l\'entrepôt', target: 'pk_keycard' },
        { id: 'door', type: 'interact', text: 'Ouvrir la porte du laboratoire', target: 'lab_door' },
        { id: 'val', type: 'interact', text: 'Libérer Valérie', target: 'npc_val' },
        {
          id: 'escort', type: 'escort', text: 'Escorter Valérie jusqu\'au ponton', actor: 'npc_val', target: 'mk_lab_boat', radius: 7,
          onStart: [{ do: 'follow', actor: 'npc_val' }, { do: 'alertGroup', group: 'lab_guards' }, { do: 'spawn', archetype: 'merc_rifle', at: 'mk_lab_rf', count: 3, group: 'lab_guards', behavior: 'attack' }],
        },
      ],
      onComplete: [{ do: 'stopFollow', actor: 'npc_val' }, { do: 'dialogue', id: 'm05_done', wait: true }, { do: 'removeGroup', group: 'val' }, { do: 'setTime', hour: 7 }, { do: 'startMission', id: 'm06' }],
    },
    {
      id: 'm06', title: 'Ailes coupées', type: 'main',
      description: 'Vargas veut évacuer sa cargaison par avion. Privons-le de carburant.',
      onStart: [{ do: 'dialogue', id: 'm06_intro' }],
      objectives: [
        { id: 'fuel', type: 'condition', text: 'Faire sauter les 3 cuves de carburant de l\'aérodrome', marker: 'fuel_2', condition: { all: [{ destroyed: 'fuel_1' }, { destroyed: 'fuel_2' }, { destroyed: 'fuel_3' }] } },
      ],
      onComplete: [{ do: 'dialogue', id: 'm06_done' }, { do: 'startMission', id: 'm07' }],
    },
    {
      id: 'm07', title: 'La Fortaleza', type: 'main',
      description: 'Il est temps d\'en finir avec le colonel Vargas.',
      onStart: [{ do: 'dialogue', id: 'm07_intro' }, { do: 'setTime', hour: 17.2 }],
      objectives: [
        { id: 'gate', type: 'goto', text: 'Atteindre la porte de la Fortaleza', target: 'mk_fort_gate', radius: 18, onComplete: [{ do: 'checkpoint' }] },
        { id: 'boss', type: 'kill', text: 'Éliminer le colonel Vargas', actor: 'boss_vargas', marker: 'boss_vargas', onStart: [{ do: 'dialogue', id: 'm07_vargas' }] },
        { id: 'radio', type: 'interact', text: 'Appeler les secours depuis la radio du fort', target: 'radio_fort', onComplete: [{ do: 'dialogue', id: 'm07_call', wait: true }] },
        { id: 'heli', type: 'goto', text: 'Rejoindre l\'héliport', target: 'mk_helipad', radius: 8 },
      ],
      onComplete: [
        { do: 'cinematic', from: [560, 110, 20], to: [470, 90, -110], lookAt: 'mk_fort', duration: 7, text: 'Isla Sombra est libre.' },
        { do: 'dialogue', id: 'm07_end', wait: true },
        { do: 'endGame', title: 'Isla Sombra est libre', text: 'Vargas est tombé. Mara et les villageois reprennent leur île — et Valérie tient son article.' },
      ],
    },
    {
      id: 's01', title: 'Les reliques de Sombra', type: 'side',
      description: 'Le vieux Tomás cherche les huit idoles dorées de ses ancêtres.',
      onStart: [{ do: 'hint', text: 'Mission secondaire : parlez à Abuelo Tomás à Puerto Viejo.', duration: 6 }],
      objectives: [
        { id: 'talk', type: 'interact', text: 'Parler à Abuelo Tomás', target: 'npc_abuelo' },
        { id: 'relics', type: 'collect', text: 'Trouver les reliques dorées', item: 'relic', count: 8, absolute: true, noMarker: true },
        { id: 'back', type: 'interact', text: 'Rapporter les reliques à Tomás', target: 'npc_abuelo' },
      ],
      onComplete: [{ do: 'giveItem', item: 'armor' }, { do: 'giveWeapon', weapon: 'sniper', ammo: { sniper: 20 } }, { do: 'dialogue', id: 'abuelo_done' }],
    },
    {
      id: 's02', title: 'La Granja', type: 'side',
      description: 'Les mercenaires ont pris la ferme de Pedro.',
      onStart: [{ do: 'dialogue', id: 's02_intro' }],
      objectives: [{ id: 'farm', type: 'liberate', text: 'Libérer la ferme de Pedro', target: 'outpost_farm' }],
      onComplete: [{ do: 'activateGroup', group: 'farm_civ' }],
    },
    {
      id: 's03', title: 'Le gardien du phare', type: 'side',
      description: 'Le phare de l\'îlot est occupé. Il faut un bateau.',
      onStart: [{ do: 'dialogue', id: 's03_intro' }],
      objectives: [{ id: 'light', type: 'liberate', text: 'Libérer le phare (îlot à l\'est)', target: 'outpost_lighthouse' }],
      onComplete: [{ do: 'giveItem', item: 'grenades' }],
    },
  ],
  triggers: [
    { id: 't_village_free', when: { event: 'liberate', outpost: 'outpost_village' }, do: [{ do: 'activateGroup', group: 'village_civ' }, { do: 'dialogue', id: 'village_free' }] },
    { id: 't_farm_free', when: { event: 'liberate', outpost: 'outpost_farm' }, do: [{ do: 'activateGroup', group: 'farm_civ' }] },
    { id: 't_first_alarm', when: { event: 'alarm' }, do: [{ do: 'hint', text: 'Alarme ! Des renforts arrivent. Sabotez les alarmes (E) avant d\'attaquer un avant-poste.', duration: 7 }] },
    { id: 't_crater', when: { enterZone: 'zone_crater' }, do: [{ do: 'banner', title: 'El Cono', subtitle: 'Le volcan endormi', duration: 4 }] },
    { id: 't_lab_early', when: { enterZone: 'zone_lab' }, if: { not: { any: [{ missionActive: 'm05' }, { missionDone: 'm05' }] } }, do: [{ do: 'dialogue', id: 'lab_early' }] },
    { id: 't_lighthouse_side', when: { event: 'missionComplete', mission: 'm04' }, do: [{ do: 'startMission', id: 's03' }] },
    { id: 't_relic_first', when: { event: 'pickup', item: 'relic' }, do: [{ do: 'hint', text: 'Une relique dorée ! Abuelo Tomás en cherche huit.', duration: 5 }] },
    { id: 't_vargas_taunt', when: { event: 'liberate' }, if: { missionDone: 'm03' }, once: true, do: [{ do: 'dialogue', id: 'vargas_taunt' }] },
  ],
};
writeJSON('game/missions.json', M);

// ============================================================================================
// Dialogue
const D = {
  speakers: {
    theo: { name: 'Théo', radio: false, pitch: 0.85, rate: 1.05, voiceIndex: 1 },
    mara: { name: 'Mara (radio)', radio: true, pitch: 1.25, rate: 1.08, voiceIndex: 0 },
    mara_live: { name: 'Mara', radio: false, pitch: 1.25, rate: 1.05, voiceIndex: 0 },
    val: { name: 'Valérie', radio: false, pitch: 1.15, rate: 1.1, voiceIndex: 0 },
    vargas: { name: 'Colonel Vargas (radio)', radio: true, pitch: 0.7, rate: 0.92, voiceIndex: 1 },
    abuelo: { name: 'Abuelo Tomás', radio: false, pitch: 0.75, rate: 0.9, voiceIndex: 1 },
    pedro: { name: 'Pedro', radio: false, pitch: 0.9, rate: 1, voiceIndex: 1 },
    pilot: { name: 'Pilote (radio)', radio: true, pitch: 0.95, rate: 1.1, voiceIndex: 1 },
  },
  dialogues: {
    m01_wake: [
      { speaker: 'theo', text: 'Ma tête… Le Marlin. Ils nous ont coulés sans sommation.' },
      { speaker: 'theo', text: 'Val ? VAL ! … Rien. Il faut que je retourne à l\'épave.' },
    ],
    m01_mara: [
      { speaker: 'mara', text: '… quelqu\'un m\'entend ? Ici Mara, Puerto Viejo. J\'ai vu un bateau couler ce matin.' },
      { speaker: 'theo', text: 'Je vous entends. Je suis le capitaine du Marlin. Une journaliste était à bord avec moi.' },
      { speaker: 'mara', text: 'Les hommes de Vargas ont emmené une femme vers le nord. Si tu veux la revoir, viens au village, à l\'est, en longeant la plage.' },
      { speaker: 'mara', text: 'Et fais attention : il y a des pirates de Vargas sur la plage. Reste dans les buissons.' },
    ],
    m01_after: [
      { speaker: 'mara', text: 'Des coups de feu ? … C\'était toi ? Pas mal pour un capitaine de plaisance. Continue vers l\'est.' },
    ],
    m02_intro: [
      { speaker: 'mara', text: 'Puerto Viejo est tenu par une demi-douzaine de mercenaires. Il y a une alarme près du mât.' },
      { speaker: 'mara', text: 'S\'ils la déclenchent, la moitié de l\'île débarque. Coupe-la d\'abord, discrètement.' },
    ],
    village_free: [
      { speaker: 'mara', text: 'Ils sont tous tombés ! Les gens sortent de leurs maisons… Viens me voir, ma maison est sur pilotis, au bord du lagon.' },
    ],
    mara_meet: [
      { speaker: 'mara_live', text: 'Alors c\'est toi, Théo. Merci… ça faisait deux ans qu\'on vivait sous leur botte.' },
      { speaker: 'mara_live', text: 'Ton amie, la journaliste, ils l\'ont emmenée au laboratoire de la côte nord. C\'est le repaire des scientifiques de Vargas.' },
      { speaker: 'mara_live', text: 'Mais d\'abord il faut faire tomber leur brouilleur, sur le Cerro Antena. Tant qu\'il tourne, personne ne peut appeler à l\'aide.' },
      { speaker: 'mara_live', text: 'Prends ces jumelles et le fusil de mon frère. Avec les jumelles (B), tu peux repérer et marquer les ennemis.' },
    ],
    m03_intro: [
      { speaker: 'mara', text: 'Le Cerro Antena, c\'est la colline à l\'ouest, avec la grande antenne rouge. Le brouilleur est un groupe électrogène au pied de la tour.' },
    ],
    m03_vargas: [
      { speaker: 'mara', text: 'Le brouillage a cessé ! Je… attends, il y a quelqu\'un sur la fréquence.' },
      { speaker: 'vargas', text: 'Capitaine Varin. Quel plaisir d\'entendre enfin votre voix. Ici le colonel Vargas.' },
      { speaker: 'vargas', text: 'Votre amie journaliste pose beaucoup de questions. Elle répondra aux miennes, à présent.' },
      { speaker: 'vargas', text: 'Quittez mon île, capitaine. Tant qu\'il vous reste des jambes pour nager.' },
      { speaker: 'theo', text: 'Je viens la chercher, Vargas.' },
    ],
    m04_intro: [
      { speaker: 'mara', text: 'Pour aller au nord, il faut passer l\'avant-poste du fleuve, sur la route. Ils y gardent une jeep.' },
    ],
    m04_done: [
      { speaker: 'mara', text: 'La route du nord est ouverte. Le laboratoire est au bout, sur la côte. Attends la nuit pour t\'en approcher.' },
    ],
    m05_intro: [
      { speaker: 'mara', text: 'Le laboratoire est très gardé : des tours, des patrouilles, une alarme. Approche par le sud, je te dirai quand c\'est le bon moment.' },
    ],
    m05_night: [
      { speaker: 'mara', text: 'La nuit est tombée. La porte du labo s\'ouvre avec une carte d\'accès : les gardes en laissent une dans l\'entrepôt, à l\'est.' },
    ],
    lab_early: [
      { speaker: 'mara', text: 'Tu es près du laboratoire ? C\'est un nid de frelons. Ne t\'y risque pas seul pour l\'instant.' },
    ],
    val_found: [
      { speaker: 'val', text: 'Théo ?! J\'ai cru que tu étais mort !' },
      { speaker: 'val', text: 'Ce n\'est pas un labo, c\'est une usine : Vargas fabrique des armes chimiques et les vend au plus offrant.' },
      { speaker: 'val', text: 'Il y a un bateau au ponton, au nord. Sors-moi d\'ici, je te suis !' },
    ],
    m05_done: [
      { speaker: 'val', text: 'On a réussi… Je file à Puerto Viejo avec le bateau, Mara saura où me cacher.' },
      { speaker: 'val', text: 'Écoute : la cargaison part demain par avion depuis l\'aérodrome. Sans carburant, pas d\'avion.' },
    ],
    m06_intro: [
      { speaker: 'mara', text: 'Valérie est arrivée saine et sauve. L\'aérodrome est au centre de l\'île, après l\'avant-poste. Trois cuves de carburant près du hangar.' },
    ],
    m06_done: [
      { speaker: 'vargas', text: 'Vous venez de brûler deux millions de dollars, capitaine. Venez donc à la Fortaleza en discuter.' },
      { speaker: 'mara', text: 'Il t\'attend, Théo. La Fortaleza est sur le plateau à l\'est. Toute l\'île compte sur toi.' },
    ],
    m07_intro: [
      { speaker: 'mara', text: 'Les villageois ont vu des renforts monter au plateau. La porte est au sud. Bonne chance.' },
    ],
    m07_vargas: [
      { speaker: 'vargas', text: 'Bienvenue à la Fortaleza ! Mes hommes vont vous offrir la visite.' },
    ],
    m07_call: [
      { speaker: 'pilot', text: 'Ici Sierra-Quatre, on vous reçoit. Hélicoptère en route vers votre position, posé dans trois minutes.' },
      { speaker: 'mara', text: 'Théo ! Tout le village t\'a entendu. Va à l\'héliport !' },
    ],
    m07_end: [
      { speaker: 'val', text: 'Mon article sortira demain. Et pour une fois, il finit bien.' },
      { speaker: 'mara', text: 'Reviens quand tu veux, capitaine. Isla Sombra te doit bien un bateau neuf.' },
    ],
    vargas_taunt: [
      { speaker: 'vargas', text: 'Vous libérez mes avant-postes un par un… Très bien. Chaque homme que vous tuez, je le remplace.' },
    ],
    abuelo_relics: [
      { speaker: 'abuelo', text: 'Mon garçon… Nos ancêtres ont caché huit idoles d\'or sur l\'île : au temple, sur le volcan, sur les îlots…' },
      { speaker: 'abuelo', text: 'Les hommes de Vargas les pillent. Rapporte-les-moi, et je te donnerai le vieux fusil de chasse de mon père.' },
    ],
    abuelo_done: [
      { speaker: 'abuelo', text: 'Les huit idoles ! Les esprits de Sombra te remercient. Ce fusil est à toi.' },
    ],
    s02_intro: [
      { speaker: 'mara', text: 'Pedro, le fermier de la Granja, à l\'ouest de la route, est retenu chez lui par des mercenaires. Si tu passes par là…' },
    ],
    pedro_thanks: [
      { speaker: 'pedro', text: 'Merci, señor ! Prenez la jeep si vous voulez, elle ira plus vite que vos jambes.' },
    ],
    s03_intro: [
      { speaker: 'mara', text: 'Le phare de l\'îlot à l\'est est éteint depuis que Vargas l\'a pris. Prends le bateau au ponton du village.' },
    ],
  },
};
writeJSON('game/dialogue.json', D);

const count = {};
for (const e of ents) count[e.type] = (count[e.type] ?? 0) + 1;
console.log(JSON.stringify({ entities: ents.length, byType: count, missions: M.missions.length, dialogues: Object.keys(D.dialogues).length }, null, 2));
