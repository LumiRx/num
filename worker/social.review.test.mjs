// App Review access — the reviewer signs in with no SMS, and nobody else does.
//
// The problem this covers. Num authenticates one way: a phone number, proved
// by an SMS code. There is no email and no password, so the demo credential in
// the store submission checklist ("review@itsnum.com / password") is not a
// thing the app can accept. And A2P 10DLC is unregistered, so the SMS half
// does not work either — after the SEC-001 fix, a fresh install typing the
// demo number gets a 503 and stops. An Apple reviewer in that position rejects
// under 2.1 App Completeness, which is Apple's single largest rejection cause.
//
// So: a grant, scoped to one number, carrying one code, with an expiry date —
// all three Worker secrets, all three absent by default. These tests pin the
// four properties that make it a grant instead of a back door:
//
//   1. it works for the demo member, with SMS dead
//   2. it does nothing for any other member
//   3. it does nothing with the flag off, expired, half-set or weak
//   4. it cannot be steered — presenting the reviewer code against another
//      number returns no ID at all
//
// Same discipline as social.takeover.test.mjs: real Requests through the real
// router against real SQLite with the real schema, asserting on real response
// bodies and real rows. Not a regex over the source.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSocialSafe } from './social.mjs';

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
      return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
    },
  });
  return {
    prepare(sql) {
      const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) });
      return bound([]);
    },
    batch: async (stmts) => stmts.map((s) => s.run()),
  };
}

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE IF NOT EXISTS num_referral_codes (
  code TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, reward_cs INTEGER, reward_referee_cs INTEGER,
  max_conversions INTEGER, max_reward_total_cs INTEGER, active INTEGER, created_at INTEGER)`);

const DEMO_PHONE = '+66811234567';
const OTHER_PHONE = '+66819998888';
const CODE = 'NUM-REVIEW-2026-8F3QK';
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

const base = { DB: d1(db), NUM_APP_ORIGIN: 'https://app.itsnum.com', TWILIO_SID: 'ACtest', TWILIO_TOKEN: 'token', TWILIO_FROM: '+15550000000' };

/** The flag OFF — production today, and the default this ships with. */
const envOff = { ...base };
/** The flag ON, unpinned. */
const envOn = { ...base, REVIEW_DEMO_PHONE: DEMO_PHONE, REVIEW_DEMO_CODE: CODE, REVIEW_ACCESS_UNTIL: FUTURE };

// A2P 10DLC is unregistered. Every send really does fail — that is the world
// these tests are about, so the stub never succeeds.
globalThis.fetch = async (url) => {
  if (!String(url).includes('api.twilio.com')) throw new Error(`unexpected fetch: ${url}`);
  return new Response(JSON.stringify({ code: 30034, message: 'unregistered A2P 10DLC campaign' }), { status: 400 });
};

const post = (path, body, env = envOn) =>
  handleSocialSafe(
    new Request(`https://app.itsnum.com/api/social${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify(body),
    }),
    env,
    path,
  );

const read = async (res) => ({ status: res.status, body: await res.json() });
/** Anything in a response body usable as `?me=`. */
const idsIn = (body) => JSON.stringify(body).match(/mem_[a-f0-9]{8,}/g) ?? [];

/**
 * "Did this response let the caller in?"
 *
 * Not the status code. The demo account is phone_verified, so the ordinary
 * `/verify` path answers `200 { ok: true, already: true }` for it — a 200 that
 * carries no identity and is exactly as useless to an attacker as a 409. What
 * matters is whether an identity came back, so that is what is asserted.
 */
