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
  const API_KEY = '';
  const APP_ID = CLIENT_ID.split('-')[0];   // project number
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GSI_SRC = 'https://accounts.google.com/gsi/client';
  const GAPI_SRC = 'https://apis.google.com/js/api.js';

  let _tokenClient = null;
  let _accessToken = null;
  let _tokenExp = 0;

  const _configured = () => !!CLIENT_ID;
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
    if (!API_KEY) return false;
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
        const token = await _getToken();
        if (await _ensurePicker()) {
          const picked = await _showPicker(token, 'folder');
          if (!picked) { _say('취소됨'); return; }
          folderId = picked.id;
        }
      } catch (e) { _fail('Google 로그인 실패: ' + (e && e.message || e)); return; }
      await AD.GDrive.saveCurrent(json, fname, tab || {}, folderId);
    },

    /* File ▸ Open from Google Drive — list this app's .tt files, pick one. */
    async open() {
      if (!_configured()) { _fail(_setupMsg()); return; }
      try {
        const token = await _getToken();
        let pick = null;
        if (await _ensurePicker()) {
          // Native Drive popup — picking a file also GRANTS drive.file access
          // to it, so even .tt files uploaded outside the app become openable.
          pick = await _showPicker(token, 'open');
          if (!pick) { _say('취소됨'); return; }
        } else {
          // Fallback: app-created files via the REST list + built-in modal.
          _say('Google Drive 목록을 불러오는 중…');
          const q = encodeURIComponent("appProperties has { key='app' and value='turtle-drawing' } and trashed=false");
          const resp = await _api('https://www.googleapis.com/drive/v3/files?q=' + q
            + '&orderBy=modifiedTime desc&pageSize=50&fields=files(id,name,modifiedTime,size)');
          const { files } = await resp.json();
          if (!files || !files.length) { _say('Drive에 저장된 Turtle Drawing 문서가 없습니다.'); return; }
          pick = await _pickModal(files);
          if (!pick) { _say('취소됨'); return; }
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
      _say('Google Drive에서 로그아웃했습니다.');
    },
  };

  function _setupMsg() {
    return 'Google Drive 연동이 아직 설정되지 않았습니다.\n'
      + '(개발자: Google Cloud Console에서 OAuth Web Client ID를 만들어 ad/gdrive.js의 CLIENT_ID에 넣으세요.)';
  }

  /* Minimal file-pick modal (name + modified time rows). */
  function _pickModal(files) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:100000;' +
        'display:flex;align-items:center;justify-content:center;font:13px -apple-system,sans-serif;';
      const box = document.createElement('div');
      box.style.cssText =
        'background:#fff;border-radius:10px;min-width:380px;max-width:520px;max-height:70vh;' +
        'box-shadow:0 12px 40px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;';
      box.innerHTML = '<div style="padding:12px 16px;font-weight:600;border-bottom:0.5px solid rgba(0,0,0,0.1);">Google Drive — Turtle Drawing 문서</div>';
      const list = document.createElement('div');
      list.style.cssText = 'overflow-y:auto;padding:6px;';
      for (const f of files) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;gap:16px;padding:8px 10px;border-radius:6px;cursor:pointer;';
        const when = f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : '';
        row.innerHTML = '<span style="font-weight:500;">' + f.name.replace(/</g, '&lt;') + '</span>'
          + '<span style="color:#888;font-size:11px;">' + when + '</span>';
        row.onmouseenter = () => row.style.background = 'rgba(10,132,255,0.1)';
        row.onmouseleave = () => row.style.background = '';
        row.onclick = () => { cleanup(); resolve(f); };
        list.appendChild(row);
      }
      const foot = document.createElement('div');
      foot.style.cssText = 'padding:10px 16px;border-top:0.5px solid rgba(0,0,0,0.1);text-align:right;';
      const cancel = document.createElement('button');
      cancel.textContent = '취소';
      cancel.style.cssText = 'padding:5px 14px;border:0.5px solid rgba(0,0,0,0.2);border-radius:6px;background:#f5f5f7;cursor:pointer;';
      cancel.onclick = () => { cleanup(); resolve(null); };
      foot.appendChild(cancel);
      box.appendChild(list); box.appendChild(foot);
      wrap.appendChild(box);
      const cleanup = () => wrap.remove();
      wrap.addEventListener('click', (e) => { if (e.target === wrap) { cleanup(); resolve(null); } });
      document.body.appendChild(wrap);
    });
  }
})();
