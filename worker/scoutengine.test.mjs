// The scout programme, run against a real SQLite rather than a mock.
//
// The schema in migrations/0006_scouts.sql already enforces the economics.
// These tests cover the code on top of it, and the rule they exist to protect
// is the same one: NOTHING IS PAID FOR A SIGNATURE. A finder's fee is released
// only once the business has produced real revenue, and open sign-up means
// every guard below is load-bearing rather than tidy.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MONTHLY_CLAIM_CAP, TERMS_VERSION, CODE_ALPHABET, CODE_LENGTH, STATE_MEANING,
  mintCode, normaliseCode, enrol, introduce, markVerified, recordRevenue,
  dashboard, claimsThisMonth, scoutByCode, scoutCodeFrom, handleScoutLink,
} from './scouts.mjs';

const SCHEMA = readFileSync(fileURLToPath(new URL('./migrations/0006_scouts.sql', import.meta.url)), 'utf8');
// 0032 adds referral attribution and the one-level override, and widens the
// earnings `kind` list. Loaded here so these tests run against the schema
// production actually has rather than the one it had in August.
const SCHEMA_REFERRALS = readFileSync(fileURLToPath(new URL('./migrations/0032_scout_referrals.sql', import.meta.url)), 'utf8');

/** A D1-shaped wrapper over node:sqlite, enough for this module. */
function makeEnv() {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec(SCHEMA_REFERRALS);
  d.exec(`CREATE TABLE IF NOT EXISTS num_place_owners (
    place_id TEXT PRIMARY KEY, business_id TEXT, claim_id TEXT, method TEXT,
    phone TEXT, member_ref TEXT, verified_at TEXT, revoked_at TEXT)`);
  d.exec(`CREATE TABLE IF NOT EXISTS num_referral_conversions (
    id TEXT PRIMARY KEY, referrer_id TEXT)`);
  d.exec(`INSERT INTO num_scout_terms (version, body, effective_at)
          VALUES ('v1','The terms.','2026-08-01')`);

  const prep = (sql) => {
    let args = [];
    const api = {
      bind: (...a) => { args = a; return api; },
      first: async () => d.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: d.prepare(sql).all(...args) }),
      run: async () => d.prepare(sql).run(...args),
      _exec: () => d.prepare(sql).run(...args),
    };
    return api;
  };
  return {
    DB: {
      prepare: prep,
      batch: async (stmts) => { for (const s of stmts) s._exec(); },
    },
    _raw: d,
  };
}

const NOW = new Date('2026-09-15T12:00:00Z');

async function aScout(env, over = {}) {
  const r = await enrol(env, { name: 'Sean', email: `s${Math.random()}@num.test`, ...over, now: NOW });
  assert.equal(r.ok, true, r.why);
  return r;
}

describe('the code on the card', () => {
  test('it avoids every character a person misreads aloud', () => {
    // The card gets tapped; when the tap fails it gets spelled across a
    // counter in a loud bar. 0/O and 1/I/L are what go wrong there.
    for (const bad of ['0', '1', 'O', 'I', 'L']) {
      assert.equal(CODE_ALPHABET.includes(bad), false, `${bad} is in the alphabet`);
    }
  });

  test('a minted code is always readable back', () => {
    for (let i = 0; i < 200; i += 1) {
      const c = mintCode();
      assert.equal(c.length, CODE_LENGTH);
      assert.equal(normaliseCode(c.toLowerCase()), c);
    }
  });

  test('spaces and punctuation are forgiven', () => {
    assert.equal(normaliseCode('  ab-3d9 '), 'AB3D9');
  });

  test('a code containing an excluded character is refused, not guessed', () => {
    // An earlier version mapped O onto 0 and I onto 1 to be helpful. Neither
    // is in the alphabet either, so it produced codes that can never exist and
    // turned a typo into a silent lookup miss.
    for (const bad of ['AB0D9', 'ABOD9', 'AB1D9', 'ABID9', 'ABLD9']) {
      assert.equal(normaliseCode(bad), null, bad);
    }
  });

  test('rubbish is null', () => {
    for (const bad of ['', null, undefined, '!!', 'QWE', 'A'.repeat(20)]) {
      assert.equal(normaliseCode(bad), null);
    }
  });
});

