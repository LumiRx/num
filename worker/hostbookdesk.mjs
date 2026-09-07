/**
 * A HOST'S RESERVATION GOES THROUGH NUM'S BOOKING DESK.
 *
 * Before 4 Sep 2026 a host arranging dinner for a client did it the way they
 * did before NUM existed: by phone. Their request was free text with no place
 * behind it, and the desk that texts 2.6 million venues a one-tap confirm link
 * never heard about it.
 *
 * Now: the host names the venue from the directory (place_id), NUM texts the
 * venue exactly as it does for an app member, the venue taps CONFIRM or
 * DECLINE, and the answer lands back on the host's request as a note for the
 * host to act on. Two rules from the 3 Sep host model, kept absolutely:
 *
 *   - NUM NEVER CONFIRMS ON THE HOST'S BEHALF. A venue saying yes moves the
 *     request to `awaiting_host`, not `confirmed`. The host confirms with
 *     their client, in their own name, through their console — which is also
 *     the moment the £5 booking fee lands (growth/worker.js hostRequests).
 *   - NUM NEVER CONTACTS THE HOST'S CLIENT. The desk row is keyed on the
 *     host, so the desk's "guest told" push goes nowhere, on purpose.
 */
import { venueE164, signBookingAnswer, __testables } from './bookdesk.mjs';
import { hostByKey } from './hostmoney.mjs';
import { record } from './failures.mjs';

const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// The link between a host request and the desk row it spawned, plus the
// receipt that the venue's answer has been written back. Added lazily.
const ALTERS = [
  'ALTER TABLE num_host_requests ADD COLUMN booking_ref TEXT',
  'ALTER TABLE num_host_requests ADD COLUMN venue_answer_at TEXT',
];
const ready = new WeakSet();
export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  let absent = false;
  for (const sql of ALTERS) {
    try { await env.DB.prepare(sql).run(); }
    catch (e) { const m = String(e?.message ?? e); if (/no such table/i.test(m)) absent = true; else if (!/duplicate column/i.test(m)) console.warn('[hostbookdesk] ensure', m); }
  }
  if (!absent) ready.add(env.DB);
}

/** 'YYYY-MM-DD HH:MM' / ISO → {on_date, at_time} or null. */
export function splitWhen(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})/.exec(String(s ?? '').trim());
  return m ? { on_date: m[1], at_time: m[2].padStart(5, '0') } : null;
}

/**
 * POST /api/host/book?k= {request_id, place_id}
 * Sends the venue the same one-tap request an app member's table gets.
 */
