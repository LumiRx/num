/* Chase the businesses who started a claim and stopped.
 *
 * ── WHAT WENT WRONG, AND WHY THIS FILE EXISTS ────────────────────────────
 * /api/claims/start writes a `num_claims` row in state 'pending' and returns
 * the list of channels that could prove the listing. The code is sent by a
 * SECOND call, /api/claims/send. Anyone who closes the tab at the channel
 * picker leaves a pending row with `sent_at` NULL — a business that raised its
 * hand and was never touched again.
 *
 * On 7 Sep 2026 there were two of them:
 *
 *   Adam,  reception@hieedinburgh.co.uk  — Holiday Inn Express Edinburgh,
 *          started 24 Aug. Fourteen days.
 *   Larry, larry@c-ohomenetwork.com      — Arroyo del Sol, Pasadena, started
 *          17:41 that afternoon, four minutes after opening our own invite.
 *
 * nudge.mjs already found both and alerted OPS. Nobody acted, twice, for two
 * weeks. The missing half was never detection — it was that the person who
 * actually wanted something was never written to. This file writes to them.
 *
 * ── AT MOST ONCE, FOREVER ────────────────────────────────────────────────
 * `num_claim_reminders` has PRIMARY KEY (claim_id, round) and was created for
 * this and never used. `INSERT OR IGNORE` against it is the lock: a round that
 * has been sent can never be sent again, not "not again today". That
 * distinction is load-bearing — a per-day guard on a sweep that runs every
 * five minutes is how bizonboard nearly sent 288 identical alerts in a day.
 */

/** When each chase goes out, measured from the claim being started.
 *
 * Three, then silence. A business that has ignored three emails about its own
 * listing is not persuadable by a fourth; it is a complaint waiting to happen,
 * and this domain's reputation is worth more than one more attempt. */
export const ROUNDS = Object.freeze([
  { round: 1, afterHours: 2 },    // same day — they were just here
  { round: 2, afterHours: 72 },   // day three
  { round: 3, afterHours: 168 },  // day seven, then stop
]);

/** The highest round now due for a claim of this age, or 0 for none. */
export function dueRound(ageHours) {
  let due = 0;
  for (const r of ROUNDS) if (ageHours >= r.afterHours) due = r.round;
  return due;
}

/** Whole hours between an SQLite datetime string and `now`.
 *
 * D1 stores `datetime('now')` as "YYYY-MM-DD HH:MM:SS" with no zone, and it is
 * UTC. Parsing it without the Z makes it local, which on a UTC worker is a
 * no-op and on a developer's laptop silently shifts every age by the offset —
 * long enough to send round 2 on day one. */
