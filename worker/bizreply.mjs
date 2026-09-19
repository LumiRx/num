/**
 * DRAFTING AN ANSWER TO A BUSINESS — and never sending one on our own.
 *
 * ── WHAT IS ACTUALLY DANGEROUS HERE ──────────────────────────────────────
 *
 * This writes to a restaurant, in NUM's name, about commercial terms. The
 * failure mode is not a clumsy sentence. It is a model that says "yes, we can
 * connect to SevenRooms" when we cannot, or "we take 5%" when we take ten, or
 * "your table is confirmed" about a booking nobody made — in writing, from the
 * company, to a merchant who will hold us to it.
 *
 * So the design is not "an assistant that answers email". It is:
 *
 *   1. A FACTS block built from the database by bizstate.mjs. Not retrieved,
 *      not summarised — the actual rows.
 *   2. A model that may use ONLY those facts, and is told to say it does not
 *      know rather than fill a gap.
 *   3. A guard that reads the draft back and refuses it on the specific
 *      things that cost money or trust: invented figures, invented links,
 *      words that promise.
 *   4. A human tap. Always. `draft()` and `send()` are different functions and
 *      nothing in this file calls the second.
 *
 * Steps 3 and 4 are both there on purpose. A guard that is the only defence
 * will eventually be walked around by a sentence nobody predicted; a human
 * who is the only defence will eventually approve on autopilot. Neither is
 * sufficient and together they are reasonable.
 *
 * ── WHY IT DRAFTS AT ALL ─────────────────────────────────────────────────
 *
 * Because the alternative, measured: two verified businesses out of 3,538
 * invitations, and the one substantive reply anybody can point to arrived as a
 * screenshot. A business that writes in and waits four days for an answer has
 * already learned what it needed to know about us. Speed is the product here,
 * and the draft is what makes speed possible without making it reckless.
 */

import { stateOf } from './bizstate.mjs';
import { conversation, threadById, replyAddress, record, markSent } from './bizthread.mjs';

/**
 * The published prices, verbatim, so the model has no reason to invent one.
 *
 * Copied from the claim page rather than paraphrased. These are the only
 * figures a draft is allowed to contain, and the guard below enforces it.
 */
export const PRICE_FACTS = Object.freeze([
  'Listing is free. No signup fee, no monthly fee, no card.',
  // Commission on a booking NUM completed, a flat fee on one it did not.
  // These two were the wrong way round until 19 Sep 2026: this block said a
  // completed table was $2.00 flat, while billpay.mjs charged 10% and the
  // pricing page said 10%. This block is what the reply guard enforces, so
  // the venue was being quoted a price the ledger never charges.
  'A booking NUM completes costs a share of the bill: 10% on a table, 15% on a room or appointment, 20% on an activity or tour, 10% on a delivery order.',
  'A guest NUM did not send, who settles through NUM’s code, costs a flat $2.00 (£1.50, €2.00, ฿70) — never a percentage of their bill.',
  'Nothing is charged for a no-show, for a declined request, or for a guest who came on their own and did not settle through NUM.',
]);

const ALLOWED_LINKS = [
  'https://itsnum.com/claim/',
  'https://itsnum.com/get',
  'https://itsnum.com/business',
  'https://itsnum.com/privacy',
  'https://itsnum.com/terms',
];

/** Figures a draft may contain, because they are published or on the record. */
function allowedFigures(state) {
  const out = new Set(['2', '2.00', '1.50', '70', '10', '15', '20', '0']);
  for (const v of [state?.evidence?.channel?.sms_to, state?.evidence?.group?.sites]) {
    if (v != null) String(v).match(/\d+/g)?.forEach((d) => out.add(d));
  }
  return out;
}

/**
 * Everything true about this business, as a block a model can read.
 *
 * Deliberately blunt and slightly ugly. A prose summary would invite the model
 * to continue the prose; a list of facts with a heading that says these are
 * the only ones invites it to stop.
 */
export function factsBlock(state, thread) {
  const e = state?.evidence ?? {};
  const lines = [
    `Business: ${state?.business_name ?? 'unknown'}`,
    state?.contact_name ? `Contact: ${state.contact_name}` : null,
    `Their email: ${state?.email ?? thread?.email ?? 'unknown'}`,
    state?.dest ? `Where: ${state.dest}${state.country ? `, ${state.country}` : ''}` : null,
    `How far they have got: ${state?.step ?? 'unknown'}`,
    `What would move them forward: ${state?.next?.say ?? 'unknown'} (whose move: ${state?.next?.blocked_by ?? 'unknown'})`,
    e.application ? `They filled the claim form on ${e.application.created_at}.` : 'They have not filled the claim form.',
    e.attempt ? `A verification code was sent by ${e.attempt.channel} and is ${e.attempt.state}.` : 'No verification code has been sent.',
    e.owner ? `They have PROVED they control the listing (${e.owner.method}, ${e.owner.verified_at}).` : 'They have NOT yet proved they control the listing.',
    e.channel?.via
      ? `They chose to receive bookings by: ${e.channel.via}`
        + (e.channel.email_to ? ` at ${e.channel.email_to}` : '')
        + (e.channel.sms_to ? ` at ${e.channel.sms_to}` : '')
        + (e.channel.system_name ? ` (their own system: ${e.channel.system_name})` : '')
      : 'Nobody has asked them how bookings should reach them.',
    e.channel?.integration && e.channel.integration !== 'none'
      ? `Integration with their system is at: ${e.channel.integration}. It is NOT built.`
      : null,
    e.group ? `They are in the group "${e.group.name}" with ${e.group.sites} locations.` : 'They have one location on NUM.',
    state?.unsubscribed ? 'THEY UNSUBSCRIBED. Do not draft anything.' : null,
  ].filter((l) => l !== null);
  return lines.join('\n');
}

