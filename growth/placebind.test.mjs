// Binding a claim to a place.
//
// Until 25 Aug 2026 `claims.place_id` was NULL on every row in production. A
// claim was a business name in a text box: no coordinates, so nothing to draw
// on a map; no listing, so nothing to check a verification code against; and
// no place, so no way to credit whoever brought the venue in. Everything the
// scout programme needs sits on top of this one column being populated.
//
// Two paths fill it, and both are tested here:
//   ?p= on the link      — exact, from the outreach CSV and printed QR codes
//   /api/claims/lookup   — a type-ahead, for someone arriving cold
//
// Same approach as pixel.test.mjs: worker.js is a Cloudflare module worker, so
// the pieces are extracted from source rather than imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = (p) => fileURLToPath(new URL(p, import.meta.url));
const SRC = readFileSync(HERE('./worker.js'), 'utf8');
const PAGE = readFileSync(HERE('../public/claim/index.html'), 'utf8');

const lookupFn = () => {
  const i = SRC.indexOf('async function claimsLookup(');
  assert.ok(i > 0, 'claimsLookup not found in worker.js');
  const j = SRC.indexOf('\n}', i);
  assert.ok(j > i, 'claimsLookup body not terminated');
  // +2 to keep the closing brace: this text is eval'd below, not only matched.
  return SRC.slice(i, j + 2);
};

/* ── the endpoint is reachable at all ───────────────────────────────────── */

test('the lookup route is matched before the bare /api/claims route', () => {
  // "/api/claims" is an exact-equality check, so ordering does not strictly
  // decide correctness today — but a later change to startsWith() would
  // silently route every lookup into the POST handler, and that handler
  // rejects a GET body with a 400. Asserting the order keeps the cheap
  // property that makes the refactor safe.
  const lookup = SRC.indexOf('p === "/api/claims/lookup"');
  const claims = SRC.indexOf('p === "/api/claims"');
  assert.ok(lookup > 0, 'lookup route not registered');
  assert.ok(lookup < claims, 'lookup route must be tested before /api/claims');
});

test('the lookup answers GET only', () => {
  const line = SRC.slice(SRC.indexOf('p === "/api/claims/lookup"'));
  assert.match(line.slice(0, 120), /req\.method === "GET"/);
});

/* ── the scraper guard ──────────────────────────────────────────────────── */

test('the lookup never returns a contact column', () => {
  // `places` holds ~2.5M rows, 30,570 of them Los Angeles businesses with an
  // email address. A public endpoint that turns a typed name into one of those
  // is a scraper with a search box. What it may return is what is already
  // painted on the shopfront.
  const fn = lookupFn();
  const select = fn.slice(fn.indexOf('SELECT'), fn.indexOf('LIMIT 8'));
  for (const col of ['email', 'phone', 'website', 'booking_ref', 'business_id']) {
    assert.doesNotMatch(select, new RegExp(`\\b${col}\\b`),
      `lookup must not select ${col}`);
  }
  // And the shape that is returned mentions none of them either.
  const shaped = fn.slice(fn.indexOf('places: rows.map'));
  for (const col of ['email', 'phone', 'website']) {
    assert.doesNotMatch(shaped, new RegExp(`\\b${col}\\b`));
  }
});

test('the match is prefix-only, so it can use idx_places_dest_name', () => {
  const fn = lookupFn();
  // A leading wildcard cannot use the index and reads the whole destination —
  // 90,263 rows for Los Angeles — on every keystroke.
  assert.match(fn, /const like = q \+ "%";/,
    'the LIKE pattern must be built as prefix + "%"');
  assert.doesNotMatch(fn, /"%" \+ q/, 'no leading wildcard');
  assert.match(fn, /WHERE dest = \? AND name LIKE \?/);
});

test('it refuses to run without a destination or under three characters', () => {
  assert.match(lookupFn(), /if \(!dest \|\| q\.length < 3\) return/);
});

test('it is rate limited and origin checked like every other write path', () => {
  const fn = lookupFn();
  assert.match(fn, /badOrigin\(req\)/);
  assert.match(fn, /overLimit\("lookup:"/);
});

/* ── it actually behaves, not just reads well ───────────────────────────── */

// Run the real extracted function against stubs, so the guards above are
// tested as behaviour and not only as source text.
function runLookup({ q, d, rows = [], throws = false, origin = null, hits = 1 }) {
  const calls = [];
  const src = `
    ${lookupFn()}
    return claimsLookup;
  `;
  const clean = (s, max) => String(s == null ? '' : s)
    // Mirrors production clean(), \p{M} included — a stub that is stricter
    // than the real thing tests a filter nobody ships.
    .replace(/[^\p{L}\p{M}\p{N} '&.,()/+@_-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const J = (o, status = 200) => ({ status, body: o });
  const badOrigin = () => origin === 'bad';
  let n = 0;
  const overLimit = () => ++n > hits;

  // eslint-disable-next-line no-new-func
  const make = new Function('clean', 'J', 'badOrigin', 'overLimit', src);
  const fn = make(clean, J, badOrigin, overLimit);

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return {
              all() {
                if (throws) throw new Error('D1 down');
                return { results: rows };
              },
            };
          },
        };
      },
    },
  };
  const url = new URL(`https://itsnum.com/api/claims/lookup?q=${encodeURIComponent(q ?? '')}&d=${encodeURIComponent(d ?? '')}`);
  const req = { headers: { get: () => null } };
  return fn(req, env, url).then((res) => ({ res, calls }));
}

