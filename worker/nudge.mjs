// The concierge that speaks first.
//
// Everything else in Num is ask→answer. This is the other half: the plan
// starts tomorrow and Num says so before anyone asks — with the one detail
// that changes what you'd do (rain, mostly, because in Phuket rain is the
// difference between a beach day and a very wet scooter ride).
//
// ── The discipline ───────────────────────────────────────────────────────
//
// A proactive message spends trust every time it fires. The rules:
//
//   1. NEVER twice for the same moment of the same plan. The dedup table is
//      the feature — a concierge that repeats itself is an alarm clock.
//   2. Only about something the person actually has: a plan with a date.
//      No "haven't seen you in a while!", no engagement bait, ever. The
//      moment a nudge exists to serve us instead of them, this file is a
//      growth-hacking tool wearing a concierge's clothes.
//   3. Quiet hours are sacred: nothing lands 21:00–08:00 Phuket time. A
//      concierge that wakes you to say it might rain tomorrow gets fired.
//
// Weather comes from Open-Meteo — free, keyless, and good enough for "bring
// a jacket". If it's down we still nudge, just without the forecast; the
// plan reminder is the substance, the weather is seasoning.

const PHUKET = { lat: 7.8804, lon: 98.3923, tz: 'Asia/Bangkok' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_nudges (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  plan_id TEXT,
  moment TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nudge_once ON num_nudges(member_id, plan_id, moment);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/** Phuket local hour, because "quiet hours" means THEIR night, not UTC's. */
function phuketHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: PHUKET.tz }).format(now));
}

/** Tomorrow's forecast, one line, or null — never a reason to skip the nudge. */
async function forecast(env) {
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${PHUKET.lat}&longitude=${PHUKET.lon}` +
      `&daily=precipitation_probability_max,temperature_2m_max&timezone=${encodeURIComponent(PHUKET.tz)}&forecast_days=2`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!r.ok) return null;
    const d = await r.json();
    const rain = d?.daily?.precipitation_probability_max?.[1];
    const temp = d?.daily?.temperature_2m_max?.[1];
    if (rain == null) return null;
    if (rain >= 60) return `Heads up: ${rain}% chance of rain — worth a plan B indoors.`;
    if (temp != null && temp >= 34) return `It'll be a hot one (~${Math.round(temp)}°C) — book anything outdoors for the evening.`;
    return null; // Fine weather isn't news. Silence is a valid forecast.
  } catch {
    return null;
  }
}

/**
 * The sweep. Runs from cron; finds every plan starting TOMORROW and tells its
 * members once. Returns counts so the cron log reads like a sentence.
 */
export async function nudgeSweep(env) {
  if (!env.DB) return { sent: 0, skipped: 'no db' };
  await ensure(env);

  // Respect the night. The cron fires hourly; the sweep just declines to act.
  const hour = phuketHour();
  if (hour >= 21 || hour < 8) return { sent: 0, skipped: 'quiet hours' };

  // Plans that start tomorrow, Phuket-tomorrow.
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: PHUKET.tz })
    .format(new Date(Date.now() + 86400_000)); // en-CA gives YYYY-MM-DD
  const { results: plans } = await env.DB.prepare(
    "SELECT id, title, dest, starts_on, starts_time FROM num_plans WHERE starts_on = ?1 AND state <> 'done'",
  ).bind(tomorrow).all().catch(() => ({ results: [] }));
  if (!plans?.length) return { sent: 0, plans: 0 };

  const wx = await forecast(env);
  const { notify } = await import('./push.mjs');
  let sent = 0;

  for (const plan of plans) {
    const { results: members } = await env.DB.prepare(
      'SELECT member_id FROM num_plan_members WHERE plan_id = ?1',
    ).bind(plan.id).all().catch(() => ({ results: [] }));

    for (const m of members ?? []) {
      // The dedup INSERT is the gate: a unique index means the second sweep
      // to reach this member finds the row and moves on. Claim BEFORE send —
      // if we sent first and crashed before writing, the next sweep would
      // send again, and a double nudge costs more trust than a lost one.
      const claimed = await env.DB.prepare(
        'INSERT OR IGNORE INTO num_nudges (id, member_id, plan_id, moment) VALUES (?1, ?2, ?3, ?4)',
      ).bind(crypto.randomUUID(), m.member_id, plan.id, `daybefore:${plan.starts_on}`).run().catch(() => null);
      if (!claimed?.meta?.changes) continue;

      const when = plan.starts_time ? ` at ${plan.starts_time}` : '';
      await notify(env, {
        memberId: m.member_id,
        kind: 'plan',
        title: `${plan.title} is tomorrow${when}`,
        body: [
          plan.dest ? `${plan.dest}.` : null,
          wx,
          'Want me to sort a car, or check the booking?',
        ].filter(Boolean).join(' '),
        url: '/?go=plan',
        tag: `nudge:${plan.id}:${plan.starts_on}`,
      }).catch(() => {});
      sent++;
    }
  }
  if (sent) console.log('[nudge] sent', sent, 'for', plans.length, 'plan(s) starting', tomorrow);
  return { sent, plans: plans.length };
}

