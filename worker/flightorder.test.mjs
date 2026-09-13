/**
 * THE ENGINE THAT WAS NEVER CONNECTED TO ANYTHING.
 *
 * Dre, 13 Sep 2026: "lets wokr through the booking process for flights and
 * make sure it fully checks out . with email confirmatonis, and the
 * requirements to book a flight."
 *
 * What the audit found: all four parts existed and none of them touched.
 * flightbooking.mjs knew the eight facts and the three ways a trip dies at a
 * check-in desk. flightpay.mjs knew authorize → issue → capture with a void
 * on every failure. flightconfirm.mjs could build and send the e-ticket
 * email. NOTHING CALLED ANY OF THEM. `startBooking` had no caller. `deliver`
 * had no caller. The concierge read the open booking out of a field the
 * CLIENT posts, and nothing ever put one there.
 *
 * These tests drive the whole path — start, collect, refuse, issue, email —
 * against a real SQLite database and a fake issuer, with booking switched on
 * in the env. Production has it switched off; the first suite proves that
 * matters.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { STATE } from './flightbooking.mjs';
import {
  answerOrder, ensure, handleFlightOrder, issueOrder, newRef, openBookingFor, startOrder, view,
} from './flightorder.mjs';

let db; let env; let mailed;

const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const r = run(); return database.prepare(r.text).get(...r.args) ?? null; };
    st.all = async () => { const r = run(); return { results: database.prepare(r.text).all(...r.args) }; };
    st.run = async () => { const r = run(); const x = database.prepare(r.text).run(...r.args); return { meta: { changes: x.changes } }; };
    return st;
  },
});

/** A fare far enough out that a valid passport is still valid on the day. */
const DEPART = '2027-06-14';
const OFFER = {
  carrier: 'BA', flight_no: 'BA286', origin: 'SFO', dest: 'LHR',
  depart_date: DEPART, depart_time: '19:20', arrive_time: '13:40',
  cabin: 'Economy', currency: 'USD', price: 84200,
};

const PAX = {
  given_name: 'Andre', family_name: 'Darville', dob: '1988-04-02',
  nationality: 'US', passport_number: 'X1234567', passport_expiry: '2030-01-31',
};
const CONTACT = { email: 'andre@thatislumi.com', phone: '+13105550100' };

/** Booking ON. Every deployment today has this OFF — see the first suite. */
const bookingOn = () => ({
  DB: d1(db),
  SABRE_BOOKING_ENABLED: 'true',
  SABRE_BOOKING_PATHS: '{"create":"/v1/trip/orders","fulfill":"/v1/trip/orders/fulfill"}',
  STRIPE_SECRET_KEY: 'sk_test_x',
  MAIL_FROM: 'Num <info@itsnum.com>',
});