describe('enrolling, which anyone may do', () => {
  test('a scout gets a code and the terms they agreed to', async () => {
    const env = makeEnv();
    const r = await aScout(env);
    assert.match(r.code, new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`));
    assert.equal(r.termsVersion, TERMS_VERSION);
  });

  test('the agreement is recorded with a version and a moment, not a memory', async () => {
    const env = makeEnv();
    const r = await aScout(env, { ip: '203.0.113.9' });
    const row = env._raw.prepare('SELECT * FROM num_scouts WHERE id=?').get(r.id);
    assert.equal(row.terms_version, 'v1');
    assert.equal(row.agreed_at, NOW.toISOString());
    assert.equal(row.agreed_ip, '203.0.113.9');
  });

  test('the cap is written onto the row, because a NULL nobody reads is not a cap', async () => {
    const env = makeEnv();
    const r = await aScout(env);
    const row = env._raw.prepare('SELECT monthly_claim_cap FROM num_scouts WHERE id=?').get(r.id);
    assert.equal(row.monthly_claim_cap, MONTHLY_CLAIM_CAP);
  });

  test('signing up twice returns the same code rather than a lecture', async () => {
    const env = makeEnv();
    const a = await enrol(env, { name: 'Sean', email: 'sean@num.test', now: NOW });
    const b = await enrol(env, { name: 'Sean again', email: 'SEAN@NUM.TEST', now: NOW });
    assert.equal(b.ok, true);
    assert.equal(b.already, true);
    assert.equal(b.code, a.code);
  });

  test('a rubbish email is refused', async () => {
    const env = makeEnv();
    for (const em of ['', 'nope', 'a@b', 'a b@c.d']) {
      const r = await enrol(env, { name: 'X', email: em, now: NOW });
      assert.equal(r.ok, false, em);
    }
  });

  test('nobody can agree to terms that do not exist', async () => {
    const env = makeEnv();
    const r = await enrol(env, { name: 'X', email: 'x@num.test', termsVersion: 'v99', now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /terms are not published/);
  });

  test('a blocked scout cannot re-enrol under the same email', async () => {
    const env = makeEnv();
    const a = await aScout(env, { email: 'bad@num.test' });
    env._raw.prepare("UPDATE num_scouts SET status='blocked' WHERE id=?").run(a.id);
    const b = await enrol(env, { name: 'X', email: 'bad@num.test', now: NOW });
    assert.equal(b.ok, false);
    assert.match(b.why, /blocked/);
  });
});

describe('bringing a business', () => {
  test('an introduction earns nothing, and says so', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    const r = await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: "Joe's Tacos", now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'introduced');
    assert.equal(r.owed, 0);
    assert.match(r.note, /Nothing is owed yet/);
    const earnings = env._raw.prepare('SELECT COUNT(*) n FROM num_scout_earnings').get();
    assert.equal(earnings.n, 0);
  });

  test('the rates are copied onto the row, not referenced', async () => {
    // A scout who joined in August is owed August's terms whatever the
    // programme does later.
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    // Legal values on purpose: the schema caps finder_cents at 5000 and
    // requires finder_cents <= finder_gate_minor, and it refused 9999 when
    // this test first tried it. The constraint is doing its job; the test was
    // wrong. A programme rate change has to stay inside the same rails.
    env._raw.prepare('UPDATE num_scouts SET finder_cents=4000, finder_gate_minor=5000, share_bps=5000').run();
    const row = env._raw.prepare('SELECT * FROM num_scout_places WHERE place_id=?').get('p1');
    assert.equal(row.finder_cents, 500);
    assert.equal(row.share_bps, 2000);
  });

  test('the second scout to reach a place is told it is taken', async () => {
    const env = makeEnv();
    const a = await aScout(env, { email: 'a@num.test' });
    const b = await aScout(env, { email: 'b@num.test' });
    await introduce(env, { scoutId: a.id, placeId: 'p1', bizName: 'A', now: NOW });
    const r = await introduce(env, { scoutId: b.id, placeId: 'p1', bizName: 'A', now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /another Num Expert introduced this business first/);
  });

  test('the same scout twice is not an error, just already done', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    const r = await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.already, true);
  });

  test('a business already on Num cannot be claimed as a find', async () => {
    // Paying for a customer we already had is leakage, not growth.
    const env = makeEnv();
    const s = await aScout(env);
    env._raw.prepare('INSERT INTO num_place_owners (place_id, business_id) VALUES (?,?)').run('p9', 'biz1');
    const r = await introduce(env, { scoutId: s.id, placeId: 'p9', bizName: 'A', now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /already on Num/);
  });

  test('a revoked owner does not block a fresh introduction', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    env._raw.prepare('INSERT INTO num_place_owners (place_id, business_id, revoked_at) VALUES (?,?,?)')
      .run('p9', 'biz1', '2026-01-01');
    const r = await introduce(env, { scoutId: s.id, placeId: 'p9', bizName: 'A', now: NOW });
    assert.equal(r.ok, true);
  });

  test('a paused scout cannot introduce anything', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    env._raw.prepare("UPDATE num_scouts SET status='paused' WHERE id=?").run(s.id);
    const r = await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /not an active Num Expert/);
  });
});

describe('the cap that open sign-up makes necessary', () => {
  test('a scout is stopped at the monthly cap', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    env._raw.prepare('UPDATE num_scouts SET monthly_claim_cap=3 WHERE id=?').run(s.id);
    for (let i = 0; i < 3; i += 1) {
      const r = await introduce(env, { scoutId: s.id, placeId: `p${i}`, bizName: 'A', now: NOW });
      assert.equal(r.ok, true, `intro ${i}`);
    }
    const over = await introduce(env, { scoutId: s.id, placeId: 'p99', bizName: 'A', now: NOW });
    assert.equal(over.ok, false);
    assert.match(over.why, /cap of 3/);
    assert.equal(over.used, 3);
  });

  test('the cap is per month, not forever', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    env._raw.prepare('UPDATE num_scouts SET monthly_claim_cap=2 WHERE id=?').run(s.id);
    await introduce(env, { scoutId: s.id, placeId: 'a', bizName: 'A', now: NOW });
    await introduce(env, { scoutId: s.id, placeId: 'b', bizName: 'A', now: NOW });
    const next = new Date('2026-10-02T00:00:00Z');
    const r = await introduce(env, { scoutId: s.id, placeId: 'c', bizName: 'A', now: next });
    assert.equal(r.ok, true);
    assert.equal(await claimsThisMonth(env, s.id, next), 1);
  });

  test('a voided introduction does not burn a slot', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'a', bizName: 'A', now: NOW });
    env._raw.prepare("UPDATE num_scout_places SET state='void' WHERE place_id='a'").run();
    assert.equal(await claimsThisMonth(env, s.id, NOW), 0);
  });
});

describe('a signature is not money', () => {
  test('verifying moves the state and pays nothing', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    const r = await markVerified(env, { placeId: 'p1', claimId: 'acl_1', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'verified');
    assert.equal(r.owed, 0);
    assert.equal(env._raw.prepare('SELECT COUNT(*) n FROM num_scout_earnings').get().n, 0);
  });

  test('revenue under the gate still pays nothing', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    const r = await recordRevenue(env, { placeId: 'p1', amountMinor: 499, now: NOW });
    assert.equal(r.activated, false);
    assert.equal(r.revenue_minor, 499);
    assert.equal(env._raw.prepare('SELECT COUNT(*) n FROM num_scout_earnings').get().n, 0);
  });

  test('crossing the gate activates and releases the finder fee', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    await recordRevenue(env, { placeId: 'p1', amountMinor: 300, now: NOW });
    const r = await recordRevenue(env, { placeId: 'p1', amountMinor: 250, now: NOW });
    assert.equal(r.activated, true);
    assert.equal(r.state, 'activated');
    const e = env._raw.prepare("SELECT * FROM num_scout_earnings WHERE kind='finder'").get();
    assert.equal(e.amount_minor, 500);
    assert.equal(e.gross_minor, 550);
    assert.ok(e.amount_minor <= e.gross_minor, 'paid more than was collected');
  });

  test('the term clock starts at activation, not at the signature', async () => {
    // A venue that takes four months to switch on should not burn a sixth of
    // the scout's term sitting idle.
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    const later = new Date('2027-01-15T00:00:00Z');
    await recordRevenue(env, { placeId: 'p1', amountMinor: 500, now: later });
    const row = env._raw.prepare('SELECT * FROM num_scout_places WHERE place_id=?').get('p1');
    assert.equal(row.activated_at, later.toISOString());
    assert.match(row.term_ends_at, /^2029-01/);
  });

  test('activation happens exactly once, however much more comes in', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    await recordRevenue(env, { placeId: 'p1', amountMinor: 500, now: NOW });
    await recordRevenue(env, { placeId: 'p1', amountMinor: 5000, now: NOW });
    await recordRevenue(env, { placeId: 'p1', amountMinor: 5000, now: NOW });
    const n = env._raw.prepare("SELECT COUNT(*) n FROM num_scout_earnings WHERE kind='finder'").get().n;
    assert.equal(n, 1, 'the finder fee was released more than once');
  });

  test('revenue for a place with no scout claim is simply not ours to record', async () => {
    const env = makeEnv();
    const r = await recordRevenue(env, { placeId: 'nobody', amountMinor: 900, now: NOW });
    assert.equal(r.ok, false);
  });

  test('a rejected or void claim never activates', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'p1', bizName: 'A', now: NOW });
    env._raw.prepare("UPDATE num_scout_places SET state='void' WHERE place_id='p1'").run();
    const r = await recordRevenue(env, { placeId: 'p1', amountMinor: 5000, now: NOW });
    assert.equal(r.ok, false);
  });
});

describe('what a scout is shown', () => {
  test('counts are per state and the states are explained', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'a', bizName: 'A', now: NOW });
    await introduce(env, { scoutId: s.id, placeId: 'b', bizName: 'B', now: NOW });
    await markVerified(env, { placeId: 'b', now: NOW });
    const d = await dashboard(env, s.id, { now: NOW });
    assert.equal(d.businesses.byState.introduced, 1);
    assert.equal(d.businesses.byState.verified, 1);
    assert.equal(d.businesses.byState.activated, 0);
    assert.equal(d.businesses.meaning.introduced, STATE_MEANING.introduced);
  });

  test('money is read from earnings, never inferred from introductions', async () => {
    // Two introductions times a $5 fee is $10 and would be wrong. The whole
    // programme turns on not showing that number.
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'a', bizName: 'A', now: NOW });
    await introduce(env, { scoutId: s.id, placeId: 'b', bizName: 'B', now: NOW });
    const d = await dashboard(env, s.id, { now: NOW });
    assert.equal(d.money.accrued_minor, 0);
    assert.match(d.money.note, /An introduction on its own is not money/);
  });

  test('once revenue lands, the accrued figure is real', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'a', bizName: 'A', now: NOW });
    await recordRevenue(env, { placeId: 'a', amountMinor: 700, now: NOW });
    const d = await dashboard(env, s.id, { now: NOW });
    assert.equal(d.money.accrued_minor, 500);
  });

  test('the terms shown are the ones they agreed to, with a promise attached', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    const d = await dashboard(env, s.id, { now: NOW });
    assert.equal(d.terms.version, 'v1');
    assert.equal(d.terms.finder_cents, 500);
    assert.match(d.terms.note, /do not change for you if the programme changes/);
  });

  test('the remaining cap is shown, so nobody walks a street they cannot bank', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    await introduce(env, { scoutId: s.id, placeId: 'a', bizName: 'A', now: NOW });
    const d = await dashboard(env, s.id, { now: NOW });
    assert.equal(d.cap.monthly, MONTHLY_CLAIM_CAP);
    assert.equal(d.cap.used, 1);
    assert.equal(d.cap.left, MONTHLY_CLAIM_CAP - 1);
  });

  test('friends are counted only when there is a Num account to count them against', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    const d = await dashboard(env, s.id, { now: NOW });
    assert.equal(d.friends.count, 0);
    assert.match(d.friends.note, /Not linked to a Num account/);
  });

  test('a linked member sees their friend referrals', async () => {
    const env = makeEnv();
    const s = await aScout(env, { memberId: 'mem_1' });
    env._raw.prepare('INSERT INTO num_referral_conversions (id, referrer_id) VALUES (?,?)').run('r1', 'mem_1');
    env._raw.prepare('INSERT INTO num_referral_conversions (id, referrer_id) VALUES (?,?)').run('r2', 'mem_1');
    const d = await dashboard(env, s.id, { now: NOW });
    assert.equal(d.friends.count, 2);
    assert.equal(d.friends.note, null);
  });

  test('one scout can never see another scout’s businesses', async () => {
    const env = makeEnv();
    const a = await aScout(env, { email: 'a@num.test' });
    const b = await aScout(env, { email: 'b@num.test' });
    await introduce(env, { scoutId: a.id, placeId: 'a1', bizName: 'A', now: NOW });
    const d = await dashboard(env, b.id, { now: NOW });
    assert.equal(d.businesses.total, 0);
  });
});

describe('the card', () => {
  // CHANGED 15 Sep 2026. These two used to assert a 302 to /claim, and that
  // assertion was the bug written down: it meant every person who tapped an
  // Expert's card — the tour guide, the traveller, the shop owner — was sent
  // to a business claim form. A card now opens a page with a door for each.
  // See worker/scoutpage.mjs and worker/scoutpage.test.mjs.
  test('a tap sets a first-touch cookie and opens the three-door page', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    const res = await handleScoutLink(new Request('https://itsnum.com/s/' + s.code), env, s.code);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`/claim/?scout=${s.code}`), 'no business door');
    assert.ok(html.includes(`/hosts/?scout=${s.code}`), 'no host door');
    assert.ok(html.includes('/app/'), 'no person door');
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`num_scout=${s.code}`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=7776000/);
  });

  test('an unknown code still opens the page, with nobody attributed', async () => {
    // A mistyped card must not dead-end a business that wants to sign up.
    const env = makeEnv();
    const res = await handleScoutLink(new Request('https://itsnum.com/s/ZZZZZZ'), env, 'ZZZZZZ');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(/scout=/.test(html), false, 'attributed someone on an unknown code');
    assert.ok(html.includes('href="/claim/"'), 'no way to sign up after a typo');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('the query wins over the cookie, so the newest tap is the one that counts', async () => {
    const req = new Request('https://itsnum.com/api/claim?scout=AB3D9', {
      headers: { cookie: 'num_scout=ZZZZZZ' },
    });
    assert.equal(scoutCodeFrom(req, {}), 'AB3D9');
  });

  test('the cookie is used when the link did not carry one', async () => {
    const req = new Request('https://itsnum.com/api/claim', { headers: { cookie: 'a=1; num_scout=AB3D9; b=2' } });
    assert.equal(scoutCodeFrom(req, {}), 'AB3D9');
  });

  test('no attribution anywhere is null, not a guess', () => {
    const req = new Request('https://itsnum.com/api/claim');
    assert.equal(scoutCodeFrom(req, {}), null);
  });

  test('a scout code is only ever resolved for an active scout', async () => {
    const env = makeEnv();
    const s = await aScout(env);
    assert.ok(await scoutByCode(env, s.code));
    env._raw.prepare("UPDATE num_scouts SET status='ended' WHERE id=?").run(s.id);
    assert.equal(await scoutByCode(env, s.code), null);
  });
});

describe('the claim flow carries the attribution', () => {
  const CLAIM = readFileSync(fileURLToPath(new URL('./claim.mjs', import.meta.url)), 'utf8');

  test('the introduction is recorded when the claim STARTS', () => {
    // The last moment the tap and the sign-up are certainly the same visit.
    assert.match(CLAIM, /scoutCodeFrom, scoutByCode, introduce/);
    assert.match(CLAIM, /the last moment we can be sure the tap and the sign-up are the/);
  });

  test('and never fails a real business signing up', () => {
    const slice = CLAIM.slice(CLAIM.indexOf('WHO SENT THEM'), CLAIM.indexOf('async function sendProof'));
    assert.match(slice, /\} catch \{/);
    assert.match(slice, /attribution is never worth failing a claim over/);
  });

  test('verification marks the introduction verified and pays nothing', () => {
    assert.match(CLAIM, /markVerified/);
    assert.match(CLAIM, /built on not paying for signatures/);
  });

  test('the routes exist', () => {
    const IDX = readFileSync(fileURLToPath(new URL('./index.mjs', import.meta.url)), 'utf8');
    assert.match(IDX, /url\.pathname\.startsWith\('\/s\/'\)/);
    assert.match(IDX, /url\.pathname\.startsWith\('\/api\/scouts'\)/);
  });
});
