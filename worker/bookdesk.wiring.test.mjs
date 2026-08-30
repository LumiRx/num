// The restaurant booking loop, end to end, through the real router.
//
// bookdesk.mjs has been a complete, deployed, closed loop for days and could
// not complete a single booking, because nothing reached it and nothing could
// choose it. Four things were missing and each of them is silent:
//
//   1. ROUTE SHADOW. `url.pathname.startsWith('/api/book')` is registered in
//      worker/index.mjs above the `/api/booking` block, and
//      '/api/booking/status'.startsWith('/api/book') is true. Every Sabre air
//      request reached bookdesk as the path 'ing/status' and came back
//      {"error":"not found"}. Two siblings had already been rescued by hand;
//      this was the third and it was a prefix, so it did not look like one.
//   2. NO ACTION. worker/prompt.mjs had no `book_table`, so the concierge
//      brain had no way to choose to book — the loop was unreachable from the
//      product even with the route open.
//   3. PHONE FORMAT. The venue number went to Twilio as typed. A bare
//      ten-digit number is undialable and a guessed country code texts a
//      stranger on another continent.
//   4. CONFIRMATION. A booking request is a text to a real restaurant naming a
//      real guest. Emitting the action must send NOTHING.
//
// These are NOT regexes over the source. Nineteen of the fifty test files in
// this repo assert on the TEXT of the module they cover, which passes happily
// when the code is right-looking and wrong — and a regex would have found the
// word '/api/booking' in index.mjs on the day the route was dead. So
// everything below imports the real Worker, drives real Requests at real
// paths, runs them against a real SQLite database with the real schema, and
// asserts on real response bodies and real ledger rows. `fetch` is stubbed at
// exactly one boundary — Twilio — because a test that texts a restaurant is
// not a test.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.mjs';
import { REPLY_SCHEMA, normalizeReply } from './prompt.mjs';
import { venueE164 } from './bookdesk.mjs';

// ── a D1 that is actually SQLite ───────────────────────────────────────────
//
// Same shim as social.takeover.test.mjs, and for the same reason: the
// properties under test here are decided by which row a WHERE clause finds
// (the `AND state='requested'` idempotency guard, the INSERT OR IGNORE on the
// commission) and a fake returning canned rows cannot see either. Statements
// compile at EXECUTION time, not at prepare(), because D1 does the same and
// the lazy ensure() in bookdesk.mjs depends on it.
function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: stmt.all(...args), success: true };
      stmt.run(...args);
      return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
    },
  });
  return {
    prepare(sql) {
      const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) });
      return bound([]);
    },
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
}

const db = new DatabaseSync(':memory:');

// The member table belongs to social.mjs and the directory to the crawler.
// Both are read by bookdesk before it will text anybody, so without them every
// request 404s and none of the assertions below would mean anything.
db.exec(`CREATE TABLE IF NOT EXISTS num_members (
  id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0)`);
db.exec(`CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY, name TEXT, category TEXT, business_id TEXT, dest TEXT)`);
// The SMS consent register. bookdesk refuses to text any number without a
// live row here (A2P blocker B1) — `venue_phone` arrives in the REQUEST BODY,
// so without this gate the endpoint is an open SMS relay, and the numbers it
// was designed for come from map scrapes rather than from anyone who agreed to
// hear from us. Creating the table and seeding Suay is what makes the send
// path reachable at all; the refusal path is covered in
// worker/bookdesk.consent.test.mjs and once more below.
db.exec(`CREATE TABLE IF NOT EXISTS num_sms_consent (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, first_name TEXT,
  consent_text TEXT NOT NULL, consent_version TEXT NOT NULL, page TEXT,
  ip TEXT, user_agent TEXT, country TEXT,
  created_at INTEGER NOT NULL, revoked_at INTEGER)`);
db.exec(`INSERT INTO num_sms_consent (id, phone, consent_text, consent_version, created_at)
         VALUES ('sc_suay', '+66762917970', 'Suay agreed to receive booking requests from NUM.', 'v1', 1787000000)`);
db.exec(`INSERT INTO num_members (id, name) VALUES ('mem_guest0000000001', 'Viv')`);
db.exec(`INSERT INTO places (id, name, category, business_id, dest)
         VALUES ('pl_suay', 'Suay Restaurant', 'Restaurant', NULL, 'phuket')`);

