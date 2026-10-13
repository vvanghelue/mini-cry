# First-person models (credits)

The GLBs here are the first-person arms and weapons, built by `npm run mc -- viewmodel build`
from the sources listed in `../../data/viewmodels.json`. The build converts each source to glTF,
keeps the arm triangles (arms) or one variant of the model (weapons), moves it into the weapon
space of its asset, and resizes and re-encodes the textures (docs/ASSETS.md).

| file | model | author | licence |
|---|---|---|---|
| `arms_military.glb` | arms of the avatar `Military_Male_03` of the [Microsoft Rocketbox Avatar Library](https://github.com/microsoft/Microsoft-Rocketbox) (the US flag, name tape and unit patches on the sleeves are painted out) | Microsoft | MIT (notice below) |
| `machete.glb` | [Machete](https://polyhaven.com/a/machete) | Ulan Cabanilla (Poly Haven) | CC0 |
| `pistol.glb` | [Service Pistol](https://polyhaven.com/a/service_pistol), wooden grip variant | Mateusz Sadek (Poly Haven) | CC0 |
| `smg.glb` | Kriss Vector (without its suppressor), from the 3D Model Haven gun pack ([archive](https://archive.org/details/gun_models.7z)) | Rajil Jose Macatangay | CC0 |
| `rifle_ak.glb` | [AKM](https://opengameart.org/content/akm) | LonesomeDucky | CC0 |
| `rifle_m4.glb` | ["M4A1"](https://sketchfab.com/3d-models/m4a1-33107f38b23c45cc8103768c0e961cdf) | [TORI106](https://sketchfab.com/TORI106) | [CC-BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| `shotgun.glb` | Mossberg 500 (without the loose shells), from the 3D Model Haven gun pack ([archive](https://archive.org/details/gun_models.7z)) | Rajil Jose Macatangay | CC0 |
| `sniper.glb` | [Bolt Action Rifle 7.62](https://polyhaven.com/a/bolt_action_rifle_7_62) (one bolt variant, without the loose cartridge) | Mateusz Sadek (Poly Haven) | CC0 |
| `rpg.glb` | ["RPG-7"](https://sketchfab.com/3d-models/rpg-7-01c0fa7bb9e0439cac27264b3119a3fd) | [Tactical_Gamer](https://sketchfab.com/Tactical_Beard) | [CC-BY 4.0](http://creativecommons.org/licenses/by/4.0/) |

The two CC-BY models were changed. Each was rescaled, rotated and re-centred, its textures were
resized, and it was merged into one mesh per material.

## Microsoft Rocketbox: MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
