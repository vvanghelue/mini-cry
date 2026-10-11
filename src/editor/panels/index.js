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
  { id: 'world', icon: '🗺', label: 'Monde', help: 'Éditeur de niveau 3D : entités, terrain, végétation' },
  { id: 'terrain', icon: '⛰', label: 'Île', help: 'Disposition de l\'île (îles, montagnes, rivières, routes, sites) et génération', component: TerrainPanel },
  { id: 'environment', icon: '☀', label: 'Ambiance', help: 'Heure, soleil, ciel, brouillard, vent, océan', component: EnvironmentPanel },
  { id: 'missions', icon: '🎯', label: 'Missions', help: 'Missions, objectifs, déclencheurs, actions', component: MissionsPanel },
  { id: 'dialogue', icon: '💬', label: 'Dialogues', help: 'Personnages radio et répliques', component: DialoguePanel },
  { id: 'data', icon: '📊', label: 'Gameplay', help: 'Armes, ennemis, joueur, objets, végétation', component: DataPanel },
  { id: 'assets', icon: '🧱', label: 'Assets', help: 'Éditeur de modèles low-poly', component: AssetPanel },
  { id: 'characters', icon: '🧍', label: 'Personnages', help: 'Archétypes, palettes, animations', component: CharactersPanel },
  { id: 'audio', icon: '🔊', label: 'Audio', help: 'Sons procéduraux', component: AudioPanel },
];
