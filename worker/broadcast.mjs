// Texting the audience — the whole audience, at once, safely.
//
// ── WHAT THIS WILL AND WILL NOT DO ───────────────────────────────────────
//
// It sends to every number that has a live consent row. It will not send to
// anything else, and there is no argument, flag or hurry that changes that.
//
// The reason is arithmetic rather than principle. Num holds 1,830,191 scraped
// business numbers. A single unconsented text to a US mobile is $500–$1,500
// in TCPA statutory damages. Ten thousand of them is a five-to-fifteen
// million dollar class action with a plaintiff list we assembled and handed
// over. There is no version of that which ends with a travel company.
//
// So `select()` reads `num_sms_consent` and nothing else. Not `places.phone`,
// not `leads.phone`. Those tables are not reachable from this file.
//
// ── AND THE PART THAT IS ACTUALLY ABOUT REVENUE ──────────────────────────
//
// A consented list is not merely the legal one, it is the one that works. The
// people on it texted Num first — they want an answer. A blast to scraped
// numbers has a response rate indistinguishable from zero, gets the sending
// number blocked within hours, and takes the A2P registration with it.
//
// The audience is currently ZERO, and that is the real finding. Every send
// path is built, tested and correct; there is simply nobody who has said yes
// yet. `smsconsent.mjs` now turns every inbound text into a consent row, so
// the number climbs from the moment anybody texts. This file is what makes
// that list worth having.

import { reachable, audience } from './smsconsent.mjs';

/** A message must carry these or it should not leave. */
export const STOP_HINT = /\bSTOP\b/;
export const SEGMENT = 160;

/**
 * Quiet hours, in the RECIPIENT'S timezone, never ours.
 *
 * The US TCPA rule is 8am–9pm local to the called party. Texting a Phuket
 * number at what is a civilised hour in Edinburgh is both an offence and the
 * fastest way to be reported.
 */
export const QUIET = Object.freeze({ from: 21, to: 8 });

const TZ_BY_PREFIX = Object.freeze({
  '+1': 'America/New_York',
  '+44': 'Europe/London',
  '+66': 'Asia/Bangkok',
  '+971': 'Asia/Dubai',
  '+966': 'Asia/Riyadh',
  '+61': 'Australia/Sydney',
  '+65': 'Asia/Singapore',
});

export function tzFor(phone) {
  const p = String(phone ?? '');
  // Longest prefix wins: +1 must not swallow +
  for (const len of [4, 3, 2]) {
    const key = p.slice(0, len);
    if (TZ_BY_PREFIX[key]) return TZ_BY_PREFIX[key];
  }
  return null;
}

/** Is it a decent hour where they are? Unknown timezone is treated as no. */
export function withinHours(phone, now = new Date()) {
  const tz = tzFor(phone);
  if (!tz) return { ok: false, why: 'unknown timezone — refusing rather than guessing at their local hour' };
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(now));
  const ok = hour >= QUIET.to && hour < QUIET.from;
  return ok ? { ok: true, tz, hour } : { ok: false, tz, hour, why: `${hour}:00 local — quiet hours` };
}

/**
 * What must be true of the text itself.
 *
 * Every one of these is a carrier or statutory requirement rather than a
 * style preference, which is why they are checked here and not left to
 * whoever writes the copy at speed.
 */
export function checkMessage(body) {
  const s = String(body ?? '').trim();
  const problems = [];
  if (!s) problems.push('empty message');
  if (s.length > SEGMENT * 3) problems.push(`${s.length} characters is more than three segments`);
  if (!/\bNUM\b/i.test(s)) problems.push('the message must name NUM — an unidentified sender reads as a scam, correctly');
  if (!STOP_HINT.test(s)) problems.push('every broadcast must say how to STOP');
  if (/\b(free|winner|congratulations|click here|act now|guaranteed)\b/i.test(s)) {
    problems.push('carrier spam filters drop this wording, and it is not how Num talks anyway');
  }
  return { ok: problems.length === 0, problems, segments: Math.ceil(s.length / SEGMENT) };
}

/**
 * The audience — consented numbers only.
 *
 * Deliberately joins nothing to `places` or `leads`. There is no code path
 * from a scraped number to a send, and that absence is the feature.
 */
export async function select(env, limit = 100) {
  if (!env?.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT c.phone, c.first_name
       FROM num_sms_consent c
      WHERE c.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM num_text_optouts o WHERE o.phone = c.phone)
      ORDER BY c.created_at ASC
      LIMIT ?1`,
  ).bind(Math.max(1, Math.min(limit, 500))).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/**
 * Send a broadcast.
 *
 * DRY RUN BY DEFAULT. `live: true` is required to send anything, because the
 * difference between previewing a blast and sending one should be a decision
 * somebody typed, not a default they inherited.
 *
 * @param {Function} sendOne async (env, to, body) => ({ok, error?})
 *   Injected, so this file never imports Twilio and the whole thing is
 *   testable without a carrier.
 */
export async function broadcast(env, { body, live = false, limit = 100, now = new Date(), sendOne }) {
  const msg = checkMessage(body);
  if (!msg.ok) return { ok: false, stage: 'message', problems: msg.problems };

  const aud = await audience(env);
  if (!aud.consented) {
    return {
      ok: false,
      stage: 'audience',
      consented: 0,
      // Said plainly, because the instinct when a blast returns zero is to go
      // looking for a bigger list, and the bigger list is the one that ends
      // the company.
      why: 'Nobody has consented to be texted yet, so there is nobody to send to. '
        + 'The 1.8m numbers in `places` and the 87k on `leads` were scraped, not offered — texting them is '
        + 'a TCPA claim per message, and the A2P campaign would reject them anyway. '
        + 'Every inbound text now writes a consent row, so this number grows the moment people start texting NUM.',
    };
  }

  const rows = await select(env, limit);
  const sent = [];
  const skipped = [];

  for (const r of rows) {
    // Checked per recipient at send time, not once for the batch. A person
    // who texts STOP while a broadcast is running must not receive the rest
    // of it.
    const can = await reachable(env, r.phone);
    if (!can.ok) { skipped.push({ phone: r.phone, why: can.why }); continue; }

    const hours = withinHours(r.phone, now);
    if (!hours.ok) { skipped.push({ phone: r.phone, why: hours.why }); continue; }

    if (!live) { sent.push({ phone: r.phone, dryRun: true }); continue; }

    const out = await sendOne(env, r.phone, body).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (out?.ok) sent.push({ phone: r.phone, id: out.id ?? null });
    else skipped.push({ phone: r.phone, why: out?.error ?? 'send failed' });
  }

  return {
    ok: true,
    live,
    consented: aud.consented,
    segments: msg.segments,
    sent: sent.length,
    skipped: skipped.length,
    detail: { sent, skipped: skipped.slice(0, 20) },
  };
}
