/**
 * THE ★100 → ★5 REBALANCE, AND THE LEDGER TRAP INSIDE IT.
 *
 * 16 Sep 2026. 94 accounts sat on exactly ★100 — one `welcome` move each,
 * reconciling to the balance exactly. Dre cut the welcome grant to ★5 and
 * asked for the people already in to be brought down with it.
 *
 * ── THE TRAP ─────────────────────────────────────────────────────────────
 *
 * The obvious way to book the reversal is a move of kind `adjustment`. It is
 * wrong, and it is wrong quietly.
 *
 * `spendable()` in starmembership.mjs does not track which Stars are which. It
 * splits a balance by ORIGIN: sum every move whose kind is NOT in PROMO_KINDS
 * (['welcome']) and call that the member's own money. An `adjustment` of -95
 * lands on the OWN side of that sum.
 *
 * For a member holding nothing but the grant it still comes out right, because
 * the sum is clamped at zero — which is exactly why this would have shipped.
 * The damage appears later: the first time that member BUYS Stars, the -95
 * nets against their purchase and they are told that 95 of the Stars they paid
 * for are promotional and cannot be spent on a membership.
 *
 * Booking the reversal as `welcome` keeps it on the side of the ledger the
 * Stars actually came from, and the arithmetic stays right at every later
 * balance. That is the whole reason this file exists.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spendable } from './starmembership.mjs';

const SQL = readFileSync(new URL('../scripts/rebalance-stars-2026-09-16.sql', import.meta.url), 'utf8');
/** The statements only — comments stripped, so prose can never satisfy a test. */
const CODE = SQL.replace(/^\s*--.*$/gm, '').trim();

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
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
});

const bal = (m) => db.prepare('SELECT stars FROM num_star_balances WHERE member_id=?').get(m)?.stars ?? null;
const ledger = (m) => db.prepare('SELECT COALESCE(SUM(delta),0) n FROM num_star_moves WHERE member_id=?').get(m).n;
const rebalance = () => db.exec(CODE);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER NOT NULL DEFAULT 0)');
  db.exec("CREATE TABLE num_star_moves (id TEXT PRIMARY KEY, member_id TEXT, delta INTEGER, kind TEXT, note TEXT, counterparty TEXT, created_at TEXT DEFAULT (datetime('now')))");
  env = { DB: d1(db) };
  // Three shapes that actually exist in production on 16 Sep 2026.
  for (const [id, stars] of [['mem_grant', 100], ['mem_nico', 600], ['mem_spent', 30]]) {
    db.exec(`INSERT INTO num_star_balances VALUES ('${id}', ${stars})`);
    db.exec(`INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('welcome_${id}','${id}',100,'welcome')`);
  }
  // Nico bought ★500 on top of his grant. He is the reason the trap matters.
  db.exec("INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('buy_nico','mem_nico',500,'purchase')");
  db.exec("INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('spend','mem_spent',-70,'receive')");
});

describe('the rebalance itself', () => {
  test('a member on exactly ★100 comes down to ★5', () => {
    rebalance();
    assert.equal(bal('mem_grant'), 5);
  });

  test('the balance still equals the sum of the moves', () => {
    // The invariant the whole Star system rests on. A balance edited without a
    // matching move is how the ledger drifted the first time.
    rebalance();
    assert.equal(bal('mem_grant'), ledger('mem_grant'));
  });

  test('NICO IS UNTOUCHED, with no hard-coded exception', () => {
    // He is on ★600, so `WHERE stars = 100` never reaches him. An exclusion
    // list would have been a thing to maintain and eventually get wrong.
    rebalance();
    assert.equal(bal('mem_nico'), 600);
    assert.ok(!/mem_8f6b|nico/i.test(CODE), 'a member id was hard-coded into the migration');
  });

  test('a balance that is not exactly ★100 is left alone', () => {
    rebalance();
    assert.equal(bal('mem_spent'), 30);
  });

  test('running it twice changes nothing the second time', () => {
    rebalance();
    const after = [bal('mem_grant'), ledger('mem_grant')];
    rebalance();
    rebalance();
    assert.deepEqual([bal('mem_grant'), ledger('mem_grant')], after);
  });
});

describe('THE TRAP: what the reversal does to spendable()', () => {
  test('a rebalanced member reports ★5 promotional and nothing spendable', async () => {
    rebalance();
    const w = await spendable(env, 'mem_grant');
    assert.equal(w.balance, 5);
    assert.equal(w.spendable, 0, 'a pure welcome balance can still spend nothing outward');
    assert.equal(w.promo_locked, 5, 'the lock must follow the balance down, not stay at 100');
  });

  test('THE ONE THAT CATCHES `adjustment`: Stars bought AFTER the rebalance are fully spendable', async () => {
    // Booked as `adjustment`, the -95 nets against this purchase and spendable
    // comes back 405 — 95 Stars this member paid real money for, refused.
    rebalance();
    db.exec("INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('buy_after','mem_grant',500,'purchase')");
    db.exec("UPDATE num_star_balances SET stars = 505 WHERE member_id='mem_grant'");

    const w = await spendable(env, 'mem_grant');
    assert.equal(w.balance, 505);
    assert.equal(w.spendable, 500, 'every Star they PAID for must be spendable — all 500 of them');
    assert.equal(w.promo_locked, 5);
  });

  test('the reversal is booked as `welcome`, and that is load-bearing', () => {
    // Asserted against the statements, never the explanation above them.
    assert.match(CODE, /'welcome'/, 'the reversal left the promotional side of the ledger');
    assert.ok(!/'adjustment'/.test(CODE), 'see this file’s header — `adjustment` breaks spendable()');
  });
});
