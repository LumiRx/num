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
//
// v5 is not a routine bump — it is the remediation. Until now any navigation
// response was written to the cache as '/', so a single 404 could become the
// installed app's shell permanently. Anyone already carrying a poisoned entry
// gets it evicted by this rename on their next launch; without it they would
// keep launching into "not found" no matter how often we redeployed.
const CACHE = 'num-shell-v5';
const PRECACHE = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* Paths the Worker answers itself rather than the SPA — the public RSVP page
   and the short share links. Their 404s are meaningful ("that invite link
   isn't valid any more") and must reach the user unchanged. */
const WORKER_PATHS = /^\/(e|r|i|c)\/|^\/claim\/confirm/;

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
      // KEEP is not just the shell: the identity cache is how a push knows who
      // it is for when no tab is open, and sweeping it on every version bump
      // would silently downgrade the next notification to "Something needs you".
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'num-identity').map((k) => caches.delete(k))))
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
    /* STAY OUT OF THE WAY of the short share links and the pages the Worker
       renders. All of them 302, and a service worker may not answer a
       navigation with a response it followed a redirect to get:

         · a navigation request's redirect mode is "manual" — the browser
           reserves redirect handling for itself
         · our fetch() below defaults to redirect: "follow", so it lands on the
           target and comes back with redirected = true
         · respondWith() of a redirected response, for a request whose redirect
           mode is not "follow", is a NETWORK ERROR — the navigation fails
           outright and the user gets a browser error page

       That is why a scanned QR, a referral link or an invite "just didn't
       load" for exactly the people who had Num installed, and worked for
       everybody else: no service worker, no interception, browser follows the
       302 itself. It also silently broke the connect flow even when a page did
       render, because the app reads ?c= / ?ref= off the URL and the address bar
       still said /c/ID — the query string only exists after the redirect the
       browser was never allowed to perform.

       Returning here (no respondWith) hands the navigation back to the browser,
       which follows the 302 natively and lands on /?c=… with the query intact. */
    if (WORKER_PATHS.test(url.pathname)) return;

    // `fetch(request)` still consults the browser's HTTP cache, and index.html
    // is served must-revalidate — which a browser is entitled to satisfy from
    // its own store. The practical result was a redeploy that never reached
    // anyone until they manually cleared site data. `cache: 'no-store'` makes
    // "network-first" actually mean the network.
    event.respondWith(
      fetch(request.url, { cache: 'no-store', credentials: 'same-origin' })
        .then((res) => {
          /* ONLY a real shell may become THE shell.
             This used to cache every navigation response under '/', whatever
             it was. One 404 — a dead share link, a blip mid-deploy, a worker
             error — and the not-found page WAS the app from then on: every
             later launch of the installed app fell back to '/' and got it.
             That is why "it says not found" only ever happened to people who
             already had Num installed, and why it never cleared on its own.
             A redirected response cannot be cached either; put() rejects it. */
          if (res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {});
            return res;
          }
          /* An error status is not worth showing someone who has a working
             copy of the app on their phone. The SPA routes itself, so the
             shell can answer for any in-app path. (Worker-rendered paths never
             reach here — they returned above, before we intercepted at all.) */
          return caches.match('/').then((hit) => hit || res);
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
              // A message from a friend gets a reply box ON the notification.
              // This is the whole point: answering "on my way" should not
              // require unlocking, finding the app, and waiting for it to boot.
              // Android honours type:'text'; iOS ignores actions entirely and
              // falls back to tapping through, which is why the tap target
              // still has to work.
              ...(n.kind === 'dm'
                ? { actions: [{ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Type a reply…' }] }
                : {}),
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
  // An inline reply never opens the app — that is the feature. Send it
  // straight from the service worker and leave the phone locked.
  if (event.action === 'reply') {
    const text = (event.reply || '').trim();
    const to = new URL(event.notification.data?.url || '/', self.location.origin).searchParams.get('dm');
    event.notification.close();
    if (!text || !to) return;
    event.waitUntil(
      (async () => {
        let me = null;
        const cached = await caches.match('/__num_me');
        if (cached) me = (await cached.text()) || null;
        if (!me) return;
        await fetch('/api/dm/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // A stable id per reply, so a retried send cannot deliver it twice.
          body: JSON.stringify({ me, to, body: text, idem: 'dm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) }),
        }).catch(() => {});
      })(),
    );
    return;
  }

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
