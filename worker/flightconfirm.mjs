// What lands in somebody's inbox and on their phone after they book.
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────
//
// A confirmation is the only document most travellers keep. It is read at a
// check-in desk at 5am by somebody who is stressed, on a phone, possibly
// without signal. So: the reference and the times come first, the prose comes
// last, and nothing that matters is only in the HTML.
//
// ── AND THE RULE THAT COMES FROM THE SIMULATOR ───────────────────────────
//
// If the issue was simulated, every artifact says so — in the subject line,
// in the first line of the body, in the SMS, and on the ticket itself. Not in
// a footer, not in grey text. A simulated confirmation that reads like a real
// one is a person at an airport with a reference that does not exist, and the
// only defence against that is making it impossible to mistake at a glance.
//
// ── WHY TEXT AND HTML ARE BUILT FROM THE SAME OBJECT ─────────────────────
//
// Two templates drift. The plain-text version is not a fallback nobody reads;
// it is what a watch, a screen reader and a stripped corporate mail client
// actually show, and on the day the HTML fails to render it is the whole
// document. Both come out of `itinerary()` so they cannot disagree about a
// departure time.

import { SIM_MARK } from './issuer.mjs';

const pad = (n) => String(n).padStart(2, '0');

/** "Mon 14 Sep 2026" — the format that is unambiguous in every country. */
export function longDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mon[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const money = (cs, cur = 'USD') => {
  const sym = { USD: '$', GBP: '£', EUR: '€', AED: 'AED ', THB: '฿' }[cur] ?? `${cur} `;
  return `${sym}${(Number(cs || 0) / 100).toFixed(2)}`;
};

/**
 * The single source of truth both renderers read.
 *
 * Everything a traveller needs is a top-level key here. If a fact is only
 * reachable by digging into `booking.offer.segments[0]`, one of the two
 * templates will eventually forget it.
 */
export function itinerary(booking, issued) {
  const o = booking?.offer ?? {};
  return {
    simulated: issued?.simulated === true,
    reference: issued?.reference ?? null,
    airlineRef: issued?.airline_ref ?? null,
    issuedAt: issued?.issued_at ?? null,
    carrier: o.carrier ?? '',
    flightNo: o.flight_no ?? '',
    origin: o.origin ?? '',
    originName: o.origin_name ?? o.origin ?? '',
    dest: o.dest ?? '',
    destName: o.dest_name ?? o.dest ?? '',
    departDate: o.depart_date ?? '',
    departTime: o.depart_time ?? '',
    arriveTime: o.arrive_time ?? '',
    duration: o.duration ?? '',
    returnDate: o.return_date ?? null,
    returnFlightNo: o.return_flight_no ?? null,
    returnDepartTime: o.return_depart_time ?? null,
    returnArriveTime: o.return_arrive_time ?? null,
    baggage: o.baggage ?? null,
    cabin: o.cabin ?? 'Economy',
    currency: o.currency ?? 'USD',
    fareCs: o.fare_cs ?? 0,
    taxCs: o.tax_cs ?? 0,
    feeCs: o.fee_cs ?? 0,
    totalCs: o.price ?? ((o.fare_cs ?? 0) + (o.tax_cs ?? 0) + (o.fee_cs ?? 0)),
    passengers: (booking?.passengers ?? []).map((p, i) => ({
      name: `${p.given_name ?? ''} ${p.family_name ?? ''}`.trim().toUpperCase(),
      ticket: issued?.tickets?.[i]?.number ?? null,
      passport: p.passport_number ?? null,
      nationality: p.nationality ?? null,
    })),
    email: booking?.contact?.email ?? null,
    phone: booking?.contact?.phone ?? null,
  };
}

/* ── SUBJECT ─────────────────────────────────────────────────────────────
   The reference goes in the subject because that is what people search their
   inbox for at the airport, and search does not open attachments. */
export function subject(it) {
  const core = `${it.reference} · ${it.origin}→${it.dest} ${longDate(it.departDate)}`;
  return it.simulated ? `[${SIM_MARK}] ${core}` : `Your flight is booked — ${core}`;
}

/* ── PLAIN TEXT ──────────────────────────────────────────────────────────
   Written to be read on a phone with the screen at minimum brightness. */
export function textEmail(it) {
  const L = [];
  if (it.simulated) {
    L.push(
      '*** ' + SIM_MARK + ' ***',
      'This is a test run of Num\'s booking flow. No ticket exists, no money',
      'has moved, and this reference will not be recognised by any airline.',
      '',
    );
  }
  L.push(
    it.simulated ? 'WHAT A REAL CONFIRMATION WOULD SAY' : 'YOUR FLIGHT IS BOOKED',
    '',
    `Booking reference   ${it.reference}`,
    `Airline reference   ${it.airlineRef}`,
    '',
    'OUTBOUND',
    `  ${longDate(it.departDate)}`,
    `  ${it.carrier} ${it.flightNo}   ${it.origin} → ${it.dest}`,
    `  Depart ${it.departTime}  Arrive ${it.arriveTime}${it.duration ? `  (${it.duration})` : ''}`,
    `  ${it.originName} → ${it.destName}`,
  );
  if (it.returnDate) {
    L.push(
      '',
      'RETURN',
      `  ${longDate(it.returnDate)}`,
      `  ${it.carrier} ${it.returnFlightNo}   ${it.dest} → ${it.origin}`,
      `  Depart ${it.returnDepartTime}  Arrive ${it.returnArriveTime}`,
    );
  }
  L.push('', 'PASSENGERS');
  for (const p of it.passengers) {
    L.push(`  ${p.name}${p.ticket ? `   ticket ${p.ticket}` : ''}`);
  }
  L.push(
    '',
    `Cabin      ${it.cabin}`,
    ...(it.baggage ? [`Baggage    ${it.baggage}`] : []),
    '',
    'WHAT YOU PAID',
    `  Fare          ${money(it.fareCs, it.currency)}`,
    `  Taxes         ${money(it.taxCs, it.currency)}`,
    ...(it.feeCs ? [`  Booking fee   ${money(it.feeCs, it.currency)}`] : []),
    `  TOTAL         ${money(it.totalCs, it.currency)}`,
    '',
    'BEFORE YOU FLY',
    '  · Check in from 48 hours before departure.',
    '  · Be at the airport 3 hours before an international departure.',
    '  · Your passport must match the name on this booking exactly.',
    '',
    it.simulated
      ? 'Nothing here is real. Reply to this and a person at Num will see it.'
      : 'Reply to this email and a person at Num will read it. If the airline needs '
        + 'you on the day they will use the mobile number on the booking.',
    '',
    'Num · 5arz Inc.',
  );
  return L.join('\n');
}

/* ── HTML ────────────────────────────────────────────────────────────────
   Table-based and inline-styled, because that is what mail clients render.
   No web fonts, no external images: a confirmation must survive being opened
   offline in an airport with images blocked. */
export function htmlEmail(it) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const row = (k, v) => `<tr><td style="padding:4px 16px 4px 0;color:#6b6e76;font-size:13px">${esc(k)}</td>`
    + `<td style="padding:4px 0;font-size:13px;font-weight:600">${esc(v)}</td></tr>`;

  const leg = (title, date, no, from, to, dep, arr) => `
    <div style="border:1px solid #e2dfd6;border-radius:4px;padding:16px;margin:0 0 12px">
      <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b6e76;margin-bottom:8px">${esc(title)}</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:10px">${esc(longDate(date))}</div>
      <table style="width:100%;border-collapse:collapse"><tr>
        <td style="font-size:26px;font-weight:700;letter-spacing:-.02em">${esc(from)}</td>
        <td style="text-align:center;color:#6b6e76;font-size:13px">${esc(no)}</td>
        <td style="font-size:26px;font-weight:700;letter-spacing:-.02em;text-align:right">${esc(to)}</td>
      </tr><tr>
        <td style="font-size:13px;color:#6b6e76">${esc(dep)}</td>
        <td></td>
        <td style="font-size:13px;color:#6b6e76;text-align:right">${esc(arr)}</td>
      </tr></table>
    </div>`;

  const banner = it.simulated ? `
    <div style="background:#8a2f1c;color:#fff;padding:14px 16px;border-radius:4px;margin:0 0 20px">
      <div style="font-size:13px;font-weight:700;letter-spacing:.04em">${esc(SIM_MARK)}</div>
      <div style="font-size:13px;margin-top:5px;line-height:1.5">This is a test run of Num's booking flow.
      No ticket exists, no money has moved, and this reference will not be recognised by any airline.</div>
    </div>` : '';

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fbfaf7;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#16181c">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2dfd6;border-radius:6px;padding:28px">
    ${banner}
    <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#1b5e5a;font-weight:700">Num</div>
    <h1 style="font-size:22px;margin:8px 0 4px;font-weight:600;letter-spacing:-.01em">
      ${it.simulated ? 'What a real confirmation would say' : 'Your flight is booked'}</h1>
    <div style="font-size:13px;color:#6b6e76;margin-bottom:20px">
      ${esc(it.originName)} to ${esc(it.destName)}</div>

    <div style="background:#f3f1ea;border-radius:4px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b6e76">Booking reference</div>
      <div style="font-size:28px;font-weight:700;letter-spacing:.06em;font-family:ui-monospace,Menlo,monospace">${esc(it.reference)}</div>
      <div style="font-size:12px;color:#6b6e76;margin-top:4px">Airline reference ${esc(it.airlineRef)}</div>
    </div>

    ${leg('Outbound', it.departDate, `${it.carrier} ${it.flightNo}`, it.origin, it.dest,
    `Depart ${it.departTime}`, `Arrive ${it.arriveTime}`)}
    ${it.returnDate ? leg('Return', it.returnDate, `${it.carrier} ${it.returnFlightNo}`, it.dest, it.origin,
    `Depart ${it.returnDepartTime}`, `Arrive ${it.returnArriveTime}`) : ''}

    <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b6e76;margin:22px 0 8px">Passengers</div>
    <table style="width:100%;border-collapse:collapse">
      ${it.passengers.map((p) => `<tr>
        <td style="padding:6px 0;font-size:14px;font-weight:600;border-bottom:1px solid #f0ede5">${esc(p.name)}</td>
        <td style="padding:6px 0;font-size:12px;color:#6b6e76;text-align:right;border-bottom:1px solid #f0ede5;
          font-family:ui-monospace,Menlo,monospace">${esc(p.ticket ?? '')}</td></tr>`).join('')}
    </table>

    <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b6e76;margin:22px 0 8px">What you paid</div>
    <table style="width:100%;border-collapse:collapse">
      ${row('Fare', money(it.fareCs, it.currency))}
      ${row('Taxes', money(it.taxCs, it.currency))}
      ${it.feeCs ? row('Num booking fee', money(it.feeCs, it.currency)) : ''}
      <tr><td style="padding:8px 16px 0 0;font-size:14px;font-weight:700;border-top:1px solid #e2dfd6">Total</td>
      <td style="padding:8px 0 0;font-size:14px;font-weight:700;border-top:1px solid #e2dfd6">${esc(money(it.totalCs, it.currency))}</td></tr>
    </table>

    <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b6e76;margin:22px 0 8px">Before you fly</div>
    <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:#3c4048">
      <li>Check in from 48 hours before departure.</li>
      <li>Be at the airport 3 hours before an international departure.</li>
      <li>Your passport must match the name on this booking exactly.</li>
    </ul>

    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2dfd6;font-size:12px;color:#6b6e76;line-height:1.6">
      ${it.simulated ? 'Nothing here is real.' : 'Reply to this email and a person at Num will read it.'}
      <br>Num · 5arz Inc.
    </div>
  </div></body></html>`;
}

/* ── SMS ─────────────────────────────────────────────────────────────────
   One segment where possible. GSM-7 gives 160 characters, and a two-segment
   confirmation costs double and arrives split on some handsets. The
   reference and the flight go first so the message is useful even in the
   notification preview, which is where it is actually read. */
export const SMS_SEGMENT = 160;

export function smsConfirm(it) {
  const body = it.simulated
    ? `NUM TEST — not a real booking. ${it.reference} ${it.origin}-${it.dest} `
      + `${it.departDate} ${it.departTime}. No ticket issued.`
    : `Num: booked. ${it.reference} · ${it.carrier}${it.flightNo} ${it.origin}-${it.dest} `
      + `${it.departDate} dep ${it.departTime}. Email sent to ${it.email}. Reply here if anything is wrong.`;
  return { body, segments: Math.ceil(body.length / SMS_SEGMENT), length: body.length };
}

/**
 * The message sent the day before. Separate because it has a different job:
 * the confirmation proves the booking exists, this one gets somebody out of
 * the door on time.
 */
export function smsReminder(it) {
  const body = `Num: ${it.carrier}${it.flightNo} ${it.origin}-${it.dest} tomorrow, dep ${it.departTime}. `
    + `Check in now if you have not. Ref ${it.reference}.`;
  return { body, segments: Math.ceil(body.length / SMS_SEGMENT), length: body.length };
}

/** Everything to send, built once so nothing can disagree with anything else. */
export function confirmations(booking, issued) {
  const it = itinerary(booking, issued);
  return {
    itinerary: it,
    email: { to: it.email, subject: subject(it), text: textEmail(it), html: htmlEmail(it) },
    sms: { to: it.phone, ...smsConfirm(it) },
    reminder: { to: it.phone, ...smsReminder(it) },
  };
}

/* ── ACTUALLY SENDING THEM ───────────────────────────────────────────────
   `confirmations()` above builds the messages. For most of this file's life
   nothing dispatched them, which is the same class of bug as the invite cron
   that ran for five days into a dead credential: the work was done and the
   result went nowhere.

   The mailer owns transports and fallback; this owns only what a flight
   confirmation is. `deliver` never throws — a booking that succeeded must not
   be reported as failed because an email bounced, and the traveller has the
   reference on screen either way. */

/**
 * @returns {Promise<{email:object, sms:object|null, itinerary:object}>}
 * Each channel reports its own outcome. A confirmation that reached the inbox
 * but not the phone is a different situation from one that reached neither,
 * and collapsing them into a single boolean loses the difference.
 */
export async function deliver(env, booking, issued, { sendSms = null } = {}) {
  const { send, recordSend } = await import('./mailer.mjs');
  const out = confirmations(booking, issued);

  const email = out.email.to
    ? await send(env, {
      to: out.email.to,
      from: env?.MAIL_FROM || 'Num <info@itsnum.com>',
      replyTo: 'info@itsnum.com',
      subject: out.email.subject,
      text: out.email.text,
      html: out.email.html,
    })
    : { ok: false, error: 'no email address on the booking' };
  await recordSend(env, 'flight-confirmation', email);

  // SMS is injected rather than imported: this module has no business
  // knowing about Twilio, and the A2P campaign is still unapproved, so on
  // most deployments there is nothing to call.
  let sms = null;
  if (sendSms && out.sms.to) {
    try {
      sms = await sendSms(env, out.sms.to, out.sms.body);
    } catch (e) {
      sms = { ok: false, error: String(e?.message ?? e) };
    }
  }

  if (!email.ok) {
    // Loud, because the traveller has paid and is now waiting for a document
    // that is not coming. This is a human's problem within the hour.
    console.error(`[flightconfirm] CONFIRMATION NOT SENT for ${out.itinerary.reference} — ${email.error}`);
  }
  return { email, sms, itinerary: out.itinerary };
}
