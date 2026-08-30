// Proving a business is yours — the wiring, and the rules it must not lose.
//
// Context, because it is the point of the file. The public claim form wrote a
// row to `claims` and stopped: no verification, no business record, no
// console, and nothing anywhere that ever moved `claims.state` off 'new'. A
// complete verification worker sat deployed with no routes. Four claim tables,
// an admin queue reading the one nothing populated, 0 business logins.
//
// These tests hold the wiring in place AND re-assert the two rules that make
// the thing proof rather than theatre:
//
//   1. The code goes to a contact ALREADY PUBLISHED on the listing. Never to
//      one typed into the form. Anyone can type an address; only the owner
//      can read the one on the door.
//   2. A listing somebody already proved is CONTESTED, not transferable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { claimStart, claimSend, claimVerify, claimStatus, claimDeps, _resetLinkCache }
  from './claimverify.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = readFileSync(join(HERE, 'claimverify.mjs'), 'utf8');
const WORKER = readFileSync(join(HERE, 'worker.js'), 'utf8');
const PAGE = readFileSync(join(HERE, '..', 'public', 'claim', 'index.html'), 'utf8');

const deps = (sent = []) => claimDeps({
  J: (o, s = 200) => ({ status: s, body: o }),
  clean: (v, n) => String(v ?? '').trim().slice(0, n),
  readJSON: async (req) => req.__body ?? {},
  sendBatch: async (env, msgs) => { sent.push(...msgs); return true; },
  legalLine: '5arz Inc',
});

