/**
 * THE BOOKING REQUEST, BY EMAIL, WITH THE ANSWER ONE TAP AWAY.
 *
 * ── WHY EMAIL IS NOT THE POOR RELATION HERE ──────────────────────────────
 *
 * `bookdesk.mjs` texts the venue and the venue taps CONFIRM or DECLINE. It is
 * the right shape and it has never once run: `partnerMayBeTexted` requires a
 * row in `num_sms_consent`, no venue has opted in, and the gate fails closed.
 * Every booking request NUM has taken has been worked by a human.
 *
 * So this is the first partner channel that can actually carry a booking end
 * to end. It is also the one the venues we most want asked for: Hugo's
 * Restaurant, four sites in Los Angeles, wrote on 18 Sep 2026 that they do not
 * accept reservations by text message and asked whether they could claim their
 * profile anyway.
 *
 * ── THE SAME LOCK, A DIFFERENT DOOR ──────────────────────────────────────
 *
 * The links are signed by `signBookingAnswer` from bookdesk.mjs — the identical
 * HMAC over (id, verdict) that the SMS carries, landing on the identical
 * `/api/book/answer` handler. Not a copy: imported. A second implementation of
 * "may this person confirm this booking" is a second set of rules about who
 * owns a table, and the two drift on the day it matters.
 *
 * That means everything already true of the SMS answer is true here without
 * being restated: only `requested` moves, a second tap changes nothing, the
 * commission accrues exactly once, and the guest is told by the same path.
 *
 * ── WHY THERE IS NO LOGIN, AND WHY THAT IS NOT A SHORTCUT ────────────────
 *
 * A reservations mailbox is read by whoever is on shift. Putting a password
 * between a host stand and a table request guarantees the request is answered
 * late or not at all, and a late answer is a lost guest. The signed link IS the
 * authorisation, and it authorises exactly one verdict on exactly one booking —
 * which is more precisely scoped than the account it replaces, not less.
 *
 * ── AND WHAT THIS MAIL IS NOT ────────────────────────────────────────────
 *
 * It is not marketing, it carries no tracking pixel, and it is sent only to an
 * address the venue itself gave us for this purpose. It rides the transactional
 * path deliberately: an operational message about one guest's table must never
 * share a reputation with an outreach campaign, and the day the invite list
 * costs us the inbox is the day this email has to still arrive.
 */

import { send, AUDIENCE } from './mailer.mjs';
import { signBookingAnswer } from './bookdesk.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/** "tonight", or a date a human reads without parsing. */
function whenLine(row) {
  const d = row?.on_date ? String(row.on_date) : null;
  const t = row?.at_time ? String(row.at_time) : null;
  if (!d && !t) return 'tonight';
  if (!d) return `today at ${t}`;
  if (!t) return d;
  return `${d} at ${t}`;
}

/**
 * The plain-text half, and it is not an afterthought.
 *
 * Every message this system sends externally carries one. A booking request
 * that arrives as an empty box because a mail client would not render the HTML
 * is a table nobody answers for, and an HTML-only message is a spam signal on
 * top of that — which matters more here than anywhere, because this is the
 * mail that must never be filtered.
 */
function textBody({ venueName, guestName, party, when, note, yes, no }) {
  return [
    `Booking request from NUM for ${venueName}.`,
    '',
    `Party of ${party}`,
    `When: ${when}`,
    `Guest: ${guestName}`,
    note ? `Note: ${note}` : null,
    '',
    'Answer by opening one of these — no login, one tap:',
    `  CONFIRM: ${yes}`,
    `  DECLINE: ${no}`,
    '',
    'Whichever you choose, the guest is told straight away.',
    'You chose email for NUM bookings. Reply to this message to change that,',
    'or to stop them altogether.',
    '',
    'NUM · itsnum.com',
  ].filter((l) => l !== null).join('\n');
}

