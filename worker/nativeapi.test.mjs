// The TestFlight signup crash, and the class of bug behind it.
//
// 15 Aug 2026, first TestFlight build: adding a name and number failed with
// `undefined is not an object (evaluating 'r.mr.name')` and the app could not
// be used at all. The cause was not in the signup code.
//
// capacitor.config.ts bundles dist/ rather than pointing at a remote URL —
// deliberately, because a thin remote shell is where App Review 4.2 sends you
// home. Its own comment claims the bundled app "talks to the same /api/* the
// web app does". Nothing made that true. On iOS the origin is
// capacitor://localhost, so every relative /api fetch hit the LOCAL BUNDLE,
// the SPA fallback returned index.html with status 200, and the JSON parse
// failed into an empty object.
//
// All 39 API calls in the app had this. Signup was just the first one a user
// reaches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
});

test('no API call is left relative — they all break inside the native shell', () => {
  const offenders = [];
  for (const f of walk(SRC)) {
    if (f.endsWith('apibase.ts')) continue; // documents the bug in prose
    const s = readFileSync(f, 'utf8');
    // fetch('/api/…') without apiUrl() around it.
    for (const m of s.matchAll(/fetch\(\s*(['"`])(\/api\/[^'"`]*)\1/g)) {
      offenders.push(`${f.replace(SRC, 'src')} → ${m[2]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these resolve against capacitor://localhost on iOS and silently fetch the app bundle:\n  ' + offenders.join('\n  '));
});

// The rule above catches `fetch('/api/…')`, which is how all 39 of them were
// written. It does not catch the four other ways to reach the network with a
// path, and the next person to add one will not have read the August incident
// report. So the rule is stated the other way round: an `/api/…` path in this
// app may only ever appear as an argument to apiUrl(). One rule, no exceptions
// list, and it fails on a form nobody has thought of yet.
test('every /api path in the app goes through apiUrl(), whatever calls it', () => {
  const offenders = [];
  for (const f of walk(SRC)) {
    if (f.endsWith('apibase.ts')) continue; // documents the bug in prose
    const s = readFileSync(f, 'utf8')
      // Comments talk ABOUT these paths constantly. Prose must never fail a
      // build, and must never satisfy an assertion either.
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of s.matchAll(/(.{0,8})(['"`])(\/api\/[^'"`]*)\2/g)) {
      if (m[1].endsWith('apiUrl(')) continue;
      offenders.push(`${f.replace(SRC, 'src')} → ${m[3]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these resolve against capacitor://localhost inside the app and silently fetch the app bundle — wrap each one in apiUrl():\n  ' + offenders.join('\n  '));
});

// The lint above is only worth having if it can fail. Both directions are
// pinned here because a guard nobody has watched fail is not a guard: the
// first version of the store-selector test in src/lib passed against the
// broken code it was written for.
test('the apiUrl lint fails on a bare path and passes on a wrapped one', () => {
  const bare = (src) => [...src
    .replace(/^\s*\/\/.*$/gm, '')
    .matchAll(/(.{0,8})(['"`])(\/api\/[^'"`]*)\2/g)]
    .filter((m) => !m[1].endsWith('apiUrl('))
    .map((m) => m[3]);

  assert.deepEqual(bare("void fetch('/api/social/me', { method: 'POST' });"), ['/api/social/me']);
  assert.deepEqual(bare("navigator.sendBeacon('/api/track', body);"), ['/api/track']);
  assert.deepEqual(bare("const u = `/api/pay/status?id=${id}`; void fetch(u);"), ['/api/pay/status?id=${id}']);
  assert.deepEqual(bare("new EventSource('/api/dm/stream')"), ['/api/dm/stream']);
  assert.deepEqual(bare("void fetch(apiUrl('/api/social/me'));"), []);
  assert.deepEqual(bare("void fetch(apiUrl(`/api/social/who?id=${encodeURIComponent(id)}`));"), []);
  assert.deepEqual(bare("// a comment about fetch('/api/social/me') is not code"), []);
});

test('the native origin is baked in, never read at runtime', () => {
  // This ships as a binary. A wrong origin is a dead app that only a store
  // update can fix, so nothing at runtime may influence it.
  const s = readFileSync(join(SRC, 'lib', 'apibase.ts'), 'utf8');
  assert.match(s, /https:\/\/app\.itsnum\.com/);
  assert.ok(!/localStorage|fetch\(|document\./.test(s.replace(/^\s*\*.*$/gm, '')),
    'apibase.ts reads runtime state to decide the API origin — a shipped binary must not be steerable');
});

test('the web build is untouched', () => {
  // Same-origin, same cookies, same relative URLs as before.
  const s = readFileSync(join(SRC, 'lib', 'apibase.ts'), 'utf8');
  // Renamed 15 Aug when apibase stopped keeping its own copy of the check.
  assert.match(s, /if \(!isNativeApp\(\)\) return p;/,
    'the browser build now rewrites its own URLs — that is a cross-origin change nobody asked for');
  assert.match(s, /if \(\/\^https\?:\\\/\\\/\/i\.test\(p\)\) return p;/,
    'an already-absolute URL is being rewritten');
});

test('a non-JSON response is an error, not an empty object', () => {
  // `.catch(() => ({}))` is what moved the failure two frames away from its
  // cause and renamed it after a minified variable.
  // Comments stripped first: the fix's own explanation quotes the pattern it
  // forbids, and prose about code must never satisfy an assertion about code.
  const raw = readFileSync(join(SRC, 'lib', 'social.ts'), 'utf8');
  const s = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(s),
    'the JSON swallow is back — the next network misconfiguration will surface as a property error');
  assert.match(raw, /Couldn't reach Num — the server answered with something unexpected\./);
});

test('signup refuses to continue without an account', () => {
  // `out.me` is dereferenced four times, and signup is the worst screen in the
  // product to be stuck on: you cannot get past it.
  const s = readFileSync(join(SRC, 'lib', 'social.ts'), 'utf8');
  assert.match(s, /if \(!out\?\.me\?\.id\) \{/);
  assert.match(s, /didn't send an account back/);
});

// ── the bridge is not the only witness ───────────────────────────────────
//
// The first TestFlight build rendered the "Tap Share, then Add to Home
// Screen" card INSIDE the iOS app. That card is web-only by definition, so
// `Capacitor.isNativePlatform()` was answering false — bridge missing or not
// yet injected. A false negative there does not cost one wrong card: it also
// stops apiUrl() rewriting (every API call hits the local bundle) and opens
// canOfferSubscription() (Star packs and the pricing ladder render on iOS,
// reopening the 3.1.1 problem). One undetected platform, three live bugs.

test('native is detected by origin as well as by the bridge', () => {
  const s = readFileSync(join(SRC, 'lib', 'native.ts'), 'utf8');
  assert.match(s, /protocol === 'capacitor:'/,
    'the capacitor:// origin check is gone — a silent bridge reads as web again');
  assert.match(s, /isNativeApp = \(\): boolean => Boolean\(cap\(\)\?\.isNativePlatform\?\.\(\)\) \|\| nativeOrigin\(\)/,
    'isNativeApp no longer ORs the two signals');
  assert.match(s, /hostname === 'localhost'/);
  assert.match(s, /!import\.meta\.env\?\.DEV/,
    'the dev-server exclusion is gone — `vite dev` on localhost would now claim to be a native app');
});

test('an unanswered bridge on a native origin does not open the iOS purchase gate', () => {
  // Wrongly saying iOS costs one hidden upgrade card. Wrongly saying web
  // costs an App Store rejection and a false statement in our review notes.
  const s = readFileSync(join(SRC, 'lib', 'native.ts'), 'utf8');
  assert.match(s, /if \(!nativeOrigin\(\)\) return 'web';/);
  assert.match(s, /\/iPhone\|iPad\|iPod\/i\.test\(ua\)/, 'the UA fallback is gone');
  assert.match(s, /return 'ios';\s*\n\};/,
    'an unknown device on a native origin no longer defaults to the strictest storefront');
});

test('there is exactly one definition of "are we native"', () => {
  // Two independent notions of the same fact means one is wrong and nobody
  // notices. apibase.ts had its own copy and it disagreed in production.
  const a = readFileSync(join(SRC, 'lib', 'apibase.ts'), 'utf8');
  assert.match(a, /import \{ isNativeApp \} from '\.\/native';/);
  assert.ok(!/isNativePlatform/.test(a.replace(/^\s*(\/\/|\*).*$/gm, '')),
    'apibase.ts re-implemented the Capacitor check — keep one definition in native.ts');
});