export async function bookForHost(env, { host, requestId, placeId, origin = 'https://app.itsnum.com', smsImpl } = {}) {
  if (!env?.DB || !host?.id) return { ok: false, status: 401, error: 'unauthorised' };
  await ensure(env);
  requestId = clip(requestId, 40); placeId = clip(placeId, 120);
  if (!requestId || !placeId) return { ok: false, status: 400, error: 'request_id and place_id required' };

  const r = await env.DB.prepare(
    `SELECT r.id, r.service_key, r.title, r.detail, r.starts_at, r.party_size, r.status, r.booking_ref, c.name AS client_name
       FROM num_host_requests r LEFT JOIN num_host_clients c ON c.id = r.client_id
      WHERE r.id = ?1 AND r.host_id = ?2`,
  ).bind(requestId, host.id).first();
  if (!r) return { ok: false, status: 404, error: 'not your request' };
  if (r.service_key !== 'reservation') return { ok: false, status: 400, error: 'only a reservation goes through the desk' };
  if (r.booking_ref) return { ok: true, status: 200, already: true, booking: r.booking_ref };
  if (['confirmed', 'done', 'declined', 'cancelled'].includes(r.status)) return { ok: false, status: 409, error: `this request is already ${r.status}` };
  const when = splitWhen(r.starts_at);
  if (!when) return { ok: false, status: 400, error: 'set a date and time on the request first — the venue needs both' };
  const party = Math.min(Math.max(Number(r.party_size) || 0, 1), 40);
  if (!r.party_size) return { ok: false, status: 400, error: 'how many people? — the venue needs a party size' };

  const place = await env.DB.prepare('SELECT id, name, phone, business_id FROM places WHERE id = ?1').bind(placeId).first().catch(() => null);
  if (!place) return { ok: false, status: 404, error: 'that place is not in the directory' };
  const venuePhone = venueE164(place.phone);

  const id = `bk_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
  await env.DB.prepare(
    `INSERT INTO num_booking_requests (id, member_id, venue_name, venue_phone, party_size, on_date, at_time, note, plan_id, place_id)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9)`,
  ).bind(id, `host:${host.id}`, clip(place.name, 120), venuePhone, party, when.on_date, when.at_time,
    clip(`Via VIP host ${host.name}${r.client_name ? ` for ${r.client_name}` : ''}`, 200), String(place.id)).run();

  let texted = false;
  if (venuePhone) {
    const yes = await signBookingAnswer(env, id, 'confirmed');
    const no = await signBookingAnswer(env, id, 'declined');
    const send = smsImpl ?? __testables.smsPartner;
    texted = await send(env, venuePhone,
      `Num booking request: table for ${party}, ${when.on_date} ${when.at_time}, for a guest of ${host.name}.\n` +
      `CONFIRM: ${origin}/api/book/answer?id=${id}&v=confirmed&t=${yes}\n` +
      `DECLINE: ${origin}/api/book/answer?id=${id}&v=declined&t=${no}`);
  }
  await env.DB.prepare(
    `UPDATE num_host_requests SET booking_ref = ?2, status = CASE WHEN status IN ('new','drafted') THEN 'awaiting_host' ELSE status END,
            updated_at = ?3 WHERE id = ?1`,
  ).bind(requestId, id, now()).run();
  return {
    ok: true, status: 200, booking: id, texted, venue: place.name,
    note: texted ? `${place.name} has the request — you'll see their answer here.` : `Logged for ${place.name}; NUM's desk works the phone and the answer lands here.`,
  };
}

/**
 * Cron: write each venue's answer back onto the host's request, once.
 * Never sets `confirmed` — that word is the host's.
 */
export async function venueAnswerSweep(env, { limit = 50 } = {}) {
  if (!env?.DB) return { written: 0 };
  await ensure(env);
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT r.id, r.booking_ref, b.state, b.venue_name, b.answered_at, h.name AS host_name, h.email AS host_email
         FROM num_host_requests r JOIN num_booking_requests b ON b.id = r.booking_ref
         JOIN num_hosts h ON h.id = r.host_id
        WHERE r.booking_ref IS NOT NULL AND r.venue_answer_at IS NULL AND b.state IN ('confirmed','declined')
        LIMIT ?1`,
    ).bind(limit).all());
  } catch (e) {
    if (!/no such (table|column)/i.test(String(e?.message ?? e))) console.warn('[hostbookdesk] sweep', e?.message ?? e);
    return { written: 0 };
  }
  let written = 0;
  for (const r of rows ?? []) {
    const line = r.state === 'confirmed'
      ? `✔ ${r.venue_name} confirmed the table through NUM (${r.booking_ref}). Confirm here to tell your client.`
      : `✖ ${r.venue_name} declined through NUM (${r.booking_ref}). Try another venue or tell your client.`;
    try {
      await env.DB.prepare(
        `UPDATE num_host_requests SET detail = CASE WHEN detail IS NULL OR detail = '' THEN ?2 ELSE detail || char(10) || ?2 END,
                venue_answer_at = ?3, updated_at = ?3 WHERE id = ?1`,
      ).bind(r.id, line, now()).run();
      written++;
      // Tell the host by email, once; the receipt above is the guard.
      const { send, AUDIENCE } = await import('./mailer.mjs');
      const out = await send(env, {
        to: r.host_email, subject: `${r.venue_name} ${r.state === 'confirmed' ? 'confirmed' : 'declined'} your request`,
        text: `${r.host_name},\n\n${line}\n\nNUM has not told your client anything — that is yours to do.`,
        tag: 'host_venue_answer',
      }, { audience: AUDIENCE.EXTERNAL }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (!out?.ok) await record(env, { kind: 'host_venue_answer_unsent', subject: `${r.host_name} <${r.host_email}>`, detail: out?.error ?? 'send failed', severity: 'low' }).catch(() => {});
    } catch (e) { console.warn('[hostbookdesk] write-back', e?.message ?? e); }
  }
  return { written };
}

/** HTTP glue for handleHost. */
export async function handleHostBook(request, env, url) {
  const host = await hostByKey(env, url.searchParams.get('k'));
  if (!host) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  const b = await request.json().catch(() => ({}));
  const out = await bookForHost(env, { host, requestId: b.request_id, placeId: b.place_id, origin: env.NUM_APP_ORIGIN || url.origin });
  const { status, ...rest } = out;
  return new Response(JSON.stringify(rest), { status: status ?? 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