function htmlBody({ venueName, guestName, party, when, note, yes, no }) {
  const row = (k, v) => `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;white-space:nowrap">${esc(k)}</td>`
    + `<td style="padding:6px 0;color:#111827;font:600 15px/1.5 -apple-system,Segoe UI,Arial,sans-serif">${esc(v)}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;background:#fff;border-radius:14px;border:1px solid #e5e7eb">
  <tr><td style="padding:26px 28px 6px">
    <div style="font:700 12px/1.4 -apple-system,Segoe UI,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#6b7280">Booking request</div>
    <h1 style="margin:8px 0 0;font:700 22px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#111827">${esc(venueName)}</h1>
  </td></tr>
  <tr><td style="padding:14px 28px 4px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      ${row('Party', String(party))}
      ${row('When', when)}
      ${row('Guest', guestName)}
      ${note ? row('Note', note) : ''}
    </table>
  </td></tr>
  <tr><td style="padding:22px 28px 6px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:#0e8a63;border-radius:10px">
        <a href="${esc(yes)}" style="display:inline-block;padding:14px 26px;font:700 16px/1 -apple-system,Segoe UI,Arial,sans-serif;color:#fff;text-decoration:none">Confirm this table</a>
      </td>
      <td style="width:12px"></td>
      <td style="border:1px solid #d1d5db;border-radius:10px">
        <a href="${esc(no)}" style="display:inline-block;padding:13px 22px;font:600 16px/1 -apple-system,Segoe UI,Arial,sans-serif;color:#374151;text-decoration:none">Can't take it</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:16px 28px 26px">
    <p style="margin:0;font:14px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280">
      One tap, no login. Whichever you choose, the guest is told straight away.<br>
      You chose email for NUM bookings — reply to this message to change that, or to stop them.
    </p>
  </td></tr>
</table>
<div style="padding:14px 0 0;font:12px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#9ca3af">NUM · itsnum.com</div>
</td></tr></table></body></html>`;
}

/**
 * Send one booking request to a venue's reservations mailbox.
 *
 * Returns what actually happened, never a bare boolean: the caller writes
 * "the venue has it" into a sentence a guest reads, and that sentence has been
 * wrong before — on 30 Aug 2026 six businesses were marked told and none were.
 * `ok` here means a transport accepted it, which is all any transport ever
 * reports, and the delivery webhook is what upgrades that to evidence.
 */
export async function mailVenueBooking(env, { row, to, venueName, guestName }) {
  if (!row?.id) return { ok: false, reason: 'no_booking' };
  if (!to) return { ok: false, reason: 'no_address' };

  const origin = env?.NUM_APP_ORIGIN || 'https://app.itsnum.com';
  const [yesTok, noTok] = await Promise.all([
    signBookingAnswer(env, row.id, 'confirmed'),
    signBookingAnswer(env, row.id, 'declined'),
  ]);
  const yes = `${origin}/api/book/answer?id=${encodeURIComponent(row.id)}&v=confirmed&t=${yesTok}`;
  const no = `${origin}/api/book/answer?id=${encodeURIComponent(row.id)}&v=declined&t=${noTok}`;

  const party = Math.min(Math.max(Number(row.party_size) || 2, 1), 40);
  const fields = {
    venueName: venueName || row.venue_name || 'your venue',
    guestName: guestName || 'a NUM guest',
    party, when: whenLine(row),
    note: row.note ? String(row.note).slice(0, 200) : null,
    yes, no,
  };

  const out = await send(env, {
    to,
    from: env?.MAIL_FROM_BOOKINGS || env?.MAIL_FROM || 'NUM bookings <bookings@itsnum.com>',
    // Replying is a supported way to answer — a host stand that types "yes,
    // 7.30 is fine" has done the job, and a person reads it. An unmonitored
    // no-reply address on an operational message is a way of saying we are
    // not really here.
    replyTo: env?.MAIL_REPLY_TO || 'info@itsnum.com',
    subject: `Table for ${party} — ${fields.when} — ${fields.venueName}`,
    text: textBody(fields),
    html: htmlBody(fields),
  }, { audience: AUDIENCE.EXTERNAL }).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }));

  return out?.ok
    ? { ok: true, via: out.via, id: out.id, proof: 'accepted' }
    : { ok: false, reason: out?.error || 'send_failed' };
}

export const __testables = { textBody, htmlBody, whenLine };
