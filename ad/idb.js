/* ============================================================================
   AD.IDB — tiny promise-based IndexedDB key-value helper (web persistence).
   ----------------------------------------------------------------------------
   Why: the browser build's autosave/recovery fell back to localStorage, whose
   ~5 MB quota silently disabled autosave on any textured import (sceneToDoc
   embeds textures as base64). IndexedDB quotas are effectively unbounded for
   our document sizes (Chromium grants up to ~60% of disk per origin).

   Stores (single DB "turtle-drawing", version 1):
     kv      — autosave snapshot ('autosave'), parked snapshots ('parked-<ts>')
     journal — error-journal lines (auto-incrementing key, ring-pruned)

   All methods resolve null / false on ANY failure — callers treat IDB exactly
   like the other optional backends (Electron IPC, localStorage) and fall
   through. Never throws.
   ============================================================================ */
(function () {
  const AD = window.AD || (window.AD = {});
  const DB_NAME = 'turtle-drawing';
  const DB_VER = 1;
  let _dbp = null;

  function open() {
    if (_dbp) return _dbp;
    _dbp = new Promise((resolve) => {
      try {
        if (!window.indexedDB) { resolve(null); return; }
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
          if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', { autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) { resolve(null); }
    });
    return _dbp;
  }

  function _tx(db, store, mode, fn) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        const out = fn(os);
        tx.oncomplete = () => resolve(out && out._want ? out.val : true);
        tx.onerror = () => resolve(out && out._want ? null : false);
        tx.onabort = () => resolve(out && out._want ? null : false);
      } catch (_) { resolve(null); }
    });
  }

  AD.IDB = {
    available() { return !!window.indexedDB; },

    async put(store, key, value) {
      const db = await open();
      if (!db) return false;
      return _tx(db, store, 'readwrite', (os) => { os.put(value, key); });
    },

    async get(store, key) {
      const db = await open();
      if (!db) return null;
      const holder = { _want: true, val: null };
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(store, 'readonly');
          const req = tx.objectStore(store).get(key);
          req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
          req.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    },

    async del(store, key) {
      const db = await open();
      if (!db) return false;
      return _tx(db, store, 'readwrite', (os) => { os.delete(key); });
    },

    async keys(store) {
      const db = await open();
      if (!db) return [];
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(store, 'readonly');
          const req = tx.objectStore(store).getAllKeys();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch (_) { resolve([]); }
      });
    },

    /* Append one line to the journal store, ring-pruned to `cap` entries. */
    async appendJournal(lines, cap) {
      const db = await open();
      if (!db) return false;
      cap = cap || 2000;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('journal', 'readwrite');
          const os = tx.objectStore('journal');
          for (const l of (Array.isArray(lines) ? lines : [lines])) os.add(String(l));
          // Prune oldest entries past the cap (count + cursor delete).
          const cnt = os.count();
          cnt.onsuccess = () => {
            let excess = cnt.result - cap;
            if (excess > 0) {
              const cur = os.openCursor();
              cur.onsuccess = () => {
                const c = cur.result;
                if (c && excess > 0) { c.delete(); excess--; c.continue(); }
              };
            }
          };
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch (_) { resolve(false); }
      });
    },

    async readJournal() {
      const db = await open();
      if (!db) return [];
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('journal', 'readonly');
          const req = tx.objectStore('journal').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch (_) { resolve([]); }
      });
    },
  };
})();
