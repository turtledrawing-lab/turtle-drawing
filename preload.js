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
      if (replaced) return;
      // Otherwise: open in a new tab.
      if (T && typeof T.receiveDoc === 'function') {
        try {
          T.receiveDoc(payload.docJson);
          if (payload.filename && T.activeId && typeof T.rename === 'function') {
            T.rename(T.activeId, payload.filename);
          }
        } catch (err) { console.error(err); }
        return;
      }
      if (typeof window.openTT === 'function') {
        try { window.openTT(payload.docJson, payload.filename); } catch (err) { console.error(err); }
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
