/* AD.EdgeBatch — merge static objects' thick-line overlays (THREE.LineSegments2)
   into a few batched meshes (grouped by colour) to cut draw calls on big imports.

   Why: each object renders its faces (1 draw call) + a LineSegments2 thick-edge
   overlay (1 draw call). On a 1500-object city import that's ~3000 draw calls and
   the CPU-bound draw-call count caps the whole-model view at ~40fps. The faces
   must stay per-object (selection/picking/editing), but the edge overlays are
   pure linework — mergeable.

   How: the per-object o._thickEdges still exist (the source of truth) but are
   HIDDEN while batched; the batch is a handful of LineSegments2 (one per edge
   colour) holding every static object's segments in world space. An object that
   is edited / moved is EXCLUDED — its own overlay un-hides and tracks live — and
   the batch re-forms once edits settle. Camera navigation (orbit/pan/zoom) never
   moves objects, so the batch stays valid through the perf-critical case.

   Instances (non-identity group matrix) and section-cut views keep per-object
   overlays (transforms / per-layer cut weights), so the batch is skipped there. */
(function () {
  if (typeof window === 'undefined') return;
  const AD = window.AD = window.AD || {};
  const PX_WIDTH = Math.max(0.5, 0.20 / 0.25 * 1.1);   // matches AD.Layers BASE_WEIGHT

  const EB = AD.EdgeBatch = {
    enabled: true,
    _meshes: [],
    _excluded: new Set(),
    _settleTimer: null,
    _rafPending: false,

    _canBatch(o) {
      return o && !o.isInstance && o.group && o.group.visible && o._thickEdges &&
        o.edges && o.edges.geometry && o.edges.geometry.attributes.position &&
        o.edges.geometry.attributes.position.array.length > 0 && !this._excluded.has(o);
    },

    _teardown() {
      for (const m of this._meshes) {
        try { if (m.parent) m.parent.remove(m); m.geometry.dispose(); m.material.dispose(); } catch (_) {}
      }
      this._meshes = [];
    },

    rebuild() {
      try {
        if (typeof Model === 'undefined' || !Model.objects) return;
        this._teardown();
        // Shaded face style = no wireframe at all: hide every per-object thick
        // overlay and emit no batch. (setViewMode drives this and also hides the
        // thin o.edges; without this the merged batch kept the lines on screen.)
        if (Model.viewMode === 'shaded') {
          for (const o of Model.objects) if (o && o._thickEdges) o._thickEdges.visible = false;
          return;
        }
        // Sections restyle cut edges per-object — don't batch while one is active.
        const sectionActive = Model.sectionPlanes && Model.sectionPlanes.some(s => s && s.visible);
        // Group edit dims non-member objects per-object (edgeMat/thick-edge opacity);
        // the merged batch can't dim individuals, so show per-object overlays then.
        const groupEdit = (Model.activeGroupId != null) || Model.activeComponentSource;
        if (!this.enabled || sectionActive || groupEdit ||
            typeof THREE.LineSegments2 !== 'function' || typeof THREE.LineSegmentsGeometry !== 'function') {
          for (const o of Model.objects) if (o && o._thickEdges) o._thickEdges.visible = true;
          return;
        }
        const byColor = new Map();
        for (const o of Model.objects) {
          if (!this._canBatch(o)) { if (o && o._thickEdges) o._thickEdges.visible = true; continue; }
          o._thickEdges.visible = false;          // batch represents it now
          // Use the RESTING colour, not the live edgeMat.color — a selected object's
          // edgeMat is tinted blue, and if the batch is (re)built while it's selected
          // (e.g. right after a move) the blue gets baked in and lingers even after
          // deselect (the batch isn't rebuilt on selection change). Selection shows via
          // the separate silhouette/bbox overlay, so the batch must stay resting.
          let col = 0x1a1a1a;
          try {
            col = (typeof _restingEdgeColor === 'function')
              ? new THREE.Color(_restingEdgeColor(o)).getHex()
              : (o.edgeMat && o.edgeMat.color ? o.edgeMat.color.getHex() : 0x1a1a1a);
          } catch (_) { if (o.edgeMat && o.edgeMat.color) col = o.edgeMat.color.getHex(); }
          let arr = byColor.get(col); if (!arr) { arr = []; byColor.set(col, arr); }
          arr.push(o.edges.geometry.attributes.position.array);
        }
        const vp = (typeof renderer !== 'undefined' && renderer.domElement) ? renderer.domElement : null;
        const resW = vp ? vp.clientWidth : 1280, resH = vp ? vp.clientHeight : 720;
        const root = (typeof worldRoot !== 'undefined') ? worldRoot : (typeof scene !== 'undefined' ? scene : null);
        if (!root) return;
        for (const [col, arrs] of byColor) {
          let total = 0; for (const a of arrs) total += a.length;
          if (!total) continue;
          const pos = new Float32Array(total); let off = 0;
          for (const a of arrs) { pos.set(a, off); off += a.length; }
          const geom = new THREE.LineSegmentsGeometry();
          geom.setPositions(pos);
          const mat = new THREE.LineMaterial({ color: col, linewidth: PX_WIDTH,
            resolution: new THREE.Vector2(resW, resH), dashed: false });
          mat.depthTest = true; mat.depthWrite = false; mat.transparent = false;
          const mesh = new THREE.LineSegments2(geom, mat);
          mesh.computeLineDistances();
          mesh.raycast = function () {};          // render-only; never picked
          mesh.userData._edgeBatch = true;
          root.add(mesh);
          this._meshes.push(mesh);
        }
      } catch (_) {}
    },

    setResolution(w, h) { for (const m of this._meshes) { try { m.material.resolution.set(w, h); } catch (_) {} } },

    /* One object's overlay (re)built — edit/move/colour/import. Exclude it so its
       live overlay shows, drop the stale batch copy promptly (small edits), and
       re-batch everything after edits settle. */
    onObjectChanged(o) {
      if (!this.enabled || !o) return;
      // During a bulk scene swap (file open / undo restore / tab switch) every
      // addObject re-syncs an overlay; skip the per-object churn — the load ends
      // with applyLayerVisibility() which rebuilds the batch once over the final scene.
      if (typeof Model !== 'undefined' && Model._suppressAddRefresh) return;
      if (!this._excluded.has(o)) {
        this._excluded.add(o);
        if (o._thickEdges) o._thickEdges.visible = true;
        // Drop the stale batch copy this frame so the live overlay doesn't double-
        // draw over it. Coalesced via rAF, so a bulk edit touching many objects in
        // one frame still triggers just one rebuild (no 30-object cap → no 400ms ghost).
        if (!this._rafPending) {
          this._rafPending = true;
          requestAnimationFrame(() => { this._rafPending = false; if (this.enabled) this.rebuild(); });
        }
      }
      if (this._settleTimer) clearTimeout(this._settleTimer);
      this._settleTimer = setTimeout(() => { this._settleTimer = null; this._excluded.clear(); this.rebuild(); }, 400);
    },

    /* Pull a set of objects OUT of the batch right now (e.g. a move drag begins):
       their per-object overlays un-hide and track live, and the batch re-forms
       without them so there's no stale ghost. They re-join on the next settle. */
    excludeMany(objs) {
      if (!this.enabled || !objs || !objs.length) return;
      let changed = false;
      for (const o of objs) {
        if (o && !this._excluded.has(o)) { this._excluded.add(o); if (o._thickEdges) o._thickEdges.visible = true; changed = true; }
      }
      if (changed) this.rebuild();
    },

    scheduleFull() {     // structural change (delete/paste/import) → full re-batch
      if (typeof Model !== 'undefined' && Model._suppressAddRefresh) return;   // bulk swap → applyLayerVisibility rebuilds at the end
      if (this._settleTimer) clearTimeout(this._settleTimer);
      this._settleTimer = setTimeout(() => { this._settleTimer = null; this._excluded.clear(); this.rebuild(); }, 300);
    },
  };

  // Notify the batch whenever a per-object overlay is (re)built.
  function hookLayers() {
    if (!AD.Layers || typeof AD.Layers.syncThickEdges !== 'function') return setTimeout(hookLayers, 50);
    if (AD.Layers.syncThickEdges._ebHooked) return;
    const orig = AD.Layers.syncThickEdges.bind(AD.Layers);
    AD.Layers.syncThickEdges = function (o, w) { const r = orig(o, w); try { EB.onObjectChanged(o); } catch (_) {} return r; };
    AD.Layers.syncThickEdges._ebHooked = true;
  }
  hookLayers();

  // Structural changes (delete/paste/import/undo) don't all touch syncThickEdges,
  // so re-batch after each history commit too (debounced).
  function hookHistory() {
    if (typeof window.pushHistory !== 'function') return setTimeout(hookHistory, 50);
    if (window.pushHistory._ebHooked) return;
    const orig = window.pushHistory;
    window.pushHistory = function () { const r = orig.apply(this, arguments); try { EB.scheduleFull(); } catch (_) {} return r; };
    window.pushHistory._ebHooked = true;
  }
  hookHistory();

  window.addEventListener('resize', () => {
    const vp = (typeof renderer !== 'undefined' && renderer.domElement) ? renderer.domElement : null;
    if (vp) EB.setResolution(vp.clientWidth, vp.clientHeight);
  });
})();
