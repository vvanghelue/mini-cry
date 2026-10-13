# Blender (headless) -> GLB, used by `mc viewmodel build` for .blend / .obj / .fbx weapon sources:
#   blender -b --factory-startup --python tools/lib/blend2glb.py -- <input> <output.glb>
import sys, bpy
inp, out = sys.argv[sys.argv.index('--') + 1:][:2]
low = inp.lower()
if low.endswith('.blend'):
    bpy.ops.wm.open_mainfile(filepath=inp, load_ui=False)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if low.endswith('.obj'):
        bpy.ops.wm.obj_import(filepath=inp)
    elif low.endswith('.fbx'):
        bpy.ops.import_scene.fbx(filepath=inp)
    else:
        raise SystemExit('unsupported input ' + inp)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True, export_animations=False, export_cameras=False, export_lights=False, use_visible=False)
