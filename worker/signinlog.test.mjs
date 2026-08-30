// The sign-in log: which half of sign-in is broken.
//
// This exists because on 23 Aug 2026 production had ~30 website visitors a
// week, a working install funnel, 131 member rows — and the last completed
// phone verification was 4 JULY. Seven weeks, invisible, because the only
// durable record of an attempt was its side effect: phone_verified flipping
// to 1. A step that never happens leaves no trace, so the outage was hidden in
// exact proportion to how total it was.
//
// And the two explanations were indistinguishable from outside:
//   · the code is never SENT   → provider / compliance (A2P 30034)
//   · sent and never ENTERED   → product: the sheet, the keyboard, the wait
// One is fixed in a Twilio console, one in the app. Guessing costs a week.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { logSignin, signinFunnel, signinReasons, STAGES, OUTCOMES, _resetForTests } from './signinlog.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true, meta: { changes: 1 } }; },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

let db, env;
beforeEach(() => { db = new DatabaseSync(':memory:'); env = { DB: d1(db) }; _resetForTests(); });

const rows = () => db.prepare('SELECT * FROM num_signin_events ORDER BY id').all();

describe('logging one attempt', () => {
  test('creates its own table on first write', async () => {
    assert.deepEqual(await logSignin(env, { memberId: 'mem_1', stage: 'send', outcome: 'ok', via: 'verify' }), { logged: 1 });
    const r = rows()[0];
    assert.equal(r.member_id, 'mem_1');
    assert.equal(r.stage, 'send');
    assert.equal(r.outcome, 'ok');
    assert.equal(r.via, 'verify');
    assert.ok(r.ts);
  });

  test('stores no phone number and no code', async () => {
    // A diagnostic table that becomes a second copy of the member register is
    // a liability that outlives the bug it was added for.
    await logSignin(env, { memberId: 'mem_1', stage: 'send', outcome: 'failed', reason: '30034', via: 'sms' });
    const cols = db.prepare('PRAGMA table_info(num_signin_events)').all().map((c) => c.name);
    assert.deepEqual(cols.sort(), ['id', 'member_id', 'outcome', 'reason', 'stage', 'ts', 'via']);
    assert.ok(!cols.includes('phone'));
    assert.ok(!cols.includes('code'));
    assert.ok(!cols.includes('ip'));
  });

  test('refuses an unknown stage or outcome rather than inventing a bucket', async () => {
    // A typo'd stage creates a bucket nobody queries, which looks exactly like
    // silence — the failure mode this whole file exists to end.
    assert.deepEqual(await logSignin(env, { stage: 'sent', outcome: 'ok' }), { logged: 0 });
    assert.deepEqual(await logSignin(env, { stage: 'send', outcome: 'success' }), { logged: 0 });
    assert.deepEqual([...STAGES], ['send', 'check']);
    assert.ok(OUTCOMES.includes('wrong_code') && OUTCOMES.includes('capped') && OUTCOMES.includes('expired'));
  });

  test('a logging failure never costs somebody their sign-in', async () => {
    const dead = { DB: { prepare() { throw new Error('D1 down'); }, batch() { throw new Error('D1 down'); } } };
    assert.deepEqual(await logSignin(dead, { stage: 'send', outcome: 'ok' }), { logged: 0 });
    assert.deepEqual(await logSignin({}, { stage: 'send', outcome: 'ok' }), { logged: 0 });
  });

  test('a long reason is clipped, not rejected', async () => {
    await logSignin(env, { memberId: 'm', stage: 'send', outcome: 'failed', reason: 'x'.repeat(200) });
    assert.equal(rows()[0].reason.length, 40);
  });
});

describe('the funnel', () => {
  const seed = async (list) => { for (const f of list) await logSignin(env, f); };

  test('separates sent from entered — the whole diagnostic', async () => {
    await seed([
      { memberId: 'a', stage: 'send', outcome: 'ok', via: 'verify' },
      { memberId: 'b', stage: 'send', outcome: 'ok', via: 'verify' },
      { memberId: 'c', stage: 'send', outcome: 'failed', reason: '30034', via: 'sms' },
      { memberId: 'a', stage: 'check', outcome: 'wrong_code', via: 'verify' },
      { memberId: 'a', stage: 'check', outcome: 'ok', via: 'verify' },
    ]);
    const [day] = await signinFunnel(env, 14);
    assert.equal(day.send_attempts, 3);
    assert.equal(day.sent, 2, 'a refused send must not count as sent');
    assert.equal(day.entered, 2);
    assert.equal(day.verified, 1);
  });

  test('codes sent with nothing entered reads as a product problem', async () => {
    await seed([
      { memberId: 'a', stage: 'send', outcome: 'ok', via: 'verify' },
      { memberId: 'b', stage: 'send', outcome: 'ok', via: 'verify' },
    ]);
    const [day] = await signinFunnel(env, 14);
    assert.equal(day.sent, 2);
    assert.equal(day.entered, 0, 'nobody came back — the app, not the provider');
  });

  test('nothing sent at all reads as a provider problem', async () => {
    await seed([
      { memberId: 'a', stage: 'send', outcome: 'failed', reason: '30034', via: 'sms' },
      { memberId: 'b', stage: 'send', outcome: 'failed', reason: '30034', via: 'sms' },
    ]);
    const [day] = await signinFunnel(env, 14);
    assert.equal(day.send_attempts, 2);
    assert.equal(day.sent, 0);
    const why = await signinReasons(env, 14);
    assert.equal(why[0].reason, '30034', 'the provider code is the answer and must survive to the report');
    assert.equal(why[0].n, 2);
  });

  test('successes are not listed as reasons to investigate', async () => {
    await seed([{ memberId: 'a', stage: 'send', outcome: 'ok', via: 'verify' }]);
    assert.deepEqual(await signinReasons(env, 14), []);
  });

  test('an empty log is an empty report, not an error', async () => {
    assert.deepEqual(await signinFunnel(env, 14), []);
    assert.deepEqual(await signinReasons(env, 14), []);
    assert.deepEqual(await signinFunnel({}, 14), []);
  });

  test('the window is clamped rather than trusted', async () => {
    await logSignin(env, { memberId: 'a', stage: 'send', outcome: 'ok' });
    for (const bad of [0, -5, 9999, NaN, 'nonsense', null]) {
      assert.ok(Array.isArray(await signinFunnel(env, bad)), `window ${bad} threw`);
    }
  });
});