const letIn = (body) => !!(body?.review_access || body?.me || idsIn(body).length);
const freshDevice = () => `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

let demoId = null;
let otherId = null;

before(async () => {
  await post('/me', { id: 'mem_bootstrap0000000000', name: 'Bootstrap' }, envOff);
  const demo = await read(await post('/me', { id: freshDevice(), name: 'NUM Review', phone: DEMO_PHONE }, envOff));
  demoId = demo.body.me.id;
  const other = await read(await post('/me', { id: freshDevice(), name: 'Somebody Else', phone: OTHER_PHONE }, envOff));
  otherId = other.body.me.id;
  assert.ok(demoId && otherId, 'fixture setup failed');
  // The checklist says the demo number is verified. Verified closes the
  // recovery branch — so this is the state the grant has to survive.
  db.prepare('UPDATE num_members SET phone_verified=1 WHERE id=?').run(demoId);
});

const attemptsOf = (id) => db.prepare('SELECT attempts FROM num_members WHERE id=?').get(id).attempts;
const resetAttempts = (id) => db.prepare('UPDATE num_members SET attempts=0 WHERE id=?').run(id);

// ── 1. it works, on a clean device, with SMS dead ──────────────────────────

describe('the reviewer gets in', () => {
  test('a fresh install on the demo number is told a code is waiting — and handed no ID', async () => {
    const { status, body } = await read(await post('/me', { id: freshDevice(), name: 'Apple Review', phone: DEMO_PHONE }));
    assert.equal(status, 202, JSON.stringify(body));
    assert.equal(body.recovery, 'code_sent');
    assert.equal(body.verification.channel, 'review');
    assert.deepEqual(idsIn(body), [], `/me leaked an ID: ${JSON.stringify(body)}`);
  });

  test('the App Store Connect code finishes the sign-in and returns the demo account', async () => {
    resetAttempts(demoId);
    const { status, body } = await read(await post('/verify', { phone: DEMO_PHONE, code: CODE }));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.review_access, true);
    assert.equal(body.me.id, demoId);
    assert.equal(body.me.name, 'NUM Review');
  });

  test('the ID it returns actually works — the reviewer sees a populated account', async () => {
    const res = await handleSocialSafe(
      new Request(`https://app.itsnum.com/api/social/friends?me=${demoId}`), envOn, '/friends',
    );
    assert.equal(res.status, 200);
  });

  test('signing in does not deface the demo account the way the old recovery branch did', async () => {
    const row = db.prepare('SELECT name, phone, phone_verified FROM num_members WHERE id=?').get(demoId);
    assert.equal(row.name, 'NUM Review', 'the caller’s name must not be written onto the account');
    assert.equal(row.phone, DEMO_PHONE);
    assert.equal(row.phone_verified, 1, 'the grant must not change what we claim about the number');
  });

  test('it is repeatable — a reviewer on a second device is not locked out', async () => {
    const first = await read(await post('/me', { id: freshDevice(), name: 'Apple Review 2', phone: DEMO_PHONE }));
    assert.equal(first.status, 202);
    const { status, body } = await read(await post('/verify', { phone: DEMO_PHONE, code: CODE }));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.me.id, demoId);
  });

  test('every use is written down', async () => {
    const rows = db.prepare("SELECT member_id, ua_hash FROM num_identity_signals WHERE ua_hash LIKE 'review-grant:%'").all();
    assert.ok(rows.some((r) => r.ua_hash === 'review-grant:me:code_pending'), 'no audit row for the /me step');
    assert.ok(rows.some((r) => r.ua_hash === 'review-grant:verify:granted'), 'no audit row for the granted sign-in');
  });
});

// ── 2. it does nothing for anybody else ────────────────────────────────────

describe('it is one account, not a mode', () => {
  test('another member’s number gets the ordinary fail-closed answer, not the grant', async () => {
    const { status, body } = await read(await post('/me', { id: freshDevice(), name: 'Mallory', phone: OTHER_PHONE }));
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body.recovery, 'unavailable');
    assert.deepEqual(idsIn(body), [], `another member’s ID leaked: ${JSON.stringify(body)}`);
  });

  test('the reviewer code presented against another member’s number returns nothing', async () => {
    resetAttempts(otherId);
    const { body } = await read(await post('/verify', { phone: OTHER_PHONE, code: CODE }));
    assert.equal(letIn(body), false, `the grant was steered onto another account: ${JSON.stringify(body)}`);
    assert.deepEqual(idsIn(body), [], `another member’s ID leaked: ${JSON.stringify(body)}`);
    assert.equal(db.prepare('SELECT phone_verified FROM num_members WHERE id=?').get(otherId).phone_verified, 0);
  });

  test('replay: the exact sequence that works for the demo number never yields another member’s ID', async () => {
    // Two shapes of "another number": one that belongs to an existing member
    // (the takeover target), and ones that belong to nobody. The second kind
    // legitimately mints the CALLER's own account — that is signup, not a
    // takeover — so what is asserted is that no EXISTING member's identity
    // ever comes back, and that /verify never releases one.
    for (const phone of [OTHER_PHONE, '+66819990000', '+15550001111']) {
      const mine = await read(await post('/me', { id: freshDevice(), name: 'Mallory', phone }));
      const two = await read(await post('/verify', { phone, code: CODE }));
      const seen = idsIn(mine.body).concat(idsIn(two.body));
      assert.ok(!seen.includes(demoId), `${phone} yielded the demo account: ${JSON.stringify(mine.body)}`);
      assert.ok(!seen.includes(otherId), `${phone} yielded another member: ${JSON.stringify(mine.body)}`);
      assert.equal(letIn(two.body), false, `${phone} /verify released an identity: ${JSON.stringify(two.body)}`);
    }
  });

  test('the member pin is enforced when it is set', async () => {
    const pinned = { ...envOn, REVIEW_DEMO_MEMBER: 'mem_notthedemoaccount' };
    const one = await read(await post('/me', { id: freshDevice(), name: 'Apple Review', phone: DEMO_PHONE }, pinned));
    assert.notEqual(one.status, 202, `pin ignored on /me: ${JSON.stringify(one.body)}`);
    const two = await read(await post('/verify', { phone: DEMO_PHONE, code: CODE }, pinned));
    assert.equal(letIn(two.body), false, `pin ignored on /verify: ${JSON.stringify(two.body)}`);
  });

  test('the pin passes when it names the demo account', async () => {
    resetAttempts(demoId);
    const pinned = { ...envOn, REVIEW_DEMO_MEMBER: demoId };
    const { status, body } = await read(await post('/verify', { phone: DEMO_PHONE, code: CODE }, pinned));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.me.id, demoId);
  });
});

