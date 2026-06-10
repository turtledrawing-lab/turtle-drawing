/* ============================================================================
   AD.Layers — per-layer line weight (CAD-style).
   ----------------------------------------------------------------------------
   Extends Turtle Drawing's layer schema with a `lineWeight` field (mm,
   default 0.25) and adds a small numeric input to the Layers panel row
   so the user can set weights like CAD layer settings. The weights drive:
     • SVG export stroke-width
     • 3D preview: sets edgeMat.linewidth (best-effort — WebGL on most
       platforms caps linewidth to 1px, so visually we also modulate
       edge color opacity / darkness slightly so the hierarchy is
       perceptible while modelling).
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});

  // "Base" thin weight used everywhere in normal (non-cut) view.
  const BASE_WEIGHT = 0.20;      // mm
  const DEFAULT_WEIGHT = 0.50;   // mm — used for CUT edges when layer hasn't set one
  const WEIGHT_PRESETS = [
    0.0001, 0.003, 0.01, 0.05,
    0.10, 0.15, 0.25, 0.35, 0.50, 0.70, 1.00, 1.40,
  ];

  AD.Layers = {
    BASE_WEIGHT, DEFAULT_WEIGHT, WEIGHT_PRESETS,
    ensureWeights() {
      if (typeof Model === 'undefined' || !Model.layers) return;
      for (const L of Model.layers) {
        if (L.lineWeight == null) L.lineWeight = DEFAULT_WEIGHT;
        if (L.cutHatch  == null) L.cutHatch  = null;   // hatch id or null
      }
    },
    weightOf(layerId) {
      const L = (Model.layers || []).find(x => x.id === layerId);
      return L && L.lineWeight != null ? L.lineWeight : DEFAULT_WEIGHT;
    },
    cutHatchOf(layerId) {
      const L = (Model.layers || []).find(x => x.id === layerId);
      return L ? L.cutHatch : null;
    },
    /* In normal (non-cut) view, every object's edges render at the
       uniform BASE_WEIGHT. Per-layer lineWeight is reserved for CUT
       edges, applied by AD.SectionStyle when a section plane is active. */
    applyToScene() {
      if (typeof Model === 'undefined' || !Model.objects) return;
      for (const o of Model.objects) {
        if (!o || !o.edgeMat) continue;
        o.edgeMat.linewidth = 1;
        // Respect the object's resting edge color (DXF/CAD layer color, or the
        // active "Lines by Layer Color" mode) instead of forcing a flat dark
        // gray — otherwise this clobbers imported colors back to near-black.
        try {
          const _rest = (typeof _restingEdgeColor === 'function') ? _restingEdgeColor(o) : '#2a2a2a';
          o.edgeMat.color.set(_rest);
        } catch (_) {}
        o.edgeMat.needsUpdate = true;
        AD.Layers.syncThickEdges(o, BASE_WEIGHT);
      }
    },

    /* Rebuild (or tear down) the thick-line overlay for a single object.
       The overlay uses THREE.LineSegments2 with LineMaterial which
       supports variable pixel widths across platforms. */
    syncThickEdges(o, explicitWeight) {
      if (!o || !o.group) return;
      if (typeof THREE.LineSegments2 !== 'function' ||
          typeof THREE.LineMaterial  !== 'function' ||
          typeof THREE.LineSegmentsGeometry !== 'function') return;
      const src = o.edges && o.edges.geometry && o.edges.geometry.attributes.position;
      if (!src) { removeThick(o); return; }
      const positions = new Float32Array(src.array.length);
      positions.set(src.array);
      const weight = (explicitWeight != null)
        ? explicitWeight
        : BASE_WEIGHT;
      const pxWidth = Math.max(0.5, weight / 0.25 * 1.1);

      if (!o._thickEdges) {
        const geom = new THREE.LineSegmentsGeometry();
        geom.setPositions(Array.from(positions));
        const vp = renderer && renderer.domElement;
        // Seed the overlay's color from the object's edge material so DXF/CAD
        // layer colors (and "Lines by Layer Color") show through. The thin
        // o.edges this overlay replaces are recolored by _restingEdgeColor;
        // the overlay must match or every line renders the same near-black.
        const _seedColor = (o.edgeMat && o.edgeMat.color) ? o.edgeMat.color.getHex() : 0x1a1a1a;
        const mat = new THREE.LineMaterial({
          color: _seedColor,
          linewidth: pxWidth,
          resolution: new THREE.Vector2(vp ? vp.clientWidth : 1280, vp ? vp.clientHeight : 720),
          dashed: false,
        });
        // Force z-testing so the export's pixel-based HLR sees proper
        // hidden-line output (LineMaterial's default transparent=true
        // and depthWrite=false can let lines leak through faces).
        mat.depthTest = true;
        mat.depthWrite = false;
        mat.transparent = false;
        const mesh = new THREE.LineSegments2(geom, mat);
        mesh.computeLineDistances();
        o.group.add(mesh);
        o._thickEdges = mesh;
        // Hide the thin line so they don't compete
        if (o.edges) o.edges.visible = false;
      } else {
        const m = o._thickEdges;
        m.geometry.dispose();
        const g = new THREE.LineSegmentsGeometry();
        g.setPositions(Array.from(positions));
        m.geometry = g;
        m.material.linewidth = pxWidth;
        // Keep the overlay color in sync with the object's edge material.
        if (o.edgeMat && o.edgeMat.color) m.material.color.copy(o.edgeMat.color);
        const vp = renderer && renderer.domElement;
        if (vp) m.material.resolution.set(vp.clientWidth, vp.clientHeight);
        m.material.needsUpdate = true;
        m.computeLineDistances();
      }
    },
  };

  function removeThick(o) {
    if (o && o._thickEdges) {
      try { o.group.remove(o._thickEdges); } catch (_) {}
      try { o._thickEdges.geometry.dispose(); } catch (_) {}
      try { o._thickEdges.material.dispose(); } catch (_) {}
      o._thickEdges = null;
      if (o.edges) o.edges.visible = true;
    }
  }

  /* Hook the layer panel render to add a weight control per row. */
  function patchRenderLayers() {
    if (typeof renderLayers !== 'function' || renderLayers._adPatched) return;
    const orig = renderLayers;
    window.renderLayers = function () {
      AD.Layers.ensureWeights();
      orig();
      // Per-row line-weight + cut-hatch controls are now rendered by the
      // expandable sub-row in renderLayers (turtle_drawing.html). Skip the
      // legacy in-row injection so the layer panel stays narrow.
      return;
      /* The ~60-line legacy in-row injection that followed this return was
         unreachable dead code (superseded by the expandable sub-row in
         turtle_drawing.html's renderLayers) — removed. */
    };
    window.renderLayers._adPatched = true;
  }

  /* Keep new objects in sync with their layer's weight. */
  function patchAddObject() {
    if (typeof addObject !== 'function' || addObject._adPatched) return;
    const orig = addObject;
    window.addObject = function (obj) {
      orig(obj);
      try { AD.Layers.applyToScene(); } catch (_) {}
    };
    window.addObject._adPatched = true;
  }

  /* Re-sync the thick-line overlay whenever an object's geometry changes
     (rebuild is called from every push/pull, move, draw…). */
  function patchSketchObjectRebuild() {
    if (typeof SketchObject !== 'function') return;
    const proto = SketchObject.prototype;
    if (!proto || proto.rebuild._adPatched) return;
    const origRebuild = proto.rebuild;
    proto.rebuild = function () {
      origRebuild.apply(this, arguments);
      try { AD.Layers.syncThickEdges(this); } catch (_) {}
    };
    proto.rebuild._adPatched = true;
  }

  /* LineMaterial needs the viewport resolution to scale stroke width. */
  function hookResize() {
    window.addEventListener('resize', () => {
      if (!renderer || !renderer.domElement) return;
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      for (const o of (Model.objects || [])) {
        if (o._thickEdges && o._thickEdges.material &&
            o._thickEdges.material.resolution) {
          o._thickEdges.material.resolution.set(w, h);
        }
      }
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      patchRenderLayers();
      patchAddObject();
      patchSketchObjectRebuild();
      hookResize();
      AD.Layers.ensureWeights();
      AD.Layers.applyToScene();
      if (typeof renderLayers === 'function') renderLayers();
    }, 500);
  });
})();
