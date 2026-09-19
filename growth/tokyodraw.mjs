/**
 * The Tokyo trip — five days, flights and hotel, drawn from referral entries.
 *
 * ── THIS FILE OWNS NO DRAW EITHER ────────────────────────────────────────
 *
 * worker/fridaydraw.mjs already contains a draw whose entire purpose is that
 * a stranger can re-run it: a Fisher-Yates shuffle over a SORTED list, driven
 * by a seed generated once and recorded, never derived from the list it
 * selects. The Official Rules promise that property in clause 7 and it is the
 * thing that separates a draw from "trust us".
 *
 * Writing a second draw beside it would mean two things to trust, and the new
 * one would be the untested one. So `pickWinners` is imported and used
 * unchanged.
 *
 * ── THE ONE PROBLEM THAT NEEDED SOLVING ──────────────────────────────────
 *
 * `pickWinners` de-duplicates: `[...new Set(ids)]`. That is correct and
 * deliberate for the Friday draw, where one person gets one ticket however
 * many doors they came through. It also means weighting CANNOT be done by
 * repeating somebody's id — the Set eats the duplicates and everybody ends up
 * with one ticket again, silently, which would look exactly like a working
 * weighted draw while being a flat one.
 *
 * So entries become TICKET STRINGS — `m_abc#1`, `m_abc#2` — which are
 * genuinely distinct, survive the Set, sort deterministically and shuffle
 * with the same seeded rng. The winner list is then walked in shuffled order
 * taking each member once. Same function, same seed behaviour, same
 * reproducibility, and the weighting is visible in the recorded ticket list
 * rather than hidden in a probability.
 *
 * ── ENTRIES ARE COMPUTED, NEVER STORED ───────────────────────────────────
 *
 * Nobody's entry count is written down. It is derived from `referred_by` at
 * the moment it is asked for, so it cannot drift from the truth, cannot be
 * edited, and can be recounted by anybody who can count members. The only
 * rows this file reads that are not referrals are the FREE entries, which
 * exist because of the law rather than because of anybody's effort.
 *
 * ── WHY THERE IS A FREE ROUTE AT ALL ─────────────────────────────────────
 *
 * Dre's call, 19 Sep 2026. A prize draw whose entries are earned by
 * recruiting people can be treated as requiring consideration, and a draw
 * with consideration is a lottery, which a private company may not run in
 * most US states. The Friday draw already answers this with "no purchase
 * necessary"; this one answers it with a route in that asks nothing of
 * anybody. It is cheap, it is what makes the promotion lawful where the
 * rules say it runs, and it must never be quietly removed to make the
 * referral ladder look better.
 */
import { pickWinners, newSeed } from '../worker/fridaydraw.mjs';

/** The campaign key. One string, used by the tables, the rules and the card. */
export const CAMPAIGN = 'tokyo-2026';

/**
 * The ladder, and the only numbers in this file worth arguing about.
 *
 * Dre asked for 500 → 1 entry, 1,000 → 2, then one per 100. Measured against
 * production on 19 Sep 2026: NUM has 156 members in total, so a single
 * person bringing 500 is not a stretch target, it is a closed door — every
 * ambassador would have read "0 of 500" for months, which demotivates
 * precisely the people it was written to motivate.
 *
 * So the SHAPE is his and the SIZE is the product's: a rung that a real
 * person could reach this month, doubling, then a steady climb. Three
 * numbers, in one place, to be raised the moment the base is bigger.
 */
export const LADDER = Object.freeze({ first: 25, second: 50, step: 25 });

/**
 * Entries earned by bringing people in.
 *
 *   below `first`            nothing yet
 *   `first` … `second`-1     one
 *   `second` and above       two, plus one for every `step` past it
 */
export function entriesFor(referred) {
  const raw = Number(referred);
  // Number.isFinite, not just `|| 0`. Infinity floors to Infinity, sails past
  // both rungs and returns Infinity entries — one corrupted count and a
  // single entrant holds every ticket in the draw. A prize draw is exactly
  // the wrong place to let a non-finite number through.
  const n = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (n < LADDER.first) return 0;
  if (n < LADDER.second) return 1;
  return 2 + Math.floor((n - LADDER.second) / LADDER.step);
}

