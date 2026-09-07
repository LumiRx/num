/**
 * Num for AI — the self-serve developer API.
 *
 * A key that anybody can mint in one click is only defensible because of what
 * it CANNOT do. Most of these tests are about that, and about the key never
 * existing anywhere we could leak it.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { issue, check, revoke, countCall, hashKey, mintKey, overview, SCOPES, DEFAULT_SCOPES, FREE_DAILY } from './devapi.mjs';

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

const req = (key) => ({ headers: { get: (h) => (h === 'Authorization' && key ? `Bearer ${key}` : null) } });
const APP = { app_name: 'Wander', email: 'dev@wander.example', website: 'https://wander.example' };

beforeEach(() => { db = new DatabaseSync(':memory:'); env = { DB: d1(db) }; });

describe('the key is never stored', () => {
  test('only a hash and the last four characters reach the database', async () => {
    const out = await issue(env, APP);
    const row = db.prepare('SELECT key_hash, tail FROM num_dev_keys').get();
    assert.equal(row.key_hash, await hashKey(out.key));
    assert.equal(row.tail, out.key.slice(-4));
    // The whole point: a leaked database leaks hashes, and nobody's
    // integration is compromised.
    const dump = JSON.stringify(db.prepare('SELECT * FROM num_dev_keys').all());
    assert.ok(!dump.includes(out.key), 'the key itself is in the database');
  });

  test('the response says out loud that it is shown once', async () => {
    const out = await issue(env, APP);
    assert.match(out.keep_it, /shown once/);
    assert.match(out.keep_it, /revoke it and take another/);
  });

  test('keys are prefixed, so a leaked one is recognisable as ours', () => {
    assert.match(mintKey(), /^num_live_[0-9a-f]{48}$/);
    assert.notEqual(mintKey(), mintKey());
  });
});

describe('READ-ONLY, AND NO PEOPLE', () => {
  test('there is no scope that books, orders, or reads a person', () => {
    const names = Object.keys(SCOPES).join(' ');
    for (const forbidden of ['book', 'order', 'member', 'guest', 'pay', 'write', 'delivery', 'phone']) {
      assert.ok(!names.includes(forbidden), `a "${forbidden}" scope exists — a key pasted into a hobby project could use it`);
    }
    assert.deepEqual(Object.keys(SCOPES).sort(), ['answer', 'events:read', 'places:read']);
  });

  test('a key only carries the scopes it was issued', async () => {
    const { key } = await issue(env, APP);
    assert.equal((await check(env, req(key), 'places:read')).ok, true);
    const no = await check(env, req(key), 'bookings:write');
    assert.equal(no.ok, false);
    assert.equal(no.status, 403);
    assert.match(no.error, /does not carry/);
  });

  test('the public overview states the limits where somebody decides to build', () => {
    const o = overview();
    assert.ok(o.limits.some((l) => /Read-only/.test(l)));
    assert.ok(o.limits.some((l) => /anything about a person/.test(l)));
    assert.equal(o.free_tier.calls_per_day, FREE_DAILY);
    assert.equal(o.free_tier.price, 0);
  });
});

describe('a bad key is refused without teaching anything', () => {
  test('no key at all says where to get one', async () => {
    const v = await check(env, req(null), 'places:read');
    assert.equal(v.status, 401);
    assert.match(v.error, /itsnum\.com\/for-ai/);
  });

  test('an unknown key and a wrong key give the SAME sentence', async () => {
    // Telling them apart tells somebody whether a guessed key exists.
    const a = await check(env, req('num_live_deadbeef'), 'places:read');
    await issue(env, APP);
    const b = await check(env, req('num_live_cafebabe'), 'places:read');
    assert.equal(a.error, b.error);
    assert.match(a.error, /not one of ours/);
  });

  test('a revoked key stops immediately and says why', async () => {
    const { key } = await issue(env, APP);
    assert.equal((await revoke(env, key)).ok, true);
    const v = await check(env, req(key), 'places:read');
    assert.equal(v.ok, false);
    assert.match(v.error, /revoked/);
  });

  test('revoking needs the KEY, not an id — the holder can switch it off alone', async () => {
    const out = await issue(env, APP);
    assert.equal((await revoke(env, out.key_id)).ok, false, 'an id was enough to revoke somebody else’s key');
    assert.equal((await revoke(env, out.key)).ok, true);
    // And revoking twice is honest about it rather than pretending.
    assert.equal((await revoke(env, out.key)).ok, false);
  });
});

describe('the free tier is real and the cap is honest', () => {
  test('the count is per key per day and the refusal says when it resets', async () => {
    const { key, key_id } = await issue(env, APP);
    db.exec(`INSERT INTO num_dev_usage (key_id, day, calls) VALUES ('${key_id}','${new Date().toISOString().slice(0, 10)}',${FREE_DAILY})`);
    const v = await check(env, req(key), 'places:read');
    assert.equal(v.status, 429);
    assert.match(v.error, /resets at 00:00 UTC/);
    assert.equal(v.used, FREE_DAILY);
  });

  test('a good call reports what is left, so a 429 is never a surprise', async () => {
    const { key, key_id } = await issue(env, APP);
    await countCall(env, key_id);
    await countCall(env, key_id);
    const v = await check(env, req(key), 'places:read');
    assert.equal(v.used, 2);
    assert.equal(v.left, FREE_DAILY - 2);
  });

  test('a call is counted AFTER the work, never before', async () => {
    // A developer billed for a request we failed to serve is a developer who
    // stops trusting the meter.
    const { key_id } = await issue(env, APP);
    const before = db.prepare('SELECT COUNT(*) n FROM num_dev_usage').get().n;
    assert.equal(before, 0, 'issuing a key already consumed a call');
    await countCall(env, key_id);
    assert.equal(db.prepare('SELECT calls FROM num_dev_usage').get().calls, 1);
  });

  test('counting never throws into the caller', async () => {
    await countCall(env, null);
    await countCall({ DB: null }, 'nope');
  });
});

describe('signing up', () => {
  test('it needs a name and a working email, and says which is missing', async () => {
    assert.match((await issue(env, { email: 'a@b.co' })).error, /What is the app called/);
    assert.match((await issue(env, { app_name: 'X', email: 'not-an-email' })).error, /working email/);
    assert.equal((await issue(env, APP)).ok, true);
  });

  test('one address cannot fill the table by accident', async () => {
    for (let i = 0; i < 5; i += 1) assert.equal((await issue(env, APP)).ok, true);
    const sixth = await issue(env, APP);
    assert.equal(sixth.ok, false);
    assert.equal(sixth.status, 429);
    // Revoking one frees the slot — a cap, not a wall.
    const one = db.prepare('SELECT key_hash FROM num_dev_keys LIMIT 1').get();
    db.exec(`UPDATE num_dev_keys SET revoked_at = datetime('now') WHERE key_hash='${one.key_hash}'`);
    assert.equal((await issue(env, APP)).ok, true);
  });

  test('a new key arrives usable, with its scopes and its cap stated', async () => {
    const out = await issue(env, APP);
    assert.deepEqual(out.scopes, [...DEFAULT_SCOPES]);
    assert.equal(out.daily_cap, FREE_DAILY);
    assert.match(out.how, /Authorization: Bearer/);
    assert.equal((await check(env, req(out.key), 'answer')).ok, true);
  });
});
