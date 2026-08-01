/**
 * Guard: a bad response must never become the installed app's shell.
 *
 * The bug this exists for: the navigation handler cached EVERY response under
 * '/', whatever its status. One 404 — a dead share link, a blip mid-deploy —
 * and the not-found page was the app from then on, because every later launch
 * fell back to '/' and found it sitting there. It only ever hit people who had
 * Num installed, and it never cleared on its own, which is exactly the shape
 * of "works fine in a fresh browser, says not found on my phone".
 *
 * The service worker is a classic (non-module) script, so it is run here in a
 * vm with the handful of globals it touches stubbed out. That is enough to
 * drive the real fetch handler over the real code.
 *
 * Run: node app-public/sw.test.mjs
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// A path may be passed in to run these same assertions against another copy of
// the worker — which is how the fix was checked against the version that had
// the bug, rather than trusting that a green suite meant anything.
const SRC = readFileSync(process.argv[2] ?? join(HERE, 'sw.js'), 'utf8');

let fail = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail}`));
  if (!cond) fail++;
};

/** Just enough Response to drive the handler. */
const mkRes = (status, body, extra = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  redirected: false,
  body,
  clone() { return mkRes(status, body, extra); },
  ...extra,
});

/** Boot a fresh worker with a scripted network, and return its fetch handler. */
function boot(network) {
  const handlers = {};
  const store = new Map();          // what ended up in the cache
  const cache = {
    async put(key, res) {
      if (res?.redirected) throw new Error('cannot cache a redirected response');
      store.set(String(key), res);
    },
    async add(key) {
      const res = await network(String(key));
      if (!res.ok) throw new Error('add() rejects non-2xx');
      store.set(String(key), res);
    },
    async match(key) { return store.get(String(key)); },
  };
  const ctx = {
    self: {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      location: { origin: 'https://app.itsnum.com' },
      skipWaiting: () => {},
      clients: { claim: () => {}, matchAll: async () => [] },
      registration: { showNotification: async () => {} },
    },
    caches: {
      open: async () => cache,
      match: async (k) => cache.match(typeof k === 'string' ? k : k.url),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: (input) => network(typeof input === 'string' ? input : input.url),
    URL, console, setTimeout, Promise, MessageChannel: function () {},
  };
  ctx.self.self = ctx.self;
  runInContext(SRC, createContext(ctx));
  return { onFetch: handlers.fetch, store, cache };
}

/**
 * Drive one navigation through the handler and return what the user gets.
 *
 * `intercepted` is the interesting half for the share-link paths: NOT calling
 * respondWith is the correct behaviour there, and it is invisible in the body.
 */
async function navigate(worker, url, { mode = 'navigate' } = {}) {
  let answered;
  let intercepted = false;
  await worker.onFetch({
    request: { url, method: 'GET', mode },
    respondWith: (p) => { intercepted = true; answered = p; },
  });
  const res = await answered;
  return { body: res?.body, intercepted, res };
}

console.log('\nthe shell cache:');
{
  const shell = mkRes(200, 'THE APP');
  const w = boot(async () => shell);
  const got = await navigate(w, 'https://app.itsnum.com/?app');
  check('a good page is served', got.body === 'THE APP');
  check('and becomes the cached shell', w.store.get('/')?.body === 'THE APP');
}

{
  // The exact poisoning path.
  const w = boot(async () => mkRes(404, 'NOT FOUND'));
  w.store.set('/', mkRes(200, 'THE APP'));          // a good shell already there
  const got = await navigate(w, 'https://app.itsnum.com/some/path');
  check('a 404 never overwrites the shell', w.store.get('/')?.body === 'THE APP', w.store.get('/')?.body);
  check('and the user gets the app, not the 404', got.body === 'THE APP', got.body);
}

{
  const w = boot(async () => mkRes(500, 'BOOM'));
  const got = await navigate(w, 'https://app.itsnum.com/?app');
  check('a 500 is not cached either', w.store.get('/') === undefined);
  check('and with no shell to fall back on, the real error shows', got.body === 'BOOM', got.body);
}

console.log('\nshare links are left to the browser:');
{
  /* The bug this locks down. Every short share link 302s, a navigation
     request's redirect mode is "manual", and respondWith() of a response we
     followed a redirect to get is a NETWORK ERROR — so intercepting these made
     a scanned QR or a referral link fail to load for exactly the people who
     had Num installed. It also dropped the ?c= / ?ref= the app reads, because
     the browser never performed the redirect that creates them.

     The fix is to not answer at all. `intercepted` is therefore the assertion
     that matters; the body is irrelevant because there is no body. */
  for (const path of ['/r/ABC123', '/i/tok_abc', '/c/mem_abc', '/e/slug', '/claim/confirm']) {
    const w = boot(async () => mkRes(200, 'SHOULD NEVER BE USED', { redirected: true }));
    const got = await navigate(w, `https://app.itsnum.com${path}`);
    check(`${path} is not intercepted`, got.intercepted === false);
    check(`${path} never becomes the shell`, w.store.get('/') === undefined);
  }
}

{
  // The in-app paths must still be intercepted — that is what makes the app
  // launch offline. Guards against "fix it by turning the handler off".
  const w = boot(async () => mkRes(200, 'THE APP'));
  const got = await navigate(w, 'https://app.itsnum.com/?ref=ABC123');
  check('a normal launch URL is still handled', got.intercepted === true);
  check('and still becomes the shell', w.store.get('/')?.body === 'THE APP');
}

console.log('\noffline:');
{
  const w = boot(async () => { throw new Error('offline'); });
  w.store.set('/', mkRes(200, 'THE APP'));
  const got = await navigate(w, 'https://app.itsnum.com/?app');
  check('the cached shell is served when the network is gone', got.body === 'THE APP');
}

console.log('\nremediation:');
check('the cache name was bumped so poisoned shells are evicted', /num-shell-v5/.test(SRC));

console.log(fail ? `\nFAIL — ${fail} assertion(s)` : '\nPASS — a bad response can never become the app');
process.exit(fail ? 1 : 0);