/**
 * Stalled business onboarding, surfaced once a day.
 *
 * A claim in 'pending' whose link expired, or parked in 'review'/'locked',
 * is a business owner who WANTED in and hit a wall — the highest-value
 * follow-up call the pilot has, and until now it vanished into a table
 * nobody read. One alert to Dre a day, only when there's something to say,
 * with names — because "3 claims stalled" prompts a query, but "Baan Rim Pa
 * stalled" prompts a phone call.
 */
export async function claimSweep(env) {
  if (!env.DB) return { alerted: false };
  await ensure(env);

  // ── NEW web signups: alerted within one cron tick, not once a day ───────
  //
  // The itsnum.com merchant form (num-growth) writes to `claims` — a table no
  // dashboard read and no alert watched. Businesses signed up in Scotland and
  // the news reached Dre days later, secondhand, from Sean. A signup is the
  // one event where minutes matter: the owner is sitting there having just
  // typed their phone number, and that is the moment to call them back.
  //
  // Runs every sweep (no quiet hours — this alerts DRE, not a user, and he
  // said to wake him for money). Deduped per claim forever, so the backlog
  // fires once and each new signup fires once.
  const { results: webNew } = await env.DB.prepare(
    "SELECT id, business_name, contact_name, phone, source, created_at FROM claims WHERE state = 'new' ORDER BY created_at DESC LIMIT 24",
  ).all().catch(() => ({ results: [] }));
  const unseen = [];
  for (const c of webNew ?? []) {
    const claimed = await env.DB.prepare(
      'INSERT OR IGNORE INTO num_nudges (id, member_id, plan_id, moment) VALUES (?1, ?2, ?3, ?4)',
    ).bind(crypto.randomUUID(), 'desk', String(c.id), 'webclaim').run().catch(() => null);
    if (claimed?.meta?.changes) unseen.push(c);
  }
  if (unseen.length) {
    const { alert } = await import('./health.mjs');
    await alert(
      env,
      `[biz] ${unseen.length} NEW web signup(s): ` +
        unseen.slice(0, 6).map((c) => `${c.business_name}${c.contact_name ? ` (${c.contact_name}` : ''}${c.phone ? `${c.contact_name ? ', ' : ' ('}${c.phone})` : c.contact_name ? ')' : ''}`).join('; ') +
        (unseen.length > 6 ? ` +${unseen.length - 6} more` : '') +
        ' — console → Claims.',
    ).catch(() => {});
  }

  const hour = phuketHour();
  // Once a day, mid-morning Phuket — when a follow-up call can actually happen.
  if (hour !== 10) return { alerted: unseen.length > 0, web_new: unseen.length, skipped: 'not the hour' };

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.state, c.created_at, p.name, p.dest
       FROM num_app_claims c JOIN places p ON p.id = c.place_id
      WHERE c.state IN ('review', 'locked')
         OR (c.state = 'pending' AND c.expires_at < datetime('now'))
      ORDER BY c.created_at DESC LIMIT 12`,
  ).all().catch(() => ({ results: [] }));
  const stalled = results ?? [];
  if (!stalled.length) return { alerted: false, stalled: 0 };

  // The same once-only gate the plan nudges use — one row per claim per day.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: PHUKET.tz }).format(new Date());
  const fresh = [];
  for (const c of stalled) {
    const claimed = await env.DB.prepare(
      'INSERT OR IGNORE INTO num_nudges (id, member_id, plan_id, moment) VALUES (?1, ?2, ?3, ?4)',
    ).bind(crypto.randomUUID(), 'desk', c.id, `claimstall:${today}`).run().catch(() => null);
    if (claimed?.meta?.changes) fresh.push(c);
  }
  if (!fresh.length) return { alerted: false, stalled: stalled.length };

  const { alert } = await import('./health.mjs');
  await alert(
    env,
    `[biz] ${fresh.length} onboarding(s) stalled: ` +
      fresh.map((c) => `${c.name} (${c.state})`).join(', ') +
      ' — console → Claims to finish them.',
  ).catch(() => {});
  return { alerted: true, stalled: fresh.length };
}