function prompt({ state, thread, history, facts }) {
  return [
    'You are drafting a reply on behalf of NUM, a travel concierge, to a business that wrote to us.',
    'A person at NUM reads your draft and decides whether to send it. Write the message only.',
    '',
    '== THE ONLY FACTS YOU MAY USE ==',
    facts,
    '',
    '== THE ONLY PRICES YOU MAY QUOTE ==',
    PRICE_FACTS.join('\n'),
    '',
    '== THE CONVERSATION SO FAR (oldest first) ==',
    history,
    '',
    '== RULES ==',
    '- Answer what they actually asked. If they asked two things, answer both.',
    '- If the facts above do not answer something, SAY you will find out. Never guess, never fill a gap.',
    '- Never say a booking is confirmed, booked, held or guaranteed.',
    '- Never promise an integration, a date, or a feature. If they asked for one, say it is not built and that we will tell them when it is.',
    '- No prices other than the ones listed above. No percentages of your own.',
    `- Links only from this list, and only if useful: ${ALLOWED_LINKS.join(' ')}`,
    '- Plain text. No subject line, no sign-off block, no emoji, no markdown.',
    '- Warm and direct, the way a founder writes. Short. Under 200 words.',
    '- If they raised a problem that was ours, say so plainly rather than managing it.',
  ].join('\n');
}

async function ask(env, text, { fetchImpl = fetch } = {}) {
  if (!env?.ANTHROPIC_API_KEY) return null;
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.NUM_REPLY_MODEL || 'claude-sonnet-4-5-20250929',
      max_tokens: 600,
      messages: [{ role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(25000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  return (j?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim() || null;
}

const PROMISES = /\b(confirmed|booked|guaranteed|reserved|we will (build|ship|have|deliver)|by (next|the) (week|month)|within \d+ (days?|weeks?))\b/i;

/**
 * Read the draft back and refuse it on the things that cost money or trust.
 *
 * Returns `{ ok }` or `{ ok: false, why }`. The reason is kept and shown: a
 * guard that silently discards teaches nobody anything, and the refusals
 * themselves are the record of what this model gets wrong.
 */
export function guard(text, state) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, why: 'empty draft' };
  if (t.length < 40) return { ok: false, why: 'too short to be an answer' };
  if (t.length > 2000) return { ok: false, why: 'too long — nobody reads it and it will contain something unchecked' };
  if (state?.unsubscribed) return { ok: false, why: 'this contact unsubscribed' };

  const promise = t.match(PROMISES);
  if (promise) return { ok: false, why: `promises something we have not made true: "${promise[0]}"` };

  for (const url of t.match(/https?:\/\/[^\s)>\]]+/g) ?? []) {
    const clean = url.replace(/[.,;]$/, '');
    if (!ALLOWED_LINKS.some((a) => clean.startsWith(a))) {
      return { ok: false, why: `invented or unapproved link: ${clean}` };
    }
  }

  // Money and percentages are the expensive kind of wrong. Anything numeric
  // that reads as a figure has to be one we published or one on the record.
  const allowed = allowedFigures(state);
  for (const m of t.match(/(?:[$£€฿]\s?\d[\d,.]*|\b\d[\d,.]*\s?%)/g) ?? []) {
    // A figure at the end of a sentence carries the full stop into the match,
    // because the character class cannot tell a decimal point from one. The
    // first version of this did not strip it, so "a completed booking is
    // $2.00." — our own published price, correctly quoted — normalised to
    // "2.00." and was refused. A guard that rejects the truth teaches people
    // to switch it off.
    const digits = m.replace(/[^\d.]/g, '').replace(/\.+$/, '').replace(/\.00$/, '');
    if (!allowed.has(digits) && !allowed.has(`${digits}.00`)) {
      return { ok: false, why: `quotes a figure we did not publish: ${m.trim()}` };
    }
  }
  return { ok: true };
}

/**
 * Draft a reply and store it as a draft. Sends nothing.
 *
 * Returns the stored draft, or a refusal with a reason. A refusal is a normal
 * outcome and leaves the thread exactly as it was — still flagged as needing
 * an answer, because it does.
 */
