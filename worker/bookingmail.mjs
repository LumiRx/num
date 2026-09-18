/**
 * THE CONFIRMATION EMAIL — the artefact a booking leaves behind.
 *
 * Dre, 18 Sep: "we need to layout the confirmation emails." The layout had
 * been in email.mjs since August (TEMPLATES.booking, TEMPLATES.changed —
 * tables, inline styles, a text part) and nothing ever sent it: a venue
 * confirmed a table, the member got a push if they were one of the two with
 * a subscription, and the email that survives a reinstall and gets forwarded
 * to whoever is coming was never written. This file is the send.
 *
 * ── WHO GETS ONE ─────────────────────────────────────────────────────────
 *
 * The address on the member's row, and only when NUM has reason to believe
 * the row is that person's: the email is verified, OR the phone is (they
 * typed the address into an account NUM has already reached by text). A
 * booking's details — a name, a venue, a time, a party size — sent to an
 * address nobody has confirmed is a booking sent to a stranger. Zero members
 * have a verified email today (18 Sep audit) and eight have a verified
 * phone, so the second clause is the one that makes this feature exist.
 *
 * ── WHAT IT NEVER CLAIMS ─────────────────────────────────────────────────
 *
 * "Sent" here means Resend accepted it (mailer.mjs, audience EXTERNAL — the
 * Cloudflare binding is not allowed to carry mail to the world because it
 * reports nothing). recordSend keeps the outcome. Nothing writes "the member
 * was told" on the strength of an accept.
 *
 * Never throws: the venue's page must render whether or not the mail went.
 */
import { composeTemplate } from './email.mjs';
import { send, recordSend, AUDIENCE } from './mailer.mjs';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The address a booking email may go to, or null with the reason. Pure. */
export function recipientFor(member) {
  const email = String(member?.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) return { to: null, why: 'no_email' };
  const trusted = Number(member.email_verified) === 1 || Number(member.phone_verified) === 1;
  if (!trusted) return { to: null, why: 'unverified' };
  return { to: email, why: null };
}

/** "Fri 25 Sep" from "2026-09-25"; the stored string when it is not a date. */
export function dayOf(onDate) {
  const s = String(onDate ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s || null;
  // Hand-rolled, not toLocaleDateString: Node's ICU says "Sept" where every
  // phone says "Sep", and a test that depends on which ICU is installed is
  // a test that fails on someone else's machine.
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** The template data for one table request, from the row the desk holds. */
export function bookingData(row, { place = null, appUrl = 'https://app.itsnum.com' } = {}) {
  return {
    title: row.venue_name,
    day: dayOf(row.on_date),
    time: row.at_time || null,
    place: row.venue_name,
    address: place?.address ?? null,
    party: row.party_size ? Number(row.party_size) : null,
    // No cost line: a table request carries no price NUM knows. The template
    // drops an empty row rather than printing "—".
    cost: null,
    reference: row.id ? String(row.id).toUpperCase() : null,
    note: row.note ? `You asked: “${row.note}”` : null,
    link: `${appUrl}/?go=plan`,
    intro: `${row.venue_name} has confirmed your table. Here it is in full:`,
  };
}

export function declinedData(row, { appUrl = 'https://app.itsnum.com' } = {}) {
  return {
    title: row.venue_name,
    // No trailing stop: the template's preheader adds its own.
    what: `${row.venue_name} couldn’t take the table${row.on_date ? ` on ${dayOf(row.on_date)}` : ''}${row.at_time ? ` at ${row.at_time}` : ''}`,
    was: [dayOf(row.on_date), row.at_time].filter(Boolean).join(' · ') || null,
    now: 'Not booked — tell NUM and it will find somewhere as good.',
    place: row.venue_name,
    link: `${appUrl}/?go=plan`,
  };
}

/**
 * Send the email for a table request that just flipped. `verdict` is
 * 'confirmed' or 'declined'; anything else sends nothing.
 */
export async function sendBookingMail(env, { row, verdict, place = null }) {
  try {
    if (!env?.DB || !row?.member_id) return { ok: false, reason: 'no_row' };
    const kind = verdict === 'confirmed' ? 'booking' : verdict === 'declined' ? 'changed' : null;
    if (!kind) return { ok: false, reason: 'no_template_for_verdict' };

    const member = await env.DB.prepare('SELECT id, email, email_verified, phone_verified FROM num_members WHERE id = ?1').bind(row.member_id).first();
    const { to, why } = recipientFor(member);
    if (!to) return { ok: false, reason: why };

    const data = kind === 'booking' ? bookingData(row, { place }) : declinedData(row);
    const msg = composeTemplate(kind, data);
    if (!msg) return { ok: false, reason: 'unknown_template' };

    const out = await send(env, { to, subject: msg.subject, html: msg.html, text: msg.text }, { audience: AUDIENCE.EXTERNAL });
    await recordSend(env, `booking_${verdict}`, out).catch(() => {});
    if (!out.ok) console.warn('[bookingmail]', verdict, 'not sent:', out.error);
    return out.ok ? { ok: true, to, via: out.via, id: out.id ?? null } : { ok: false, reason: out.error };
  } catch (err) {
    console.error('[bookingmail] threw, swallowed so the venue page renders', err?.stack ?? err);
    return { ok: false, reason: 'threw' };
  }
}
