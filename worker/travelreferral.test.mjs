// The travel referral, end to end, through the real router.
//
// The properties under test here are not "does the code look right" — nineteen
// of the test files in this repo assert on the TEXT of the module they cover,
// which passes happily when the code is right-looking and wrong. So everything
// below imports the real Worker, drives real Requests at real paths, runs them
// against a real SQLite database with the real schema, and asserts on real
// response bodies and real ledger rows. The one stub is the mail binding,
// because a test that emails a travel agency is not a test — and the brief for
// this work said in capitals not to send anything to a real partner.
//
// What must hold, in the order the money moves:
//
//   1. A NUM- reference is minted, is unique, and is readable down a phone.
//   2. draft → sent → quoted → accepted → confirmed, one guarded step at a
//      time, and no step can be skipped or replayed.
//   3. Commission accrues on exactly one edge and exactly once.
//   4. The agency's link is HMAC-signed, cannot be forged, cannot be swapped
//      for another verdict, and a second submission changes nothing.
//   5. Routing picks the right agency and refuses to guess when there is none.
//   6. NO path accepts a payment instrument, and NO member-facing sentence says
//      Num booked, reserved or priced anything.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.mjs';
import {
  LINES, SCHEMA, STATE_LINE, FORBIDDEN_CLAIMS, PAYMENT_KEYS,
  newRef, handoffText, handoffSubject, offendingClaim, _sign,
} from './travelreferral.mjs';
import { partners, routeFor, commissionBp } from './travelpartners.mjs';
import { REPLY_SCHEMA, normalizeReply } from './prompt.mjs';
import { statementsOf } from './passengers.mjs';

// ── a D1 that is actually SQLite ───────────────────────────────────────────
//
// Same shim as bookdesk.wiring.test.mjs, and for the same reason: every
// property that matters here is decided by which row a WHERE clause finds —
// the `AND state IN (...)` transition guards, the UNIQUE index on `ref`, the
// INSERT OR IGNORE on the commission — and a fake returning canned rows can see
// none of them.
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
db.exec(`CREATE TABLE IF NOT EXISTS num_members (
  id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0)`);
db.exec(`INSERT INTO num_members (id, name, phone) VALUES ('mem_guest0000000001', 'Viv', '+447700900123')`);
db.exec(`INSERT INTO num_members (id, name, phone) VALUES ('mem_guest0000000002', 'Sam', '+447700900124')`);

// Three agencies, because one agency is a hardcode wearing a config's clothes.
// A specialist that only covers Thailand, a Gulf specialist, and a generalist
// carrying the wildcard — which is exactly the shape the partnerships team will
// have by the second signature.
const TRAVEL_PARTNERS = JSON.stringify([
  {
    id: 'letsgo2trip',
    name: 'LetsGo2Trip',
    email: 'handoffs@example-agency.test',
    products: ['flight', 'hotel', 'package', 'transfer'],
    dests: ['*'],
    commission_bp: { flight: 300, hotel: 1000, package: 1200, default: 300 },
    priority: 10,
    sla_hours: 24,
  },
  {
    id: 'phuketdesk',
    name: 'Phuket Desk',
    email: 'desk@example-phuket.test',
    products: ['hotel', 'transfer'],
    dests: ['phuket', 'krabi'],
    commission_bp: { hotel: 1400 },
    priority: 1,
  },
  {
    id: 'dormant',
    name: 'Dormant Travel',
    email: 'nobody@example-dormant.test',
    products: ['*'],
    dests: ['*'],
    priority: 99,
    active: false,
  },
]);

// Every email that "went out", so a test can read exactly what an agency would
// have received. Nothing leaves the process.
const mailbox = [];

const env = {
  DB: d1(db),
  // Explicitly on, because it is explicitly off by default — the kill switch.
  TRAVEL_REFERRAL_ENABLED: 'true',
  TRAVEL_PARTNERS,
  ADMIN_KEY: 'test-admin-key',
  NUM_APP_ORIGIN: 'https://app.itsnum.com',
  EMAIL: { send: async (msg) => { mailbox.push(msg); return { ok: true }; } },
  EMAIL_FROM: 'hello@itsnum.com',
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

// The only network this suite allows is none at all.
globalThis.fetch = async (url) => {
  throw new Error(`unexpected fetch — this test may not touch the network: ${String(url)}`);
};

// A fresh source IP per request: index.mjs runs one per-IP limiter in front of
// every POST /api/* (guard.mjs), and a suite making thirty requests in a second
// from one address is throttled by it — the limiter working, not the desk
// failing.
let caller = 0;
const nextIp = () => `203.0.113.${(caller++ % 250) + 1}`;

const hit = (path, init) =>
  worker.fetch(
    new Request(`https://app.itsnum.com${path}`, {
      ...init,
      headers: {
        'CF-Connecting-IP': nextIp(),
        ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    }),
    env,
    ctx,
  );

const post = (path, body, headers) => hit(path, { method: 'POST', body: JSON.stringify(body), headers });
const admin = (path, body) => post(path, body, { 'X-Admin-Key': 'test-admin-key' });
const read = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });

