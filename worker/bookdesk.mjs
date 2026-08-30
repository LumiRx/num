// Closed-loop bookings: the table is confirmed THROUGH Num, not hoped for.
//
// Until now Num recommended and a human still had to call. This closes the
// loop: the request goes to the venue by SMS, the venue answers by tapping a
// link, and the guest's phone buzzes with the answer. Num stops being advice
// and starts being infrastructure.
//
// ── Why the partner side is a LINK and not an account ────────────────────
//
// A Phuket restaurant will not download an app, remember a password, or
// attend an onboarding call to accept one table. The bar for a partner's
// first confirmed booking has to be: read a text, tap once. The signed link
// IS the auth — it proves the tap came from the phone we texted, which is
// exactly as much identity as the fax machine it replaces ever had.
//
// The token is HMAC-signed over (request id, verdict), so a partner can
// confirm or decline only the one booking we asked them about, and a guest
// who inspects their own URL can't forge a confirmation. Ten-minute-old
// links still work — restaurants answer when service quiets down.
//
// ── States ───────────────────────────────────────────────────────────────
//
//   requested → confirmed | declined | expired
//
// One transition, one direction. Only 'requested' can move: a second tap on
// yesterday's link cannot un-confirm a table, because Stripe taught us that
// at-least-once delivery is a property of the universe, not of Stripe.

// The venue's number is the whole mechanism — an unreachable number turns a
// closed loop back into advice. normalisePhone is the one the rest of the
// Worker already uses (social.mjs, events.mjs, claim.mjs) and it is
// deliberately reused rather than re-implemented here: a second phone parser
// is a second set of rules about what "+66 81" means, and the two drift.
import { senderParams } from './twiliosender.mjs';

import { normalisePhone } from '../claim/verify.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * The venue number, in the only form Twilio will dial: E.164, leading `+`.
 *
 * normalisePhone keeps the digits of a bare national number ("2125551234")
 * without inventing a country code, so this insists on the `+` on top of it —
 * the same two-step social.mjs does at signup, and for the same reason. A bare
 * ten-digit US number and a bare nine-digit Thai number are indistinguishable
 * to a parser and are two different restaurants on two different continents.
 * Guessing +1 because most of the directory is American would text a stranger
 * in Ohio about a table in Phuket, so a number without a country code is
 * REFUSED, loudly, at the moment it is typed — not silently saved and then
 * discovered to be undialable at the one moment it mattered.
 *
 *   "+66 81 234 5678" → "+66812345678"   (Thai, already international)
 *   "+1 (212) 555-1234" → "+12125551234"
 *   "0066812345678"   → "+66812345678"   (00 is the other international prefix)
 *   "212-555-1234"    → null             (which country?)
 *   "call the front desk" → null
 */
