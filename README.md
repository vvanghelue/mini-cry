# Mini Cry — Isla Sombra

Un FPS en monde ouvert **low-poly** dans l'esprit de *Far Cry 1* : une île tropicale de 2 × 2 km
(jungle, lagon, volcan, rivière, îlots), des avant-postes de mercenaires à libérer, une histoire
scriptée en 7 missions + missions secondaires — avec son **moteur**, son **éditeur** et des
**outils pour agents IA**. Three.js + Vite, sans aucun fichier binaire d'art à part les
personnages riggés Quaternius : tout le reste (modèles, sons, terrain) est décrit en JSON et
généré.

**Démo** : https://vvanghelue.github.io/mini-cry/ (jeu) · https://vvanghelue.github.io/mini-cry/editor.html
(éditeur, sans sauvegarde : il faut le serveur de dev pour écrire les données).

```bash
npm install
npm run dev          # http://localhost:5190  (jeu)   ·   /editor.html  (éditeur)
```

## Le jeu

- **Île** : terrain procédural (heightmap 1025², LOD par chunks), océan et rivières en shader,
  ~145 000 végétaux instanciés (palmiers, géants de la jungle, bambous, fougères…), herbe autour
  du joueur, cycle jour/nuit avec ombres en cascades, occlusion ambiante (SSAO), ciel nuageux,
  brouillard.
- **Combat FPS** : machette (éliminations furtives), pistolet, PM, AK, M4, fusil à pompe, fusil de
  précision à lunette, lance-roquettes, grenades. Dispersion, recul, visée, rechargement, dégâts
  localisés (tête / corps / membres).
- **IA** : jauge de détection (distance, vision centrale / périphérique, part du corps visible,
  posture, mouvement, buissons sur la ligne de vue, nuit, attention), ouïe (tirs, explosions,
  course), patrouilles, enquête, combat à couvert, rafales, grenades, alerte d'escouade (un
  guetteur abattu avant de crier ne prévient personne), coureur vers l'alarme → renforts. Civils
  qui fuient.
- **Monde ouvert** : 10 avant-postes à libérer (voyage rapide), jumelles pour marquer les ennemis,
  jeep et bateau conduisibles, barils explosifs, objets à ramasser, 8 reliques et 6 dossiers.
- **Histoire** : *Échoué → Puerto Viejo → Ondes courtes → Le fleuve → Le laboratoire → Ailes
  coupées → La Fortaleza*, + 3 missions secondaires. Dialogues radio sous-titrés (voix de synthèse
  française en option), cinématiques, points de contrôle.
