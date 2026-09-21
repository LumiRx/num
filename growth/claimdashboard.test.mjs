// From a proved listing to a signed-in owner — executed, not read.
//
// Every earlier test of verification inspected the SOURCE TEXT of
// claimVerify. None ever ran the success path. That is how this shipped and
// stayed shipped:
//
//     next: 'Your listing is yours. We will send your dashboard link to the
//            same contact.'
//
// with nothing after it that sent a link, and no num_business_users row for
// the owner — the only table business sign-in recognises. num_biz_sessions
// had never held a row. A business could prove a listing was theirs and never
// get in. These tests drive the real function end to end.
//
// And one rule held above the convenience: the login is created ONLY after
// the code sent to the listing's published contact has been typed back.
// Before that, anyone who knows a restaurant's name could take its dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { claimVerify, claimDeps, _resetLinkCache } from './claimverify.mjs';
import { hashCode } from '../claim/verify.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = readFileSync(join(HERE, 'claimverify.mjs'), 'utf8');

const PLACE = { id: 'p1', name: 'Kan Eang', phone: '+66761234567', email: 'book@kaneang.com',
  website: 'https://kaneang.com', dest: 'phuket', category: 'Restaurant' };

async function pendingClaim(extra = {}) {
  const salt = 'saltsalt';
  return {
    id: 'clm_1', place_id: 'p1', state: 'pending', channel: 'email_domain',
    code_hash: await hashCode('123456', salt), code_salt: salt,
    attempts: 0, max_attempts: 5, expires_at: new Date(Date.now() + 6e5).toISOString(),
    claimant_name: 'Somchai', claimant_email: 'Owner@KanEang.com', ...extra,
  };
}

/**
 * A D1 stand-in that behaves like the real one for the rows that matter:
 * once num_business_users is written, sign-in can find it.
 */
