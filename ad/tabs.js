/* ============================================================================
   AD.Tabs — multi-document tab bar.
   ----------------------------------------------------------------------------
   Each tab holds one Turtle Drawing "document" (same JSON shape as the
   .tt save format). Switching tabs serialises the current scene into
   the active tab, then loads the target tab's document into the scene.
   A blank "+" tab creates a fresh document; each tab carries a close
   button; middle-click or Cmd+W closes.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});

  const Tabs = {
    list: [],          // [{ id, name, doc }]
    activeId: null,
    _boot: false,
  };
  AD.Tabs = Tabs;

  function uid() { return 't' + Math.random().toString(36).slice(2, 8); }

  function currentDoc() {
    try { return (typeof sceneToDoc === 'function') ? sceneToDoc() : null; }
    catch (err) { console.warn('[tabs] sceneToDoc failed', err); return null; }
  }
  function loadDoc(doc) {
    if (!doc) return;
    try { loadDocIntoScene(doc); }
    catch (err) { console.warn('[tabs] loadDocIntoScene failed', err); }
  }

  /* ---------- Crash recovery + autosave (P0-2) -----------------------
     Tabs only live in memory, so a crash / force-quit / power-loss loses
     everything since the last manual .tt save. We periodically snapshot the
     whole session (all tabs) to localStorage and, on a launch that follows an
     UNEXPECTED exit, offer to restore it. A normal close sets a "clean exit"
     flag (beforeunload), so a tidy quit never prompts.
  ------------------------------------------------------------------- */
  const RKEY = 'turtle_recovery_v1';
  const CLEAN_KEY = 'turtle_clean_exit_v1';
  const AUTOSAVE_MS = 20000;
  const _rlog = (s) => { try { if (window.__TD_DEV) console.log('[recovery] ' + s); } catch (_) {} };
  function _docHasContent(doc) {
    try {
      return !!(doc && ((doc.objects && doc.objects.length) ||
                        (doc.components && doc.components.length) ||
                        (doc.dimensions && doc.dimensions.length) ||
                        (doc.annotations && doc.annotations.length)));
    } catch (_) { return false; }
  }
  function _writeAutosave() {
    try {
      if (typeof Tabs.serialize !== 'function') return;
      // Pre-flight: a very large model serialises past the 4.5 MB cap below and
      // gets skipped anyway — but building that multi-MB string every 20s is
      // heavy memory churn (it was running right before the paint OOM crash).
      // Skip cheaply by face count BEFORE serialising.
      try {
        if (typeof Model !== 'undefined' && Model.objects) {
          let _f = 0;
          for (const o of Model.objects) if (o && o.em && o.em.faces) _f += o.em.faces.length;
          if (_f > 150000) { _rlog('model too large to autosave (' + _f + ' faces); skipped'); return; }
        }
      } catch (_) {}
      const snap = Tabs.serialize();
      snap.tabs = (snap.tabs || []).filter(t => _docHasContent(t.doc));
      if (!snap.tabs.length) { try { localStorage.removeItem(RKEY); } catch (_) {} return; }
      snap.ts = Date.now();
      const json = JSON.stringify(snap);
      // localStorage caps near 5 MB; very large docs (e.g. imported textures)
      // can blow the quota. Skip rather than throw — don't disrupt editing.
      if (json.length > 4500000) { _rlog('session too large to autosave (' + json.length + ' bytes); skipped'); return; }
      localStorage.setItem(RKEY, json);
      localStorage.setItem(CLEAN_KEY, '0');
    } catch (e) { _rlog('autosave failed: ' + (e && e.message)); }
  }
  function _maybeRecover() {
    let raw = null, clean = null;
    try { raw = localStorage.getItem(RKEY); } catch (_) {}
    try { clean = localStorage.getItem(CLEAN_KEY); } catch (_) {}
    try { localStorage.setItem(CLEAN_KEY, '0'); } catch (_) {}   // this session: not yet cleanly exited
    let snap = null; try { snap = JSON.parse(raw || 'null'); } catch (_) {}
    if (!snap || !snap.tabs || !snap.tabs.length) { _rlog('no recovery data'); return; }
    // Claim the recovery data immediately (clear it before doing anything else)
    // so a second window or a re-entry can't double-handle the same snapshot.
    try { localStorage.removeItem(RKEY); } catch (_) {}
    if (clean === '1') { _rlog('previous exit clean — discarding stale recovery'); return; }
    const n = snap.tabs.length;
    _rlog('unexpected previous exit — offering to restore ' + n + ' doc(s) (rawLen=' + (raw ? raw.length : 0) + ')');
    if (window.__TD_RECOVERY_TEST) { _rlog('TEST mode: would prompt; not prompting/restoring'); return; }
    let when = ''; try { if (snap.ts) when = new Date(snap.ts).toLocaleString(); } catch (_) {}
    const msg = 'Turtle Drawing didn’t close normally last time.\n\nRestore ' + n + ' unsaved document' + (n > 1 ? 's' : '') + (when ? '\n(from ' + when + ')' : '') + '?';
    let ok = false; try { ok = window.confirm(msg); } catch (_) {}
    _rlog('prompt result ok=' + ok);
    if (ok) { try { Tabs.restoreSession(snap); _rlog('restored ' + n + ' doc(s)'); } catch (e) { _rlog('restore failed: ' + (e && e.message)); } }
  }
  function _setupAutosave() {
    try { window.addEventListener('beforeunload', () => { try { localStorage.setItem(CLEAN_KEY, '1'); } catch (_) {} }); } catch (_) {}
    try { document.addEventListener('visibilitychange', () => { if (document.hidden) _writeAutosave(); }); } catch (_) {}
    try { setInterval(_writeAutosave, AUTOSAVE_MS); } catch (_) {}
  }

  Tabs.save = function () {
    const t = Tabs.list.find(x => x.id === Tabs.activeId);
    if (!t) return;
    const d = currentDoc();
    if (d) t.doc = d;
  };
  Tabs.switchTo = function (id) {
    if (id === Tabs.activeId) return;
    Tabs.save();
    const t = Tabs.list.find(x => x.id === id);
    if (!t) return;
    Tabs.activeId = id;
    if (t.doc) loadDoc(t.doc);
    else {
      // Empty tab — clear scene.
      if (typeof clearSceneAll === 'function') clearSceneAll();
      else if (typeof Model !== 'undefined') {
        for (const o of Model.objects.slice()) removeObject(o);
      }
    }
    render();
  };
  Tabs.newTab = function (name) {
    // Persist whatever the user has right now into the existing tab,
    // then create a fresh blank one.
    Tabs.save();
    const id = uid();
    Tabs.list.push({ id, name: name || ('Untitled ' + (Tabs.list.length + 1)), doc: null });
    Tabs.activeId = id;
    // Blank scene.
    if (typeof Model !== 'undefined') {
      for (const o of Model.objects.slice()) removeObject(o);
      for (const sp of (Model.sectionPlanes || []).slice()) {
        try { removeSectionPlane(sp); } catch (_) {}
      }
      clearSelection();
      if (typeof renderLayers === 'function') renderLayers();
      if (typeof applyLayerVisibility === 'function') applyLayerVisibility();
    }
    render();
  };
  Tabs.close = function (id) {
    const idx = Tabs.list.findIndex(x => x.id === id);
    if (idx < 0) return;
    const target = Tabs.list[idx];
    // Confirm if there are unsaved changes.
    if (target && target.dirty) {
      const ok = window.confirm(`"${target.name}" has unsaved changes. Close anyway?`);
      if (!ok) return;
    }
    // If closing the active tab, switch to a neighbour first.
    const wasActive = id === Tabs.activeId;
    if (wasActive && Tabs.list.length === 1) {
      // Closing the last tab → close the window.
      if (window.electronCloseSelf) {
        try { window.electronCloseSelf(); return; }
        catch (_) {}
      }
      try { window.close(); return; } catch (_) {}
      // Fallback: reset to blank if window can't close.
      const t = Tabs.list[0];
      t.name = 'Untitled 1'; t.doc = null;
      if (typeof Model !== 'undefined') {
        for (const o of Model.objects.slice()) removeObject(o);
      }
      render();
      return;
    }
    if (wasActive) {
      const neighbour = Tabs.list[idx + 1] || Tabs.list[idx - 1];
      if (neighbour) Tabs.activeId = neighbour.id;
    }
    Tabs.list.splice(idx, 1);
    if (Tabs.activeId && Tabs.activeId !== id) {
      const cur = Tabs.list.find(x => x.id === Tabs.activeId);
      if (cur && cur.doc) loadDoc(cur.doc);
    }
    render();
  };
  Tabs.rename = function (id, newName) {
    const t = Tabs.list.find(x => x.id === id);
    if (!t || !newName) return;
    t.name = newName;
    render();
  };

  /* Full-session serialize/restore (every tab) — used for crash recovery. */
  Tabs.serialize = function () {
    try { Tabs.save(); } catch (_) {}   // flush the active tab's live scene into its doc
    return { activeId: Tabs.activeId, tabs: Tabs.list.map(t => ({ id: t.id, name: t.name, doc: t.doc || null })) };
  };
  Tabs.restoreSession = function (snap) {
    if (!snap || !Array.isArray(snap.tabs) || !snap.tabs.length) return false;
    Tabs.list = snap.tabs.map(t => ({ id: t.id || uid(), name: t.name || 'Untitled', doc: t.doc || null, dirty: true }));
    Tabs.activeId = snap.tabs.some(t => t.id === snap.activeId) ? snap.activeId : Tabs.list[0].id;
    const cur = Tabs.list.find(x => x.id === Tabs.activeId);
    if (cur && cur.doc) loadDoc(cur.doc);
    render();
    return true;
  };

  /* ---------- Rendering ---------------------------------------------- */
  function ensureBar() {
    let bar = document.getElementById('adTabBar');
    if (bar) return bar;
    const vp = document.getElementById('viewport');
    if (!vp) return null;
    bar = document.createElement('div');
    bar.id = 'adTabBar';
    bar.style.cssText =
      'position:absolute;top:0;left:0;right:0;height:28px;display:flex;' +
      'align-items:flex-end;padding:0 6px;gap:2px;z-index:500;' +
      'font:11px -apple-system,"SF Pro Text",sans-serif;color:#333;' +
      // Truly translucent: no opaque overlay, just a faint tint + heavy blur.
      'background:rgba(240,240,245,0.18);' +
      'backdrop-filter:saturate(180%) blur(40px);' +
      '-webkit-backdrop-filter:saturate(180%) blur(40px);' +
      'border-bottom:0.5px solid rgba(0,0,0,0.08);user-select:none;' +
      // Allow window-drag from the bar; child interactive elements opt out
      // via `-webkit-app-region:no-drag` set in render().
      '-webkit-app-region:drag;';
    // Double-click anywhere on the empty bar area → maximize/restore.
    bar.addEventListener('dblclick', (e) => {
      if (e.target !== bar) return; // only when clicking empty bar bg
      try { if (window.electronToggleMaximize) window.electronToggleMaximize(); } catch (_) {}
    });
    vp.appendChild(bar);
    // Shift the canvases down by the bar height so tabs don't cover them.
    const can = document.getElementById('threeCanvas');
    const ovl = document.getElementById('overlay');
    if (can) { can.style.top = '28px'; can.style.height = 'calc(100% - 28px)'; }
    if (ovl) { ovl.style.top = '28px'; ovl.style.height = 'calc(100% - 28px)'; }
    return bar;
  }

  function render() {
    const bar = ensureBar();
    if (!bar) return;
    bar.innerHTML = '';
    for (const t of Tabs.list) {
      const tab = document.createElement('div');
      const active = t.id === Tabs.activeId;
      tab.dataset.id = t.id;
      tab.style.cssText =
        'display:flex;align-items:center;gap:4px;height:22px;padding:0 10px;' +
        'border-radius:6px 6px 0 0;border:0.5px solid rgba(0,0,0,0.12);' +
        'border-bottom:none;cursor:pointer;max-width:160px;' +
        '-webkit-app-region:no-drag;' +
        'backdrop-filter:blur(20px) saturate(180%);' +
        '-webkit-backdrop-filter:blur(20px) saturate(180%);' +
        'background:' + (active ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)') + ';' +
        'color:' + (active ? '#0a84ff' : '#444') + ';' +
        'font-weight:' + (active ? '600' : '400') + ';';
      const name = document.createElement('span');
      name.textContent = t.name;
      name.title = t.name;
      name.style.cssText =
        'overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:120px;';
      tab.appendChild(name);
      const close = document.createElement('span');
      close.textContent = '×';
      close.title = 'Close tab';
      close.style.cssText =
        'font-size:13px;line-height:12px;color:#888;padding:0 2px;border-radius:3px;';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        Tabs.close(t.id);
      });
      tab.appendChild(close);
      tab.addEventListener('click', () => Tabs.switchTo(t.id));
      tab.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const n = prompt && prompt('Tab name', t.name);
        if (n) Tabs.rename(t.id, n);
      });
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); Tabs.close(t.id); }
      });
      // Drag a tab out of the window → detach into a new window.
      tab.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (!window.electronTabDrop && !window.electronDetachTab) return;
        const startX = e.clientX, startY = e.clientY;
        let dragging = false;
        const onMove = (ev) => {
          if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) {
            dragging = true;
            document.body.style.cursor = 'grabbing';
          }
        };
        const onUp = (ev) => {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          document.body.style.cursor = '';
          if (!dragging) return;
          const outside = ev.clientX < 0 || ev.clientY < 0 ||
                          ev.clientX > window.innerWidth ||
                          ev.clientY > window.innerHeight;
          if (!outside) return;
          _dropTabAtScreen(t.id, ev.screenX, ev.screenY);
        };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
      });
      bar.appendChild(tab);
    }
    // "+" button to add a new tab.
    const add = document.createElement('div');
    add.textContent = '+';
    add.title = 'New tab (Cmd+T)';
    add.style.cssText =
      'display:flex;align-items:center;justify-content:center;height:22px;width:24px;' +
      'border-radius:6px 6px 0 0;border:0.5px solid transparent;cursor:pointer;' +
      '-webkit-app-region:no-drag;color:#666;font-size:14px;';
    add.addEventListener('mouseenter', () => add.style.background = 'rgba(0,0,0,0.05)');
    add.addEventListener('mouseleave', () => add.style.background = 'transparent');
    add.addEventListener('click', () => Tabs.newTab());
    bar.appendChild(add);
  }

  function _detachTab(id) {
    if (!window.electronDetachTab) return;
    const t = Tabs.list.find(x => x.id === id);
    if (!t) return;
    if (id === Tabs.activeId) Tabs.save();
    const doc = t.doc || (id === Tabs.activeId ? currentDoc() : null);
    if (!doc) return;
    try { window.electronDetachTab(JSON.stringify(doc)); } catch (_) {}
    Tabs.close(id);
  }

  function _dropTabAtScreen(id, sx, sy) {
    const t = Tabs.list.find(x => x.id === id);
    if (!t) return;
    if (id === Tabs.activeId) Tabs.save();
    const doc = t.doc || (id === Tabs.activeId ? currentDoc() : null);
    if (!doc) return;
    const json = JSON.stringify(doc);
    const wasLast = Tabs.list.length === 1;
    const api = window.electronTabDrop
      ? window.electronTabDrop(json, sx, sy)
      : window.electronDetachTab(json);
    Promise.resolve(api).then((res) => {
      // If this was the only tab AND the doc was handed to an existing
      // window (not a freshly-spawned one), close this window entirely.
      if (wasLast && res && res.target === 'existing' && window.electronCloseSelf) {
        window.electronCloseSelf();
        return;
      }
      Tabs.close(id);
    });
  }

  // Called by preload when another window hands us a tab doc.
  Tabs.receiveDoc = function (docJson) {
    if (!docJson) return;
    let doc;
    try { doc = typeof docJson === 'string' ? JSON.parse(docJson) : docJson; }
    catch (_) { return; }
    Tabs.save();
    const id = uid();
    const name = 'Untitled ' + (Tabs.list.length + 1);
    Tabs.list.push({ id, name, doc });
    Tabs.activeId = id;
    loadDoc(doc);
    render();
  };

  /* ---------- Init --------------------------------------------------- */
  function boot() {
    if (Tabs._boot) return;
    Tabs._boot = true;
    ensureBar();
    // Seed with the current scene as the first tab.
    const id = uid();
    Tabs.list.push({ id, name: 'Untitled 1', doc: null });
    Tabs.activeId = id;
    render();

    // If this window was spawned via tab detach, load the pending doc.
    // Otherwise (a normal launch) check for an unsaved session to recover.
    if (window.electronConsumePendingDoc) {
      window.electronConsumePendingDoc().then((docJson) => {
        if (docJson) {
          try {
            const doc = typeof docJson === 'string' ? JSON.parse(docJson) : docJson;
            loadDoc(doc);
            const cur = Tabs.list.find(x => x.id === Tabs.activeId);
            if (cur) cur.doc = doc;
          } catch (err) { console.warn('[tabs] consume pending doc', err); }
          return;                                  // detached-tab window — no recovery prompt
        }
        try { _maybeRecover(); } catch (_) {}
      }).catch(() => { try { _maybeRecover(); } catch (_) {} });
    } else {
      try { _maybeRecover(); } catch (_) {}
    }

    // Auto-save current tab's doc on every history push so switching
    // tabs later restores what the user had.
    if (typeof pushHistory === 'function' && !pushHistory._adTabsWrapped) {
      const orig = pushHistory;
      window.pushHistory = function (label) {
        orig(label);
        try { Tabs.save(); } catch (_) {}
      };
      window.pushHistory._adTabsWrapped = true;
    }

    // Cmd/Ctrl+T → new tab
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        Tabs.newTab();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
        if (Tabs.activeId) { e.preventDefault(); Tabs.close(Tabs.activeId); }
      }
    });

    _setupAutosave();
  }

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(boot, 700);
  });
})();
