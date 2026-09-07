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
import { _resetForTests as _resetSourcing } from './sourcing.mjs';

/**
 * Worker env whose `DB` is a D1 stand-in remembering every bound row.
 *
 * `scouts` maps a place id to the scout credited with introducing it, so the
 * attribution lookup in sourcing.mjs has something real to answer with. An
 * empty map is the honest default: almost no place has a scout.
 *
 * A value may be a bare scout id, or `{ id, code }` where the two differ —
 * which in production they always do: the id is `sc_adam` and the code, the
 * thing that travels to the affiliate network, is `ADAM`. Tests that assert
 * on what reaches the network must use the second form or they are asserting
 * on a value production never produces.
 */
function db({ failOn = null, scouts = {} } = {}) {
  const inserted = [];
  const ddl = [];
  const migrations = [];
  const api = {
    prepare(q) {
      const isInsert = /^\s*INSERT/i.test(q);
      const isScoutLookup = /FROM num_scout_places/i.test(q);
      const bound = (args) => ({
        __q: q,
        __args: args,
        __insert: isInsert,
        // The attribution query, answered from `scouts`.
        async all() {
          if (!isScoutLookup) return { results: [] };
          const results = args
            .filter((id) => scouts[id])
            .map((id) => {
              const v = scouts[id];
              const scoutId = typeof v === 'string' ? v : v.id;
              return {
                place_id: id,
                scout_place_id: `sp_${id}`,
                scout_id: scoutId,
                state: 'activated',
                code: typeof v === 'string' ? String(v).toUpperCase() : v.code,
              };
            });
          return { results };
        },
        async first() { return (await this.all()).results[0] ?? null; },
        async run() { return { success: true }; },
      });
      return {
        // Carried so that batch() can tell what it was handed. `ddl` is
        // recorded THERE and not here, because the difference between a
        // statement in the SCHEMA batch and one run on its own afterwards is
        // exactly what the migration-ordering test needs to see.
        __q: q,
        __insert: isInsert,
        __scoutLookup: isScoutLookup,
        // `bind` must return the STATEMENT, so a batch of bound statements is
        // a list of things D1 can run — not a list of databases.
        bind(...args) { return bound(args); },
        // ALTER TABLE and CREATE INDEX are run un-bound. Recording them is how
        // the migration test can prove the new columns are actually added to
        // the table that already exists in production.
        async run() { migrations.push(q.replace(/\s+/g, ' ').trim()); return { success: true }; },
      };
    },
    async batch(stmts) {
      if (failOn === 'batch') throw new Error('D1_ERROR: no such table');
      for (const s of stmts) {
        if (s.__insert) inserted.push(s.__args);
        else if (!s.__scoutLookup) ddl.push(String(s.__q ?? '').replace(/\s+/g, ' ').trim());
      }
      return stmts.map(() => ({ success: true }));
    },
  };
  return { DB: api, inserted, ddl, migrations };
}

// Column order matters here in the same way it matters in the INSERT: this
// list IS the mapping from bound argument to column name, so a column added
// in the middle of the statement and not added here silently renames every
// assertion after it.
const COLS = ['host', 'programme', 'tagged', 'event', 'surface', 'kind', 'member_id', 'dest',
  'place_id', 'scout_id', 'ts'];
const row = (args) => Object.fromEntries(COLS.map((c, i) => [c, args[i]]));

