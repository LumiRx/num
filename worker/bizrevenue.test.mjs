// The event two payout programmes were waiting on and never got.
//
// Checked 15 Sep 2026: `recordRevenue` (Num Experts) had no callers, and
// `creditBizReferral` (member referrals) had no callers. Two complete, tested
// payout systems wired to nothing — which looks exactly like working code
// right up until somebody asks where their money is.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA, CENTS_PER_STAR, businessEarned, placeForBusiness, revenueFor, _resetEnsured,
} from './bizrevenue.mjs';

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
const SCOUTS = read('./migrations/0006_scouts.sql');
const SCOUTS_REF = read('./migrations/0032_scout_referrals.sql');
const BIZREF_SCHEMA = /const SCHEMA = `(.*?)`;/s.exec(read('./bizreferral.mjs'))[1];

function makeEnv() {
  _resetEnsured();
  const d = new DatabaseSync(':memory:');
  d.exec(SCOUTS);
  d.exec(SCOUTS_REF);
  d.exec(SCHEMA);
  d.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT, revoked_at TEXT)`);
  // The REAL bizreferral schema, lifted out of the module rather than
  // hand-written here. A hand-rolled fixture drifted from it immediately —
  // num_star_moves takes `delta`, not `stars` — and a fake that does not match
  // production tests nothing worth knowing.
  d.exec(BIZREF_SCHEMA);
  d.exec(`CREATE TABLE IF NOT EXISTS num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER)`);
  d.exec(`CREATE TABLE IF NOT EXISTS num_star_moves (
    id TEXT PRIMARY KEY, member_id TEXT, delta INTEGER, kind TEXT, note TEXT,
    counterparty TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`INSERT INTO num_scout_terms (version,body,effective_at) VALUES ('v1','T','2026-08-01')`);
  d.exec(`INSERT INTO num_scouts (id,name,email,email_lc,code,terms_version,agreed_at)
          VALUES ('sc1','Isaiah','i@n.test','i@n.test','FARMER','v1','2026-09-15')`);
  d.exec(`INSERT INTO num_place_owners (place_id,business_id) VALUES ('p1','biz1')`);

  const prep = (sql) => {
    let args = [];
    const api = {
      bind: (...a) => { args = a; return api; },
      first: async () => d.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: d.prepare(sql).all(...args) }),
      run: async () => { const r = d.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
      _exec: () => d.prepare(sql).run(...args),
    };
    return api;
  };
  return { DB: { prepare: prep, batch: async (st) => { for (const x of st) x._exec(); } }, _raw: d };
}

const NOW = new Date('2026-09-15T12:00:00Z');

/** An Expert has introduced biz1's place and is waiting on revenue. */
function withIntroduction(env) {
  env._raw.prepare(
    `INSERT INTO num_scout_places (id,scout_id,place_id,biz_name,state,finder_gate_minor,finder_cents,share_bps,sub_share_bps)
     VALUES ('sp1','sc1','p1','Joe''s Tacos','introduced',500,500,2000,2000)`,
  ).run();
}

