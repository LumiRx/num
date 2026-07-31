// Num service worker — makes the installed app launch instantly and survive a
// dead connection. Strategy per request kind:
//
//   navigations   → network-first (a redeploy lands immediately), cached shell
//                   as the offline fallback
//   hashed assets → cache-first (Vite content-hashes filenames, so a cached
//                   entry can never be stale for a given URL)
//   fonts         → cache-first (stable third-party URLs)
//   /api/*        → never touched; Num's replies must always be live
//
// Bump CACHE to force every client to drop the old shell.
const CACHE = 'num-shell-v4';
const PRECACHE = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individual failures must not abort the install (a missing icon
      // shouldn't cost us offline support entirely).
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function cacheFirst(request) {
  return caches.match(request).then(
    (hit) =>
      hit ||
      fetch(request).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }),
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST /api/num passes straight through

  const url = new URL(request.url);
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // `fetch(request)` still consults the browser's HTTP cache, and index.html
    // is served must-revalidate — which a browser is entitled to satisfy from
    // its own store. The practical result was a redeploy that never reached
    // anyone until they manually cleared site data. `cache: 'no-store'` makes
    // "network-first" actually mean the network.
    event.respondWith(
      fetch(request.url, { cache: 'no-store', credentials: 'same-origin' })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || caches.match(request))),
    );
    return;
  }

  event.respondWith(cacheFirst(request));
});


// ── push ────────────────────────────────────────────────────────────────────
//
// The push itself carries NO payload. It is a wake-up; the content is fetched
// here, at display time, so a notification about a table that has since been
// released corrects itself instead of lying on the lock screen.

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let me = null;
      try {
        // The member id lives in the app's persisted state; the worker has no
        // localStorage, so it asks an open client, and falls back to the cache
        // if every tab is closed.
        const clientList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const c of clientList) {
          const got = await new Promise((resolve) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => resolve(e.data?.me ?? null);
            c.postMessage({ type: 'num-who' }, [ch.port2]);
            setTimeout(() => resolve(null), 400);
          });
          if (got) { me = got; break; }
        }
        if (!me) {
          const cached = await caches.match('/__num_me');
          if (cached) me = (await cached.text()) || null;
        }
        if (!me) {
          await self.registration.showNotification('Num', { body: 'Something needs you — open Num.', tag: 'num-generic', icon: '/icon-192.png' });
          return;
        }

        const res = await fetch(`/api/push/pending?me=${encodeURIComponent(me)}`, { cache: 'no-store' });
        const { notifications = [] } = await res.json();
        if (!notifications.length) return;

        await Promise.all(
          notifications.map((n) =>
            self.registration.showNotification(n.title, {
              body: n.body || '',
              // `tag` collapses: a second update about the same thing replaces
              // the first rather than stacking four alerts about one table.
              tag: n.tag || n.kind,
              renotify: true,
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              data: { url: n.url || '/?app', id: n.id },
            }),
          ),
        );
      } catch (err) {
        await self.registration.showNotification('Num', { body: 'Something needs you — open Num.', tag: 'num-generic', icon: '/icon-192.png' });
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/?app';
  event.waitUntil(
    (async () => {
      // Focus an open Num rather than opening a second copy of the app.
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (c.url.includes(self.location.origin)) {
          await c.focus();
          c.postMessage({ type: 'num-open', url: target });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