const fill = async (memberId = 'mem_1', extra = {}) => {
  for (const [k, v] of Object.entries({ ...PAX, ...extra })) {
    const out = await answerOrder(env, { memberId, key: k, value: v });
    assert.equal(out.ok, true, `${k}: ${out.message ?? out.error ?? ''}`);
  }
  for (const [k, v] of Object.entries(CONTACT)) {
    const out = await answerOrder(env, { memberId, key: k, value: v });
    assert.equal(out.ok, true, `${k}: ${out.message ?? out.error ?? ''}`);
  }
};

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_payments (
    id TEXT PRIMARY KEY, ref TEXT, member_id TEXT, amount_cs INTEGER, currency TEXT,
    intent_id TEXT, state TEXT, description TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE num_mail_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ok INTEGER, detail TEXT, at TEXT)`);
  mailed = [];
  env = bookingOn();
});

describe('it is switched off, and that is load-bearing', () => {
  test('the route refuses on a deployment that cannot issue', async () => {
    const res = await handleFlightOrder(
      new Request('https://app.itsnum.com/api/flights/order/start', {
        method: 'POST', body: JSON.stringify({ me: 'mem_1', offer: OFFER }),
      }),
      { DB: d1(db) },
      '/start',
    );
    const body = await res.json();
    assert.equal(body.available, false);
    // The point: it does not collect a passport number for a ticket it
    // cannot issue. Nothing is written and nothing is asked.
    assert.equal(body.order, undefined);
  });

  test('the concierge is told about no booking at all', async () => {
    await ensure(env);
    await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    assert.equal(await openBookingFor({ DB: d1(db) }, 'mem_1'), null);
    assert.ok(await openBookingFor(env, 'mem_1'), 'and does see it once booking is on');
  });

  test('issuing refuses before it touches money', async () => {
    await ensure(env);
    await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    await fill();
    const out = await issueOrder({ DB: d1(db) }, { memberId: 'mem_1' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'booking_off');
  });
});

describe('the booking is the server\'s, not the client\'s', () => {
  test('a passport number never comes back to the app', async () => {
    await ensure(env);
    await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    await fill();
    const row = await db.prepare('SELECT booking FROM num_flight_orders').get();
    assert.match(row.booking, /X1234567/, 'it is stored, obviously');

    const res = await handleFlightOrder(
      new Request('https://app.itsnum.com/api/flights/order?me=mem_1'), env, '/',
    );
    const body = JSON.stringify(await res.json());
    assert.doesNotMatch(body, /X1234567/, 'the passport number must not travel back to the client');
    assert.doesNotMatch(body, /1988-04-02/, 'nor the date of birth');
  });

  test('the view carries the question, never the answers', async () => {
    await ensure(env);
    const { order } = await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    assert.ok(order.next.ask, 'there is something to ask');
    assert.equal(order.next.value, undefined);
    assert.equal(order.collected, 0);
    assert.equal(order.total > 0, true);
  });

  test('a second start returns the first order rather than making two', async () => {
    await ensure(env);
    const a = await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    const b = await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    assert.equal(b.reused, true);
    assert.equal(a.order.ref, b.order.ref);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_flight_orders').get().n, 1);
  });

  test('two members do not share a booking', async () => {
    await ensure(env);
    const a = await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    const b = await startOrder(env, { memberId: 'mem_2', offer: OFFER });
    assert.notEqual(a.order.ref, b.order.ref);
  });

  test('refs are unique', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newRef()));
    assert.equal(seen.size, 200);
  });
});

describe('one question at a time, and it validates', () => {
  beforeEach(async () => {
    await ensure(env);
    await startOrder(env, { memberId: 'mem_1', offer: OFFER });
  });

  test('the first thing asked is answerable from memory, not from a document', async () => {
    const res = await handleFlightOrder(
      new Request('https://app.itsnum.com/api/flights/order?me=mem_1'), env, '/',
    );
    const { order } = await res.json();
    assert.equal(order.next.key, 'given_name');
  });

  test('answering advances the count', async () => {
    const out = await answerOrder(env, { memberId: 'mem_1', key: 'given_name', value: 'Andre' });
    assert.equal(out.ok, true);
    assert.equal(out.order.collected, 1);
    assert.notEqual(out.order.next.key, 'given_name');
  });

  test('a field Num does not collect is refused, not silently stored', async () => {
    const out = await answerOrder(env, { memberId: 'mem_1', key: 'mothers_maiden_name', value: 'x' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'invalid');
  });

  test('an invalid answer leaves the record exactly as it was', async () => {
    await answerOrder(env, { memberId: 'mem_1', key: 'given_name', value: 'Andre' });
    const before = db.prepare('SELECT booking FROM num_flight_orders').get().booking;
    const out = await answerOrder(env, { memberId: 'mem_1', key: 'dob', value: 'sometime in the eighties' });
    assert.equal(out.ok, false);
    assert.equal(db.prepare('SELECT booking FROM num_flight_orders').get().booking, before);
  });

  test('answering with no open booking is an honest no', async () => {
    const out = await answerOrder(env, { memberId: 'nobody', key: 'given_name', value: 'X' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'no_open_booking');
  });

  test('the order is ready only once everything is in', async () => {
    await fill();
    const row = await db.prepare('SELECT * FROM num_flight_orders').get();
    assert.equal(view(row).ready, true);
    assert.equal(row.state, STATE.READY);
  });
});

describe('the checks that stop somebody being turned away at a desk', () => {
  beforeEach(async () => {
    await ensure(env);
    await startOrder(env, { memberId: 'mem_1', offer: OFFER });
  });

  test('a passport expiring inside six months BLOCKS the sale', async () => {
    // Flying 14 Jun 2027 on a passport that dies 1 Aug 2027. The airline is
    // fined for carrying someone who will be refused entry, so it refuses at
    // check-in. This is the single most common denied boarding there is.
    await fill('mem_1', { passport_expiry: '2027-08-01' });
    const row = db.prepare('SELECT * FROM num_flight_orders').get();
    const v = view(row);
    assert.equal(v.ready, false);
    assert.ok(v.blocking.length, 'the traveller must be told before they pay');
    assert.match(v.blocking.join(' '), /passport/i);

    const out = await issueOrder(env, { memberId: 'mem_1' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'preflight');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_payments').get().n, 0, 'no money was touched');
  });

  test('an incomplete booking cannot be issued and says what is missing', async () => {
    await answerOrder(env, { memberId: 'mem_1', key: 'given_name', value: 'Andre' });
    const out = await issueOrder(env, { memberId: 'mem_1' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'incomplete');
    assert.ok(out.missing?.length);
  });
});

describe('issuing, paying, and the email that had no caller', () => {
  let calls;
  const ISSUED = {
    ok: true, reference: 'ABC123', real: true, issued_at: '2026-09-13T04:00:00Z',
    tickets: [{ number: '125-1234567890' }],
  };

  /**
   * The three collaborators, recorded rather than mocked at the module level.
   * Each one's own behaviour is covered by its own tests; what is under test
   * here is the WIRING — that issue is reached through purchase, that deliver
   * is reached after capture and not before, and that the row ends up right.
   */
  const fakes = (over = {}) => ({
    purchase: async (e, booking, opts) => {
      calls.push(['purchase', opts.ref]);
      const iss = await opts.issueFn();
      calls.push(['issued', iss.reference]);
      return over.purchase
        ? over.purchase(iss)
        : { ok: true, issued: iss, intentId: 'pi_1', captured_cs: 84200, amount: { currency: 'usd' } };
    },
    issue: async () => (over.issue ? over.issue() : ISSUED),
    deliver: async (e, booking, iss) => {
      calls.push(['deliver', iss.reference, booking.state]);
      return over.deliver ? over.deliver() : { email: { ok: true }, sms: null, itinerary: {} };
    },
    alert: async (e, text) => { calls.push(['alert', text]); return { ok: true }; },
  });

  beforeEach(async () => {
    calls = [];
    await ensure(env);
    await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    await fill();
  });

  test('the whole path runs in order, and the email is finally sent', async () => {
    const out = await issueOrder(env, { memberId: 'mem_1', deps: fakes() });
    assert.equal(out.ok, true);
    assert.equal(out.pnr, 'ABC123');
    assert.equal(out.confirmation.email, true);
    assert.deepEqual(calls.map((c) => c[0]), ['purchase', 'issued', 'deliver']);
  });

  test('the confirmation goes out AFTER the ticket exists, never before', async () => {
    await issueOrder(env, { memberId: 'mem_1', deps: fakes() });
    const deliver = calls.find((c) => c[0] === 'deliver');
    assert.equal(deliver[1], 'ABC123', 'it is told the real reference');
    assert.equal(deliver[2], 'issued', 'and the booking it is handed says issued');
  });

  test('the row records the PNR, what was captured, and in which currency', async () => {
    await issueOrder(env, { memberId: 'mem_1', deps: fakes() });
    const row = db.prepare('SELECT * FROM num_flight_orders').get();
    assert.equal(row.state, 'issued');
    assert.equal(row.pnr, 'ABC123');
    assert.equal(row.total_cs, 84200);
    assert.equal(row.currency, 'usd');
    assert.equal(row.intent_id, 'pi_1');
  });

  test('an issued booking is no longer the open one', async () => {
    await issueOrder(env, { memberId: 'mem_1', deps: fakes() });
    assert.equal(await openBookingFor(env, 'mem_1'), null);
    const second = await startOrder(env, { memberId: 'mem_1', offer: OFFER });
    assert.equal(second.reused, false, 'they can book another flight');
  });

  test('a bounced confirmation does NOT fail a paid booking', async () => {
    // They have paid and they hold a PNR. Telling them the flight did not
    // happen because an email bounced is the wrong end of the problem.
    const out = await issueOrder(env, {
      memberId: 'mem_1',
      deps: fakes({ deliver: () => { throw new Error('resend down'); } }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.pnr, 'ABC123');
    assert.equal(out.confirmation.email, false, 'but it is reported honestly');
    assert.equal(db.prepare('SELECT state s FROM num_flight_orders').get().s, 'issued');
  });

  test('a failed issue marks the order failed and sends no confirmation', async () => {
    const out = await issueOrder(env, {
      memberId: 'mem_1',
      deps: fakes({ purchase: () => ({ ok: false, stage: 'issue', error: 'issue_failed', voided: true }) }),
    });
    assert.equal(out.ok, false);
    assert.equal(db.prepare('SELECT state s FROM num_flight_orders').get().s, 'failed');
    assert.equal(calls.some((c) => c[0] === 'deliver'), false, 'nobody is emailed an e-ticket that does not exist');
  });

  test('TICKET ISSUED, PAYMENT FAILED stays open, keeps the PNR, and shouts', async () => {
    // The one case that must never be marked failed: marking it failed
    // invites a retry, and a retry issues a SECOND ticket. It stays in
    // ISSUING with the PNR recorded, and a human is woken.
    const out = await issueOrder(env, {
      memberId: 'mem_1',
      deps: fakes({
        purchase: (iss) => ({
          ok: false, stage: 'capture', needsHuman: true, issued: iss, intentId: 'pi_1',
          message: 'The ticket issued but the payment did not complete.',
        }),
      }),
    });
    assert.equal(out.ok, false);
    const row = db.prepare('SELECT * FROM num_flight_orders').get();
    assert.equal(row.state, 'issuing', 'NOT failed — failed invites a second ticket');
    assert.equal(row.pnr, 'ABC123', 'the ticket that exists is written down');
    const shout = calls.find((c) => c[0] === 'alert');
    assert.ok(shout, 'a human has to hear about this within the hour');
    assert.match(shout[1], /ABC123/);
    assert.match(shout[1], /do not cancel the hold/i);
  });

  test('issuing twice cannot produce two tickets', async () => {
    // The guard is the ISSUING state: the first call sets it before it
    // touches money, and the second refuses on sight.
    db.prepare("UPDATE num_flight_orders SET state = 'issuing'").run();
    const out = await issueOrder(env, { memberId: 'mem_1', deps: fakes() });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'in_flight');
    assert.equal(calls.length, 0, 'and it does not reach the payment processor at all');
  });

  test('a booking being issued cannot have its details changed underneath it', async () => {
    db.prepare("UPDATE num_flight_orders SET state = 'issuing'").run();
    const out = await answerOrder(env, { memberId: 'mem_1', key: 'family_name', value: 'Somebodyelse' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'locked');
  });

  test('the confirmation carries what a person actually needs at a desk', async () => {
    const { confirmations } = await import('./flightconfirm.mjs');
    const booking = JSON.parse(db.prepare('SELECT booking FROM num_flight_orders').get().booking);
    const out = confirmations(booking, ISSUED);
    assert.equal(out.email.to, CONTACT.email, 'the address they gave, not the account address');
    assert.match(out.email.subject, /ABC123/, 'the reference is what people search their inbox for');
    assert.match(out.email.text, /SFO/);
    assert.match(out.email.text, /LHR/);
    assert.match(out.email.text, /ANDRE DARVILLE/, 'the name as printed on the passport');
    assert.match(out.email.text, /BA286/);
  });
});

describe('what the app is allowed to ask for', () => {
  test('an unsigned-in request is refused before anything is read', async () => {
    const res = await handleFlightOrder(
      new Request('https://app.itsnum.com/api/flights/order/start', {
        method: 'POST', body: JSON.stringify({ offer: OFFER }),
      }),
      env, '/start',
    );
    assert.equal(res.status, 401);
  });

  test('starting with no fare is a 400', async () => {
    const res = await handleFlightOrder(
      new Request('https://app.itsnum.com/api/flights/order/start', {
        method: 'POST', body: JSON.stringify({ me: 'mem_1' }),
      }),
      env, '/start',
    );
    assert.equal(res.status, 400);
  });

  test('a silly seat count falls back to one rather than booking nine', async () => {
    await ensure(env);
    const res = await handleFlightOrder(
      new Request('https://app.itsnum.com/api/flights/order/start', {
        method: 'POST', body: JSON.stringify({ me: 'mem_1', offer: OFFER, seats: 400 }),
      }),
      env, '/start',
    );
    const { order } = await res.json();
    assert.equal(order.passengers, 1);
  });

  test('an unknown sub-path 404s rather than doing something surprising', async () => {
    const res = await handleFlightOrder(
      new Request('https://app.itsnum.com/api/flights/order/cancel', { method: 'POST', body: '{"me":"mem_1"}' }),
      env, '/cancel',
    );
    assert.equal(res.status, 404);
  });
});
