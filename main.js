const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Override the default app name ("Electron") so the macOS menu bar,
// Dock tooltip, and About panel read "Turtle Drawing". Must run before
// `app.whenReady()`.
try { app.setName('Turtle Drawing'); } catch (_) {}
try { app.name = 'Turtle Drawing'; } catch (_) {}

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
  const _devSearch = _IS_DEV
    ? ('dev=1' + (process.env.TD_SELFTEST ? '&selftest=1' : '') + (process.env.TD_RECOVERYTEST ? '&recoverytest=1' : '') + (process.env.TD_CLEARRECOVERY ? '&clearrecovery=1' : '') + (process.env.TD_PERFTEST ? '&perftest=1' : ''))
    : '';
  win.loadFile('turtle_drawing.html', _devSearch ? { search: _devSearch } : undefined);
  // Dev-only: forward [selftest]/[health]/[recovery] diagnostic lines to stdout.
  if (_IS_DEV) {
    try {
      win.webContents.on('console-message', (_e, _l, message) => {
        if (typeof message === 'string' && (message.indexOf('[selftest]') === 0 || message.indexOf('[health]') === 0 || message.indexOf('[recovery]') === 0 || message.indexOf('[dev-error]') === 0 || message.indexOf('[perf]') === 0)) {
          process.stdout.write('[RENDERER] ' + message + '\n');
        }
      });
    } catch (_) {}
  }
  if (pendingDocJson) _pendingDocs.set(win.id, pendingDocJson);

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
              try { anyWin.webContents.send('menu-action', 'file-open-data', { docJson, filename }); } catch (_) {}
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
            { label: 'STL (3D printing)...',    click: send('export-stl') },
            { type: 'separator' },
            { label: 'Section SVG...',          click: send('export-svg') },
            { label: 'Section PDF...',          click: send('export-pdf') },
            { label: 'Section DXF...',          click: send('export-dxf') },
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
    try { win.webContents.send('menu-action', 'file-open-data', { docJson, filename }); } catch (_) {}
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
async function _markCleanExit() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.webContents || w.webContents.isDestroyed()) continue;
    try { await w.webContents.executeJavaScript("try{localStorage.setItem('turtle_clean_exit_v1','1')}catch(e){}", true); } catch (_) {}
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
          const doc = sceneToDoc();
          const defName = (currentFileName || 'drawing').replace(/\\.tt$/i, '') + '.tt';
          return { json: JSON.stringify(doc, null, 2), defaultName: defName };
        } catch (e) { return null; }
      })()
    `, true);
  } catch (_) { payload = null; }
  if (!payload || !payload.json) return false;
  const res = dialog.showSaveDialogSync(win, {
    title: 'Save',
    defaultPath: payload.defaultName,
    filters: [{ name: 'Turtle Drawing', extensions: ['tt'] }],
  });
  if (!res) return false;  // user cancelled
  try {
    fs.writeFileSync(res, payload.json, 'utf8');
  } catch (e) {
    dialog.showErrorBox('Save failed', String(e));
    return false;
  }
  // Mark all tabs clean & update filename in renderer.
  const basename = path.basename(res);
  try {
    await win.webContents.executeJavaScript(`
      (function(){
        try { if (typeof currentFileName !== 'undefined') currentFileName = ${JSON.stringify(basename)}; } catch(_){}
        try {
          const T = window.AD && window.AD.Tabs;
          if (T && T.list) T.list.forEach(function(t){ t.dirty = false; });
          if (T && T.rename && T.activeId) T.rename(T.activeId, ${JSON.stringify(basename)});
        } catch(_){}
      })()
    `, true);
  } catch (_) {}
  return true;
}
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
