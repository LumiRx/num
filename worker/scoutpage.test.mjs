/**
 * The page an NFC card opens.
 *
 * Two of these tests exist because of a real outage rather than a theory:
 * itsnum.com/s/FARMER returned 404 on the day the first card was printed, and
 * the handler it should have reached would have sent a traveller and a tour
 * guide to a business claim form. Both failures are now assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  esc, firstName, doorsFor, renderScoutPage, personRefFor, handleScoutLanding,
} from './scoutpage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SCOUT = Object.freeze({
  id: 'sc_isaiah_farmer_0001', name: 'Isaiah Farmer', code: 'FARMER',
  status: 'active', member_id: 'mem_ea0653523c7d4f3092e8',
});

/* ── escaping ─────────────────────────────────────────────────────────── */

test('a name is escaped, because a scout name is user input', () => {
  const html = renderScoutPage({ scout: { ...SCOUT, name: '<script>alert(1)</script>' } });
  assert.ok(!html.includes('<script>alert(1)'), 'raw tag reached the page');
  assert.ok(html.includes('&lt;script&gt;'), 'not escaped at all');
});

test('esc covers every character that can break out of an attribute', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('a code is url-encoded into the door, not pasted', () => {
  const d = doorsFor({ code: 'A B&C' });
  assert.ok(!d.business.includes(' '), 'a raw space reached the href');
  assert.ok(!d.business.includes('&C'), 'a raw ampersand reached the href');
});

/* ── the three doors ──────────────────────────────────────────────────── */

test('every card offers all three doors, not just the business one', () => {
  const html = renderScoutPage({ scout: SCOUT, personRef: 'BRNRBR' });
  assert.ok(html.includes('/claim/?scout=FARMER'), 'no business door');
  assert.ok(html.includes('/hosts/?scout=FARMER'), 'no host door');
  assert.ok(html.includes('/app/?ref=BRNRBR'), 'no person door');
});

test('THE BUG THIS PAGE REPLACES: /s/CODE does not just send everyone to /claim', () => {
  const html = renderScoutPage({ scout: SCOUT, personRef: 'BRNRBR' });
  const doors = html.match(/class="s-door" href="([^"]+)"/g) ?? [];
  assert.equal(doors.length, 3, `expected three doors, got ${doors.length}`);
});

test('the person door carries the MEMBER code, never the scout code', () => {
  // These are different namespaces in different tables. Passing FARMER as ?ref=
  // asks linkReferral for a member code that does not exist, and could one day
  // match a DIFFERENT person's code and pay the wrong human.
  const d = doorsFor({ code: 'FARMER', personRef: 'BRNRBR' });
  assert.equal(d.person, '/app/?ref=BRNRBR');
  assert.ok(!d.person.includes('FARMER'), 'the scout code leaked into ?ref=');
});

test('no member account means a plain app link, not a guessed one', () => {
  const d = doorsFor({ code: 'FARMER', personRef: null });
  assert.equal(d.person, '/app/');
});

test('the business and host doors carry the SCOUT code, not the member code', () => {
  const d = doorsFor({ code: 'FARMER', personRef: 'BRNRBR' });
  assert.ok(d.business.includes('scout=FARMER') && !d.business.includes('BRNRBR'));
  assert.ok(d.host.includes('scout=FARMER') && !d.host.includes('BRNRBR'));
});

/* ── an unknown code is never a dead end ──────────────────────────────── */

test('an unknown code still shows all three doors', () => {
  const html = renderScoutPage({ scout: null });
  assert.ok(html.includes('href="/claim/"'));
  assert.ok(html.includes('href="/hosts/"'));
  assert.ok(html.includes('href="/app/"'));
});

test('an unknown code claims nobody', () => {
  const html = renderScoutPage({ scout: null });
  assert.ok(!/scout=/.test(html), 'attributed someone on an unknown code');
  assert.ok(/did not match anyone/.test(html), 'did not say so honestly');
});

test('handleScoutLanding answers 200 for a code nobody holds', async () => {
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
  const res = await handleScoutLanding(new Request('https://itsnum.com/s/NOPE'), env, 'NOPE');
  assert.equal(res.status, 200, 'a mistyped card must never 404 a person who came to sign up');
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.equal(res.headers.get('set-cookie'), null, 'set a cookie for a scout that does not exist');
});

test('a database outage still serves the page', async () => {
  const env = { DB: { prepare: () => { throw new Error('D1 down'); } } };
  const res = await handleScoutLanding(new Request('https://itsnum.com/s/FARMER'), env, 'FARMER');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('/claim/'), 'no doors on the fallback page');
});

/* ── attribution plumbing ─────────────────────────────────────────────── */

test('a known scout gets the first-touch cookie', async () => {
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => (/num_scouts/.test(sql) ? SCOUT : { code: 'BRNRBR' }),
        }),
      }),
    },
  };
  const res = await handleScoutLanding(new Request('https://itsnum.com/s/FARMER'), env, 'FARMER');
  const c = res.headers.get('set-cookie') || '';
  assert.match(c, /num_scout=FARMER/);
  assert.match(c, /HttpOnly/, 'readable by any script on the origin');
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=7776000/, 'first touch is meant to last 90 days');
});

