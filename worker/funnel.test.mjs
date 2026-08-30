// The funnel, actually measurable.
//
// 10 Aug 2026, reading a month of campaign data against the live database:
// 189,425 impressions and 2,702 paid clicks produced a funnel nobody could
// read. Three separate silences, each of which looked like working code:
//
//   1. `num-track.js` defines fifteen funnel events and was loaded on exactly
//      one page — /install. The landing page and the app, where every visitor
//      actually goes, loaded nothing. Only three event types have ever been
//      recorded, and two of them are about business claims.
//   2. The landing page is served from itsnum.com, which returned 404 for
//      /num-track.js — the file only existed under app-public.
//   3. `state.me.id` was read by the server on every ask and never sent by the
//      client, so all 142 asks carry member_id NULL. "Did anyone who signed up
//      ever ask Num anything?" was unanswerable.
//
// None of these threw an error. That is the point of testing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(HERE, '..', ...p);

test('the tracker is loaded on the pages visitors actually land on', () => {
  const landing = readFileSync(root('public', 'index.html'), 'utf8');
  assert.match(landing, /num-track\.js/,
    'the landing page loads no funnel tracking — every ad click after this is unmeasurable again');
  // The app shell loads the tracker from src/lib/analyticsLoader.ts through
  // apiUrl(), not from a tag. A bare /num-track.js in index.html resolves
  // against capacitor://localhost in the bundled iOS app, so it loaded a
  // stale copy from whenever the binary was cut — or nothing. Assert the
  // outcome, not the tag.
  const loader = readFileSync(root('src', 'lib', 'analyticsLoader.ts'), 'utf8');
  assert.match(loader, /apiUrl\(\s*['"]\/num-track\.js['"]\s*\)/,
    'the app shell loads no funnel tracking — activation cannot be observed');
  const main = readFileSync(root('src', 'main.tsx'), 'utf8');
  assert.match(main, /loadAnalytics\(\)/,
    'nothing calls loadAnalytics — the app shell tracks nothing');
});

test('the landing origin can actually serve the file it references', () => {
  // itsnum.com serves from public/. Referencing /num-track.js from there while
  // the file lives only in app-public/ is a 404 — a script tag that looks
  // correct in the HTML and loads nothing in the browser.
  assert.ok(existsSync(root('public', 'num-track.js')),
    'public/num-track.js is missing — itsnum.com will 404 on the script it references');
  assert.ok(existsSync(root('app-public', 'num-track.js')),
    'app-public/num-track.js is missing — app.itsnum.com will 404');
});

test('every surface reports under its own page name', () => {
  // With one hard-coded PAGE, the landing page and the app both file rows as
  // "landing" and the funnel reads as one step happening twice.
  const src = readFileSync(root('app-public', 'num-track.js'), 'utf8');
  assert.doesNotMatch(src, /var PAGE = 'landing';/,
    'PAGE is hard-coded again — every surface will claim to be the landing page');
  assert.match(src, /location\.hostname/,
    'PAGE is no longer derived from where the script is running');
  for (const page of ['app', 'install', 'landing']) {
    assert.ok(src.includes(`'${page}'`), `the "${page}" surface is no longer distinguished`);
  }
});

test('an ask carries who asked it', () => {
  const client = readFileSync(root('src', 'lib', 'concierge.ts'), 'utf8');
  assert.match(client, /\.\.\.\(s\.me\?\.id \? \{ me: \{ id: s\.me\.id \} \} : \{\}\)/,
    'the client stopped sending me.id — asks go back to member_id NULL and activation becomes unmeasurable');
  const server = readFileSync(root('worker', 'index.mjs'), 'utf8');
  assert.match(server, /memberId: parsed\.state\?\.me\?\.id \?\? null/,
    'the server no longer reads me.id when recording an ask');
});

test('only the id travels — an ask log is not a contact list', () => {
  // num_asks is scrubbed of identifiers by design. Sending the whole member
  // object would put a name and phone number one join away from every question
  // somebody asked, which is exactly what the scrub exists to prevent.
  const client = readFileSync(root('src', 'lib', 'concierge.ts'), 'utf8');
  const sent = /me: \{ id: s\.me\.id \}/.test(client);
  assert.ok(sent, 'the me payload shape changed — check it still sends ONLY the id');
  assert.doesNotMatch(client, /me: s\.me\b/,
    'the whole member object is being sent — name and phone would ride along into the ask path');
});
