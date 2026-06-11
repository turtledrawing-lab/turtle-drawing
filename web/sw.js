/* Turtle Drawing — service worker (web build only).
   Generated/stamped by build/web.sh: __TD_SHA__ becomes the deploy sha and
   __TD_PRECACHE__ becomes the core asset list (HTML + JS + fonts; NOT the
   19 MB entourage library or the 2.5 MB rhino3dm wasm — those runtime-cache
   on first use).

   Strategy:
   - navigations (the HTML): network-first, cache fallback → users get each
     deploy immediately when online, and full offline boot when not.
   - everything else under our scope: cache-first in a per-deploy cache →
     immutable-by-version; activate deletes caches from older deploys.
   - skipWaiting on message → the page shows a "new version" toast and the
     user opts into the reload (no mid-session surprise swap). */
const SHA = '__TD_SHA__';
const CACHE = 'td-' + SHA;
const PRECACHE = __TD_PRECACHE__;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {})   // partial precache failure must not brick install
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('td-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'td-skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE);
        c.put('./', net.clone()).catch(() => {});
        return net;
      } catch (_) {
        const hit = await caches.match('./');
        return hit || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: false });
    if (hit) return hit;
    try {
      const net = await fetch(req);
      // Runtime-cache same-origin assets (entourage SVGs, wasm, typefaces…)
      if (net && net.ok) {
        const c = await caches.open(CACHE);
        c.put(req, net.clone()).catch(() => {});
      }
      return net;
    } catch (err) {
      // Offline miss: try ignoring the ?v= cache-bust as a last resort.
      const loose = await caches.match(req, { ignoreSearch: true });
      if (loose) return loose;
      throw err;
    }
  })());
});
