#!/usr/bin/env python3
"""Convert a SketchUp .skp file to binary glTF (.glb).

Runs ONLY where the SketchUp SDK binding is available (sketchup.so +
SketchUpAPI.framework next to this file). It walks the model with the SketchUp
C API binding and emits a .glb that Turtle Drawing loads through its normal
importGLB() path.

    python convert.py input.skp output.glb

INSTANCING (Stage 8): a SketchUp COMPONENT used N times shares one DEFINITION.
The old converter BAKED every instance's geometry into world space → a component
used N times produced N full copies → memory/object explosion → nesting had to be
coarsened away (GROUP_CAP). Now each definition used ≥ TD_SKP_INSTANCE_MIN (2)
times is emitted ONCE as a def-LOCAL mesh, and every instance becomes a
lightweight glTF NODE that references that shared mesh with the instance's world
transform. GLTFLoader shares the BufferGeometry across those nodes, so the
importer rebuilds them as one component definition + N instances (shared
geometry, per-instance matrix) — full depth, no explosion.

Singleton components and groups (inherently unique) are still BAKED inline, which
preserves their nesting via the group-path mesh name without any duplication.

Binding API (from the pyslapi/RedHalo binding):
    m = sketchup.Model.from_file(path)
    m.materials -> [ mat(.name, .color, .opacity, .texture(.write(path))) ]
    m.entities  -> entities(.faces, .groups, .instances)
        face:  .material(.name), .tessfaces -> (verts, tris, uvs)
        group: .transform (4x4), .entities, .material, .hidden, .layer
        instance(component): .transform, .definition(.name,.entities,.numInstances,
                             .numUsedInstances), .material, .hidden, .layer

CALIBRATION KNOBS:
  * UNIT_SCALE      : binding lengths (here already metres) → glTF metres.
  * Z_UP_TO_Y_UP    : SketchUp Z-up → glTF Y-up (rotate -90° about X).
  * TRANSPOSE_XFORM : flip if the binding's 4x4 needs transposing.
"""
import os
import sys

import numpy as np
import trimesh

UNIT_SCALE = 1.0             # the pyslapi binding already returns metres (calibrated on Mac)
Z_UP_TO_Y_UP = True
TRANSPOSE_XFORM = False
INCLUDE_HIDDEN = bool(os.environ.get("TD_SKP_INCLUDE_HIDDEN"))
TEXTURES = not os.environ.get("TD_SKP_NO_TEXTURES")
# Cap embedded texture dimension. Textures are TILED (triplanar) in the renderer
# and the app is an architectural sectional/perspective tool — they're viewed in
# a viewport, not photoreal close-ups — so a smaller cap is plenty on screen while
# cutting glb size, convert/parse time, web transfer, and GPU memory a LOT (data
# scales with the square of the dimension). 512 ≈ ¼ the data of 1024. Override
# with TD_SKP_TEX_MAX (e.g. 256 = fastest, 1024 = full).
TEX_MAX = int(os.environ.get("TD_SKP_TEX_MAX") or 512)
# A component definition used at least this many times is emitted ONCE + instanced
# (rather than baked per use). Set TD_SKP_NO_INSTANCE=1 to fully disable instancing
# (every component baked inline — the old behaviour, kept as a safety fallback).
INSTANCE_MIN = (1 << 30) if os.environ.get("TD_SKP_NO_INSTANCE") \
    else int(os.environ.get("TD_SKP_INSTANCE_MIN") or 2)


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
                        if max(full.size) > TEX_MAX:
                            full.thumbnail((TEX_MAX, TEX_MAX), Image.LANCZOS)
                        image = full.copy()
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
            if image is None and avg is not None:
                col = (avg[0], avg[1], avg[2], col[3] if len(col) > 3 else 1.0)
            out[name] = {"color": col, "opacity": op, "image": image}
        except Exception as e:
            sys.stderr.write("[convert] material skip: %s\n" % e)
    return out


def _face_mat_name(face, default_mat):
    try:
        if face.material:
            return face.material.name
    except Exception:
        pass
    return default_mat


def _emit_face(bucket, face, xform, default_mat):
    """Append one tessellated face's triangles into `bucket` ({v,f,uv}),
    transformed by `xform`. Returns the material name used."""
    try:
        vs, tris, uvs = face.tessfaces
    except Exception:
        return None
    if not vs or not tris:
        return None
    base = len(bucket["v"])
    M = xform
    for (x, y, z) in vs:
        p = M @ np.array([x, y, z, 1.0])
        bucket["v"].append((p[0] * UNIT_SCALE, p[1] * UNIT_SCALE, p[2] * UNIT_SCALE))
    if uvs and len(uvs) == len(vs):
        bucket["uv"].extend((u, v) for (u, v, *_rest) in (tuple(t) for t in uvs))
    else:
        bucket["uv"].extend((0.0, 0.0) for _ in vs)
    for tri in tris:
        bucket["f"].append((tri[0] + base, tri[1] + base, tri[2] + base))
    return _face_mat_name(face, default_mat)