const env = {
  DB: d1(db),
  // Explicitly on, because it is explicitly off by default — the kill switch.
  BOOKDESK_ENABLED: 'true',
  ADMIN_KEY: 'test-admin-key',
  NUM_APP_ORIGIN: 'https://app.itsnum.com',
  // Present so smsPartner takes the Twilio path; the stub below answers it.
  TWILIO_SID: 'ACtest', TWILIO_TOKEN: 'token', TWILIO_FROM: '+15550000000',
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

// Every text that "went out", so a test can assert one was sent and read the
// exact number Twilio was asked to dial.
const outbox = [];
/** Flip to false to reproduce Twilio refusing an unregistered A2P campaign. */
let smsWorks = true;

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (!target.includes('api.twilio.com')) {
    throw new Error(`unexpected fetch — the only network this test allows is Twilio: ${target}`);
  }
  const form = new URLSearchParams(init.body);
  if (!smsWorks) {
    return new Response(JSON.stringify({ code: 30034, message: 'unregistered A2P 10DLC campaign' }), { status: 400 });
  }
  outbox.push({ to: form.get('To'), from: form.get('From'), body: form.get('Body') });
  return new Response(JSON.stringify({ sid: `SM${outbox.length}` }), { status: 201 });
};

// ── real requests, through the real router ─────────────────────────────────

// A fresh source IP per request. index.mjs runs ONE per-IP limiter in front of
// every POST /api/* (guard.mjs:82), and a suite that makes thirty requests in
// under a second from one address is throttled by it — which is the limiter
// working, not the desk failing. Each request here is a different guest.
let caller = 0;
const nextIp = () => `198.51.100.${(caller++ % 250) + 1}`;

const hit = (path, init) =>
  worker.fetch(
    new Request(`https://app.itsnum.com${path}`, {
      ...init,
      headers: { 'CF-Connecting-IP': nextIp(), ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    }),
    env,
    ctx,
  );

const post = (path, body) => hit(path, { method: 'POST', body: JSON.stringify(body) });
const read = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });

const ask = (over = {}) =>
  post('/api/book/request', {
    me: 'mem_guest0000000001',
    venue_name: 'Suay Restaurant',
    place_id: 'pl_suay',
    party_size: 2,
    on_date: '2026-08-20',
    at_time: '19:30',
    ...over,
  });

/** The two links a venue actually taps, rebuilt from a sent text. */
const linksIn = (body) => ({
  confirm: body.match(/CONFIRM: (\S+)/)?.[1],
  decline: body.match(/DECLINE: (\S+)/)?.[1],
});
const pathOf = (u) => new URL(u).pathname + new URL(u).search;

const commissions = (bookingId) =>
  db.prepare('SELECT * FROM num_commissions WHERE booking_id = ?').all(bookingId);
const requestRows = () => db.prepare('SELECT * FROM num_booking_requests').all();

before(async () => {
  // Force the lazy schema and the place_id migration through once.
  await hit('/api/book/mine?me=mem_guest0000000001');
});

// ── 1 · the route is actually reachable ────────────────────────────────────

describe('routing — every /api/book* sibling answers its own handler', () => {
  test('the bookdesk paths reach bookdesk', async () => {
    const { status, body } = await read(await hit('/api/book/mine?me=mem_guest0000000001'));
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.requests), `/api/book/mine did not reach bookdesk: ${JSON.stringify(body)}`);
  });

  test('/api/booking is no longer swallowed by the /api/book prefix', async () => {
    // THE REGRESSION. Before the fix this answered 404 {"error":"not found"} —
    // bookdesk's own 404, for the path 'ing/status' it has never heard of.
    const { status, body } = await read(await hit('/api/booking/status'));
    assert.notEqual(status, 404, '/api/booking/status is being shadowed by the /api/book prefix again');
    assert.equal(
      body.error, undefined,
      `/api/booking/status fell through to bookdesk: ${JSON.stringify(body)}`,
    );
    assert.ok('operations' in body, 'this is not sabre-booking’s status body — something else is answering');
  });

  test('the two rescued siblings still answer their own handlers', async () => {
    for (const p of ['/api/book/platforms', '/api/book/link?ref=x']) {
      const { body } = await read(await hit(p));
      assert.notEqual(
        body.error, 'not found',
        `${p} is answering bookdesk's 404 — it has been shadowed again`,
      );
    }
  });

  test('a path bookdesk really does not own still 404s', async () => {
    // The fix must not make everything reachable. This one SHOULD be a 404.
    const { status } = await read(await hit('/api/book/nonsense'));
    assert.equal(status, 404);
  });
});

// ── 2 · the brain can choose it, and choosing sends nothing ────────────────

