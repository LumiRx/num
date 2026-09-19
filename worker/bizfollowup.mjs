/**
 * ONE MESSAGE TO THE PEOPLE WHO ALREADY CAME AND COULD NOT FINISH.
 *
 * ── WHY THIS IS NOT THE THING THAT IS CURRENTLY HALTED ───────────────────
 *
 * Cold outreach is stopped, and it should be: 21.9% bouncing over seven days,
 * 25.7% on the worst day, a list with eleven Domino's staff addresses and a
 * UCLA medical school mailbox in it. Sending more of that spends a domain that
 * sign-in codes also depend on.
 *
 * This is the opposite population, and the distinction is the whole argument.
 * Every recipient here was DELIVERED TO, OPENED IT, AND CLICKED THROUGH to the
 * claim page. They are, by definition, real mailboxes belonging to people who
 * were interested enough to arrive. Mail to an engaged recipient is the
 * cheapest reputation there is; it is what recovers a sending domain, not what
 * damages it.
 *
 * There are 68 of them, against 3,538 invitations. They are the warmest leads
 * NUM has, and they are going cold because of a bug we have since fixed.
 *
 * ── AND WHY THE MESSAGE IS WHAT IT IS ────────────────────────────────────
 *
 * Between 15 and 18 Sep the claim form's submit handler refused every
 * submission without seven digits in the phone box, under a label reading
 * "(optional)". 77 businesses reached that page and 9 got past it.
 *
 * So the message says the form was broken and is fixed. That is not a
 * marketing angle, it is what happened, and it is the only honest reason to
 * write to someone a second time. A "just following up!" to the same 68 people
 * would be the kind of mail that earns a spam complaint, and a complaint from
 * an engaged recipient costs more than a bounce from a dead one.
 *
 * ── THE LIMITS, ENFORCED HERE AND NOT BY WHOEVER CALLS IT ────────────────
 *
 *   · clickers only, who never filled the form
 *   · once ever, tracked in its own table, not by reading the invite log
 *   · never to an unsubscribe, a suppression, a bounce or a complaint
 *   · refuses entirely when the bounce breaker is over its ceiling
 *   · a small per-run cap, because a bug here reaches real people
 */

import { sendHealth } from './bouncepolicy.mjs';
import { stuckAt } from './bizstate.mjs';
import { openThread, replyAddress, record } from './bizthread.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_biz_followups (
  email       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  thread_id   TEXT,
  provider_id TEXT,
  sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, kind)
);`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.prepare(SCHEMA.trim()).run();
  ready = true;
}
export function __resetReady() { ready = false; }

export const KIND = 'claim_form_fixed';

/** The message. Written out here rather than generated — 68 people, one text. */
export function compose({ businessName, claimUrl }) {
  const name = businessName ? ` for ${businessName}` : '';
  const text = [
    `A while ago you clicked through to claim your NUM profile${name}, and the form would not let you finish.`,
    '',
    'That was our fault, and it was a real bug: the page asked for a mobile number,',
    'said it was optional, and then refused to submit without one. If you gave up on it,',
    'that is almost certainly why.',
    '',
    'It is fixed. It now asks how you would like bookings to reach you — a text, an email,',
    'into the booking system you already use, or not at all if you just want to be listed',
    'and found. Any of those is a complete answer, including the last one.',
    '',
    `Two minutes if you still want it: ${claimUrl}`,
    '',
    'And if you would rather we left it, just reply and say so — I will take the listing',
    'out of our outreach and you will not hear from us again.',
    '',
    'Dre',
    'NUM · itsnum.com',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f9">
<tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;background:#fff;border-radius:14px;border:1px solid #e5e7eb">
<tr><td style="padding:30px 32px;font:16px/1.65 -apple-system,Segoe UI,Arial,sans-serif;color:#1f2937">
${text.split('\n\n').map((p) => `<p style="margin:0 0 16px">${p.replace(/\n/g, ' ').replace(/</g, '&lt;')
    .replace(claimUrl, `<a href="${claimUrl}" style="color:#0e8a63;font-weight:600">${claimUrl}</a>`)}</p>`).join('')}
</td></tr></table>
</td></tr></table></body></html>`;

  return { subject: 'The claim form was broken — that was us', text, html };
}

