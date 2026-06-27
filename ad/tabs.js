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
    // loadDocIntoScene is async (it chunks big files); catch both a sync throw
    // and an async rejection so a bad load never becomes an unhandled rejection.
    try {
      const p = loadDocIntoScene(doc);
      if (p && typeof p.catch === 'function') p.catch((err) => console.warn('[tabs] loadDocIntoScene failed', err));
    } catch (err) { console.warn('[tabs] loadDocIntoScene failed', err); }
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
  // Disk autosave (Electron) has no localStorage 5 MB quota; only truly huge
  // models are skipped (string-building cost), and the skip is surfaced.
  const FACE_CAP_DISK = 800000;
  const FACE_CAP_LOCALSTORAGE = 150000;
  const _rlog = (s) => { try { if (window.__TD_DEV) console.log('[recovery] ' + s); } catch (_) {} };
  let _autosaveGen = 0;          // bumped on every pushHistory (edit)
  let _lastSavedGen = -1;        // generation last written to the snapshot
  let _warnedSkip = false;       // surface "autosave off" once, not every 20s
  let _persistAsked = false;     // navigator.storage.persist() asked once
  Tabs._bumpAutosaveGen = function () { _autosaveGen++; };
  function _autosaveWriteGen() { return _autosaveGen; }
  function _askPersistOnce() {
    if (_persistAsked) return;
    _persistAsked = true;
    // Durable-storage request: without it Safari/Firefox may EVICT IndexedDB
    // (incl. the crash-recovery snapshot) under storage pressure.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
  }
  function _docHasContent(doc) {
    try {
      return !!(doc && ((doc.objects && doc.objects.length) ||
                        (doc.components && doc.components.length) ||
                        (doc.dimensions && doc.dimensions.length) ||
                        (doc.annotations && doc.annotations.length)));
    } catch (_) { return false; }
  }
  function _validSnap(snap) {
    return !!(snap && Array.isArray(snap.tabs) && snap.tabs.some(t => _docHasContent(t && t.doc)));
  }
  function _surfaceSkip(reason) {
    _rlog('autosave skipped: ' + reason);
    if (_warnedSkip) return;
    _warnedSkip = true;
    try { if (typeof setStatus === 'function') setStatus('msg', '⚠ 자동 저장 꺼짐 — ' + reason + ' (수동 저장(Cmd+S)을 권장합니다)'); } catch (_) {}
  }
  function _writeAutosave() {
    try {
      if (typeof Tabs.serialize !== 'function') return;
      // Re-arm the crash flag EVERY tick, before the gen skip — a session that
      // loads a doc and never edits would otherwise stay marked "clean" and
      // its crash would discard the recovery snapshot.
      try { localStorage.setItem(CLEAN_KEY, '0'); } catch (_) {}
      // Skip when nothing changed since the last snapshot — no point paying
      // the serialize cost (and on big models it's the dominant cost).
      if (_autosaveGen === _lastSavedGen) return;
      const disk = !!window.electronAutosaveWrite;
      // Web: IndexedDB has no meaningful quota at our sizes — same face cap
      // as the Electron disk path. localStorage stays as the LAST resort
      // (ancient browsers / IDB failure) with its old tight caps.
      const idb = !disk && !!(window.AD && AD.IDB && AD.IDB.available());
      // Pre-flight by face count BEFORE serialising: building a multi-MB string
      // every 20s is heavy churn (it was running right before a paint OOM).
      try {
        if (typeof Model !== 'undefined' && Model.objects) {
          let _f = 0;
          for (const o of Model.objects) if (o && o.em && o.em.faces) _f += o.em.faces.length;
          const cap = (disk || idb) ? FACE_CAP_DISK : FACE_CAP_LOCALSTORAGE;
          if (_f > cap) { _surfaceSkip('모델이 너무 큼 (' + _f.toLocaleString() + ' faces)'); return; }
        }
      } catch (_) {}
      const snap = Tabs.serialize();
      snap.tabs = (snap.tabs || []).filter(t => _docHasContent(t.doc));
      if (!snap.tabs.length) {
        if (disk) { try { window.electronAutosaveClear(); } catch (_) {} }
        if (idb) { try { AD.IDB.del('kv', 'autosave'); } catch (_) {} }
        try { localStorage.removeItem(RKEY); } catch (_) {}
        _lastSavedGen = _autosaveGen;
        return;
      }
      snap.ts = Date.now();
      const json = JSON.stringify(snap);
      if (disk) {
        const gen = _autosaveWriteGen();
        window.electronAutosaveWrite(json).then((ok) => { if (ok) _lastSavedGen = gen; });
        try { localStorage.setItem(CLEAN_KEY, '0'); } catch (_) {}
        return;
      }
      if (idb) {
        const gen = _autosaveWriteGen();
        AD.IDB.put('kv', 'autosave', json).then((ok) => { if (ok) _lastSavedGen = gen; });
        try { localStorage.setItem(CLEAN_KEY, '0'); } catch (_) {}
        _askPersistOnce();
        return;
      }
      // localStorage last resort (no IndexedDB): quota caps near 5 MB.
      if (json.length > 4500000) { _surfaceSkip('문서가 너무 큼 (' + (json.length / 1e6).toFixed(1) + ' MB)'); return; }
      localStorage.setItem(RKEY, json);
      localStorage.setItem(CLEAN_KEY, '0');
      _lastSavedGen = _autosaveGen;
    } catch (e) { _rlog('autosave failed: ' + (e && e.message)); }
  }
  function _promptAndRestore(snap, rawLen, onDone) {
    // onDone(status): 'restored' | 'declined' | 'failed'
    const n = snap.tabs.length;
    _rlog('unexpected previous exit — offering to restore ' + n + ' doc(s) (rawLen=' + rawLen + ')');
    if (window.__TD_RECOVERY_TEST) { _rlog('TEST mode: would prompt; not prompting/restoring'); onDone('declined'); return; }
    let when = ''; try { if (snap.ts) when = new Date(snap.ts).toLocaleTimeString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) {}
    const doRestore = () => {
      let restored = false;
      try { restored = !!Tabs.restoreSession(snap); }
      catch (e) { _rlog('restore failed: ' + (e && e.message)); }
      if (restored) { _rlog('restored ' + n + ' doc(s)'); onDone('restored'); }
      else {
        const ko = _recLang() === 'ko';
        try { window.alert(ko ? '복구에 실패했습니다. 스냅샷은 보존되어 다음 실행 때 다시 시도할 수 있습니다.' : 'Restore failed. The snapshot is kept so you can try again next launch.'); } catch (_) {}
        onDone('failed');
      }
    };
    _showRecoveryModal(n, when, doRestore, () => { _rlog('prompt result ok=false'); onDone('declined'); });
  }
  // Current UI language for the recovery prompt (mirrors ad/i18n.js td_menu_lang).
  function _recLang() {
    try { const v = localStorage.getItem('td_menu_lang'); if (v === 'ko' || v === 'en') return v; } catch (_) {}
    try { return (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en'; } catch (_) { return 'en'; }
  }
  /* Friendly "restore unsaved work?" card shown on a refresh/relaunch after an
     unexpected close (replaces the plain window.confirm). */
  function _showRecoveryModal(n, when, onRestore, onDiscard) {
    const ko = _recLang() === 'ko';
    const L = (k, e) => (ko ? k : e);
    let done = false;
    const finish = (fn) => { if (done) return; done = true; try { wrap.remove(); } catch (_) {} try { fn(); } catch (_) {} };
    const docs = ko ? ('저장 못 한 문서 ' + n + '개를 가지고 있어요.') : ("I'm holding " + n + ' unsaved document' + (n > 1 ? 's' : '') + '.');
    const wrap = document.createElement('div');
    wrap.id = 'tdRecoveryModal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;'
      + 'background:rgba(0,0,0,0.38);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);font:14px -apple-system,"SF Pro Text","Apple SD Gothic Neo",sans-serif;color:#1d1d1f;';
    // Speech-bubble layout: the turtle "says" the message — avatar on the left,
    // a rounded green bubble (with a left-pointing tail) to its right.
    const BUB = '#eef9ee';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:22px;width:min(500px,100%);box-shadow:0 18px 60px rgba(0,0,0,0.3);padding:20px;display:flex;gap:10px;align-items:flex-start;">'
      + '<img src="icons/icon-192.png" alt="" width="104" height="104" style="flex:none;margin-top:6px;" onerror="this.style.display=\'none\'">'
      + '<div style="position:relative;flex:1;min-width:0;background:' + BUB + ';border-radius:16px;padding:14px 16px;margin-left:4px;">'
      +   '<div style="position:absolute;left:-8px;top:40px;width:0;height:0;border-top:9px solid transparent;border-bottom:9px solid transparent;border-right:9px solid ' + BUB + ';"></div>'
      +   '<div style="font-weight:700;font-size:17px;line-height:1.4;">' + L('앗, 지난번엔 갑자기 닫혀버렸어요.', 'Oops — it closed unexpectedly last time.') + '</div>'
      +   '<div style="color:#5a6b5a;margin-top:8px;line-height:1.5;">' + docs + '</div>'
      +   (when ? '<div style="color:#9bb0a0;font-size:12px;margin-top:2px;">(' + when + L(' 작업', '') + ')</div>' : '')
      +   '<div style="font-weight:700;font-size:15px;margin-top:14px;">' + L('다시 불러올까요?', 'Restore it?') + '</div>'
      +   '<div style="display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:16px;">'
      +     '<button id="tdRecDiscard" style="border:none;background:transparent;color:#7e8e7e;font-weight:600;font-size:14px;cursor:pointer;padding:8px 6px;">' + L('버리기', 'Discard') + '</button>'
      +     '<button id="tdRecRestore" style="border:none;background:#99ff99;color:#0f3d18;font-weight:700;font-size:14px;cursor:pointer;padding:10px 20px;border-radius:11px;">' + L('복원하기', 'Restore') + '</button>'
      +   '</div>'
      + '</div>'
      + '</div>';
    wrap.querySelector('#tdRecRestore').addEventListener('click', () => finish(onRestore));
    wrap.querySelector('#tdRecDiscard').addEventListener('click', () => finish(onDiscard));
    document.body.appendChild(wrap);
  }
  function _maybeRecover() {
    let clean = null;
    try { clean = localStorage.getItem(CLEAN_KEY); } catch (_) {}
    try { localStorage.setItem(CLEAN_KEY, '0'); } catch (_) {}   // this session: not yet cleanly exited
    // ---- Disk autosave path (Electron). Claim returns an ARRAY (per-window
    // snapshots + claims orphaned by a crash during a previous prompt). File
    // presence alone means "not cleanly exited" — a clean close deletes the
    // file in the main process — so no localStorage clean-flag dependence.
    // restored → snapshot deleted; declined/failed → PARKED (kept on disk,
    // not re-offered) so one "Cancel" can never destroy the only copy.
    if (window.electronAutosaveClaim) {
      window.electronAutosaveClaim().then((claims) => {
        if (claims && !Array.isArray(claims)) claims = [claims];   // legacy single-claim shape
        if (!claims || !claims.length) { _legacyLocalStorageRecover(clean); return; }
        // Merge every claimed snapshot's tabs into one recovery session.
        const merged = { activeId: null, tabs: [], ts: 0 };
        const valid = [];
        for (const c of claims) {
          let snap = null; try { snap = JSON.parse(c.json); } catch (_) {}
          if (!_validSnap(snap)) {
            _rlog('a disk snapshot was invalid/empty — discarding it');
            window.electronAutosaveResolve(c.claimId, true);
            continue;
          }
          valid.push(c);
          merged.tabs.push(...snap.tabs.filter(t => _docHasContent(t && t.doc)));
          if (!merged.activeId) merged.activeId = snap.activeId;
          if (snap.ts && snap.ts > merged.ts) merged.ts = snap.ts;
        }
        if (!valid.length || !merged.tabs.length) return;
        const rawLen = valid.reduce((n, c) => n + c.json.length, 0);
        _promptAndRestore(merged, rawLen, (status) => {
          for (const c of valid) window.electronAutosaveResolve(c.claimId, status === 'restored');
        });
      }).catch(() => { _legacyLocalStorageRecover(clean); });
      return;
    }
    // ---- Web path: IndexedDB snapshot (written by _writeAutosave). Falls
    // through to the legacy localStorage snapshot if IDB is empty/broken so
    // sessions saved by an older build still recover.
    if (window.AD && AD.IDB && AD.IDB.available()) { _idbRecover(clean); return; }
    _legacyLocalStorageRecover(clean);
  }
  function _idbRecover(clean) {
    AD.IDB.get('kv', 'autosave').then((raw) => {
      _pruneParked();
      let snap = null; try { snap = JSON.parse(raw || 'null'); } catch (_) {}
      if (!_validSnap(snap)) { _legacyLocalStorageRecover(clean); return; }
      if (clean === '1') {
        _rlog('previous exit clean — discarding stale IDB recovery');
        AD.IDB.del('kv', 'autosave');
        return;
      }
      // Claim flag in localStorage (synchronous) so a second browser tab
      // doesn't double-prompt; the snapshot itself is never deleted by a claim.
      const CLAIM = RKEY + '_claim';
      try {
        const prev = parseInt(localStorage.getItem(CLAIM) || '0', 10);
        if (prev && Date.now() - prev < 60000) { _rlog('another tab is handling recovery'); return; }
        localStorage.setItem(CLAIM, String(Date.now()));
      } catch (_) {}
      _promptAndRestore(snap, (raw || '').length, (status) => {
        try { localStorage.removeItem(CLAIM); } catch (_) {}
        if (status === 'restored') { AD.IDB.del('kv', 'autosave'); return; }
        if (status === 'declined') {
          // PARK, never destroy — mirrors the Electron disk behavior: one
          // "Cancel" must not delete the only copy. Kept ~7 days, not
          // re-offered.
          AD.IDB.put('kv', 'parked-' + Date.now(), raw).then(() => AD.IDB.del('kv', 'autosave'));
          return;
        }
        // 'failed' → keep the snapshot for the next launch
      });
    }).catch(() => _legacyLocalStorageRecover(clean));
  }
  function _pruneParked() {
    try {
      AD.IDB.keys('kv').then((keys) => {
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        for (const k of (keys || [])) {
          if (typeof k === 'string' && k.indexOf('parked-') === 0) {
            const ts = parseInt(k.slice(7), 10);
            if (ts && ts < cutoff) AD.IDB.del('kv', k);
          }
        }
      });
    } catch (_) {}
  }
  function _legacyLocalStorageRecover(clean) {
    let raw = null;
    try { raw = localStorage.getItem(RKEY); } catch (_) {}
    let snap = null; try { snap = JSON.parse(raw || 'null'); } catch (_) {}
    if (!_validSnap(snap)) { _rlog('no recovery data'); return; }
    if (clean === '1') {
      _rlog('previous exit clean — discarding stale recovery');
      try { localStorage.removeItem(RKEY); } catch (_) {}
      return;
    }
    // Claim flag (not deletion!) so a second window doesn't double-prompt,
    // while the snapshot itself survives a failed restore.
    const CLAIM = RKEY + '_claim';
    try {
      const prev = parseInt(localStorage.getItem(CLAIM) || '0', 10);
      if (prev && Date.now() - prev < 60000) { _rlog('another window is handling recovery'); return; }
      localStorage.setItem(CLAIM, String(Date.now()));
    } catch (_) {}
    _promptAndRestore(snap, raw ? raw.length : 0, (status) => {
      try {
        // Declined → PARK into IndexedDB when available (was: hard delete).
        if (status === 'declined' && window.AD && AD.IDB && AD.IDB.available()) {
          try { AD.IDB.put('kv', 'parked-' + Date.now(), raw); } catch (_) {}
        }
        if (status !== 'failed') localStorage.removeItem(RKEY);
        localStorage.removeItem(CLAIM);
      } catch (_) {}
    });
  }
  function _setupAutosave() {
    try {
      window.addEventListener('beforeunload', (e) => {
        // Web only: warn before closing a tab with unsaved changes — browsers
        // give us no Save/Don't Save dialog, just this generic prompt, and
        // Electron has its own native quit-save guard in the main process.
        // Deliberately DON'T mark the exit clean when dirty: if the user
        // leaves anyway, the next launch still offers crash recovery.
        const isWeb = !window.electronSaveTT;
        const dirty = isWeb && Tabs.list.some(t => t && t.dirty);
        if (dirty) {
          try { _writeAutosave(); } catch (_) {}   // freshest possible snapshot
          try { e.preventDefault(); e.returnValue = ''; } catch (_) {}
          return;
        }
        try { localStorage.setItem(CLEAN_KEY, '1'); } catch (_) {}
      });
    } catch (_) {}
    try { document.addEventListener('visibilitychange', () => { if (document.hidden) _writeAutosave(); }); } catch (_) {}
    try { setInterval(_writeAutosave, AUTOSAVE_MS); } catch (_) {}
  }

  /* The on-disk path (window.currentFilePath) is PER-DOCUMENT state, but the
     global is per-window — without syncing it at every tab change, Cmd+S's
     silent-overwrite path writes the ACTIVE tab's content into the file some
     OTHER tab was opened from. Each tab carries its own filePath; this swaps
     the global to match the active tab. */
  function syncFilePath() {
    try {
      const t = Tabs.list.find(x => x.id === Tabs.activeId);
      window.currentFilePath = (t && t.filePath) || null;
    } catch (_) {}
  }
  Tabs._syncFilePath = syncFilePath;

  Tabs.save = function () {
    const t = Tabs.list.find(x => x.id === Tabs.activeId);
    if (!t) return;
    const d = currentDoc();
    if (d) t.doc = d;
    // Capture the active tab's on-disk path before any switch.
    try { t.filePath = window.currentFilePath || null; } catch (_) {}
  };
  Tabs.switchTo = function (id) {
    if (id === Tabs.activeId) return;
    Tabs.save();
    const t = Tabs.list.find(x => x.id === id);
    if (!t) return;
    Tabs.activeId = id;
    syncFilePath();
    if (t.doc) loadDoc(t.doc);
    else {
      // Empty tab — clear scene.
      if (typeof clearSceneAll === 'function') clearSceneAll();
      else if (typeof Model !== 'undefined') {
        for (const o of Model.objects.slice()) removeObject(o);
      }
    }
    Tabs._bumpAutosaveGen();
    render();
  };
  Tabs.newTab = function (name) {
    // Persist whatever the user has right now into the existing tab,
    // then create a fresh blank one.
    Tabs.save();
    const id = uid();
    Tabs.list.push({ id, name: name || ('Untitled ' + (Tabs.list.length + 1)), doc: null, filePath: null });
    Tabs.activeId = id;
    syncFilePath();   // new tab has no on-disk path — Cmd+S must show a dialog
    // Blank scene — clearSceneAll also resets undo history, dimensions,
    // annotations and components so Cmd+Z can't resurrect the previous doc.
    if (typeof clearSceneAll === 'function') {
      clearSceneAll();
    } else if (typeof Model !== 'undefined') {
      for (const o of Model.objects.slice()) removeObject(o);
      for (const sp of (Model.sectionPlanes || []).slice()) {
        try { removeSectionPlane(sp); } catch (_) {}
      }
      clearSelection();
      if (typeof renderLayers === 'function') renderLayers();
      if (typeof applyLayerVisibility === 'function') applyLayerVisibility();
    }
    // Seed the same starter entourage figure the first window opens with, so a
    // new tab matches first launch instead of opening empty. (_placeStarterEntourage
    // uses placeAt, which doesn't pushHistory → the new tab stays clean/undirty.)
    try { if (typeof window._placeStarterEntourage === 'function') window._placeStarterEntourage(); } catch (_) {}
    Tabs._bumpAutosaveGen();
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
      if (wasActive) syncFilePath();
      if (wasActive && cur && cur.doc) loadDoc(cur.doc);
    }
    Tabs._bumpAutosaveGen();
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
    return { activeId: Tabs.activeId, tabs: Tabs.list.map(t => ({ id: t.id, name: t.name, doc: t.doc || null, filePath: t.filePath || null })) };
  };
  Tabs.restoreSession = function (snap) {
    if (!snap || !Array.isArray(snap.tabs) || !snap.tabs.length) return false;
    Tabs.list = snap.tabs.map(t => ({ id: t.id || uid(), name: t.name || 'Untitled', doc: t.doc || null, filePath: t.filePath || null, dirty: true }));
    Tabs.activeId = snap.tabs.some(t => t.id === snap.activeId) ? snap.activeId : Tabs.list[0].id;
    syncFilePath();
    const cur = Tabs.list.find(x => x.id === Tabs.activeId);
    if (cur && cur.doc) loadDoc(cur.doc);
    Tabs._bumpAutosaveGen();
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
    // The render buffer + camera aspect are sized to the CANVAS rect, which
    // this shift just changed — re-run the engine's resize or the image stays
    // vertically squashed and snap hit-tests drift below the cursor.
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
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
        'background:' + (active ? '#99ff99' : 'rgba(255,255,255,0.18)') + ';' +
        'color:' + (active ? '#0f3d18' : '#444') + ';' +
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
    Tabs.list.push({ id, name, doc, filePath: null });
    Tabs.activeId = id;
    syncFilePath();   // no disk path yet — preload's menu-open handler stamps it after
    loadDoc(doc);
    Tabs._bumpAutosaveGen();
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
      // Tabs.save() builds the WHOLE document object (sceneToDoc) — running it
      // synchronously on every single edit froze big textured imports and fed
      // the OOM crash. Debounce it: the tab doc only needs to be fresh by the
      // time the user switches tabs / autosave fires, and Tabs.switchTo /
      // Tabs.serialize both call Tabs.save() themselves anyway.
      let saveTimer = 0;
      window.pushHistory = function (label) {
        orig(label);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { try { Tabs.save(); } catch (_) {} }, 1200);
        try { Tabs._bumpAutosaveGen(); } catch (_) {}
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