export function ageHours(createdAt, now = new Date()) {
  if (!createdAt) return 0;
  const t = Date.parse(`${String(createdAt).replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now.getTime() - t) / 3600000);
}

/** The message. Plain text on purpose — this is one person writing to another
 *  about something they started, not a campaign. */
export function chaseEmail({ businessName, placeName, claimantName, resumeUrl, round }) {
  const who = claimantName ? `Hi ${claimantName},` : 'Hello,';
  const name = placeName || businessName || 'your business';
  const nudge = round === 1
    ? 'You got as far as choosing how to prove it and then stopped — that step sends a short code to the contact already published on your listing.'
    : round === 2
      ? 'It only takes the one code, and it goes to the contact already published on your listing — not to an address you have to give us.'
      : 'This is the last time we will write about it. The listing stays either way; claiming it is what lets you change what we say.';
  return {
    subject: round === 1 ? `Finish claiming ${name}` : `${name} — still yours to claim`,
    text:
`${who}

You started claiming ${name} on NUM. ${nudge}

Pick up where you left off:
${resumeUrl}

Claiming it means you decide what NUM tells a traveller about you — the
description, the hours, the photo, and one thing we can offer a guest who asks
for somewhere like yours. It is free, there is no card, and nobody can pay to
be recommended ahead of you.

If this was not you, ignore this and nothing happens.

— NUM
Reply to this email and a person answers.`,
  };
}

/** Mark the invite that produced a claim, matching on the EMAIL DOMAIN.
 *
 * `num_invites.claimed_at` was joined on the exact address and therefore
 * recorded zero conversions while the campaign had at least one: the invite
 * went to info@c-ohomenetwork.com and Larry claimed from
 * larry@c-ohomenetwork.com four minutes later. info@ receives, the owner
 * replies — that is the ordinary shape of a real signup, not an edge case.
 *
 * Domain, never a substring: matching "%c-ohomenetwork.com" would also match
 * "not-c-ohomenetwork.com", and attributing a stranger's signup to an invite
 * is worse than missing one.
 */
export async function attributeClaim(env, { claimId, email }) {
  const at = String(email ?? '').lastIndexOf('@');
  if (at < 1) return { matched: 0 };
  const domain = String(email).slice(at + 1).toLowerCase();
  // A freemail domain says nothing about who was invited — everyone shares it.
  if (['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com'].includes(domain)) {
    return { matched: 0, skipped: 'freemail' };
  }
  const r = await env.DB.prepare(
    `UPDATE num_invites
        SET claimed_at = COALESCE(claimed_at, datetime('now'))
      WHERE claimed_at IS NULL
        AND lower(substr(email, instr(email, '@') + 1)) = ?1`,
  ).bind(domain).run().catch(() => null);
  return { matched: r?.meta?.changes ?? 0, domain, claimId };
}

/**
 * One sweep. Writes to every business that started a claim and stopped.
 *
 * @param {object} env
 * @param {{ mailer?: Function, now?: Date, limit?: number, site?: string }} opts
 */
export async function chaseStalledClaims(env, { mailer, now = new Date(), limit = 20, site } = {}) {
  if (!env?.DB) return { sent: 0, reason: 'no database' };
  const base = site || env.SITE || 'https://itsnum.com';

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.place_id, c.claimant_name, c.claimant_email, c.created_at,
            p.name AS place_name
       FROM num_claims c
       LEFT JOIN places p ON p.id = c.place_id
      WHERE c.state = 'pending'
        -- sent_at NULL is the whole population: a claim that got its code is
        -- somebody's unfinished business, not ours.
        AND c.sent_at IS NULL
        AND c.claimant_email IS NOT NULL AND c.claimant_email LIKE '%@%'
        -- Older than a month is not a warm lead, it is a cold one wearing a
        -- timestamp, and mailing it costs more reputation than it can return.
        AND c.created_at > datetime('now', '-30 days')
      ORDER BY c.created_at ASC
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));

  const send = mailer ?? (await import('./mailer.mjs')).send;
  const out = { considered: (results ?? []).length, sent: 0, skipped: 0, failed: 0, rows: [] };

  for (const c of results ?? []) {
    const round = dueRound(ageHours(c.created_at, now));
    if (!round) { out.skipped++; continue; }

    // THE LOCK. Taken before the send, so a mailer that throws cannot be
    // retried into a second copy of the same message.
    const claimed = await env.DB.prepare(
      'INSERT OR IGNORE INTO num_claim_reminders (claim_id, round) VALUES (?1, ?2)',
    ).bind(String(c.id), round).run().catch(() => null);
    if (!claimed?.meta?.changes) { out.skipped++; continue; }

    const resumeUrl = c.place_id
      ? `${base}/claim/?p=${encodeURIComponent(c.place_id)}`
      : `${base}/claim/`;
    const { subject, text } = chaseEmail({
      placeName: c.place_name,
      claimantName: c.claimant_name,
      resumeUrl,
      round,
    });

    const res = await send(env, {
      to: c.claimant_email,
      subject,
      text,
      headers: {
        'List-Unsubscribe': `<mailto:${env.MAIL_REPLY_TO || 'info@itsnum.com'}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

    if (res?.ok) {
      out.sent++;
      out.rows.push({ claim: c.id, to: c.claimant_email, round });
      await env.DB.prepare(
        "INSERT INTO num_claim_events (claim_id, event, detail) VALUES (?1, 'chased', ?2)",
      ).bind(String(c.id), `round ${round}`).run().catch(() => {});
    } else {
      out.failed++;
      // Release the lock so a transport outage does not permanently silence a
      // real business. The row is gone, the next sweep tries again.
      await env.DB.prepare(
        'DELETE FROM num_claim_reminders WHERE claim_id = ?1 AND round = ?2',
      ).bind(String(c.id), round).run().catch(() => {});
      out.rows.push({ claim: c.id, to: c.claimant_email, round, error: res?.error ?? 'send failed' });
    }
  }
  return out;
}
