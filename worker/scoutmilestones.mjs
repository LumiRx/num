/**
 * NUM · what an Expert has reached, and what is next.
 *
 * ── THE LINE THIS FILE WALKS ──────────────────────────────────────────────
 *
 * worker/scouts.mjs opens with a warning this file has to obey: a dashboard
 * that shows "23 businesses" next to a dollar figure, where the 23 are
 * introductions and the dollars need revenue that has not happened, creates
 * an argument in about six weeks.
 *
 * Motivation built on that number is worse, not better, because it makes the
 * wrong figure the thing somebody chases. So every milestone here counts a
 * state the DATABASE agrees with, and the two that matter most count
 * `activated` — venues that have actually produced money to NUM. Signatures
 * are not progress. A venue that uses NUM is.
 *
 * What makes that motivating rather than discouraging is the other half:
 * `nextGate` shows the venue closest to paying and what it still needs. That
 * is a real number about a real shop, and the action it suggests — go back and
 * get them using it — is the action that actually pays.
 *
 * ── CASH IS OFF, AND THE MACHINERY IS FINISHED ────────────────────────────
 *
 * Every bonus below is 0. Dre's call, 18 Sep: build it all now, funded later,
 * so turning money on is one number and not a migration. Nothing in here
 * promises a bonus that does not exist — a milestone with no bonus reads as
 * recognition, and the page says so.
 */

const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

/**
 * The programme, in order.
 *
 * `of` names what is counted and each one is a state the database can settle:
 *   introduced — businesses brought in, any state but void
 *   activated  — businesses that have produced revenue to NUM
 *   experts    — other Experts this person referred
 *
 * `bonus_cents` is the money. All zero today. Raising one moves nobody who
 * already reached it — a milestone row keeps the bonus it was awarded with —
 * so a later change rewards the people who reach it next, which is what a
 * bonus is for.
 */
export const MILESTONES = Object.freeze([
  { key: 'first_intro', of: 'introduced', need: 1,
    label: 'First business signed up',
    note: 'The hardest one. Every Expert who gets here gets the next one faster.',
    bonus_cents: 0 },
  { key: 'first_earning', of: 'activated', need: 1,
    label: 'First venue earning',
    note: 'A venue you brought in has produced real money to Num. This is the one that pays.',
    bonus_cents: 0 },
  { key: 'live_5', of: 'activated', need: 5,
    label: 'Five venues earning',
    note: 'Five shops using Num because you walked in.',
    bonus_cents: 0 },
  { key: 'live_10', of: 'activated', need: 10,
    label: 'Ten venues earning',
    note: 'Ten. The recurring share on ten live venues is the part that compounds.',
    bonus_cents: 0 },
  { key: 'live_25', of: 'activated', need: 25,
    label: 'Twenty-five venues earning',
    note: 'A neighbourhood.',
    bonus_cents: 0 },
  { key: 'first_expert', of: 'experts', need: 1,
    label: 'Brought in another Expert',
    note: 'You earn a share of what they earn, on top of what they are paid.',
    bonus_cents: 0 },
]);

/** What this scout has actually done, counted from the rows, never cached. */
export async function countsFor(env, scoutId) {
  const p = await env.DB.prepare(
    `SELECT COUNT(*) AS introduced,
            COALESCE(SUM(CASE WHEN state='activated' THEN 1 ELSE 0 END), 0) AS activated
       FROM num_scout_places WHERE scout_id=?1 AND state <> 'void'`,
  ).bind(scoutId).first().catch(() => null);

  const e = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM num_scouts WHERE referred_by_scout_id=?1',
  ).bind(scoutId).first().catch(() => null);

  return {
    introduced: Number(p?.introduced ?? 0),
    activated: Number(p?.activated ?? 0),
    experts: Number(e?.n ?? 0),
  };
}

/**
 * The venue closest to releasing its finder fee, and what it still needs.
 *
 * The single most useful number on the dashboard, because it is the only one
 * that names something to go and do today. Read off the place rows, so it is
 * the same gate the payout actually uses rather than a second opinion.
 */
export async function nextGate(env, scoutId) {
  const row = await env.DB.prepare(
    `SELECT biz_name, dest, revenue_minor, finder_gate_minor, finder_cents
       FROM num_scout_places
      WHERE scout_id=?1 AND state IN ('introduced','verified')
        AND revenue_minor < finder_gate_minor
      ORDER BY (finder_gate_minor - revenue_minor) ASC LIMIT 1`,
  ).bind(scoutId).first().catch(() => null);
  if (!row) return null;
  return {
    biz_name: row.biz_name,
    dest: row.dest ?? null,
    needs_minor: Math.max(0, Number(row.finder_gate_minor) - Number(row.revenue_minor)),
    releases_minor: Number(row.finder_cents ?? 0),
    note: 'Once this venue has produced that much to Num, your finder fee releases.',
  };
}

