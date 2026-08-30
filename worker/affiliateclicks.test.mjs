// The click log: what Num sent away, and to whom.
//
// These tests DRIVE the module — they import it and feed it real inputs. They
// deliberately do not grep the source: a regex over a file proves the letters
// are there, not that a row lands in D1 with the right host on it, and the
// whole point of this table is that the number in it can be trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tag, tagged, affiliates, programmes } from './affiliate.mjs';
import { recordHandoffs, logHandoffs, _resetForTests } from './affiliateclicks.mjs';

/** Worker env whose `DB` is a D1 stand-in remembering every bound row. */
function db({ failOn = null } = {}) {
  const inserted = [];
  const ddl = [];
  const api = {
    prepare(q) {
      const isInsert = /^\s*INSERT/i.test(q);
      if (!isInsert) ddl.push(q.replace(/\s+/g, ' ').trim());
      return {
        // `bind` must return the STATEMENT, so a batch of bound statements is
        // a list of things D1 can run — not a list of databases.
        bind(...args) { return { __q: q, __args: args, __insert: isInsert }; },
      };
    },
    async batch(stmts) {
      if (failOn === 'batch') throw new Error('D1_ERROR: no such table');
      for (const s of stmts) if (s.__insert) inserted.push(s.__args);
      return stmts.map(() => ({ success: true }));
    },
  };
  return { DB: api, inserted, ddl };
}

const COLS = ['host', 'programme', 'tagged', 'event', 'surface', 'kind', 'member_id', 'dest', 'ts'];
const row = (args) => Object.fromEntries(COLS.map((c, i) => [c, args[i]]));

test.beforeEach(() => _resetForTests());

/* ── affiliate.tagged(): the three facts the log needs ──────────────────── */

test('tagged() reports host, programme and whether a ref actually landed', () => {
  const env = { NUM_AFFILIATES: JSON.stringify({ 'booking.com': { ref: 'aid123', param: 'aid' } }) };
  const t = tagged('https://www.booking.com/searchresults.html?ss=Phuket', env);
  assert.equal(t.host, 'booking.com', 'www. must be stripped or one host logs as two');
  assert.equal(t.programme, 'booking.com');
  assert.equal(t.tagged, true);
  assert.match(t.url, /[?&]aid=aid123/);
});

test('an untagged host is still logged, with its host and no programme', () => {
  // This is the case that matters most today: NUM_AFFILIATES is unset, so
  // every link is untagged — and the log of WHERE we sent that traffic is
  // exactly the evidence for which programme to apply for next.
  const t = tagged('https://hungryhub.com/en/', {});
  assert.equal(t.tagged, false);
  assert.equal(t.host, 'hungryhub.com');
  assert.equal(t.programme, null);
  assert.equal(t.reason, 'no_table');
  assert.equal(t.url, 'https://hungryhub.com/en/', 'an unconfigured link must come back untouched');
});

test('the catch-all reports itself as the "*" programme, not as the host', () => {
  const env = { NUM_AFFILIATES: JSON.stringify({ '*': { ref: 'num', param: 'utm_source' } }) };
  const t = tagged('https://food.grab.com/th/en/', env);
  assert.equal(t.programme, '*', 'a "*" row counted as a real programme would fake revenue we do not earn');
  assert.equal(t.host, 'food.grab.com');
  assert.equal(t.tagged, true);
  assert.match(t.url, /utm_source=num/);
});

test('a specific rule beats the catch-all and is named as itself', () => {
  const env = { NUM_AFFILIATES: JSON.stringify({
    'booking.com': { ref: 'aid123', param: 'aid' },
    '*': { ref: 'num', param: 'utm_source' },
  }) };
  const t = tagged('https://www.booking.com/x', env);
  assert.equal(t.programme, 'booking.com');
  assert.match(t.url, /aid=aid123/);
  assert.ok(!/utm_source/.test(t.url), 'both rules fired — the ref param must be the only one applied');
});

test('refusals carry a reason, so a zero can be explained', () => {
  const env = { NUM_AFFILIATES: JSON.stringify({ '*': { ref: 'num', param: 'utm_source' } }) };
  assert.equal(tagged('http://resy.com/x', env).reason, 'not_https');
  assert.equal(tagged('not a url', env).reason, 'malformed');
  assert.equal(tagged('', env).reason, 'empty');
  assert.equal(tagged('https://resy.com/x?utm_source=theirs', env).reason, 'already_attributed');
});

test('tag() is unchanged — it is still exactly tagged().url', () => {
  const env = { NUM_AFFILIATES: JSON.stringify({ 'resy.com': { ref: 'num01', param: 'ref' } }) };
  for (const u of ['https://resy.com/x', 'https://example.com/x', 'http://resy.com/x', 'not a url', '']) {
    assert.equal(tag(u, env), tagged(u, env).url, `tag() and tagged() disagree on ${JSON.stringify(u)}`);
  }
});

