// The app updates itself, or a fix never reaches a phone.
//
// 11 Aug 2026: replies were fixed on the server and Dre's installed app still
// answered "we've dropped the line". The phone was running JavaScript from
// days earlier. The only update check in the product lived inside ProfileView
// — a screen most guests never open — so in practice the "new version" banner
// was unreachable, and the honest instruction to a user was "reinstall Num".
//
// These tests hold the three triggers and the two loop guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, '..', p), 'utf8');

test('auto-update runs app-wide, not only on the profile screen', () => {
  const main = src('src/main.tsx');
  assert.match(main, /startAutoUpdate/,
    'nothing starts auto-update at boot — a deploy reaches only guests who open Profile');
  const au = src('src/lib/autoupdate.ts');
  assert.match(au, /visibilitychange/, 'no foreground trigger — an installed app is backgrounded, not killed');
  assert.match(au, /setInterval/, 'no poll — a tab left open all week never updates');
  assert.match(au, /setTimeout\(\(\) => void check\(\), 2500\)/, 'no boot check');
});

test('a reload cannot loop', () => {
  // reload → still stale → reload is worse than being a version behind.
  const au = src('src/lib/autoupdate.ts');
  assert.match(au, /version !== VERSION/,
    'staleness is no longer compared against the bundled version — a reload that changes nothing can re-arm');
  assert.match(au, /sessionStorage\.getItem\(RELOADED\) === stale/,
    'the once-per-version guard is gone — a stuck deploy would spin the app');
});

test('an update never interrupts a guest mid-question', () => {
  const au = src('src/lib/autoupdate.ts');
  assert.match(au, /if \(busy\?\.\(\)\) return;/, 'the busy veto is gone — a reload can eat a half-typed ask');
  const main = src('src/main.tsx');
  assert.match(main, /numBusy/, 'main no longer reads the busy flag');
  const c = src('src/lib/concierge.ts');
  assert.match(c, /dataset\.numBusy = '1'/, 'the concierge no longer raises the busy flag while a reply is in flight');
  assert.match(c, /delete document\.body\.dataset\.numBusy/,
    'the busy flag is never cleared — it would block auto-update forever, which is the original bug');
});

test('the version check bypasses every cache', () => {
  // Asking the browser cache what the server is running defeats the point.
  const au = src('src/lib/autoupdate.ts');
  // Wrapped in apiUrl() on 15 Aug so the native shell reaches production
  // rather than its own bundle; the cache option is the part under test.
  assert.match(au, /apiUrl\('\/api\/version'\), \{ cache: 'no-store' \}/,
    'the version probe can be served from cache');
});