describe('the book_table action', () => {
  test('the reply grammar admits it', () => {
    // Asserted against the real schema object the model is given, not the
    // source text of the file — a typo'd enum still reads fine in prose.
    const types = REPLY_SCHEMA.properties.actions.items.properties.type.enum;
    assert.ok(types.includes('book_table'), `book_table is not in the action enum: ${types.join(', ')}`);
  });

  test('a well-formed payload survives normalizeReply into the frontend shape', () => {
    const out = normalizeReply({
      reply: 'Ready to send.',
      card: null,
      chips: null,
      actions: [{
        type: 'book_table',
        payload: JSON.stringify({
          venue_name: 'Suay Restaurant', venue_phone: '+66 76 291 797', place_id: 'pl_suay',
          party_size: 2, on_date: '2026-08-20', at_time: '19:30', note: 'window table',
        }),
      }],
    });
    assert.equal(out.actions.length, 1);
    const a = out.actions[0];
    assert.equal(a.type, 'book_table');
    assert.equal(a.request.venue_name, 'Suay Restaurant');
    assert.equal(a.request.party_size, 2);
    assert.equal(a.request.at_time, '19:30');
    assert.equal(a.request.place_id, 'pl_suay');
  });

  test('an under-specified request is dropped rather than defaulted', () => {
    // "A table for someone, at some point" is not a thing a restaurant can
    // answer, and a party size invented server-side is one nobody agreed to.
    for (const p of [
      { venue_name: 'Suay Restaurant', at_time: '19:30' },              // no party
      { venue_name: 'Suay Restaurant', party_size: 2 },                 // no time
      { party_size: 2, at_time: '19:30' },                              // no venue
      { venue_name: 'Suay', party_size: 0, at_time: '19:30' },          // party of nobody
    ]) {
      const out = normalizeReply({ actions: [{ type: 'book_table', payload: JSON.stringify(p) }] });
      assert.equal(out.actions.length, 0, `an incomplete request survived: ${JSON.stringify(p)}`);
    }
  });

  test('EMITTING the action sends nothing and books nothing', async () => {
    // The confirmation rule, stated as a fact about the system rather than a
    // sentence in the persona: the action is inert. Only the guest's own tap —
    // POST /api/book/request — reaches a restaurant.
    const textsBefore = outbox.length;
    const rowsBefore = requestRows().length;
    normalizeReply({
      actions: [{
        type: 'book_table',
        payload: JSON.stringify({ venue_name: 'Suay Restaurant', venue_phone: '+66762917970', party_size: 2, at_time: '19:30' }),
      }],
    });
    assert.equal(outbox.length, textsBefore, 'emitting book_table texted a venue');
    assert.equal(requestRows().length, rowsBefore, 'emitting book_table created a booking request');
  });
});

// ── 3 · the venue number, in the only form Twilio will dial ────────────────

