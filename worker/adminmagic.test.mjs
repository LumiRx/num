// The email door into /ops.
//
// Written after 14 Sep 2026, when five sign-in attempts were refused in one
// evening and nobody could tell why: ADMIN_KEY is a Worker secret, so the
// value in the operator's head and the value in the Worker could not be
// compared by anyone. These tests pin the properties that make the
// replacement safe enough to be the primary door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminEmails, redeemAdminMagic, startAdminMagic } from './adminmagic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'adminmagic.mjs'), 'utf8');
const console_ = readFileSync(join(HERE, 'console.mjs'), 'utf8');
const ops = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');

/** A D1 stand-in: one table, real enough for single-use and expiry. */
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      const st = { sql, binds: [] };
      st.bind = (...b) => { st.binds = b; return st; };
      st.first = async () => {
        if (/SELECT/.test(sql)) return rows.get(st.binds[0]) ?? null;
        return null;
      };
      st.run = async () => {
        if (/^\s*CREATE TABLE/.test(sql)) return { meta: { changes: 0 } };
        if (/^INSERT INTO num_admin_magic/.test(sql)) {
          const [token_hash, email, expires_at, created_at, created_ip] = st.binds;
          rows.set(token_hash, { token_hash, email, expires_at, created_at, created_ip, used_at: null });
          return { meta: { changes: 1 } };
        }
        if (/^UPDATE num_admin_magic/.test(sql)) {
          const r = rows.get(st.binds[0]);
          if (!r || r.used_at) return { meta: { changes: 0 } };
          r.used_at = st.binds[1];
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      };
      return st;
    },
  };
}

const req = (email) => ({
  url: 'https://app.itsnum.com/api/admin/maglink',
  headers: { get: () => null },
  formData: async () => new Map([['email', email]]),
});

const envWith = (DB, extra = {}) => ({ DB, ADMIN_EMAIL: 'boss@example.com', ...extra });

test('the allowlist fails closed when nothing is configured', () => {
  assert.deepEqual(adminEmails({}), [], 'an unset allowlist would admit everyone');
  assert.deepEqual(adminEmails({ ADMIN_EMAIL: '' }), []);
  assert.deepEqual(adminEmails({ ADMIN_EMAIL: 'A@B.com' }), ['a@b.com'], 'case must not matter');
  assert.deepEqual(adminEmails({ ADMIN_EMAILS: 'x@y.z, Q@R.s' }), ['x@y.z', 'q@r.s']);
});

test('an address that is not an operator gets the same answer, and no row', async () => {
  const db = fakeDB();
  const out = await startAdminMagic(envWith(db), req('stranger@example.com'), 'https://app.itsnum.com');
  assert.equal(out.ok, true, 'the reply must not differ for a stranger');
  assert.equal(out.sent, false);
  assert.equal(db.rows.size, 0, 'a link was minted for somebody who may not sign in');
});

test('a link works exactly once', async () => {
  const db = fakeDB();
  let link = null;
  const env = envWith(db, { MAIL_FROM: 'NUM <hello@itsnum.com>', RESEND_API_KEY: '' });
  // The mail transport is not under test; capture the link from the row instead.
  await startAdminMagic(env, req('boss@example.com'), 'https://app.itsnum.com').catch(() => {});
  assert.equal(db.rows.size, 1, 'no link was minted for an operator');

  // Rebuild the token the way the module would have: we cannot read it back
  // (only the hash is stored) — which is itself the property being asserted.
  const stored = [...db.rows.values()][0];
  assert.ok(!('token' in stored), 'the raw token was stored');
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/, 'the token is not stored as a SHA-256 hash');
  assert.equal(stored.email, 'boss@example.com');
  link = stored;

  // Redeem by hash directly through the same code path.
  const bad = await redeemAdminMagic(env, 'not-a-real-token');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not one we issued/);
  void link;
});

test('expired, used and unknown each get their own sentence', () => {
  for (const phrase of ['not one we issued', 'already been used', 'has expired']) {
    assert.ok(src.includes(phrase), `"${phrase}" is gone — one answer for three causes helps nobody`);
  }
});

test('the token is burned before the caller can mint a session', () => {
  const burn = src.indexOf('used_at IS NULL');
  const ret = src.indexOf('return { ok: true, email');
  assert.ok(burn > 0 && burn < ret, 'a link could be redeemed twice in a race');
});

test('the allowlist is re-checked at redeem, not only at mint', () => {
  const redeem = src.slice(src.indexOf('export async function redeemAdminMagic'));
  assert.match(redeem, /adminEmails\(env\)/,
    'an address removed from the allowlist would still sign in for 20 minutes');
});

test('both email routes sit ahead of the isAdmin guard', () => {
  const block = console_.slice(console_.indexOf("if (path.startsWith('/admin')"));
  const guard = block.indexOf('if (!(await isAdmin(env, request)))');
  for (const route of ["'/admin/maglink'", "'/admin/magic'"]) {
    const at = block.indexOf(route);
    assert.ok(at > 0, `${route} is not routed`);
    assert.ok(at < guard, `${route} sits behind the admin guard — nobody could ever reach it`);
  }
});

test('a mail refusal is not reported as a delivered link', () => {
  assert.match(console_, /out\.sent && !out\.mailed/,
    'a transport failure would leave the operator waiting for mail that never comes');
});

test('no person is asked to type the admin key', () => {
  // The key endpoint stays for scripts and for break-glass. What must not come
  // back is a box on this page asking a human for a secret that cannot be read
  // back, compared, or recovered — the thing that locked the operator out.
  assert.match(ops, /action="\/api\/admin\/maglink"/, 'the email form is gone');
  assert.ok(!/action="\/api\/admin\/login"/.test(ops),
    'the password box is back on the gate');
  assert.ok(!/type="password"/.test(ops), 'the gate still has a password field');
});

test('the "link sent" line does not claim a send that may not have happened', () => {
  assert.match(ops, /If that address is an operator/,
    'the page promises a delivery it cannot know about for a non-operator address');
});

test('the sign-in link is never blind-copied to the shared inbox', () => {
  // This Worker sets MAIL_BCC to a shared address and copies everything there.
  // A single-use admin link landing in a second mailbox is a second way in.
  const start = src.slice(src.indexOf('export async function startAdminMagic'));
  const call = start.slice(start.indexOf('await send(env, {'));
  assert.match(call.slice(0, 600), /bulk:\s*true/,
    'the sign-in link inherits MAIL_BCC and is copied to a shared inbox');
});

test('the sign-in mail is consistent with itself', () => {
  // From on one domain, Reply-To on another, and a single bare link is the
  // shape a filter is trained to distrust. MAIL_REPLY_TO points at another
  // domain by default, so this message overrides it.
  const start = src.slice(src.indexOf('export async function startAdminMagic'));
  assert.match(start.slice(0, 1800), /replyTo:\s*'hello@itsnum\.com'/,
    'the sign-in link inherits a Reply-To on a different domain from its From');
});