test.beforeEach(() => { _resetForTests(); _resetSourcing(); });

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
  // `mode` distinguishes the two ways a programme earns: appending a ref
  // parameter, or rewriting the link through a click-redirect network. They
  // are reconciled against completely different payout reports, so an ops page
  // that cannot tell them apart cannot check either one.
  assert.deepEqual(programmes(env), [{ host: '*', mode: 'param', param: 'utm_source' }],
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

/* ── whose link was it ──────────────────────────────────────────────────── */
//
// Until these columns existed, a handoff for a hotel somebody sourced looked
// exactly like a handoff for a hotel that came off OpenStreetMap: same host,
// same programme, same kind. The tests below are the ones that would have
// caught that, and the ones that keep it fixed.

test('the migration adds the two new columns to the table already in production', async () => {
  // CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so the
  // columns arrive by ALTER or they do not arrive at all — and the table has
  // been live and collecting rows since before either column was thought of.
  const d = db();
  await recordHandoffs(d, [{ host: 'x.test' }], {});
  const m = d.migrations.join('\n');
  assert.match(m, /ALTER TABLE num_affiliate_clicks ADD COLUMN place_id TEXT/);
  assert.match(m, /ALTER TABLE num_affiliate_clicks ADD COLUMN scout_id TEXT/);
});

test('the scout index is created AFTER the column it names', async () => {
  // A partial index naming scout_id, run in the SCHEMA batch, would be
  // created before the ALTER that adds the column — and because SCHEMA runs
  // as one batch, that single failure rolls back the whole batch and leaves
  // the click log writing nothing at all.
  const d = db();
  await recordHandoffs(d, [{ host: 'x.test' }], {});
  const m = d.migrations;
  const alter = m.findIndex((q) => /ADD COLUMN scout_id/.test(q));
  const index = m.findIndex((q) => /idx_affclick_scout/.test(q));
  assert.ok(alter >= 0 && index > alter, `index must follow its column: ${JSON.stringify(m)}`);
  assert.ok(!/idx_affclick_scout/.test(d.ddl.join('\n')), 'the partial index must not be in the SCHEMA batch');
});

test('a handoff for a sourced place records the place AND the scout', async () => {
  const d = db({ scouts: { 'hotel-adam-1': 'sc_adam' } });
  const out = await recordHandoffs(d, [
    { host: 'be.synxis.com', programme: null, tagged: false, kind: 'synxis', placeId: 'hotel-adam-1' },
  ], { surface: 'book_link', dest: 'bath' });
  assert.equal(out.logged, 1);
  assert.equal(out.attributed, 1);
  const r = row(d.inserted[0]);
  assert.equal(r.place_id, 'hotel-adam-1');
  assert.equal(r.scout_id, 'sc_adam');
});

test('a handoff for a place nobody sourced records the place and no scout', async () => {
  // The place id still lands. Attribution and evidence are different jobs, and
  // the row is worth keeping either way.
  const d = db({ scouts: { 'hotel-adam-1': 'sc_adam' } });
  const out = await recordHandoffs(d, [
    { host: 'be.synxis.com', kind: 'synxis', placeId: 'osm-hotel' },
  ], {});
  assert.equal(out.attributed, 0);
  assert.equal(row(d.inserted[0]).place_id, 'osm-hotel');
  assert.equal(row(d.inserted[0]).scout_id, null, 'an unsourced place must not inherit anybody');
});

test('a city-level provider link belongs to nobody and says so', async () => {
  const d = db({ scouts: { 'hotel-adam-1': 'sc_adam' } });
  await recordHandoffs(d, [{ host: 'food.grab.com', kind: 'food' }], { surface: 'concierge' });
  assert.equal(row(d.inserted[0]).place_id, null);
  assert.equal(row(d.inserted[0]).scout_id, null);
});

test('two hotels on the SAME booking engine are two rows, not one', async () => {
  // The dedupe key used to be host|kind. Two different hotels booked through
  // synxis share both, so one reply offering a sourced hotel and an unsourced
  // one would collapse to a single row and silently drop whichever
  // attribution came second. That is a lost payment to a real person.
  const d = db({ scouts: { 'hotel-adam-1': 'sc_adam' } });
  const out = await recordHandoffs(d, [
    { host: 'be.synxis.com', kind: 'synxis', placeId: 'hotel-adam-1' },
    { host: 'be.synxis.com', kind: 'synxis', placeId: 'osm-hotel' },
  ], {});
  assert.equal(out.logged, 2, 'two venues collapsed into one row');
  const ids = d.inserted.map((a) => row(a).place_id).sort();
  assert.deepEqual(ids, ['hotel-adam-1', 'osm-hotel']);
  assert.equal(out.attributed, 1);
});

test('the same venue offered twice in one reply is still one row', async () => {
  const d = db({ scouts: { 'hotel-adam-1': 'sc_adam' } });
  const out = await recordHandoffs(d, [
    { host: 'be.synxis.com', kind: 'synxis', placeId: 'hotel-adam-1' },
    { host: 'be.synxis.com', kind: 'synxis', placeId: 'hotel-adam-1' },
  ], {});
  assert.equal(out.logged, 1, 'the dedupe must still dedupe');
});

test('a scout the caller already resolved is used without asking again', async () => {
  const d = db();  // the stand-in knows about no scouts at all
  const out = await recordHandoffs(d, [
    { host: 'be.synxis.com', kind: 'synxis', placeId: 'hotel-adam-1', scoutId: 'sc_adam' },
  ], {});
  assert.equal(row(d.inserted[0]).scout_id, 'sc_adam');
  assert.equal(out.attributed, 1);
});

test('the booking API carries place_id and the scout onto the row it logs', async () => {
  // End to end through the real handler: /api/book/link is the single choke
  // point every venue booking link passes through, including the partner MCP.
  const { handleBookLink } = await import('./openapi.mjs');
  const place = {
    id: 'hotel-adam-1', name: 'The Yard', dest: 'bath', category: 'Hotel',
    booking_platform: 'siteminder', booking_ref: 'theyardbathdirect',
    hours_mask: null, phone: '+44', website: 'https://x.test/',
  };
  const d = db({ scouts: { 'hotel-adam-1': 'sc_adam' } });
  const env = { ...d, NUM_AFFILIATES: '{}' };
  env.DB = {
    ...d.DB,
    prepare(q) {
      const s = d.DB.prepare(q);
      return {
        ...s,
        bind: (...a) => ({
          ...s.bind(...a),
          first: async () => (/FROM places/.test(q) ? place
            : /FROM destinations/.test(q) ? { tz: 'Europe/London' }
            : s.bind(...a).first()),
        }),
      };
    },
  };
  const req = new Request('https://app.itsnum.com/api/book/link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place_id: 'hotel-adam-1' }),
  });
  const body = await (await handleBookLink(req, env)).json();
  assert.equal(body.bookable, true);
  assert.equal(d.inserted.length, 1);
  assert.equal(row(d.inserted[0]).place_id, 'hotel-adam-1',
    'the handler had the place id in hand and dropped it');
  assert.equal(row(d.inserted[0]).scout_id, 'sc_adam');
});