/** Minimal D1 stand-in. `rows` records every write for inspection. */
function db(fixtures = {}) {
  _resetLinkCache();
  const writes = [];
  const {
    place = null, owner = null, claim = null, rateOk = true,
  } = fixtures;
  const DB = {
    prepare(q) {
      let a = [];
      const stmt = {
        bind: (...x) => { a = x; return stmt; },
        run: async () => { writes.push({ q, a }); return { meta: { changes: 1 } }; },
        first: async () => {
          if (/FROM places/.test(q)) return place;
          if (/num_place_owners/.test(q)) return owner;
          if (/FROM num_claims/.test(q)) return claim;
          if (/COUNT/.test(q)) return rateOk ? { n: 0 } : { n: 999 };
          return null;
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async (s) => { for (const x of s) await x.run(); return []; },
  };
  return { DB, writes };
}

const req = (body = {}) => ({
  __body: body,
  headers: { get: (h) => (h === 'cf-connecting-ip' ? '1.2.3.4' : '') },
});

const PLACE = {
  id: 'p1', name: 'Kan Eang', phone: '+66761234567',
  email: 'book@kaneang.com', website: 'https://kaneang.com', dest: 'phuket',
};

/* ── it is wired at all ─────────────────────────────────────────────────── */

test('all four endpoints are routed, and under the path that already exists', () => {
  // itsnum.com/api/claims* already points at this worker. That is why the
  // fully-built claim worker never needed to be routed separately — and why
  // nobody noticed for three weeks that it had not been.
  for (const p of ['start', 'send', 'verify', 'status']) {
    assert.match(WORKER, new RegExp(`p === "/api/claims/${p}"`), `/api/claims/${p} not routed`);
  }
  assert.ok(
    WORKER.indexOf('p === "/api/claims/start"') < WORKER.indexOf('p === "/api/claims"'),
    'the sub-routes must be tested before the bare /api/claims POST',
  );
});

test('the rules come from the file that already had them', () => {
  // Not reimplemented. Every judgement about what proves ownership is
  // imported from claim/verify.mjs — the tested one.
  assert.match(SRC, /from '\.\.\/claim\/verify\.mjs'/);
  assert.match(SRC, /channelsFor/);
  assert.match(SRC, /sameDomain/);
  assert.match(SRC, /isFreeMail/);
  assert.match(SRC, /rateLimitOk/);
  assert.match(SRC, /onboardStatements/);
});

/* ── the rule that makes it proof ───────────────────────────────────────── */

test('the destination comes from the listing, never from the request', () => {
  const send = SRC.slice(SRC.indexOf('export async function claimSend'), SRC.indexOf('/* ── POST /api/claims/verify'));
  // `pick.value` is the crawled contact. The only branch that reads a
  // submitted address is email_domain, and it is fenced by sameDomain.
  assert.match(send, /let target = pick\.value;/);
  assert.match(send, /if \(pick\.channel === 'email_domain'\)/);
  assert.match(send, /!sameDomain\(addr, dom\) \|\| isFreeMail\(addrDom\)/);
});

test('a free mailbox on someone else\'s domain cannot prove anything', async () => {
  const d = db({ place: PLACE, claim: { id: 'c1', state: 'pending', place_id: 'p1', max_attempts: 5, attempts: 0 } });
  const r = await claimSend(
    req({ claim_id: 'c1', channel: 'email_domain', email: 'someone@gmail.com' }),
    { DB: d.DB, RESEND_KEY: 'x' }, deps(),
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot prove ownership/);
});

test('an address on the listing\'s own domain can', async () => {
  const sent = [];
  const d = db({ place: PLACE, claim: { id: 'c1', state: 'pending', place_id: 'p1', max_attempts: 5, attempts: 0 } });
  const r = await claimSend(
    req({ claim_id: 'c1', channel: 'email_domain', email: 'owner@kaneang.com' }),
    { DB: d.DB, RESEND_KEY: 'x' }, deps(sent),
  );
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['owner@kaneang.com']);
});

test('what comes back is masked, and the code is not in it', async () => {
  const sent = [];
  const d = db({ place: PLACE, claim: { id: 'c1', state: 'pending', place_id: 'p1', max_attempts: 5, attempts: 0 } });
  const r = await claimSend(
    req({ claim_id: 'c1', channel: 'email' }), { DB: d.DB, RESEND_KEY: 'x' }, deps(sent),
  );
  assert.equal(r.status, 200);
  assert.match(r.body.sent_to, /•|\*/, 'the destination came back unmasked');
  // The code exists only in the email and as a salted hash in the row.
  assert.doesNotMatch(JSON.stringify(r.body), /\b\d{6}\b/);
  const stored = d.writes.find((w) => /code_hash=\?4/.test(w.q));
  assert.ok(stored, 'no code hash was stored');
  assert.doesNotMatch(String(stored.a[3]), /^\d{6}$/, 'the code was stored in the clear');
});

/* ── a listing someone already proved ───────────────────────────────────── */

test('a contested listing goes to review, and offers no code channel', async () => {
  const d = db({ place: PLACE, owner: { business_id: 'biz_existing' } });
  const r = await claimStart(req({ place_id: 'p1' }), { DB: d.DB }, deps());
  assert.equal(r.body.contested, true);
  assert.deepEqual(r.body.channels.map((c) => c.channel), ['manual'],
    'a code was offered on a listing somebody already proved');
  assert.match(r.body.note, /current owner is told/i);
  // Bind order: id, place_id, name, email, phone, state, ip, ua, reason.
  const ins = d.writes.find((w) => /INSERT INTO num_claims/.test(w.q));
  assert.equal(ins.a[5], 'review');
  assert.equal(ins.a[8], 'already_claimed');
});

/* ── SMS is not offered, because it cannot be sent ──────────────────────── */

test('a venue with an email and no website can still prove it', async () => {
  // 12,760 venues across our four cities are in exactly this position. The
  // shared channelsFor() offers them nothing, and with no SMS on this worker
  // that would have meant no self-service verification at all.
  const d = db({ place: { id: 'p9', name: 'Warung Ibu', email: 'ibu@gmail.com', phone: null, website: null } });
  const r = await claimStart(req({ place_id: 'p9' }), { DB: d.DB }, deps());
  // Manual review stays on the end as the always-available fallback — the
  // point is that `email` is now there in front of it.
  assert.deepEqual(r.body.channels.map((c) => c.channel), ['email', 'manual']);
  assert.match(r.body.channels[0].display, /•|\*/, 'the address came back unmasked');
});

test('a crawled address is not held to the free-mail rule', () => {
  // That guard exists on the domain channel because there the CLAIMANT names
  // the mailbox. Nobody named this one — we read it off the listing.
  const c = SRC.slice(SRC.indexOf('function channelsForClaim'), SRC.indexOf('async function sendCode'));
  assert.doesNotMatch(c, /isFreeMail/);
  assert.match(SRC, /const base = channelsFor\(place\);/, 'the shared helper must stay untouched');
});

test('a channel we cannot send on is not offered at all', async () => {
  // This worker has no Twilio binding. Offering SMS and then failing leaves
  // the claimant waiting for a code that was never sent, which is worse than
  // not offering it: they conclude NUM is broken rather than that we are.
  const d = db({ place: PLACE });
  const r = await claimStart(req({ place_id: 'p1' }), { DB: d.DB }, deps());
  assert.equal(r.body.channels.some((c) => c.channel === 'sms'), false);
  assert.ok(r.body.channels.length > 0, 'no channel survived the filter');
});

test('no email provider means honest manual review, not a retry prompt', async () => {
  const d = db({ place: PLACE, claim: { id: 'c1', state: 'pending', place_id: 'p1', max_attempts: 5, attempts: 0 } });
  const r = await claimSend(req({ claim_id: 'c1', channel: 'email' }), { DB: d.DB }, deps()); // no RESEND_KEY
  assert.equal(r.status, 503);
  assert.equal(r.body.fallback, 'manual');
  assert.match(r.body.message, /by hand/i);
  assert.ok(d.writes.some((w) => /state='review'/.test(w.q)), 'the claim was not routed to review');
});

/* ── verifying, and what it creates ─────────────────────────────────────── */

test('a wrong code burns an attempt and says how many are left', async () => {
  const d = db({
    place: PLACE,
    claim: {
      id: 'c1', state: 'pending', place_id: 'p1', attempts: 1, max_attempts: 5,
      code_hash: 'nope', code_salt: 's', expires_at: new Date(Date.now() + 6e5).toISOString(),
    },
  });
  const r = await claimVerify(req({ claim_id: 'c1', code: '000000' }), { DB: d.DB }, deps());
  assert.equal(r.status, 400);
  assert.equal(r.body.attempts_left, 3);
  assert.ok(d.writes.some((w) => /attempts = attempts \+ 1/.test(w.q)));
});

test('an expired code is expired, not merely wrong', async () => {
  const d = db({
    place: PLACE,
    claim: {
      id: 'c1', state: 'pending', place_id: 'p1', attempts: 0, max_attempts: 5,
      code_hash: 'x', code_salt: 's', expires_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const r = await claimVerify(req({ claim_id: 'c1', code: '123456' }), { DB: d.DB }, deps());
  assert.equal(r.status, 410);
});

test('verifying creates the business, the owner, and the settings row', () => {
  // The bit that was missing from the public path entirely. Without
  // onboardStatements the business is verified but inert — no commission
  // rate, no timezone, no feature flags.
  const v = SRC.slice(SRC.indexOf('export async function claimVerify'));
  assert.match(v, /INSERT INTO businesses/);
  assert.match(v, /INSERT INTO num_place_owners/);
  assert.match(v, /UPDATE places SET status='claimed'/);
  assert.match(v, /onboardStatements\(env, businessId, place/);
  // And the code is burned, so it can never be replayed.
  assert.match(v, /code_hash=NULL, code_salt=NULL/);
});

test('the lead row finally records an outcome', () => {
  // `claims.state` was write-once 'new'. It now moves to 'verifying' when a
  // proof is opened and 'verified' when one lands, so the table the public
  // form writes says what happened to it.
  assert.match(SRC, /UPDATE claims SET num_claim_id=\?2, state='verifying'/);
  assert.match(SRC, /UPDATE claims SET state='verified', business_id=\?2/);
});

test('the link columns are added lazily, because there is no migration runner', () => {
  // A feature that only works after somebody remembers to run some SQL is a
  // feature that does not work.
  assert.match(SRC, /ALTER TABLE claims ADD COLUMN num_claim_id TEXT/);
  assert.match(SRC, /await ensureLink\(env\)/);
});

/* ── status leaks nothing ───────────────────────────────────────────────── */

test('status returns the masked contact, never the raw one', async () => {
  const d = db({ claim: { id: 'c1', state: 'pending', channel_value: 'b••k@kaneang.com' } });
  const url = new URL('https://itsnum.com/api/claims/status?claim_id=c1');
  const r = await claimStatus(req(), { DB: d.DB }, url, deps());
  assert.equal(r.status, 200);
  const s = SRC.slice(SRC.indexOf('export async function claimStatus'));
  assert.doesNotMatch(s, /code_hash|code_salt/, 'status can see the code material');
});

/* ── the page ───────────────────────────────────────────────────────────── */

test('the page offers verification only when a listing is bound', () => {
  assert.match(PAGE, /if \(placeId\) startVerify\(placeId/);
});

test('the card stays hidden when nothing can prove it', () => {
  // No published contact is OUR data gap, not the venue's failure. They keep
  // the claim and the human check; they are not shown a dead control.
  const v = PAGE.slice(PAGE.indexOf('function startVerify'));
  assert.match(v.slice(0, 900), /if \(!j \|\| !j\.ok \|\| !j\.channels \|\| !j\.channels\.length\) return;/);
  assert.match(v.slice(0, 900), /if \(!usable\.length\) return;/);
});

test('nothing about verification can block the claim itself', () => {
  // The claim is already committed by the time this runs. A failure here must
  // cost a venue nothing.
  const v = PAGE.slice(PAGE.indexOf('function startVerify'));
  assert.match(v.slice(0, 1200), /\.catch\(function \(\) \{\}\)/);
});

test('channel labels are written with textContent', () => {
  // They are masked contacts out of a crawled row.
  const r = PAGE.slice(PAGE.indexOf('function renderChannels'), PAGE.indexOf('function pickChannel'));
  assert.match(r, /t\.textContent =/);
  assert.match(r, /d\.textContent =/);
  const writes = r.match(/[\w.]*innerHTML\s*=[^\n]*/g) || [];
  assert.deepEqual(writes, ['box.innerHTML = "";']);
});

test('every language can say all of it', () => {
  for (const k of ['verifyH', 'verifyWhy', 'verifySend', 'verifyCode',
    'verifyCheck', 'verifySent', 'verifyDomEmail', 'verifyDone']) {
    const n = (PAGE.match(new RegExp(`^\\s*${k}:`, 'gm')) || []).length;
    assert.equal(n, 3, `${k} is missing from a language block`);
  }
});

test('the ownership funnel is measurable', () => {
  // Without a denominator, "the claim form is a dead end" is invisible — which
  // is exactly how it stayed one for three weeks.
  for (const e of ['claim_verify_offered', 'claim_code_sent', 'claim_verified']) {
    assert.match(WORKER, new RegExp(`"${e}"`), `${e} missing from the events allowlist`);
    assert.match(PAGE, new RegExp(`logEvent\\("${e}"`), `${e} never fired`);
  }
});