def convert(skp_path, glb_path):
    import sketchup  # provided by the SketchUp binding next to this file
    model = sketchup.Model.from_file(skp_path)
    mats = _build_materials(model)

    # --- World-baked geometry: root faces, groups, and singleton components ---
    # bucket key (path_tuple, mat_name) -> {v,f,uv}  (world coords, Y-up metres)
    buckets = {}
    group_seq = [0]
    skipped = [0]

    # --- Component DEFINITIONS, emitted once in def-LOCAL space (Z-up) ---
    # def_name -> { mat_name: {v,f,uv} } | None while building (cycle guard)
    def_cache = {}
    # Placed instances: list of (path_tuple, def_name, world_xform 4x4)
    instances = []

    def _child_path(path):
        group_seq[0] += 1
        return path + ("g%d" % group_seq[0],)

    def _inst_count(d):
        for k in ("numUsedInstances", "numInstances"):
            try:
                c = int(getattr(d, k, 0) or 0)
                if c:
                    return c
            except Exception:
                pass
        return 0

    def _flatten_def(definition):
        """Build (cached) def-LOCAL per-material buckets for a definition by
        walking its entities with an IDENTITY root and FLATTENING nested groups
        and nested component instances into the definition's own local frame.
        (Nested components are flattened here for v1; the instance's own world
        matrix still places the whole definition, so repeated use stays shared.)"""
        name = definition.name
        cached = def_cache.get(name, False)
        if cached is not False:
            return cached
        def_cache[name] = None     # cycle guard (a def can't contain itself, but be safe)
        local = {}                 # mat -> {v,f,uv}

        def w(ents, xf, default_mat):
            for f in (getattr(ents, "faces", []) or []):
                tmp = {"v": [], "f": [], "uv": []}
                mn = _emit_face(tmp, f, xf, default_mat)
                if mn is None:
                    continue
                b = local.setdefault(mn, {"v": [], "f": [], "uv": []})
                base = len(b["v"])
                b["v"].extend(tmp["v"]); b["uv"].extend(tmp["uv"])
                for (a, c, d2) in tmp["f"]:
                    b["f"].append((a + base, c + base, d2 + base))
            for g in (getattr(ents, "groups", []) or []):
                if not _is_visible(g):
                    continue
                gm = default_mat
                try:
                    if g.material:
                        gm = g.material.name
                except Exception:
                    pass
                w(g.entities, xf @ _mat4(g.transform), gm)
            for ins in (getattr(ents, "instances", []) or []):
                if not _is_visible(ins):
                    continue
                im = default_mat
                try:
                    if ins.material:
                        im = ins.material.name
                except Exception:
                    pass
                try:
                    ents2 = ins.definition.entities
                except Exception:
                    ents2 = getattr(ins, "entities", None)
                if ents2 is not None:
                    w(ents2, xf @ _mat4(ins.transform), im)

        try:
            w(definition.entities, np.eye(4), "DefaultMaterial")
        except Exception as e:
            sys.stderr.write("[convert] def flatten skip (%s): %s\n" % (name, e))
        def_cache[name] = local
        return local

    def walk(entities, xform, default_mat, path):
        for f in (getattr(entities, "faces", []) or []):
            mn = _face_mat_name(f, default_mat)
            b = buckets.setdefault((path, mn), {"v": [], "f": [], "uv": []})
            _emit_face(b, f, xform, mn)
        for g in (getattr(entities, "groups", []) or []):
            if not _is_visible(g):
                skipped[0] += 1
                continue
            gm = default_mat
            try:
                if g.material:
                    gm = g.material.name
            except Exception:
                pass
            walk(g.entities, xform @ _mat4(g.transform), gm, _child_path(path))
        for inst in (getattr(entities, "instances", []) or []):
            if not _is_visible(inst):
                skipped[0] += 1
                continue
            im = default_mat
            try:
                if inst.material:
                    im = inst.material.name
            except Exception:
                pass
            d = getattr(inst, "definition", None)
            world = xform @ _mat4(inst.transform)
            if d is not None and _inst_count(d) >= INSTANCE_MIN:
                # Shared component: emit the def once (def-LOCAL) + an instance node.
                _flatten_def(d)
                instances.append((path, d.name, world))
            else:
                # Singleton component (or no definition): bake inline like a group,
                # preserving nesting via the path. No duplication (used once).
                try:
                    ents = inst.definition.entities
                except Exception:
                    ents = getattr(inst, "entities", None)
                if ents is not None:
                    walk(ents, world, im, _child_path(path))

    root = _AXIS if Z_UP_TO_Y_UP else np.eye(4)
    walk(model.entities, root, "DefaultMaterial", ())

    _ndef = sum(1 for v in def_cache.values() if v)
    sys.stderr.write("[convert] baked buckets=%d, definitions=%d, instance placements=%d\n"
                     % (len(buckets), _ndef, len(instances)))

    # OBJECT-COUNT CAP for the BAKED part only (instances don't explode). Repeated
    # components are now shared, so this rarely triggers; kept as a safety net for
    # pathological models with thousands of unique groups.
    GROUP_CAP = int(os.environ.get("TD_SKP_GROUP_CAP") or 1500)

    def _merge_into(out, npath, mat, b):
        nb = out.setdefault((npath, mat), {"v": [], "f": [], "uv": []})
        base = len(nb["v"])
        nb["v"].extend(b["v"]); nb["uv"].extend(b["uv"])
        for (a, b2, c) in b["f"]:
            nb["f"].append((a + base, b2 + base, c + base))

    def _coarsen_smart(bk, cap):
        passes = 0
        while len(bk) > cap:
            extended = set()
            for (p, _m) in bk:
                for k in range(len(p)):
                    extended.add(p[:k])
            clusters = {}
            for key in bk:
                p = key[0]
                if len(p) >= 1 and p not in extended:
                    clusters.setdefault(p[:-1], []).append(key)
            if not clusters:
                break
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
                    _merge_into(out, p[:-1], mat, b)
                else:
                    _merge_into(out, p, mat, b)
            if len(out) >= len(bk):
                break
            bk = out
            passes += 1
        return bk, passes

    _before = len(buckets)
    buckets, _passes = _coarsen_smart(buckets, GROUP_CAP)
    if _passes:
        sys.stderr.write("[convert] coarsened baked buckets in %d pass(es): %d -> %d\n"
                         % (_passes, _before, len(buckets)))

    # One PBRMaterial per material name, REUSED so trimesh embeds each texture once.
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
        if img is not None:
            base = [1.0, 1.0, 1.0, float(op)]
        else:
            base = [float(col[0]), float(col[1]), float(col[2]), float(op)]
        kw = dict(name=mname, baseColorFactor=base)
        if op < 0.999:
            kw["alphaMode"] = "BLEND"
            _n_transp[0] += 1
        if img is not None:
            kw["baseColorTexture"] = img
            _n_tex[0] += 1
        mat = trimesh.visual.material.PBRMaterial(**kw)
        _pbr_cache[mname] = mat
        return mat

    def _make_mesh(b, mname):
        verts = np.array(b["v"], dtype=float)
        faces = np.array(b["f"], dtype=np.int64)
        mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
        try:
            mesh.visual = trimesh.visual.TextureVisuals(
                uv=np.array(b["uv"], dtype=float),
                material=_material_for(mname))
        except Exception as e:
            sys.stderr.write("[convert] visual skip (%s): %s\n" % (mname, e))
        return mesh

    scene = trimesh.Scene()
    n_baked = 0
    # 1) Baked geometry — one mesh per (path, material), node name = group path.
    for (path, mname), b in buckets.items():
        if not b["f"]:
            continue
        gname = "-".join(path) if path else "loose"
        scene.add_geometry(_make_mesh(b, mname), geom_name=gname)
        n_baked += 1

    # 2) Component definitions — each (def, material) mesh added to the scene ONCE
    #    under a stable geometry name. Instances below reference these by name, so
    #    trimesh/GLTF emit a single shared mesh + N nodes (the importer rebuilds
    #    them as one component def + N instances).
    def_geom_names = {}     # (def_name, mat_name) -> geometry name in the scene
    _dsan = {}
    for di, (dname, local) in enumerate(def_cache.items()):
        if not local:
            continue
        _dsan[dname] = di
        for mi, (mname, b) in enumerate(local.items()):
            if not b["f"]:
                continue
            gname = "def%d_%d" % (di, mi)
            scene.geometry[gname] = _make_mesh(b, mname)
            def_geom_names[(dname, mname)] = gname

    # 3) Instance NODES — one node per (instance, def-material) referencing the
    #    shared geometry, placed by the instance's world matrix. The node name
    #    carries the group path (+ a unique "_<seq>" the importer strips) so the
    #    importer rebuilds the nested group tree; geometry identity carries the
    #    instancing.
    n_inst_nodes = 0
    seq = 0
    for (path, dname, world) in instances:
        local = def_cache.get(dname)
        if not local:
            continue
        pstr = "-".join(path) if path else "loose"
        for mname in local.keys():
            gname = def_geom_names.get((dname, mname))
            if not gname:
                continue
            seq += 1
            node = "%s_%d" % (pstr, seq)
            scene.graph.update(frame_to=node, matrix=np.asarray(world, dtype=float), geometry=gname)
            n_inst_nodes += 1

    if not n_baked and not n_inst_nodes:
        raise RuntimeError("no geometry extracted from %s" % skp_path)

    scene.export(glb_path)
    sys.stderr.write("[convert] %s -> %s  (%d baked meshes, %d defs, %d instance nodes, "
                     "%d hidden skipped, %d transparent mat, %d textured mat)\n"
                     % (skp_path, glb_path, n_baked, len(def_geom_names), n_inst_nodes,
                        skipped[0], _n_transp[0], _n_tex[0]))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.stderr.write("usage: python convert.py input.skp output.glb\n")
        sys.exit(2)
    convert(sys.argv[1], sys.argv[2])
