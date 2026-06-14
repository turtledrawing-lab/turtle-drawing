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
  // drive.file (NON-sensitive): create/read files the app made or the user
  // picked. drive.readonly (RESTRICTED): read the WHOLE Drive — needed only for
  // the iOS/Safari full-folder browser (the Picker, which browses without it,
  // is blocked there). Requested ONLY where the browser is used, so desktop
  // Chrome keeps the clean drive.file-only consent (no "unverified app" warning).
  const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
  const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
  const GSI_SRC = 'https://accounts.google.com/gsi/client';
  const GAPI_SRC = 'https://apis.google.com/js/api.js';

  let _tokenClient = null;
  let _tokenClientScope = '';   // scope the cached client was built with
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
  // Readonly only where the folder browser runs; drive.file elsewhere. Separate
  // consent-granted flags per scope set so adding readonly forces a fresh
  // consent on those devices without re-prompting drive.file-only users.
  const _scopeStr = () => _pickerBlocked() ? (DRIVE_FILE + ' ' + DRIVE_READONLY) : DRIVE_FILE;
  const _grantKey = () => _pickerBlocked() ? 'turtle_gdrive_granted_ro' : 'turtle_gdrive_granted';
  const _say = (m) => { try { setStatus('msg', m); } catch (_) { console.log('[gdrive]', m); } };
  const _fail = (m) => { try { showError(m); } catch (_) { alert(m); } };
  // Escape EVERYTHING that comes from Drive (file/folder names can be attacker-
  // controlled via a shared file) before it touches innerHTML.
  const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
        // Recreate the token client if the needed scope changed (defensive —
        // _pickerBlocked() is stable per device, but never request a token from
        // a client baked with the wrong scope).
        if (!_tokenClient || _tokenClientScope !== _scopeStr()) {
          _tokenClientScope = _scopeStr();
          _tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: _tokenClientScope,
            callback: () => {},   // replaced per-request below
          });
        }
        _tokenClient.callback = (resp) => {
          if (resp && resp.access_token) {
            // If readonly was requested (iOS/Safari) but Google didn't grant it,
            // do NOT mark consent done — reject so the user re-tries / fixes the
            // consent screen, instead of silently 403-ing in the folder browser.
            const grantedScopes = (resp.scope || '').split(/\s+/);
            if (_pickerBlocked() && !grantedScopes.some((s) => /drive\.readonly/.test(s))) {
              _accessToken = null;
              try { localStorage.removeItem(_grantKey()); } catch (_) {}
              reject(new Error('Google Drive 폴더 접근(읽기) 권한이 허용되지 않았습니다 — 다시 로그인하여 모든 권한을 허용해주세요.'));
              return;
            }
            _accessToken = resp.access_token;
            _tokenExp = Date.now() + ((resp.expires_in || 3600) * 1000);
            try { localStorage.setItem(_grantKey(), '1'); } catch (_) {}
            resolve(_accessToken);
          } else {
            reject(new Error((resp && resp.error) || 'Google sign-in was cancelled'));
          }
        };
        let granted = false;
        try { granted = localStorage.getItem(_grantKey()) === '1'; } catch (_) {}
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
      // 403 "Insufficient Permission" = the token lacks a needed scope (usually
      // drive.readonly not granted / not on the Cloud Console consent screen).
      // Clear the consent flag + token so the next attempt re-prompts, and give
      // actionable guidance instead of the raw Google message.
      if (resp.status === 403 && /insufficient|permission|scope/i.test(detail)) {
        _accessToken = null;
        try { localStorage.removeItem(_grantKey()); } catch (_) {}
        throw new Error('Google Drive 읽기 권한이 없습니다. 로그아웃 후 다시 로그인해 권한을 허용해주세요. (계속 안 되면 Cloud Console OAuth 동의 화면에 drive.readonly 범위를 추가해야 합니다.)');
      }
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
        // A file opened via the read-only folder browser isn't app-writable, so
        // save a NEW copy (drive.file) instead of PATCHing it (which would 403).
        const baseId = (tab && tab._driveReadOnly) ? null : (tab && tab._driveFileId);
        const r = await _upload(json, fname, baseId, folderId);
        if (tab) { tab._driveFileId = r.id; tab._driveReadOnly = false; }
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
        let pick = null, pickReadOnly = false;
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
          } else if (_pickerBlocked()) {
            // iOS/Safari: the Picker is blocked, so browse the full Drive folder
            // tree ourselves (drive.readonly). The token (incl. readonly) is
            // already fetched above. Browse-opened files are read-only, so a
            // later save writes a NEW copy (see saveCurrent).
            pick = await _folderBrowser();
            if (!pick) { _say('취소됨'); return; }
            pickReadOnly = true;
          } else {
            // No Picker and not the readonly browser (e.g. missing API key on a
            // non-Apple browser): list just the app's files via REST + modal,
            // grouped by parent folder, searchable (drive.file scope).
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
        if (tab) { tab._driveFileId = pick.id; tab._fsHandle = null; tab._driveReadOnly = pickReadOnly; }
        _say('☁ Drive에서 열림 — ' + pick.name + (pickReadOnly ? ' (편집 후 저장하면 새 파일로 저장됩니다)' : ' (Cmd+S로 Drive에 저장)'));
      } catch (e) {
        console.error('[gdrive]', e);
        _fail('Drive 열기 실패: ' + (e && e.message || e));
      }
    },

    signOut() {
      try { if (_accessToken && window.google) google.accounts.oauth2.revoke(_accessToken, () => {}); } catch (_) {}
      _accessToken = null; _tokenExp = 0;
      try { localStorage.removeItem('turtle_gdrive_granted'); localStorage.removeItem('turtle_gdrive_granted_ro'); } catch (_) {}
      // Desktop: drop the stored refresh_token in the main process too.
      try { if (window.electronGDriveSignout) window.electronGDriveSignout(); } catch (_) {}
      _say('Google Drive에서 로그아웃했습니다.');
    },
  };

  function _setupMsg() {
    return 'Google Drive 연동이 아직 설정되지 않았습니다.\n'
      + '(개발자: Google Cloud Console에서 OAuth Web Client ID를 만들어 ad/gdrive.js의 CLIENT_ID에 넣으세요.)';
  }

  /* Full Drive folder browser — used on iOS/Safari where the native Picker is
     blocked. Needs the drive.readonly scope (requested there). Navigate folders
     from My Drive down (breadcrumb), tap a .tt to open. Resolves {id,name} or
     null on cancel. */
  function _folderBrowser() {
    const FOLDER = 'application/vnd.google-apps.folder';
    return new Promise((resolve) => {
      let stack = [{ id: 'root', name: '내 드라이브' }];
      let loadGen = 0;   // guards against a slow folder load clobbering a newer one
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:100000;box-sizing:border-box;padding:12px;' +
        'display:flex;align-items:center;justify-content:center;font:13px -apple-system,sans-serif;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:10px;width:min(560px,94vw);height:min(640px,82vh);' +
        'box-shadow:0 12px 40px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;';
      const head = document.createElement('div');
      head.style.cssText = 'padding:12px 16px;border-bottom:0.5px solid rgba(0,0,0,0.1);display:flex;flex-direction:column;gap:8px;';
      head.innerHTML = '<div style="font-weight:600;">Google Drive에서 열기</div>';
      const crumb = document.createElement('div');
      crumb.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:1px;font-size:12px;';
      head.appendChild(crumb);
      const list = document.createElement('div');
      list.style.cssText = 'overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px;flex:1;';
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

      const renderCrumb = () => {
        crumb.innerHTML = '';
        stack.forEach((node, i) => {
          if (i) { const sep = document.createElement('span'); sep.textContent = '›'; sep.style.cssText = 'color:#bbb;margin:0 3px;'; crumb.appendChild(sep); }
          const seg = document.createElement('span');
          seg.textContent = node.name;
          const isLast = i === stack.length - 1;
          seg.style.cssText = 'display:inline-block;padding:6px 2px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            (isLast ? 'color:#444;font-weight:600;' : 'color:#0a7d2c;cursor:pointer;');
          if (!isLast) seg.onclick = () => { stack = stack.slice(0, i + 1); load(); };
          crumb.appendChild(seg);
        });
      };

      const mkRow = (label, sub, isFolder, onClick) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px;border-radius:6px;cursor:pointer;';
        const icon = isFolder
          ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="#c9a23f" style="flex:none;"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
          : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5a8f5a" stroke-width="2" style="flex:none;"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>';
        row.innerHTML = icon
          + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + (isFolder ? 'font-weight:500;' : '') + '">' + _esc(label) + '</span>'
          + (sub ? '<span style="color:#999;font-size:11px;flex:none;">' + _esc(sub) + '</span>' : '')
          + (isFolder ? '<span style="color:#ccc;flex:none;font-size:15px;">›</span>' : '');
        row.onmouseenter = () => row.style.background = 'rgba(153,255,153,0.3)';
        row.onmouseleave = () => row.style.background = '';
        row.onclick = onClick;
        return row;
      };

      async function load() {
        const gen = ++loadGen;
        renderCrumb();
        list.innerHTML = '<div style="padding:24px;text-align:center;color:#aaa;">불러오는 중…</div>';
        const folderId = stack[stack.length - 1].id;
        let files;
        try {
          const q = "'" + folderId + "' in parents and trashed=false and (mimeType='" + FOLDER + "' or fileExtension='tt')";
          const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q)
            + '&orderBy=folder,name&pageSize=400&fields=files(id,name,mimeType,modifiedTime)';
          files = ((await (await _api(url)).json()).files) || [];
        } catch (e) {
          if (gen !== loadGen) return;   // superseded by a newer navigation
          list.innerHTML = '<div style="padding:24px;text-align:center;color:#c0392b;">목록을 불러오지 못했습니다.<br><span style="font-size:11px;color:#999;">' + _esc(e && e.message) + '</span></div>';
          return;
        }
        if (gen !== loadGen) return;   // a newer load() started while we awaited — drop this one
        const folders = files.filter((f) => f.mimeType === FOLDER);
        const docs = files.filter((f) => f.mimeType !== FOLDER);
        list.innerHTML = '';
        if (!folders.length && !docs.length) {
          list.innerHTML = '<div style="padding:24px;text-align:center;color:#aaa;">이 폴더엔 하위 폴더나 .tt 파일이 없습니다.</div>';
          return;
        }
        folders.forEach((f) => list.appendChild(mkRow(f.name, '', true, () => { stack.push({ id: f.id, name: f.name }); load(); })));
        docs.forEach((f) => {
          const when = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '';
          list.appendChild(mkRow(f.name, when, false, () => { cleanup(); resolve({ id: f.id, name: f.name }); }));
        });
      }
      load();
    });
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
            + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(label) + '</span>';
          list.appendChild(hdr);
          for (const f of matched) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 12px;border-radius:6px;cursor:pointer;';
            const when = f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : '';
            row.innerHTML = '<span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(f.name) + '</span>'
              + '<span style="color:#888;font-size:11px;flex:none;">' + _esc(when) + '</span>';
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
