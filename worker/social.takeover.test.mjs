// Account takeover through the recovery branch of POST /api/social/me.
//
// The bug these tests pin, stated as the attacker would:
//
//   POST /api/social/me { name: "x", phone: "<victim's number>", verify: false }
//     → 200 { me: { id: "mem_…" }, recovered: true }
//
// One request, no secret, no relationship with the victim, and no text to warn
// them — because `verify: false` is a flag the ATTACKER sets. That member ID is
// the credential on every other route in this file and in pay.mjs, dm.mjs and
// account.mjs: Stars transfer, tab settlement, DM read, profile patch, account
// delete. Precondition was `phone_verified = 0`, which was 125 of 125 members.
// (security/THREAT_MODEL.md SEC-006 × SEC-001.)
//
// These are not regexes over the source. Nineteen of the fifty test files in
// this repo assert on the TEXT of the module they cover, which passes happily
// when the code is right-looking and wrong. Everything below imports
// handleSocialSafe and drives real HTTP requests against a real SQLite
// database with the real schema, then asserts on the real response bodies —
// so a reintroduction of the hole fails here whatever it is spelled like.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSocialSafe } from './social.mjs';

// ── a D1 that is actually SQLite ───────────────────────────────────────────
//
// The alternative — a hand-written fake that returns canned rows — cannot
// catch the thing that matters here, because the takeover is decided by which
// row a WHERE clause finds. So the queries really run.

function d1(db) {
  // Statements compile at EXECUTION time, not at prepare() time — D1 does the
  // same, and ensure() depends on it: it prepares `CREATE INDEX … ON
  // num_members` in the same map() that prepares the CREATE TABLE it needs.
  // Async, because D1 is: the code under test writes
  // `.run().catch(() => {})` on the migrations it expects to fail.
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

// The referral ledger belongs to the num-claim Worker, which owns its own
// schema in the same num-db. social.mjs writes a member's code into it during
// signup, inside the same batch as the member row — so without it here every
// signup fails and none of the assertions below would mean anything.
db.exec(`CREATE TABLE IF NOT EXISTS num_referral_codes (
  code TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, reward_cs INTEGER, reward_referee_cs INTEGER,
  max_conversions INTEGER, max_reward_total_cs INTEGER, active INTEGER, created_at INTEGER)`);

const env = {
  DB: d1(db),
  NUM_APP_ORIGIN: 'https://app.itsnum.com',
  // Present so sendCode() takes the Twilio path; the fetch below answers it.
  TWILIO_SID: 'ACtest', TWILIO_TOKEN: 'token', TWILIO_FROM: '+15550000000',
};

// Every text that "went out", so a test can assert one was sent and read the
// code out of it exactly as the owner of the phone would.
const outbox = [];
let smsWorks = true;

globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.twilio.com')) throw new Error(`unexpected fetch: ${url}`);
  const form = new URLSearchParams(init.body);
  if (!smsWorks) {
    return new Response(JSON.stringify({ code: 30034, message: 'unregistered A2P 10DLC campaign' }), { status: 400 });
  }
  outbox.push({ to: form.get('To'), body: form.get('Body'), code: form.get('Body').match(/\b(\d{6})\b/)?.[1] });
  return new Response(JSON.stringify({ sid: `SM${outbox.length}` }), { status: 201 });
};