const refer = (over = {}) =>
  post('/api/travel/refer', {
    me: 'mem_guest0000000001',
    product: 'flight',
    origin: 'London',
    destination: 'Phuket',
    depart_on: '2026-09-04',
    return_on: '2026-09-11',
    adults: 2,
    cabin: 'Economy',
    budget_cs: 180000,
    budget_currency: 'GBP',
    notes: 'Aisle seats together.',
    ...over,
  });

const rowOf = (ref) => db.prepare('SELECT * FROM num_travel_referrals WHERE ref = ?').get(ref);
const commissionsFor = (ref) => db.prepare('SELECT * FROM num_commissions WHERE booking_id = ?').all(ref);

before(async () => {
  // Force the lazy schema through once before anything asserts on a row count.
  await hit('/api/travel/mine?me=mem_guest0000000001');
});

// ── 1 · routing — the module is reachable and owns its own prefix ──────────

describe('routing', () => {
  test('/api/travel reaches the referral handler, not bookdesk', async () => {
    const { status, body } = await read(await hit('/api/travel/mine?me=mem_guest0000000001'));
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.referrals), `/api/travel/mine did not reach the handler: ${JSON.stringify(body)}`);
  });

  test('the neighbouring prefixes still answer their own handlers', async () => {
    // /api/trust is an exact match far above this block and shares four
    // characters with /api/travel. If either ever moves, this fails first.
    const { body } = await read(await hit('/api/book/mine?me=mem_guest0000000001'));
    assert.ok('requests' in body, 'bookdesk stopped answering /api/book/mine');
    const version = await read(await hit('/api/version'));
    assert.equal(version.status, 200);
    assert.equal(version.body.connected.travel_referral.partners, 2, 'the version report lost its partner count');
    assert.equal(version.body.connected.travel_referral.enabled, true);
  });

  test('a path travel really does not own still 404s', async () => {
    const { status } = await read(await hit('/api/travel/nonsense'));
    assert.equal(status, 404);
  });
});

// ── 2 · the reference ──────────────────────────────────────────────────────

describe('the NUM- reference', () => {
  test('is readable down a phone line — no I, O, 0 or 1', () => {
    for (let i = 0; i < 400; i += 1) {
      const ref = newRef();
      assert.match(ref, /^NUM-[2-9A-HJ-NP-Z]{6}$/, `${ref} contains a character a human will mistype`);
    }
  });

  test('40,000 references are effectively unique', () => {
    // 32^6 ≈ 1.07 billion. The birthday bound puts the EXPECTED number of
    // collisions in 40,000 draws at n²/2N ≈ 0.75, so "zero collisions" is not
    // a property this can assert without being flaky roughly half the time.
    // What it can assert is that the generator is drawing from the whole space
    // rather than, say, repeating a seeded value — a broken generator collides
    // thousands of times, not three. The real uniqueness guarantee is the
    // UNIQUE index, tested below against the actual database.
    const seen = new Set();
    for (let i = 0; i < 40_000; i += 1) seen.add(newRef());
    assert.ok(seen.size >= 39_990, `newRef repeated itself ${40_000 - seen.size} times — the generator is not random`);
  });

  test('the database refuses a duplicate reference outright', async () => {
    const { body } = await read(await refer());
    assert.match(body.ref, /^NUM-/);
    assert.throws(
      () => db.prepare(
        'INSERT INTO num_travel_referrals (id, ref, member_id, partner_id, product) VALUES (?,?,?,?,?)',
      ).run('tr_dupe', body.ref, 'mem_guest0000000001', 'letsgo2trip', 'flight'),
      /UNIQUE|constraint/i,
      'two referrals could share a reference — which is an argument about money in month two',
    );
  });
});

// ── 3 · partner routing ────────────────────────────────────────────────────

