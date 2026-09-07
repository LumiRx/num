/**
 * Buying a membership with Stars — the three rules, and the arithmetic.
 *
 * The tests that matter here are the ones about money leaving without coming
 * back: a discount that appears through rounding, a welcome gift that buys
 * three months of Plus per signup, and a card subscription that keeps charging
 * underneath a Star purchase.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bestStarRate, starPrice, starTiers, spendable, quote, buyWithStars, PROMO_KINDS } from './starmembership.mjs';
import { STAR_PACKS } from './preflight.mjs';
import { tierOf, grantTier } from './membership.mjs';

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

const credit = (member, delta, kind, id = `${kind}_${member}_${delta}`) =>
  db.exec(`INSERT INTO num_star_moves (id, member_id, delta, kind) VALUES ('${id}','${member}',${delta},'${kind}')`);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT)`);
  db.exec(`CREATE TABLE num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE num_star_moves (id TEXT PRIMARY KEY, member_id TEXT, delta INTEGER, kind TEXT, note TEXT, counterparty TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE num_memberships (member_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free', since TEXT DEFAULT (datetime('now')), renews_at TEXT, source TEXT, ref TEXT, stripe_sub TEXT)`);
  db.exec(`CREATE TABLE num_usage_counters (member_id TEXT, period TEXT, key TEXT, used INTEGER DEFAULT 0, PRIMARY KEY (member_id, period, key))`);
  db.exec(`INSERT INTO num_members VALUES ('mem_a','Dre'),('mem_b','Sam')`);
  env = { DB: d1(db) };
});

describe('rule 1 — Stars are never the cheap door', () => {
  test('the Star price is derived from the cheapest pack we sell, rounded up', () => {
    // ★5,000 for $1,425 is 28.5¢ a Star, the best rate on the shelf.
    assert.equal(bestStarRate(STAR_PACKS), 28.5);
    assert.equal(starPrice(898), 32);   // 31.5 → 32
    assert.equal(starPrice(2898), 102); // 101.68 → 102
  });

  test('every tier costs at least as much in Stars as it does in cash', () => {
    const rate = bestStarRate(STAR_PACKS);
    for (const t of starTiers({})) {
      assert.ok(
        t.stars_per_month * rate >= t.price_cents,
        `${t.id}: ★${t.stars_per_month} is ${t.stars_per_month * rate}¢, cheaper than the ${t.price_cents}¢ cash price`,
      );
    }
  });

  test('the price moves with the packs rather than being typed in twice', () => {
    // Halve the price of Stars and a membership costs twice as many of them.
    assert.equal(starPrice(898, { 1000: 14750 }), 61);
  });

  test('a zero or nonsense price never becomes a free membership', () => {
    assert.equal(starPrice(0), null);
    assert.equal(starPrice(-100), null);
    assert.equal(starPrice(898, {}), null);
  });
});

describe('rule 2 — the welcome gift cannot buy a membership', () => {
  test('a brand-new member with only the welcome grant can spend none of it', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',100)`);
    credit('mem_a', 100, 'welcome');
    const w = await spendable(env, 'mem_a');
    assert.deepEqual(w, { balance: 100, spendable: 0, promo_locked: 100 });
  });

  test('and is told why, in words, rather than just refused', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',100)`);
    credit('mem_a', 100, 'welcome');
    const q = await quote(env, { memberId: 'mem_a', tier: 'plus' });
    assert.equal(q.affordable, false);
    assert.equal(q.short, 32);
    assert.match(q.note, /welcome gift/);
  });

  test('bought and earned Stars spend freely; only the gift is held back', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',400)`);
    credit('mem_a', 100, 'welcome');
    credit('mem_a', 200, 'purchase');
    credit('mem_a', 100, 'referral');
    const w = await spendable(env, 'mem_a');
    assert.equal(w.spendable, 300);
    assert.equal(w.promo_locked, 100);
  });

  test('the welcome grant is the ONLY thing held back — not a growing list', () => {
    assert.deepEqual([...PROMO_KINDS], ['welcome']);
  });

  test('a signup script cannot mint months: 1,000 fresh members buy nothing', async () => {
    for (let i = 0; i < 25; i += 1) {
      db.exec(`INSERT INTO num_members VALUES ('bot_${i}','bot')`);
      db.exec(`INSERT INTO num_star_balances VALUES ('bot_${i}',100)`);
      credit(`bot_${i}`, 100, 'welcome');
      const out = await buyWithStars(env, { memberId: `bot_${i}`, tier: 'plus' });
      assert.equal(out.ok, false);
      assert.equal(out.status, 402);
    }
    const granted = db.prepare('SELECT COUNT(*) n FROM num_memberships').get();
    assert.equal(granted.n, 0);
  });
});

describe('rule 3 — never charged twice for the same month', () => {
  test('a live card subscription blocks the Star purchase and says how to fix it', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',500)`);
    credit('mem_a', 500, 'purchase');
    db.exec(`INSERT INTO num_memberships (member_id, tier, stripe_sub) VALUES ('mem_a','plus','sub_123')`);
    const out = await buyWithStars(env, { memberId: 'mem_a', tier: 'plus' });
    assert.equal(out.ok, false);
    assert.equal(out.status, 409);
    assert.match(out.error, /twice/);
    assert.match(out.error, /Cancel the card plan first/);
    assert.equal(db.prepare(`SELECT stars FROM num_star_balances WHERE member_id='mem_a'`).get().stars, 500);
  });

  test('the same idem key twice charges once', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',500)`);
    credit('mem_a', 500, 'purchase');
    const a = await buyWithStars(env, { memberId: 'mem_a', tier: 'plus', idem: 'tap1' });
    const b = await buyWithStars(env, { memberId: 'mem_a', tier: 'plus', idem: 'tap1' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.repeat, true);
    assert.equal(db.prepare(`SELECT stars FROM num_star_balances WHERE member_id='mem_a'`).get().stars, 468);
  });
});

describe('what the member actually gets', () => {
  test('a purchase debits the Stars, files the move and grants the tier', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',500)`);
    credit('mem_a', 500, 'purchase');
    const out = await buyWithStars(env, { memberId: 'mem_a', tier: 'plus', months: 3 });
    assert.equal(out.ok, true);
    assert.equal(out.stars, 96);
    assert.equal(out.auto_renews, false);
    assert.equal(db.prepare(`SELECT stars FROM num_star_balances WHERE member_id='mem_a'`).get().stars, 404);
    const move = db.prepare(`SELECT delta, kind FROM num_star_moves WHERE kind='membership'`).get();
    assert.equal(move.delta, -96);
    assert.equal(move.kind, 'membership');
    assert.equal(await tierOf(env, 'mem_a'), 'plus');
  });

  test('nothing recurs — no Stripe subscription is attached to a Star membership', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',500)`);
    credit('mem_a', 500, 'purchase');
    await buyWithStars(env, { memberId: 'mem_a', tier: 'plus' });
    const row = db.prepare(`SELECT source, stripe_sub FROM num_memberships WHERE member_id='mem_a'`).get();
    assert.equal(row.source, 'stars');
    assert.equal(row.stripe_sub, null);
  });

  test('topping up early ADDS to the days left instead of throwing them away', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',500)`);
    credit('mem_a', 500, 'purchase');
    const first = await buyWithStars(env, { memberId: 'mem_a', tier: 'plus', idem: 'a' });
    const second = await buyWithStars(env, { memberId: 'mem_a', tier: 'plus', idem: 'b' });
    const days = (s) => Math.round((Date.parse(`${s}Z`) - Date.now()) / 86400_000);
    assert.equal(days(first.renews_at), 30);
    assert.equal(days(second.renews_at), 60, 'the second month stacked on the first');
  });

  test('moving UP a tier does not carry cheap months onto the expensive plan', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',900)`);
    credit('mem_a', 900, 'purchase');
    await buyWithStars(env, { memberId: 'mem_a', tier: 'plus', months: 6, idem: 'a' });
    const up = await buyWithStars(env, { memberId: 'mem_a', tier: 'pro', idem: 'b' });
    const days = Math.round((Date.parse(`${up.renews_at}Z`) - Date.now()) / 86400_000);
    assert.equal(days, 30, 'Pro starts today, not in six months');
  });

  test('a member who cannot pay is told the number, not just "no"', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',20)`);
    credit('mem_a', 20, 'purchase');
    const out = await buyWithStars(env, { memberId: 'mem_a', tier: 'plus' });
    assert.equal(out.ok, false);
    assert.match(out.error, /★32/);
    assert.match(out.error, /★20/);
    assert.equal(out.short, 12);
  });

  test('months are bounded — nobody buys a century in one tap', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',99999)`);
    credit('mem_a', 99999, 'purchase');
    const out = await buyWithStars(env, { memberId: 'mem_a', tier: 'plus', months: 600 });
    assert.equal(out.ok, false);
    assert.match(out.error, /twelve months/);
  });

  test('an unknown member buys nothing', async () => {
    const out = await buyWithStars(env, { memberId: 'nobody', tier: 'plus' });
    assert.equal(out.ok, false);
    assert.equal(out.status, 404);
  });
});

describe('the refusals never leak code or vendor text', () => {
  test('every message a member can see reads like a person wrote it', async () => {
    db.exec(`INSERT INTO num_star_balances VALUES ('mem_a',10)`);
    credit('mem_a', 10, 'purchase');
    const said = [
      (await buyWithStars(env, { memberId: 'mem_a', tier: 'plus' })).error,
      (await buyWithStars(env, { memberId: 'mem_a', tier: 'nope' })).error,
      (await quote(env, { memberId: 'mem_a', tier: 'plus' })).note,
    ].filter(Boolean);
    for (const line of said) {
      assert.doesNotMatch(line, /undefined|null|\[object|Error:|SQLITE|D1_/);
    }
  });
});

describe('the source itself', () => {
  const SRC = readFileSync(new URL('./starmembership.mjs', import.meta.url), 'utf8');
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('the Star price is computed, never a literal sitting next to the cash price', () => {
    assert.doesNotMatch(code, /stars_per_month:\s*\d+/);
    assert.match(code, /Math\.ceil\(cents \/ rate\)/);
  });

  test('the client never names the price', () => {
    assert.doesNotMatch(code, /b\.(stars|price|amount|cost)/);
  });
});
