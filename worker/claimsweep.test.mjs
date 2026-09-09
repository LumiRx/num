/**
 * THE ALERT THAT FIRED ON SUCCESS.
 *
 * Between 24 Aug and 8 Sep 2026 Dre was texted every morning that Holiday Inn
 * Express Edinburgh was "waiting on us". It was not waiting. Adam verified the
 * listing on 24 Aug and had owner tools from that moment. Ten texts, all of
 * them wrong, about a business that had already succeeded — plus two more for
 * Arroyo del Sol.
 *
 * The cause was a filter written in the wrong table's vocabulary:
 * `state NOT IN ('approved','rejected','expired')` applied to num_claims,
 * which only ever holds 'verified' and 'expired'. Two of the three excluded
 * names could never appear, so the condition meant `<> 'expired'` and every
 * completed claim qualified for ever.
 *
 * These tests exist so that never happens again by the same route: the states
 * that alert are an explicit allowlist, and an unrecognised state stays quiet.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claimSweep, WAITING_ON_US, SETTLED } from './nudge.mjs';

let db; let env; let sent;
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

const claim = (id, state, created) =>
  db.prepare('INSERT INTO num_claims (id, place_id, state, created_at, claimant_name, claimant_email) VALUES (?,?,?,?,?,?)')
    .run(id, 'p1', state, created, 'Adam', 'reception@hieedinburgh.co.uk');

const OLD = '2026-08-24 16:31:15';

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, dest TEXT)`);
  db.prepare('INSERT INTO places VALUES (?,?,?)').run('p1', 'Holiday Inn Express Edinburgh City Centre', 'edinburgh');
  db.exec(`CREATE TABLE num_claims (id TEXT PRIMARY KEY, place_id TEXT, state TEXT, created_at TEXT, claimant_name TEXT, claimant_email TEXT)`);
  db.exec(`CREATE TABLE num_app_claims (id TEXT PRIMARY KEY, place_id TEXT, state TEXT, created_at TEXT, expires_at TEXT)`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT, contact_name TEXT, phone TEXT, source TEXT, state TEXT, created_at TEXT)`);
  // nudge.mjs guards its schema with a module-level `ready` boolean, so only
  // the FIRST test in this file gets its tables created. Every later test
  // would silently fail its dedupe insert and report nothing — which looks
  // exactly like the fix working. Create the table here so each case starts
  // from a real database.
  db.exec(`CREATE TABLE num_nudges (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, plan_id TEXT, moment TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec(`CREATE UNIQUE INDEX idx_nudge_once ON num_nudges(member_id, plan_id, moment)`);
  sent = [];
  env = { DB: d1(db), ALERT_SMS_TO: '', ADMIN_EMAIL: '' };
});

describe('the fifteen-day false alarm', () => {
  test('a VERIFIED claim is never reported as waiting on us', async () => {
    // The exact row: Adam, verified 24 Aug, ten texts.
    claim('clm_f66d23c0b7014ddf915b', 'verified', OLD);
    const out = await claimSweep(env);
    assert.equal(out.api_claims ?? 0, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_nudges WHERE moment LIKE 'apiclaim:%'").get().n, 0,
      'not even a dedupe row — it should never have been a candidate');
  });

  test('an EXPIRED claim is never reported either', async () => {
    claim('c2', 'expired', OLD);
    assert.equal((await claimSweep(env)).api_claims ?? 0, 0);
  });

  test('a genuinely pending claim IS reported — the alert still does its job', async () => {
    claim('c3', 'pending', OLD);
    const out = await claimSweep(env);
    assert.equal(out.api_claims, 1);
  });

  test('the old filter would have alerted; the new one does not', () => {
    // Written as an assertion rather than a comment so the regression is
    // mechanical: 'verified' passes the OLD test and fails the NEW one.
    const oldFilter = (s) => !['approved', 'rejected', 'expired'].includes(s);
    assert.equal(oldFilter('verified'), true, 'this is how ten texts happened');
    assert.equal(WAITING_ON_US.includes('verified'), false);
  });
});

describe('the allowlist is the fix, not a longer denylist', () => {
  test('verified and expired are classified as settled', () => {
    for (const s of ['verified', 'expired']) assert.ok(SETTLED.includes(s), s);
  });

  test('no state is both waiting and settled', () => {
    for (const s of WAITING_ON_US) assert.ok(!SETTLED.includes(s), `${s} is in both lists`);
  });

  test('an unknown state stays quiet rather than alerting daily for ever', async () => {
    // The default matters more than the list. A state nobody has classified
    // yet must not wake someone every morning until they notice.
    claim('c4', 'some_future_state', OLD);
    assert.equal((await claimSweep(env)).api_claims ?? 0, 0);
  });

  test('every state num_claims can actually produce is classified', () => {
    // Taken from production on 8 Sep 2026: SELECT state, COUNT(*) FROM
    // num_claims GROUP BY state → verified 2, expired 2. If claim.mjs starts
    // writing a third, this test is where someone decides what it means.
    for (const s of ['verified', 'expired']) {
      assert.ok(WAITING_ON_US.includes(s) || SETTLED.includes(s), `${s} is unclassified`);
    }
  });
});

describe('what it still catches', () => {
  test('a claim younger than two hours is left alone', async () => {
    claim('c5', 'pending', new Date().toISOString().slice(0, 19).replace('T', ' '));
    assert.equal((await claimSweep(env)).api_claims ?? 0, 0);
  });

  test('a pending claim is reported once a day, not once every five minutes', async () => {
    claim('c6', 'pending', OLD);
    assert.equal((await claimSweep(env)).api_claims, 1);
    assert.equal((await claimSweep(env)).api_claims, 0, 'the same day is silent');
  });

  test('a brand new web signup still alerts immediately', async () => {
    db.prepare("INSERT INTO claims (business_name, contact_name, phone, source, state, created_at) VALUES (?,?,?,?,'new',?)")
      .run('Bestia', 'Ori', '+13105550000', 'web', OLD);
    const out = await claimSweep(env);
    assert.equal(out.web_new, 1, 'the money moment is untouched by this fix');
  });
});
