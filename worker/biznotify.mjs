/**
 * Telling a business something worth knowing — and nothing else.
 *
 * ── WHAT ALREADY EXISTED, SO THIS DOES NOT DUPLICATE IT ───────────────────
 *
 * `bookdesk.mjs` already texts the venue's PUBLISHED phone number the moment a
 * booking request arrives, with confirm/decline links. That path is the right
 * one for the request itself: it reaches whoever is standing at the pass, and
 * it works whether or not anybody ever claimed the listing.
 *
 * This file is for the CLAIMED owner — the person with a dashboard and an
 * account email, who is usually not the person holding the venue phone at
 * 8pm. It adds a second, quieter channel and a reason to come back.
 *
 * ── THE RULE: NEVER SEND AN EMPTY NOTIFICATION ────────────────────────────
 *
 * A weekly digest that arrives saying "0 impressions, 0 requests, nothing
 * asked" teaches a business to filter us. Every function here returns null
 * when there is nothing to report, and the caller sends nothing. Silence is a
 * feature: it means the next email that does arrive is worth opening.
 *
 * And no notification ever carries a number this codebase has not measured —
 * the same contract as the dashboard (bizdash.mjs). An estimate in an email is
 * a figure a merchant quotes back at you.
 */

/** Preferences. Opt-IN per channel; nothing is on by default. */
async function ensure(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_business_notify (
       business_id TEXT PRIMARY KEY,
       email       TEXT,
       on_booking  INTEGER NOT NULL DEFAULT 1,
       on_weekly   INTEGER NOT NULL DEFAULT 1,
       last_weekly TEXT,
       updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run();
}

export async function prefs(env, businessId) {
  if (!env?.DB || !businessId) return null;
  await ensure(env);
  const row = await env.DB.prepare(
    'SELECT business_id, email, on_booking, on_weekly, last_weekly FROM num_business_notify WHERE business_id = ?1',
  ).bind(String(businessId)).first().catch(() => null);
  if (row) return { ...row, on_booking: !!row.on_booking, on_weekly: !!row.on_weekly };
  // Not configured yet. Fall back to the address the business signed up with,
  // so a booking alert works before anyone visits the settings — but say
  // plainly that it is inherited rather than chosen.
  const user = await env.DB.prepare(
    "SELECT email FROM num_business_users WHERE business_id = ?1 AND status = 'active' ORDER BY created_at ASC LIMIT 1",
  ).bind(String(businessId)).first().catch(() => null);
  return { business_id: String(businessId), email: user?.email ?? null, on_booking: true, on_weekly: true, inherited: true };
}

export async function setPrefs(env, businessId, { email, onBooking, onWeekly }) {
  if (!env?.DB || !businessId) return { ok: false };
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO num_business_notify (business_id, email, on_booking, on_weekly, updated_at)
     VALUES (?1,?2,?3,?4,datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET
       email = excluded.email, on_booking = excluded.on_booking,
       on_weekly = excluded.on_weekly, updated_at = datetime('now')`,
  ).bind(
    String(businessId),
    email ? String(email).slice(0, 200) : null,
    onBooking ? 1 : 0,
    onWeekly ? 1 : 0,
  ).run();
  return { ok: true };
}

/**
 * A booking request, to the owner's inbox.
 *
 * SECOND channel, not a replacement: bookdesk still texts the venue line, and
 * that text is the one that gets a table held. This is so the owner knows it
 * happened even when they were not the one holding the phone.
 */
export function bookingEmail({ business, party, when, note } = {}) {
  const biz = String(business ?? 'your listing').trim();
  return {
    subject: `Booking request — ${biz}`,
    text: [
      `A traveller asked Num for a table at ${biz}.`,
      '',
      `Party: ${party ?? 'not stated'}`,
      `When: ${when ?? 'not stated'}`,
      ...(note ? ['', `They said: ${note}`] : []),
      '',
      'We have texted the number on your listing with confirm and decline links —'
        + ' answering there is what holds the table. This note is so you know it happened.',
      '',
      'NUM · info@itsnum.com',
    ].join('\n'),
  };
}

/**
 * The weekly note — only when there is something in it.
 *
 * Returns null when the week held nothing. A business that hears from us only
 * when something happened will read the one that arrives.
 */
export async function weeklyDigest(env, { businessId, placeId, place, days = 7, now = Date.now() } = {}) {
  if (!env?.DB || !placeId) return null;

  const since = `-${Number(days) || 7} days`;
  const [impr, reqs] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM num_impressions WHERE place_id = ?1 AND created_at >= datetime('now', ?2)",
    ).bind(String(placeId), since).first().catch(() => null),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM num_booking_requests WHERE place_id = ?1 AND created_at >= datetime('now', ?2)",
    ).bind(String(placeId), since).first().catch(() => null),
  ]);

  const shown = Number(impr?.n ?? 0);
  const requests = Number(reqs?.n ?? 0);

  // NOTHING HAPPENED — send nothing. An empty digest is how a sender becomes
  // spam, and it is also just untrue to call it news.
  if (!shown && !requests) return null;

  const biz = String(place?.name ?? 'your listing').trim();
  const lines = [
    `Your week on Num — ${biz}`,
    '',
    shown ? `Shown to travellers: ${shown}` : null,
    requests ? `Booking requests: ${requests}` : null,
    '',
    'See the detail, and what travellers in your area were asking:',
    `https://app.itsnum.com/api/biz/console?q=${encodeURIComponent(biz.slice(0, 80))}`,
    '',
    'Reply to stop these and a person will turn them off.',
    '',
    'NUM · info@itsnum.com',
  ].filter((l) => l !== null);

  return { subject: `${biz} — your week on Num`, text: lines.join('\n'), shown, requests, businessId };
}

/**
 * The sweep. Weekly per business, never twice in the same seven days.
 *
 * `last_weekly` is written only after a SUCCESSFUL send, so a mail outage
 * retries next tick instead of silently skipping a week — the same lesson as
 * the dropped signup alert that lost Fingal Hotel.
 */
export async function weeklySweep(env, { send, now = Date.now(), limit = 25 } = {}) {
  if (!env?.DB) return { sent: 0 };
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT po.business_id, po.place_id, p.name
       FROM num_place_owners po JOIN places p ON p.id = po.place_id
      WHERE po.revoked_at IS NULL
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));

  let sent = 0;
  for (const row of results ?? []) {
    const pref = await prefs(env, row.business_id);
    if (!pref?.on_weekly || !pref.email) continue;
    if (pref.last_weekly) {
      const ageDays = (now - Date.parse(`${String(pref.last_weekly).replace(' ', 'T')}Z`)) / 86_400_000;
      if (!(ageDays >= 7)) continue;
    }
    const digest = await weeklyDigest(env, {
      businessId: row.business_id, placeId: row.place_id, place: { name: row.name }, now,
    });
    if (!digest) continue;

    const mail = send ?? (await import('./mailer.mjs')).send;
    const out = await mail(env, {
      to: pref.email, from: env.MAIL_FROM || 'NUM <info@itsnum.com>',
      subject: digest.subject, text: digest.text,
    }).catch(() => ({ ok: false }));

    if (out?.ok) {
      await env.DB.prepare(
        "UPDATE num_business_notify SET last_weekly = datetime('now') WHERE business_id = ?1",
      ).bind(String(row.business_id)).run().catch(() => {});
      sent += 1;
    }
  }
  return { sent };
}