- **Audio 100 % procédural** : 74 sons synthétisés (armes, impacts, pas, UI, ambiances jour /
  nuit / sous l'eau, musique qui monte avec le combat).

**Commandes** : ZQSD/WASD · souris · clic tirer · clic droit viser · R recharger · E utiliser /
conduire · G grenade · V machette · Maj sprint · Ctrl accroupi · Espace sauter / nager · B jumelles
· M carte · 1–5 armes · Échap pause · F3 stats (FPS / CPU / GPU / draw calls / mémoire)
· F2 panneau de debug (triches, missions, heure, graphismes). Les deux s'affichent par défaut
(`?stats=0` / `?debug=0` pour les masquer).

## L'éditeur (`/editor.html`)

| Onglet | Rôle |
|---|---|
| 🗺 Monde | Niveau 3D : sélection, gizmo (W/E/R), placement depuis le navigateur de contenu (bâtiments, objets, végétation, véhicules, armes, personnages, logique), outliner, inspecteur généré depuis les schémas, sculpture / peinture du terrain, pinceau de végétation, édition de chemins, undo/redo, ▶ jouer depuis la caméra |
| ⛰ Île | Disposition de l'île (îles, montagnes, plateaux, lagons, rivières, routes, sites) et régénération du terrain + végétation |
| ☀ Ambiance | Heure, soleil, lune, ciel, brouillard, nuages, vent, couleurs de l'océan — en direct |
| 🎯 Missions | Missions, objectifs, déclencheurs, conditions, actions, validation des références, test direct |
| 💬 Dialogues | Personnages radio, répliques, écoute en voix de synthèse |
| 📊 Gameplay | Armes, munitions, ennemis (archétypes & palettes), joueur, objets, espèces végétales |
| 🧱 Assets | Éditeur de modèles low-poly (pièces, générateurs, colliders, LOD) avec aperçu 3D |
| 🔊 Audio | Concepteur de sons procéduraux (couches, enveloppes, filtres) avec forme d'onde et écoute |

Ctrl+S enregistre (les fichiers vont dans `public/data/`, une copie de sauvegarde est gardée dans
`.mc-backup/`).

## Outils pour agents IA

Tout le contenu est en JSON lisible et modifiable sans navigateur, et l'agent peut **voir** et
**jouer** le jeu en headless sur le vrai GPU :

```bash
npm run mc -- help                       # la CLI (terrain, végétation, assets, entités, missions, sons, validation, live)
npm run mc -- validate                   # vérifie assets, schémas, références des missions…
npm test                                 # scénarios de non-régression headless (tests/*.play)
npm run mc -- terrain preview            # carte vue de dessus -> shots/map.png
npm run mc -- asset shot hut_stilt --colliders   # rendu d'un asset -> PNG
npm run shot -- --at outpost_river --tod 17      # capture d'un point de vue du monde
npm run play -- --spawn x,y,z,yaw --steps "wait 2; key KeyW 1; click 0.5; shot test; state"
npm run bench -- --mode play [--prod]    # perfs par point de vue (fps, ms CPU/GPU, draw calls)
npm run profile -- --spawn x,y,z         # profil CPU agrégé par fonction
node tools/trace-flight.mjs --prod       # trace Chrome d'un survol rapide : images longues et leur cause
npm run mc -- live state                 # pilote un jeu / éditeur ouvert dans un navigateur
```

Voir `CLAUDE.md` (guide agent), `docs/ASSETS.md`, `docs/MISSIONS.md`, `docs/AUDIO.md`.

## Architecture

```
src/engine/   moteur générique
  core/       Engine (boucle, systèmes, résolution dynamique, perfs CPU/GPU), Input, Data, Live, FlyCamera
  render/     Lighting (jour/nuit, ciel, matériaux low-poly, vent), SunShadows (cascades), SSAO, InstancedField, StaticBatch
  world/      TerrainData / TerrainGen / TerrainRenderer, Water, Vegetation (+ scatter), Grass, Entities, World
  physics/    Physics (grille spatiale, boîtes/cylindres/sphères, personnage, raycasts)
  assets/     ModelBuilder (JSON -> géométrie), generators (palmier, arbre…), AssetLibrary
  anim/       Characters (persos Quaternius fusionnés, retargeting des anims UAL, hitboxes)
  audio/      synth (rendu des recettes, worker) + AudioSystem (3D, ambiances, musique)
src/game/     le jeu : Game, player/ (contrôleur, armes), actors/ (acteurs, IA, navigation), missions/,
              entities/ (types d'entités du jeu), vehicles/, fx/, ui/ (HUD, menus, carte)
src/editor/   l'éditeur (Preact) : core.js + ui/ + panels/
public/data/  toutes les données : terrain/, assets/, world.json, vegetation.*, environment.json,
              sounds.json, game/ (player, weapons, archetypes, items, missions, dialogue)
tools/        CLI mc + outils headless (shot, play, bench, profile) + content/seed-world.mjs
```

**Performances** (cible : 120 fps+ sur MacBook Air M1) : matériaux Lambert à facettes sans
textures, terrain en chunks LOD, végétation instanciée par secteurs avec LOD (les LOD lointains
partagent une géométrie), props fusionnés par secteur (static batching), ombres en 2–3 cascades à
fréquence de rafraîchissement décroissante, SSAO en demi-résolution (pré-passe de profondeur limitée
aux 80 m où elle est visible, flou 4x4, appliquée dans les matériaux à la lumière ambiante), personnages fusionnés en un seul mesh skinné et sortis
du graphe de scène quand ils sont loin, animations à cadence réduite avec la distance, effets en
pools instanciés, résolution dynamique.

Streaming sans à-coups : les instances (végétation, herbe) sont envoyées au GPU **par blocs de
secteur / tuile** (`render/InstanceBlocks.js`) : seuls les blocs qui entrent ou sortent sont
transférés (quelques Ko par image au lieu de ~76 Mo/s en survol rapide), et un secteur n'est
retraité que quand il franchit une distance de LOD. Tous les shaders (passe principale + passe
d'ombre, personnages, armes en vue FPS, variantes de matériaux pas encore utilisées) sont compilés
pendant l'écran de chargement (`World.warmUp`, ~0,1–0,2 s) : aucune compilation en cours de jeu
(`npm test` affiche les compilations tardives s'il y en a).

Mesure (`npm run bench -- --mode play --prod --m1 --repeat 3 --fresh`) : 9 points de vue en jeu
réel (ennemis, IA, HUD), 1440×900, une page neuve par mesure. Le mode `--m1` est une estimation
**pessimiste** d'un MacBook Air M1 7 cœurs GPU faite sur une machine plus rapide : CPU de la page
bridé ×2 (le M1 est ~1,6× plus lent en monocœur) et temps GPU mesuré ×1,9 ; fps estimés =
min(fps avec CPU bridé, 1000 / (ms GPU × 1,9)). Dernier résultat (médiane de 3) : **toutes les vues
≥ 164 fps estimés sur M1** (pire : côte au coucher du soleil, 164 ; meilleure : forteresse, 201) ;
avec le CPU bridé ×2 le jeu tourne à 233–318 fps, 163–240 appels de dessin par image.

Fluidité (sans bridage) : survol en ligne droite à 108 km/h pendant 8 s (`tests/stream_smooth.play`) :
p50 3,7 ms, p99 6–6,6 ms, pire image 7,9–9,4 ms, 0 à 2 images > 8,3 ms sur ~2 100 ; en jeep
(`tests/drive_smooth.play`) : p99 5,6 ms, pire 7,3 ms. Les mesures GPU varient quand d'autres
applications utilisent le GPU : toujours utiliser `--repeat`. Le préréglage « low » et la
résolution dynamique gardent de la marge sur les machines plus faibles.

La **GI** (illumination globale par probes, comme dans `three-rigged-game`) est volontairement
laissée pour plus tard ; l'éclairage actuel est soleil/lune + ciel hémisphérique.

Crédits : personnages et animations — Quaternius (CC0, *Universal Animation Library*).
