// The partner handoff reference and the settlement feed it makes possible.
//
// This is the counter we sent LetsGo2Trip on their term 6 (a 30-day last-click
// cookie), and the machinery behind the condition we attached to term 7
// (deductions as a closed list, with the working shown per booking). It is
// worth testing hard because both are now commercial commitments, not
// preferences — and because every failure mode here is silent: a reference
// that does not verify, a settlement applied twice, or a deduction quietly
// absorbed all look exactly like nothing happening.
//
// Real SQLite, real schema, real HMACs. Nothing is stubbed.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mintHandoff, verifyHandoffRef, withHandoffRef, applySettlement, ledgerFor,
  DEDUCTIONS, SETTLEMENT_STATES, _resetForTests,
} from './handoff.mjs';

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
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
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

let db, env;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  env = { DB: d1(db), ADMIN_KEY: 'test-admin-key' };
  _resetForTests();
});

const mint = (over = {}) => mintHandoff(env, {
  partnerId: 'letsgo2trip', memberId: 'mem_1', product: 'flight',
  dest: 'phuket', targetHost: 'letsgo2trip.com', ...over,
});

const settle = (ref, over = {}) => applySettlement(env, 'letsgo2trip', {
  num_ref: ref,
  partner_ref: 'LG2T-88121',
  status: 'confirmed',
  currency: 'THB',
  gross_cs: 100_000,
  deductions: { tax_cs: 30_000, surcharge_cs: 8_000, gds_cs: 1_500, gateway_cs: 2_500 },
  net_cs: 58_000,
  commission_cs: 4_060,
  ...over,
});

describe('the reference itself', () => {
  test('mints as id.signature and records that we issued it', async () => {
    const { ref, id, reason } = await mint();
    assert.equal(reason, 'ok');
    assert.equal(ref, `${id}.${ref.split('.')[1]}`);
    assert.match(ref, /^[a-z0-9]{8,40}\.[0-9a-f]{32}$/);
    const row = db.prepare('SELECT * FROM num_handoffs WHERE id=?').get(id);
    assert.equal(row.partner_id, 'letsgo2trip');
    assert.equal(row.state, 'issued');
    assert.equal(row.product, 'flight');
    assert.ok(row.issued_at > 0);
  });

  test('verifies a reference we minted', async () => {
    const { ref, id } = await mint();
    assert.deepEqual(await verifyHandoffRef(env, ref), { ok: true, id, reason: 'ok' });
  });

  test('refuses an invented or tampered reference', async () => {
    const { ref, id } = await mint();
    const [, mac] = ref.split('.');
    for (const [bad, why] of [
      ['', 'malformed'],
      ['nodothere', 'malformed'],
      [`${id}.`, 'malformed'],
      [`${id}.deadbeef`, 'malformed'],
      [`${id}.${'0'.repeat(32)}`, 'bad_signature'],
      [`${'z'.repeat(24)}.${mac}`, 'bad_signature'],
    ]) {
      const v = await verifyHandoffRef(env, bad);
      assert.equal(v.ok, false, `accepted ${JSON.stringify(bad)}`);
      assert.equal(v.reason, why, `wrong reason for ${JSON.stringify(bad)}`);
    }
  });

  test('a reference signed with a different key does not verify', async () => {
    const { ref } = await mint();
    const other = await verifyHandoffRef({ ADMIN_KEY: 'someone-elses-key' }, ref);
    assert.equal(other.ok, false);
    assert.equal(other.reason, 'bad_signature');
  });

  test('carries nothing about the traveller', async () => {
    // The parameter travels through a third party's URL bar, access logs,
    // analytics and referrer headers. Everything about the person stays in
    // our row, keyed by the id.
    const { ref } = await mint({ memberId: 'mem_secret_person', dest: 'phuket' });
    assert.ok(!ref.includes('mem_'), 'the member id is in the reference');
    assert.ok(!ref.includes('phuket'), 'the destination is in the reference');
    assert.ok(!/[+@]/.test(ref));
  });

  test('two mints never collide', async () => {
    const refs = new Set();
    for (let i = 0; i < 50; i++) refs.add((await mint()).ref);
    assert.equal(refs.size, 50);
  });

  test('a link still works when the database is gone', async () => {
    // An unrecorded handoff is a revenue problem. A missing link is a product
    // problem, and the product problem is worse.
    const { ref, reason } = await mintHandoff({ ADMIN_KEY: 'test-admin-key' }, { partnerId: 'letsgo2trip' });
    assert.equal(reason, 'not_recorded');
    assert.match(ref, /^[a-z0-9]+\.[0-9a-f]{32}$/);
    assert.equal((await verifyHandoffRef({ ADMIN_KEY: 'test-admin-key' }, ref)).ok, true);
  });

  test('no partner, no reference', async () => {
    assert.deepEqual(await mintHandoff(env, {}), { ref: null, id: null, reason: 'no_partner' });
  });
});

