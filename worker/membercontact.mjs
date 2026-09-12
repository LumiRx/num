/**
 * membercontact.mjs — a way to reach the person, required at sign-up.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * Dre, 12 Sep 2026: "the number when a person is signing up is suppsoe to be
 * mandatory. if they dont have a phone number they can use and email."
 *
 * The number on the day that was said:
 *
 *   147 members. 107 of them — 73% — with no phone at all.
 *   Of the 40 who gave one, 6 verified.
 *
 * Num cannot reach three-quarters of its own members. It cannot text them a
 * confirmation, tell them a table moved, or get them back into an account on
 * a new phone. An account nobody can be reached at is a row, not a member.
 *
 * ── AND WHY IT IS NOT SIMPLY A WALL AGAIN ────────────────────────────────
 * The field WAS mandatory and was made optional for a measured reason, which
 * is written in InviteSheet.tsx: "48 of our first 77 sign-ups typed a name and
 * stopped dead at this field — 62% of everyone who opened Num."
 *
 * That is a real finding and this file does not pretend otherwise. What makes
 * this different is the alternative. The old wall was "a phone number or
 * nothing", and it was standing in front of a stranger who had not yet seen
 * the app do anything. The rule now is "a way to reach you", and there are
 * three doors through it: a mobile, an email address, or Sign in with Apple /
 * Google — which hand us a verified identity already and which Apple's
 * guideline 4.8 obliges us to offer anyway.
 *
 * If this still costs funnel, the honest fix is to move WHEN it is asked, not
 * to go back to accounts we cannot reach.
 *
 * ── WHAT COUNTS AS REACHABLE ─────────────────────────────────────────────
 * A verified channel, or an unverified one we have at least written down.
 * Deliberately generous on the second: refusing an unverified address would
 * strand anyone whose code did not arrive, and we already know from the 34
 * unverified numbers how often that happens. `hasVerifiedContact` is the
 * stricter test, for the places that need it.
 */

import { generateCode, hashCode } from '../claim/verify.mjs';
// The address rule lives on its own so the SIGN-UP FORM can import the exact
// same function. A client that accepts an address the server refuses is a
// button that looks fine and then fails, which is the failure mode we keep
// paying for. See src/lib/contact.ts.
import { normaliseEmail } from './emailaddr.mjs';

export { normaliseEmail };

/** How long a code is good for. Matches the SMS side. */
export const CODE_TTL_MIN = 10;

/** What we say when somebody offers neither. One sentence, and it explains why. */
export const NEED_CONTACT =
  'I need a mobile number or an email address — it is how I get back to you when a booking '
  + 'moves, and how you get your account back on a new phone. Either one is fine.';

/** What we say when the address itself is malformed. */
export const BAD_EMAIL =
  'That email address does not look complete — check for a missing @ or a typo in the domain.';

let ready = new WeakSet();

/** Reset for tests. Production never calls this. */
export function __resetReady() { ready = new WeakSet(); }

/**
 * Add the columns this needs, once per isolate.
 *
 * `code_channel` is the load-bearing one and the least obvious. A pending code
 * lives in `code_hash` no matter which door it went out of, so without a note
 * of the channel, a code emailed to somebody would have set `phone_verified`
 * when they typed it in — verifying a number nobody ever texted.
 */
export async function ensureContact(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  for (const sql of [
    'ALTER TABLE num_members ADD COLUMN email TEXT',
    'ALTER TABLE num_members ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE num_members ADD COLUMN code_channel TEXT',
  ]) {
    // Already-exists is the normal outcome after the first deploy.
    await env.DB.prepare(sql).run().catch(() => {});
  }
  // One address, one account — the same rule the phone column already has.
  // Partial so the 107 rows with a NULL email do not collide with each other.
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS num_members_email ON num_members (email) WHERE email IS NOT NULL',
  ).run().catch(() => {});
  ready.add(env.DB);
}

/**
 * Can Num get back to this person at all?
 *
 * Apple and Google sign-ins are reachable by construction — the provider
 * holds a verified address and we key the account on their subject id — so a
 * member carrying one passes without a phone or an email of ours.
 */
export const hasContact = (row) =>
  !!(row?.phone || row?.email || row?.apple_sub || row?.has_provider);

/** The stricter test: a channel somebody has actually proved they hold. */
export const hasVerifiedContact = (row) =>
  !!(Number(row?.phone_verified) || Number(row?.email_verified) || row?.apple_sub || row?.has_provider);