test('a two-character query never reaches the database', async () => {
  const { res, calls } = await runLookup({ q: 'ka', d: 'hkt' });
  assert.deepEqual(res.body, { ok: true, places: [] });
  assert.equal(calls.length, 0, 'no query may be issued below three characters');
});

test('a query with no destination never reaches the database', async () => {
  const { res, calls } = await runLookup({ q: 'kata beach', d: '' });
  assert.deepEqual(res.body, { ok: true, places: [] });
  assert.equal(calls.length, 0);
});

test('a real query binds the destination and a prefix pattern', async () => {
  const { calls } = await runLookup({
    q: 'sushi', d: 'los-angeles',
    rows: [{ id: 'abc', name: 'Sushi 101', address: '930 S Robertson Blvd', area: null, category: 'restaurant', status: 'unclaimed' }],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['los-angeles', 'sushi%']);
});

test('the destination is sanitised down to what a dest can contain', async () => {
  const { calls } = await runLookup({ q: 'sushi', d: "los-angeles' OR 1=1--" });
  // Everything outside [a-z0-9-] is stripped before it is bound. It is a bound
  // parameter regardless, so this is a second lock on an already locked door.
  assert.equal(calls[0].args[0], 'los-angelesor11--');
  assert.doesNotMatch(calls[0].args[0], /['" =]/);
});

test('a Thai query keeps its tone marks', async () => {
  // The bug this replaces: the shared clean() whitelist was [\p{L}\p{N}...],
  // and Thai writes its vowels and tones as combining marks, not letters. So
  // ร้าน (ร + ้ + า + น) arrived at the database as "ร าน" and matched none of
  // the 1,449 Phuket listings whose name starts with it. Five thousand seven
  // hundred Thai venues could not find themselves by typing their own name.
  const { calls } = await runLookup({ q: 'ร้าน', d: 'phuket' });
  assert.equal(calls.length, 1, 'a four-character Thai word must reach the DB');
  assert.equal(calls[0].args[1], 'ร้าน%');
});

test('the shared whitelist keeps combining marks in every script', () => {
  const m = SRC.match(/const SAFE = (\/\[\^[^\n]*\/gu);/);
  assert.ok(m, 'SAFE not found in worker.js');
  // eslint-disable-next-line no-eval
  const safe = eval(m[1]);
  for (const [script, s] of [
    ['Thai', 'ร้าน พ.บาติก'],
    ['Vietnamese', 'Phở Hà Nội'],
    ['Arabic', 'مَطعَم'],
    ['Devanagari', 'चाय की दुकान'],
  ]) {
    assert.equal(s.replace(safe, ' '), s, `${script} must survive SAFE intact`);
  }
  // And the property it exists for still holds: CR, LF and the colon a header
  // needs are all gone, so nothing here can become a second header line.
  const injected = 'a\r\nBcc: x@y.z'.replace(safe, ' ');
  assert.doesNotMatch(injected, /[\r\n:]/);
});

test('the claim page keeps combining marks too', () => {
  const m = PAGE.match(/var NAME_OK = (\/\[\^[^\n]*\/gu);/);
  assert.ok(m, 'NAME_OK not found on the claim page');
  // eslint-disable-next-line no-eval
  const ok = eval(m[1]);
  // This is the ?b= prefill. 5,709 Phuket venues are emailed a link carrying
  // their own name in it; stripping the marks greets them misspelled.
  assert.equal('ร้าน พ.บาติก สวนหลวง'.replace(ok, ' '), 'ร้าน พ.บาติก สวนหลวง');
  assert.equal('<script>'.replace(ok, ' '), ' script ');
});

test('a claimed listing is marked, not hidden', async () => {
  // Hiding it would tell a second manager at the same venue that we hold no
  // listing for their business, which is false and reads as incompetence.
  const { res } = await runLookup({
    q: 'holiday', d: 'edinburgh',
    rows: [{ id: 'x1', name: 'Holiday Inn Express', address: 'Picardy Pl', area: 'New Town', category: 'hotel', status: 'claimed' }],
  });
  assert.equal(res.body.places[0].taken, 1);
  assert.equal(res.body.places[0].name, 'Holiday Inn Express');
  assert.equal(res.body.places[0].where, 'Picardy Pl');
});

test('a place with no address falls back to its area', async () => {
  const { res } = await runLookup({
    q: 'kata', d: 'hkt',
    rows: [{ id: 'k1', name: 'Kata Rocks', address: null, area: 'Kata', category: 'hotel', status: null }],
  });
  assert.equal(res.body.places[0].where, 'Kata');
  assert.equal(res.body.places[0].taken, 0);
});

test('a database failure returns an empty list, never an error the form shows', async () => {
  // The claim must land even when the lookup is broken. A 500 here would put a
  // red box in front of a business that was two fields from signing up.
  const { res } = await runLookup({ q: 'sushi', d: 'los-angeles', throws: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, places: [] });
});

test('a bad origin is refused before any query', async () => {
  const { res, calls } = await runLookup({ q: 'sushi', d: 'los-angeles', origin: 'bad' });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('the rate limit is refused before any query', async () => {
  const { res, calls } = await runLookup({ q: 'sushi', d: 'los-angeles', hits: 0 });
  assert.equal(res.status, 429);
  assert.equal(calls.length, 0);
});

/* ── the analytics event exists ─────────────────────────────────────────── */

test('claim_place_picked is on the events allowlist', () => {
  // /api/ev silently drops anything not in EVENTS, so an event that is fired
  // but not listed produces a metric that is always zero and always believed.
  const set = SRC.slice(SRC.indexOf('const EVENTS = new Set(['));
  assert.match(set.slice(0, 900), /"claim_place_picked"/);
  assert.match(PAGE, /logEvent\("claim_place_picked"/);
});

/* ── the page ───────────────────────────────────────────────────────────── */

test('the claim page reads ?p= and sends it as place_id', () => {
  assert.match(PAGE, /var placeId\s*=\s*qp\("p"\)/);
  assert.match(PAGE, /place_id:\s*placeId/);
});

test('the picker never blocks a submit', () => {
  // The single most expensive thing this feature could do is refuse a real
  // business because we hold no listing for it. Validation is business name,
  // contact name, phone, email — and nothing about placeId.
  const submit = PAGE.slice(PAGE.indexOf('form.addEventListener("submit"'));
  // From the end of the payload object to the point of no return. The payload
  // itself of course carries place_id — that is the whole feature. What must
  // not exist is a guard that turns it into a requirement.
  const guards = submit.slice(
    submit.indexOf('if (!payload.business_name)'),
    submit.indexOf('sending = true'),
  );
  assert.doesNotMatch(guards, /placeId/,
    'placeId must never appear in submit validation');
  assert.match(guards, /if \(!payload\.business_name\) return showError/);
});

test('typing after a pick unbinds the place', () => {
  // Otherwise the claim goes in bound to a listing the person edited away from,
  // which is worse than being unbound: it is confidently wrong.
  const picker = PAGE.slice(PAGE.indexOf('---- listing picker'));
  assert.match(picker, /input\.addEventListener\("input", function \(\) \{\s*\/\/[^\n]*\n\s*if \(placeId\) unbind\(\);/);
});

test('lookup results are written with textContent, never innerHTML', () => {
  // These names and addresses were crawled off the open web. They are not ours
  // and they are not markup.
  const render = PAGE.slice(PAGE.indexOf('function render()'));
  const body = render.slice(0, render.indexOf('function move('));
  const writes = body.match(/[\w.]*innerHTML\s*=[^\n]*/g) || [];
  assert.deepEqual(writes, ['list.innerHTML = "";'],
    'the only innerHTML in render() may be the one that empties the list');
  assert.match(body, /nm\.textContent =/);
  assert.match(body, /wh\.textContent =/);
});

test('a stale reply cannot paint over a newer query', () => {
  const picker = PAGE.slice(PAGE.indexOf('---- listing picker'));
  assert.match(picker, /if \(input\.value\.trim\(\) !== q\) return;/);
});

test('the page and the endpoint agree on the minimum query length', () => {
  const picker = PAGE.slice(PAGE.indexOf('---- listing picker'));
  assert.match(picker, /if \(!dest \|\| q\.length < 3\) return hideList\(\);/);
  assert.match(lookupFn(), /q\.length < 3/);
});

test('the legal line on the page matches the one in the worker', () => {
  // A business checking whether the email that brought them here is real reads
  // the two side by side. A different address or reply-to is the phishing tell.
  const m = SRC.match(/const LEGAL_LINE =\s*\n?\s*"([^"]+)"/);
  assert.ok(m, 'LEGAL_LINE not found in worker.js');
  const p = PAGE.match(/var LEGAL_LINE =\s*\n?\s*"([^"]+)"/);
  assert.ok(p, 'LEGAL_LINE not found on the claim page');
  assert.equal(p[1], m[1]);
});