test('personRefFor returns null rather than inventing a code', async () => {
  assert.equal(await personRefFor({}, SCOUT), null);
  assert.equal(await personRefFor({ DB: {} }, { ...SCOUT, member_id: null }), null);
  const boom = { DB: { prepare: () => { throw new Error('nope'); } } };
  assert.equal(await personRefFor(boom, SCOUT), null);
});

test('personRefFor only ever reads an ACTIVE member-owned code', async () => {
  let seen = '';
  const env = { DB: { prepare: (sql) => { seen = sql; return { bind: () => ({ first: async () => ({ code: 'BRNRBR' }) }) }; } } };
  assert.equal(await personRefFor(env, SCOUT), 'BRNRBR');
  assert.match(seen, /active\s*=\s*1/);
  assert.match(seen, /owner_type\s*=\s*'member'/);
});

/* ── the page itself ──────────────────────────────────────────────────── */

test('firstName is a first name and cannot run away', () => {
  assert.equal(firstName('Isaiah Farmer'), 'Isaiah');
  assert.equal(firstName('   '), '');
  assert.equal(firstName(null), '');
  assert.ok(firstName('A'.repeat(200)).length <= 24);
});

test('a personal invite link is not indexed', () => {
  assert.match(renderScoutPage({ scout: SCOUT }), /name="robots" content="noindex/);
});

test('every page can be translated — this one included', () => {
  assert.ok(renderScoutPage({ scout: SCOUT }).includes('/assets/translate.js'));
});

test('stylesheet and script are ABSOLUTE, because this page also serves on app.itsnum.com', () => {
  // Root-relative here would 404 silently on the app host, where public/ does
  // not exist, and leave an unstyled page with no explanation.
  const html = renderScoutPage({ scout: SCOUT });
  assert.ok(html.includes('https://itsnum.com/assets/site.css'));
  assert.ok(html.includes('https://itsnum.com/assets/translate.js'));
  assert.ok(!/(href|src)="\/assets\//.test(html), 'a root-relative asset survived');
});

test('the doors are plain links — no JavaScript decides where anybody goes', () => {
  const html = renderScoutPage({ scout: SCOUT, personRef: 'BRNRBR' });
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'inline script on a page that must work everywhere');
});

test('the page is readable on a phone', () => {
  const html = renderScoutPage({ scout: SCOUT });
  assert.ok(html.includes('width=device-width'));
  assert.match(html, /@media\(max-width:480px\)/);
});

/* ── the routing that 404'd ───────────────────────────────────────────── */

test('THE 404: itsnum.com/s/* has BOTH a handler and a route', () => {
  const worker = readFileSync(join(ROOT, 'growth', 'worker.js'), 'utf8');
  const cfg = readFileSync(join(ROOT, 'growth', 'wrangler.jsonc'), 'utf8');
  assert.match(worker, /p\.startsWith\("\/s\/"\)/, 'num-growth has no /s/ handler');
  assert.match(worker, /handleScoutLanding/, 'the handler does not render the landing page');
  assert.match(cfg, /"pattern":\s*"itsnum\.com\/s\/\*"/,
    'a handler with no route is unreachable — this is the exact bug that 404d');
});

test('the app host serves the same page from the same function', () => {
  const idx = readFileSync(join(ROOT, 'worker', 'index.mjs'), 'utf8');
  const scouts = readFileSync(join(ROOT, 'worker', 'scouts.mjs'), 'utf8');
  assert.match(idx, /pathname\.startsWith\('\/s\/'\)/);
  assert.match(scouts, /handleScoutLanding/, 'app host still redirects instead of rendering');
  assert.ok(!/Response\.redirect\([\s\S]{0,80}\/claim/.test(scouts),
    'the old "everyone is a business" redirect is back');
});

/* ── the forms carry it through ───────────────────────────────────────── */

test('the claim form reads ?scout= and posts it', () => {
  const html = readFileSync(join(ROOT, 'public', 'claim', 'index.html'), 'utf8');
  assert.match(html, /qp\("scout"\)/, 'the claim form never reads the code off the URL');
  assert.match(html, /scout:\s*scoutCode/, 'the code is read and then dropped on the floor');
});

test('the host form reads ?scout= and posts it', () => {
  const html = readFileSync(join(ROOT, 'public', 'hosts', 'index.html'), 'utf8');
  assert.match(html, /get\('scout'\)/, 'the host form never reads the code off the URL');
  assert.match(html, /scout:\s*scoutCode/, 'the code is read and then dropped on the floor');
});

test('both forms SAY that a code is attached, rather than attaching it silently', () => {
  for (const f of [['public', 'claim'], ['public', 'hosts']]) {
    const html = readFileSync(join(ROOT, ...f, 'index.html'), 'utf8');
    assert.match(html, /nothing for you to type|nothing for you to type\./i,
      `${f[1]} attaches attribution without telling the person`);
  }
});