describe('attaching it to the partner link', () => {
  test('preserves the partner’s own encoding byte for byte', async () => {
    const url = 'https://letsgo2trip.com/checkout?trip[from]=HKT&trip[to]=BKK&depart=2026-09-01%2008%3A00';
    const out = withHandoffRef(url, 'abc.def');
    assert.equal(out, `${url}&num_ref=abc.def`);
    assert.ok(out.startsWith(url));
  });

  test('handles a bare URL and a fragment', () => {
    assert.equal(withHandoffRef('https://x.test/c', 'r'), 'https://x.test/c?num_ref=r');
    assert.equal(withHandoffRef('https://x.test/c?a=1#step2', 'r'), 'https://x.test/c?a=1&num_ref=r#step2');
  });

  test('no reference means the link is returned untouched', () => {
    assert.equal(withHandoffRef('https://x.test/c', null), 'https://x.test/c');
  });
});

describe('settlement', () => {
  test('a clean row settles and the arithmetic closes', async () => {
    const { ref, id } = await mint();
    const r = await settle(ref);
    assert.deepEqual(r, { num_ref: ref, accepted: true, state: 'confirmed', arithmetic_ok: true });
    const row = db.prepare('SELECT * FROM num_handoffs WHERE id=?').get(id);
    assert.equal(row.state, 'confirmed');
    assert.equal(row.partner_ref, 'LG2T-88121');
    assert.equal(row.commission_cs, 4060);
    assert.equal(row.arithmetic_ok, 1);
    // Each deduction stored under its own name — term 7's "show the working".
    assert.equal(row.tax_cs, 30000);
    assert.equal(row.gds_cs, 1500);
  });

  test('a row that does not add up is STORED and flagged, never dropped', async () => {
    // A bookkeeping dispute must not lose the booking. Both sides see it the
    // same day instead of at the end of the quarter.
    const { ref, id } = await mint();
    const r = await settle(ref, { net_cs: 40_000 });
    assert.equal(r.accepted, true);
    assert.equal(r.arithmetic_ok, false);
    assert.equal(db.prepare('SELECT arithmetic_ok FROM num_handoffs WHERE id=?').get(id).arithmetic_ok, 0);
  });

  test('a one-unit rounding difference is not a dispute', async () => {
    const { ref } = await mint();
    assert.equal((await settle(ref, { net_cs: 58_001 })).arithmetic_ok, true);
  });

  test('a deduction nobody agreed to is REFUSED, not absorbed', async () => {
    // This is the difference between a contract term and a sentence in an
    // email. DEDUCTIONS is the closed list from term 7.
    const { ref, id } = await mint();
    const r = await settle(ref, {
      deductions: { tax_cs: 30_000, service_fee_cs: 5_000 },
    });
    assert.equal(r.accepted, false);
    assert.match(r.reason, /^undeclared_deduction:service_fee_cs$/);
    assert.equal(db.prepare('SELECT state FROM num_handoffs WHERE id=?').get(id).state, 'issued',
      'a refused row must leave the handoff untouched');
  });

  test('the agreed deductions are exactly the four in the contract', () => {
    assert.deepEqual([...DEDUCTIONS], ['tax_cs', 'surcharge_cs', 'gds_cs', 'gateway_cs']);
    assert.deepEqual([...SETTLEMENT_STATES], ['confirmed', 'cancelled', 'refunded']);
  });

  test('an unknown status is refused', async () => {
    const { ref } = await mint();
    assert.equal((await settle(ref, { status: 'ticketed' })).reason, 'unknown_status');
  });

  test('cancelled and refunded settle too', async () => {
    for (const status of ['cancelled', 'refunded']) {
      _resetForTests();
      db = new DatabaseSync(':memory:');
      env = { DB: d1(db), ADMIN_KEY: 'test-admin-key' };
      const { ref } = await mint();
      assert.equal((await settle(ref, { status })).state, status);
    }
  });

  test('applying the same row twice does not pay twice', async () => {
    // At-least-once delivery is a property of the universe, not of the
    // partner. A retried file must change nothing.
    const { ref, id } = await mint();
    assert.equal((await settle(ref)).accepted, true);
    const again = await settle(ref, { commission_cs: 999_999 });
    assert.equal(again.accepted, false);
    assert.equal(again.reason, 'already_settled');
    assert.equal(db.prepare('SELECT commission_cs FROM num_handoffs WHERE id=?').get(id).commission_cs, 4060);
  });

  test('another partner cannot settle our handoff, and is told so plainly', async () => {
    const { ref } = await mint();
    const r = await applySettlement(env, 'someone-else', { num_ref: ref, status: 'confirmed' });
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'wrong_partner', 'reported as a duplicate would hide a real problem');
  });

  test('a validly-signed reference we never issued is unknown, not accepted', async () => {
    const { ref } = await mint();
    db.prepare('DELETE FROM num_handoffs').run();
    assert.equal((await settle(ref)).reason, 'unknown_reference');
  });

  test('a forged reference never reaches the database', async () => {
    const r = await applySettlement(env, 'letsgo2trip', { num_ref: 'aaaaaaaa.' + '0'.repeat(32), status: 'confirmed' });
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'bad_signature');
  });
});

