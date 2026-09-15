/**
 * The welcome grant — recorded AND actually credited.
 *
 * On 13 Sep 2026 Num took its first real payment: $150 for ★500. Four seconds
 * later `ensureBalance` wrote that member a +100 welcome move and changed his
 * balance by nothing. He had paid, so a balance row already existed, and the
 * grant was applied with:
 *
 *     INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?, 100)
 *
 * OR IGNORE on an existing row is a silent no-op — the same family as
 * CREATE TABLE IF NOT EXISTS against a table that is already there. The move
 * row and the balance row were guarded on DIFFERENT KEYS, so the ledger said
 * 600 and the balance said 500. Six accounts were out by 740 Stars.
 *
 * These tests fail if that shape ever returns. The invariant is not "the
 * welcome grant works" — it is "the balance always equals the sum of the
 * moves", which is the only property that makes a Star balance defensible.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureBalance } from './social.mjs';

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

const balance = (m) => db.prepare(`SELECT stars FROM num_star_balances WHERE member_id=?`).get(m)?.stars ?? null;
const moves = (m) => db.prepare(`SELECT COALESCE(SUM(delta),0) n FROM num_star_moves WHERE member_id=?`).get(m).n;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE num_star_moves (id TEXT PRIMARY KEY, member_id TEXT, delta INTEGER, kind TEXT, note TEXT, counterparty TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  env = { DB: d1(db) };
});

describe('the welcome grant', () => {
  test('a brand-new member is credited', async () => {
    await ensureBalance(env, 'mem_new');
    assert.equal(balance('mem_new'), 100);
    assert.equal(moves('mem_new'), 100);
  });

  test('THE BUG: a member who paid first is still credited', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_paid', 500)`);
    db.exec(`INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('buy','mem_paid',500,'purchase')`);
    await ensureBalance(env, 'mem_paid');
    assert.equal(moves('mem_paid'), 600, 'the ledger records the grant');
    assert.equal(balance('mem_paid'), 600, 'and the balance actually moved — this is what regressed');
  });

  test('calling it twice never grants twice', async () => {
    await ensureBalance(env, 'mem_new');
    await ensureBalance(env, 'mem_new');
    await ensureBalance(env, 'mem_new');
    assert.equal(balance('mem_new'), 100);
    assert.equal(moves('mem_new'), 100);
  });

  test('a member who received a transfer before signing in is still credited', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_got', 25)`);
    db.exec(`INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('in','mem_got',25,'receive')`);
    await ensureBalance(env, 'mem_got');
    assert.equal(balance('mem_got'), 125);
    assert.equal(moves('mem_got'), 125);
  });

  test('the invariant, stated once: balance equals the sum of the moves', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_x', 500)`);
    db.exec(`INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('b1','mem_x',500,'purchase')`);
    for (const m of ['mem_a', 'mem_x', 'mem_a']) await ensureBalance(env, m);
    for (const m of ['mem_a', 'mem_x']) {
      assert.equal(balance(m), moves(m), `${m}: balance and ledger disagree`);
    }
  });
});

describe('the source itself', () => {
  test('the grant is never applied with INSERT OR IGNORE carrying the amount', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./social.mjs', import.meta.url), 'utf8'));
    const body = src.slice(src.indexOf('export async function ensureBalance'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    assert.ok(
      !/INSERT\s+OR\s+IGNORE\s+INTO\s+num_star_balances[^;]*WELCOME_STARS/is.test(fn),
      'the welcome amount is back inside an INSERT OR IGNORE — it will be skipped for anyone who already has a row',
    );
    assert.match(fn, /stars\s*=\s*stars\s*\+/, 'the grant must be an increment, not an insert');
  });
});

/**
 * THE RULE FOR WHEN STARS PAY A VENUE.
 *
 * Dre, 14 Sep 2026: "we want people to pay their tabs here eventually through
 * stars so we need it proper."
 *
 * Today a tab is friends splitting a bill BETWEEN THEMSELVES. Welcome Stars
 * moving from one member to another never leave Num, and a `receive` move is
 * not a cashable kind, so nothing can turn into money. That is why the
 * member-to-member path debits the raw balance and that is fine.
 *
 * The moment a tab pays a VENUE, that stops being true. At the 1:1 peg the
 * welcome grant is ★100 = $100, minted for anyone who types in a phone number
 * and never verified. If that can settle a real bill, Num is wiring $100 of
 * its own money to a merchant per fake signup.
 *
 * The mechanism to prevent it already exists and is already tested: PROMO_KINDS
 * and `spendable()`, which is how the welcome grant is kept from buying a
 * membership. Any path that moves Stars OUT of Num to a third party must spend
 * `spendable`, never `balance`.
 *
 * These tests state that rule now, while the feature does not exist yet, so it
 * is a decision already made rather than an argument had later.
 */
describe('the rule for when Stars pay a venue', () => {
  test('the welcome grant is promotional, and spendable() holds it back', async () => {
    const { PROMO_KINDS, spendable } = await import('./starmembership.mjs');
    assert.ok(PROMO_KINDS.includes('welcome'), 'the welcome grant must stay promotional');

    db.exec(`INSERT INTO num_star_balances VALUES ('mem_g', 0)`);
    await ensureBalance(env, 'mem_g');
    const gift = await spendable(env, 'mem_g');
    assert.equal(gift.balance, 100);
    assert.equal(gift.spendable, 0, 'a pure welcome balance can spend nothing outward');
    assert.equal(gift.promo_locked, 100);

    db.exec(`INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('buy','mem_g',500,'purchase')`);
    db.exec(`UPDATE num_star_balances SET stars = 600 WHERE member_id='mem_g'`);
    const bought = await spendable(env, 'mem_g');
    assert.equal(bought.spendable, 500, 'bought Stars spend; the gift still does not');
    assert.equal(bought.promo_locked, 100);
  });

  test('every place Stars are DEBITED is on the reviewed list', async () => {
    const fs = await import('node:fs');
    const files = fs.readdirSync(new URL('.', import.meta.url))
      .filter((f) => f.endsWith('.mjs') && !f.includes('.test.'));
    const found = {};
    for (const f of files) {
      const text = fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const n = (text.match(/num_star_balances\s+SET\s+stars\s*=\s*stars\s*-/gi) ?? []).length;
      if (n) found[f] = n;
    }
    assert.deepEqual(found, DEBIT_SITES,
      'A new way to SPEND Num Stars appeared. If it moves Stars to a venue or ' +
      'anyone outside Num it must spend `spendable`, not `balance` — otherwise ' +
      'the ★100 welcome grant becomes $100 of real money per unverified signup. ' +
      'Add it to DEBIT_SITES with a reason once you have checked.');
  });
});

/**
 * Every place a Num balance can SHRINK, by file and count.
 *
 *   social.mjs  — member→member transfer, and tab settlement between members.
 *                 Both stay inside Num; a `receive` move is not cashable, so
 *                 no promotional Star can become money down either path.
 *   errands.mjs — posting an errand moves Stars into escrow, still inside Num.
 *   starmembership.mjs — buying a membership, which already spends `spendable`
 *                 and so already excludes the welcome grant.
 *   cashout.mjs — the only door OUT. Restricted to EARNED kinds, which the
 *                 welcome grant is not.
 */
const DEBIT_SITES = {
  'cashout.mjs': 1,
  'errands.mjs': 1,
  'pay.mjs': 1,
  'social.mjs': 2,
  'starmembership.mjs': 1,
};