test('attribution never reaches the URL that was handed out', async () => {
  // The safety property. A scout share must not be able to change what a
  // guest is shown, and the cheapest proof is that the same place produces a
  // byte-identical link whether or not anybody is credited with it.
  const { handleBookLink } = await import('./openapi.mjs');
  const place = {
    id: 'hotel-adam-1', name: 'The Yard', dest: 'bath', category: 'Hotel',
    booking_platform: 'siteminder', booking_ref: 'theyardbathdirect',
    hours_mask: null, phone: '+44', website: 'https://x.test/',
  };
  const run = async (scouts) => {
    _resetForTests(); _resetSourcing();
    const d = db({ scouts });
    const env = { ...d, NUM_AFFILIATES: '{}' };
    env.DB = {
      ...d.DB,
      prepare(q) {
        const s = d.DB.prepare(q);
        return { ...s, bind: (...a) => ({ ...s.bind(...a), first: async () => (/FROM places/.test(q) ? place : { tz: 'Europe/London' }) }) };
      },
    };
    const req = new Request('https://app.itsnum.com/api/book/link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place_id: 'hotel-adam-1' }),
    });
    return (await (await handleBookLink(req, env)).json()).url;
  };
  assert.equal(await run({ 'hotel-adam-1': 'sc_adam' }), await run({}));
});

test('no comment in the schema contains a semicolon', async () => {
  // The schema is split on ';' to make a batch. A semicolon inside a SQL
  // COMMENT therefore cuts a statement in half, and the halves are still
  // valid-looking strings — so the failure is not a syntax error you can read,
  // it is CREATE TABLE silently never running and every later write saying
  // "no such table". This cost a real debugging round the day the two new
  // columns were commented.
  const d = db();
  await recordHandoffs(d, [{ host: 'x.test' }], {});
  const creates = d.ddl.filter((q) => /^CREATE TABLE/i.test(q));
  assert.equal(creates.length, 1, `the CREATE TABLE was split: ${JSON.stringify(d.ddl)}`);
  assert.match(creates[0], /\)$/, 'the CREATE TABLE does not end in a closing paren — it was cut short');
  assert.match(creates[0], /place_id TEXT/);
  assert.match(creates[0], /scout_id TEXT/);
  for (const q of d.ddl) assert.ok(q.length, 'an empty statement means a stray semicolon');
});