/**
 * Send it, to the ones it is for, once each.
 *
 * `dryRun` defaults to TRUE. This reaches real businesses who already gave us
 * the benefit of the doubt once, so the default has to be the harmless one and
 * sending has to be a thing somebody typed on purpose.
 */
export async function runFollowup(env, { limit = 40, dryRun = true } = {}) {
  if (!env?.DB) return { sent: 0, reason: 'no database' };
  await ensure(env);

  const health = await sendHealth(env).catch(() => ({ ok: true, known: false }));
  if (!health.ok) {
    return { sent: 0, reason: 'the bounce breaker is over its ceiling — nothing goes out', health };
  }

  const clickers = await stuckAt(env, 'clicked', { limit: limit * 3 });
  const site = env?.SITE || 'https://itsnum.com';

  const todo = [];
  for (const c of clickers) {
    if (todo.length >= limit) break;
    const already = await env.DB.prepare(
      'SELECT email FROM num_biz_followups WHERE email = ?1 AND kind = ?2',
    ).bind(String(c.email).toLowerCase(), KIND).first().catch(() => null);
    if (!already) todo.push(c);
  }
  if (!todo.length) return { sent: 0, reason: 'nobody is waiting on this one', candidates: clickers.length };

  if (dryRun) {
    return {
      sent: 0, dryRun: true, would_send: todo.length, candidates: clickers.length,
      sample: todo.slice(0, 5).map((t) => ({ email: t.email, business: t.business_name, clicked: t.clicked_at })),
      health,
    };
  }

  const { send, AUDIENCE } = await import('./mailer.mjs');
  let sent = 0;
  const failed = [];

  for (const c of todo) {
    const thread = await openThread(env, {
      email: c.email, businessName: c.business_name, inviteToken: c.token,
      dest: c.dest, country: c.country, state: 'clicked',
    }).catch(() => null);

    const claimUrl = `${site}/claim/?ref=${encodeURIComponent(c.token ?? '')}`;
    const msg = compose({ businessName: c.business_name, claimUrl });

    const out = await send(env, {
      to: c.email,
      // The transactional-side sender deliberately, not the outreach one.
      // This is a correction to somebody who already engaged, it must reach
      // the inbox, and it must not ride whatever reputation the cold list
      // built. See the sender split in mailer.mjs.
      from: env?.MAIL_FROM_BIZ || env?.MAIL_FROM || 'NUM <hello@itsnum.com>',
      replyTo: thread ? replyAddress(env, thread.reply_key) : (env?.MAIL_REPLY_TO || 'hello@itsnum.com'),
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: {
        'List-Unsubscribe': `<${site}/api/accounts/unsubscribe?t=${encodeURIComponent(c.token ?? '')}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }, { audience: AUDIENCE.EXTERNAL }).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }));

    if (!out?.ok) { failed.push({ email: c.email, error: out?.error }); continue; }

    // Written only after a transport accepted it. Marking first would repeat
    // 30 Aug 2026 exactly: six businesses recorded as told, none told, and a
    // sweep that skipped them for ever after.
    await env.DB.prepare(
      'INSERT OR IGNORE INTO num_biz_followups (email, kind, thread_id, provider_id) VALUES (?1,?2,?3,?4)',
    ).bind(String(c.email).toLowerCase(), KIND, thread?.id ?? null, out.id ?? null).run().catch(() => {});

    if (thread) {
      await record(env, thread.id, {
        direction: 'out', to: c.email, subject: msg.subject, body: msg.text,
        providerId: out.id, state: 'sent', draftedBy: 'followup',
      }).catch(() => {});
    }
    sent += 1;
  }

  return { sent, failed: failed.length, failures: failed.slice(0, 5), candidates: clickers.length, health };
}
