/* ============================================================================
   AD.Core — Turtle Drawing's architectural-drawing layer
   ----------------------------------------------------------------------------
   A thin IIFE namespace that rides on top of Turtle Drawing's existing engine
   (EditableMesh, SketchObject, Model, scene, camera, etc.). It adds:
     • Per-object metadata: { kind, material, struct, layer, cutBehavior, level }
     • A cut-plane → hatch/material assignment system
     • Scene-based section transitions (each Scene can own a section plane
       configuration and camera pose; switching scenes slides the section
       plane to reveal a different cut)
     • SVG-always vector rendering (phase 2)

   This file is the public API surface. Sub-modules plug themselves into
   `AD` as they load (ad/lines.js, ad/hatch.js, ad/poche.js, …).
   ============================================================================ */
(function () {
  if (typeof window === 'undefined') return;
  const AD = window.AD || (window.AD = {});
  AD.VERSION = '0.1.0';

  // -------------------------------------------------------------------- core
  AD.Core = {
    /* Ensure every SketchObject carries an .ad metadata block. Called on
       app boot and after import. */
    ensureMetadata(obj) {
      if (!obj) return;
      if (!obj.ad) {
        obj.ad = {
          kind: null,           // 'wall'|'slab'|'floor'|'roof'|'window'|…
          material: null,       // 'concrete'|'timber'|'brick'|…  (hatch key)
          struct: false,        // part of structural frame?
          layer: obj.layerId || null,
          cutBehavior: 'render', // 'cut'|'render'|'invisible'
          level: null,           // building level label (B1, 1F, 2F, …)
          hatchAt: new Map(),    // sectionPlaneId → hatchKey  (per-section override)
        };
      }
    },
    ensureAll() {
      if (typeof Model === 'undefined' || !Model.objects) return;
      for (const o of Model.objects) AD.Core.ensureMetadata(o);
    },
    /* Resolve the effective hatch for an object at a given section plane. */
    hatchFor(obj, sectionPlane) {
      if (!obj || !obj.ad) return null;
      if (sectionPlane && obj.ad.hatchAt && obj.ad.hatchAt.has(sectionPlane)) {
        return obj.ad.hatchAt.get(sectionPlane);
      }
      return obj.ad.material || null;
    },
  };

  // -------------------------------------------------------------------- UI
  AD.UI = AD.UI || {};

  // -------------------------------------------------------------------- boot
  window.addEventListener('DOMContentLoaded', () => {
    // Run once the base engine has initialised everything.
    setTimeout(() => {
      try { AD.Core.ensureAll(); } catch (_) {}
      if (AD.UI.install) AD.UI.install();
    }, 400);
  });
})();
