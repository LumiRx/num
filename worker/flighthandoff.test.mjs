/**
 * THE DEAD END AT THE END OF A FARE LIST.
 *
 * Before 13 Sep 2026 the fares tray could price a flight, re-check it live
 * against the airline, and then do nothing. The only rail that can actually
 * issue a ticket was reachable only as a link the model might mention in
 * prose. A traveller who found their flight had no next step.
 *
 * These tests pin the three things that make the fix safe rather than just
 * convenient: it refuses to exist the day Num can issue tickets itself, it
 * never returns a link without the fee sentence attached, and the referral
 * row is written before the link is handed over.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  disclosure, dollars, grossCs, handleFlightHandoff, handoffAvailable, parseRequest,
} from './flighthandoff.mjs';

let db; let env;
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

const post = (body) => new Request('https://app.itsnum.com/api/flights/handoff', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const GOOD = { fromCode: 'lax', toCode: 'JFK', depart: '2026-10-04', adults: 2, price: '224.20', currency: 'USD' };

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_travel_referrals (
    id TEXT PRIMARY KEY, ref TEXT, member_id TEXT, partner_id TEXT, partner_name TEXT, product TEXT,
    origin TEXT, destination TEXT, depart_on TEXT, return_on TEXT, adults INTEGER,
    state TEXT, commission_expected_cs INTEGER, sent_at TEXT)`);
  env = { DB: d1(db), LGT_PARTNER_ID: 'num' };
});

describe('it stops existing the day Num can issue a ticket', () => {
  test('a configured Sabre issuer switches the handoff off', () => {
    const issuing = { ...env, SABRE_BOOKING_ENABLED: 'true', SABRE_BOOKING_PATHS: '{"create":"/x"}' };
    assert.equal(handoffAvailable(issuing).available, false);
    assert.match(handoffAvailable(issuing).why, /issue this itself/i);
  });

  test('and the route agrees, without anyone editing the route', async () => {
    const issuing = { ...env, SABRE_BOOKING_ENABLED: 'true', SABRE_BOOKING_PATHS: '{"create":"/x"}' };
    const res = await handleFlightHandoff(post(GOOD), issuing);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.equal(body.url, undefined, 'no link may escape once we could have booked it ourselves');
  });

  test('refusing is a 200, because "no" is an answer and not a fault', async () => {
    // A 404 here would show up in the logs as a broken route every time the
    // client correctly asked whether the button should exist.
    const res = await handleFlightHandoff(post(GOOD), { DB: env.DB });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).available, false);
  });

  test('no partner configured is also a clean no', () => {
    assert.equal(handoffAvailable({}).available, false);
    assert.match(handoffAvailable({}).why, /partner/i);
  });

  test('available only when a partner exists and we cannot issue', () => {
    assert.equal(handoffAvailable(env).available, true);
  });
});

describe('the fee is never separated from the link', () => {
  test('every successful answer carries the sentence and the number', async () => {
    const res = await handleFlightHandoff(post(GOOD), env);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.ok(body.url.startsWith('https://'), body.url);
    assert.equal(body.fee_cs, 1500, 'the default belief about their checkout');
    assert.match(body.disclosure, /\$15/);
    assert.match(body.disclosure, /LetsGo2Trip issues the ticket/);
    assert.match(body.disclosure, /direct/i, 'the way out has to be offered too');
  });

  test('the fee comes from the server, so the app cannot drift from it', async () => {
    const res = await handleFlightHandoff(post(GOOD), { ...env, LGT_SURCHARGE_CS: '2500' });
    const body = await res.json();
    assert.equal(body.fee_cs, 2500);
    assert.match(body.disclosure, /\$25/);
  });

  test('a genuinely zero fee still says who they are buying from', () => {
    const d = disclosure({ LGT_SURCHARGE_CS: '0' });
    assert.match(d, /LetsGo2Trip issues the ticket/);
    assert.doesNotMatch(d, /\$0/, 'announcing a zero surcharge is noise, not disclosure');
  });

  test('whole dollars read as whole dollars', () => {
    assert.equal(dollars(1500), '$15');
    assert.equal(dollars(1550), '$15.50');
  });
});

describe('what it accepts', () => {
  test('airport codes are normalised, not rejected for case', () => {
    const q = parseRequest(GOOD);
    assert.equal(q.ok, true);
    assert.equal(q.from, 'LAX');
  });

  for (const [why, body] of [
    ['no origin', { toCode: 'JFK', depart: '2026-10-04' }],
    ['not an airport code', { fromCode: 'LOSANGELES', toCode: 'JFK', depart: '2026-10-04' }],
    ['same airport', { fromCode: 'LAX', toCode: 'LAX', depart: '2026-10-04' }],
    ['no date', { fromCode: 'LAX', toCode: 'JFK' }],
    ['a date that is not a date', { fromCode: 'LAX', toCode: 'JFK', depart: 'next tuesday' }],
  ]) {
    test(`refuses ${why}`, () => assert.equal(parseRequest(body).ok, false));
  }

  test('a silly passenger count falls back to one rather than failing', () => {
    assert.equal(parseRequest({ ...GOOD, adults: 400 }).adults, 1);
    assert.equal(parseRequest({ ...GOOD, adults: 0 }).adults, 1);
  });

  test('a bad request is a 400 and writes nothing', async () => {
    const res = await handleFlightHandoff(post({ fromCode: 'LAX' }), env);
    assert.equal(res.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_travel_referrals').get().n, 0);
  });

  test('GET is not a way to mint a referral', async () => {
    const res = await handleFlightHandoff(
      new Request('https://app.itsnum.com/api/flights/handoff'), env,
    );
    assert.equal(res.status, 405);
  });
});

describe('the referral row is written before the link is handed over', () => {
  test('one row, with the route on it', async () => {
    await handleFlightHandoff(post({ ...GOOD, me: 'mem_1', ret: '2026-10-11' }), env);
    const r = db.prepare('SELECT * FROM num_travel_referrals').get();
    assert.equal(r.product, 'flight');
    assert.equal(r.origin, 'LAX');
    assert.equal(r.destination, 'JFK');
    assert.equal(r.depart_on, '2026-10-04');
    assert.equal(r.return_on, '2026-10-11');
    assert.equal(r.adults, 2);
    assert.equal(r.member_id, 'mem_1');
    assert.equal(r.state, 'sent');
  });

  test('the ref in the row is the ref in the link', async () => {
    const body = await (await handleFlightHandoff(post(GOOD), env)).json();
    const r = db.prepare('SELECT ref FROM num_travel_referrals').get();
    assert.equal(r.ref, body.ref);
    assert.ok(body.url.includes(body.ref), 'a referral nobody can attribute is not a referral');
  });

  test('a signed-out traveller still gets the link', async () => {
    const body = await (await handleFlightHandoff(post(GOOD), env)).json();
    assert.equal(body.available, true);
    assert.equal(db.prepare('SELECT member_id m FROM num_travel_referrals').get().m, 'anon');
  });

  test('a database that is down costs a row, never the link', async () => {
    const broken = { LGT_PARTNER_ID: 'num', DB: { prepare: () => { throw new Error('gone'); } } };
    const body = await (await handleFlightHandoff(post(GOOD), broken)).json();
    assert.equal(body.available, true);
    assert.ok(body.url);
  });
});

describe('the commission expectation is never a guess', () => {
  test('a USD fare becomes cents', () => {
    assert.equal(grossCs('224.20', 'USD'), 22420);
    assert.equal(grossCs('1,240', 'USD'), 124000);
  });

  test('a non-USD fare is left null rather than mis-recorded', () => {
    // Writing a EUR number into a cents column marked USD puts a wrong
    // figure in a money table, which is worse than an empty one.
    assert.equal(grossCs('224.20', 'EUR'), null);
    assert.equal(grossCs('224.20', 'THB'), null);
  });

  test('nonsense is null, not zero', () => {
    for (const v of [null, undefined, '', 'ask us', '-5']) assert.equal(grossCs(v, 'USD'), null);
  });
});