/* ── the paste-ready secret ─────────────────────────────────────────────── */

test('the shipped NUM_AFFILIATES catch-all parses and tags every host', () => {
  // The exact value in HQ/divisions/num/AFFILIATE_ACTIVATION.md. If this test
  // fails, the document is telling Andre to paste something that does nothing.
  const SECRET = '{"*":{"ref":"num","param":"utm_source"}}';
  const env = { NUM_AFFILIATES: SECRET };
  assert.deepEqual(affiliates(env), { '*': { ref: 'num', param: 'utm_source' } });
  assert.deepEqual(programmes(env), [{ host: '*', param: 'utm_source' }],
    'programmes() must accept the catch-all, or the ops page shows nothing after activation');
  for (const u of [
    'https://hungryhub.com/en/',
    'https://food.grab.com/th/en/',
    'https://www.booking.com/searchresults.html?ss=Phuket',
    'https://www.thefork.com/search?cityName=Phuket',
    'https://www.fresha.com/search?q=massage',
  ]) {
    assert.match(tag(u, env), /utm_source=num/, `${u} was not tagged by the catch-all`);
  }
});

/* ── recordHandoffs(): the row that lands ───────────────────────────────── */

test('a handoff writes one row per host with the fields the report needs', async () => {
  const d = db();
  const out = await recordHandoffs(d, [
    { host: 'hungryhub.com', programme: null, tagged: false, kind: 'table' },
    { host: 'food.grab.com', programme: '*', tagged: true, kind: 'food' },
  ], { memberId: 'mem_1', dest: 'phuket', surface: 'service_option' });

  assert.equal(out.logged, 2);
  assert.equal(d.inserted.length, 2);
  const r = row(d.inserted[1]);
  assert.equal(r.host, 'food.grab.com');
  assert.equal(r.programme, '*');
  assert.equal(r.tagged, 1, 'tagged must persist as 1/0 — SQLite has no boolean');
  assert.equal(r.event, 'handoff');
  assert.equal(r.surface, 'service_option');
  assert.equal(r.kind, 'food');
  assert.equal(r.member_id, 'mem_1');
  assert.equal(r.dest, 'phuket');
  assert.equal(typeof r.ts, 'number');
  assert.ok(r.ts > 1_700_000_000 && r.ts < 4_000_000_000, 'ts must be unix SECONDS, like every other table');
});

test('the same host twice in one reply is one row, not two', async () => {
  const d = db();
  const out = await recordHandoffs(d, [
    { host: 'grab.com', tagged: false, kind: 'ride' },
    { host: 'grab.com', tagged: false, kind: 'ride' },
  ], {});
  assert.equal(out.logged, 1, 'a duplicated link inflated the host that gets applied for first');
  assert.equal(d.inserted.length, 1);
});

test('the same host under two different kinds is two rows', async () => {
  const d = db();
  await recordHandoffs(d, [
    { host: 'grab.com', tagged: false, kind: 'ride' },
    { host: 'grab.com', tagged: false, kind: 'food' },
  ], {});
  assert.equal(d.inserted.length, 2, 'ride and food are different programmes at Grab and must not collapse');
});

test('an untagged handoff is recorded, not skipped', async () => {
  // The whole value of this table before any programme is approved.
  const d = db();
  await recordHandoffs(d, [{ host: 'hungryhub.com', programme: null, tagged: false, kind: 'table' }], {});
  assert.equal(row(d.inserted[0]).tagged, 0);
  assert.equal(row(d.inserted[0]).programme, null);
});

test('a link with no host is dropped rather than logged as an empty string', async () => {
  const d = db();
  const out = await recordHandoffs(d, [{ host: '', tagged: false }, { host: null, tagged: false }], {});
  assert.equal(out.logged, 0);
  assert.equal(d.inserted.length, 0);
});

test('an unknown event value cannot reach the table', async () => {
  const d = db();
  await recordHandoffs(d, [{ host: 'resy.com', tagged: true }], { event: 'purchase' });
  assert.equal(row(d.inserted[0]).event, 'handoff', "'purchase' would be a claim we cannot support");
});

test("'tap' is accepted, because that is the honest name for a real click", async () => {
  const d = db();
  await recordHandoffs(d, [{ host: 'resy.com', tagged: true }], { event: 'tap' });
  assert.equal(row(d.inserted[0]).event, 'tap');
});

test('the table is created before the first insert', async () => {
  const d = db();
  await recordHandoffs(d, [{ host: 'resy.com', tagged: true }], {});
  assert.ok(d.ddl.some((q) => /CREATE TABLE IF NOT EXISTS num_affiliate_clicks/.test(q)));
  assert.ok(d.ddl.some((q) => /CREATE INDEX IF NOT EXISTS idx_affclick_ts/.test(q)),
    'without an index on ts the nightly window scan reads the whole table');
});