function db(claim, { leadEmail = null } = {}) {
  _resetLinkCache();
  const writes = [];
  const users = [];
  const DB = {
    prepare(q) {
      let a = [];
      const stmt = {
        bind: (...x) => { a = x; return stmt; },
        run: async () => {
          writes.push({ q, a });
          if (/INSERT INTO num_business_users/.test(q)) {
            users.push({ id: a[0], business_id: a[1], email: a[2], name: a[3],
              role: 'owner', status: 'active', business_name: PLACE.name });
          }
          return { meta: { changes: 1 } };
        },
        first: async () => {
          if (/FROM num_business_users u JOIN businesses/.test(q)) {
            return users.find((u) => u.email === String(a[0]).toLowerCase()) ?? null;
          }
          if (/FROM claims WHERE num_claim_id/.test(q)) return leadEmail ? { email: leadEmail } : null;
          if (/FROM places/.test(q)) return PLACE;
          if (/FROM num_claims/.test(q)) return claim;
          return null;
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async (s) => { for (const x of s) await x.run(); return []; },
  };
  return { DB, writes, users };
}

const deps = (sent, { mailThrows = false } = {}) => claimDeps({
  J: (o, s = 200) => ({ status: s, body: o }),
  clean: (v, n) => String(v ?? '').trim().slice(0, n),
  readJSON: async (req) => req.__body ?? {},
  sendBatch: async () => true,
  sendMail: async (env, msg) => {
    if (mailThrows) throw new Error('Resend 401');
    sent.push(msg); return { ok: true, via: 'test' };
  },
  legalLine: '5arz Inc',
});

const req = (body) => ({ __body: body, headers: { get: (h) => (h === 'cf-connecting-ip' ? '1.2.3.4' : '') } });

test('a verified owner gets a login row, in the same write as the business', async () => {
  const { DB, writes, users } = db(await pendingClaim());
  const r = await claimVerify(req({ claim_id: 'clm_1', code: '123456' }), { DB }, deps([]));
  assert.equal(r.body.ok, true);
  const ins = writes.find((w) => /INSERT INTO num_business_users/.test(w.q));
  assert.ok(ins, 'the row business sign-in depends on must be created');
  assert.equal(ins.a[2], 'owner@kaneang.com', 'stored lower-case, the way sign-in looks it up');
  assert.equal(users.length, 1);
  assert.match(ins.q, /'owner','active'/);
});

test('the dashboard link is actually sent — the promise now has a body', async () => {
  const sent = [];
  const { DB } = db(await pendingClaim());
  const r = await claimVerify(req({ claim_id: 'clm_1', code: '123456' }),
    { DB, SITE: 'https://itsnum.com' }, deps(sent));
  assert.equal(sent.length, 1, 'exactly one email: the dashboard link');
  assert.equal(sent[0].to, 'owner@kaneang.com');
  assert.match(sent[0].text, /https:\/\/itsnum\.com\/biz\/login\?t=\w+/,
    'the SAME door a normal sign-in uses, not a second one to keep in step');
  assert.match(sent[0].subject, /Kan Eang/);
  assert.equal(r.body.dashboard.sent, true);
  assert.match(r.body.next, /emailed your dashboard link/);
  assert.doesNotMatch(r.body.next, /owner@kaneang\.com/i,
    'the reply is shown on screen, so the full address must not be in it');
});

test('the reply says what happened — never "we will send" when nothing was sent', async () => {
  const { DB } = db(await pendingClaim({ claimant_email: null }));
  const r = await claimVerify(req({ claim_id: 'clm_1', code: '123456' }), { DB }, deps([]));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.dashboard.sent, false);
  assert.doesNotMatch(r.body.next, /we will send your dashboard link to the same contact/i);
});

test('with no email on the claim, the lead row is asked before giving up', async () => {
  const sent = [];
  const { DB, users } = db(await pendingClaim({ claimant_email: null }), { leadEmail: 'lead@kaneang.com' });
  const r = await claimVerify(req({ claim_id: 'clm_1', code: '123456' }), { DB }, deps(sent));
  assert.equal(users[0]?.email, 'lead@kaneang.com');
  assert.equal(sent[0]?.to, 'lead@kaneang.com');
  assert.equal(r.body.dashboard.sent, true);
});

test('a mail outage never undoes a verification the owner already completed', async () => {
  const { DB, users } = db(await pendingClaim());
  const r = await claimVerify(req({ claim_id: 'clm_1', code: '123456' }), { DB }, deps([], { mailThrows: true }));
  assert.equal(r.body.ok, true, 'the business and the login both exist; sign-in at /biz still works');
  assert.equal(users.length, 1);
  assert.equal(r.body.dashboard.sent, false);
  assert.match(r.body.next, /itsnum\.com\/biz/);
});

test('a wrong code creates no login and sends nothing', async () => {
  const sent = [];
  const { DB, users } = db(await pendingClaim());
  const r = await claimVerify(req({ claim_id: 'clm_1', code: '000000' }), { DB }, deps(sent));
  assert.equal(r.body.ok, false);
  assert.equal(users.length, 0);
  assert.equal(sent.length, 0);
});

test('THE RULE: the login is created only after the code check, never before it', () => {
  // Anyone can type a restaurant's name into a form. Only its owner can read
  // the code sent to the contact on its door. If this insert ever moves above
  // the safeEqual check — or into claimStart, claimSend, or the public claim
  // form — the dashboard belongs to whoever typed the name first.
  const verify = SRC.slice(SRC.indexOf('export async function claimVerify'));
  const check = verify.indexOf('safeEqual(hash, claim.code_hash)');
  const insert = verify.indexOf('INSERT INTO num_business_users');
  assert.ok(check > 0 && insert > check, 'the login row must be written after the code is proved');
  const before = SRC.slice(0, SRC.indexOf('export async function claimVerify'));
  assert.doesNotMatch(before, /INSERT INTO num_business_users/,
    'no earlier step of the claim may create a login');
});
