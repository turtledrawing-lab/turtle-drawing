/* ============================================================================
   AD.Scenes — Bind section-plane state to Turtle Drawing's Scenes.
   ----------------------------------------------------------------------------
   Each Scene already captures camera pose. We extend it to also capture
   the active section plane(s). Switching Scenes animates both camera AND
   section plane so the cut "slides" to reveal a different section.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});

  function snapshotSectionPlanes() {
    if (typeof Model === 'undefined' || !Model.sectionPlanes) return [];
    return Model.sectionPlanes.map(sp => ({
      id: sp.id || (sp.id = 'SP' + Math.random().toString(36).slice(2, 7)),
      name: sp.name,
      nx: sp.plane.normal.x, ny: sp.plane.normal.y, nz: sp.plane.normal.z,
      c:  sp.plane.constant,
      enabled: !!sp.enabled,
      visible: sp.visible !== false,
    }));
  }

  function restoreSectionPlanes(snap, animated = true) {
    if (typeof Model === 'undefined' || !snap) return;
    const now = Model.sectionPlanes || [];
    // Map by id for fast lookup.
    const byId = new Map(snap.map(s => [s.id, s]));
    for (const sp of now) {
      const target = byId.get(sp.id);
      if (!target) continue;
      if (animated) {
        AD.Scenes._animations.push({
          sp,
          fromC: sp.plane.constant,
          toC: target.c,
          fromN: sp.plane.normal.clone(),
          toN: new THREE.Vector3(target.nx, target.ny, target.nz),
          enabled: target.enabled,
          visible: target.visible,
          t0: performance.now(),
          dur: 800,
        });
      } else {
        sp.plane.normal.set(target.nx, target.ny, target.nz);
        sp.plane.constant = target.c;
        sp.enabled = target.enabled;
        sp.visible = target.visible;
      }
    }
  }

  AD.Scenes = {
    _animations: [],

    /* Called by our boot wrapper right after Turtle Drawing's addScene /
       updateScene finishes. Attaches the snapshot onto the scene entry. */
    attachSnapshot(sceneEntry) {
      if (!sceneEntry) return;
      sceneEntry.adSection = snapshotSectionPlanes();
    },

    /* Called when activating a scene. Starts an animation over section
       planes that matches the camera animation. */
    applyFromScene(sceneEntry, animated = true) {
      if (!sceneEntry || !sceneEntry.adSection) return;
      restoreSectionPlanes(sceneEntry.adSection, animated);
    },

    /* Per-frame tick — call from the existing animate loop. */
    tick() {
      if (!this._animations.length) return;
      const now = performance.now();
      const kept = [];
      for (const a of this._animations) {
        const t = Math.min(1, (now - a.t0) / a.dur);
        const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;  // easeInOutQuad
        a.sp.plane.normal.copy(a.fromN).lerp(a.toN, e).normalize();
        a.sp.plane.constant = a.fromC + (a.toC - a.fromC) * e;
        if (t >= 1) {
          a.sp.enabled = a.enabled;
          a.sp.visible = a.visible;
        } else {
          kept.push(a);
        }
      }
      this._animations = kept;
    },
  };

  // Wrap the base engine's scene functions once they exist.
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (typeof addScene === 'function' && !addScene._adWrapped) {
        const origAdd = addScene;
        window.addScene = function (name) {
          origAdd(name);
          const last = Model.scenes[Model.scenes.length - 1];
          AD.Scenes.attachSnapshot(last);
        };
        window.addScene._adWrapped = true;
      }
      if (typeof updateScene === 'function' && !updateScene._adWrapped) {
        const origUpd = updateScene;
        window.updateScene = function (id) {
          origUpd(id);
          const s = Model.scenes.find(x => x.id === id);
          if (s) AD.Scenes.attachSnapshot(s);
        };
        window.updateScene._adWrapped = true;
      }
      if (typeof activateScene === 'function' && !activateScene._adWrapped) {
        const origAct = activateScene;
        window.activateScene = function (id, animated = true) {
          const s = Model.scenes.find(x => x.id === id);
          origAct(id, animated);
          if (s) AD.Scenes.applyFromScene(s, animated);
        };
        window.activateScene._adWrapped = true;
      }
      // Piggy-back on the renderer's animate loop for section plane tick.
      if (typeof renderer !== 'undefined' && !AD.Scenes._hooked) {
        const origRender = renderer.render.bind(renderer);
        renderer.render = function (scn, cam) {
          try { AD.Scenes.tick(); } catch (_) {}
          return origRender(scn, cam);
        };
        AD.Scenes._hooked = true;
      }
    }, 500);
  });
})();
