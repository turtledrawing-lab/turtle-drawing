/* ============================================================================
   ad/web_shell.js — browser-only shell glue (PWA + resilience).
   ----------------------------------------------------------------------------
   Loaded in every build but self-disables under Electron (the preload bridge
   runs before any page script, so window.electronSaveTT is a reliable gate).

   1. Service-worker registration + "new version" toast: the SW (web/sw.js,
      copied to the web root by build/web.sh) caches per-deploy; when a new
      deploy's worker is WAITING we show a small toast — the user opts into
      the reload, nothing swaps mid-session.
   2. PWA file handling (Chromium): an installed app registered for .tt gets
      double-clicked files via launchQueue — open them and keep the writable
      handle so Cmd+S silently overwrites (same as File ▸ Open).
   3. WebGL context loss: GPU resets kill the canvas but NOT the JS scene —
      bump the autosave generation so the next tick captures the live model,
      tell the user, and offer a one-click reload when the context returns.
   ============================================================================ */
(function () {
  if (window.electronSaveTT) return;   // Electron: native shell handles all of this

  /* ---------- 1. Service worker + update toast ------------------------- */
  function _toast(msg, actionLabel, onAction) {
    let el = document.getElementById('tdWebToast');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'tdWebToast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:99999;' +
      'background:rgba(28,28,30,0.92);color:#fff;padding:10px 14px;border-radius:10px;' +
      'font:13px -apple-system,"SF Pro Text",sans-serif;display:flex;gap:12px;align-items:center;' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.25);backdrop-filter:blur(8px);';
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (actionLabel) {
      const btn = document.createElement('button');
      btn.textContent = actionLabel;
      btn.style.cssText =
        'background:#0a84ff;color:#fff;border:none;border-radius:6px;padding:5px 12px;' +
        'font-size:12px;font-weight:600;cursor:pointer;';
      btn.onclick = () => { try { onAction(); } catch (_) {} };
      el.appendChild(btn);
    }
    const x = document.createElement('span');
    x.textContent = '×';
    x.style.cssText = 'cursor:pointer;color:#999;font-size:15px;padding:0 2px;';
    x.onclick = () => el.remove();
    el.appendChild(x);
    document.body.appendChild(el);
  }

  function _watchForUpdate(reg) {
    const offer = (worker) => {
      _toast('새 버전이 준비되었습니다.', '새로고침', () => {
        try { worker.postMessage('td-skip-waiting'); } catch (_) {}
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
      });
    });
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        _watchForUpdate(reg);
        // One controlled reload when the new worker takes over.
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloaded) return;
          reloaded = true;
          location.reload();
        });
      }).catch(() => {});   // no SW (e.g. plain http dev server quirk) — app works without it
    });
  }

  /* ---------- 2. PWA .tt file handling (Chromium installed app) -------- */
  if ('launchQueue' in window) {
    try {
      window.launchQueue.setConsumer(async (params) => {
        if (!params || !params.files || !params.files.length) return;
        const h = params.files[0];
        let text, name;
        try {
          const f = await h.getFile();
          text = await f.text();
          name = f.name;
        } catch (_) { return; }
        // The big inline script defines openTT after the ad/ modules — and a
        // launch can race the boot. Poll briefly until the app is ready.
        const tryOpen = (left) => {
          if (typeof window.openTT === 'function' && window.AD && AD.Tabs && AD.Tabs._boot) {
            try {
              window.openTT(text, name);
              const T = AD.Tabs;
              const tab = T.list.find((x) => x.id === T.activeId);
              if (tab) tab._fsHandle = h;   // Cmd+S overwrites the launched file
            } catch (_) {}
            return;
          }
          if (left > 0) setTimeout(() => tryOpen(left - 1), 250);
        };
        tryOpen(40);
      });
    } catch (_) {}
  }

  /* ---------- 3. WebGL context loss ------------------------------------ */
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      const can = document.getElementById('threeCanvas');
      if (!can) return;
      can.addEventListener('webglcontextlost', (e) => {
        try { e.preventDefault(); } catch (_) {}   // allow the browser to restore
        // The JS scene is intact — make sure the next autosave tick snapshots it.
        try { if (window.AD && AD.Tabs && AD.Tabs._bumpAutosaveGen) AD.Tabs._bumpAutosaveGen(); } catch (_) {}
        _toast('그래픽 컨텍스트가 끊겼습니다 — 작업 내용은 자동 저장됩니다.', null, null);
      });
      can.addEventListener('webglcontextrestored', () => {
        _toast('그래픽 컨텍스트가 복구되었습니다. 화면이 비어 보이면 새로고침하세요.', '새로고침', () => location.reload());
      });
    }, 500);
  });
})();