export function venueE164(raw) {
  if (!raw) return null;
  // 00 is how most of the world writes the international prefix on a business
  // card. normalisePhone strips punctuation and keeps a leading '+' but knows
  // nothing about 00, so it is translated before it gets there.
  const s = String(raw).trim().replace(/[^\d+]/g, '');
  const p = normalisePhone(/^00\d/.test(s) ? `+${s.slice(2)}` : s);
  return p && p.startsWith('+') ? p : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_booking_requests (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  venue_phone TEXT,
  party_size INTEGER,
  on_date TEXT,
  at_time TEXT,
  note TEXT,
  state TEXT NOT NULL DEFAULT 'requested',
  plan_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookreq_member ON num_booking_requests(member_id, created_at);
`;
// Added 15 Aug with commission capture. The table only ever held a venue NAME,
// which is enough to text somebody and not nearly enough to bill them: the
// category sets the rate, and business_id says whose invoice it lands on.
// Separate from SCHEMA because CREATE TABLE IF NOT EXISTS will not add a
// column to a table that already exists — the reason a migration that looks
// applied can silently do nothing.
const MIGRATIONS = ['ALTER TABLE num_booking_requests ADD COLUMN place_id TEXT'];
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  // One at a time, each failure swallowed: "duplicate column name" is the
  // expected result on every run after the first, and batching would let that
  // expected error roll back the statements around it.
  for (const m of MIGRATIONS) await env.DB.prepare(m).run().catch(() => {});
  ready = true;
}

/** HMAC over exactly (id, verdict) — a confirm token cannot decline. */
async function sign(env, id, verdict) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.ADMIN_KEY ?? 'dev'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`book:${id}:${verdict}`));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * WHO WE ARE ALLOWED TO TEXT, AND WHY THIS IS NOT OPTIONAL.
 *
 * `venue_phone` arrives in the REQUEST BODY. Any caller could post any number
 * and this worker would text it — an open SMS relay wearing a booking desk as
 * a hat. Even used exactly as intended it is no better: the numbers come from
 * OpenStreetMap and Google Places, which is to say from a map, which is to say
 * from nobody who ever agreed to hear from us.
 *
 * That matters in three separate directions and only one of them is legal:
 *
 *  1. THE A2P REGISTRATION. The campaign we are about to file tells a carrier
 *     that recipients are venues who have a relationship with NUM and gave us
 *     their number. Filing that while this code texts numbers scraped off a
 *     map is a false statement to a carrier — the kind that gets a brand
 *     struck rather than a campaign rejected, and it would be found by the
 *     first audit that pulls a sample and asks where the number came from.
 *  2. TCPA. The day one of those "venue" numbers turns out to be a US mobile,
 *     an unconsented automated text is $500–$1,500 of statutory damages, per
 *     message, and no amount of good intent is a defence.
 *  3. THE GUEST. A text that a carrier filters still returns 201 from Twilio,
 *     so the guest is told "the venue has it" when nobody has it.
 *
 * So the register is the gate: a row in `num_sms_consent` for this exact E.164
 * number, not revoked. That table is written by the /sms opt-in page, which
 * stores the verbatim consent wording, its version, the IP and the timestamp —
 * the evidence an audit actually asks for.
 *
 * TODAY THAT MEANS ZERO PARTNER TEXTS, because no venue has opted in yet. That
 * is the honest state of the world and it is strictly better than the
 * alternative: `/request` still records the booking and the desk still works it
 * by hand, which is what was really happening anyway. What changes is that we
 * stop claiming a text went out, and stop sending one we cannot defend.
 *
 * The unlock is a venue opt-in path, not a loosening of this check.
 */
async function partnerMayBeTexted(env, to) {
  if (!to) return { ok: false, reason: 'no_number' };
  try {
    const row = await env.DB.prepare(
      'SELECT revoked_at FROM num_sms_consent WHERE phone = ?1',
    ).bind(to).first();
    if (!row) return { ok: false, reason: 'no_consent_on_file' };
    if (row.revoked_at) return { ok: false, reason: 'consent_revoked' };
    return { ok: true, reason: 'consented' };
  } catch (e) {
    // The consent register lives with the opt-in page and may not exist in a
    // fresh environment. FAIL CLOSED. An unreadable register is not permission;
    // the failure mode of guessing "yes" here is the one this whole function
    // exists to prevent.
    console.warn('[bookdesk] consent lookup failed, refusing to text', e?.message ?? e);
    return { ok: false, reason: 'consent_register_unavailable' };
  }
}

/**
 * Every partner message carries the brand and the way out. Both are carrier
 * requirements for a registered campaign, and both are things a person who did
 * not expect this text needs in the message itself rather than on a website
 * they would have to go and find.
 */
const PARTNER_SMS_FOOTER = '\n\nNUM booking desk. Reply STOP to opt out, HELP for help.';

async function smsPartner(env, to, text) {
  // See twiliosender.mjs: a US long code inherits A2P campaign approval
  // through its Messaging Service, never on its own. `From: <number>` is what
  // earned 30034 on every real send between 5 and 21 Aug 2026.
  const sender = senderParams(env);
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !sender || !to) return false;

  // The gate, before the credentials are ever spent.
  const consent = await partnerMayBeTexted(env, to);
  if (!consent.ok) {
    console.warn(`[bookdesk] not texting ${to}: ${consent.reason}`);
    return false;
  }

  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: to,
      ...sender,
      Body: text + PARTNER_SMS_FOOTER,
      // Same reasoning as claim/verify.mjs:189. Twilio answers 201 the instant
      // it queues a message; only the receipt says whether a carrier took it.
      // Without this, `texted: true` below means "we asked", and the guest is
      // told the venue has their table on the strength of it.
      StatusCallback: 'https://app.itsnum.com/api/sms/status',
    }),
  }).catch(() => null);
  return !!r?.ok;
}

/**
 * The kill switch, in the same shape as SABRE_BOOKING_ENABLED
 * (sabre-booking.mjs:135): an explicit string, default OFF.
 *
 * It gates the ASK and nothing else. `/answer` and `/mine` stay open however
 * this is set, deliberately: the confirm links already live in text messages
 * on phones we do not control, and a venue that taps CONFIRM after someone
 * pulled the switch must still be able to answer — otherwise a guest is left
 * waiting on a table that a restaurant believes it has given them. Turning
 * bookdesk off means "stop asking", never "stop listening".
 *
 * `wrangler secret put BOOKDESK_ENABLED` takes effect without a deploy, which
 * is what makes this a kill switch rather than a release note.
 */
export const bookdeskEnabled = (env) => env?.BOOKDESK_ENABLED === 'true';

/**
 * The SMS gate, reachable from a test.
 *
 * Exported deliberately and narrowly. `smsPartner` is the one function in this
 * file where being wrong is a false statement to a carrier and a TCPA exposure
 * rather than a bug, so "who will this text, and what does it put in the body"
 * has to be assertable by running it — not by reading it and hoping. Nothing
 * in the request path imports this; see worker/bookdesk.consent.test.mjs.
 */
export const __testables = { smsPartner, partnerMayBeTexted, PARTNER_SMS_FOOTER };

export async function handleBooking(request, env, path) {
  await ensure(env);
  const url = new URL(request.url);
  const origin = env.NUM_APP_ORIGIN || 'https://app.itsnum.com';

  // ── Guest asks for a table ───────────────────────────────────────────
  if (path === '/request' && request.method === 'POST') {
    // 503, not 404: the endpoint exists and is switched off, and the app shows
    // the guest a sentence rather than a broken button.
    if (!bookdeskEnabled(env)) {
      return json({
        error: 'The booking desk is closed right now — I’ll give you the number and the link instead.',
        disabled: true,
      }, 503);
    }
    const b = await request.json().catch(() => ({}));
    const me = clip(b.me, 40);
    const venue = clip(b.venue_name, 120);
    if (!me || !venue) return json({ error: 'Who, and where?' }, 400);
    const member = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(me).first();
    if (!member) return json({ error: 'sign up first' }, 404);

    // A number we cannot dial is refused here rather than stored. Without a
    // country code we would either not text at all (and the guest would be
    // told "the venue has it" when nobody has it) or text the wrong country.
    // No number at all is a legitimate, honest state — the desk works it by
    // hand — so only a number that was SUPPLIED and is unusable is an error.
    const venuePhone = venueE164(b.venue_phone);
    if (b.venue_phone && !venuePhone) {
      return json({
        error: 'That venue number needs its country code — start it with + (like +66, +1 or +44).',
        bad_phone: true,
      }, 400);
    }

    const id = `bk_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
    const partySize = Math.min(Math.max(Number(b.party_size) || 2, 1), 40);
    await env.DB.prepare(
      `INSERT INTO num_booking_requests (id, member_id, venue_name, venue_phone, party_size, on_date, at_time, note, plan_id, place_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    ).bind(
      // The E.164 form is what is STORED, so a retry from the desk months
      // later dials the same number the first text went to.
      id, me, venue, venuePhone, partySize,
      clip(b.on_date, 20), clip(b.at_time, 8), clip(b.note, 200), clip(b.plan_id, 40),
      // Optional and best-effort. Without it the booking still works and
      // simply bills at the cheapest flat rate — an unidentified venue must
      // under-bill, never guess a percentage.
      clip(b.place_id, 120),
    ).run();

    // Text the venue, if we have a number for it. If we don't, the request
    // still exists — the concierge (or Dre, in the pilot) works the phone and
    // answers through the same link a partner would have tapped.
    let texted = false;
    if (venuePhone) {
      const yes = await sign(env, id, 'confirmed');
      const no = await sign(env, id, 'declined');
      texted = await smsPartner(
        env,
        venuePhone,
        `Num booking request: table for ${partySize}, ${b.on_date ?? 'tonight'}${b.at_time ? ` ${b.at_time}` : ''}, ` +
        `for ${member.name ?? 'a guest'}.${b.note ? ` (${clip(b.note, 80)})` : ''}\n` +
        `CONFIRM: ${origin}/api/book/answer?id=${id}&v=confirmed&t=${yes}\n` +
        `DECLINE: ${origin}/api/book/answer?id=${id}&v=declined&t=${no}`,
      );
    }
    return json({
      ok: true, id, state: 'requested', texted,
      note: texted
        ? 'The venue has it — you’ll hear the moment they answer.'
        : 'Request logged — our desk is on it, you’ll hear as soon as it’s confirmed.',
    });
  }

  // ── Venue answers (the tapped link) ──────────────────────────────────
  if (path === '/answer') {
    const id = clip(url.searchParams.get('id'), 40);
    const verdict = url.searchParams.get('v');
    const token = clip(url.searchParams.get('t'), 40);
    if (!id || !['confirmed', 'declined'].includes(verdict) || !token) return json({ error: 'bad link' }, 400);
    if (token !== (await sign(env, id, verdict))) return json({ error: 'bad link' }, 403);

    // Only 'requested' moves. Yesterday's link, tapped again, changes nothing.
    const flip = await env.DB.prepare(
      "UPDATE num_booking_requests SET state=?2, answered_at=datetime('now') WHERE id=?1 AND state='requested'",
    ).bind(id, verdict).run();
    const row = await env.DB.prepare('SELECT * FROM num_booking_requests WHERE id=?1').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);

    // MONEY, exactly once, and only on a confirmation that actually flipped.
    //
    // `flip.meta.changes > 0` is the idempotency guard and it is the whole
    // safety property here: this URL lives in an SMS on a stranger's phone. It
    // gets tapped twice, forwarded to a colleague, and prefetched by link
    // previewers. Accruing outside this branch would bill a merchant three
    // times for one table, and they would find out before we did.
    //
    // Awaited, not deferred: this route returns an HTML page rather than
    // finishing a guest's request, so there is no latency to protect, and a
    // ledger write that races the response is a ledger write that sometimes
    // does not happen. `accrue` never throws — a booking must complete even
    // if the money line fails.
    if (flip.meta.changes > 0 && verdict === 'confirmed') {
      const { accrue } = await import('./commission.mjs');
      const place = row.place_id
        // `country` is load-bearing: commission.mjs applies per-country rates
        // off it (Thailand bills 10% of the bill rather than a flat fee), and
        // a missing country silently falls back to the default line.
        ? await env.DB.prepare('SELECT id, name, category, business_id, dest, country FROM places WHERE id=?1')
            .bind(row.place_id).first().catch(() => null)
        : null;
      await accrue(env, {
        bookingId: id,
        place: place ?? { name: row.venue_name },
        venueName: row.venue_name,
        memberId: row.member_id,
        dest: place?.dest ?? null,
      });
    }

    if (flip.meta.changes > 0) {
      const { notify } = await import('./push.mjs');
      await notify(env, {
        memberId: row.member_id,
        kind: 'plan',
        title: verdict === 'confirmed'
          ? `${row.venue_name} — confirmed ✓`
          : `${row.venue_name} couldn’t take it`,
        body: verdict === 'confirmed'
          ? `Table for ${row.party_size}${row.on_date ? `, ${row.on_date}` : ''}${row.at_time ? ` at ${row.at_time}` : ''}. It’s in your plan.`
          : 'Want me to find you somewhere just as good?',
        url: '/?go=plan',
        tag: `book:${id}`,
      }).catch(() => {});
    }

    // The partner sees a page, not JSON — they tapped this on a phone.
    return new Response(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#faf7f5">` +
      `<div style="text-align:center;padding:24px"><div style="font-size:40px">${verdict === 'confirmed' ? '✓' : '—'}</div>` +
      `<h2 style="margin:8px 0 4px">${verdict === 'confirmed' ? 'Confirmed' : 'Declined'}</h2>` +
      `<p style="color:#777">${row.venue_name} · party of ${row.party_size}${row.on_date ? ` · ${row.on_date}` : ''}` +
      `${flip.meta.changes === 0 ? '<br>(already answered)' : '<br>The guest has been told.'}</p></div>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  // ── Guest checks their requests ──────────────────────────────────────
  if (path === '/mine') {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ requests: [] });
    const { results } = await env.DB.prepare(
      'SELECT id, venue_name, party_size, on_date, at_time, state, created_at, answered_at FROM num_booking_requests WHERE member_id=?1 ORDER BY created_at DESC LIMIT 20',
    ).bind(me).all();
    return json({ requests: results ?? [] });
  }

  return json({ error: 'not found' }, 404);
}
