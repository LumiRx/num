/**
 * The stay record, tested at the two places it can cost real money.
 *
 *   1. A PAYMENT INSTRUMENT MUST NEVER LAND IN THE TABLE. NUM holding
 *      passenger money is what a zero-dollar seller-of-travel bond depends on
 *      (§17550.11). The refusal has to throw rather than strip, because a
 *      silently dropped field is one somebody later "fixes".
 *
 *   2. THE WALL HOLDS HERE TOO. liteapi.test.mjs proves the search payload
 *      carries no public price, saving or commission. A receipt is the other
 *      door into the same data, and what NUM earned is not a line on a guest's
 *      own receipt.
 *
 * Plus idempotency, which is not a nicety: a retried tap on one bar of signal
 * is the ordinary case and the cost of getting it wrong is a second room.
 *
 *   node --test worker/staybookings.test.mjs
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  refusePaymentFields, hold, confirm, fail, cancelled, forMember, auditFor, newClientReference,
} from './staybookings.mjs';

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
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
  batch: async (sts) => { for (const s of sts) await s.run(); return []; },
});

const QUERY = {
  checkin: '2026-10-01', checkout: '2026-10-04', adults: 2, rooms: 1,
  childrenAges: [7], guestNationality: 'GB',
};
const OPTION = {
  hotelId: 'lp1a2b3', hotel: 'The Caledonian', room: 'Deluxe Double', boardType: 'BI',
  currency: 'USD', total: 271.4, publicTotal: 312, payAtHotel: null,
  refundable: true, cancelBy: '2026-10-01T12:00:00',
};
const PRE = { prebookId: 'pb_77', transactionId: 'tx_77', currency: 'USD', total: 271.4, priceChanged: false };

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  env = { DB: d1(db) };
});

/* ── 1. the refusal ───────────────────────────────────────────────────── */

describe('a payment instrument is refused, not stripped', () => {
  for (const bad of [
    { card: '4111111111111111' },
    { cvv: '123' },
    { payment_method: 'pm_x' },
    { iban: 'GB33BUKB20201555555555' },
    { billing_address: '1 Princes St' },
    { holder: { cardholder: 'Dre Tester' } },
    { a: { b: { exp_month: '04' } } },
  ]) {
    test(`refuses ${Object.keys(bad)[0]}`, () => {
      assert.throws(() => refusePaymentFields(bad), /may not carry payment details/);
    });
  }

  test('a transactionId is a SESSION reference and passes — it cannot be charged', () => {
    assert.equal(refusePaymentFields({ transactionId: 'tx_77', prebookId: 'pb_77' }), true);
  });

  test('hold() refuses before it writes anything', async () => {
    await assert.rejects(
      () => hold(env, {
        memberId: 'm1', clientReference: newClientReference(), prebook: PRE, query: QUERY,
        option: { ...OPTION, card: '4111111111111111' },
      }),
      /payment details/,
    );
  });
});

/* ── 2. the life of a booking ─────────────────────────────────────────── */

describe('held → confirmed', () => {
  test('the row is written at PREBOOK, before anybody pays', async () => {
    const ref = newClientReference();
    const { id } = await hold(env, {
      memberId: 'm1', clientReference: ref, prebook: PRE, option: OPTION, query: QUERY,
      marginPct: 7, wasMemberRate: true,
    });
    const row = db.prepare('SELECT * FROM num_stay_bookings WHERE id = ?').get(id);
    assert.equal(row.status, 'held');
    assert.equal(row.member_id, 'm1');
    assert.equal(row.total_cs, 27140);
    assert.equal(row.public_total_cs, 31200, 'the public price must be captured now — the rate is gone in 20 minutes');
    assert.equal(row.margin_pct, 7);
    assert.equal(row.was_member_rate, 1);
    assert.equal(row.children_ages, '[7]', 'ages, not a count');
    assert.equal(row.refundable, 1);

    const ev = db.prepare('SELECT event FROM num_stay_events WHERE stay_id = ?').all(id).map((r) => r.event);
    assert.deepEqual(ev, ['held']);
  });

  test('a price that moved at prebook is on the record', async () => {
    const { id } = await hold(env, {
      memberId: 'm1', clientReference: newClientReference(), option: OPTION, query: QUERY,
      prebook: { ...PRE, priceChanged: true, priceDifference: 18.5 },
    });
    const ev = db.prepare('SELECT event, detail FROM num_stay_events WHERE stay_id = ?').all(id);
    assert.ok(ev.some((e) => e.event === 'price_moved'));
    assert.match(ev.find((e) => e.event === 'price_moved').detail, /18\.5/);
  });

  test('confirm records the code the front desk recognises', async () => {
    const { id } = await hold(env, {
      memberId: 'm1', clientReference: newClientReference(), prebook: PRE, option: OPTION, query: QUERY,
    });
    await confirm(env, id, {
      bookingId: 'bk_99', supplierBookingId: 'sup_1', hotelConfirmationCode: 'CAL-55231',
      total: 271.4, currency: 'USD',
    });
    const row = db.prepare('SELECT * FROM num_stay_bookings WHERE id = ?').get(id);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.hotel_confirmation_code, 'CAL-55231');
  });

  test("a failure keeps the SUPPLIER'S own words, which a guest can act on", async () => {
    const { id } = await hold(env, {
      memberId: 'm1', clientReference: newClientReference(), prebook: PRE, option: OPTION, query: QUERY,
    });
    await fail(env, id, 'Rate no longer available');
    const row = db.prepare('SELECT status FROM num_stay_bookings WHERE id = ?').get(id);
    assert.equal(row.status, 'failed');
    const ev = db.prepare("SELECT detail FROM num_stay_events WHERE stay_id = ? AND event='failed'").get(id);
    assert.match(ev.detail, /Rate no longer available/,
      '"booking failed" is something a guest has to ring somebody about');
  });

  test('cancelled is a state, not a delete — the row stays', async () => {
    const { id } = await hold(env, {
      memberId: 'm1', clientReference: newClientReference(), prebook: PRE, option: OPTION, query: QUERY,
    });
    await cancelled(env, id, { refund: 271.4 });
    assert.equal(db.prepare('SELECT status FROM num_stay_bookings WHERE id = ?').get(id).status, 'cancelled');
    assert.ok(db.prepare('SELECT 1 FROM num_stay_bookings WHERE id = ?').get(id));
  });
});