const post = (path, body) =>
  handleSocialSafe(
    new Request(`https://app.itsnum.com/api/social${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify(body),
    }),
    env,
    path,
  );

const get = (path) =>
  handleSocialSafe(new Request(`https://app.itsnum.com/api/social${path}`), env, path.split('?')[0]);

const read = async (res) => ({ status: res.status, body: await res.json() });

/** Anything in a response body that could be used as `?me=`. */
const idsIn = (body) => JSON.stringify(body).match(/mem_[a-f0-9]{8,}/g) ?? [];

/** A victim: signed up, unverified — the state 125 of 125 members are in. */
async function victim(phone, name = 'Victim') {
  smsWorks = false; // signup must not depend on SMS working
  const { body } = await read(await post('/me', { id: `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, name, phone }));
  smsWorks = true;
  assert.ok(body.me?.id, `victim setup failed: ${JSON.stringify(body)}`);
  const row = db.prepare('SELECT phone_verified FROM num_members WHERE id=?1').get(body.me.id);
  assert.equal(row.phone_verified, 0, 'victim should be unverified — that is the precondition under test');
  return body.me.id;
}

before(async () => {
  // Force the lazy schema/migrations through once before any assertions.
  await post('/me', { id: 'mem_bootstrap0000000000', name: 'Bootstrap' });
});

// ── the exploit, verbatim ──────────────────────────────────────────────────

describe('the takeover request itself', () => {
  test('phone + verify:false does not return the victim’s member ID', async () => {
    const target = await victim('+66811110001');
    const { status, body } = await read(await post('/me', { id: 'mem_attacker00000001', name: 'Mallory', phone: '+66811110001', verify: false }));

    assert.ok(!idsIn(body).includes(target), `the response handed back the victim's ID: ${JSON.stringify(body)}`);
    assert.equal(body.me, undefined, 'a `me` object came back to a caller who proved nothing');
    assert.notEqual(status, 200, 'the takeover request still answers 200 OK');
    assert.equal(body.recovered ?? false, false);
  });

  test('verify:false cannot silence the owner — the text goes anyway', async () => {
    await victim('+66811110002');
    const before = outbox.length;
    await post('/me', { id: 'mem_attacker00000002', name: 'Mallory', phone: '+66811110002', verify: false });
    assert.equal(outbox.length, before + 1, 'no SMS was sent — the owner is not told their account is being claimed');
    assert.equal(outbox.at(-1).to, '+66811110002', 'the code went somewhere other than the number on the account');
  });

  test('no bearer ID is leaked even when the SMS does go out', async () => {
    const target = await victim('+66811110003');
    const { status, body } = await read(await post('/me', { name: 'Mallory', phone: '+66811110003' }));
    assert.equal(status, 202, 'recovery should answer 202 accepted, not a success carrying an identity');
    assert.equal(body.recovery, 'code_sent');
    assert.ok(!idsIn(body).includes(target), 'the ID came back with the code — the code is then pointless');
    assert.equal(body.ref, undefined, 'the referral code came back; it is a share credential of the victim');
  });

  test('the victim’s profile is not written to by the attempt', async () => {
    const target = await victim('+66811110004', 'Real Name');
    await post('/me', { id: 'mem_attacker00000004', name: 'Mallory', phone: '+66811110004', verify: false });
    const row = db.prepare('SELECT name FROM num_members WHERE id=?1').get(target);
    assert.equal(row.name, 'Real Name', 'the attacker’s name was written onto the victim’s account');
  });

  test('the refused attempt is recorded', async () => {
    await victim('+66811110005');
    await post('/me', { id: 'mem_attacker00000005', name: 'Mallory', phone: '+66811110005', verify: false });
    const hit = db.prepare("SELECT COUNT(*) n FROM num_identity_signals WHERE device_id='mem_attacker00000005' AND ua_hash LIKE 'blocked:phone:%'").get();
    assert.ok(hit.n >= 1, 'nothing was written down, so nobody can see this happening');
  });
});

// ── the flag cannot be smuggled back in ────────────────────────────────────

describe('the fix cannot be talked around', () => {
  const variants = [
    ['string false', { verify: 'false' }],
    ['capital False', { verify: 'False' }],
    ['zero', { verify: 0 }],
    ['null', { verify: null }],
    ['empty string', { verify: '' }],
    ['array', { verify: [false] }],
    ['object', { verify: { valueOf: () => false } }],
    ['odd casing of the key', { Verify: false, VERIFY: false, verifY: false }],
    ['extra fields alongside it', { verify: false, recovered: true, phone_verified: 1, me: { id: 'mem_attacker00000009' } }],
    ['prototype-ish key', { verify: false, __proto__: { verify: false } }],
  ];

  for (const [label, extra] of variants) {
    test(`${label} still refuses to hand over the ID`, async () => {
      const phone = `+6681112${String(2000 + variants.findIndex(([l]) => l === label)).padStart(4, '0')}`;
      const target = await victim(phone);
      const before = outbox.length;
      const { status, body } = await read(await post('/me', { id: 'mem_attacker0000000x', name: 'Mallory', phone, ...extra }));
      assert.ok(!idsIn(body).includes(target), `"${label}" got the ID back: ${JSON.stringify(body)}`);
      assert.ok(status === 202 || status === 503, `"${label}" produced an unexpected status ${status}`);
      if (status === 202) assert.ok(outbox.length > before, `"${label}" suppressed the SMS`);
    });
  }

  test('knowing the number does not let a second account adopt it either', async () => {
    const target = await victim('+66811110020');
    await post('/me', { id: 'mem_attacker00000020', name: 'Mallory' });               // attacker has their own account
    const { body } = await read(await post('/me', { id: 'mem_attacker00000020', phone: '+66811110020' }));
    assert.ok(!idsIn(body).includes(target));
    const still = db.prepare('SELECT phone FROM num_members WHERE id=?1').get(target);
    assert.equal(still.phone, '+66811110020', 'the victim’s number was moved off their account');
  });
});

// ── the real user still gets back in ───────────────────────────────────────

describe('genuine recovery', () => {
  test('number → code → ID, and the account comes back whole', async () => {
    const target = await victim('+66811110030', 'Returning Member');

    // New phone, no stored ID: all they can do is claim the number.
    const first = await read(await post('/me', { name: 'Returning Member', phone: '+66811110030' }));
    assert.equal(first.status, 202);
    assert.equal(first.body.verification.sent, true);
    assert.ok(!idsIn(first.body).includes(target), 'the ID was handed over before the code was presented');

    // They read the text — which only the holder of the number can do.
    const code = outbox.at(-1).code;
    assert.match(code, /^\d{6}$/);

    const done = await read(await post('/verify', { phone: '+66811110030', code }));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.me.id, target, 'recovery returned a different account than the one holding the number');
    assert.equal(done.body.phone_verified, true);
    assert.equal(done.body.me.name, 'Returning Member');

    // And the ID now works, which is what "back in" means.
    const friends = await read(await get(`/friends?me=${target}`));
    assert.equal(friends.status, 200);
  });

  test('a wrong code gets nothing, and the attempts cap holds', async () => {
    await victim('+66811110031');
    await post('/me', { name: 'Mallory', phone: '+66811110031' });
    for (let i = 0; i < 5; i++) {
      const { status, body } = await read(await post('/verify', { phone: '+66811110031', code: '000000' }));
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(body.me, undefined, 'a wrong code still returned an identity');
    }
    const { status } = await read(await post('/verify', { phone: '+66811110031', code: '000000' }));
    assert.equal(status, 429, 'the attempt cap does not apply to the phone path — the code is brute-forceable');
  });

  test('an unknown number reveals nothing about who is on Num', async () => {
    const { status, body } = await read(await post('/verify', { phone: '+66899999999', code: '123456' }));
    assert.equal(status, 404);
    assert.equal(body.me, undefined);
  });

  test('when SMS cannot deliver, recovery fails CLOSED', async () => {
    const target = await victim('+66811110032');
    smsWorks = false;
    const { status, body } = await read(await post('/me', { name: 'Mallory', phone: '+66811110032' }));
    smsWorks = true;
    assert.equal(status, 503, 'a member was handed over on a path where nobody could be warned');
    assert.ok(!idsIn(body).includes(target));
    assert.equal(body.recovery, 'unavailable');
  });
});

// ── and the front door still opens ─────────────────────────────────────────

describe('onboarding is untouched', () => {
  test('a brand-new number signs up and gets its ID, code or no code', async () => {
    const id = 'mem_newcomer00000001';
    const { status, body } = await read(await post('/me', { id, name: 'Newcomer', phone: '+66811110040' }));
    assert.equal(status, 200);
    assert.equal(body.me.id, id, 'a new signup no longer gets its own ID back');
    assert.equal(body.me.phone, '+66811110040');
    assert.ok(body.ref, 'no referral code was minted for a new member');
    assert.equal(body.verification.sent, true);
  });

  test('a brand-new number still signs up when SMS is down', async () => {
    smsWorks = false;
    const { status, body } = await read(await post('/me', { id: 'mem_newcomer00000002', name: 'Newcomer Two', phone: '+66811110041' }));
    smsWorks = true;
    assert.equal(status, 200, 'onboarding was made to depend on a working SMS provider');
    assert.equal(body.me.id, 'mem_newcomer00000002');
    assert.equal(body.verification.sent, false);
  });

  test('verify:false is still honoured for a NEW number — no account exists to take over', async () => {
    const before = outbox.length;
    const { status, body } = await read(await post('/me', { id: 'mem_newcomer00000003', name: 'Newcomer Three', phone: '+66811110042', verify: false }));
    assert.equal(status, 200);
    assert.equal(body.me.id, 'mem_newcomer00000003');
    assert.equal(outbox.length, before, 'a member who asked not to be texted was texted anyway');
  });

  test('an existing member patching their own profile is unaffected', async () => {
    const id = 'mem_newcomer00000004';
    await post('/me', { id, name: 'Patcher', phone: '+66811110043', verify: false });
    const { status, body } = await read(await post('/me', { id, bio: { diet: 'no shellfish' }, dest: 'Phuket' }));
    assert.equal(status, 200);
    assert.equal(body.me.id, id);
    assert.deepEqual(body.me.bio, { diet: 'no shellfish' });
  });

  test('a verified number stays shut, as it always did', async () => {
    const id = 'mem_verified00000001';
    await post('/me', { id, name: 'Verified', phone: '+66811110050' });
    const code = outbox.at(-1).code;
    await post('/verify', { id, code });
    assert.equal(db.prepare('SELECT phone_verified v FROM num_members WHERE id=?1').get(id).v, 1);

    const { status, body } = await read(await post('/me', { id: 'mem_attacker00000050', name: 'Mallory', phone: '+66811110050', verify: false }));
    assert.equal(status, 409);
    assert.ok(!idsIn(body).includes(id));
  });

  test('the ordinary verify path does not start handing out IDs', async () => {
    const id = 'mem_verified00000002';
    await post('/me', { id, name: 'Ordinary', phone: '+66811110051' });
    const { body } = await read(await post('/verify', { id, code: outbox.at(-1).code }));
    assert.equal(body.ok, true);
    assert.equal(body.me, undefined, 'the id-based verify path now returns an identity object it never used to');
  });
});
