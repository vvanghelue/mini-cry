# NPC bodies (credits)

The GLBs here are the realistic NPC bodies, built by `npm run mc -- character build` from the
avatars listed in `../../data/characters.json`: the [Microsoft Rocketbox Avatar Library](https://github.com/microsoft/Microsoft-Rocketbox)
(Microsoft, MIT). The build converts each avatar to glTF, merges its parts into one
mesh, replaces its skeleton by the game's character rig, packs and resizes its textures into one
atlas, recolours the camouflage of the soldiers (jungle tones) and paints out the US flag, name
tapes and unit patches (docs/ASSETS.md).

| file | character | avatar |
|---|---|---|
| `soldier_goggles.glb` | Soldier: helmet, goggles, assault vest | [Military_Male_01](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Military_Male_01) |
| `soldier_cap.glb` | Soldier: patrol cap, fatigues | [Military_Male_02](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Military_Male_02) |
| `soldier_shades.glb` | Soldier: helmet, sunglasses, rolled-up sleeves, vest | [Military_Male_03](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Military_Male_03) |
| `soldier_nvg.glb` | Soldier: helmet with night-vision mount, vest | [Military_Male_04](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Military_Male_04) |
| `soldier_cap_b.glb` | Soldier: patrol cap, fatigues (2) | [Military_Male_05](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Military_Male_05) |
| `soldier_cap_c.glb` | Soldier: patrol cap, fatigues (3) | [Military_Male_06](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Military_Male_06) |
| `soldier_woman.glb` | Soldier (woman): helmet, vest | [Military_Female_01](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Military_Female_01) |
| `soldier_woman_b.glb` | Soldier (woman): helmet, vest (2) | [Military_Female_02](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Military_Female_02) |
| `officer.glb` | Officer: peaked cap, olive dress uniform | [Pilot_Male_01](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Pilot_Male_01) |
| `scientist_labcoat.glb` | Scientist: lab coat | [Medical_Male_01](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Medical_Male_01) |
| `villager_polo.glb` | Villager: polo shirt, shorts | [Male_Adult_01](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Adults/Male_Adult_01) |
| `villager_denim.glb` | Villager: denim shirt, cap | [Wood_Male_01](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Wood_Male_01) |
| `rebel_woman.glb` | Mara: leather jacket, cargo trousers, boots | [Female_Adult_04](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Adults/Female_Adult_04) |
| `journalist.glb` | Valérie: blazer, jeans | [Female_Adult_05](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Adults/Female_Adult_05) |
| `villager_elder.glb` | Abuelo Tomás: old man, sweater, jeans | [Male_Adult_13](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Adults/Male_Adult_13) |
| `farmer.glb` | Pedro: work jacket, rubber boots | [Gardener_Male_01](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Professions/Gardener_Male_01) |
| `villager_woman.glb` | Villager (woman): shirt, jeans | [Female_Adult_01](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Adults/Female_Adult_01) |

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
