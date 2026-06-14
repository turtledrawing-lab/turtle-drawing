/* ============================================================================
   ad/gdrive.js — Google Drive cloud save/open (web build).
   ----------------------------------------------------------------------------
   "Work from anywhere": sign in with a Google account, save the current
   document to Drive, open it on any machine, and Cmd+S keeps writing back to
   the same Drive file (tab._driveFileId marks a cloud-backed tab; the hook
   lives in saveTT).

   Privacy/scope: uses the NON-SENSITIVE `drive.file` scope — the app can only
   see files it created or that the user explicitly opened with it, never the
   rest of their Drive. Everything runs client-side against the Drive REST API
   (no app server involved); the Google Identity Services script is loaded
   lazily on first use.

   Setup: requires a Google Cloud OAuth *Web* Client ID with the site origin
   authorized. Paste it into CLIENT_ID below. Web client IDs are public by
   design — embedding one is safe.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});

  // ── CONFIG ─────────────────────────────────────────────────────────────
  // Google Cloud Console → APIs & Services → Credentials → OAuth client ID
  // (Web application; Authorized JavaScript origins: https://tdw.kr).
  const CLIENT_ID = '505623931645-848idqgu62euhainht8q162drr29ogvf.apps.googleusercontent.com';
  // Google Picker (the native Drive popup) additionally needs an API key
  // (Cloud Console → Credentials → API key) with the Picker API enabled.
  // Empty key → graceful fallback to the built-in list modal.
  const API_KEY = 'AIzaSyDniPLIFNKq7Ak5_SSwzulAxcBpIWA0iQE';
  const APP_ID = CLIENT_ID.split('-')[0];   // project number
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GSI_SRC = 'https://accounts.google.com/gsi/client';
  const GAPI_SRC = 'https://apis.google.com/js/api.js';

  let _tokenClient = null;
  let _accessToken = null;
  let _tokenExp = 0;

  // Desktop (Electron) signs in through the main-process loopback/PKCE flow
  // (window.electronGDriveAuth); the browser build uses Google Identity
  // Services. Either path is "configured" when its credential is present.
  const _isDesktop = () => !!window.electronGDriveAuth;
  const _configured = () => !!CLIENT_ID || _isDesktop();

  // The native Google Picker renders a docs.google.com iframe that needs the
  // user's Google SESSION cookie. Safari and ALL iOS browsers (WebKit) block
  // that as a third-party cookie under ITP, so the Picker fails with "invalid
  // developer key" / "can't access your Google account". On those we skip the
  // Picker and use the built-in REST list modal, which only needs the OAuth
  // token we already hold (no third-party cookie, no developer key).
  const _pickerBlocked = () => {
    try {
      const ua = navigator.userAgent || '';
      const iOS = /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1); // iPadOS 13+
      const macSafari = navigator.vendor === 'Apple Computer, Inc.' &&
        /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Android/.test(ua);
      return iOS || macSafari;
    } catch (_) { return false; }
  };
  const _say = (m) => { try { setStatus('msg', m); } catch (_) { console.log('[gdrive]', m); } };
  const _fail = (m) => { try { showError(m); } catch (_) { alert(m); } };

  async function _ensureGsi() {
    if (window.google && google.accounts && google.accounts.oauth2) return;
    await window._ensureVendor(GSI_SRC);
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      throw new Error('Google Identity script failed to load');
    }
  }

  /* Get an access token. First call pops the Google consent window; later
     calls reuse the cached token or refresh silently (prompt: ''). */
  function _getToken() {
    // Desktop: try a silent refresh (stored refresh_token in main), then fall
    // back to the interactive system-browser flow.
    if (_isDesktop()) {
      return (async () => {
        if (_accessToken && Date.now() < _tokenExp - 60000) return _accessToken;
        let tok = null;
        try { tok = await window.electronGDriveSilent(); } catch (_) {}
        if (!tok || !tok.access_token) {
          _say('브라우저에서 Google 로그인을 진행해주세요…');
          tok = await window.electronGDriveAuth();
        }
        if (!tok || !tok.access_token) throw new Error('Google 로그인에 실패했습니다');
        _accessToken = tok.access_token;
        _tokenExp = Date.now() + ((tok.expires_in || 3600) * 1000);
        return _accessToken;
      })();
    }
    return new Promise(async (resolve, reject) => {
      try {
        if (_accessToken && Date.now() < _tokenExp - 60000) { resolve(_accessToken); return; }
        await _ensureGsi();
        if (!_tokenClient) {
          _tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPE,
            callback: () => {},   // replaced per-request below
          });
        }
        _tokenClient.callback = (resp) => {
          if (resp && resp.access_token) {
            _accessToken = resp.access_token;
            _tokenExp = Date.now() + ((resp.expires_in || 3600) * 1000);
            try { localStorage.setItem('turtle_gdrive_granted', '1'); } catch (_) {}
            resolve(_accessToken);
          } else {
            reject(new Error((resp && resp.error) || 'Google sign-in was cancelled'));
          }
        };
        let granted = false;
        try { granted = localStorage.getItem('turtle_gdrive_granted') === '1'; } catch (_) {}
        _tokenClient.requestAccessToken({ prompt: granted ? '' : 'consent' });
      } catch (e) { reject(e); }
    });
  }

  async function _api(path, opts) {
    const token = await _getToken();
    const resp = await fetch(path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, ...((opts && opts.headers) || {}) },
    });
    if (resp.status === 401) {
      // token expired/revoked mid-session — clear and let the caller retry
      _accessToken = null;
      throw new Error('Google 인증이 만료되었습니다 — 다시 시도해주세요.');
    }
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json()).error.message; } catch (_) {}
      throw new Error('Drive API ' + resp.status + (detail ? ': ' + detail : ''));
    }
    return resp;
  }

  /* ── Save (create or update) ──────────────────────────────────────────── */
  async function _upload(json, fname, fileId, folderId) {
    const meta = { name: fname, mimeType: 'application/json' };
    if (!fileId) {
      meta.appProperties = { app: 'turtle-drawing' };
      if (folderId) meta.parents = [folderId];
    }
    const boundary = 'td' + Math.random().toString(36).slice(2);
    const body =
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(meta) +
      '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' +
      json +
      '\r\n--' + boundary + '--';
    const url = 'https://www.googleapis.com/upload/drive/v3/files'
      + (fileId ? '/' + encodeURIComponent(fileId) : '')
      + '?uploadType=multipart&fields=id,name,modifiedTime';
    const resp = await _api(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body,
    });
    return resp.json();
  }

  let _pickerReady = false;
  async function _ensurePicker() {
    if (_pickerReady) return true;
    // Desktop: the Google Picker is a web widget that needs a real https
    // origin, so on file:// Electron we use the built-in list modal instead.
    if (_isDesktop()) return false;
    if (!API_KEY) return false;
    if (_pickerBlocked()) return false;   // Safari/iOS: third-party cookies kill the Picker → REST list
    try {
      await window._ensureVendor(GAPI_SRC);
      await new Promise((res, rej) => gapi.load('picker', { callback: res, onerror: rej }));
      _pickerReady = true;
      return true;
    } catch (e) { console.warn('[gdrive] picker unavailable:', e); return false; }
  }

  /* Native Drive popup. mode 'open' → pick a .tt file; mode 'folder' → pick a
     destination folder. Resolves the picked doc ({id,name}) or null. */
  function _showPicker(token, mode) {
    return new Promise((resolve) => {
      let view;
      if (mode === 'folder') {
        view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMimeTypes('application/vnd.google-apps.folder');
      } else {
        view = new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setIncludeFolders(true)
          .setMimeTypes('application/json,text/plain,application/octet-stream');
      }
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .setAppId(APP_ID)
        .setLocale('ko')
        .addView(view)
        .setTitle(mode === 'folder' ? '저장할 폴더 선택' : 'Turtle Drawing 문서 열기')
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const d = data.docs && data.docs[0];
            resolve(d ? { id: d.id, name: d.name } : null);
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
    });
  }

  /* Desktop: open the official Google Picker in a dedicated https window (main
     hosts tdw.kr/desktop-picker.html — file:// can't run the Picker widget).
     Returns {id,name} on pick, null on cancel, undefined when the picker window
     is unavailable so callers can fall back to the built-in list/REST path. */
  async function _desktopPicker(mode) {
    if (!_isDesktop() || !window.electronGDrivePicker) return undefined;
    try {
      const token = await _getToken();
      const r = await window.electronGDrivePicker({ token, apiKey: API_KEY, appId: APP_ID, mode, locale: 'ko' });
      if (!r) return null;            // window closed without a pick → cancel
      if (r.failed) return undefined; // couldn't load → fall back
      // The id comes from a remote page — treat as untrusted; only accept a
      // well-formed Drive file id (defense-in-depth before we fetch it).
      if (r.id && /^[A-Za-z0-9_-]{10,}$/.test(r.id)) return { id: String(r.id), name: String(r.name || '') };
      return null;
    } catch (_) { return undefined; }
  }

  /* Cmd+S path for Drive-backed tabs (json already built+guarded by saveTT). */
  AD.GDrive = {
    isConfigured: _configured,

    async saveCurrent(json, fname, tab, folderId) {
      if (!_configured()) { _fail(_setupMsg()); return; }
      try {
        _say('Google Drive에 저장 중…');
        const r = await _upload(json, fname, tab._driveFileId, folderId);
        tab._driveFileId = r.id;
        try { _markSavedAs(r.name); } catch (_) {}
        _say('☁ Google Drive에 저장됨 — ' + r.name);
      } catch (e) {
        console.error('[gdrive]', e);
        _fail('Drive 저장 실패: ' + (e && e.message || e));
      }
    },

    /* File ▸ Save to Google Drive (explicit; also links the tab to Drive). */
    async saveAs() {
      if (!_configured()) { _fail(_setupMsg()); return; }
      const json = window._buildTTJson();
      if (json == null) return;
      const fname = ((window.currentFileName || 'drawing').replace(/\.tt$/i, '')) + '.tt';
      const T = AD.Tabs;
      const tab = (T && T.list) ? T.list.find(x => x.id === T.activeId) : null;
      // Native Drive popup: pick the destination folder (first save only —
      // Cmd+S updates in place without any popup).
      let folderId = null;
      try {
        if (_isDesktop() && window.electronGDrivePicker) {
          const r = await _desktopPicker('folder');
          if (r && r.id) folderId = r.id;
          else if (r === null) { _say('취소됨'); return; }
          // In this branch the picker IS applicable, so undefined means the
          // window failed to load/timed out — surface it instead of silently
          // saving to Drive root.
          else { _fail('Google Drive 폴더 선택 창을 열지 못했습니다 — 다시 시도해주세요.'); return; }
        } else {
          const token = await _getToken();
          if (await _ensurePicker()) {
            const picked = await _showPicker(token, 'folder');
            if (!picked) { _say('취소됨'); return; }
            folderId = picked.id;
          }
        }
      } catch (e) { _fail('Google 로그인 실패: ' + (e && e.message || e)); return; }
      await AD.GDrive.saveCurrent(json, fname, tab || {}, folderId);
    },

    /* File ▸ Open from Google Drive — list this app's .tt files, pick one. */
    async open() {
      if (!_configured()) { _fail(_setupMsg()); return; }
      try {
        let pick = null;
        // Desktop: official Google Picker in a dedicated https window.
        if (_isDesktop() && window.electronGDrivePicker) {
          const r = await _desktopPicker('open');
          if (r && r.id) pick = r;
          else if (r === null) { _say('취소됨'); return; }
          // r === undefined → picker window unavailable → fall through below
        }
        if (!pick) {
          const token = await _getToken();
          if (await _ensurePicker()) {
            // Native Drive popup — picking a file also GRANTS drive.file access
            // to it, so even .tt files uploaded outside the app become openable.
            pick = await _showPicker(token, 'open');
            if (!pick) { _say('취소됨'); return; }
          } else {
            // Fallback (iOS/Safari, or no API key): list the app's files via REST
            // and show the built-in modal — grouped by parent folder, searchable.
            // drive.file scope means we only see files THIS app created/opened and
            // the folders it was granted (e.g. a desktop "save into folder").
            _say('Google Drive 목록을 불러오는 중…');
            const q = encodeURIComponent("appProperties has { key='app' and value='turtle-drawing' } and trashed=false");
            const resp = await _api('https://www.googleapis.com/drive/v3/files?q=' + q
              + '&orderBy=modifiedTime desc&pageSize=200&fields=files(id,name,modifiedTime,size,parents)');
            const { files } = await resp.json();
            if (!files || !files.length) { _say('Drive에 저장된 Turtle Drawing 문서가 없습니다.'); return; }
            const folderNames = await _resolveFolderNames(files);
            pick = await _pickModal(files, folderNames);
            if (!pick) { _say('취소됨'); return; }
          }
        }
        _say('내려받는 중 — ' + pick.name + '…');
        const dl = await _api('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(pick.id) + '?alt=media');
        const text = await dl.text();
        openTT(text, pick.name);
        const T = AD.Tabs;
        const tab = (T && T.list) ? T.list.find(x => x.id === T.activeId) : null;
        if (tab) { tab._driveFileId = pick.id; tab._fsHandle = null; }
        _say('☁ Drive에서 열림 — ' + pick.name + ' (Cmd+S로 Drive에 저장)');
      } catch (e) {
        console.error('[gdrive]', e);
        _fail('Drive 열기 실패: ' + (e && e.message || e));
      }
    },

    signOut() {
      try { if (_accessToken && window.google) google.accounts.oauth2.revoke(_accessToken, () => {}); } catch (_) {}
      _accessToken = null; _tokenExp = 0;
      try { localStorage.removeItem('turtle_gdrive_granted'); } catch (_) {}
      // Desktop: drop the stored refresh_token in the main process too.
      try { if (window.electronGDriveSignout) window.electronGDriveSignout(); } catch (_) {}
      _say('Google Drive에서 로그아웃했습니다.');
    },
  };

  function _setupMsg() {
    return 'Google Drive 연동이 아직 설정되지 않았습니다.\n'
      + '(개발자: Google Cloud Console에서 OAuth Web Client ID를 만들어 ad/gdrive.js의 CLIENT_ID에 넣으세요.)';
  }

  /* Resolve parent-folder display names for the listed files. With drive.file
     we can read a folder's metadata only when the app was granted it (created
     it, or saved into it via the folder picker); anything else (incl. My Drive
     root) fails the get and falls back to a "내 드라이브" label. One parallel
     batch of gets, failures tolerated. */
  async function _resolveFolderNames(files) {
    const ids = [...new Set(files.flatMap((f) => f.parents || []))];
    const map = {};
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await _api('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?fields=id,name');
        map[id] = (await r.json()).name || null;
      } catch (_) { map[id] = null; }
    }));
    return map;
  }

  /* File-pick modal — files grouped under their parent folder, with a live
     search box. Folders whose names we couldn't read (root, or not granted)
     collapse into a "내 드라이브" group. Resolves the picked file or null. */
  function _pickModal(files, folderNames) {
    folderNames = folderNames || {};
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:100000;box-sizing:border-box;padding:12px;' +
        'display:flex;align-items:center;justify-content:center;font:13px -apple-system,sans-serif;';
      const box = document.createElement('div');
      box.style.cssText =
        'background:#fff;border-radius:10px;width:min(520px,94vw);max-height:82vh;' +
        'box-shadow:0 12px 40px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;';
      const head = document.createElement('div');
      head.style.cssText = 'padding:12px 16px 8px;border-bottom:0.5px solid rgba(0,0,0,0.1);';
      head.innerHTML = '<div style="font-weight:600;margin-bottom:8px;">Google Drive — Turtle Drawing 문서</div>';
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = '파일 검색…';
      search.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 11px;border:0.5px solid rgba(0,0,0,0.2);' +
        'border-radius:8px;font:13px -apple-system,sans-serif;outline:none;';
      head.appendChild(search);
      const list = document.createElement('div');
      list.style.cssText = 'overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px;flex:1;';

      // Group by parent folder, preserving the (modifiedTime desc) input order.
      const groups = new Map();
      for (const f of files) {
        const pid = (f.parents && f.parents[0]) || '';
        const label = folderNames[pid] || '내 드라이브';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(f);
      }
      const render = () => {
        list.innerHTML = '';
        const term = search.value.trim().toLowerCase();
        let shown = 0;
        for (const [label, fs] of groups) {
          const matched = term ? fs.filter((f) => (f.name || '').toLowerCase().includes(term)) : fs;
          if (!matched.length) continue;
          const hdr = document.createElement('div');
          hdr.style.cssText = 'display:flex;align-items:center;gap:6px;padding:9px 10px 4px;color:#888;font-size:11px;font-weight:600;';
          hdr.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="#c9a23f" style="flex:none;"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
            + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label.replace(/</g, '&lt;') + '</span>';
          list.appendChild(hdr);
          for (const f of matched) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 12px;border-radius:6px;cursor:pointer;';
            const when = f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : '';
            row.innerHTML = '<span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (f.name || '').replace(/</g, '&lt;') + '</span>'
              + '<span style="color:#888;font-size:11px;flex:none;">' + when + '</span>';
            row.onmouseenter = () => row.style.background = 'rgba(153,255,153,0.3)';
            row.onmouseleave = () => row.style.background = '';
            row.onclick = () => { cleanup(); resolve(f); };
            list.appendChild(row);
            shown++;
          }
        }
        if (!shown) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:22px;text-align:center;color:#aaa;';
          empty.textContent = '검색 결과 없음';
          list.appendChild(empty);
        }
      };
      search.addEventListener('input', render);
      render();

      const foot = document.createElement('div');
      foot.style.cssText = 'padding:10px 16px;border-top:0.5px solid rgba(0,0,0,0.1);text-align:right;';
      const cancel = document.createElement('button');
      cancel.textContent = '취소';
      cancel.style.cssText = 'padding:8px 16px;border:0.5px solid rgba(0,0,0,0.2);border-radius:6px;background:#f5f5f7;cursor:pointer;font:13px -apple-system,sans-serif;';
      cancel.onclick = () => { cleanup(); resolve(null); };
      foot.appendChild(cancel);
      box.appendChild(head); box.appendChild(list); box.appendChild(foot);
      wrap.appendChild(box);
      const cleanup = () => wrap.remove();
      wrap.addEventListener('click', (e) => { if (e.target === wrap) { cleanup(); resolve(null); } });
      document.body.appendChild(wrap);
      // Autofocus the search on pointer (mouse) devices only — on touch it would
      // pop the keyboard over the list.
      try {
        if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) {
          setTimeout(() => { try { search.focus(); } catch (_) {} }, 50);
        }
      } catch (_) {}
    });
  }
})();