/**
 * Award anything newly reached. Safe to run as often as you like.
 *
 * The UNIQUE (scout_id, key) in 0034 is what makes that true, not the SELECT
 * below — the check is a courtesy to avoid pointless writes, and the database
 * is the rule. A constraint violation here is success, not failure: somebody
 * else got there first in a concurrent request.
 */
export async function award(env, scoutId, { now = new Date() } = {}) {
  if (!env?.DB || !scoutId) return { ok: false, reached: [] };

  const counts = await countsFor(env, scoutId);
  const { results: had = [] } = await env.DB.prepare(
    'SELECT key FROM num_scout_milestones WHERE scout_id=?1',
  ).bind(scoutId).all().catch(() => ({ results: [] }));
  const already = new Set(had.map((r) => r.key));

  const reached = [];
  for (const m of MILESTONES) {
    if (already.has(m.key)) continue;
    if (Number(counts[m.of] ?? 0) < m.need) continue;

    // A bonus is only ever paid out of revenue those venues actually produced.
    // Unfunded, it is still reached — the badge is real, the money is not
    // invented. See the note at the top of 0034.
    let bonus = 0;
    let earningId = null;
    if (m.bonus_cents > 0) {
      const g = await env.DB.prepare(
        `SELECT COALESCE(SUM(revenue_minor), 0) AS gross FROM num_scout_places
          WHERE scout_id=?1 AND state='activated'`,
      ).bind(scoutId).first().catch(() => null);
      const gross = Number(g?.gross ?? 0);
      if (m.bonus_cents <= gross) {
        bonus = m.bonus_cents;
        earningId = uid('se');
        await env.DB.prepare(
          `INSERT INTO num_scout_earnings
             (id, scout_id, scout_place_id, kind, gross_minor, amount_minor, state, accrued_at)
           VALUES (?1,?2,NULL,'milestone',?3,?4,'accrued',?5)`,
        ).bind(earningId, scoutId, gross, bonus, now.toISOString()).run();
      }
    }

    try {
      await env.DB.prepare(
        `INSERT INTO num_scout_milestones
           (id, scout_id, key, label, threshold, reached_at, bonus_cents, earning_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
      ).bind(uid('sm'), scoutId, m.key, m.label, m.need, now.toISOString(), bonus, earningId).run();
      reached.push({ key: m.key, label: m.label, bonus_cents: bonus });
    } catch (err) {
      // UNIQUE means somebody already has it. Not an error.
      if (!/UNIQUE/i.test(String(err?.message))) throw err;
    }
  }
  return { ok: true, reached };
}

/**
 * Everything the dashboard shows: what has been reached, what is next, and
 * how far along it is.
 *
 * `next` carries `have` and `need` so the page can draw a bar without doing
 * arithmetic of its own — a progress bar computed in two places is a progress
 * bar that disagrees with itself.
 */
export async function progressFor(env, scoutId) {
  const counts = await countsFor(env, scoutId);
  const { results: rows = [] } = await env.DB.prepare(
    `SELECT key, label, threshold, reached_at, bonus_cents FROM num_scout_milestones
      WHERE scout_id=?1 ORDER BY reached_at ASC`,
  ).bind(scoutId).all().catch(() => ({ results: [] }));
  const done = new Set(rows.map((r) => r.key));

  const upcoming = MILESTONES.filter((m) => !done.has(m.key)).map((m) => ({
    key: m.key,
    label: m.label,
    note: m.note,
    have: Math.min(Number(counts[m.of] ?? 0), m.need),
    need: m.need,
    counting: m.of,
    bonus_cents: m.bonus_cents,
  }));

  return {
    counts,
    reached: rows.map((r) => ({
      key: r.key, label: r.label, threshold: r.threshold,
      reached_at: r.reached_at, bonus_cents: r.bonus_cents,
    })),
    next: upcoming[0] ?? null,
    upcoming,
    gate: await nextGate(env, scoutId),
    // Said here rather than left to the page, so every surface says the same
    // thing about what a milestone with no bonus is.
    note: 'Milestones count venues that have produced real revenue to Num — not sign-ups. '
      + 'A milestone with no amount beside it is recognition, not a payment.',
  };
}
