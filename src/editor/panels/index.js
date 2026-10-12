// Editor panels shown in the top bar. 'world' is the 3D level editor (no full panel).
import { EnvironmentPanel } from './EnvironmentPanel.jsx';
import { DataPanel } from './DataPanel.jsx';
import { TerrainPanel } from './TerrainPanel.jsx';
import { MissionsPanel } from './MissionsPanel.jsx';
import { DialoguePanel } from './DialoguePanel.jsx';
import { AssetPanel } from './AssetPanel.jsx';
import { AudioPanel } from './AudioPanel.jsx';
import { CharactersPanel } from './CharactersPanel.jsx';

export const PANELS = [
  { id: 'world', icon: '🗺', label: 'World', help: '3D level editor: entities, terrain, vegetation' },
  { id: 'terrain', icon: '⛰', label: 'Island', help: 'Island layout (islands, mountains, rivers, roads, sites) and generation', component: TerrainPanel },
  { id: 'environment', icon: '☀', label: 'Environment', help: 'Time of day, sun, sky, fog, wind, ocean', component: EnvironmentPanel },
  { id: 'missions', icon: '🎯', label: 'Missions', help: 'Missions, objectives, triggers, actions', component: MissionsPanel },
  { id: 'dialogue', icon: '💬', label: 'Dialogue', help: 'Radio characters and lines', component: DialoguePanel },
  { id: 'data', icon: '📊', label: 'Gameplay', help: 'Weapons, enemies, player, items, vegetation', component: DataPanel },
  { id: 'assets', icon: '🧱', label: 'Assets', help: 'Low-poly model editor', component: AssetPanel },
  { id: 'characters', icon: '🧍', label: 'Characters', help: 'Archetypes, palettes, animations', component: CharactersPanel },
  { id: 'audio', icon: '🔊', label: 'Audio', help: 'Procedural sounds', component: AudioPanel },
];
