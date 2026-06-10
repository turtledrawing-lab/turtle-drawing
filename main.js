const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Override the default app name ("Electron") so the macOS menu bar,
// Dock tooltip, and About panel read "Turtle Drawing". Must run before
// `app.whenReady()`.
try { app.setName('Turtle Drawing'); } catch (_) {}
try { app.name = 'Turtle Drawing'; } catch (_) {}

// Big imported models routinely exceed V8's default ~4 GB heap during
// parse/serialize peaks — raise it before any renderer is created.
try { app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192'); } catch (_) {}

// Runtime Dock icon — the bundle's CFBundleIconFile handles the initial
// icon, but on macOS app.dock.setIcon is needed to refresh after rename
// and to survive restart-less reloads during development.
app.whenReady().then(async () => {
  try {
    if (process.platform !== 'darwin' || !app.dock || !app.dock.setIcon) return;
    // Use the square (1024×1024 padded) PNG so the dock keeps the
    // turtle's correct aspect — the raw turtle.png is 430×285 and
    // gets squished when macOS forces it into a square icon slot.
    const sqPath = path.join(__dirname, 'build', 'turtle_square.png');
    if (fs.existsSync(sqPath)) { app.dock.setIcon(sqPath); return; }
    const iconPath = path.join(__dirname, 'build', 'icon.icns');
    if (fs.existsSync(iconPath)) app.dock.setIcon(iconPath);
  } catch (e) { console.error('[dock icon]', e); }
});

// IPC: pick a folder and return all files inside (recursively) as
// { name, relPath, dataBase64 } so the renderer can feed the importer.
ipcMain.handle('pick-import-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Select OBJ folder',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  const root = res.filePaths[0];
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? (rel + '/' + e.name) : e.name;
      if (e.isDirectory()) walk(abs, relPath);
      else if (e.isFile()) {
        try {
          const buf = fs.readFileSync(abs);
          out.push({ name: e.name, relPath, size: buf.length, dataBase64: buf.toString('base64') });
        } catch (_) {}
      }
    }
  };
  walk(root, '');
  return { root, files: out };
});

// Pick a single file via the native open-dialog. Caller passes a `filters`
// array (electron OpenDialog format). Returns { name, dataBase64 } or null.
ipcMain.handle('pick-import-file', async (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || 'Open file',
    properties: ['openFile'],
    filters: (opts && opts.filters) || [{ name: 'All', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  const abs = res.filePaths[0];
  try {
    const buf = fs.readFileSync(abs);
    // Return raw bytes through Electron's structured-clone IPC. Base64 was
    // truncating / corrupting large binary payloads (e.g. 70+ MB .3dm files).
    return { name: path.basename(abs), bytes: new Uint8Array(buf), size: buf.length };
  } catch (e) {
    return null;
  }
});

// Map new window id → pending doc JSON, consumed by the renderer once
// the page signals it's ready (via IPC 'detach-ready').
const _pendingDocs = new Map();

// Respawn timestamps for the renderer-crash auto-restart cap (60s window).
let _crashRespawns = [];

ipcMain.handle('detach-tab', async (event, payload) => {
  const win = createWindow(payload && payload.docJson);
  return win ? win.id : null;
});

// Drop a tab at screen coords: if another window contains the point,
// hand the doc off to it; otherwise spawn a new window.
ipcMain.handle('tab-drop', async (event, payload) => {
  const { docJson, screenX, screenY } = payload || {};
  const src = BrowserWindow.fromWebContents(event.sender);
  const srcId = src ? src.id : -1;
  const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.id !== srcId);
  for (const w of wins) {
    const b = w.getBounds();
    if (screenX >= b.x && screenX <= b.x + b.width &&
        screenY >= b.y && screenY <= b.y + b.height) {
      try { w.webContents.send('tab-receive', docJson); w.focus(); } catch (_) {}
      return { target: 'existing', winId: w.id };
    }
  }
  const win = createWindow(docJson);
  return { target: 'new', winId: win ? win.id : null };
});
ipcMain.handle('toggle-maximize', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return true;
});
ipcMain.handle('close-self', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
  return true;
});
ipcMain.handle('detach-consume', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const doc = _pendingDocs.get(win.id);
  _pendingDocs.delete(win.id);
  return doc || null;
});

// ── System fonts for 3D text ───────────────────────────────────────────
// Enumerate installed .ttf/.otf/.ttc fonts so 3D Text can use any system
// font. .ttf/.otf parse directly in the renderer; .ttc collections are split
// to a standalone sfnt there (the first face) before opentype.js parses them.
const _FONT_DIRS = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/Library/Fonts',
  path.join(require('os').homedir(), 'Library', 'Fonts'),
];
// macOS keeps DOWNLOADED "optional" fonts (e.g. NanumGothic and many CJK
// faces — the ones Font Book lists but that aren't in the dirs above) under
// per-asset hash folders here. Walk it so those show up too.
const _ASSETS_FONT_ROOT = '/System/Library/AssetsV2';
ipcMain.handle('list-system-fonts', async () => {
  const out = [];
  const seen = new Set();
  const add = (dir, f) => {
    if (!/\.(ttf|otf|ttc)$/i.test(f)) return;
    const key = f.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: f.replace(/\.(ttf|otf|ttc)$/i, ''), path: path.join(dir, f) });
  };
  for (const dir of _FONT_DIRS) {
    try { for (const f of fs.readdirSync(dir)) add(dir, f); } catch (_) {}
  }
  // AssetsV2/com_apple_MobileAsset_Font*/<hash>.asset/AssetData/<font files>
  try {
    for (const sub of fs.readdirSync(_ASSETS_FONT_ROOT)) {
      if (!/^com_apple_MobileAsset_Font/.test(sub)) continue;
      const subDir = path.join(_ASSETS_FONT_ROOT, sub);
      let assets;
      try { assets = fs.readdirSync(subDir); } catch (_) { continue; }
      for (const a of assets) {
        const adata = path.join(subDir, a, 'AssetData');
        try { for (const f of fs.readdirSync(adata)) add(adata, f); } catch (_) {}
      }
    }
  } catch (_) {}
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
});
ipcMain.handle('read-font-file', async (_e, p) => {
  // Only allow reads from the known system font locations — never arbitrary paths.
  if (typeof p !== 'string') return null;
  const ok = _FONT_DIRS.some(d => p.startsWith(d + '/')) || p.startsWith(_ASSETS_FONT_ROOT + '/');
  if (!ok) return null;
  try { return fs.readFileSync(p); } catch (_) { return null; }
});

/* ---------- Safe .tt save + disk autosave (work-loss prevention) ---------
   writeTTSafely: back up the previous file to <name>.tt.bak, then write
   atomically (tmp + rename) so a crash mid-write can never leave a
   truncated .tt — the worst case is the intact old file + .bak. */
function writeTTSafely(filePath, json) {
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) {}
  }
  const tmp = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, filePath);
}

