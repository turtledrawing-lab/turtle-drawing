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
import os
import sys

import numpy as np
import trimesh

UNIT_SCALE = 1.0             # the pyslapi binding already returns metres (calibrated on Mac)
Z_UP_TO_Y_UP = True
TRANSPOSE_XFORM = False
# Skip geometry that is HIDDEN in SketchUp (per-entity Hide, or on an invisible
# tag/layer) so the import matches what's visible in SketchUp. The binding
# exposes .hidden + .layer.visible on groups/instances (not on bare faces), so
# filtering happens at the group/instance level — which is where hidden objects
# live in practice. Set TD_SKP_INCLUDE_HIDDEN=1 to import everything anyway.
INCLUDE_HIDDEN = bool(os.environ.get("TD_SKP_INCLUDE_HIDDEN"))
# Embed real material textures (PNG via glTF bufferView) + per-material opacity.
# Default ON. The desktop file:// texture-load path is handled by forcing
# TextureLoader in the vendored GLTFLoader (ImageBitmapLoader's fetch() is
# blocked under file://). Set TD_SKP_NO_TEXTURES=1 for the old color-only output.
TEXTURES = not os.environ.get("TD_SKP_NO_TEXTURES")
TEX_MAX = 1024   # cap embedded texture dimension. Textures are TILED (triplanar)
                 # in the renderer, so 1024 looks great while keeping glb size +
                 # GPU memory sane (2048 × dozens of textures = ~1GB VRAM).


def _is_visible(el):
    """True unless the group/instance is hidden or sits on an invisible layer."""
    if INCLUDE_HIDDEN:
        return True
    try:
        if getattr(el, "hidden", False):
            return False
    except Exception:
        pass
    try:
        lay = getattr(el, "layer", None)
        if lay is not None and getattr(lay, "visible", True) is False:
            return False
    except Exception:
        pass
    return True

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
    """name -> dict(color=(r,g,b,a) 0..1, opacity=0..1, image=PIL.Image|None)."""
    import tempfile
    from PIL import Image
    out = {}
    for mi, mat in enumerate(model.materials):
        try:
            name = mat.name
            col = tuple(mat.color) if getattr(mat, "color", None) else (204, 204, 204, 255)
            if max(col) > 1.0:
                col = tuple(c / 255.0 for c in col)
            # Opacity: the binding exposes mat.opacity (float 0..1); fall back to
            # the colour's alpha channel. <1 → glass/translucent.
            try:
                op = float(mat.opacity)
            except Exception:
                op = col[3] if len(col) > 3 else 1.0
            if op > 1.0:
                op = op / 255.0
            op = max(0.0, min(1.0, op))

            image = None
            avg = None
            tex = getattr(mat, "texture", None)
            if tex and hasattr(tex, "write"):
                try:
                    p = os.path.join(tempfile.gettempdir(), "td_skptex_%d.png" % mi)
                    tex.write(p)
                    full = Image.open(p)
                    full.load()
                    full = full.convert("RGB")
                    if TEXTURES:
                        # Embed the REAL texture (capped to TEX_MAX).
                        if max(full.size) > TEX_MAX:
                            full.thumbnail((TEX_MAX, TEX_MAX), Image.LANCZOS)
                        image = full.copy()
                    # Always compute an average colour as a fallback / for
                    # color-only mode (brick→red, grass→green, …).
                    thumb = full.copy()
                    thumb.thumbnail((24, 24))
                    px = list(thumb.getdata())
                    if px:
                        n = len(px)
                        avg = (sum(q[0] for q in px) / n / 255.0,
                               sum(q[1] for q in px) / n / 255.0,
                               sum(q[2] for q in px) / n / 255.0)
                    try:
                        os.remove(p)
                    except Exception:
                        pass
                except Exception as e:        # texture handling is best-effort
                    sys.stderr.write("[convert] texture skip (%s): %s\n" % (name, e))
            # Color-only path (or texture-load failed): use the average colour so
            # a textured material isn't rendered flat white.
            if image is None and avg is not None:
                col = (avg[0], avg[1], avg[2], col[3] if len(col) > 3 else 1.0)
            out[name] = {"color": col, "opacity": op, "image": image}
        except Exception as e:
            sys.stderr.write("[convert] material skip: %s\n" % e)
    return out


