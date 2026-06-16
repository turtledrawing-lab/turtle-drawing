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
      isImagePlane: !!o.isImagePlane,
      isEntourage:  !!o.isEntourage,
      entourageId:  o.entourageId || null,
      imageSrc:     o.imageSrc || null,
      faceCamera:   !!o.faceCamera,
      componentId:  o.componentId || null,
      componentOrigin: o.componentOrigin ? { ...o.componentOrigin } : null,
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
        color: f.color,
        layerId: f.layerId,
        holes: (f.holes || []).map(h => h.slice()),
      })),
      edges: (em.edges || []).map(e => ({ a: e.a, b: e.b })),
    };
  }

  function reconstructObject(data, shift, groupMap) {
    const em = new EditableMesh();
    if (data.smoothShade) em._smoothShade = true;
    const s = shift || { x: 0, y: 0, z: 0 };
    for (const v of data.vertices) {
      em.vertices.push(new THREE.Vector3(v[0] + s.x, v[1] + s.y, v[2] + s.z));
    }
    for (const fd of (data.faces || [])) {
      const f = em.addFace(fd.verts.slice(),
        fd.color != null ? fd.color : 0xffffff,
        fd.layerId || data.layerId || 'Layer0');
      if (fd.holes && fd.holes.length) f.holes = fd.holes.map(h => h.slice());
    }
    for (const ed of (data.edges || [])) em.edges.push({ a: ed.a, b: ed.b });

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

    // Built-in material restore.
    if (data.materialId && typeof MATERIALS !== 'undefined') {
      const matDef = MATERIALS.find(m => m.id === data.materialId);
      if (matDef && typeof applyMaterialToObject === 'function') {
        try { applyMaterialToObject(obj, matDef); } catch (_) {}
      }
    }

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
            color: f.color,
            layerId: f.layerId,
            holes: (f.holes || []).map(h => h.map(remap)),
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
    for (const data of Clip.objects) {
      const obj = reconstructObject(data, { x: 0, y: 0, z: 0 }, groupMap);
      if (!obj) continue;
      placed.push(obj);
      Selection.objects.add(obj);
      for (const v of obj.em.vertices) bb.expandByPoint(v);
    }
    if (!placed.length) return;
    // Anchor at bottom-corner of the combined bbox so the cursor grabs
    // the (min x, min y, min z) foot of the pasted content.
    const anchor = bb.isEmpty()
      ? new THREE.Vector3()
      : new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z);
    refreshSelectionVisuals();
    renderEntityInfo();

    // Enter paste-drag mode.
    const state = {
      objs: placed,
      origVerts: placed.map(o => o.em.vertices.map(v => v.clone())),
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
      const orig = state.origVerts[i];
      for (let k = 0; k < obj.em.vertices.length; k++) {
        obj.em.vertices[k].copy(orig[k]).add(shift);
      }
      try { obj.rebuild(); } catch (_) {}
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
    const count = _pasteState.objs.length;
    _pasteState = null;
    _teardownPasteListeners();
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