/** How many more people until the next entry — the number the card shows. */
export function toNextEntry(referred) {
  const raw = Number(referred);
  const n = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (n < LADDER.first) return LADDER.first - n;
  if (n < LADDER.second) return LADDER.second - n;
  const past = (n - LADDER.second) % LADDER.step;
  return LADDER.step - past;
}

/** Build one person's tickets. Distinct strings, so the Set in pickWinners
 *  keeps every one of them. */
export function ticketsFor(memberId, entries) {
  const raw = Number(entries);
  // Capped as well as finite-checked. Even a legitimate enormous count should
  // not be able to build a million-string array inside a Worker's CPU budget
  // and take the draw down with it.
  const n = Number.isFinite(raw) ? Math.min(10000, Math.max(0, Math.floor(raw))) : 0;
  const out = [];
  for (let i = 1; i <= n; i++) out.push(`${memberId}#${i}`);
  return out;
}

/** The member behind a ticket. */
export const memberOfTicket = (t) => String(t).split('#')[0];

/**
 * Everybody in the draw, with their entries, computed fresh.
 *
 * Referral entries and free entries are summed per member, so somebody who
 * asked for a free entry AND brought people in is not penalised for having
 * used the free door — refusing to stack them would make the free route a
 * trap rather than a right.
 */
export async function standings(env) {
  if (!env?.DB) return [];
  const byMember = new Map();

  const { results: refs = [] } = await env.DB.prepare(
    `SELECT referred_by AS member_id, COUNT(*) AS n
       FROM num_members WHERE referred_by IS NOT NULL
      GROUP BY referred_by`,
  ).all().catch(() => ({ results: [] }));
  for (const r of refs) {
    const e = entriesFor(r.n);
    if (e > 0) byMember.set(String(r.member_id), { referred: Number(r.n), earned: e, free: 0 });
  }

  const { results: free = [] } = await env.DB.prepare(
    `SELECT member_id, SUM(entries) AS n FROM num_draw_free_entries
      WHERE campaign = ?1 AND member_id IS NOT NULL GROUP BY member_id`,
  ).bind(CAMPAIGN).all().catch(() => ({ results: [] }));
  for (const f of free) {
    const id = String(f.member_id);
    const cur = byMember.get(id) || { referred: 0, earned: 0, free: 0 };
    cur.free = Number(f.n || 0);
    byMember.set(id, cur);
  }

  return [...byMember.entries()]
    .map(([member_id, v]) => ({ member_id, ...v, entries: v.earned + v.free }))
    .filter((r) => r.entries > 0)
    .sort((a, b) => b.entries - a.entries || a.member_id.localeCompare(b.member_id));
}

/** One person's line, for their own console. */
export async function standingFor(env, memberId) {
  const base = { referred: 0, earned: 0, free: 0, entries: 0 };
  if (!env?.DB || !memberId) return base;
  const r = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM num_members WHERE referred_by = ?1',
  ).bind(String(memberId)).first().catch(() => null);
  const f = await env.DB.prepare(
    'SELECT COALESCE(SUM(entries),0) AS n FROM num_draw_free_entries WHERE campaign = ?1 AND member_id = ?2',
  ).bind(CAMPAIGN, String(memberId)).first().catch(() => null);
  const referred = Number(r?.n ?? 0);
  const earned = entriesFor(referred);
  const free = Number(f?.n ?? 0);
  return {
    referred, earned, free, entries: earned + free,
    to_next: toNextEntry(referred),
    ladder: LADDER,
  };
}

/**
 * Run it.
 *
 * Everything that made the Friday draw checkable is kept: the seed is
 * generated once here and RECORDED, the ticket list is recorded whole, and
 * `pickWinners` does the selection. Anybody handed the seed and the ticket
 * list can reproduce the result exactly, on any machine, at any time.
 *
 * `winners` is a count, not a flag: a trip for one is the headline, but the
 * same function runs a draw for three without being rewritten.
 */
