// The monthly quota, which was a number on a dashboard and nothing else.
//
// `num_partner_keys.monthly_limit` has been stored since signup shipped, shown
// on /api/partner/usage as `remaining`, and promised in the welcome email as
// "Free tier: 1,000 calls/month". A grep for it found a schema default, a tier
// table and two lines of display code — and no reader. The free tier was
// unlimited and a paid tier could not mean anything.
//
// That stopped being academic when LetsGo2Trip proposed a flat monthly fee
// (their term 10) against a 120 req/min ceiling (term 8). A flat fee buys a
// ceiling; an unenforced ceiling means the fee buys a sentence.
//
// The two properties below are in tension and both matter:
//   · the quota is COUNTED and reported immediately, so the number is real;
//   · it does not REFUSE until PARTNER_QUOTA_ENFORCED is set, so switching it
//     on cannot break a partner mid-integration on a day nobody chose.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { monthlyUsage, quotaEnforced, overQuota } from './partnermcp.mjs';
import { TIERS, perMinFor } from './partnersignup.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => ({ results: db.prepare(sql).all(...args), success: true }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true, meta: { changes: 1 } }; },
  });
  return { prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); } };
}

let db, env;
const month = new Date().toISOString().slice(0, 7);
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_partner_keys (id TEXT PRIMARY KEY, company TEXT, email TEXT,
           key_hash TEXT, tier TEXT DEFAULT 'free', monthly_limit INTEGER DEFAULT 1000, state TEXT DEFAULT 'active')`);
  db.exec(`CREATE TABLE num_partner_calls (id INTEGER PRIMARY KEY AUTOINCREMENT,
           partner TEXT, tool TEXT, ok INTEGER, ts TEXT)`);
  db.prepare(`INSERT INTO num_partner_keys (id, company, tier, monthly_limit)
              VALUES ('letsgo2trip','LetsGo2Trip','partner',250000)`).run();
  env = { DB: d1(db) };
});

const calls = (n, when = `${month}-15`) => {
  const st = db.prepare('INSERT INTO num_partner_calls (partner, tool, ok, ts) VALUES (?,?,1,?)');
  for (let i = 0; i < n; i++) st.run('letsgo2trip', 'search_places', when);
};
const keyed = { id: 'letsgo2trip', keyed: true };

describe('monthlyUsage', () => {
  test('counts this month against the key’s own ceiling', async () => {
    calls(7);
    assert.deepEqual(await monthlyUsage(env, keyed), { used: 7, ceiling: 250000, month });
  });

  test('last month’s calls do not count against this month', async () => {
    calls(5, '2020-01-15');
    assert.equal((await monthlyUsage(env, keyed)).used, 0);
  });

  test('another partner’s calls do not count against ours', async () => {
    db.prepare('INSERT INTO num_partner_calls (partner, tool, ok, ts) VALUES (?,?,1,?)')
      .run('someone-else', 'search_places', `${month}-15`);
    assert.equal((await monthlyUsage(env, keyed)).used, 0);
  });

  test('unkeyed traffic is not quota-counted — the per-minute limiter governs it', async () => {
    assert.equal(await monthlyUsage(env, { id: null, keyed: false }), null);
  });

  test('an unknown key returns null rather than a zero ceiling', async () => {
    // A zero ceiling would read as "over quota" and refuse everything.
    assert.equal(await monthlyUsage(env, { id: 'ghost', keyed: true }), null);
  });

  test('counting never costs somebody an answer', async () => {
    const dead = { DB: { prepare() { throw new Error('D1 down'); } } };
    assert.equal(await monthlyUsage(dead, keyed), null);
    assert.equal(await monthlyUsage({}, keyed), null);
  });
});

describe('the switch', () => {
  test('off by default, and off for anything but the exact string', () => {
    assert.equal(quotaEnforced({}), false);
    assert.equal(quotaEnforced({ PARTNER_QUOTA_ENFORCED: 'TRUE' }), false);
    assert.equal(quotaEnforced({ PARTNER_QUOTA_ENFORCED: '1' }), false);
    assert.equal(quotaEnforced({ PARTNER_QUOTA_ENFORCED: 'true' }), true);
  });

  test('the refusal is a JSON-RPC error a client can act on, not a bare 429', () => {
    const res = overQuota(9, { used: 1000, ceiling: 1000, month: '2026-08' });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '3600');
  });

  test('the refusal names the numbers and says nothing changed', async () => {
    const body = await overQuota(9, { used: 1200, ceiling: 1000, month: '2026-08' }).json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 9);
    assert.equal(body.error.code, -32003);
    assert.match(body.error.message, /1200 of 1000/);
    assert.match(body.error.message, /2026-08/);
    assert.match(body.error.message, /Nothing was changed/);
  });
});

describe('the tiers a fee can actually buy', () => {
  test('the partner tier clears the 120 req/min term', () => {
    assert.ok(TIERS.partner.per_min >= 120, 'the tier does not meet what we agreed to');
    assert.ok(TIERS.partner.monthly_limit > TIERS.free.monthly_limit);
  });

  test('free is an evaluation tier and says so in its ceiling', () => {
    assert.equal(TIERS.free.monthly_limit, 1000);
    assert.ok(TIERS.free.per_min < TIERS.partner.per_min);
  });

  test('every tier declares a per-minute figure', () => {
    for (const [name, t] of Object.entries(TIERS)) {
      assert.ok(Number.isFinite(t.per_min), `${name} has no per_min — perMinFor would silently use free`);
    }
  });

  test('perMinFor falls back to free rather than to undefined', () => {
    assert.equal(perMinFor({ tier: 'partner' }), TIERS.partner.per_min);
    assert.equal(perMinFor({ tier: 'nonsense' }), TIERS.free.per_min);
    assert.equal(perMinFor(null), TIERS.free.per_min);
  });
});
