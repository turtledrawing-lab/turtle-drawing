// preload.js — bridges the native macOS menu (main process) into the
// renderer's existing handleAction() pipeline, and hides the in-HTML
// menu bar so the app looks like a regular native macOS app.
const { ipcRenderer } = require('electron');

// Expose native folder picker to the renderer. Returns { root, files: [{name, relPath, dataBase64}] }
window.electronPickFolder = async () => {
  try { return await ipcRenderer.invoke('pick-import-folder'); }
  catch (e) { console.error('[preload] pick-folder failed:', e); return null; }
};
window.electronPickFile = async (opts) => {
  try { return await ipcRenderer.invoke('pick-import-file', opts || {}); }
  catch (e) { console.error('[preload] pick-file failed:', e); return null; }
};
// System fonts for 3D text: list installed .ttf/.otf, and read one's bytes.
window.electronListFonts = async () => {
  try { return await ipcRenderer.invoke('list-system-fonts'); }
  catch (e) { console.error('[preload] list-fonts failed:', e); return []; }
};
window.electronReadFont = async (fontPath) => {
  try { return await ipcRenderer.invoke('read-font-file', fontPath); }
  catch (e) { console.error('[preload] read-font failed:', e); return null; }
};

// Safe .tt save: silent overwrite of knownPath (with .bak + atomic write),
// or a native save dialog when no path is known / Save As.
window.electronSaveTT = async (json, suggestedName, knownPath, forceDialog) => {
  try { return await ipcRenderer.invoke('save-tt-file', { json, suggestedName, knownPath, forceDialog }); }
  catch (e) { console.error('[preload] save-tt failed:', e); return { error: String(e) }; }
};
// Disk autosave (crash recovery) — atomic claim prevents double-restore.
window.electronAutosaveWrite = async (json) => {
  try { return await ipcRenderer.invoke('autosave-write', json); } catch (_) { return false; }
};
window.electronAutosaveClaim = async () => {
  try { return await ipcRenderer.invoke('autosave-claim'); } catch (_) { return null; }
};
window.electronAutosaveResolve = async (claimId, success) => {
  try { return await ipcRenderer.invoke('autosave-resolve', claimId, success); } catch (_) { return false; }
};
window.electronAutosaveClear = async () => {
  try { return await ipcRenderer.invoke('autosave-clear'); } catch (_) { return false; }
};
// Vendored binary assets (rhino3dm.wasm etc.) — renderer can't fetch file://.
window.electronReadVendor = async (name) => {
  try { return await ipcRenderer.invoke('read-vendor-file', name); } catch (_) { return null; }
};
// Always-on error journal (rotating td-errors.log in userData).
window.electronErrorLog = async (lines) => {
  try { return await ipcRenderer.invoke('error-journal-append', lines); } catch (_) { return false; }
};
// SketchUp .skp → glb, offline (macOS). bytes = Uint8Array; returns a Uint8Array
// (the glb) on success, or {error} / null. Renderer falls back to the web
// conversion server when this is absent or returns null.
window.electronConvertSKP = async (bytes, filename, srcPath) => {
  try { return await ipcRenderer.invoke('convert-skp', { bytes, filename, path: srcPath }); } catch (e) { return { error: String((e && e.message) || e) }; }
};
// Google Drive desktop OAuth (installed-app flow lives in main; GIS can't run
// on file://). Silent first, interactive on demand. Returns {access_token,…}.
window.electronGDriveSilent  = async () => { try { return await ipcRenderer.invoke('gdrive-token-silent'); } catch (_) { return null; } };
window.electronGDriveAuth    = async () => ipcRenderer.invoke('gdrive-auth');
window.electronGDriveSignout = async () => { try { return await ipcRenderer.invoke('gdrive-signout'); } catch (_) { return false; } };
// Official Google Picker in a dedicated https window (file:// can't run it).
// cfg: { token, apiKey, appId, mode, locale } → { id,name } | null | {failed}.
window.electronGDrivePicker = async (cfg) => { try { return await ipcRenderer.invoke('gdrive-open-picker', cfg); } catch (_) { return { failed: true }; } };