describe('partner routing — LetsGo2Trip is a row, not the schema', () => {
  test('the config parses and drops nothing valid', () => {
    const all = partners(env);
    assert.deepEqual(all.map((p) => p.id).sort(), ['dormant', 'letsgo2trip', 'phuketdesk']);
  });

  test('a partner with no address is dropped rather than half-understood', () => {
    const broken = partners({ TRAVEL_PARTNERS: JSON.stringify([{ id: 'x' }, { name: 'no id', email: 'a@b.c' }]) });
    assert.equal(broken.length, 0);
  });

  test('malformed JSON degrades to "no partner", never to a 500', async () => {
    assert.deepEqual(partners({ TRAVEL_PARTNERS: '{{{not json' }), []);
    const { status, body } = await read(await worker.fetch(
      new Request('https://app.itsnum.com/api/travel/refer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify({ me: 'mem_guest0000000001', destination: 'Phuket' }),
      }),
      { ...env, TRAVEL_PARTNERS: '{{{not json' },
      ctx,
    ));
    assert.equal(status, 503);
    assert.equal(body.no_partner, true);
  });

  test('the specialist beats the generalist on its own destination', () => {
    assert.equal(routeFor(env, { product: 'hotel', dest: 'Phuket' }).id, 'phuketdesk');
    // …even though the generalist has ten times the priority. Specificity
    // first is what lets a catch-all sit in the config without stealing the
    // destinations a specialist was added for.
    assert.equal(routeFor(env, { product: 'hotel', dest: 'Lisbon' }).id, 'letsgo2trip');
  });

  test('a product the specialist does not sell goes to the generalist', () => {
    assert.equal(routeFor(env, { product: 'flight', dest: 'Phuket' }).id, 'letsgo2trip');
  });

  test('an inactive partner is never routed to, however high its priority', () => {
    assert.notEqual(routeFor(env, { product: 'flight', dest: 'Anywhere' })?.id, 'dormant');
  });

  test('a named partner that cannot serve the product is a miss, not a fallback', () => {
    // Silently rerouting a traveller's details to a company the operator did
    // not name is worse than answering "nobody".
    assert.equal(routeFor(env, { product: 'flight', partner_id: 'phuketdesk' }), null);
    assert.equal(routeFor(env, { product: 'hotel', partner_id: 'phuketdesk' }).id, 'phuketdesk');
    assert.equal(routeFor(env, { product: 'flight', partner_id: 'dormant' }), null);
  });

  test('no configuration at all routes nowhere and says so', async () => {
    assert.equal(routeFor({}, { product: 'flight' }), null);
    const { status, body } = await read(await worker.fetch(
      new Request('https://app.itsnum.com/api/travel/refer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify({ me: 'mem_guest0000000001', destination: 'Mars' }),
      }),
      { ...env, TRAVEL_PARTNERS: undefined },
      ctx,
    ));
    assert.equal(status, 503);
    assert.equal(body.error, LINES.no_partner);
  });

  test('commission is per partner and per product, and unagreed means null', () => {
    const lg = routeFor(env, { product: 'hotel', dest: 'Lisbon' });
    assert.equal(commissionBp(lg, 'hotel'), 1000);
    assert.equal(commissionBp(lg, 'flight'), 300);
    // Falls to the partner's own default, never to a number Num invented.
    assert.equal(commissionBp(lg, 'rail'), 300);
    assert.equal(commissionBp(routeFor(env, { product: 'transfer', dest: 'Phuket' }), 'transfer'), null);
  });
});

// ── 4 · the kill switch ────────────────────────────────────────────────────

describe('the kill switch', () => {
  test('defaults off, and off means the ask 503s with a sentence', async () => {
    const off = { ...env, TRAVEL_REFERRAL_ENABLED: undefined };
    const { status, body } = await read(await worker.fetch(
      new Request('https://app.itsnum.com/api/travel/refer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify({ me: 'mem_guest0000000001', destination: 'Phuket' }),
      }),
      off,
      ctx,
    ));
    assert.equal(status, 503);
    assert.equal(body.disabled, true);
    assert.equal(body.error, LINES.disabled);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM num_travel_referrals WHERE destination='Phuket' AND state='draft'").get().c, 0);
  });

  test('off means stop SENDING, never stop listening', async () => {
    // A signed quote link already lives in an agency's inbox. If pulling the
    // switch broke it, a member would wait forever on a quote the agency
    // believes it has sent.
    const { body } = await read(await refer({ destination: 'Lisbon' }));
    const row = rowOf(body.ref);
    const token = await _sign(env, row.id, 'quote');
    const res = await worker.fetch(
      new Request(`https://app.itsnum.com/api/travel/quote?ref=${body.ref}&t=${token}`, { headers: { 'CF-Connecting-IP': nextIp() } }),
      { ...env, TRAVEL_REFERRAL_ENABLED: undefined },
      ctx,
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /SEND THIS QUOTE/);
  });
});

// ── 5 · the state machine ──────────────────────────────────────────────────

