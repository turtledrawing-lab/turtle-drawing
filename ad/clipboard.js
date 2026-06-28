/* ============================================================================
   AD.Clipboard — copy/paste selected objects, across tabs too.
   ----------------------------------------------------------------------------
   Lives at module level so it outlives tab switches (each tab rebuilds
   its own scene when activated, but the clipboard stays). Serialises
   each object in the same JSON shape as sceneToDoc()'s per-object
   entries; pasting walks the same reconstruction path as the .tt file
   loader.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});

  const Clip = { objects: [], groups: [] };
  AD.Clipboard = Clip;

  /* Walk each object's group chain to the root, collecting {id,parentId,name}
     records so a copied NESTED group can be re-created (with fresh ids) on
     paste. Reads the live Model.groups registry at copy time. */
  function collectGroups(objs) {
    const out = [];
    const seen = new Set();
    if (typeof Model === 'undefined' || !Model.groups) return out;
    for (const o of objs) {
      let g = o.groupId, guard = 0;
      while (g != null && !seen.has(g) && guard++ < 256) {
        seen.add(g);
        const e = Model.groups.get(g);
        out.push({ id: g, parentId: e ? e.parentId : null, name: e ? e.name : null });
        g = e ? e.parentId : null;
      }
    }
    return out;
  }

  function snapshotObject(o) {
    const em = o.em;
    return {
      name: o.name,
      layerId: o.layerId,
      groupId: o.groupId || null,
      visible: o.visible,
      locked: o.locked,
      smoothShade: !!em._smoothShade,
      materialId: o.materialId || null,
      // Material APPEARANCE (mirrors snapshot()/sceneToDoc) so paste restores the
      // exact color/opacity/transparency even when the material def can't be found
      // — e.g. SKP/OBJ imported glass. Without these, pasted glass turned opaque.
      matColor: (o.mat && o.mat.color) ? o.mat.color.getHex() : null,
      matOpacity: o.mat ? o.mat.opacity : null,
      matTransparent: o.mat ? !!o.mat.transparent : null,
      matDepthWrite: o.mat ? !!o.mat.depthWrite : null,
      castShadow: o.mesh ? !!o.mesh.castShadow : null,
      isImagePlane: !!o.isImagePlane,
      isEntourage:  !!o.isEntourage,
      entourageId:  o.entourageId || null,
      imageSrc:     o.imageSrc || null,
      faceCamera:   !!o.faceCamera,
      componentId:  o.componentId || null,
      componentOrigin: o.componentOrigin ? { ...o.componentOrigin } : null,
      // True component instance: copy = a new instance sharing the same
      // definition, placed by this matrix (not a baked clone).
      isInstance:   !!o.isInstance,
      instanceMatrix: (o.isInstance && o.instanceMatrix) ? o.instanceMatrix.toArray() : null,
      ad: o.ad ? {
        kind: o.ad.kind || null,
        material: o.ad.material || null,
        struct: !!o.ad.struct,
        cutBehavior: o.ad.cutBehavior || 'render',
        level: o.ad.level || null,
      } : null,
      vertices: em.vertices.map(v => [v.x, v.y, v.z]),
      faces: em.faces.map(f => ({
        verts: f.verts.slice(),
        // Serialize the face normal so the paste roundtrip is lossless (matches
        // em.clone). addFace would otherwise recompute it from winding and lose
        // any independently-flipped normal → broken faces on paste.
        normal: f.normal ? [f.normal.x, f.normal.y, f.normal.z] : null,
        color: f.color,
        layerId: f.layerId,
        holes: (f.holes || []).map(h => h.slice()),
        hidden: !!f.hidden,
      })),
      edges: (em.edges || []).map(e => ({ a: e.a, b: e.b })),
      // Soft (hidden) edges — the coplanar/triangulation diagonals that the
      // renderer skips. Without these the paste shows every triangle split.
      // sceneToDoc/.tt serialize these (and em.clone keeps them); the clipboard
      // roundtrip must too. Keyed by vertex index ("min:max"), which the roundtrip
      // preserves (vertices are restored in the same order).
      softEdges: em.softEdges ? Array.from(em.softEdges) : [],
      hiddenEdges: em.hiddenEdges ? Array.from(em.hiddenEdges) : [],
    };
  }

  function reconstructObject(data, shift, groupMap) {
    const s = shift || { x: 0, y: 0, z: 0 };
    // True component instance: re-create as a shared-geometry instance of the
    // same definition (looked up by componentId), placed by its matrix + the
    // paste shift — NOT a baked clone. Falls back to baked geometry below if the
    // definition is gone (e.g. cross-session paste).
    if (data.isInstance && data.componentId && typeof Model !== 'undefined' && Model.components &&
        typeof createComponentInstance === 'function') {
      const def = Model.components.find(c => c.id === data.componentId);
      if (def) {
        const M = data.instanceMatrix ? new THREE.Matrix4().fromArray(data.instanceMatrix) : new THREE.Matrix4();
        M.premultiply(new THREE.Matrix4().makeTranslation(s.x, s.y, s.z));
        const so = createComponentInstance(def, M);
        if (so) {
          so.name = data.name || def.name;
          so.layerId = data.layerId || 'Layer0';
          if (typeof mappedCopyGroupId === 'function') {
            const _b = (typeof Model !== 'undefined' && Model) ? Model.activeGroupId : null;
            so.groupId = mappedCopyGroupId(data.groupId || null, groupMap, _b);
          }
        }
        return so;
      }
    }
    const em = new EditableMesh();
    if (data.smoothShade) em._smoothShade = true;
    for (const v of data.vertices) {
      em.vertices.push(new THREE.Vector3(v[0] + s.x, v[1] + s.y, v[2] + s.z));
    }
    for (const fd of (data.faces || [])) {
      const f = em.addFace(fd.verts.slice(),
        fd.color != null ? fd.color : 0xffffff,
        fd.layerId || data.layerId || 'Layer0');
      if (fd.holes && fd.holes.length) f.holes = fd.holes.map(h => h.slice());
      if (fd.hidden) f.hidden = true;
      // Preserve the EXACT stored normal. addFace recomputes it from winding
      // (Newell), but a face whose normal was flipped independently of its winding
      // (SKP import / flip-faces) would otherwise re-orient on paste — flipping the
      // earcut projection in triangulateFace → BROKEN triangulation/shading. em.clone()
      // keeps the normal (so the move-tool copy is fine); the clipboard roundtrip must too.
      if (fd.normal && fd.normal.length === 3) f.normal.set(fd.normal[0], fd.normal[1], fd.normal[2]);
    }
    for (const ed of (data.edges || [])) em.edges.push({ a: ed.a, b: ed.b });
    // Restore soft (hidden) edges — without these, an SKP-triangulated face's
    // coplanar diagonals (softened in the source) render as visible triangle
    // splits on paste. Matches sceneToDoc/.tt and em.clone.
    if (data.softEdges && data.softEdges.length) em.softEdges = new Set(data.softEdges);
    if (data.hiddenEdges && data.hiddenEdges.length) em.hiddenEdges = new Set(data.hiddenEdges);

    const obj = new SketchObject(em, (data.name || 'Object') + ' (copy)');
    obj.layerId = data.layerId || 'Layer0';
    obj.visible = data.visible !== false;
    obj.locked  = !!data.locked;
    obj.materialId = data.materialId || null;
    if (data.componentId) {
      obj.componentId = data.componentId;
      // Shift the stored anchor by the same translation we applied to vertices
      // so the copy's recorded position lines up with its visible mesh.
      const baseOrigin = data.componentOrigin || { x: 0, y: 0, z: 0 };
      obj.componentOrigin = {
        x: baseOrigin.x + s.x, y: baseOrigin.y + s.y, z: baseOrigin.z + s.z,
      };
    }

    // Material restore — mirror the undo/.tt loader: restore the appearance props
    // first, then re-apply the texture from EITHER registry. SKP/OBJ imported
    // materials (incl. glass) live in ImportedMaterials, which the old code never
    // searched (and it skipped the opacity/transparent props), so imported
    // materials and glass transparency were lost on paste.
    if (data.matColor != null && obj.mat && obj.mat.color) obj.mat.color.setHex(data.matColor);
    if (data.matOpacity != null && obj.mat) obj.mat.opacity = data.matOpacity;
    if (data.matTransparent != null && obj.mat) obj.mat.transparent = data.matTransparent;
    if (data.matDepthWrite != null && obj.mat) obj.mat.depthWrite = data.matDepthWrite;
    if (data.castShadow != null && obj.mesh) obj.mesh.castShadow = data.castShadow;
    if (data.materialId && typeof applyMaterialToObject === 'function') {
      if (obj.mat) obj.mat.vertexColors = false;
      let matDef = null;
      if (typeof MATERIALS !== 'undefined') matDef = MATERIALS.find(m => m.id === data.materialId);
      if (!matDef && typeof ImportedMaterials !== 'undefined') matDef = ImportedMaterials.find(m => m.id === data.materialId);
      if (matDef) { try { applyMaterialToObject(obj, matDef); } catch (_) {} }
    }
    if (obj.mat) obj.mat.needsUpdate = true;

    // Image-plane / entourage restore (reuses the .tt loader's pattern).
    if (data.isImagePlane || data.isEntourage) {
      let src = data.imageSrc;
      if (!src && data.isEntourage && data.entourageId &&
          window.AD && AD.Entourage) {
        const item = AD.Entourage.byId(data.entourageId);
        if (item) src = AD.Entourage.svgDataUrl(item);
      }
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.DoubleSide,
        transparent: true, alphaTest: 0.01, depthWrite: true,
      });
      if (src) {
        if (window.AD && AD.Entourage && AD.Entourage.applyHiResTexture) {
          AD.Entourage.applyHiResTexture(src, mat);
        } else {
          const loader = new THREE.TextureLoader();
          loader.load(src, (tex) => {
            tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = false;
            if (typeof THREE.sRGBEncoding !== 'undefined') tex.encoding = THREE.sRGBEncoding;
            tex.needsUpdate = true;
            mat.map = tex; mat.needsUpdate = true;
          });
        }
      }
      obj.mesh.material = mat;
      obj.mat = mat;
      obj.isImagePlane = true;
      obj.isEntourage  = !!data.isEntourage;
      obj.entourageId  = data.entourageId || null;
      obj.imageSrc     = src || null;
      obj._skipEdges = true;
      if (obj.edges && obj.edges.geometry) {
        obj.edges.geometry.dispose();
        obj.edges.geometry = new THREE.BufferGeometry();
      }
      obj.rebuild = function () {
        const V = this.em.vertices;
        if (V.length < 4) return;
        const A = V[0], B = V[1], C = V[2], D = V[3];
        const n = new THREE.Vector3()
          .crossVectors(new THREE.Vector3().subVectors(B, A),
                        new THREE.Vector3().subVectors(D, A)).normalize();
        const positions = new Float32Array([
          A.x,A.y,A.z, B.x,B.y,B.z, C.x,C.y,C.z,
          A.x,A.y,A.z, C.x,C.y,C.z, D.x,D.y,D.z,
        ]);
        const normals = new Float32Array([
          n.x,n.y,n.z, n.x,n.y,n.z, n.x,n.y,n.z,
          n.x,n.y,n.z, n.x,n.y,n.z, n.x,n.y,n.z,
        ]);
        const uvs = new Float32Array([
          0,0, 1,0, 1,1,
          0,0, 1,1, 0,1,
        ]);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
        g.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
        g.userData.faceIdxMap = [0, 0];
        g.computeBoundingBox(); g.computeBoundingSphere();
        if (this.mesh.geometry) this.mesh.geometry.dispose();
        this.mesh.geometry = g;
      };
      obj.rebuild();
    }

    // AD metadata (hatch assignments — section-plane references can't
    // carry across tabs so we drop hatchAt and keep only the default
    // material hatch).
    if (data.ad) {
      if (window.AD && AD.Core && AD.Core.ensureMetadata) AD.Core.ensureMetadata(obj);
      obj.ad.kind        = data.ad.kind || null;
      obj.ad.material    = data.ad.material || null;
      obj.ad.struct      = !!data.ad.struct;
      obj.ad.cutBehavior = data.ad.cutBehavior || 'render';
      obj.ad.level       = data.ad.level || null;
      if (obj.ad.material && window.AD && AD.HatchLines && AD.HatchLines.apply) {
        try { AD.HatchLines.apply(obj, obj.ad.material); } catch (_) {}
      }
    }

    addObject(obj);
    // Restore layer after addObject (which would otherwise reassign).
    obj.layerId = data.layerId || 'Layer0';
    // Restore group membership: map the source groupId to its freshly-minted
    // copy group (built once per paste in Clip.paste), so a copied group stays
    // grouped (and nested) instead of dissolving into loose objects.
    if (typeof mappedCopyGroupId === 'function') {
      const _boundary = (typeof Model !== 'undefined' && Model) ? Model.activeGroupId : null;
      obj.groupId = mappedCopyGroupId(data.groupId || null, groupMap, _boundary);
    } else if (data.groupId && groupMap && groupMap.get) {
      obj.groupId = groupMap.get(data.groupId) || null;
    }

    if (data.faceCamera) {
      try {
        if (typeof setObjectFaceCamera === 'function') setObjectFaceCamera(obj, true);
        else obj.faceCamera = true;
      } catch (_) {}
    }
    return obj;
  }

  // Persist last clipboard payload across file switches / app reloads via
  // localStorage. Also try the system clipboard (navigator.clipboard) so
  // copy/paste between separate Turtle Drawing windows works.
  function persist(objs, groups) {
    try {
      const blob = JSON.stringify({ kind: 'turtle-clip', v: 1, objects: objs, groups: groups || [] });
      localStorage.setItem('turtle_clipboard', blob);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(blob).catch(() => {});
      }
    } catch (_) {}
  }
  function restoreFromStorageIfEmpty() {
    if (Clip.objects && Clip.objects.length) return;
    try {
      const blob = localStorage.getItem('turtle_clipboard');
      if (!blob) return;
      const j = JSON.parse(blob);
      if (j && j.kind === 'turtle-clip' && Array.isArray(j.objects)) {
        Clip.objects = j.objects;
        Clip.groups = Array.isArray(j.groups) ? j.groups : [];
      }
    } catch (_) {}
  }

  Clip.copy = function () {
    if (typeof Selection === 'undefined') return;
    const wholeSel = Array.from(Selection.objects);
    // Face-only selection (e.g. picking a single face inside a group):
    // snapshot a SUB-OBJECT containing just the selected faces so paste
    // recreates that geometry, not stale clipboard data.
    const facePieces = [];
    if (!wholeSel.length && Selection.faces && Selection.faces.size) {
      for (const [obj, faceSet] of Selection.faces) {
        if (!faceSet || !faceSet.size) continue;
        const fi = Array.from(faceSet);
        const usedV = new Map();
        const remap = (vi) => {
          if (!usedV.has(vi)) usedV.set(vi, usedV.size);
          return usedV.get(vi);
        };
        const newFaces = fi.map(i => {
          const f = obj.em.faces[i];
          return {
            verts: f.verts.map(remap),
            normal: f.normal ? [f.normal.x, f.normal.y, f.normal.z] : null,
            color: f.color,
            layerId: f.layerId,
            holes: (f.holes || []).map(h => h.map(remap)),
            hidden: !!f.hidden,
          };
        });
        const newVerts = Array.from(usedV.keys()).map(vi => {
          const v = obj.em.vertices[vi];
          return [v.x, v.y, v.z];
        });
        facePieces.push({
          name: obj.name + ' (faces)',
          layerId: obj.layerId,
          visible: true, locked: false,
          smoothShade: !!obj.em._smoothShade,
          materialId: obj.materialId || null,
          isImagePlane: false, isEntourage: false,
          entourageId: null, imageSrc: null, faceCamera: false,
          componentId: null, componentOrigin: null, ad: null,
          vertices: newVerts,
          faces: newFaces,
          edges: [],
        });
      }
    }
    const snaps = wholeSel.length ? wholeSel.map(snapshotObject) : facePieces;
    if (!snaps.length) {
      if (typeof setStatus === 'function') setStatus('msg', 'Nothing selected to copy.');
      return;
    }
    Clip.objects = snaps;
    Clip.groups = wholeSel.length ? collectGroups(wholeSel) : [];
    persist(Clip.objects, Clip.groups);
    if (typeof setStatus === 'function') {
      setStatus('msg', `Copied ${snaps.length} item(s) to clipboard.`);
    }
  };

  Clip.cut = function () {
    const sel = typeof Selection !== 'undefined' ? Array.from(Selection.objects) : [];
    if (!sel.length) return;
    Clip.objects = sel.map(snapshotObject);
    Clip.groups = collectGroups(sel);
    persist(Clip.objects, Clip.groups);
    for (const o of sel) removeObject(o);
    clearSelection();
    if (typeof pushHistory === 'function') { try { pushHistory('Cut'); } catch (_) {} }
    if (typeof setStatus === 'function') {
      setStatus('msg', `Cut ${sel.length} object(s).`);
    }
  };

  /* Paste objects and follow the mouse cursor until the user clicks to
     commit or presses Esc to cancel. The pasted objects live in the
     scene during placement so the user sees them update live. */
  Clip.paste = async function () {
    // If our in-memory buffer is empty, try restoring from localStorage and
    // then from the system clipboard (a Turtle Drawing JSON payload from
    // another window).
    restoreFromStorageIfEmpty();
    if (!Clip.objects.length && navigator.clipboard && navigator.clipboard.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.startsWith('{') && text.includes('"turtle-clip"')) {
          const j = JSON.parse(text);
          if (j && j.kind === 'turtle-clip' && Array.isArray(j.objects)) {
            Clip.objects = j.objects;
            Clip.groups = Array.isArray(j.groups) ? j.groups : [];
          }
        }
      } catch (_) {}
    }
    if (!Clip.objects.length) {
      if (typeof setStatus === 'function') setStatus('msg', 'Clipboard empty.');
      return;
    }
    clearSelection();
    // Re-create the copied group subtree once with FRESH ids (parentId chain
    // remapped, roots attached to the current edit context) so all pasted
    // objects of the same source group land in the same NEW group and keep
    // their nesting. Falls back to no-op if the registry helpers are absent.
    let groupMap = null;
    try {
      if (typeof instantiateGroupCopies === 'function' && Clip.groups && Clip.groups.length) {
        const _boundary = (typeof Model !== 'undefined' && Model) ? Model.activeGroupId : null;
        groupMap = instantiateGroupCopies(Clip.groups, _boundary);
      }
    } catch (_) {}
    const placed = [];
    const bb = new THREE.Box3();
    bb.makeEmpty();
    // addObject() refreshes the outliner + layer visibility PER object, so pasting
    // a large group is O(n²) and freezes. Suppress the per-object refresh and run
    // it ONCE below — mirrors the bulk-import paths in turtle_drawing.html.
    const _prevSuppress = (typeof Model !== 'undefined' && Model) ? Model._suppressAddRefresh : false;
    if (typeof Model !== 'undefined' && Model) Model._suppressAddRefresh = true;
    // rebuild() calls rebuildSectionFills() PER object, which rebuilds the WHOLE
    // scene's section fills (O(sectionPlanes × Model.objects × faces)). Pasting N
    // objects that way is O(n²) and is the real freeze. _bulkRestore skips the
    // per-object call; we run rebuildSectionFills() ONCE below (bulk-import idiom).
    const _prevBulk = window._bulkRestore;
    window._bulkRestore = true;
    for (const data of Clip.objects) {
      const obj = reconstructObject(data, { x: 0, y: 0, z: 0 }, groupMap);
      if (!obj) continue;
      placed.push(obj);
      Selection.objects.add(obj);
      // Instances store em in def-LOCAL space — use the world bbox.
      if (obj.isInstance && typeof obj.computeBBox === 'function') bb.union(obj.computeBBox());
      else for (const v of obj.em.vertices) bb.expandByPoint(v);
    }
    if (typeof Model !== 'undefined' && Model) Model._suppressAddRefresh = _prevSuppress;
    window._bulkRestore = _prevBulk;
    if (!placed.length) return;
    // Anchor at bottom-corner of the combined bbox so the cursor grabs
    // the (min x, min y, min z) foot of the pasted content.
    const anchor = bb.isEmpty()
      ? new THREE.Vector3()
      : new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z);
    refreshSelectionVisuals();
    renderEntityInfo();
    // Per-object refresh was suppressed during the loop; run each ONCE now so the
    // pasted group shows correctly during placement: outliner, layer visibility,
    // thick-edge layer weights/colors (applyToScene), and section fills.
    if (!_prevSuppress) {
      try { if (typeof renderOutliner === 'function') renderOutliner(); } catch (_) {}
      try { if (typeof applyLayerVisibility === 'function') applyLayerVisibility(); } catch (_) {}
      try { if (window.AD && AD.Layers && AD.Layers.applyToScene) AD.Layers.applyToScene(); } catch (_) {}
    }
    if (!_prevBulk) { try { if (typeof rebuildSectionFills === 'function') rebuildSectionFills(); } catch (_) {} }

    // Enter paste-drag mode.
    const state = {
      objs: placed,
      // Instances move via their matrix during the paste-drag (em is shared).
      origMat: placed.map(o => (o.isInstance && o.instanceMatrix) ? o.instanceMatrix.clone() : null),
      anchor: anchor,
      lastShift: new THREE.Vector3(),
      copyGroupIds: groupMap ? Array.from(groupMap.values()) : [],
    };
    _enterPasteMode(state);
  };

  let _pasteState = null;
  let _pasteCursor = null;
  let _pasteKey = null;

  function _enterPasteMode(state) {
    _pasteState = state;
    const can = document.getElementById('threeCanvas') ||
                document.getElementById('canvas') ||
                document.querySelector('canvas');
    if (!can) { _commitPaste(); return; }
    if (typeof setStatus === 'function') {
      setStatus('msg', `${state.objs.length} object(s) — move with mouse, click to place, Esc to cancel.`);
    }
    document.body.style.cursor = 'crosshair';

    const onMove = (e) => {
      if (!_pasteState) return;
      const hit = _pointerToWorld(e, can);
      if (!hit) return;
      const shift = new THREE.Vector3().subVectors(hit, _pasteState.anchor);
      _pasteState.lastShift.copy(shift);
      _applyShift(_pasteState, shift);
    };
    const onDown = (e) => {
      if (!_pasteState) return;
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      _commitPaste();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        _cancelPaste();
      }
    };
    _pasteCursor = { can, onMove, onDown };
    _pasteKey = onKey;
    can.addEventListener('pointermove', onMove, true);
    can.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  }

  function _applyShift(state, shift) {
    for (let i = 0; i < state.objs.length; i++) {
      const obj = state.objs[i];
      // Instance: move via its matrix (em is the SHARED def geometry — mutating
      // it would corrupt every instance).
      if (obj.isInstance && state.origMat && state.origMat[i]) {
        obj.instanceMatrix = new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z).multiply(state.origMat[i]);
        obj.group.matrix.copy(obj.instanceMatrix);
        obj.group.matrixWorldNeedsUpdate = true;
        try { obj.group.updateMatrixWorld(true); } catch (_) {}
        continue;
      }
      // Non-instance: translate the whole group via its transform (O(1)/object)
      // for a smooth live preview. Rewriting every vertex + obj.rebuild() per
      // frame froze large-group pastes. em.vertices stay at their paste-time
      // positions; the offset is baked into them once on commit (_commitPaste).
      obj.group.position.copy(shift);
    }
  }

  function _pointerToWorld(e, can) {
    const rect = can.getBoundingClientRect();
    const p = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(p, camera);
    // Prefer geometry hits over ground plane so pasting on top of an
    // existing wall/floor snaps to its surface.
    const hits = rc.intersectObjects(
      Model.objects
        .filter(o => o.group.visible && !_pasteState.objs.includes(o))
        .map(o => o.mesh),
      false
    );
    if (hits && hits.length) return hits[0].point.clone();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const out = new THREE.Vector3();
    return rc.ray.intersectPlane(ground, out) ? out : null;
  }

  function _teardownPasteListeners() {
    if (_pasteCursor) {
      _pasteCursor.can.removeEventListener('pointermove', _pasteCursor.onMove, true);
      _pasteCursor.can.removeEventListener('pointerdown', _pasteCursor.onDown, true);
    }
    if (_pasteKey) window.removeEventListener('keydown', _pasteKey, true);
    _pasteCursor = null; _pasteKey = null;
    document.body.style.cursor = '';
  }

  function _commitPaste() {
    if (!_pasteState) return;
    const st = _pasteState;
    const count = st.objs.length;
    _pasteState = null;
    _teardownPasteListeners();
    const _prevBulkB = window._bulkRestore;
    window._bulkRestore = true;   // skip per-object rebuildSectionFills — run once below
    // Bake the live-preview group offset (group.position) into geometry so each
    // pasted object owns its final world coords, then rebuild ONCE — instead of
    // the per-frame rebuild during the drag that froze large-group pastes.
    for (let i = 0; i < st.objs.length; i++) {
      const obj = st.objs[i];
      if (obj.isInstance) continue;   // placed via instanceMatrix during the drag
      const p = obj.group.position;
      if (p.x || p.y || p.z) {
        for (let k = 0; k < obj.em.vertices.length; k++) obj.em.vertices[k].add(p);
        obj.group.position.set(0, 0, 0);
        try { obj.rebuild(); } catch (_) {}
      }
    }
    window._bulkRestore = _prevBulkB;
    if (!_prevBulkB) { try { if (typeof rebuildSectionFills === 'function') rebuildSectionFills(); } catch (_) {} }
    if (typeof renderOutliner === 'function') { try { renderOutliner(); } catch (_) {} }
    if (typeof applyLayerVisibility === 'function') { try { applyLayerVisibility(); } catch (_) {} }
    if (typeof pushHistory === 'function') { try { pushHistory('Paste'); } catch (_) {} }
    if (typeof setStatus === 'function') {
      setStatus('msg', `Pasted ${count} object(s).`);
    }
  }
  function _cancelPaste() {
    if (!_pasteState) return;
    for (const obj of _pasteState.objs) {
      try { removeObject(obj); } catch (_) {}
    }
    // Drop the copy groups we registered up-front so a cancelled paste leaves
    // no orphaned (empty) group entries in the registry.
    try {
      if (typeof Model !== 'undefined' && Model.groups && _pasteState.copyGroupIds) {
        for (const gid of _pasteState.copyGroupIds) Model.groups.delete(gid);
      }
    } catch (_) {}
    _pasteState = null;
    _teardownPasteListeners();
    clearSelection();
    refreshSelectionVisuals();
    renderEntityInfo();
    if (typeof setStatus === 'function') setStatus('msg', 'Paste cancelled.');
  }

  /* ---- Key bindings ---------------------------------------------------- */
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      window.addEventListener('keydown', (e) => {
        if (document.activeElement &&
            (document.activeElement.tagName === 'INPUT' ||
             document.activeElement.tagName === 'TEXTAREA')) return;
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;
        const k = e.key.toLowerCase();
        if (k === 'c') { e.preventDefault(); Clip.copy(); }
        else if (k === 'x') { e.preventDefault(); Clip.cut(); }
        else if (k === 'v') { e.preventDefault(); Clip.paste(); }
        else if (k === 'd') { e.preventDefault(); Clip.copy(); Clip.paste(); }
      });
    }, 600);
  });
})();
