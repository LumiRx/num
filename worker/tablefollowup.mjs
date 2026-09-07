/**
 * BEFORE AND AFTER THE TABLE.
 *
 * A confirmed table used to end at "confirmed ✓". Two moments were missing,
 * and they are the two a good concierge is remembered for:
 *
 *   BEFORE — about three hours out: "Blue Elephant at 19:30 tonight, table
 *            for four. Want me to sort a car?"
 *   AFTER  — the next morning: "How was Blue Elephant? Two taps and every
 *            rating changes what the next guest is shown."
 *
 * Both were impossible for app bookings before 4 Sep 2026: the reminder sweep
 * only knew about plans, and the after-visit token was minted only when a
 * table QR was scanned. num_booking_requests already carries the member and
 * the time; this reads it.
 *
 * The discipline is nudge.mjs's, unchanged: never twice for the same moment
 * (num_nudges is the gate, claimed BEFORE sending), only about something the
 * person actually has, and a time NUM cannot place in a timezone is skipped,
 * not guessed — a reminder at 03:00 is worse than none.
 *
 * Reach: the in-app queue always; push where a subscription exists; a text
 * only where the member has consented and not opted out (worker/optout.mjs).
 */
import { notify } from './push.mjs';
import { sendText } from './friendtext.mjs';
import { optedOut } from './optout.mjs';
import { tzFor } from './broadcast.mjs';

const BEFORE_MIN = { from: 150, to: 210 };   // 2½–3½ hours ahead: one hourly tick lands in it
const AFTER_MIN = { from: 12 * 60, to: 36 * 60 }; // the next morning, roughly

/** The timezone a booking's clock reads in, or null. */
export async function bookingTz(env, row) {
  if (row.place_id) {
    const r = await env.DB.prepare(
      'SELECT d.tz AS tz FROM places p LEFT JOIN destinations d ON d.slug = p.dest WHERE p.id = ?1',
    ).bind(row.place_id).first().catch(() => null);
    if (r?.tz) return r.tz;
  }
  return tzFor(row.venue_phone) ?? null;
}

/** Minutes from `now` until the booking's local wall-clock time. null = cannot place it. */
export function minutesUntil(row, tz, now = new Date()) {
  if (!tz || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.on_date ?? '')) || !/^\d{1,2}:\d{2}/.test(String(row.at_time ?? ''))) return null;
  // Wall clock "now" in that zone, as a naive timestamp, so the subtraction
  // is naive minus naive and DST never enters into it.
  let local;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
    local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  } catch { return null; }
  const [hh, mm] = String(row.at_time).split(':').map(Number);
  const [y, m, d] = String(row.on_date).split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  return Math.round((target - local) / 60000);
}

