// ACCEPTED IS NOT DELIVERED — and on 30 Aug 2026 that cost six businesses.
//
// 19:46 that evening: the mail selftest passed "via cloudflare".
// 20:26, forty minutes later: six approved businesses were handed to the same
// transport, every send returned ok, and num_claim_decisions.onboarded was set
// to 1 on all six — Holiday Inn Express, Fingal, Giuliano's, Awafi, makani,
// Morrisons Lounge. Not one received anything. All six are now permanently
// marked as told, so the retry sweep skips them forever.
//
// The transport was not lying. The caller asked "did a transport accept this"
// and wrote the answer down as "was this business told".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { send, chainFor, AUDIENCE, transports } from './mailer.mjs';

const RESEND_OK = { RESEND_KEY: 'k', MAIL_FROM: 'NUM <info@itsnum.com>' };
const msg = { to: 'reception@hieedinburgh.co.uk', subject: 'You are listed', text: 'hello' };

test('an external message may not travel on a transport that cannot report', () => {
  assert.deepEqual(chainFor(AUDIENCE.EXTERNAL), ['resend'],
    'the Cloudflare binding is eligible for stranger mail again — it accepts and tells us nothing');
  assert.ok(chainFor(AUDIENCE.INTERNAL).includes('cloudflare'),
    'alerts to ourselves lost the transport that works when every credential is dead');
});

test('with no Resend key, external mail fails loudly instead of pretending', async () => {
  // The binding is present and would happily accept — that is exactly the
  // trap. A failure gets retried; a false success never does.
  const env = { EMAIL: { send: async () => ({ messageId: '<x@5arz.com>' }) } };
  const out = await send(env, msg, { audience: AUDIENCE.EXTERNAL });
  assert.equal(out.ok, false, 'the Cloudflare binding carried a business email again');
  assert.match(out.error, /Resend/i);
});

test('the same message to ourselves still goes out on the binding', async () => {
  const env = { EMAIL: { send: async () => ({ messageId: '<x@5arz.com>' }) }, ADMIN_EMAIL: 'andre@thatislumi.com' };
  const out = await send(env, { ...msg, to: 'andre@thatislumi.com' }, { audience: AUDIENCE.INTERNAL });
  assert.equal(out.ok, true, 'an alert can no longer reach us when the credentials are dead');
  assert.equal(out.via, 'cloudflare');
});

test('a success says what it actually knows', async () => {
  const env = { EMAIL: { send: async () => ({ messageId: '<x@5arz.com>' }) } };
  const out = await send(env, { ...msg, to: 'andre@thatislumi.com' }, { audience: AUDIENCE.INTERNAL });
  assert.equal(out.proof, 'accepted',
    'the result claims delivery again — no transport here reports one');
  assert.equal(out.audience, 'internal');
});

test('the default audience is internal, so a careless caller cannot mail a stranger by accident', async () => {
  const env = { EMAIL: { send: async () => ({ messageId: '<x@5arz.com>' }) } };
  const out = await send(env, msg);   // no audience given
  assert.equal(out.audience, 'internal');
});

// ── the caller that got it wrong ─────────────────────────────────────────
const onboard = readFileSync(new URL('./bizonboard.mjs', import.meta.url), 'utf8');

test('the onboarding email declares itself external', () => {
  assert.match(onboard, /audience: 'external'/,
    'the business welcome can fall through to a transport that cannot reach a business again');
});

test('a business that could not be told becomes a visible failure', () => {
  // Not a log line. Six businesses sat approved and uninformed for four days
  // and the only trace was a database column nobody had reason to read.
  assert.match(onboard, /kind: 'biz_onboard_unsent'/);
  assert.match(onboard, /await record\(env, \{/);
});

test('"onboarded" is still only written on a success, and only with a receipt', () => {
  const fn = onboard.slice(onboard.indexOf('export async function sendOnboarding'), onboard.indexOf('export async function onboardApproved'));
  const mark = fn.indexOf('accepted(env, claim.id');
  const ok = fn.indexOf('if (out?.ok)');
  assert.ok(ok >= 0 && ok < mark, 'the send is marked outside the success branch');
  assert.match(fn, /ref: out\.id/,
    'the provider receipt is not stored, so no delivery event can ever be matched back to this claim');
  assert.equal(/SET onboarded = 1/.test(fn), false,
    'the bare flag write is back — acceptance would be recorded as delivery again');
});

test('transports still say what they can and cannot do', () => {
  const t = transports({ EMAIL: { send: () => {} } });
  const cf = t.find((x) => x.via === 'cloudflare');
  assert.match(cf.note, /verified destination/,
    'the one sentence that explains 30 Aug is gone from the code');
});