describe('E.164 normalisation of the venue number', () => {
  test('the normaliser accepts what a real listing carries', () => {
    assert.equal(venueE164('+66812345678'), '+66812345678');       // already E.164
    assert.equal(venueE164('+66 81 234 5678'), '+66812345678');    // Thai, spaced
    assert.equal(venueE164('+1 (212) 555-1234'), '+12125551234');  // US, punctuated
    assert.equal(venueE164('0066812345678'), '+66812345678');      // 00 prefix
  });

  test('it refuses rather than guesses', () => {
    // A bare ten-digit US number and a bare nine-digit Thai number are
    // indistinguishable. Defaulting to +1 texts Ohio about a table in Phuket.
    assert.equal(venueE164('212-555-1234'), null, 'a bare US 10-digit number was given a country code');
    assert.equal(venueE164('0812345678'), null, 'a bare Thai national number was given a country code');
    assert.equal(venueE164('call the front desk'), null);
    assert.equal(venueE164('+12'), null);
    assert.equal(venueE164(''), null);
    assert.equal(venueE164(null), null);
  });

  test('a junk number is refused by the endpoint, and no text goes out', async () => {
    const before = outbox.length;
    const { status, body } = await read(await ask({ venue_phone: 'call the front desk' }));
    assert.equal(status, 400);
    assert.equal(body.bad_phone, true);
    assert.equal(outbox.length, before, 'a request with an undialable number still texted somebody');
  });

  test('a bare US 10-digit number is refused, not silently made American', async () => {
    const { status, body } = await read(await ask({ venue_phone: '212-555-1234' }));
    assert.equal(status, 400, `a country-code-less number was accepted: ${JSON.stringify(body)}`);
  });

  test('a Thai number is dialled in E.164 and stored that way', async () => {
    const { status, body } = await read(await ask({ venue_phone: '+66 76 291 797 0' }));
    assert.equal(status, 200);
    assert.equal(body.texted, true);
    assert.equal(outbox.at(-1).to, '+66762917970', 'Twilio was handed a number it cannot dial');

    const row = db.prepare('SELECT venue_phone FROM num_booking_requests WHERE id=?').get(body.id);
    assert.equal(row.venue_phone, '+66762917970', 'the un-normalised number was stored');
  });

  test('no number at all is a legitimate state — the request stands, honestly', async () => {
    const before = outbox.length;
    const { status, body } = await read(await ask({ venue_phone: undefined }));
    assert.equal(status, 200);
    assert.equal(body.texted, false, 'texted:true with no number to text');
    assert.equal(outbox.length, before);
    assert.match(body.note, /desk/i, 'the guest was not told a human is working it');
  });

  test('a venue that never agreed to hear from us is not texted', async () => {
    // A2P blocker B1, end to end through the real router. `venue_phone` comes
    // from the REQUEST BODY, and the numbers this endpoint was built around
    // come from OpenStreetMap and Google Places scrapes — nobody on that list
    // consented to anything. The A2P campaign we are filing declares the
    // opposite to a carrier, so this is the assertion that keeps the filing
    // true, not a tidiness check.
    //
    // A different Thai number, deliberately: it is well-formed, dialable, and
    // passes every other gate. The ONLY thing wrong with it is that there is
    // no row in num_sms_consent.
    const before = outbox.length;
    const { status, body } = await read(await ask({ venue_phone: '+66812345678' }));
    assert.equal(status, 200, 'the booking was lost along with the text');
    assert.equal(body.texted, false, 'an unconsented number was texted');
    assert.equal(outbox.length, before, 'Twilio was called for a number with no consent on file');
    // The guest is not left believing a restaurant has their table.
    assert.match(body.note, /desk/i, 'the guest was not told a human is working it');
    assert.ok(requestRows().some((r) => r.id === body.id), 'the request was not logged for the desk to work');
  });

  test('Twilio refusing the send is reported as not-texted, never as sent', async () => {
    // The live case today: an unregistered A2P 10DLC campaign returns 30034.
    smsWorks = false;
    const { status, body } = await read(await ask({ venue_phone: '+66762917970' }));
    smsWorks = true;
    assert.equal(status, 200, 'a failed text lost the request');
    assert.equal(body.texted, false, 'a refused text was reported to the guest as sent');
    assert.ok(requestRows().some((r) => r.id === body.id), 'the request was not logged for the desk to work');
  });
});

// ── 4 · the tap, once, and the money exactly once ──────────────────────────