describe('the shared ledger view', () => {
  test('totals only what was confirmed, and counts what did not add up', async () => {
    const a = await mint(); const b = await mint(); const c = await mint();
    await settle(a.ref);
    await settle(b.ref, { net_cs: 1 });                      // arithmetic fails
    await settle(c.ref, { status: 'cancelled', gross_cs: 500_000, net_cs: 500_000,
      deductions: {}, commission_cs: 0 });                   // not confirmed

    const { rows, totals } = await ledgerFor(env, 'letsgo2trip');
    assert.equal(rows.length, 3);
    assert.equal(totals.handoffs, 3);
    assert.equal(totals.confirmed, 2);
    assert.equal(totals.commission_cs, 4060 * 2);
    assert.equal(totals.disputed, 1);
    // The cancelled booking's gross must not inflate the confirmed total.
    assert.equal(totals.gross_cs, 200_000);
  });

  test('one partner never sees another’s rows', async () => {
    await mint();
    await mintHandoff(env, { partnerId: 'other-agency', product: 'hotel' });
    assert.equal((await ledgerFor(env, 'letsgo2trip')).rows.length, 1);
    assert.equal((await ledgerFor(env, 'other-agency')).rows.length, 1);
  });

  test('an unissued handoff still appears, so the denominator is honest', async () => {
    await mint();
    const { rows, totals } = await ledgerFor(env, 'letsgo2trip');
    assert.equal(rows[0].state, 'issued');
    assert.equal(totals.handoffs, 1);
    assert.equal(totals.confirmed, 0);
  });
});