def convert(skp_path, glb_path):
    import sketchup  # provided by the RedHalo binding next to this file (Windows)
    model = sketchup.Model.from_file(skp_path)
    mats = _build_materials(model)

    # Accumulate triangles per (group-PATH, material), baked into world space.
    # EVERY SketchUp group/component instance — at ANY depth — opens a new node,
    # so the full nesting is preserved. The path of unique group ids is encoded
    # into each mesh name ("g1/g4/g7::<material>"; "::<material>" = ungrouped),
    # and the importer rebuilds the nested group tree from it.
    buckets = {}        # (path_tuple, mat_name) -> {"v","f","uv"}
    group_seq = [0]

    def emit(face, xform, default_mat, path):
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
        b = buckets.setdefault((path, mname), {"v": [], "f": [], "uv": []})
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

    def _child_path(path):
        group_seq[0] += 1
        return path + ("g%d" % group_seq[0],)

    skipped = [0]   # hidden groups/instances skipped (for the log)

    def walk(entities, xform, default_mat, path):
        for f in entities.faces:
            emit(f, xform, default_mat, path)
        for g in getattr(entities, "groups", []) or []:
            if not _is_visible(g):           # hidden / invisible-tag group → drop
                skipped[0] += 1
                continue
            gm = default_mat
            try:
                if g.material:
                    gm = g.material.name
            except Exception:
                pass
            walk(g.entities, xform @ _mat4(g.transform), gm, _child_path(path))
        for inst in getattr(entities, "instances", []) or []:
            if not _is_visible(inst):        # hidden / invisible-tag instance → drop
                skipped[0] += 1
                continue
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
                walk(ents, xform @ _mat4(inst.transform), im, _child_path(path))

    root = _AXIS if Z_UP_TO_Y_UP else np.eye(4)
    walk(model.entities, root, "DefaultMaterial", ())

    _maxd0 = max((len(p) for (p, _m) in buckets.keys()), default=0)
    sys.stderr.write("[convert] full nesting: %d buckets, max depth %d (before cap)\n" % (len(buckets), _maxd0))

    # OBJECT-COUNT CAP: full nesting can explode — a component used N times bakes
    # its inner groups N times → thousands of group paths → thousands of objects
    # → the app freezes. We must cap the object (bucket) count, but the OLD
    # approach flattened the DEEPEST level GLOBALLY, which also crushed the
    # uniquely-deep nesting the user cares about (the main building) down to ~2
    # levels. SMARTER: collapse the BUSHIEST leaf-clusters first — e.g. a "trees"
    # or "surrounding buildings" container holding 100 repeated instances becomes
    # one object — while sparsely-nested unique branches (the design itself) keep
    # their full depth. Tunable via TD_SKP_GROUP_CAP.
    GROUP_CAP = int(os.environ.get("TD_SKP_GROUP_CAP") or 1500)

    def _merge_into(out, np, mat, b):
        nb = out.setdefault((np, mat), {"v": [], "f": [], "uv": []})
        base = len(nb["v"])
        nb["v"].extend(b["v"]); nb["uv"].extend(b["uv"])
        for (a, b2, c) in b["f"]:
            nb["f"].append((a + base, b2 + base, c + base))

    def _coarsen_smart(bk, cap):
        passes = 0
        while len(bk) > cap:
            # A bucket path P is a LEAF if no other path strictly extends it.
            extended = set()
            for (p, _m) in bk:
                for k in range(len(p)):
                    extended.add(p[:k])
            clusters = {}                       # parent path -> [keys of its leaf children]
            for key in bk:
                p = key[0]
                if len(p) >= 1 and p not in extended:
                    clusters.setdefault(p[:-1], []).append(key)
            if not clusters:
                break
            # Collapse the biggest leaf-clusters first, just enough to reach cap.
            order = sorted(clusters, key=lambda pp: -len(clusters[pp]))
            need = len(bk) - cap
            chosen, saved = set(), 0
            for pp in order:
                if saved >= need and len(clusters[pp]) < 2:
                    break
                chosen.add(pp)
                saved += len(clusters[pp])
                if saved >= need:
                    break
            out = {}
            for (p, mat), b in bk.items():
                if len(p) >= 1 and p[:-1] in chosen and p not in extended:
                    _merge_into(out, p[:-1], mat, b)   # leaf → its parent
                else:
                    _merge_into(out, p, mat, b)
            if len(out) >= len(bk):
                break                            # no progress (safety)
            bk = out
            passes += 1
        return bk, passes

    _before = len(buckets)
    buckets, _passes = _coarsen_smart(buckets, GROUP_CAP)
    _maxd1 = max((len(p) for (p, _m) in buckets.keys()), default=0)
    if _passes:
        sys.stderr.write("[convert] coarsened bushiest subtrees in %d pass(es): %d → %d objects, max depth %d (cap ~%d)\n"
                         % (_passes, _before, len(buckets), _maxd1, GROUP_CAP))

    # One PBRMaterial per material name, REUSED across every bucket that uses it
    # — so trimesh embeds each texture image ONCE in the glb (sharing the same
    # material instance lets the exporter dedupe), not once per bucket.
    _pbr_cache = {}
    _n_transp = [0]
    _n_tex = [0]

    def _material_for(mname):
        if mname in _pbr_cache:
            return _pbr_cache[mname]
        info = mats.get(mname, {"color": (0.8, 0.8, 0.8, 1.0), "opacity": 1.0, "image": None})
        col = info["color"]
        op = info.get("opacity", col[3] if len(col) > 3 else 1.0)
        img = info.get("image")
        # baseColorFactor as glTF FLOATS 0..1. A textured material is left WHITE
        # so the texture isn't double-tinted; a solid material carries its rgb.
        if img is not None:
            base = [1.0, 1.0, 1.0, float(op)]
        else:
            base = [float(col[0]), float(col[1]), float(col[2]), float(op)]
        kw = dict(name=mname, baseColorFactor=base)
        if op < 0.999:
            kw["alphaMode"] = "BLEND"      # → GLTFLoader sets material.transparent=true
            _n_transp[0] += 1
        if img is not None:
            kw["baseColorTexture"] = img   # PIL.Image → trimesh embeds as a bufferView
            _n_tex[0] += 1
        mat = trimesh.visual.material.PBRMaterial(**kw)
        _pbr_cache[mname] = mat
        return mat

    scene = trimesh.Scene()
    n_out = 0
    for (path, mname), b in buckets.items():
        if not b["f"]:
            continue
        verts = np.array(b["v"], dtype=float)
        faces = np.array(b["f"], dtype=np.int64)
        mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
        try:
            mesh.visual = trimesh.visual.TextureVisuals(
                uv=np.array(b["uv"], dtype=float),
                material=_material_for(mname))
        except Exception as e:
            sys.stderr.write("[convert] visual skip (%s): %s\n" % (mname, e))
        # Encode the nested group path in the mesh name using '-' (GLTFLoader
        # STRIPS '/', ':', '.' from names but keeps '-'). Group ids are "g<n>",
        # so "g1-g4-g7" is unambiguous; ungrouped geometry → "loose". The
        # material name is NOT in the name (its colour rides on the PBR material).
        gname = "-".join(path) if path else "loose"
        scene.add_geometry(mesh, geom_name=gname)
        n_out += 1

    if not n_out:
        raise RuntimeError("no geometry extracted from %s" % skp_path)

    scene.export(glb_path)
    sys.stderr.write("[convert] %s -> %s  (%d meshes, %d hidden skipped, %d transparent mat, %d textured mat)\n"
                     % (skp_path, glb_path, n_out, skipped[0], _n_transp[0], _n_tex[0]))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.stderr.write("usage: python convert.py input.skp output.glb\n")
        sys.exit(2)
    convert(sys.argv[1], sys.argv[2])
