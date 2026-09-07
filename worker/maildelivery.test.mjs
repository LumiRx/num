// ACCEPTED IS NOT DELIVERED.
//
// 30 Aug 2026, 20:26: six approved businesses handed to the mailer, every send
// returned ok, `onboarded = 1` written on all six. Not one arrived. Nothing was
// broken in a way anything could see — the transport accepted the messages, and
// acceptance is all any transport reports at send time. The system asked "did
// somebody take this from me" and filed the answer under `onboarded`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleResendWebhook, accepted, checkUnconfirmed } from './maildelivery.mjs';
import { open } from './failures.mjs';
import { DatabaseSync } from 'node:sqlite';

function reorder(sql, args) {
  const idx = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (!idx.length) return args;
  return idx.map((i) => (args[i - 1] === undefined ? null : args[i - 1]));
}
function d1(db) {
  return {
    prepare(sql) {
      const st = { sql, args: [] };
      st.bind = (...a) => { st.args = a; return st; };
      const run = (fn) => {
        const s = db.prepare(st.sql.replace(/\?(\d+)/g, '?'));
        return fn(s, reorder(st.sql, st.args));
      };
      st.run = async () => ({ meta: { changes: run((s, a) => s.run(...a)).changes } });
      st.first = async () => run((s, a) => s.get(...a)) ?? null;
      st.all = async () => ({ results: run((s, a) => s.all(...a)) });
      return st;
    },
  };
}
function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT)`);
  db.exec(`CREATE TABLE num_claim_decisions (claim_id TEXT PRIMARY KEY, decision TEXT, onboarded INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE num_suppressions (email TEXT PRIMARY KEY, reason TEXT, note TEXT, created_at TEXT DEFAULT '')`);
  db.exec(`INSERT INTO claims VALUES (13,'Holiday Inn Express','reception@hieedinburgh.co.uk')`);
  db.exec(`INSERT INTO num_claim_decisions VALUES ('13','approved',0)`);
  return { DB: d1(db), _db: db };
}
const row = (env) => env._db.prepare('SELECT * FROM num_claim_decisions WHERE claim_id = ?').get('13');

test('a handover records the provider receipt, not a bare flag', async () => {
  const env = fresh();
  await accepted(env, 13, { via: 'resend', ref: 're_abc123' });
  const r = row(env);
  assert.equal(r.onboarded, 1, 'at-most-once still has to hold — nobody gets the welcome twice');
  assert.equal(r.onboard_ref, 're_abc123', 'without the receipt no delivery event can ever be matched to this claim');
  assert.equal(r.delivered_at, null, 'acceptance was recorded as delivery again — this is the 30 Aug bug');
});

test('unconfirmed after the grace period is a named, visible failure', async () => {
  const env = fresh();
  await accepted(env, 13, { via: 'cloudflare', ref: 'cf_1' });
  // Nothing yet: a message accepted a minute ago may be fine.
  assert.equal((await checkUnconfirmed(env)).unconfirmed, 0);
  env._db.prepare('UPDATE num_claim_decisions SET onboard_at = onboard_at - 3600').run();
  const out = await checkUnconfirmed(env);
  assert.equal(out.unconfirmed, 1);
  const failures = await open(env);
  const f = failures.find((x) => x.kind === 'biz_onboard_unconfirmed');
  assert.ok(f, 'six of these should have been on the board by 20:56 on 30 Aug');
  assert.match(f.subject, /Holiday Inn Express/);
});

test('an unconfirmed message is escalated, never silently re-sent', async () => {
  // "Retry until confirmed" mails a hotel the same welcome forty times, and a
  // webhook that was never configured looks exactly like a message that never
  // arrived.
  const env = fresh();
  await accepted(env, 13, { via: 'cloudflare', ref: 'cf_1' });
  env._db.prepare('UPDATE num_claim_decisions SET onboard_at = onboard_at - 3600').run();
  await checkUnconfirmed(env);
  assert.equal(row(env).onboarded, 1, 'the sweep cleared onboarded and the next tick will mail them again');
});

// ── the webhook ──────────────────────────────────────────────────────────
const req = (body, headers = {}) => new Request('https://app.itsnum.com/api/webhooks/resend', {
  method: 'POST', body: JSON.stringify(body), headers,
});

test('with no secret configured it refuses, and says so out loud', async () => {
  // An unauthenticated webhook that writes "delivered" into our records is a
  // stranger with a pen: anybody could mark a business as told.
  const env = fresh();
  const res = await handleResendWebhook(req({ type: 'email.delivered' }), env);
  assert.equal(res.status, 503);
  const f = (await open(env)).find((x) => x.kind === 'mail_webhook_unconfigured');
  assert.ok(f, 'an unconfigured webhook failed silently — which is how "delivered" stays unsayable');
});

test('a bad signature is refused', async () => {
  const env = { ...fresh(), RESEND_WEBHOOK_SECRET: 'whsec_' + btoa('key') };
  const res = await handleResendWebhook(req({ type: 'email.delivered' }, {
    'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,nonsense',
  }), env);
  assert.equal(res.status, 401);
});

/** A correctly signed Svix request, so the happy path is tested for real. */
async function signed(env, body) {
  const raw = JSON.stringify(body);
  const id = 'msg_1';
  const ts = String(Math.floor(Date.now() / 1000));
  const b64 = env.RESEND_WEBHOOK_SECRET.slice(6);
  const key = await crypto.subtle.importKey(
    'raw', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${raw}`));
  const sig = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return new Request('https://app.itsnum.com/api/webhooks/resend', {
    method: 'POST', body: raw,
    headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
  });
}