/* ── 3. idempotency ───────────────────────────────────────────────────── */

describe('one tap, one room', () => {
  test('the same client reference cannot be written twice', async () => {
    const ref = newClientReference();
    await hold(env, { memberId: 'm1', clientReference: ref, prebook: PRE, option: OPTION, query: QUERY });
    await assert.rejects(
      () => hold(env, { memberId: 'm1', clientReference: ref, prebook: PRE, option: OPTION, query: QUERY }),
      /UNIQUE|constraint/i,
      'the database has to enforce this — a caller remembering is not enough on one bar of signal',
    );
  });

  test('two different bookings are fine', async () => {
    await hold(env, { memberId: 'm1', clientReference: newClientReference(), prebook: PRE, option: OPTION, query: QUERY });
    await hold(env, { memberId: 'm1', clientReference: newClientReference(), prebook: PRE, option: OPTION, query: QUERY });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM num_stay_bookings').get().c, 2);
  });
});

/* ── 4. THE WALL, at the receipt ──────────────────────────────────────── */

describe('a guest receipt carries no margin', () => {
  test('forMember emits no public price, no margin, no member-rate flag', async () => {
    const { id } = await hold(env, {
      memberId: 'm1', clientReference: newClientReference(), prebook: PRE, option: OPTION,
      query: QUERY, marginPct: 7, wasMemberRate: true,
    });
    await confirm(env, id, { bookingId: 'bk_99', hotelConfirmationCode: 'CAL-55231' });

    const [receipt] = await forMember(env, 'm1');
    const blob = JSON.stringify(receipt);
    for (const leak of ['public_total', 'publicTotal', 'margin', 'was_member_rate', 'wasMemberRate', 'commission']) {
      assert.ok(!blob.includes(leak), `the receipt carries ${leak}`);
    }
    assert.equal(receipt.hotel, 'The Caledonian');
    assert.equal(receipt.total, 271.4);
    assert.equal(receipt.confirmationCode, 'CAL-55231');
    assert.equal(receipt.status, 'confirmed');
  });

  test('one member never sees another one’s stay', async () => {
    await hold(env, { memberId: 'm1', clientReference: newClientReference(), prebook: PRE, option: OPTION, query: QUERY });
    assert.equal((await forMember(env, 'm2')).length, 0);
  });

  test('the audit view DOES carry the margin — server side, for evidence', async () => {
    const { id } = await hold(env, {
      memberId: 'm1', clientReference: newClientReference(), prebook: PRE, option: OPTION,
      query: QUERY, marginPct: 7, wasMemberRate: true,
    });
    const audit = await auditFor(env, id);
    assert.equal(audit.booking.margin_pct, 7);
    assert.equal(audit.booking.public_total_cs, 31200);
    assert.ok(audit.events.length >= 1);
  });

  test('a failed read is NOT reported as "you have no bookings"', async () => {
    // The stub has to let ensure() through and fail only on the LIST read,
    // otherwise the test passes on a TypeError and proves nothing.
    const stmt = {
      bind: () => stmt,
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => null,
      all: async () => { throw new Error('D1 down'); },
    };
    const broken = { DB: { prepare: () => stmt } };
    await assert.rejects(() => forMember(broken, 'm1'), /D1 down/,
      'swallowing this renders as "no bookings" to somebody who has one');
  });
});
