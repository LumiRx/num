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
const CACHE = 'num-shell-v3';
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