describe('draft → sent → quoted → accepted → confirmed', () => {
  test('a referral is born sent, with the partner copied onto the row', async () => {
    mailbox.length = 0;
    const { status, body } = await read(await refer());
    assert.equal(status, 200);
    assert.equal(body.state, 'sent');
    assert.equal(body.partner, 'LetsGo2Trip');
    const row = rowOf(body.ref);
    assert.equal(row.state, 'sent');
    assert.ok(row.sent_at, 'sent_at was never stamped');
    // Copied, not referenced: changing the config next quarter must not
    // rewrite where last quarter's referrals went.
    assert.equal(row.partner_email, 'handoffs@example-agency.test');
    assert.equal(row.commission_bp, 300);
    assert.equal(mailbox.length, 1, 'the agency was not emailed');
    assert.equal(mailbox[0].to, 'handoffs@example-agency.test');
    assert.match(mailbox[0].subject, new RegExp(body.ref));
  });

  test('the quote link records the partner\'s own number and reference', async () => {
    const { body } = await read(await refer());
    const row = rowOf(body.ref);
    const token = await _sign(env, row.id, 'quote');
    const form = new URLSearchParams({ amount: '1740.50', currency: 'gbp', partner_ref: 'LG2T-88121', note: 'Emirates, 1 stop' });
    const res = await hit(`/api/travel/quote?ref=${body.ref}&t=${token}`, {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Quote received/);
    const after = rowOf(body.ref);
    assert.equal(after.state, 'quoted');
    assert.equal(after.quote_amount_cs, 174050);
    assert.equal(after.quote_currency, 'GBP');
    assert.equal(after.partner_ref, 'LG2T-88121');
    assert.ok(after.quoted_at);
  });

  test('a step cannot be skipped — accept before a quote changes nothing', async () => {
    const { body } = await read(await refer());
    const out = await read(await post('/api/travel/accept', { me: 'mem_guest0000000001', ref: body.ref }));
    assert.equal(out.body.changed, false);
    assert.equal(rowOf(body.ref).state, 'sent');
  });

  test('another member cannot accept your quote', async () => {
    const { body } = await read(await refer());
    const row = rowOf(body.ref);
    await hit(`/api/travel/quote?ref=${body.ref}&t=${await _sign(env, row.id, 'quote')}`, {
      method: 'POST', body: new URLSearchParams({ amount: '900' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const out = await read(await post('/api/travel/accept', { me: 'mem_guest0000000002', ref: body.ref }));
    assert.equal(out.status, 403);
    assert.equal(rowOf(body.ref).state, 'quoted');
  });

  test('confirming without the agency\'s own reference is refused', async () => {
    const { body } = await read(await refer());
    const out = await read(await admin('/api/travel/confirm', { ref: body.ref }));
    assert.equal(out.status, 400);
    assert.match(out.body.error, /reference/i);
  });

  test('the whole machine, one guarded step at a time', async () => {
    const { body } = await read(await refer({ product: 'hotel', destination: 'Phuket' }));
    // Phuket + hotel routes to the specialist, at the specialist's rate.
    assert.equal(body.partner, 'Phuket Desk');
    const row = rowOf(body.ref);
    assert.equal(row.commission_bp, 1400);

    await hit(`/api/travel/quote?ref=${body.ref}&t=${await _sign(env, row.id, 'quote')}`, {
      method: 'POST',
      body: new URLSearchParams({ amount: '2400', currency: 'usd', partner_ref: 'PD-5512' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(rowOf(body.ref).state, 'quoted');

    const accepted = await read(await post('/api/travel/accept', { me: 'mem_guest0000000001', ref: body.ref }));
    assert.equal(accepted.body.state, 'accepted');
    // The sentence this entire structure exists to be able to say.
    assert.match(accepted.body.note, /contact you directly to take payment/i);

    const done = await read(await admin('/api/travel/confirm', { ref: body.ref, partner_ref: 'PD-5512' }));
    assert.equal(done.body.state, 'confirmed');
    const final = rowOf(body.ref);
    assert.equal(final.state, 'confirmed');
    assert.equal(final.partner_ref, 'PD-5512');
    // 14% of $2,400.
    assert.equal(final.commission_expected_cs, 33600);
    assert.ok(final.confirmed_at);
  });

  test('a cancelled referral cannot be resurrected', async () => {
    const { body } = await read(await refer());
    await post('/api/travel/cancel', { me: 'mem_guest0000000001', ref: body.ref });
    assert.equal(rowOf(body.ref).state, 'cancelled');
    const row = rowOf(body.ref);
    const res = await hit(`/api/travel/quote?ref=${body.ref}&t=${await _sign(env, row.id, 'quote')}`, {
      method: 'POST', body: new URLSearchParams({ amount: '500' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.match(await res.text(), /Already answered/);
    assert.equal(rowOf(body.ref).state, 'cancelled');
  });

  test('the agency can decline, and the state machine says so honestly', async () => {
    const { body } = await read(await refer());
    const row = rowOf(body.ref);
    const res = await hit(`/api/travel/quote?ref=${body.ref}&v=declined&t=${await _sign(env, row.id, 'declined')}`);
    assert.equal(res.status, 200);
    assert.equal(rowOf(body.ref).state, 'declined');
  });

  test('every state has a plain-English line for the member', () => {
    for (const s of ['draft', 'sent', 'quoted', 'accepted', 'confirmed', 'declined', 'cancelled', 'expired']) {
      assert.ok(STATE_LINE[s], `${s} has no member-facing line`);
    }
  });
});

// ── 6 · the signed link ────────────────────────────────────────────────────

describe('the agency\'s link — the whole integration', () => {
  test('a forged token is refused', async () => {
    const { body } = await read(await refer());
    const res = await hit(`/api/travel/quote?ref=${body.ref}&t=${'0'.repeat(32)}`);
    assert.equal(res.status, 403);
    assert.equal(rowOf(body.ref).state, 'sent');
  });

  test('a quote token cannot decline, and a decline token cannot quote', async () => {
    const { body } = await read(await refer());
    const row = rowOf(body.ref);
    const quoteToken = await _sign(env, row.id, 'quote');
    // The same token, pointed at the other verdict.
    const res = await hit(`/api/travel/quote?ref=${body.ref}&v=declined&t=${quoteToken}`);
    assert.equal(res.status, 403);
    assert.equal(rowOf(body.ref).state, 'sent');
  });

  test('one referral\'s token cannot answer another referral', async () => {
    const a = (await read(await refer())).body;
    const b = (await read(await refer())).body;
    const aToken = await _sign(env, rowOf(a.ref).id, 'quote');
    const res = await hit(`/api/travel/quote?ref=${b.ref}&t=${aToken}`);
    assert.equal(res.status, 403);
    assert.equal(rowOf(b.ref).state, 'sent');
  });

  test('a bookdesk token cannot be replayed here', async () => {
    // Both modules HMAC with ADMIN_KEY. The namespace prefix is the only thing
    // keeping a restaurant's confirm link from answering a travel request.
    const { body } = await read(await refer());
    const id = rowOf(body.ref).id;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.ADMIN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`book:${id}:quote`));
    const bookToken = [...new Uint8Array(mac)].slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join('');
    const res = await hit(`/api/travel/quote?ref=${body.ref}&t=${bookToken}`);
    assert.equal(res.status, 403);
  });

  test('a replayed quote submission changes nothing the second time', async () => {
    const { body } = await read(await refer());
    const row = rowOf(body.ref);
    const token = await _sign(env, row.id, 'quote');
    const send = (amount) => hit(`/api/travel/quote?ref=${body.ref}&t=${token}`, {
      method: 'POST',
      body: new URLSearchParams({ amount, currency: 'usd', partner_ref: `X-${amount}` }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.match(await (await send('1000')).text(), /Quote received/);
    // Forwarded to a colleague, tapped twice, prefetched by a link previewer.
    const second = await send('9999');
    assert.match(await second.text(), /Already answered/);
    const after = rowOf(body.ref);
    assert.equal(after.quote_amount_cs, 100000, 'a replay overwrote the agreed quote');
    assert.equal(after.partner_ref, 'X-1000');
  });

  test('a quote with no price re-renders the form instead of storing a blank', async () => {
    const { body } = await read(await refer());
    const token = await _sign(env, rowOf(body.ref).id, 'quote');
    const res = await hit(`/api/travel/quote?ref=${body.ref}&t=${token}`, {
      method: 'POST', body: new URLSearchParams({ partner_ref: 'X' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /total price/i);
    assert.equal(rowOf(body.ref).state, 'sent');
  });
});

// ── 7 · the money ──────────────────────────────────────────────────────────

describe('commission — accrued once, reconciled, never doubled', () => {
  const drive = async (over = {}) => {
    const { body } = await read(await refer(over));
    const row = rowOf(body.ref);
    await hit(`/api/travel/quote?ref=${body.ref}&t=${await _sign(env, row.id, 'quote')}`, {
      method: 'POST',
      body: new URLSearchParams({ amount: '4000', currency: 'usd', partner_ref: `REF-${body.ref}` }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    await post('/api/travel/accept', { me: 'mem_guest0000000001', ref: body.ref });
    return body.ref;
  };

  test('accrues on confirmation, at the partner\'s rate, against the NUM- reference', async () => {
    const ref = await drive();
    await admin('/api/travel/confirm', { ref, partner_ref: 'LG2T-1' });
    const lines = commissionsFor(ref);
    assert.equal(lines.length, 1);
    // 3% of $4,000 — the flight rate on the row, not the $2 reservation flat.
    assert.equal(lines[0].amount_cs, 12000);
    assert.equal(lines[0].state, 'accrued');
    assert.equal(lines[0].source, 'travel_referral');
    assert.equal(lines[0].category, 'travel_flight');
  });

  test('a double tap does not double-accrue', async () => {
    const ref = await drive();
    const first = await read(await admin('/api/travel/confirm', { ref, partner_ref: 'LG2T-2' }));
    const second = await read(await admin('/api/travel/confirm', { ref, partner_ref: 'LG2T-2' }));
    assert.equal(first.body.changed, true);
    assert.equal(second.body.changed, false);
    assert.equal(commissionsFor(ref).length, 1, 'a second confirm wrote a second commission line');
    assert.equal(commissionsFor(ref)[0].amount_cs, 12000);
  });

  test('an unagreed rate accrues nothing rather than a number we invented', async () => {
    const ref = await drive({ product: 'transfer', destination: 'Phuket' });
    await admin('/api/travel/confirm', { ref, partner_ref: 'PD-T1' });
    assert.equal(rowOf(ref).state, 'confirmed');
    assert.equal(rowOf(ref).commission_expected_cs, null);
    assert.equal(commissionsFor(ref).length, 0, 'a rate nobody agreed became an invoice');
  });

  test('the ledger surfaces what is owed, and drops it when paid', async () => {
    const ref = await drive();
    await admin('/api/travel/confirm', { ref, partner_ref: 'LG2T-3' });
    const before = await read(await hit('/api/travel/ledger', { headers: { 'X-Admin-Key': 'test-admin-key' } }));
    assert.ok(before.body.unpaid.some((r) => r.ref === ref), 'a confirmed, unpaid referral is missing from the ledger');
    assert.ok(before.body.ledger_unpaid.some((r) => r.booking_id === ref));

    const paid = await read(await admin('/api/travel/commission', { ref, received_cs: 12000 }));
    assert.equal(paid.body.received_cs, 12000);
    assert.equal(paid.body.variance_cs, 0);

    const after = await read(await hit('/api/travel/ledger', { headers: { 'X-Admin-Key': 'test-admin-key' } }));
    assert.ok(!after.body.unpaid.some((r) => r.ref === ref), 'a settled referral is still being chased');
    assert.ok(!after.body.ledger_unpaid.some((r) => r.booking_id === ref));
  });

  test('recording the same payment twice does not double the receipt', async () => {
    const ref = await drive();
    await admin('/api/travel/confirm', { ref, partner_ref: 'LG2T-4' });
    await admin('/api/travel/commission', { ref, received_cs: 6000 });
    const twice = await read(await admin('/api/travel/commission', { ref, received_cs: 6000 }));
    assert.equal(twice.body.received_cs, 6000, 'the second entry added instead of replacing');
    // A short payment stays visible: half the money is still half the money.
    const led = await read(await hit('/api/travel/ledger', { headers: { 'X-Admin-Key': 'test-admin-key' } }));
    assert.ok(led.body.unpaid.some((r) => r.ref === ref), 'a half-paid referral fell off the chase list');
  });

  test('the ledger is admin-only', async () => {
    assert.equal((await read(await hit('/api/travel/ledger'))).status, 401);
    assert.equal((await read(await post('/api/travel/confirm', { ref: 'NUM-AAAAAA', partner_ref: 'x' }))).status, 401);
    assert.equal((await read(await post('/api/travel/log', { me: 'mem_guest0000000001' }))).status, 401);
  });
});

// ── 8 · the manual path — day one, no partner action at all ────────────────

describe('logging a referral by hand', () => {
  test('one call creates, quotes, accepts, confirms and accrues', async () => {
    const out = await read(await admin('/api/travel/log', {
      me: 'mem_guest0000000001',
      partner_id: 'letsgo2trip',
      product: 'package',
      origin: 'London',
      destination: 'Phuket',
      depart_on: '2026-09-04',
      return_on: '2026-09-11',
      adults: 2,
      state: 'confirmed',
      quote_amount_cs: 500000,
      quote_currency: 'GBP',
      partner_ref: 'LG2T-FIRST',
      notes: 'The first one, agreed on the phone.',
    }));
    assert.equal(out.status, 200);
    assert.equal(out.body.state, 'confirmed');
    const row = rowOf(out.body.ref);
    // Every stage it passed through is stamped, so reconciliation works on a
    // hand-logged referral exactly as it does on a clicked one.
    for (const stamp of ['sent_at', 'quoted_at', 'accepted_at', 'confirmed_at']) {
      assert.ok(row[stamp], `${stamp} was skipped by the manual path`);
    }
    // 12% of £5,000.
    assert.equal(row.commission_expected_cs, 60000);
    assert.equal(commissionsFor(out.body.ref).length, 1);
    assert.equal(commissionsFor(out.body.ref)[0].amount_cs, 60000);
  });

  test('a hand-logged confirmation still needs the agency\'s reference', async () => {
    const out = await read(await admin('/api/travel/log', {
      me: 'mem_guest0000000001', product: 'flight', destination: 'Lisbon', state: 'confirmed', quote_amount_cs: 1000,
    }));
    assert.equal(out.status, 400);
    assert.match(out.body.error, /partner_ref/);
  });

  test('the handoff text can be pasted into a shared inbox or WhatsApp', async () => {
    const { body } = await read(await refer());
    const out = await read(await hit(`/api/travel/handoff?ref=${body.ref}`, { headers: { 'X-Admin-Key': 'test-admin-key' } }));
    assert.equal(out.status, 200);
    assert.equal(out.body.to, 'handoffs@example-agency.test');
    assert.match(out.body.subject, new RegExp(body.ref));
    assert.match(out.body.text, /you collect payment directly from the traveller/i);
    assert.match(out.body.quote_link, /\/api\/travel\/quote\?ref=NUM-/);
  });
});

// ── 9 · the two rules that keep the bond at zero ───────────────────────────

describe('Num never takes the money and never quotes its own price', () => {
  test('every write route refuses a payment instrument outright', async () => {
    const bodies = [
      ['/api/travel/refer', { me: 'mem_guest0000000001', destination: 'Phuket', card_number: '4242424242424242' }],
      ['/api/travel/refer', { me: 'mem_guest0000000001', destination: 'Phuket', payment: { cvv: '123' } }],
      ['/api/travel/accept', { me: 'mem_guest0000000001', ref: 'NUM-AAAAAA', payment_method: 'pm_123' }],
      ['/api/travel/confirm', { ref: 'NUM-AAAAAA', partner_ref: 'x', stripe_customer: 'cus_1' }],
      ['/api/travel/log', { me: 'mem_guest0000000001', iban: 'GB33BUKB20201555555555' }],
    ];
    for (const [path, payload] of bodies) {
      const { status, body } = await read(await admin(path, payload));
      assert.equal(status, 422, `${path} accepted a payment instrument: ${JSON.stringify(body)}`);
      assert.equal(body.payment_refused, true);
      assert.match(body.error, /Num never takes a payment for travel/);
    }
  });

  test('the refusal happens before anything is written', () => {
    assert.equal(db.prepare("SELECT COUNT(*) c FROM num_travel_referrals WHERE notes LIKE '%4242%'").get().c, 0);
  });

  test('the schema has no column that could hold one', () => {
    const cols = db.prepare('PRAGMA table_info(num_travel_referrals)').all().map((c) => c.name);
    for (const col of cols) {
      assert.equal(PAYMENT_KEYS.test(col), false, `num_travel_referrals.${col} could hold a payment instrument`);
    }
  });

  test('no member-facing sentence claims Num booked, reserved or priced anything', () => {
    const said = [
      LINES.sent('Agency'), LINES.quoted('Agency'), LINES.accepted('Agency'),
      LINES.confirmed('Agency'), LINES.declined('Agency'), LINES.cancelled(),
      LINES.no_partner, LINES.disabled, ...Object.values(STATE_LINE),
    ];
    for (const line of said) {
      assert.equal(offendingClaim(line), null, `Num claims too much: "${line}"`);
    }
    // The guard itself has to work, or the assertion above proves nothing.
    assert.ok(FORBIDDEN_CLAIMS.test('I have booked your flight'));
    assert.ok(FORBIDDEN_CLAIMS.test('That is reserved for you'));
    assert.equal(offendingClaim('The agency will contact you to take payment.'), null);
  });

  test('the quote Num relays is the partner\'s number, in the partner\'s currency', async () => {
    const { body } = await read(await refer());
    const token = await _sign(env, rowOf(body.ref).id, 'quote');
    await hit(`/api/travel/quote?ref=${body.ref}&t=${token}`, {
      method: 'POST',
      body: new URLSearchParams({ amount: '1740.50', currency: 'thb', partner_ref: 'X-1' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const mine = await read(await hit('/api/travel/mine?me=mem_guest0000000001'));
    const shown = mine.body.referrals.find((r) => r.ref === body.ref);
    // Two separate fields. Num never combines them into a converted figure,
    // because a converted figure is a price Num computed.
    assert.equal(shown.quote_amount_cs, 174050);
    assert.equal(shown.quote_currency, 'THB');
    assert.equal(JSON.stringify(shown).includes('usd'), false);
  });

  test('the agency\'s own page states who collects the money', async () => {
    const { body } = await read(await refer());
    const token = await _sign(env, rowOf(body.ref).id, 'quote');
    const html = await (await hit(`/api/travel/quote?ref=${body.ref}&t=${token}`)).text();
    assert.match(html, /you take their payment and you issue the confirmation/i);
    assert.match(html, /Num does not hold traveller money/i);
  });

  test('the partner\'s email says it too, in both the HTML and the text part', async () => {
    mailbox.length = 0;
    await refer();
    const sent = mailbox.at(-1);
    assert.match(sent.html, /take the traveller's payment directly/i);
    // The text part is the SAME artefact an operator pastes into WhatsApp,
    // built by handoffText — not a stripped-down version of the HTML. Both
    // channels have to carry the sentence that does the legal work.
    assert.match(sent.text, /you collect payment directly from the traveller/i);
    assert.match(sent.text, /Num does not take the traveller's money/i);
    // The subject leads with the reference so a shared inbox can filter on it.
    assert.match(sent.subject, /NUM-[2-9A-HJ-NP-Z]{6}/);
  });

  test('the member\'s own list never leaks the agency\'s address', async () => {
    const mine = await read(await hit('/api/travel/mine?me=mem_guest0000000001'));
    assert.ok(mine.body.referrals.length > 0);
    assert.equal(JSON.stringify(mine.body).includes('@example-agency.test'), false);
  });
});

// ── 10 · the brain can choose it, and choosing sends nothing ───────────────

describe('the concierge can reach this, and emitting it sends nothing', () => {
  test('travel_referral is an action the model is allowed to emit', () => {
    const types = REPLY_SCHEMA.properties.actions.items.properties.type.enum;
    assert.ok(types.includes('travel_referral'), 'the brain has no way to choose a travel handoff');
  });

  test('the payload normalises into a draft the sheet can render', () => {
    const out = normalizeReply({
      reply: 'Ready to send.',
      card: null,
      chips: null,
      actions: [{
        type: 'travel_referral',
        payload: JSON.stringify({
          product: 'PACKAGE', origin: 'London', destination: 'Phuket',
          depart_on: '2026-09-04', return_on: '2026-09-11', adults: 2, children: 1,
          cabin: 'Economy', budget_cs: 500000, budget_currency: 'GBP', notes: 'Near the beach.',
        }),
      }],
    });
    assert.equal(out.actions.length, 1);
    assert.deepEqual(out.actions[0].referral, {
      product: 'package',
      origin: 'London',
      destination: 'Phuket',
      depart_on: '2026-09-04',
      return_on: '2026-09-11',
      adults: 2,
      children: 1,
      cabin: 'Economy',
      budget_cs: 500000,
      budget_currency: 'GBP',
      notes: 'Near the beach.',
      contact_email: null,
      contact_phone: null,
    });
  });

  test('a referral with no destination is dropped, not defaulted', () => {
    const out = normalizeReply({
      reply: '', card: null, chips: null,
      actions: [{ type: 'travel_referral', payload: JSON.stringify({ product: 'flight', adults: 2 }) }],
    });
    assert.equal(out.actions.length, 0, 'a trip to nowhere reached a travel agency');
  });

  test('a budget the model made up is not passed to the agency', () => {
    const out = normalizeReply({
      reply: '', card: null, chips: null,
      actions: [{ type: 'travel_referral', payload: JSON.stringify({ destination: 'Lisbon', budget_cs: 'about two grand' }) }],
    });
    assert.equal(out.actions[0].referral.budget_cs, null);
  });

  test('normalising an action emits NO email — the traveller taps SEND', async () => {
    mailbox.length = 0;
    normalizeReply({
      reply: '', card: null, chips: null,
      actions: [{ type: 'travel_referral', payload: JSON.stringify({ destination: 'Phuket' }) }],
    });
    assert.equal(mailbox.length, 0, 'emitting an action sent a real agency a real traveller');
  });
});

// ── 11 · the schema on disk and the schema in the Worker ───────────────────

test('the inlined SCHEMA and worker/migrations/0003_travel_referrals.sql have not drifted', async () => {
  const file = await readFile(new URL('./migrations/0003_travel_referrals.sql', import.meta.url), 'utf8');
  assert.deepEqual(statementsOf(SCHEMA), statementsOf(file));
});

test('the handoff document carries the reference, the itinerary and the deal', () => {
  const row = {
    ref: 'NUM-K7QP42', product: 'flight', origin: 'LHR', destination: 'HKT',
    depart_on: '2026-09-04', return_on: '2026-09-11', adults: 2, children: 1,
    cabin: 'Economy', budget_cs: 180000, budget_currency: 'GBP', notes: 'Aisle seats.',
    contact_name: 'Viv', contact_email: 'viv@example.test', contact_phone: '+447700900123',
  };
  const text = handoffText(row, { quoteLink: 'https://app.itsnum.com/api/travel/quote?ref=NUM-K7QP42&t=abc' });
  assert.match(text, /NUM-K7QP42/);
  assert.match(text, /LHR → HKT/);
  assert.match(text, /2 adults \+ 1 child/);
  assert.match(text, /1800\.00 GBP/);
  assert.match(text, /you collect payment directly from the traveller/i);
  assert.equal(offendingClaim(text), null);
  assert.match(handoffSubject(row), /^NUM-K7QP42 HKT 2026-09-04–2026-09-11 2 adults \+ 1 child$/);
});
