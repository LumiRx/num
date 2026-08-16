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
  assert.match(s, /if \(!isNative\(\)\) return p;/,
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