test('end to end: a chain hotel Adam sourced goes out through the network, carrying his code', async () => {
  // The whole chain in one assertion, because every link in it was broken
  // separately at the start of the day:
  //   places.website  →  property code  →  chain deep link
  //                   →  wrapped through impact.com
  //                   →  subId1 = the scout's code   (Hilton's own report)
  //                   →  scout_id on the click row   (NUM's own report)
  // Two independent records that have to agree is what makes a commission
  // owed to a real person checkable rather than assertable.
  const { handleBookLink } = await import('./openapi.mjs');
  const place = {
    id: 'hotel-cal', name: 'The Caledonian Edinburgh', dest: 'edinburgh', category: 'Hotel',
    booking_platform: 'hilton', booking_ref: 'ednchqq',
    hours_mask: null, phone: '+44', website: 'https://www.hilton.com/en/hotels/ednchqq-the-caledonian-edinburgh/',
  };
  const d = db({ scouts: { 'hotel-cal': { id: 'sc_adam', code: 'ADAM' } } });
  const env = {
    ...d,
    NUM_AFFILIATES: JSON.stringify({
      'hilton.com': { wrap: 'https://hilton.sjv.io/c/1234567/1958948/12674?subId1={sub}&u={dest}' },
    }),
  };
  env.DB = {
    ...d.DB,
    prepare(q) {
      const s = d.DB.prepare(q);
      return {
        ...s,
        bind: (...a) => ({
          ...s.bind(...a),
          first: async () => (/FROM places/.test(q) ? place
            : /FROM destinations/.test(q) ? { tz: 'Europe/London' }
            : s.bind(...a).first()),
        }),
      };
    },
  };
  const req = new Request('https://app.itsnum.com/api/book/link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place_id: 'hotel-cal' }),
  });
  const body = await (await handleBookLink(req, env)).json();

  assert.equal(body.bookable, true);
  const u = new URL(body.url);
  assert.equal(u.hostname, 'hilton.sjv.io',
    'the guest went straight to hilton.com — a ref parameter there earns nothing');
  assert.equal(u.searchParams.get('subId1'), 'ADAM',
    "the network's own payout report will not name the scout");
  assert.equal(u.searchParams.get('u'),
    'https://www.hilton.com/en/book/reservation/deeplink/?ctyhocn=EDNCHQQ',
    'the destination was mangled on the way into the wrapper');

  const r = row(d.inserted[0]);
  assert.equal(r.place_id, 'hotel-cal');
  assert.equal(r.scout_id, 'sc_adam');
  assert.equal(r.tagged, 1, 'a wrapped link must count as earning, or the report understates it');
  assert.equal(r.host, 'hilton.com', 'the log must name the hotel, not the tracker');
});

test('the same hotel with NO scout still books, and still earns', async () => {
  // Attribution is not a precondition for revenue. A venue nobody introduced
  // must still go out through the network — otherwise adding a scout
  // programme would have quietly switched off earnings on everything else.
  const { handleBookLink } = await import('./openapi.mjs');
  const place = {
    id: 'hotel-cal', name: 'The Caledonian Edinburgh', dest: 'edinburgh', category: 'Hotel',
    booking_platform: 'hilton', booking_ref: 'ednchqq',
    hours_mask: null, phone: '+44', website: 'https://x.test/',
  };
  const d = db();
  const env = {
    ...d,
    NUM_AFFILIATES: JSON.stringify({
      'hilton.com': { wrap: 'https://hilton.sjv.io/c/1/2/3?subId1={sub}&u={dest}' },
    }),
  };
  env.DB = {
    ...d.DB,
    prepare(q) {
      const s = d.DB.prepare(q);
      return { ...s, bind: (...a) => ({ ...s.bind(...a), first: async () => (/FROM places/.test(q) ? place : { tz: 'Europe/London' }) }) };
    },
  };
  const req = new Request('https://app.itsnum.com/api/book/link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place_id: 'hotel-cal' }),
  });
  const body = await (await handleBookLink(req, env)).json();
  const u = new URL(body.url);
  assert.equal(u.hostname, 'hilton.sjv.io');
  // Falls back to the destination slug, which is what this argument carried
  // before scouts existed.
  assert.equal(u.searchParams.get('subId1'), 'edinburgh');
  assert.equal(row(d.inserted[0]).scout_id, null);
});