describe('one event, both programmes', () => {
  test('revenue reaches the Expert who introduced the business', async () => {
    const env = makeEnv();
    withIntroduction(env);
    const r = await businessEarned(env, { businessId: 'biz1', amountMinor: 600, ref: 'cs_1', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.recorded, true);
    assert.equal(r.place_id, 'p1');
    assert.equal(r.scout.activated, true, 'the gate was not crossed');
    const fee = env._raw.prepare("SELECT * FROM num_scout_earnings WHERE kind='finder'").get();
    assert.equal(fee.amount_minor, 500);
  });

  test('and the member who referred them, in Stars', async () => {
    const env = makeEnv();
    env._raw.prepare(
      `INSERT INTO num_biz_referrals (id,referrer_id,biz_name,biz_key,business_id,pct,state)
       VALUES ('r1','mem1','Joe','joe|la','biz1',2,'active')`,
    ).run();
    await businessEarned(env, { businessId: 'biz1', amountMinor: 50000, ref: 'cs_1', now: NOW });
    const bal = env._raw.prepare("SELECT stars FROM num_star_balances WHERE member_id='mem1'").get();
    // 50000 cents = 500 stars, 2% = 10.
    assert.equal(bal.stars, 10);
  });

  test('a business with neither still records the revenue', async () => {
    const env = makeEnv();
    const r = await businessEarned(env, { businessId: 'biz1', amountMinor: 900, ref: 'cs_1', now: NOW });
    assert.equal(r.recorded, true);
    assert.equal((await revenueFor(env, 'biz1')).total_minor, 900);
  });

  test('a business with no listing still records, and says so', async () => {
    const env = makeEnv();
    const r = await businessEarned(env, { businessId: 'biz_unknown', amountMinor: 900, ref: 'x', now: NOW });
    assert.equal(r.recorded, true);
    assert.equal(r.place_id, null);
    assert.equal(r.scout, null);
  });
});

describe('a retried webhook cannot pay twice', () => {
  test('the same ref twice records once', async () => {
    // Stripe retries. Without this the running total doubles and a business
    // can cross the finder gate on revenue that never existed.
    const env = makeEnv();
    withIntroduction(env);
    const a = await businessEarned(env, { businessId: 'biz1', amountMinor: 300, ref: 'cs_1', now: NOW });
    const b = await businessEarned(env, { businessId: 'biz1', amountMinor: 300, ref: 'cs_1', now: NOW });
    assert.equal(a.recorded, true);
    assert.equal(b.duplicate, true);
    assert.equal(b.recorded, false);
    const row = env._raw.prepare("SELECT revenue_minor, state FROM num_scout_places WHERE id='sp1'").get();
    assert.equal(row.revenue_minor, 300);
    assert.equal(row.state, 'introduced', 'a retry pushed it over the gate');
  });

  test('the finder fee is released exactly once across retries', async () => {
    const env = makeEnv();
    withIntroduction(env);
    for (let i = 0; i < 5; i += 1) {
      await businessEarned(env, { businessId: 'biz1', amountMinor: 900, ref: 'cs_same', now: NOW });
    }
    const n = env._raw.prepare("SELECT COUNT(*) n FROM num_scout_earnings WHERE kind='finder'").get().n;
    assert.equal(n, 1);
  });

  test('a different ref is genuinely new money', async () => {
    const env = makeEnv();
    withIntroduction(env);
    await businessEarned(env, { businessId: 'biz1', amountMinor: 200, ref: 'cs_1', now: NOW });
    await businessEarned(env, { businessId: 'biz1', amountMinor: 200, ref: 'cs_2', now: NOW });
    assert.equal(env._raw.prepare("SELECT revenue_minor FROM num_scout_places WHERE id='sp1'").get().revenue_minor, 400);
  });

  test('the same ref for a DIFFERENT business is not a duplicate', async () => {
    const env = makeEnv();
    const a = await businessEarned(env, { businessId: 'biz1', amountMinor: 100, ref: 'shared', now: NOW });
    const b = await businessEarned(env, { businessId: 'biz2', amountMinor: 100, ref: 'shared', now: NOW });
    assert.equal(a.recorded, true);
    assert.equal(b.recorded, true);
  });

  test('no ref is refused, because a retry cannot be told from a payment', async () => {
    const env = makeEnv();
    const r = await businessEarned(env, { businessId: 'biz1', amountMinor: 500, now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /ref are required/);
  });
});

describe('what it refuses to record', () => {
  test('zero and negative amounts', async () => {
    const env = makeEnv();
    for (const amt of [0, -100, null, undefined, NaN, 'lots']) {
      assert.equal((await businessEarned(env, { businessId: 'biz1', amountMinor: amt, ref: 'r' })).ok, false, String(amt));
    }
  });

  test('no business', async () => {
    const env = makeEnv();
    assert.equal((await businessEarned(env, { amountMinor: 100, ref: 'r' })).ok, false);
  });

  test('a revoked owner does not attribute revenue to a stale listing', async () => {
    const env = makeEnv();
    env._raw.prepare("UPDATE num_place_owners SET revoked_at='2026-01-01' WHERE place_id='p1'").run();
    assert.equal(await placeForBusiness(env, 'biz1'), null);
  });
});

describe('it never breaks the payment it is listening to', () => {
  test('a failing scout credit does not fail the record', async () => {
    const env = makeEnv();
    withIntroduction(env);
    // A scout table that throws on read.
    const broken = { ...env, DB: { ...env.DB, prepare: (sql) => (/num_scout_places/.test(sql)
      ? { bind: () => ({ first: async () => { throw new Error('boom'); }, run: async () => {}, all: async () => ({ results: [] }) }) }
      : env.DB.prepare(sql)) } };
    const r = await businessEarned(broken, { businessId: 'biz1', amountMinor: 700, ref: 'cs_1', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.recorded, true);
    assert.equal(r.scout.ok, false);
  });

  test('the webhook caller wraps the hook too', () => {
    const PAY = read('./pay.mjs');
    const slice = PAY.slice(PAY.indexOf('MONEY ARRIVED FROM A BUSINESS'), PAY.indexOf('A VIP host plan'));
    assert.match(slice, /\} catch \(err\) \{/);
    assert.match(slice, /makes Stripe retry the charge handling forever/);
  });
});

describe('the two callers', () => {
  const PAY = read('./pay.mjs');
  const COMM = read('./commission.mjs');

  test('a paid business subscription records revenue, keyed on the Stripe id', () => {
    assert.match(PAY, /businessEarned\(env, \{/);
    assert.match(PAY, /source: 'biztier'/);
    assert.match(PAY, /ref: id,/);
  });

  test('a received commission records revenue — at payment, not at accrual', () => {
    // An accrued commission is money OWED. Paying a share of it would credit
    // an Expert for an invoice the venue has not settled.
    assert.match(COMM, /Deliberately here and not at accrual/);
    assert.match(COMM, /source: 'commission'/);
  });

  test('the commission hook sends the increase, not the whole figure again', () => {
    // markPaid REPLACES rather than adds, so a second instalment would
    // otherwise credit the first one twice.
    assert.match(COMM, /const delta = Math\.round\(paidCents\) - Number\(before\?\.paid_cs \?\? 0\)/);
    assert.match(COMM, /if \(delta > 0 && before\?\.business_id\)/);
  });

  test('and the amount is in its ref, so a re-run is a duplicate', () => {
    assert.match(COMM, /ref: `comm:\$\{bookingId\}:\$\{Math\.round\(paidCents\)\}`/);
  });

  test('the hook sits inside markPaid, not at its callers', () => {
    // The exact failure that left recordRevenue with no callers for a week.
    assert.match(COMM, /so that every future\s+\/\/ caller is covered without anybody remembering to add it/);
  });
});

describe('the star conversion', () => {
  test('matches the peg used everywhere else', () => {
    assert.equal(CENTS_PER_STAR, 100);
    const PRE = read('./preflight.mjs');
    assert.match(PRE, new RegExp(`CENTS_PER_STAR = ${CENTS_PER_STAR}`));
  });

  test('under one star credits nothing rather than rounding up', async () => {
    const env = makeEnv();
    env._raw.prepare(
      `INSERT INTO num_biz_referrals (id,referrer_id,biz_name,biz_key,business_id,pct,state)
       VALUES ('r1','mem1','Joe','joe|la','biz1',2,'active')`,
    ).run();
    await businessEarned(env, { businessId: 'biz1', amountMinor: 50, ref: 'cs_1', now: NOW });
    const bal = env._raw.prepare("SELECT stars FROM num_star_balances WHERE member_id='mem1'").get();
    assert.equal(bal, undefined);
  });
});