export async function runTokyoDraw(env, { seed = null, winners = 1, now = new Date() } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };

  const rows = await standings(env);
  if (!rows.length) {
    // NOT a quiet success. A draw with nobody in it is a fact somebody needs
    // to act on, and the Friday draw's own header records what happens when
    // an empty read is reported as a calm week.
    return { ok: false, why: 'nobody has an entry yet', eligible: 0 };
  }

  const tickets = rows.flatMap((r) => ticketsFor(r.member_id, r.entries));
  const s = seed || newSeed();

  // The whole shuffled order, not just the top slice, so that walking it to
  // skip a repeat member never runs out of names.
  const order = pickWinners(tickets, tickets.length, s);

  const won = [];
  for (const t of order) {
    const m = memberOfTicket(t);
    // One trip per person. A weighted draw where the same name can come out
    // twice is a weighted draw that hands one person both prizes.
    if (!won.includes(m)) won.push(m);
    if (won.length >= winners) break;
  }

  const id = `${CAMPAIGN}-${now.toISOString().slice(0, 10)}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO num_giveaway_results
       (id, week_start, drawn_at, seed, eligible_count, winners, note, campaign)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  ).bind(id, Math.floor(now.getTime() / 1000), now.toISOString(), s,
    tickets.length, JSON.stringify(won),
    `${rows.length} people, ${tickets.length} tickets`, CAMPAIGN).run();

  for (const m of won) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_giveaway_claims
         (draw_id, entrant_key, member_id, state, campaign) VALUES (?1,?2,?3,'won',?4)`,
    ).bind(id, m, m, CAMPAIGN).run().catch(() => {});
  }

  return {
    ok: true, id, seed: s, winners: won,
    people: rows.length, tickets: tickets.length,
    // Handed back so whoever runs it can publish the two things that make
    // the result checkable, rather than having to go and find them.
    verify: { seed: s, tickets },
  };
}

/**
 * The free way in.
 *
 * THIS IS THE CLAUSE THAT KEEPS THE DRAW LAWFUL and it is deliberately the
 * easiest thing in the file: one button, no referrals, no purchase, no
 * conditions beyond being reachable if you win. Anybody quietly removing it
 * to make the referral ladder look better is converting a sweepstake into a
 * lottery, which a private company may not run in most US states.
 *
 * The unique index in 0055 is what stops it becoming the easy route — one per
 * person per campaign, enforced by the database rather than by a check that
 * can race with itself.
 *
 * Non-members enter by writing to the contact address in the Official Rules
 * and are granted one by hand. A free route that requires an account is not
 * a free route.
 */
export async function grantFreeEntry(env, { memberId = null, email = null, name = null,
  source = 'app', note = null } = {}) {
  if (!env?.DB || (!memberId && !email)) return { ok: false, why: 'nobody to enter' };
  const id = 'fe_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  try {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO num_draw_free_entries
         (id, campaign, member_id, email, name, entries, source, note, created_at)
       VALUES (?1,?2,?3,?4,?5,1,?6,?7,?8)`,
    ).bind(id, CAMPAIGN, memberId, email ? String(email).toLowerCase() : null,
      name, source, note, new Date().toISOString()).run();
    const added = Number(res?.meta?.changes ?? 0) > 0;
    // Already having one is not an error. Telling somebody their entry failed
    // when they are already in the draw is how a correct system reads as broken.
    return { ok: true, already: !added };
  } catch (e) {
    console.warn('[tokyo free entry]', e?.message ?? e);
    return { ok: false, why: 'could not record that entry' };
  }
}

/** The prize and the terms, in one object, so the card, the rules page and
 *  the console cannot describe different draws. Same pattern as
 *  growth/fridayrules.mjs RULES, which exists for exactly this reason. */
export const PRIZE = Object.freeze({
  title: 'Five days in Tokyo',
  nights: 5,
  what: 'Return flights and five nights in a hotel, for one person plus a guest.',
  // Stated as a range, like the Friday rules' pack value: a single invented
  // figure in an Official Rules is an invented figure in a legal document.
  arvUsd: '4,000-6,000',
  winners: 1,
  freeRoute: 'Tap Enter in the app, or write to info@itsnum.com. No referrals, no purchase.',
});