test('a delivery makes it a fact, and closes the failures about it', async () => {
  const env = { ...fresh(), RESEND_WEBHOOK_SECRET: 'whsec_' + btoa('supersecretkey') };
  await accepted(env, 13, { via: 'resend', ref: 're_abc123' });
  env._db.prepare('UPDATE num_claim_decisions SET onboard_at = onboard_at - 3600').run();
  await checkUnconfirmed(env);
  assert.ok((await open(env)).some((f) => f.kind === 'biz_onboard_unconfirmed'));

  const res = await handleResendWebhook(await signed(env, {
    type: 'email.delivered',
    data: { email_id: 're_abc123', to: ['reception@hieedinburgh.co.uk'] },
  }), env);
  assert.equal(res.status, 200);
  assert.ok(row(env).delivered_at, 'a confirmed delivery is still not recorded as one');
  assert.equal((await open(env)).some((f) => f.kind === 'biz_onboard_unconfirmed'), false,
    'a fixed problem stayed on the board');
});

test('a bounce un-marks the send so a corrected address can be tried', async () => {
  const env = { ...fresh(), RESEND_WEBHOOK_SECRET: 'whsec_' + btoa('supersecretkey') };
  await accepted(env, 13, { via: 'resend', ref: 're_abc123' });
  await handleResendWebhook(await signed(env, {
    type: 'email.bounced',
    data: { email_id: 're_abc123', to: ['reception@hieedinburgh.co.uk'], reason: 'mailbox does not exist' },
  }), env);
  const r = row(env);
  assert.equal(r.onboarded, 0, 'a bounced business stays marked as told — the exact 30 Aug mistake');
  assert.match(r.bounce_reason, /mailbox does not exist/);
  assert.ok((await open(env)).some((f) => f.kind === 'mail_bounced'));
});

test('a complaint suppresses the address as well', async () => {
  const env = { ...fresh(), RESEND_WEBHOOK_SECRET: 'whsec_' + btoa('supersecretkey') };
  await accepted(env, 13, { via: 'resend', ref: 're_abc123' });
  await handleResendWebhook(await signed(env, {
    type: 'email.complained',
    data: { email_id: 're_abc123', to: ['reception@hieedinburgh.co.uk'] },
  }), env);
  const s = env._db.prepare('SELECT * FROM num_suppressions').all();
  assert.equal(s.length, 1, 'somebody marked us as spam and we kept the right to email them');
});

test('a replayed request from yesterday is refused', async () => {
  const env = { ...fresh(), RESEND_WEBHOOK_SECRET: 'whsec_' + btoa('supersecretkey') };
  const r = await signed(env, { type: 'email.delivered', data: {} });
  const stale = new Request(r.url, {
    method: 'POST', body: await r.text(),
    headers: { 'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000) - 4000), 'svix-signature': r.headers.get('svix-signature') },
  });
  assert.equal((await handleResendWebhook(stale, env)).status, 401);
});

// ── the suppression check that never fired ───────────────────────────────
test('the suppression list is queried on a column that exists', () => {
  const worker = readFileSync(new URL('../growth/worker.js', import.meta.url), 'utf8');
  assert.equal(/num_suppressions WHERE email_lc/.test(worker), false,
    'the suppression check queries a column num_suppressions does not have, and swallows the error — '
    + 'so it returns "not suppressed" every time and a person who asked never to be contacted is contactable');
  assert.match(worker, /num_suppressions WHERE lower\(email\) = \?/);
});