// Detach the current tab's document into a new top-level window.
window.electronDetachTab = async (docJson) => {
  try { return await ipcRenderer.invoke('detach-tab', { docJson }); }
  catch (e) { console.error('[preload] detach-tab failed:', e); return null; }
};
// Drop a tab at given screen coords — main routes to existing window or new.
window.electronTabDrop = async (docJson, screenX, screenY) => {
  try { return await ipcRenderer.invoke('tab-drop', { docJson, screenX, screenY }); }
  catch (e) { console.error('[preload] tab-drop failed:', e); return null; }
};
window.electronCloseSelf = () => { try { ipcRenderer.invoke('close-self'); } catch (_) {} };
window.electronToggleMaximize = () => { try { ipcRenderer.invoke('toggle-maximize'); } catch (_) {} };
// Receive a tab doc handed off from another window.
ipcRenderer.on('tab-receive', (_ev, docJson) => {
  if (window.AD && AD.Tabs && AD.Tabs.receiveDoc) {
    try { AD.Tabs.receiveDoc(docJson); } catch (e) { console.error(e); }
  }
});
// Renderer calls this on load to pick up a pending doc (if spawned via detach).
window.electronConsumePendingDoc = async () => {
  try { return await ipcRenderer.invoke('detach-consume'); }
  catch (_) { return null; }
};

window.addEventListener('DOMContentLoaded', () => {
  // 1) Hide the in-HTML menu bar and collapse its grid row so the viewport
  //    fills the space cleanly.
  const bar = document.getElementById('menubar');
  if (bar) bar.style.display = 'none';
  const appEl = document.getElementById('app');
  // Layout: 3 rows = 0(menu), 1fr(viewport+toolbar), 27px(status)
  if (appEl) appEl.style.gridTemplateRows = '0 1fr 27px';

  // 2) When the native menu dispatches an action, call the same
  //    handleAction() the HTML menu used to call.
  ipcRenderer.on('menu-action', (_ev, act, payload) => {
    if (act === 'file-open-data' && payload && payload.docJson != null) {
      const T = window.AD && window.AD.Tabs;
      // Remember the on-disk path AFTER the open call (openTT/receiveDoc null
      // the global for pathless opens) so Cmd+S silently overwrites this file
      // (with a .tt.bak backup) instead of prompting. Also stamp the tab.
      const stampPath = () => {
        try {
          window.currentFilePath = payload.fullPath || null;
          if (T && T.list && T.activeId) {
            const t = T.list.find(x => x.id === T.activeId);
            if (t) t.filePath = payload.fullPath || null;
          }
        } catch (_) {}
      };
      // If the active tab is Untitled and empty (no doc), REPLACE it
      // instead of creating another tab.
      let replaced = false;
      try {
        if (T && T.list && T.activeId) {
          const cur = T.list.find(x => x.id === T.activeId);
          const isUntitled = cur && /^Untitled/i.test(cur.name || '') && !cur.doc;
          if (isUntitled && typeof window.openTT === 'function') {
            window.openTT(payload.docJson, payload.filename);
            try {
              const doc = JSON.parse(payload.docJson);
              cur.doc = doc;
            } catch (_) {}
            replaced = true;
          }
        }
      } catch (err) { console.error(err); }
      if (replaced) { stampPath(); return; }
      // Otherwise: open in a new tab.
      if (T && typeof T.receiveDoc === 'function') {
        try {
          T.receiveDoc(payload.docJson);
          if (payload.filename && T.activeId && typeof T.rename === 'function') {
            T.rename(T.activeId, payload.filename);
          }
          stampPath();
        } catch (err) { console.error(err); }
        return;
      }
      if (typeof window.openTT === 'function') {
        try { window.openTT(payload.docJson, payload.filename); stampPath(); } catch (err) { console.error(err); }
      }
      return;
    }
    if (act === 'show-hold-to-quit-toast') {
      try { showHoldToQuitToast(); } catch (_) {}
      return;
    }
    if (act === 'start-onboarding') {
      try { if (typeof window._startOnboardingTour === 'function') window._startOnboardingTour(); } catch (_) {}
      return;
    }
    if (typeof window.handleAction === 'function') {
      try { window.handleAction(act); } catch (err) { console.error(err); }
    }
  });
  function showHoldToQuitToast() {
    let t = document.getElementById('hold-quit-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'hold-quit-toast';
      t.textContent = 'Hold ⌘Q to Quit';
      Object.assign(t.style, {
        position: 'fixed', left: '50%', top: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(28,28,30,0.92)', color: '#fff',
        font: '600 14px/1 -apple-system, "SF Pro Text", sans-serif',
        letterSpacing: '-0.01em',
        padding: '12px 18px', borderRadius: '10px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.3)',
        zIndex: '999999', pointerEvents: 'none',
        opacity: '0', transition: 'opacity 0.18s ease',
      });
      document.body.appendChild(t);
    }
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    clearTimeout(showHoldToQuitToast._h);
    showHoldToQuitToast._h = setTimeout(() => { t.style.opacity = '0'; }, 950);
  }
});