// ── 3. off is off ──────────────────────────────────────────────────────────

describe('the flag defaults off, and fails off', () => {
  test('with no secrets set, the demo number is just another taken number', async () => {
    const one = await read(await post('/me', { id: freshDevice(), name: 'Apple Review', phone: DEMO_PHONE }, envOff));
    assert.notEqual(one.status, 202, `the grant ran with the flag off: ${JSON.stringify(one.body)}`);
    assert.deepEqual(idsIn(one.body), []);
  });

  test('with no secrets set, the code is worth nothing', async () => {
    resetAttempts(demoId);
    const { body } = await read(await post('/verify', { phone: DEMO_PHONE, code: CODE }, envOff));
    assert.equal(letIn(body), false, `the grant ran with the flag off: ${JSON.stringify(body)}`);
  });

  const halves = [
    ['phone only', { REVIEW_DEMO_PHONE: DEMO_PHONE }],
    ['code only', { REVIEW_DEMO_CODE: CODE }],
    ['no expiry', { REVIEW_DEMO_PHONE: DEMO_PHONE, REVIEW_DEMO_CODE: CODE }],
    ['expired', { REVIEW_DEMO_PHONE: DEMO_PHONE, REVIEW_DEMO_CODE: CODE, REVIEW_ACCESS_UNTIL: PAST }],
    ['unparseable expiry', { REVIEW_DEMO_PHONE: DEMO_PHONE, REVIEW_DEMO_CODE: CODE, REVIEW_ACCESS_UNTIL: 'soon' }],
    ['code too short to be a secret', { REVIEW_DEMO_PHONE: DEMO_PHONE, REVIEW_DEMO_CODE: '123456', REVIEW_ACCESS_UNTIL: FUTURE }],
    ['empty code', { REVIEW_DEMO_PHONE: DEMO_PHONE, REVIEW_DEMO_CODE: '   ', REVIEW_ACCESS_UNTIL: FUTURE }],
  ];
  for (const [label, extra] of halves) {
    test(`${label} → no grant`, async () => {
      resetAttempts(demoId);
      const env = { ...base, ...extra };
      const one = await read(await post('/me', { id: freshDevice(), name: 'Apple Review', phone: DEMO_PHONE }, env));
      assert.notEqual(one.status, 202, `${label} produced a grant: ${JSON.stringify(one.body)}`);
      const two = await read(await post('/verify', { phone: DEMO_PHONE, code: extra.REVIEW_DEMO_CODE ?? CODE }, env));
      assert.equal(letIn(two.body), false, `${label} let a caller in: ${JSON.stringify(two.body)}`);
      assert.equal(letIn(one.body), false, `${label} leaked on /me: ${JSON.stringify(one.body)}`);
    });
  }
});

// ── 4. the code is still a code ────────────────────────────────────────────

describe('guessing it is not cheaper than guessing an OTP', () => {
  test('a wrong code gets nothing, and the attempt is counted', async () => {
    resetAttempts(demoId);
    const { status, body } = await read(await post('/verify', { phone: DEMO_PHONE, code: 'NUM-REVIEW-WRONGWRONG' }));
    assert.equal(status, 400, JSON.stringify(body));
    assert.deepEqual(idsIn(body), []);
    assert.equal(attemptsOf(demoId), 1);
  });

  test('the 5-attempt cap applies to the grant exactly as it does to an OTP', async () => {
    resetAttempts(demoId);
    for (let i = 0; i < 5; i++) await post('/verify', { phone: DEMO_PHONE, code: `NUM-REVIEW-WRONG-${i}` });
    const capped = await read(await post('/verify', { phone: DEMO_PHONE, code: CODE }));
    assert.equal(capped.status, 429, `the cap did not hold: ${JSON.stringify(capped.body)}`);
    assert.deepEqual(idsIn(capped.body), []);
    resetAttempts(demoId);
    const after = await read(await post('/verify', { phone: DEMO_PHONE, code: CODE }));
    assert.equal(after.status, 200, 'a reset should let the real code back in');
  });

  test('the grant is reachable only by the phone path — an ID plus the code is not a way in', async () => {
    resetAttempts(demoId);
    const { body } = await read(await post('/verify', { id: demoId, code: CODE }));
    assert.equal(letIn(body), false, `the id path accepted the review code: ${JSON.stringify(body)}`);
  });
});