const NUDGES = [
  `CREATE TABLE IF NOT EXISTS num_nudges (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, plan_id TEXT, moment TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_nudge_once ON num_nudges(member_id, plan_id, moment)',
];
const ready = new WeakSet();
async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  for (const sql of NUDGES) await env.DB.prepare(sql).run().catch(() => {});
  ready.add(env.DB);
}

async function claim(env, memberId, id, moment) {
  await ensure(env);
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO num_nudges (id, member_id, plan_id, moment) VALUES (?1, ?2, ?3, ?4)',
  ).bind(crypto.randomUUID(), memberId, `table:${id}`, moment).run().catch(() => null);
  return (r?.meta?.changes ?? 0) > 0;
}

/** A text to a member — only with consent on file and no STOP. */
export async function textMember(env, memberId, body, { fetchImpl } = {}) {
  const m = await env.DB.prepare('SELECT phone, phone_verified FROM num_members WHERE id = ?1').bind(memberId).first().catch(() => null);
  if (!m?.phone || !m.phone_verified) return { sent: false, why: 'no verified phone' };
  if (await optedOut(env, m.phone)) return { sent: false, why: 'opted out' };
  const { reachable } = await import('./smsconsent.mjs');
  const ok = await reachable(env, m.phone);
  if (!ok.ok) return { sent: false, why: ok.why };
  const out = await sendText(env, { to: m.phone, body: body + '\n\nReply STOP to opt out.', fetchImpl });
  return out.ok ? { sent: true, sid: out.sid } : { sent: false, why: out.error };
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
async function confirmed(env, now = new Date()) {
  // The window is computed from the sweep's own clock (injectable in tests),
  // wide enough that any timezone on earth is inside it.
  const { results } = await env.DB.prepare(
    `SELECT id, member_id, venue_name, venue_phone, party_size, on_date, at_time, place_id, answered_at
       FROM num_booking_requests
      WHERE state = 'confirmed' AND on_date IS NOT NULL AND at_time IS NOT NULL
        AND on_date >= ?1 AND on_date <= ?2
      ORDER BY on_date, at_time LIMIT 200`,
  ).bind(dayOf(now.getTime() - 2 * 86400_000), dayOf(now.getTime() + 2 * 86400_000)).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/** BEFORE: about three hours out. */
export async function reminderSweep(env, { now = new Date(), fetchImpl } = {}) {
  if (!env?.DB) return { sent: 0, texted: 0, skipped: 0 };
  let sent = 0, texted = 0, skipped = 0;
  for (const row of await confirmed(env, now)) {
    const tz = await bookingTz(env, row);
    const mins = minutesUntil(row, tz, now);
    if (mins == null || mins < BEFORE_MIN.from || mins > BEFORE_MIN.to) { skipped++; continue; }
    if (!(await claim(env, row.member_id, row.id, 'before'))) { skipped++; continue; }
    const party = row.party_size ? ` — table for ${row.party_size}` : '';
    const title = `${row.venue_name} at ${row.at_time}${party}`;
    const body = 'In about three hours. Want me to sort a car, or add it to your calendar?';
    await notify(env, { memberId: row.member_id, kind: 'plan', title, body, url: '/?go=plan', tag: `table:${row.id}:before` }).catch(() => {});
    sent++;
    const t = await textMember(env, row.member_id, `${title}. ${body} Reply here and Num will sort it.`, { fetchImpl });
    if (t.sent) texted++;
  }
  return { sent, texted, skipped };
}

/** AFTER: the next morning — the after-visit link, same as a QR visit gets. */
export async function afterVisitSweep(env, { now = new Date(), fetchImpl, site = 'https://itsnum.com' } = {}) {
  if (!env?.DB) return { sent: 0, texted: 0, skipped: 0 };
  let sent = 0, texted = 0, skipped = 0;
  for (const row of await confirmed(env, now)) {
    const tz = await bookingTz(env, row);
    const mins = minutesUntil(row, tz, now);
    // Passed by 12–36 hours. Unknown timezone: fall back to treating the clock
    // as UTC — an after-visit ask a few hours early or late costs nothing.
    const m = mins ?? minutesUntil(row, 'UTC', now);
    if (m == null || -m < AFTER_MIN.from || -m > AFTER_MIN.to) { skipped++; continue; }
    if (!(await claim(env, row.member_id, row.id, 'after'))) { skipped++; continue; }
    let token = null;
    try {
      const { issueAfter } = await import('../growth/aftervisit.mjs');
      const place = row.place_id
        ? await env.DB.prepare('SELECT business_id FROM places WHERE id = ?1').bind(row.place_id).first().catch(() => null)
        : null;
      token = await issueAfter(env, { bookingId: row.id, businessId: place?.business_id ?? null, placeId: row.place_id, memberRef: row.member_id });
    } catch (e) { console.warn('[tablefollowup] after token', e?.message ?? e); }
    const url = token ? `${site}/a/${token}` : '/?go=plan';
    await notify(env, {
      memberId: row.member_id, kind: 'plan',
      title: `How was ${row.venue_name}?`,
      body: 'Two taps. Every rating changes what the next guest is shown.',
      url, tag: `table:${row.id}:after`,
    }).catch(() => {});
    sent++;
    if (token) {
      const t = await textMember(env, row.member_id, `How was ${row.venue_name} last night? Two taps: ${url}`, { fetchImpl });
      if (t.sent) texted++;
    }
  }
  return { sent, texted, skipped };
}
