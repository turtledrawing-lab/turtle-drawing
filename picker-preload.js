// picker-preload.js — bridge for the Google Drive Picker child window.
// The Picker is a web widget that only runs on a real https origin, so main
// opens https://tdw.kr/desktop-picker.html in a dedicated window and uses this
// preload to hand the page its config (OAuth token + API key) over IPC and to
// receive the picked file back. Runs under sandbox + contextIsolation, so the
// page only ever sees the narrow `window.electronPicker` bridge below.
const { contextBridge, ipcRenderer } = require('electron');

let _cfg = null;
const _waiters = [];
ipcRenderer.on('picker-config', (_e, cfg) => {
  _cfg = cfg;
  while (_waiters.length) { try { _waiters.shift()(cfg); } catch (_) {} }
});

contextBridge.exposeInMainWorld('electronPicker', {
  // Resolves with { token, apiKey, appId, mode, locale } once main sends it.
  getConfig: () => (_cfg ? Promise.resolve(_cfg) : new Promise((res) => _waiters.push(res))),
  // Report the result: { id, name } picked · null cancelled · { failed:true }.
  done: (result) => { try { ipcRenderer.send('gdrive-picker-result', result); } catch (_) {} },
});