export async function draftReply(env, threadId, { fetchImpl = fetch, by = 'agent' } = {}) {
  const thread = await threadById(env, threadId);
  if (!thread) return { ok: false, why: 'no such thread' };

  const state = await stateOf(env, {
    email: thread.email, placeId: thread.place_id, businessId: thread.business_id,
  }).catch(() => null);

  if (state?.unsubscribed) return { ok: false, why: 'this contact unsubscribed — nothing is drafted' };

  const msgs = await conversation(env, threadId, { limit: 12 });
  const inbound = msgs.filter((m) => m.direction === 'in');
  if (!inbound.length) return { ok: false, why: 'nothing has come in on this thread to answer' };

  const history = msgs.map((m) => (
    `[${m.direction === 'in' ? 'THEM' : 'NUM'} ${m.created_at}] ${m.subject ?? ''}\n${String(m.body ?? '').slice(0, 2000)}`
  )).join('\n\n---\n\n');

  const facts = factsBlock(state, thread);
  const text = await ask(env, prompt({ state, thread, history, facts }), { fetchImpl });
  if (!text) return { ok: false, why: 'the model did not answer' };

  const check = guard(text, state);
  if (!check.ok) {
    console.warn('[bizreply] draft refused:', check.why);
    return { ok: false, why: check.why, rejected: text };
  }

  const last = inbound[inbound.length - 1];
  const subject = /^re:/i.test(last.subject ?? '') ? last.subject : `Re: ${last.subject ?? 'NUM'}`;

  const stored = await record(env, threadId, {
    direction: 'out',
    to: thread.email,
    from: env?.MAIL_FROM_BIZ || env?.MAIL_FROM || 'NUM <hello@itsnum.com>',
    subject,
    body: text,
    state: 'draft',
    draftedBy: by,
  });
  return { ok: true, id: stored.id, subject, body: text, state, next: state?.next ?? null };
}

/**
 * Send a draft, once a person has approved it.
 *
 * `by` is required and recorded. "Who approved this" is the first question
 * anybody asks about a message a business disputes, and a default of 'system'
 * would make the answer a lie on the day it mattered.
 */
export async function approveAndSend(env, messageId, by) {
  if (!by) return { ok: false, why: 'an approval needs a name' };
  const row = await env.DB.prepare('SELECT * FROM num_biz_messages WHERE id = ?1')
    .bind(String(messageId)).first().catch(() => null);
  if (!row) return { ok: false, why: 'no such draft' };
  if (row.state !== 'draft') return { ok: false, why: `that message is ${row.state}, not a draft` };

  const thread = await threadById(env, row.thread_id);
  if (!thread) return { ok: false, why: 'the thread is gone' };

  // Re-checked at the moment of sending, not only when drafted. A draft that
  // sat overnight may have been overtaken — an unsubscribe, most obviously.
  const state = await stateOf(env, { email: thread.email, placeId: thread.place_id }).catch(() => null);
  const check = guard(row.body, state);
  if (!check.ok) return { ok: false, why: `refused at send: ${check.why}` };

  await env.DB.prepare("UPDATE num_biz_messages SET state='approved', approved_by=?2, approved_at=datetime('now') WHERE id=?1")
    .bind(row.id, String(by).slice(0, 60)).run().catch(() => {});

  const { send, AUDIENCE } = await import('./mailer.mjs');
  const out = await send(env, {
    to: thread.email,
    from: env?.MAIL_FROM_BIZ || env?.MAIL_FROM || 'NUM <hello@itsnum.com>',
    replyTo: replyAddress(env, thread.reply_key),
    subject: row.subject,
    text: row.body,
  }, { audience: AUDIENCE.EXTERNAL }).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }));

  if (!out?.ok) {
    await env.DB.prepare("UPDATE num_biz_messages SET state='failed' WHERE id=?1").bind(row.id).run().catch(() => {});
    return { ok: false, why: out?.error ?? 'send failed' };
  }
  await markSent(env, row.id, out.id);
  return { ok: true, id: row.id, via: out.via };
}

export async function decline(env, messageId, by, why = null) {
  if (!env?.DB || !messageId) return { ok: false };
  // Kept, not deleted. The drafts a person threw away are the only honest
  // record of what this thing gets wrong.
  await env.DB.prepare(
    "UPDATE num_biz_messages SET state='declined', approved_by=?2, approved_at=datetime('now') WHERE id=?1 AND state='draft'",
  ).bind(String(messageId), String(by ?? 'unknown').slice(0, 60)).run().catch(() => {});
  if (why) {
    await env.DB.prepare('UPDATE num_biz_messages SET matched_by = ?2 WHERE id = ?1')
      .bind(String(messageId), String(why).slice(0, 20)).run().catch(() => {});
  }
  return { ok: true };
}

export const __testables = { prompt, factsBlock, allowedFigures };
