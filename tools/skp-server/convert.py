#!/usr/bin/env python3
"""Convert a SketchUp .skp file to binary glTF (.glb).

Runs ONLY where the SketchUp SDK binding is available (Windows, via the RedHalo
"sketchup_importer" binaries placed next to this file — the `sketchup` module +
SketchUpAPI.dll). It walks the model with the SketchUp C API binding and emits a
.glb that Turtle Drawing loads through its normal importGLB() path.

    python convert.py input.skp output.glb

Binding API used (from RedHalo/pyslapi):
    m = sketchup.Model.from_file(path)
    m.materials -> [ mat(.name, .color=(r,g,b,a), .texture(.dimensions, .write(path))) ]
    m.entities  -> entities(.faces, .groups, .instances)
        face: .material(.name), .tessfaces -> (verts, tris, uvs)
        group/instance: .transform (4x4), .entities (or .definition.entities), .material

CALIBRATION KNOBS — verify against one known model on Windows and adjust:
  * UNIT_SCALE : SketchUp C API lengths are INCHES; glTF is metres → 0.0254.
  * Z_UP_TO_Y_UP : SketchUp is Z-up, glTF is Y-up → rotate -90° about X.
  * TRANSPOSE_XFORM : whether the binding's 4x4 needs transposing for row-vector
    math. If imports come in mirrored/rotated wrong, flip this first.
"""
import sys

import numpy as np
import trimesh

UNIT_SCALE = 1.0             # the pyslapi binding already returns metres (calibrated on Mac)
Z_UP_TO_Y_UP = True
TRANSPOSE_XFORM = False

# (x,y,z) Z-up -> (x, z, -y) Y-up
_AXIS = np.array([[1, 0, 0, 0],
                  [0, 0, 1, 0],
                  [0, -1, 0, 0],
                  [0, 0, 0, 1]], dtype=float)


def _mat4(t):
    """Binding transform (flat-16 or nested 4x4) -> 4x4 numpy matrix for
    column-vector math (M @ [x,y,z,1])."""
    a = np.array(t, dtype=float).reshape(4, 4)
    return a.T if TRANSPOSE_XFORM else a


def _build_materials(model):
    """name -> dict(color=(r,g,b,a) 0..1, image=PIL.Image|None)."""
    import os
    import tempfile
    from PIL import Image
    out = {}
    for mat in model.materials:
        try:
            name = mat.name
            col = tuple(mat.color) if getattr(mat, "color", None) else (204, 204, 204, 255)
            if max(col) > 1.0:
                col = tuple(c / 255.0 for c in col)
            # Textures are NOT embedded (the importer only applies a solid colour
            # today, and glb-embedded images make GLTFLoader fetch them on parse,
            # which fails under the desktop file:// origin). BUT a textured
            # SketchUp material usually has a WHITE base colour, so instead of
            # rendering it white we sample the texture's AVERAGE colour as a
            # representative solid (brick→red, grass→green, …). Full textures
            # come later with proper texture import.
            tex = getattr(mat, "texture", None)
            if tex and hasattr(tex, "write"):
                try:
                    p = os.path.join(tempfile.gettempdir(), "td_skptex.png")
                    tex.write(p)
                    im = Image.open(p).convert("RGB")
                    im.thumbnail((24, 24))
                    px = list(im.getdata())
                    if px:
                        n = len(px)
                        col = (sum(q[0] for q in px) / n / 255.0,
                               sum(q[1] for q in px) / n / 255.0,
                               sum(q[2] for q in px) / n / 255.0,
                               col[3] if len(col) > 3 else 1.0)
                except Exception as e:        # average-colour is best-effort
                    sys.stderr.write("[convert] texture avg skip (%s): %s\n" % (name, e))
            out[name] = {"color": col, "image": None}
        except Exception as e:
            sys.stderr.write("[convert] material skip: %s\n" % e)
    return out


def convert(skp_path, glb_path):
    import sketchup  # provided by the RedHalo binding next to this file (Windows)
    model = sketchup.Model.from_file(skp_path)
    mats = _build_materials(model)

    # Accumulate triangles per material name (baked into world space).
    buckets = {}   # mat_name -> {"v": [...], "f": [...], "uv": [...]}

    def emit(face, xform, default_mat):
        try:
            vs, tris, uvs = face.tessfaces
        except Exception:
            return
        if not vs or not tris:
            return
        mname = default_mat
        try:
            if face.material:
                mname = face.material.name
        except Exception:
            pass
        b = buckets.setdefault(mname, {"v": [], "f": [], "uv": []})
        base = len(b["v"])
        M = xform
        for (x, y, z) in vs:
            p = M @ np.array([x, y, z, 1.0])
            b["v"].append((p[0] * UNIT_SCALE, p[1] * UNIT_SCALE, p[2] * UNIT_SCALE))
        if uvs and len(uvs) == len(vs):
            b["uv"].extend((u, v) for (u, v, *_rest) in (tuple(t) for t in uvs))
        else:
            b["uv"].extend((0.0, 0.0) for _ in vs)
        for tri in tris:
            b["f"].append((tri[0] + base, tri[1] + base, tri[2] + base))

    def walk(entities, xform, default_mat):
        for f in entities.faces:
            emit(f, xform, default_mat)
        for g in getattr(entities, "groups", []) or []:
            gm = default_mat
            try:
                if g.material:
                    gm = g.material.name
            except Exception:
                pass
            walk(g.entities, xform @ _mat4(g.transform), gm)
        for inst in getattr(entities, "instances", []) or []:
            im = default_mat
            try:
                if inst.material:
                    im = inst.material.name
            except Exception:
                pass
            try:
                ents = inst.definition.entities
            except Exception:
                ents = getattr(inst, "entities", None)
            if ents is not None:
                walk(ents, xform @ _mat4(inst.transform), im)

    root = _AXIS if Z_UP_TO_Y_UP else np.eye(4)
    walk(model.entities, root, "DefaultMaterial")

    geoms = []
    for mname, b in buckets.items():
        if not b["f"]:
            continue
        verts = np.array(b["v"], dtype=float)
        faces = np.array(b["f"], dtype=np.int64)
        mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
        info = mats.get(mname, {"color": (0.8, 0.8, 0.8, 1.0), "image": None})
        try:
            uv = np.array(b["uv"], dtype=float)
            if info["image"] is not None:
                mesh.visual = trimesh.visual.TextureVisuals(
                    uv=uv, image=info["image"])
            else:
                rgba = [int(round(c * 255)) for c in info["color"]]
                if len(rgba) == 3:
                    rgba.append(255)
                mesh.visual = trimesh.visual.TextureVisuals(
                    uv=uv,
                    material=trimesh.visual.material.PBRMaterial(
                        baseColorFactor=rgba, name=mname))
        except Exception as e:
            sys.stderr.write("[convert] visual skip (%s): %s\n" % (mname, e))
        geoms.append(mesh)

    if not geoms:
        raise RuntimeError("no geometry extracted from %s" % skp_path)

    scene = trimesh.Scene(geoms)
    scene.export(glb_path)
    sys.stderr.write("[convert] %s -> %s  (%d material groups)\n"
                     % (skp_path, glb_path, len(geoms)))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.stderr.write("usage: python convert.py input.skp output.glb\n")
        sys.exit(2)
    convert(sys.argv[1], sys.argv[2])
