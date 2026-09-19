// The field names a raw HTTP API actually reads, and the rail it is allowed to
// use.
//
// WHY THIS FILE EXISTS. `sendBatch` does not use the Resend SDK. It posts the
// message object straight at Resend's REST endpoint:
//
//     body: JSON.stringify(messages.map(({ __idem, ...m }) => m))
//
// The SDK takes `replyTo`. The REST API takes `reply_to`. Fourteen call sites
// used the SDK spelling, Resend ignored the unknown key without complaining,
// and every one of those emails shipped with no Reply-To at all — replies went
// to the From address instead.
//
// That is not cosmetic. invitecron.mjs stopped hardcoding its reply address
// precisely because info@itsnum.com rejects at the SMTP layer, so every one of
// the 1,051 businesses that hit reply on an invite got a bounce, and so did
// anyone using the mailto unsubscribe — one of the two opt-out routes CAN-SPAM
// and PECR require. And hostloop.test.mjs asserted the RIGHT property against
// the WRONG spelling, so it passed for months while clients replying to their
// confirmation reached NUM instead of their host.
//
// A typo that a remote API silently tolerates is the hardest kind to see. This
// is the file that sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const all = readdirSync(HERE)
  .filter((f) => (f.endsWith('.mjs') || f.endsWith('.js')) && !f.includes('.test.'))
  .map((f) => [f, readFileSync(join(HERE, f), 'utf8')]);

// Only the files that post AT RESEND'S REST API. worker/mailer.mjs takes the
// SDK spelling `replyTo` and is correct to — claimverify.mjs routes through it
// and must not be dragged into this rule. The bug is specifically a raw HTTP
// body being handed SDK field names.
const files = all
  .filter(([, src]) => /sendBatch\s*\(/.test(src) || /api\.resend\.com/.test(src))
  // resend.mjs is the one file that legitimately speaks both dialects: it reads
  // `reply_to` off the REST-shaped message and hands `replyTo` to mailer.mjs,
  // which is the SDK-shaped side. It is the translation layer, not a caller.
  .filter(([name]) => name !== 'resend.mjs');

test('nothing that goes to sendBatch uses the SDK spelling of reply_to', () => {
  for (const [name, src] of files) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\breplyTo\s*:/.test(code),
      `${name} uses replyTo:, which Resend's REST API ignores — use reply_to:. `
      + 'The message object is posted verbatim; an unknown key is dropped without an error.');
  }
});

test('the reply address is configurable and not the mailbox that bounces', () => {
  const worker = files.find(([n]) => n === 'worker.js')[1];
  const cron = files.find(([n]) => n === 'invitecron.mjs')[1];
  for (const [name, src] of [['worker.js', worker], ['invitecron.mjs', cron]]) {
    for (const m of src.matchAll(/reply_to:\s*(\[[^\]]*\]|"[^"]*")/g)) {
      assert.match(m[1], /MAIL_REPLY_TO/,
        `${name} pins a reply address instead of reading env.MAIL_REPLY_TO: ${m[1]}`);
    }
  }
});

test('MAIL_REPLY_TO is actually set on the worker that sends', () => {
  // Half the original fix. invitecron read env.MAIL_REPLY_TO and growth never
  // defined it, so the code fell straight back to the dead address it had been
  // rewritten to avoid.
  const wr = readFileSync(join(HERE, 'wrangler.jsonc'), 'utf8');
  assert.match(wr, /"MAIL_REPLY_TO":\s*"[^"]+"/,
    'growth sends merchant and host mail — replies to it must land somewhere a person reads');
  assert.doesNotMatch(wr, /"MAIL_REPLY_TO":\s*"info@itsnum\.com"/,
    'that mailbox rejects at SMTP — it is the address this was all about');
});

test('the Cloudflare rail is never used for someone outside the company', () => {
  // mailer.mjs keeps Cloudflare out of the external chain because it reaches
  // only addresses verified on our own account: for a merchant it accepts the
  // message and discards it. sendBatch used to reach past that with
  // { order: ['cloudflare'] } on any 401, return ok:true, and let every ledger
  // write "sent" — spending leads that are only ever mailed once.
  const src = readFileSync(join(HERE, 'resend.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(code, /internal = false/,
    'the fallback must be opt-in, and off by default');
  const calls = [...code.matchAll(/await viaCloudflareOneByOne\(env, messages\)/g)];
  assert.equal(calls.length, 2, 'expected exactly the no-key and the rejected-key routes');
  for (const m of calls) {
    // Look back to the start of the enclosing `if`, not a fixed number of
    // characters — a comment or a reformat should not decide whether this
    // guard can see the condition it is checking.
    const before = code.slice(0, m.index);
    const cond = before.slice(before.lastIndexOf('if ('));
    assert.match(cond, /internal/,
      'every route to the Cloudflare rail must be gated on the internal opt-in');
  }
  assert.match(code, /accept and discard/,
    'and the refusal must explain itself to whoever reads the error');
});

/* ── WHICH SENDER, AND WHY IT IS NO LONGER READ OFF MAIL_FROM ─────────────
 *
 * worker/mailer.mjs split the sender on 19 Sep 2026 so a cold list bouncing
 * at a quarter cannot take the sign-in codes down with it. The split
 * protected nothing here, because every send in growth/worker.js read
 * `env.MAIL_FROM` directly: a host console code, a booking confirmation and a
 * settled-bill receipt had no protected address to sit on. A split only one
 * half of the product uses is not a split.
 *
 * These guard the routing, not the address. Nothing changes today —
 * `senderFor` falls back to MAIL_FROM — and setting MAIL_FROM_TRANSACTIONAL
 * moves all of them at once, which is the whole point.
 */

test('growth sends go through the transactional sender, not MAIL_FROM directly', () => {
  const src = readFileSync(join(HERE, 'worker.js'), 'utf8');
  const direct = [...src.matchAll(/from:\s*env\.MAIL_FROM/g)];
  assert.equal(direct.length, 0,
    `${direct.length} send(s) still read env.MAIL_FROM directly — they cannot be moved off the outreach domain`);
  assert.match(src, /function txFrom\(env\)/, 'the helper is gone and every call site is on its own again');
  assert.match(src, /mailSenderFor\(env, MAIL_KIND\.TRANSACTIONAL\)/,
    'txFrom no longer asks the mailer which sender a transactional message takes');
});

test('the settled-bill receipt is transactional — a venue is waiting on it', () => {
  const src = readFileSync(join(HERE, 'worker.js'), 'utf8');
  const fn = src.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /from: txFrom\(env\)/,
    'a receipt on the outreach domain inherits whatever a cold list built');
});

test('a thread records the address the message actually left from', () => {
  // It recorded MAIL_FROM while the send used senderFor(OUTREACH), so once the
  // split is configured the thread would show a reply going to an address the
  // business never saw.
  const cron = readFileSync(join(HERE, 'invitecron.mjs'), 'utf8');
  assert.match(cron, /from: senderFor\(env, MAIL_KIND\.OUTREACH\)/);
  assert.doesNotMatch(cron, /from: env\.MAIL_FROM \|\|/);
});