describe('the venue taps the link', () => {
  test('a confirm flips the state, tells the guest, and accrues once', async () => {
    const { body } = await read(await ask({ venue_phone: '+66762917970' }));
    const { confirm } = linksIn(outbox.at(-1).body);
    assert.ok(confirm, `no CONFIRM link in the text: ${outbox.at(-1).body}`);

    const res = await hit(pathOf(confirm));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Confirmed/);

    const row = db.prepare('SELECT state FROM num_booking_requests WHERE id=?').get(body.id);
    assert.equal(row.state, 'confirmed');

    const rows = commissions(body.id);
    assert.equal(rows.length, 1, `a confirmed table accrued ${rows.length} commission rows`);
    assert.equal(rows[0].category, 'reservation');
    assert.equal(rows[0].amount_cs, 200, 'a reservation is a flat $2, not a percentage');
    assert.equal(rows[0].state, 'accrued');
  });

  test('the same link tapped again changes nothing and bills nothing', async () => {
    // This URL lives in an SMS on a stranger's phone. It gets tapped twice,
    // forwarded to a colleague, and prefetched by link previewers.
    const { body } = await read(await ask({ venue_phone: '+66762917970' }));
    const { confirm } = linksIn(outbox.at(-1).body);

    await hit(pathOf(confirm));
    const second = await hit(pathOf(confirm));
    const html = await second.text();

    assert.match(html, /already answered/, 'a second tap was treated as a first');
    assert.equal(commissions(body.id).length, 1, 'the venue was billed twice for one table');
    assert.equal(
      db.prepare('SELECT state FROM num_booking_requests WHERE id=?').get(body.id).state,
      'confirmed',
    );
  });

  test('a decline after a confirm cannot un-confirm the table', async () => {
    const { body } = await read(await ask({ venue_phone: '+66762917970' }));
    const { confirm, decline } = linksIn(outbox.at(-1).body);

    await hit(pathOf(confirm));
    await hit(pathOf(decline));

    assert.equal(
      db.prepare('SELECT state FROM num_booking_requests WHERE id=?').get(body.id).state,
      'confirmed',
      'yesterday’s decline link un-confirmed a table somebody is sitting at',
    );
    assert.equal(commissions(body.id).length, 1);
  });

  test('a decline accrues nothing', async () => {
    const { body } = await read(await ask({ venue_phone: '+66762917970' }));
    const { decline } = linksIn(outbox.at(-1).body);
    await hit(pathOf(decline));

    assert.equal(
      db.prepare('SELECT state FROM num_booking_requests WHERE id=?').get(body.id).state, 'declined',
    );
    assert.equal(commissions(body.id).length, 0, 'a table nobody got was billed for');
  });

  test('a forged token confirms nothing', async () => {
    const { body } = await read(await ask({ venue_phone: '+66762917970' }));
    const res = await hit(`/api/book/answer?id=${body.id}&v=confirmed&t=${'0'.repeat(32)}`);
    assert.equal(res.status, 403);
    assert.equal(
      db.prepare('SELECT state FROM num_booking_requests WHERE id=?').get(body.id).state, 'requested',
    );
    assert.equal(commissions(body.id).length, 0);
  });

  test('a confirm token cannot decline', async () => {
    // sign() is HMAC over (id, verdict) exactly so this is impossible.
    const { body } = await read(await ask({ venue_phone: '+66762917970' }));
    const { confirm } = linksIn(outbox.at(-1).body);
    const token = new URL(confirm).searchParams.get('t');
    const res = await hit(`/api/book/answer?id=${body.id}&v=declined&t=${token}`);
    assert.equal(res.status, 403);
  });
});

// ── 5 · the kill switch ────────────────────────────────────────────────────

describe('the kill switch', () => {
  test('off by default — a fresh environment asks nobody for a table', async () => {
    const before = outbox.length;
    const res = await worker.fetch(
      new Request('https://app.itsnum.com/api/book/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify({ me: 'mem_guest0000000001', venue_name: 'Suay Restaurant', venue_phone: '+66762917970', party_size: 2, at_time: '19:30' }),
      }),
      { ...env, BOOKDESK_ENABLED: undefined },
      ctx,
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).disabled, true);
    assert.equal(outbox.length, before, 'a switched-off desk still texted a venue');
  });

  test('switching it off does not strand a venue mid-answer', async () => {
    // The confirm link is already in a text message on somebody's phone. If
    // pulling the switch broke /answer, a restaurant would tap CONFIRM, get an
    // error, and a guest would be left waiting on a table the venue thinks it
    // has given them.
    const { body } = await read(await ask({ venue_phone: '+66762917970' }));
    const { confirm } = linksIn(outbox.at(-1).body);

    const off = { ...env, BOOKDESK_ENABLED: undefined };
    const res = await worker.fetch(new Request(`https://app.itsnum.com${pathOf(confirm)}`), off, ctx);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Confirmed/);
    assert.equal(
      db.prepare('SELECT state FROM num_booking_requests WHERE id=?').get(body.id).state, 'confirmed',
    );

    // And the guest can still read their own list while it is off.
    const mine = await worker.fetch(new Request(`https://app.itsnum.com/api/book/mine?me=mem_guest0000000001`), off, ctx);
    assert.equal(mine.status, 200);
  });
});

// ── 6 · the guest can see it ───────────────────────────────────────────────

test('the guest’s own list carries the state the venue set', async () => {
  // A guest of their own, because /mine is `ORDER BY created_at DESC LIMIT 20`
  // and every row in this file is written in the same second — sharing the
  // first guest would make this assertion depend on SQLite's tie-break.
  db.exec(`INSERT INTO num_members (id, name) VALUES ('mem_guest0000000002', 'Dan')`);
  const { body: made } = await read(await ask({ me: 'mem_guest0000000002', venue_phone: '+66762917970' }));
  const { confirm } = linksIn(outbox.at(-1).body);
  await hit(pathOf(confirm));

  const { body } = await read(await hit('/api/book/mine?me=mem_guest0000000002'));
  const mine = body.requests.find((r) => r.id === made.id);
  assert.ok(mine, 'the guest cannot see their own request');
  assert.equal(mine.state, 'confirmed');
  assert.equal(mine.venue_name, 'Suay Restaurant');
  assert.equal(mine.party_size, 2);
});