test('no DB, no rows, no error', async () => {
  assert.deepEqual(await recordHandoffs({}, [{ host: 'resy.com' }], {}), { logged: 0 });
  assert.deepEqual(await recordHandoffs(null, [{ host: 'resy.com' }], {}), { logged: 0 });
  assert.deepEqual(await recordHandoffs(db(), [], {}), { logged: 0 });
});

test('a D1 failure is swallowed — bookkeeping never costs a guest their answer', async () => {
  const d = db({ failOn: 'batch' });
  const out = await recordHandoffs(d, [{ host: 'resy.com', tagged: true }], {});
  assert.equal(out.logged, 0);
  assert.match(out.error, /no such table/);
});

test('logHandoffs hands the promise to ctx.waitUntil when there is one', async () => {
  const d = db();
  const waited = [];
  const ret = logHandoffs(d, { waitUntil: (p) => waited.push(p) }, [{ host: 'resy.com' }], {});
  assert.equal(ret, null, 'with a ctx the caller must not be given something to await');
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(d.inserted.length, 1);
});

test('logHandoffs returns an awaitable when there is no ctx', async () => {
  // The partner MCP path calls the booking handler in-process with no
  // execution context. An un-awaited promise there is cancelled and the row
  // silently never lands.
  const d = db();
  const p = logHandoffs(d, undefined, [{ host: 'resy.com' }], {});
  assert.ok(p && typeof p.then === 'function');
  await p;
  assert.equal(d.inserted.length, 1);
});

/* ── the wiring, driven end to end ──────────────────────────────────────── */

test('a Phuket table request produces tagged links and one row per host', async () => {
  // The real chain: services.mjs ranks the providers, affiliate.mjs tags what
  // it ranked, and the click log records what was handed over. Nothing here is
  // a stand-in except D1.
  const { optionsFor } = await import('./services.mjs');
  const env = { NUM_AFFILIATES: '{"*":{"ref":"num","param":"utm_source"}}' };
  const { options } = optionsFor('table', { country: 'TH', city: 'Phuket', q: 'pad thai' }, env);
  assert.ok(options.length >= 3, 'the Thailand table providers vanished from services.mjs');

  const before = options.map((o) => o.id);
  const out = [];
  const retagged = options.map((o) => {
    const t = tagged(o.url, env, { extra: 'phuket' });
    out.push({ host: t.host, programme: t.programme, tagged: t.tagged, kind: 'table' });
    return { ...o, url: t.url };
  });

  assert.deepEqual(retagged.map((o) => o.id), before,
    'tagging reordered the providers — a referral rate has reached the ranking');
  assert.equal(retagged[0].id, 'hungryhub', 'the top Thailand table provider changed; the ranking is what it is');
  for (const o of retagged) assert.match(o.url, /utm_source=num/, `${o.id} was handed over untagged`);

  const d = db();
  const res = await recordHandoffs(d, out, { dest: 'phuket', surface: 'service_option', memberId: null });
  assert.equal(res.logged, options.length);
  assert.deepEqual(d.inserted.map((a) => a[0]), ['hungryhub.com', 'chope.co', 'thefork.com']);
  assert.ok(d.inserted.every((a) => a[2] === 1), 'the catch-all failed to tag one of the live Phuket links');
});

test('the booking API tags and logs the link it hands out', async () => {
  const { handleBookLink } = await import('./openapi.mjs');
  const place = {
    id: 'p1', name: 'Bestia', dest: 'los-angeles', category: 'Restaurant',
    booking_platform: 'opentable', booking_ref: 'bestia-los-angeles',
    hours_mask: null, phone: '+1', website: 'https://x.test/',
  };
  const d = db();
  const env = {
    ...d,
    NUM_AFFILIATES: '{"opentable.com":{"ref":"12345","param":"ref"},"*":{"ref":"num","param":"utm_source"}}',
  };
  // The place lookup and the timezone lookup both go through prepare().first().
  env.DB = {
    ...d.DB,
    prepare(q) {
      const s = d.DB.prepare(q);
      return { ...s, bind: (...a) => ({ ...s.bind(...a), first: async () => (/FROM places/.test(q) ? place : { tz: 'America/Los_Angeles' }) }) };
    },
  };

  const req = new Request('https://app.itsnum.com/api/book/link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place_id: 'p1', party: 2 }),
  });
  const body = await (await handleBookLink(req, env)).json();

  assert.equal(body.bookable, true);
  assert.match(body.url, /opentable\.com/);
  assert.match(body.url, /[?&]ref=12345/, 'the booking link went out untagged');
  assert.equal(body.booked, false, 'a tagged link is still not a reservation');
  assert.equal(d.inserted.length, 1, 'the booking handoff was not logged');
  assert.equal(row(d.inserted[0]).host, 'opentable.com');
  assert.equal(row(d.inserted[0]).programme, 'opentable.com');
  assert.equal(row(d.inserted[0]).tagged, 1);
  assert.equal(row(d.inserted[0]).surface, 'book_link');
});