/**
 * Mint a code, email it, and store the hash.
 *
 * Mirrors issueCode() in social.mjs deliberately, down to the rule that
 * matters most: **the hash is only written when the send actually succeeded.**
 * A stored hash for a message that never left is a member who can never
 * verify and whose retry is told a code is already pending.
 */
export async function issueEmailCode(env, id, email, ctx) {
  if (!env?.DB) return { sent: false, reason: 'no database' };
  const to = normaliseEmail(email);
  if (!to) return { sent: false, reason: 'bad_email', note: BAD_EMAIL };
  await ensureContact(env);

  const code = generateCode();

  // ── WHY THIS DOES NOT CALL email.mjs's sendEmail ────────────────────────
  //
  // That function posts straight at `env.EMAIL`, the Cloudflare binding, and
  // this codebase already knows what that costs. From worker/mailer.mjs:
  // the Cloudflare transport "would accept the message and tell us nothing,
  // which is how six businesses became unreachable-forever rather than merely
  // un-emailed."
  //
  // A sign-in code goes to a stranger's own inbox — the definition of an
  // EXTERNAL send — and a false success here is the worst possible outcome:
  // the app says "code sent", the person waits, and nothing ever arrives with
  // no record on our side that anything went wrong. So it goes through the
  // mailer, on the external chain, which is Resend only and reports per-
  // message status.
  //
  // The BODY still comes from the shared template so this message looks like
  // every other one Num sends. Only the transport is different.
  const { TEMPLATES, renderTemplate } = await import('./email.mjs');
  const t = TEMPLATES.signin({ code, minutes: CODE_TTL_MIN });
  const { send, AUDIENCE } = await import('./mailer.mjs');
  const out = await send(env, {
    to,
    subject: t.subject,
    html: renderTemplate('signin', { code, minutes: CODE_TTL_MIN }),
    text: t.text,
    // No blind copy of somebody's sign-in code to the ops mailbox. `bulk`
    // is the flag that turns MAIL_BCC off, and this is the one message where
    // a second reader is not a safety net but a second person holding the key.
    bulk: true,
    tag: 'signin_code',
  }, { audience: AUDIENCE.EXTERNAL }).catch(
    (err) => ({ ok: false, error: String(err?.message ?? err).slice(0, 160) }),
  );

  if (!out?.ok) {
    const { logSignin: logFail } = await import('./signinlog.mjs');
    await logFail(env, { memberId: id, stage: 'send', outcome: 'failed', reason: out?.error, via: 'email' })
      .catch(() => {});
    return {
      sent: false,
      reason: out?.error ?? 'send_failed',
      note: 'Address saved, but that code did not go out. Try again in a minute, or use a mobile number instead.',
    };
  }
  // Logged so the resend cooldown can see it. Without this row, `sendGate`
  // finds no previous send, and an email account has NO rate limit at all —
  // an open endpoint for spending our sending reputation on someone else's
  // afternoon. The SMS path has always logged; this had to as well.
  const { logSignin } = await import('./signinlog.mjs');
  await logSignin(env, { memberId: id, stage: 'send', outcome: 'ok', via: 'email' }).catch(() => {});

  const salt = crypto.randomUUID();
  await env.DB.prepare(
    `UPDATE num_members SET code_hash=?2, code_salt=?3, code_expires=?4, attempts=0,
            code_sid=NULL, code_channel='email' WHERE id=?1`,
  ).bind(
    id,
    await hashCode(code, salt),
    salt,
    new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString(),
  ).run();

  return { sent: true, channel: 'email', to, expires_in_min: CODE_TTL_MIN };
}

/**
 * The nudge for the 107 who already have neither.
 *
 * Asked, never enforced. Locking out a member who signed up under the old
 * rule would punish them for our change, and the whole point of the exercise
 * is to be able to reach these people — which you cannot do by shutting the
 * door on them. Returns null when there is nothing to ask for.
 */
export function contactNudge(row) {
  if (hasContact(row)) return null;
  return {
    needed: true,
    ask:
      'One thing I never got from you: a mobile number, or an email if you would rather. '
      + 'It is how I reach you when a booking moves, and how you get this account back if you '
      + 'change phones — right now I have no way to do either.',
    chip: { id: 'addcontact', label: 'Add my number' },
  };
}