// Renderer-driven save: silent overwrite when it already knows the path
// (normal Cmd+S on an opened/previously-saved file), native dialog otherwise.
ipcMain.handle('save-tt-file', async (event, payload) => {
  try {
    const { json, suggestedName, knownPath, forceDialog } = payload || {};
    if (typeof json !== 'string' || !json.length) return { error: 'empty payload' };
    let target = (!forceDialog && knownPath && typeof knownPath === 'string' &&
                  fs.existsSync(path.dirname(knownPath))) ? knownPath : null;
    if (!target) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const res = dialog.showSaveDialogSync(win, {
        title: 'Save',
        defaultPath: (suggestedName || 'drawing').replace(/\.tt$/i, '') + '.tt',
        filters: [{ name: 'Turtle Drawing', extensions: ['tt'] }],
      });
      if (!res) return { canceled: true };
      target = res;
    }
    writeTTSafely(target, json);
    return { path: target, name: path.basename(target) };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

/* Disk autosave for crash recovery — replaces the old localStorage snapshot
   (5 MB quota, lost on site-data clears). PER-WINDOW files (a shared file was
   last-writer-wins across windows), claimed by RENAME (atomic) so two windows
   can never double-restore the same snapshot. Lifecycle:
     - a window closing NORMALLY deletes its own file (see createWindow);
     - a crashed window keeps it → next launch claims and offers it;
     - claims orphaned by a crash DURING the recovery prompt are re-offered;
     - declined / failed restores are PARKED (autosave-parked-*.json): never
       re-offered, but kept ~7 days for manual recovery. */
const _autosaveDir = () => {
  const d = path.join(app.getPath('userData'), 'recovery');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
};
const _autosavePathFor = (wcId) => path.join(_autosaveDir(), 'autosave-w' + wcId + '.json');
const _liveClaims = new Set();
ipcMain.handle('autosave-write', async (e, json) => {
  try {
    if (typeof json !== 'string' || !json.length) return false;
    const p = _autosavePathFor(e.sender.id);
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('autosave-claim', async () => {
  try {
    const dir = _autosaveDir();
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return null; }
    const claims = [];
    let seq = 0;
    for (const n of names) {
      const full = path.join(dir, n);
      // Live snapshots: legacy shared name + per-window files.
      const live = /^autosave(\.json|-w\d+\.json)$/.test(n);
      // Orphaned claims from a previous run (crash during the prompt).
      const orphan = /^autosave\.claimed-/.test(n) && !_liveClaims.has(full);
      // Housekeeping: drop parked snapshots older than ~7 days.
      if (/^autosave-parked-(\d+)\.json$/.test(n)) {
        const ts = parseInt(RegExp.$1, 10);
        if (ts && Date.now() - ts > 7 * 24 * 3600 * 1000) { try { fs.unlinkSync(full); } catch (_) {} }
        continue;
      }
      if (!live && !orphan) continue;
      try {
        let claimed = full;
        if (live) {
          claimed = path.join(dir, 'autosave.claimed-' + Date.now() + '-' + process.pid + '-' + (seq++) + '.json');
          fs.renameSync(full, claimed);
        }
        const json = fs.readFileSync(claimed, 'utf8');
        _liveClaims.add(claimed);
        claims.push({ claimId: claimed, json });
      } catch (_) {}
    }
    return claims.length ? claims : null;
  } catch (_) { return null; }
});
ipcMain.handle('autosave-resolve', async (_e, claimId, success) => {
  // success → restored, delete. failure/declined → PARK for manual recovery
  // (never auto-deleted on a single "Cancel", never re-prompted either).
  try {
    if (typeof claimId !== 'string' || !claimId.startsWith(_autosaveDir())) return false;
    _liveClaims.delete(claimId);
    if (!fs.existsSync(claimId)) return false;
    if (success) fs.unlinkSync(claimId);
    else fs.renameSync(claimId, path.join(_autosaveDir(), 'autosave-parked-' + Date.now() + '.json'));
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('autosave-clear', async (e) => {
  try { fs.unlinkSync(_autosavePathFor(e.sender.id)); return true; } catch (_) { return false; }
});

/* Vendored binary assets (e.g. rhino3dm.wasm): the renderer cannot fetch()
   file:// URLs, so it asks main for the bytes. Locked to the vendor dir. */
ipcMain.handle('read-vendor-file', async (_e, name) => {
  try {
    if (typeof name !== 'string' || path.basename(name) !== name) return null;
    const p = path.join(__dirname, 'vendor', name);
    return fs.readFileSync(p);   // works inside app.asar too
  } catch (_) { return null; }
});

/* Always-on error journal: the renderer batches uncaught errors, rejection
   reasons, and geometry-guard verdicts; we append them to a rotating log so
   production failures are diagnosable from a beta report. */
const _errorLogPath = () => path.join(app.getPath('userData'), 'td-errors.log');
ipcMain.handle('error-journal-append', async (_e, lines) => {
  try {
    if (!Array.isArray(lines) || !lines.length) return false;
    const p = _errorLogPath();
    try {
      const st = fs.statSync(p);
      if (st.size > 512 * 1024) { try { fs.renameSync(p, p + '.1'); } catch (_) {} }
    } catch (_) {}
    const stamp = new Date().toISOString();
    fs.appendFileSync(p, lines.map(l => stamp + ' ' + String(l).slice(0, 2000)).join('\n') + '\n', 'utf8');
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('reveal-error-log', async () => {
  try {
    const { shell } = require('electron');
    const p = _errorLogPath();
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
    shell.showItemInFolder(p);
    return true;
  } catch (_) { return false; }
});

let autoUpdater = null;
try {
  // Only enable auto-updater for real packaged builds where the
  // app-update.yml config exists. In dev (running via electron CLI against
  // a renamed Electron.app), app.isPackaged is true but no update config
  // is present — skip to avoid noisy ENOENT errors at startup.
  if (app.isPackaged) {
    const fs = require('fs');
    const path = require('path');
    const cfg = path.join(process.resourcesPath || '', 'app-update.yml');
    if (fs.existsSync(cfg)) ({ autoUpdater } = require('electron-updater'));
  }
} catch (_) { /* updater not installed yet */ }

let _splashShown = false;
function showSplashOnce() {
  if (_splashShown) return null;
  _splashShown = true;
  const splash = new BrowserWindow({
    width: 460, height: 340,
    frame: false, transparent: true,
    resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    title: 'Turtle Drawing',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  return splash;
}

function createWindow(pendingDocJson) {
  const splash = showSplashOnce();

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    title: 'Turtle Drawing',
    backgroundColor: '#00000000',
    transparent: true,
    titleBarStyle: 'hiddenInset', // keeps macOS traffic lights visible
    show: !splash, // hide until ready when splash is up
    icon: path.join(__dirname, 'build', 'icon.icns'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
  });

  // Dev builds load with ?dev=1 to enable in-app diagnostics (mesh-health
  // canary, geometry self-test). Never enabled in packaged/beta builds.
  // Set TD_SELFTEST=1 to also auto-run the geometry self-test on launch.
  // NOTE: app.isPackaged is unreliable here — the dev Electron binary is
  // renamed to "Turtle Drawing", which makes isPackaged report true even in
  // dev. process.defaultApp is true only when launched as `electron .`.
  const _IS_DEV = !!process.defaultApp;
  if (_IS_DEV) {
    // Mark the dev window so it's never confused with the installed app.
    win.setTitle('Turtle Drawing (dev)');
    win.on('page-title-updated', (e) => { e.preventDefault(); }); // keep the (dev) suffix
  }
  const _devSearch = _IS_DEV
    ? ('dev=1' + (process.env.TD_SELFTEST ? '&selftest=1' : '') + (process.env.TD_RECOVERYTEST ? '&recoverytest=1' : '') + (process.env.TD_CLEARRECOVERY ? '&clearrecovery=1' : '') + (process.env.TD_PERFTEST ? '&perftest=1' : ''))
    : '';
  win.loadFile('turtle_drawing.html', _devSearch ? { search: _devSearch } : undefined);
  // Dev-only: forward [selftest]/[health]/[recovery] diagnostic lines to stdout.
  if (_IS_DEV) {
    try {
      win.webContents.on('console-message', (_e, _l, message) => {
        if (typeof message === 'string' && (message.indexOf('[selftest]') === 0 || message.indexOf('[health]') === 0 || message.indexOf('[recovery]') === 0 || message.indexOf('[dev-error]') === 0 || message.indexOf('[perf]') === 0 || message.indexOf('[OBJ Import]') === 0 || message.indexOf('[rhinotest]') === 0 || message.indexOf('[glbtest]') === 0 || message.indexOf('[objtest]') === 0 || message.indexOf('[drilltest]') === 0 || message.indexOf('[snaptest]') === 0 || message.indexOf('[bluetest]') === 0 || message.indexOf('[splittest]') === 0)) {
          process.stdout.write('[RENDERER] ' + message + '\n');
        }
      });
    } catch (_) {}
  }
  // Dev-only coordinate-space audit: TD_SNAPTEST=1 verifies (after the tab bar
  // installs) that render buffer == canvas rect == camera aspect, and that
  // worldToScreen round-trips through a raycast back to the same world point.
  if (_IS_DEV && process.env.TD_SNAPTEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.executeJavaScript(`
          (async () => {
            try {
              const cr = CAN.getBoundingClientRect();
              const rs = new THREE.Vector2(); renderer.getSize(rs);
              const sizeOk = Math.abs(rs.x - cr.width) < 1.5 && Math.abs(rs.y - cr.height) < 1.5;
              const ovOk = Math.abs(OV.width - cr.width) < 1.5 && Math.abs(OV.height - cr.height) < 1.5;
              const aspOk = !camera.isPerspectiveCamera || Math.abs(camera.aspect - cr.width / cr.height) < 1e-3;
              // Round-trip: world point -> worldToScreen px -> synthetic event
              // -> ndc() -> ray -> ground plane -> must land on the same point.
              const P = new THREE.Vector3(1.234, 0, -2.345);
              const s = worldToScreen(P);
              const fake = { clientX: cr.left + s.x, clientY: cr.top + s.y };
              const n = ndc(fake);
              const rc = new THREE.Raycaster(); rc.setFromCamera(n, camera);
              const hit = new THREE.Vector3();
              rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit);
              const err = hit ? hit.distanceTo(P) : 999;
              console.log('[snaptest] bufferOk=' + sizeOk + ' (' + rs.x.toFixed(0) + 'x' + rs.y.toFixed(0) + ' vs ' + cr.width.toFixed(0) + 'x' + cr.height.toFixed(0) + ')' +
                ' overlayOk=' + ovOk + ' aspectOk=' + aspOk +
                ' roundTripErr=' + (err * 1000).toFixed(2) + 'mm' +
                ((sizeOk && ovOk && aspOk && err < 0.002) ? '   PASS' : '   <<< FAIL'));
            } catch (e) { console.log('[snaptest] FAIL ' + (e && e.message)); }
          })()
        `, true).catch((e) => process.stdout.write('[snaptest] inject failed: ' + e + '\n'));
      }, 8000);
    });
  }
  // TEMP-PROBE (snap audit) BEGIN — remove after audit
  if (_IS_DEV && process.env.TD_SNAPTEST2) {
    win.webContents.once('did-finish-load', () => {
      // P6: boot-race poller — does the buffer lag the canvas rect after the
      // tab bar installs (~700ms) and for how long?
      win.webContents.executeJavaScript(`
        (() => {
          const t0 = performance.now();
          const hist = [];
          const iv = setInterval(() => {
            try {
              if (typeof CAN === 'undefined' || typeof renderer === 'undefined') return;
              const cr = CAN.getBoundingClientRect();
              const rs = new THREE.Vector2(); renderer.getSize(rs);
              hist.push({ t: Math.round(performance.now() - t0), top: Math.round(cr.top), h: Math.round(cr.height), bufH: Math.round(rs.y), ovH: OV.height|0 });
              if (performance.now() - t0 > 3000) {
                clearInterval(iv);
                let prev = null; const out = [];
                for (const e of hist) { const k = e.top+':'+e.h+':'+e.bufH+':'+e.ovH; if (k !== prev) { out.push(JSON.stringify(e)); prev = k; } }
                console.log('[snaptest] P6 BOOTRACE transitions: ' + out.join(' '));
              }
            } catch (_) {}
          }, 40);
        })()
      `, true).catch(() => {});
      setTimeout(() => {
        win.webContents.executeJavaScript(`
          (async () => {
            const log = s => console.log('[snaptest] ' + s);
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            try {
              // ---------- P0: layout audit ----------
              const vr = VP.getBoundingClientRect();
              let cr = CAN.getBoundingClientRect();
              const or0 = OV.getBoundingClientRect();
              log('P0 LAYOUT vpTop=' + vr.top.toFixed(0) + ' vpH=' + vr.height.toFixed(0) +
                  ' canTop=' + cr.top.toFixed(0) + ' canH=' + cr.height.toFixed(0) +
                  ' ovTop=' + or0.top.toFixed(0) + ' ovH=' + or0.height.toFixed(0) +
                  ' inlineH="' + CAN.style.height + '" computedH=' + getComputedStyle(CAN).height +
                  ' canBottomBeyondVP=' + (cr.bottom - vr.bottom).toFixed(1) + 'px');

              // ---------- P1: corner/center snap reprojection (empty scene) ----------
              const pts = [[15,15],[cr.width-15,15],[15,cr.height-15],[cr.width-15,cr.height-15],[cr.width/2,cr.height/2]];
              for (const [px,py] of pts) {
                const fake = { clientX: cr.left+px, clientY: cr.top+py, shiftKey:false, altKey:false, ctrlKey:false, metaKey:false };
                let snap = null; try { snap = computeSnap(fake, {}); } catch (e) { log('P1 computeSnap threw ' + e.message); }
                if (!snap) { log('P1 (' + px.toFixed(0) + ',' + py.toFixed(0) + ') snap=null'); continue; }
                const s = worldToScreen(snap.point);
                const d = Math.hypot(s.x-px, s.y-py);
                log('P1 (' + px.toFixed(0) + ',' + py.toFixed(0) + ') type=' + snap.type + ' reprojErr=' + d.toFixed(2) + 'px' + (d > 14.5 ? '  <<< FAIL' : '  ok'));
              }

              // ---------- P2: edge pick + endpoint snap on a real box ----------
              const em = new EditableMesh();
              const va = em.addVertex(new THREE.Vector3(0,0,0)), vb = em.addVertex(new THREE.Vector3(0,0,4)),
                    vc = em.addVertex(new THREE.Vector3(4,0,4)), vd = em.addVertex(new THREE.Vector3(4,0,0));
              const f0 = em.addFace([va,vb,vc,vd], 0xffffff, Model.activeLayerId);
              em.extrudeFace(f0, 3);
              const so = new SketchObject(em, '__snapProbeBox');
              addObject(so);
              await sleep(150);
              cr = CAN.getBoundingClientRect();
              const eset = new Set(); const pairs = [];
              for (const ff of em.faces) { const n = ff.verts.length; for (let i=0;i<n;i++){ const u=ff.verts[i], v=ff.verts[(i+1)%n]; const k=Math.min(u,v)+':'+Math.max(u,v); if(!eset.has(k)){eset.add(k);pairs.push([u,v]);} } }
              let bp=null, bscore=1e9, bmid=null;
              for (const [u,v] of pairs) {
                const sA=worldToScreen(em.vertices[u]), sB=worldToScreen(em.vertices[v]);
                if (sA.z>=1||sB.z>=1) continue;
                if (Math.hypot(sB.x-sA.x,sB.y-sA.y) < 40) continue;
                const mx=(sA.x+sB.x)/2, my=(sA.y+sB.y)/2;
                const sc=Math.hypot(mx-cr.width/2,my-cr.height/2);
                if (sc<bscore){bscore=sc;bp=[u,v];bmid=[mx,my];}
              }
              if (!bp) log('P2 no visible edge  <<< FAIL');
              else {
                const [u,v]=bp; const sA=worldToScreen(em.vertices[u]), sB=worldToScreen(em.vertices[v]);
                const ex=sB.x-sA.x, ey=sB.y-sA.y; const L=Math.hypot(ex,ey)||1;
                const px=bmid[0]-ey/L*3, py=bmid[1]+ex/L*3;
                const fake={clientX:cr.left+px, clientY:cr.top+py, shiftKey:false, altKey:false, ctrlKey:false, metaKey:false};
                const ep = pickEdgeNearScreen(fake, 6);
                if (!ep) log('P2 pickEdge null at 3px from edge  <<< FAIL');
                else {
                  const same = ep.obj===so && ((ep.a===u&&ep.b===v)||(ep.a===v&&ep.b===u));
                  const s1=worldToScreen(ep.obj.em.vertices[ep.a]), s2=worldToScreen(ep.obj.em.vertices[ep.b]);
                  const ddx=s2.x-s1.x, ddy=s2.y-s1.y; const l2=ddx*ddx+ddy*ddy||1;
                  let t=((px-s1.x)*ddx+(py-s1.y)*ddy)/l2; t=Math.max(0,Math.min(1,t));
                  const dpx=Math.hypot(s1.x+ddx*t-px, s1.y+ddy*t-py);
                  log('P2 edgePick sameEdge=' + same + ' screenDist=' + dpx.toFixed(2) + 'px (expect ~3)' + ((same && Math.abs(dpx-3)<1.5) ? '  ok' : '  <<< FAIL'));
                  if (!same) {
                    const W = i => { const p=em.vertices[i]; return '('+p.x+','+p.y+','+p.z+')'; };
                    log('P2diag verts=' + em.vertices.length + ' faces=' + em.faces.length + ' standaloneEdges=' + em.edges.length);
                    log('P2diag chosen u=' + u + W(u) + ' v=' + v + W(v) + ' returned a=' + ep.a + W(ep.a) + ' b=' + ep.b + W(ep.b));
                    // brute force: all unique edges within 8px of cursor
                    const camPos = camera.position;
                    for (const [m,n2] of pairs) {
                      const e1=worldToScreen(em.vertices[m]), e2=worldToScreen(em.vertices[n2]);
                      if (e1.z>=1&&e2.z>=1) continue;
                      const gx=e2.x-e1.x, gy=e2.y-e1.y; const gl=gx*gx+gy*gy||1;
                      let tt=((px-e1.x)*gx+(py-e1.y)*gy)/gl; tt=Math.max(0,Math.min(1,tt));
                      const gd=Math.hypot(e1.x+gx*tt-px, e1.y+gy*tt-py);
                      if (gd<8) {
                        const wp=new THREE.Vector3().lerpVectors(em.vertices[m],em.vertices[n2],tt);
                        log('P2diag near edge ('+m+','+n2+') dPx='+gd.toFixed(2)+' camDist='+camPos.distanceTo(wp).toFixed(2));
                      }
                    }
                  }
                }
                const sV=worldToScreen(em.vertices[u]);
                const fk2={clientX:cr.left+sV.x+4, clientY:cr.top+sV.y+4, shiftKey:false, altKey:false, ctrlKey:false, metaKey:false};
                const sn2=computeSnap(fk2,{});
                if (sn2) { const sp=worldToScreen(sn2.point); const dd=Math.hypot(sp.x-sV.x, sp.y-sV.y);
                  log('P2b cursor 5.7px from corner -> type=' + sn2.type + ' snapToVertexErr=' + dd.toFixed(2) + 'px' + ((sn2.type==='Endpoint'&&dd<0.5)?'  ok':'  <<< check')); }
                else log('P2b corner snap null  <<< FAIL');
              }

              // ---------- P3: overlay marker pixel audit ----------
              {
                cr = CAN.getBoundingClientRect();
                const P = new THREE.Vector3(2,1.5,2);
                const s = worldToScreen(P);
                octx.clearRect(0,0,OV.width,OV.height);
                drawSnapIndicator(s.x, s.y, 'Endpoint', true);
                const R=25, x0=Math.max(0,Math.round(s.x-R)), y0=Math.max(0,Math.round(s.y-R));
                const img = octx.getImageData(x0,y0,R*2,R*2);
                let sx=0,sy=0,n=0;
                for (let yy=0;yy<R*2;yy++) for (let xx=0;xx<R*2;xx++){ const al=img.data[(yy*R*2+xx)*4+3]; if (al>40){ sx+=x0+xx+0.5; sy+=y0+yy+0.5; n++; } }
                if (!n) log('P3 no marker pixels  <<< FAIL');
                else {
                  const cx=sx/n, cy=sy/n, derr=Math.hypot(cx-s.x,cy-s.y);
                  const ovr=OV.getBoundingClientRect();
                  log('P3 markerCentroidErr=' + derr.toFixed(2) + 'px ovBufScale=(' + (OV.width/ovr.width).toFixed(3) + ',' + (OV.height/ovr.height).toFixed(3) + ')' + ((derr<1.5)?'  ok':'  <<< FAIL'));
                }
                try { drawOverlay(); } catch(_){}
              }

              // ---------- P4: 2-pt perspective ray vs projection ----------
              {
                cr = CAN.getBoundingClientRect();
                const savedTY = controls.target.y;
                _twoPtPerspective = true;
                controls.target.y = 3;
                controls.update(); camera.updateMatrixWorld(true);
                const P = new THREE.Vector3(1,0,-1);
                const s = worldToScreen(P);
                const fake = { clientX: cr.left+s.x, clientY: cr.top+s.y };
                const rc = new THREE.Raycaster(); rc.setFromCamera(ndc(fake), camera);
                const hit = new THREE.Vector3();
                const ok1 = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0), hit);
                let mErr=-1, pxErr=-1;
                if (ok1) { mErr = hit.distanceTo(P); const s2=worldToScreen(hit); pxErr=Math.hypot(s2.x-s.x,s2.y-s.y); }
                camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
                const rc2 = new THREE.Raycaster(); rc2.setFromCamera(ndc(fake), camera);
                const hit2 = new THREE.Vector3();
                const ok2 = rc2.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0), hit2);
                const mErr2 = ok2 ? hit2.distanceTo(P) : -1;
                log('P4 twoPt staleInverse: worldErr=' + (mErr*1000).toFixed(1) + 'mm pxErr=' + pxErr.toFixed(1) + 'px ; after manual inverse sync worldErr=' + (mErr2*1000).toFixed(1) + 'mm' + ((mErr > 0.01 && mErr2 >= 0 && mErr2 < 0.002) ? '  <<< FAIL (camera.projectionMatrixInverse stale in 2-pt mode)' : '  ok'));
                _twoPtPerspective = false;
                controls.target.y = savedTY;
                controls.update(); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
              }

              try { removeObject(so); } catch (e) { log('cleanup fail ' + e.message); }
              try { drawOverlay(); } catch(_){}
              log('PROBES DONE');
            } catch (e) { log('PROBE THREW ' + (e && e.message)); }
          })()
        `, true).catch((e) => process.stdout.write('[snaptest2] inject failed: ' + e + '\n'));
      }, 10000);
      // P5: window resize tracking — mid-debounce and post-debounce buffer state.
      setTimeout(() => {
        const [w, h] = win.getSize();
        const audit = (tag) => win.webContents.executeJavaScript(
          `(()=>{const cr=CAN.getBoundingClientRect();const rs=new THREE.Vector2();renderer.getSize(rs);` +
          `return '${tag} can='+cr.width.toFixed(0)+'x'+cr.height.toFixed(0)+' buf='+rs.x.toFixed(0)+'x'+rs.y.toFixed(0)+' ovBuf='+OV.width+'x'+OV.height+' aspect='+camera.aspect.toFixed(4)+' rectAspect='+(cr.width/cr.height).toFixed(4);})()`,
          true).then(s => process.stdout.write('[RENDERER] [snaptest] P5 ' + s + '\n')).catch(()=>{});
        win.setSize(w + 137, h + 89);
        setTimeout(() => audit('RESIZE+100ms'), 100);
        setTimeout(() => audit('RESIZE+500ms'), 500);
        setTimeout(() => { win.setSize(w, h); }, 900);
        setTimeout(() => audit('RESTORE+500ms'), 1400);
      }, 16000);
    });
  }
  // TEMP-PROBE (snap audit) END
  // Dev-only repro: TD_BLUETEST=1 — drill a box, then push its right wall
  // inward PAST the tunnel (splits the solid like the user's screenshot) and
  // report face-orientation health + which faces stay inconsistent.
  if (_IS_DEV && process.env.TD_BLUETEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.executeJavaScript(`
          (async () => {
            try {
              const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
              // box 4x3x4 + island on top, drilled through (same as drilltest)
              const em = new EditableMesh();
              const a = em.addVertex(V3(0,0,0)), b = em.addVertex(V3(0,0,4)),
                    c = em.addVertex(V3(4,0,4)), d = em.addVertex(V3(4,0,0));
              const base = em.addFace([a,b,c,d], 0xffffff, 'Layer0');
              em.extrudeFace(base, 3);
              const corners = [V3(1,3,1), V3(3,3,1), V3(3,3,3), V3(1,3,3)];
              const idxs = corners.map(p => findOrAddVertexAt(em, p));
              for (const i of idxs) splitEdgesAtPoint(em, i);
              for (let i = 0; i < idxs.length; i++) {
                const p = idxs[i], q = idxs[(i + 1) % idxs.length];
                if (!edgeExists(em, p, q)) em.edges.push({ a: p, b: q });
              }
              const cyc = findShortestCycle(em, idxs[0], idxs[1]);
              const inner = createFaceFromCycle(em, (cyc && cyc.length >= 3) ? cyc : idxs, 0xffffff, 'Layer0');
              const statics = new Set(em.vertices.map(v => v.x + '|' + v.y + '|' + v.z));
              em.extrudeFace(inner, -3);
              em.weldVertices(0.005, statics);
              em.splitFaceByCoplanarFace && em.splitFaceByCoplanarFace();
              _closeCoplanarHoleCaps(em);
              Tools.pp._runBurnThrough(em, statics);
              mergeCoplanarAdjacentFaces(em);
              _healMeshTopology(em);
              const h0 = _meshHealth(em);
              // NOW: push the right wall (x=4, normal +X) inward past the tunnel
              const right = em.faces.find(f => f.normal.x > 0.9 &&
                f.verts.every(vi => Math.abs(em.vertices[vi].x - 4) < 1e-6));
              if (!right) { console.log('[bluetest] FAIL no right wall'); return; }
              const statics2 = new Set(em.vertices.map(v => v.x + '|' + v.y + '|' + v.z));
              const pre = { verts: em.vertices.map(v => v.clone()),
                            faces: em.faces.map(f => ({ verts: f.verts.slice(), normal: f.normal.clone(), color: f.color, layerId: f.layerId, holes: (f.holes||[]).map(hh => hh.slice()) })) };
              em.extrudeFace(right, -2.5);   // past tunnel right wall at x=3
              em.weldVertices(0.005, statics2);
              em.splitFaceByCoplanarFace && em.splitFaceByCoplanarFace();
              _closeCoplanarHoleCaps(em);
              Tools.pp._runBurnThrough(em, statics2);
              mergeCoplanarAdjacentFaces(em);
              _healMeshTopology(em);
              const h1 = _meshHealth(em);
              const fakeObj = { em, rebuild() {} };
              const rolled = _commitGuard(fakeObj, pre, 'BlueTest');
              const h2 = _meshHealth(em);
              // diagnose remaining winding offenders: faces whose directed
              // edges conflict; report each with its edges' usage counts.
              const use = new Map();
              em.faces.forEach((f) => {
                const loops = [f.verts].concat(f.holes || []);
                for (const loop of loops) for (let i = 0; i < loop.length; i++) {
                  const x = loop[i], y = loop[(i + 1) % loop.length];
                  if (x === y) continue;
                  const k = x < y ? x + '_' + y : y + '_' + x;
                  use.set(k, (use.get(k) || 0) + 1);
                }
              });
              let nonman = 0; for (const v of use.values()) if (v > 2) nonman++;
              console.log('[bluetest] afterDrill wind=' + h0.winding +
                ' | afterCut wind=' + h1.winding + ' open=' + h1.open + ' nonman=' + h1.nonman +
                ' faces=' + em.faces.length +
                ' | guardRolled=' + rolled + ' finalWind=' + h2.winding +
                ' | nonmanEdges=' + nonman +
                ((h2.winding === 0) ? '   PASS' : '   <<< FAIL (blue faces remain)'));
            } catch (e) { console.log('[bluetest] FAIL ' + (e && e.message)); }
          })()
        `, true).catch((e) => process.stdout.write('[bluetest] inject failed: ' + e + '\n'));
      }, 6000);
    });
  }
  // Dev-only repro: TD_SPLITTEST=1 — drill a box, then draw two chords across
  // the holed top face via the REAL line-tool commit; the ring must split.
  if (_IS_DEV && process.env.TD_SPLITTEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.executeJavaScript(`
          (async () => {
            try {
              const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
              const em = new EditableMesh();
              const a = em.addVertex(V3(0,0,0)), b = em.addVertex(V3(0,0,4)),
                    c = em.addVertex(V3(4,0,4)), d = em.addVertex(V3(4,0,0));
              const base = em.addFace([a,b,c,d], 0xffffff, 'Layer0');
              em.extrudeFace(base, 3);
              const corners = [V3(1,3,1), V3(3,3,1), V3(3,3,3), V3(1,3,3)];
              const idxs = corners.map(p => findOrAddVertexAt(em, p));
              for (const i of idxs) splitEdgesAtPoint(em, i);
              for (let i = 0; i < idxs.length; i++) {
                const p = idxs[i], q = idxs[(i + 1) % idxs.length];
                if (!edgeExists(em, p, q)) em.edges.push({ a: p, b: q });
              }
              const cyc = findShortestCycle(em, idxs[0], idxs[1]);
              const inner = createFaceFromCycle(em, (cyc && cyc.length >= 3) ? cyc : idxs, 0xffffff, 'Layer0');
              const statics = new Set(em.vertices.map(v => v.x + '|' + v.y + '|' + v.z));
              em.extrudeFace(inner, -3);
              em.weldVertices(0.005, statics);
              em.splitFaceByCoplanarFace && em.splitFaceByCoplanarFace();
              _closeCoplanarHoleCaps(em);
              Tools.pp._runBurnThrough(em, statics);
              mergeCoplanarAdjacentFaces(em);
              _healMeshTopology(em);
              const so = new SketchObject(em, 'SplitTest');
              addObject(so); so.rebuild();
              const facesBefore = em.faces.length;
              const ringBefore = em.faces.filter(f => f.holes && f.holes.length).length;
              // chord 1: outer front edge -> hole front edge ; chord 2: hole back -> outer back
              const r1 = Tools.line._commitEdge.call(Tools.line, V3(1,3,0), { obj: so }, V3(1,3,1), { obj: so });
              const r2 = Tools.line._commitEdge.call(Tools.line, V3(1,3,3), { obj: so }, V3(1,3,4), { obj: so });
              const topFaces = em.faces.filter(f => f.normal && f.normal.y > 0.9 &&
                f.verts.every(vi => Math.abs(em.vertices[vi].y - 3) < 1e-6));
              const ringAfter = em.faces.filter(f => f.holes && f.holes.length).length;
              const h = _meshHealth(em);
              console.log('[splittest] facesBefore=' + facesBefore + ' after=' + em.faces.length +
                ' topFaces=' + topFaces.length + ' (expect 2)' +
                ' ringFaces ' + ringBefore + '->' + ringAfter + ' (expect 2->1: top ring consumed, bottom stays)' +
                ' r1=' + !!r1 + ' r2=' + !!r2 + ' wind=' + h.winding +
                ((topFaces.length === 2 && ringAfter === 1 && h.winding === 0) ? '   PASS' : '   <<< FAIL (face not split)'));
              // FULL user workflow: push the LEFT split piece down through the
              // box (cutting that strip away) — the step that used to leave
              // blue (inverted) faces behind.
              const leftTop = topFaces.find(f => f.verts.every(vi => em.vertices[vi].x < 1 + 1e-3));
              if (leftTop) {
                const st3 = new Set(em.vertices.map(v => v.x + '|' + v.y + '|' + v.z));
                em.extrudeFace(leftTop, -3);
                em.weldVertices(0.005, st3);
                em.splitFaceByCoplanarFace && em.splitFaceByCoplanarFace();
                _closeCoplanarHoleCaps(em);
                Tools.pp._runBurnThrough(em, st3);
                mergeCoplanarAdjacentFaces(em);
                _healMeshTopology(em);
                const h3 = _meshHealth(em);
                console.log('[splittest] afterCutLeft wind=' + h3.winding + ' degen=' + h3.degenerate +
                  ' dup=' + h3.dup + ' faces=' + em.faces.length +
                  (h3.winding === 0 && h3.degenerate === 0 ? '   PASS (no blue faces)' : '   <<< FAIL'));
              } else {
                console.log('[splittest] afterCutLeft SKIPPED (left piece not found)');
              }
              for (const o of Model.objects.slice()) if (o.name === 'SplitTest') removeObject(o);
            } catch (e) { console.log('[splittest] FAIL ' + (e && e.message)); }
          })()
        `, true).catch((e) => process.stdout.write('[splittest] inject failed: ' + e + '\n'));
      }, 6000);
    });
  }
  // Dev-only repro for the drill-through bug: TD_DRILLTEST=1 replicates the
  // push/pull VCB commit pipeline (rectangle on a box face pushed through to
  // the opposite wall) in three variants and logs [drilltest] verdicts.
  if (_IS_DEV && process.env.TD_DRILLTEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.executeJavaScript(`
          (async () => {
            try {
              const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
              const mkScene = () => {
                // Mirror Tools.rect.commit drawing a rectangle on a box face:
                // findOrAddVertexAt + edges + createFaceFromCycle (island).
                const em = new EditableMesh();
                const a = em.addVertex(V3(0,0,0)), b = em.addVertex(V3(0,0,4)),
                      c = em.addVertex(V3(4,0,4)), d = em.addVertex(V3(4,0,0));
                const base = em.addFace([a,b,c,d], 0xffffff, 'Layer0');
                em.extrudeFace(base, 3);                          // 4x3x4 box
                const corners = [V3(1,3,1), V3(3,3,1), V3(3,3,3), V3(1,3,3)];
                const idxs = corners.map(p => findOrAddVertexAt(em, p));
                for (const i of idxs) splitEdgesAtPoint(em, i);
                for (let i = 0; i < idxs.length; i++) {
                  const p = idxs[i], q = idxs[(i + 1) % idxs.length];
                  if (!edgeExists(em, p, q)) em.edges.push({ a: p, b: q });
                }
                const cycle = findShortestCycle(em, idxs[0], idxs[1]);
                const inner = createFaceFromCycle(em, (cycle && cycle.length >= 3) ? cycle : idxs, 0xffffff, 'Layer0');
                if (!inner) throw new Error('createFaceFromCycle failed');
                return { em, inner };
              };
              const flipFace = (em, f) => { f.verts.reverse(); em.computeFaceNormal(f); };
              const drilled = (em) => {
                // ray from above through the tunnel centre — 0 hits = drilled through
                const so = new SketchObject(em.clone ? em.clone() : em, 'DrillCheck');
                so.mesh.updateMatrixWorld(true);
                const rc = new THREE.Raycaster(V3(2, 10, 2), V3(0, -1, 0));
                const hits = rc.intersectObject(so.mesh, false);
                try { so.mesh.geometry.dispose(); so.edges.geometry.dispose(); } catch (_) {}
                return { hits: hits.length, faces: em.faces.length };
              };
              const pipeline = (variant) => {
                const { em, inner } = mkScene();
                // 'flipped*': the island face wound the way Tools.rect actually
                // creates it (normal negated toward the camera, i.e. INTO the
                // solid) — the real interactive condition.
                const flipped = variant.indexOf('flipped') === 0;
                if (flipped) flipFace(em, inner);
                const statics = new Set(em.vertices.map(v => v.x + '|' + v.y + '|' + v.z));
                const preVerts = em.vertices.map(v => v.clone());
                const preFaces = em.faces.map(f => ({ verts: f.verts.slice(), normal: f.normal.clone(), color: f.color, layerId: f.layerId, holes: (f.holes||[]).map(h => h.slice()) }));
                em.extrudeFace(inner, flipped ? 3 : -3);   // both = push INTO the box to the bottom
                const s = (variant.indexOf('legacy') >= 0) ? null : statics;
                try { em.weldVertices(0.005, s); } catch (e) { return 'weld THREW ' + e.message; }
                try { em.splitFaceByCoplanarFace && em.splitFaceByCoplanarFace(); } catch (e) { return 'split THREW ' + e.message; }
                try { _closeCoplanarHoleCaps(em); } catch (e) { return 'caps THREW ' + e.message; }
                try { Tools.pp._runBurnThrough(em, s); } catch (e) { return 'burn THREW ' + e.message; }
                try { mergeCoplanarAdjacentFaces(em); } catch (_) {}
                try { _healMeshTopology(em); } catch (_) {}
                const d = drilled(em);
                const h = _meshHealth(em);
                let guard = '-';
                if (variant.indexOf('commitguard') >= 0) {
                  const fakeObj = { em, rebuild() { this._r = true; } };
                  guard = _commitGuard(fakeObj, { verts: preVerts, faces: preFaces }, 'DrillTest') ? 'ROLLED_BACK' : 'kept';
                }
                return 'hits=' + d.hits + ' (0=drilled) faces=' + d.faces +
                  ' health{open=' + h.open + ' nonman=' + h.nonman + ' wind=' + h.winding + ' degen=' + h.degenerate + ' dup=' + h.dup + '}' +
                  ' guard=' + guard;
              };
              console.log('[drilltest] legacy            : ' + pipeline('legacy'));
              console.log('[drilltest] guarded           : ' + pipeline('guarded'));
              console.log('[drilltest] guarded+commitgrd : ' + pipeline('guarded+commitguard'));
              console.log('[drilltest] flipped legacy    : ' + pipeline('flipped legacy'));
              console.log('[drilltest] flipped guarded   : ' + pipeline('flipped guarded'));
              console.log('[drilltest] flipped+commitgrd : ' + pipeline('flipped guarded commitguard'));
            } catch (e) { console.log('[drilltest] FAIL ' + (e && e.message)); }
          })()
        `, true).catch((e) => process.stdout.write('[drilltest] inject failed: ' + e + '\n'));
      }, 6000);
    });
  }
  // Dev-only E2E check for the OBJ inch heuristic: TD_OBJTEST=1 imports a
  // SketchUp-header OBJ (394 units ≈ a 10m wall in inches) with the unit
  // modal bypassed and logs the resulting size as [objtest].
  if (_IS_DEV && process.env.TD_OBJTEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.executeJavaScript(`
          (async () => {
            try {
              window.__TD_UNIT_CHOICE = 'auto';
              const objText = '# Exported from SketchUp\\nv 0 0 0\\nv 394 0 0\\nv 394 0 394\\nv 0 0 394\\nf 1 2 3 4\\n';
              const before = Model.objects.length;
              await importOBJ(objText, 'sketchup_test.obj');
              const added = Model.objects.slice(before);
              const bb = new THREE.Box3();
              for (const o of added) for (const v of o.em.vertices) bb.expandByPoint(v);
              const sz = new THREE.Vector3(); bb.getSize(sz);
              const maxDim = Math.max(sz.x, sz.y, sz.z);
              console.log('[objtest] added=' + added.length + ' maxDim=' + maxDim.toFixed(3) + 'm (expect ~10.008 for inch scaling)');
              for (const o of added) removeObject(o);
              delete window.__TD_UNIT_CHOICE;
            } catch (e) { console.log('[objtest] FAIL ' + (e && e.message)); }
          })()
        `, true).catch((e) => process.stdout.write('[objtest] inject failed: ' + e + '\n'));
      }, 6000);
    });
  }
  // Dev-only E2E check for the glTF round-trip: TD_GLBTEST=1 builds a box,
  // exports it through GLTFExporter, re-imports through GLTFLoader +
  // _importMeshTreeIntoScene (placement stubbed), and logs [glbtest].
  if (_IS_DEV && process.env.TD_GLBTEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.executeJavaScript(`
          (async () => {
            try {
              const em = new EditableMesh();
              const a = em.addVertex(new THREE.Vector3(0,0,0)), b = em.addVertex(new THREE.Vector3(0,0,2)),
                    c = em.addVertex(new THREE.Vector3(2,0,2)), d = em.addVertex(new THREE.Vector3(2,0,0));
              const f = em.addFace([a,b,c,d], 0xffffff, 'Layer0'); em.extrudeFace(f, 1);
              const so = new SketchObject(em, 'GLBTest');
              const grp = new THREE.Group();
              const m = new THREE.Mesh(so.mesh.geometry, new THREE.MeshStandardMaterial({ vertexColors: true }));
              m.name = 'Layer0/GLBTest'; grp.add(m);
              const ab = await new Promise((res, rej) => { try { new THREE.GLTFExporter().parse(grp, res, { binary: true }); } catch (e) { rej(e); } });
              const placed = [];
              const orig = window._startPlacementMode;
              window._startPlacementMode = (objs) => placed.push(...objs);
              try {
                await new Promise((res, rej) => new THREE.GLTFLoader().parse(ab, '', (g) => {
                  try { _importMeshTreeIntoScene(g.scene, 'roundtrip.glb', 1, { placeMode: true }); res(); } catch (e) { rej(e); }
                }, rej));
              } finally { window._startPlacementMode = orig; }
              const o = placed[0];
              console.log('[glbtest] exporter=' + (typeof THREE.GLTFExporter === 'function') +
                ' collada=' + (typeof THREE.ColladaLoader === 'function') +
                ' glbBytes=' + (ab && ab.byteLength) +
                ' placed=' + placed.length +
                ' faces=' + (o && o.em.faces.length) +
                ' verts=' + (o && o.em.vertices.length));
            } catch (e) { console.log('[glbtest] FAIL ' + (e && e.message)); }
          })()
        `, true).catch((e) => process.stdout.write('[glbtest] inject failed: ' + e + '\n'));
      }, 6000);
    });
  }
  // Dev-only E2E check for the Rhino importer: TD_RHINOTEST=1 feeds
  // /tmp/test_cube.3dm through importRhino3dm (placement stubbed) and logs
  // [rhinotest] results to stdout. Never runs in packaged builds.
  if (_IS_DEV && process.env.TD_RHINOTEST) {
    try {
      const b64 = fs.readFileSync('/tmp/test_cube.3dm').toString('base64');
      win.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          win.webContents.executeJavaScript(`
            (async () => {
              try {
                const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
                const placed = [];
                const orig = window._startPlacementMode;
                window._startPlacementMode = (objs) => { placed.push(...objs); };
                try { await importRhino3dm(bytes, 'test_cube.3dm'); }
                finally { window._startPlacementMode = orig; }
                const o = placed[0];
                const L = Model.layers.find(l => l.name === 'TestLayer');
                console.log('[rhinotest] objects=' + placed.length +
                  ' layerFound=' + !!L +
                  ' layerColor=' + (L && L.color) +
                  ' objLayerOk=' + !!(o && L && o.layerId === L.id) +
                  ' verts=' + (o && o.em.vertices.length) +
                  ' faces=' + (o && o.em.faces.length) +
                  ' v1=' + (o ? [o.em.vertices[1].x, o.em.vertices[1].y, o.em.vertices[1].z].join(',') : '-'));
              } catch (e) { console.log('[rhinotest] FAIL ' + (e && e.message)); }
            })()
          `, true).catch((e) => process.stdout.write('[rhinotest] inject failed: ' + e + '\n'));
        }, 6000);
      });
    } catch (e) { process.stdout.write('[rhinotest] no test file: ' + e + '\n'); }
  }
  if (pendingDocJson) _pendingDocs.set(win.id, pendingDocJson);

  // A window that closes NORMALLY cleans up its own autosave snapshot — file
  // presence alone then means "this window did not exit cleanly", which is
  // what the recovery prompt keys on. Crashed windows (and quits that leave
  // dirty tabs unsaved — see confirmDiscardIfDirty) keep theirs.
  {
    const _wcId = win.webContents.id;
    win.on('closed', () => {
      if (win._crashed || win._preserveAutosave) return;
      try { fs.unlinkSync(_autosavePathFor(_wcId)); } catch (_) {}
    });
  }

  // Renderer crash (GPU context loss / OOM): recreate the window instead of
  // leaving a blank shell. The fresh window's recovery prompt then offers the
  // disk autosave — without this handler the user saw a dead window and the
  // crash protection never got a chance to run. Capped: a crash-on-boot must
  // not become an infinite respawn loop.
  win.webContents.on('render-process-gone', (_e, details) => {
    try { console.error('[main] renderer gone:', details && details.reason); } catch (_) {}
    if (details && (details.reason === 'clean-exit' || details.reason === 'killed')) return;
    win._crashed = true;   // keep this window's autosave file for recovery
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) {}
    const now = Date.now();
    _crashRespawns = _crashRespawns.filter(t => now - t < 60000);
    if (_crashRespawns.length >= 3) {
      try {
        dialog.showErrorBox('Turtle Drawing',
          '렌더러가 반복적으로 종료되어 자동 재시작을 멈췄습니다.\n' +
          '다시 실행하면 마지막 자동 저장본 복구를 제안합니다.');
      } catch (_) {}
      try { app.quit(); } catch (_) {}
      return;
    }
    _crashRespawns.push(now);
    try { createWindow(); } catch (_) {}
  });

  if (splash) {
    // Keep splash visible at least 900ms even if the main window loads instantly.
    const startedAt = Date.now();
    const finish = () => {
      const remain = Math.max(0, 5000 - (Date.now() - startedAt));
      setTimeout(() => {
        if (!splash.isDestroyed()) splash.close();
        if (!win.isDestroyed()) { win.show(); win.focus(); }
      }, remain);
    };
    win.once('ready-to-show', finish);
    // Safety net: close splash after 8s even if ready-to-show never fires.
    setTimeout(() => { if (!splash.isDestroyed()) splash.close(); if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 5000);
  }

  // Helper: dispatch a custom app-level action to the renderer, which will
  // call handleAction(act) — the same function the in-HTML menu used.
  const send = (act) => () => {
    let target = (BrowserWindow.getFocusedWindow && BrowserWindow.getFocusedWindow())
                || (win && !win.isDestroyed() ? win : null)
                || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    if (!target || target.isDestroyed() || !target.webContents || target.webContents.isDestroyed()) {
      // No usable window — spawn one and dispatch after it finishes loading.
      const fresh = createWindow();
      if (!fresh) return;
      fresh.webContents.once('did-finish-load', () => {
        try { fresh.webContents.send('menu-action', act); } catch (_) {}
      });
      return;
    }
    try { target.webContents.send('menu-action', act); } catch (_) {}
    const js = `(()=>{try{
      var bar=document.getElementById('menubar'); if(bar) bar.style.display='none';
      if(typeof window.handleAction==='function') window.handleAction(${JSON.stringify(act)});
      else if(typeof handleAction==='function') handleAction(${JSON.stringify(act)});
      else {
        var el=document.querySelector('[data-act="'+${JSON.stringify(act)}+'"]');
        if(el) el.click();
      }
    }catch(e){console.error('[menu-action]',e);}})()`;
    // userGesture=true so that handlers which open native dialogs (file input
    // .click(), window.confirm, etc.) are allowed — Chromium blocks those when
    // the call isn't attributed to a user activation.
    target.webContents.executeJavaScript(js, true).catch(()=>{});
  };

  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: 'About Turtle Drawing' },
        { type: 'separator' },
        { label: 'Check for updates...', click: () => checkForUpdatesManually(win) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit Turtle Drawing',
          accelerator: 'Command+Q',
          // Chrome-style "hold to quit": short tap shows a toast, holding
          // the shortcut for ~1s actually quits.
          click: () => holdToQuit(),
        },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            // On macOS the user can close the window without quitting the app.
            // In that case "New" should spawn a fresh window. If a window is
            // already open, dispatch the in-renderer 'new' action instead so
            // the current scene is reset (classic single-document behavior).
            const anyWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
            if (!anyWin) { createWindow(); return; }
            send('new')();
          },
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            // Always show the native file picker from main — HTML file inputs
            // triggered through a menu IPC are blocked by Chromium's
            // user-activation requirement.
            const anyWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
            const res = await dialog.showOpenDialog(anyWin || {}, {
              title: 'Open Turtle Drawing',
              properties: ['openFile'],
              filters: [
                { name: 'Turtle Drawing', extensions: ['tt'] },
                { name: 'All', extensions: ['*'] },
              ],
            });
            if (res.canceled || !res.filePaths || !res.filePaths.length) return;
            let docJson;
            try { docJson = fs.readFileSync(res.filePaths[0], 'utf8'); }
            catch (e) { dialog.showErrorBox('Open failed', String(e)); return; }
            const filename = path.basename(res.filePaths[0]);
            if (anyWin) {
              try { anyWin.webContents.send('menu-action', 'file-open-data', { docJson, filename, fullPath: res.filePaths[0] }); } catch (_) {}
            } else {
              createWindow(docJson);
            }
          },
        },
        { type: 'separator' },
        { label: 'Save',          accelerator: 'CmdOrCtrl+S',       click: send('file-save') },
        { label: 'Save As...',    accelerator: 'Shift+CmdOrCtrl+S', click: send('file-save-as') },
        { type: 'separator' },
        {
          label: 'Import',
          submenu: [
            { label: 'DXF...',                  click: send('import-dxf') },
            { label: 'Rhino (.3dm)...',         click: send('import-3dm') },
            { label: 'glTF / GLB...',           click: send('import-glb') },
            { label: 'Collada (.dae)...',       click: send('import-dae') },
            { label: 'STL...',                  click: send('import-stl') },
            { label: 'OBJ (file)...',           click: send('import-obj') },
            { label: 'OBJ (folder)...',         click: send('import-obj-folder') },
            { type: 'separator' },
            { label: 'Cadastral...',    click: send('cadastral-import') },
          ],
        },
        {
          label: 'Export',
          submenu: [
            { label: 'OBJ...',    click: send('export-obj') },
            { label: '3DM (Rhino)...', click: send('export-3dm') },
            { label: 'glTF (.glb)...', click: send('export-glb') },
            { label: 'STL (3D printing)...',    click: send('export-stl') },
            { type: 'separator' },
            { label: 'Section / Elevation SVG...', click: send('export-svg') },
            { label: 'Section / Elevation PDF...', click: send('export-pdf') },
            { label: 'Section / Elevation DXF (per-layer colors)...', click: send('export-dxf') },
          ],
        },
        ...(!isMac ? [
          { type: 'separator' },
          { label: 'About', click: send('about') },
          { role: 'quit' },
        ] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo',          accelerator: 'CmdOrCtrl+Z',       click: send('undo') },
        { label: 'Redo',          accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Select All',    accelerator: 'CmdOrCtrl+A',       click: send('selectAll') },
        { label: 'Delete',        accelerator: 'Delete',            click: send('delete') },
        { type: 'separator' },
        { label: 'Make Group',    accelerator: 'CmdOrCtrl+G',       click: send('group') },
        { label: 'Explode',                                         click: send('explode') },
        { type: 'separator' },
        { label: 'Split Disconnected',                              click: send('split-disconnected') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom All',      accelerator: 'Shift+Z',           click: send('zoom-all') },
        { label: 'Zoom Selection',                                  click: send('zoom-selection') },
        { label: 'Position Camera (Eye Level 1.6 m)',               click: send('eye-level') },
        { type: 'separator' },
        { label: 'Perspective',                                     click: send('view-persp') },
        { label: 'Orthographic',                                    click: send('view-ortho') },
        { type: 'separator' },
        { label: 'Top',                                             click: send('view-top') },
        { label: 'Front',                                           click: send('view-front') },
        { label: 'Right',                                           click: send('view-right') },
        { label: 'Iso',                                             click: send('view-iso') },
        { type: 'separator' },
        {
          label: 'Face Style',
          submenu: [
            { label: 'Shaded',          click: send('style-shaded') },
            { label: 'Wireframe',       click: send('style-wire') },
            { label: 'Hidden Line',     click: send('style-hiddenline') },
            { label: 'Shaded + Wire',   click: send('style-both') },
          ],
        },
        { label: 'Wireframe Toggle',              accelerator: 'K',  click: send('toggle-wire') },
        { type: 'separator' },
        { label: 'Turntable Animation',           accelerator: 'CmdOrCtrl+Shift+T', click: send('toggle-turntable') },
        { type: 'separator' },
        { label: 'Toggle Grid',                                     click: send('toggle-grid') },
        { label: 'Toggle Axes',                                     click: send('toggle-axes') },
        { label: 'Color by Layer',                                  click: send('toggle-colorlayer') },
        { label: 'Lines by Layer Color',                            click: send('toggle-linecolorlayer') },
        { label: 'Dark Background',                                 click: send('toggle-darkbg') },
        { label: 'Section Fills',                                   click: send('toggle-sectionfill') },
        { type: 'separator' },
        { label: 'Full Snap to Underlay (DXF)',                     click: send('toggle-snap-underlay') },
        { label: 'Select Underlay (DXF)',                           click: send('toggle-pick-underlay') },
        { type: 'separator' },
        { label: 'Shadows',                                         click: send('toggle-shadows') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Draw',
      submenu: [
        { label: 'Line',          accelerator: 'L',                 click: send('tool-line') },
        { label: 'Rectangle',     accelerator: 'R',                 click: send('tool-rect') },
        { label: 'Wall',                                            click: send('tool-wall') },
        { label: 'Polygon',                                         click: send('tool-polygon') },
        { label: 'Freehand',                                        click: send('tool-freehand') },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Select',        accelerator: 'Space',             click: send('tool-select') },
        { label: 'Move',          accelerator: 'M',                 click: send('tool-move') },
        { label: 'Rotate',        accelerator: 'Q',                 click: send('tool-rotate') },
        { label: 'Scale',         accelerator: 'S',                 click: send('tool-scale') },
        { label: 'Push / Pull',   accelerator: 'P',                 click: send('tool-pp') },
        { type: 'separator' },
        { label: 'Line',          accelerator: 'L',                 click: send('tool-line') },
        { label: 'Rectangle',     accelerator: 'R',                 click: send('tool-rect') },
        { label: 'Arc',           accelerator: 'A',                 click: send('tool-arc') },
        { label: 'Polygon',                                         click: send('tool-polygon') },
        { label: 'Freehand',                                        click: send('tool-freehand') },
        { label: 'Offset',        accelerator: 'F',                 click: send('tool-offset') },
        { label: 'Wall',          accelerator: 'W',                 click: send('tool-wall') },
        { type: 'separator' },
        { label: 'Orbit',         accelerator: 'O',                 click: send('tool-orbit') },
        { label: 'Pan',           accelerator: 'H',                 click: send('tool-pan') },
        { label: 'Zoom All',      accelerator: 'Z',                 click: send('zoom-all') },
        { label: 'Isolate',       accelerator: 'N',                 click: send('isolate') },
        { type: 'separator' },
        { label: 'Tape Measure',  accelerator: 'T',                 click: send('tool-tape') },
        { label: 'Dimension',     accelerator: 'I',                 click: send('tool-dim') },
        { label: 'Angle Dimension',                                 click: send('tool-dimAngle') },
        { label: 'Text',                                            click: send('tool-text') },
        { label: 'Callout',                                         click: send('tool-callout') },
        { label: 'Material Spec',                                   click: send('tool-matSpec') },
        { label: '3D Text...',                                      click: send('text-3d') },
        { label: 'Chain Dimensions (Toggle)',                       click: send('toggle-dim-chain') },
        { label: 'Align Selected Dimensions',                       click: send('align-dims') },
        { label: 'Level Marker',                                    click: send('tool-level') },
        { label: 'Eraser',        accelerator: 'E',                 click: send('tool-erase') },
        { label: 'Paint Bucket',  accelerator: 'B',                 click: send('tool-paint') },
        { label: 'Section Plane',                 accelerator: 'X',  click: send('tool-section') },
        { label: 'Wall Layer Offset',                               click: send('tool-walllayer') },
        { type: 'separator' },
        { label: 'Dimension Units...',                              click: send('dim-units') },
        { label: 'Dimension Style...',                              click: send('dim-style') },
        { label: 'Title Block...',                                  click: send('title-block') },
        { type: 'separator' },
        { label: 'Make Component',                accelerator: 'CmdOrCtrl+Shift+G', click: send('make-component') },
        { type: 'separator' },
        {
          label: 'Align Selected',
          submenu: [
            { label: 'Align Left (−X)',   click: send('align-min-x')    },
            { label: 'Align Center (X)',  click: send('align-center-x') },
            { label: 'Align Right (+X)',  click: send('align-max-x')    },
            { type: 'separator' },
            { label: 'Align Bottom (−Y)', click: send('align-min-y')    },
            { label: 'Align Middle (Y)',  click: send('align-center-y') },
            { label: 'Align Top (+Y)',    click: send('align-max-y')    },
            { type: 'separator' },
            { label: 'Align Front (−Z)',  click: send('align-min-z')    },
            { label: 'Align Center (Z)',  click: send('align-center-z') },
            { label: 'Align Back (+Z)',   click: send('align-max-z')    },
          ],
        },
        {
          label: 'Distribute Selected',
          submenu: [
            { label: 'Distribute X', click: send('distribute-x') },
            { label: 'Distribute Y', click: send('distribute-y') },
            { label: 'Distribute Z', click: send('distribute-z') },
          ],
        },
        { label: 'Keyboard Shortcuts...',                           click: send('open-shortcuts') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Onboarding Tour', click: send('start-onboarding') },
        { type: 'separator' },
        { label: 'Shortcuts & Help', click: send('help') },
        { type: 'separator' },
        {
          label: 'Reveal Error Log…',
          click: () => {
            try {
              const { shell } = require('electron');
              const p = path.join(app.getPath('userData'), 'td-errors.log');
              if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
              shell.showItemInFolder(p);
            } catch (_) {}
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  setTimeout(() => checkForUpdatesSilently(win), 3000);
  return win;
}

/* ------ Auto-update wiring -------------------------------------------- */
function checkForUpdatesSilently(win) {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', (info) => {
    const res = dialog.showMessageBoxSync(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      title: 'Update ready',
      message: `Turtle Drawing ${info.version} has been downloaded.`,
      detail: 'Restart now to apply the new version.',
    });
    if (res === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => console.error('[updater]', err));
  autoUpdater.checkForUpdates().catch(() => {});
}

function checkForUpdatesManually(win) {
  if (!autoUpdater) {
    dialog.showMessageBox(win, { type: 'info', message: 'Updates work only in distributed builds.' });
    return;
  }
  autoUpdater.once('update-not-available', () => {
    dialog.showMessageBox(win, { type: 'info', message: 'You are using the latest version.' });
  });
  autoUpdater.once('error', (err) => {
    dialog.showMessageBox(win, { type: 'error', message: 'Update check failed', detail: String(err) });
  });
  autoUpdater.checkForUpdates();
}

// File-open handler (macOS double-click on .tt). Queues the file path
// until a window is ready, then loads it via the same IPC the file menu
// uses. Also handles `open-file` events arriving while the app is running.
const _pendingOpenFiles = [];
function _dispatchFileOpen(filePath) {
  let docJson;
  try { docJson = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { return; }
  const filename = path.basename(filePath);
  const dispatch = (win) => {
    try { win.webContents.send('menu-action', 'file-open-data', { docJson, filename, fullPath: filePath }); } catch (_) {}
  };
  let target = (BrowserWindow.getFocusedWindow && BrowserWindow.getFocusedWindow())
            || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
  if (target && !target.isDestroyed() && target.webContents && !target.webContents.isDestroyed()) {
    dispatch(target);
  } else {
    const w = createWindow();
    if (w) w.webContents.once('did-finish-load', () => dispatch(w));
  }
}
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) _dispatchFileOpen(filePath);
  else _pendingOpenFiles.push(filePath);
});
app.whenReady().then(() => {
  if (_pendingOpenFiles.length === 0) createWindow();
  while (_pendingOpenFiles.length) _dispatchFileOpen(_pendingOpenFiles.shift());
});
// Windows/Linux: file path passed as argv
if (process.platform !== 'darwin') {
  for (const arg of process.argv.slice(1)) {
    if (arg && arg.toLowerCase().endsWith('.tt') && fs.existsSync(arg)) {
      _pendingOpenFiles.push(path.resolve(arg));
    }
  }
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Chrome-style "Hold ⌘Q to quit". A first invocation arms the quit and
// shows a transient toast; if the user invokes again within 900ms (which
// the OS does while ⌘Q is held), we actually quit — but first check for
// unsaved changes and prompt to save.
// Mark a CLEAN exit in every renderer so the crash-recovery check on the next
// launch knows this shutdown was intentional. beforeunload covers the red-X /
// menu-quit paths, but app.exit(0) below bypasses it, so set the flag here too.
// Set by confirmDiscardIfDirty when dirty tabs remain after a partial save —
// the exit must NOT be marked clean, so the next launch offers recovery.
let _skipCleanExit = false;
async function _markCleanExit() {
  if (_skipCleanExit) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.webContents || w.webContents.isDestroyed()) continue;
    try { await w.webContents.executeJavaScript("try{localStorage.setItem('turtle_clean_exit_v1','1')}catch(e){}", true); } catch (_) {}
    // app.exit() below skips the per-window 'closed' cleanup — remove the
    // autosave snapshots here so a clean quit never triggers recovery.
    try { fs.unlinkSync(_autosavePathFor(w.webContents.id)); } catch (_) {}
  }
}
let _quitArmedUntil = 0;
async function holdToQuit() {
  const now = Date.now();
  if (now < _quitArmedUntil) {
    const ok = await confirmDiscardIfDirty();
    if (ok) { await _markCleanExit(); app.exit(0); }
    return;
  }
  _quitArmedUntil = now + 900;
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('menu-action', 'show-hold-to-quit-toast'); } catch (_) {}
  }
}

// Ask the renderer if any tab is dirty; if so, show a Save/Don't Save/Cancel
// dialog. Returns true if it's OK to proceed with the destructive action.
async function confirmDiscardIfDirty() {
  let dirty = false;
  const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
  for (const w of wins) {
    try {
      const r = await w.webContents.executeJavaScript(`
        (function(){
          try {
            const T = window.AD && window.AD.Tabs;
            if (!T || !T.list) return false;
            return T.list.some(function(t){ return !!t.dirty; });
          } catch (_) { return false; }
        })()
      `, true);
      if (r) { dirty = true; break; }
    } catch (_) {}
  }
  if (!dirty) return true;
  const choice = dialog.showMessageBoxSync(wins[0] || null, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0, cancelId: 2,
    message: '저장하지 않은 변경 사항이 있습니다.',
    detail: '종료하기 전에 저장할까요?',
  });
  if (choice === 2) return false;        // Cancel
  if (choice === 1) return true;         // Don't Save → quit
  // Save: serialize the scene in the renderer, then show a native Save
  // dialog so the user can pick a location and filename. Write the file
  // directly with fs (avoids the browser-download path that auto-saves
  // to the default Downloads folder).
  const win = wins[0];
  if (!win) return true;
  let payload;
  try {
    payload = await win.webContents.executeJavaScript(`
      (function(){
        try {
          if (typeof sceneToDoc !== 'function') return null;
          // Same guards as the in-app save path: block on NaN vertices (a file
          // with null coordinates may never reopen), warn on mesh-health issues.
          if (typeof _saveNaNScan === 'function') {
            const nan = _saveNaNScan();
            if (nan && nan.bad > 0) return { nanBlocked: true, names: nan.names };
          }
          try { if (typeof _saveIntegrityCheck === 'function') _saveIntegrityCheck(); } catch (_) {}
          const doc = sceneToDoc();
          const defName = (currentFileName || 'drawing').replace(/\\.tt$/i, '') + '.tt';
          const known = (typeof currentFilePath !== 'undefined' && currentFilePath) ? currentFilePath : null;
          return { json: JSON.stringify(doc), defaultName: defName, knownPath: known };
        } catch (e) { return null; }
      })()
    `, true);
  } catch (_) { payload = null; }
  if (payload && payload.nanBlocked) {
    dialog.showErrorBox('저장 차단됨',
      '좌표가 손상된(NaN) 객체가 있어 저장하면 파일이 다시 열리지 않을 수 있습니다.\n\n' +
      '손상된 객체: ' + (payload.names || []).join(', ') + '\n\n' +
      '실행 취소(Cmd+Z)로 되돌리거나 해당 객체를 삭제한 뒤 다시 저장하세요.');
    return false;  // cancel the quit so the user can fix and save
  }
  if (!payload || !payload.json) return false;
  let target = (payload.knownPath && fs.existsSync(path.dirname(payload.knownPath))) ? payload.knownPath : null;
  if (!target) {
    target = dialog.showSaveDialogSync(win, {
      title: 'Save',
      defaultPath: payload.defaultName,
      filters: [{ name: 'Turtle Drawing', extensions: ['tt'] }],
    });
  }
  if (!target) return false;  // user cancelled
  try {
    writeTTSafely(target, payload.json);
  } catch (e) {
    dialog.showErrorBox('Save failed', String(e));
    return false;
  }
  const res = target;
  // Mark ONLY the tab we actually wrote as clean — the old forEach marked
  // every tab (including dirty background tabs that were never saved) clean,
  // and the clean-exit path then deleted the autosave that still held them.
  const basename = path.basename(res);
  try {
    await win.webContents.executeJavaScript(`
      (function(){
        try { if (typeof currentFileName !== 'undefined') currentFileName = ${JSON.stringify(basename)}; } catch(_){}
        try { window.currentFilePath = ${JSON.stringify(res)}; } catch(_){}
        try {
          const T = window.AD && window.AD.Tabs;
          if (T && T.list && T.activeId) {
            const t = T.list.find(function(x){ return x.id === T.activeId; });
            if (t) { t.dirty = false; t.filePath = ${JSON.stringify(res)}; }
          }
          if (T && T.rename && T.activeId) T.rename(T.activeId, ${JSON.stringify(basename)});
        } catch(_){}
      })()
    `, true);
  } catch (_) {}
  // If ANY tab anywhere is still dirty (background tabs, other windows),
  // preserve every window's autosave snapshot so the next launch can offer
  // recovery of the unsaved documents — only the active tab was written.
  try {
    let stillDirty = false;
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || !w.webContents || w.webContents.isDestroyed()) continue;
      try {
        const r = await w.webContents.executeJavaScript(`
          (function(){ try { const T = window.AD && window.AD.Tabs; return !!(T && T.list && T.list.some(function(t){ return !!t.dirty; })); } catch (_) { return false; } })()
        `, true);
        if (r) { stillDirty = true; break; }
      } catch (_) {}
    }
    if (stillDirty) {
      for (const w of BrowserWindow.getAllWindows()) { try { w._preserveAutosave = true; } catch (_) {} }
      _skipCleanExit = true;
    }
  } catch (_) {}
  return true;
}
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
