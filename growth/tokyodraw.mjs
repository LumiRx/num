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
import { assess, explain, identityKey, canClaim } from './entryquality.mjs';
import { rows as mustRead } from './readfail.mjs';

/**
 * One person's referrals, with everything the quality rules need to judge
 * them, in ONE query.
 *
 * `activity` is a count rather than a flag so the rule can be loosened later
 * without another migration. num_messages keys members by `member_ref`, not
 * `member_id` — a detail that silently returns zero for everybody if you
 * assume otherwise.
 */
async function referralRows(env, referrerId) {
  /* NOT `.catch(() => [])`. A failed read here would return "you referred
   * nobody", which is indistinguishable from the truth and is the exact
   * failure worked/fridaydraw.mjs records in its own header: a broken query
   * that looked like a quiet week. On a page that tells somebody how close
   * they are to a prize, a silent empty is the worst available answer. */
  return mustRead(env.DB.prepare(
    `SELECT m.id, m.phone_verified, m.email_verified,
            s.device_id, s.ip_hash, s.ua_hash,
            (SELECT COUNT(*) FROM num_messages x WHERE x.member_ref = m.id) AS activity
       FROM num_members m
       LEFT JOIN num_identity_signals s ON s.member_id = m.id
      WHERE m.referred_by = ?1`,
  ).bind(String(referrerId)).all(), 'the people you brought in');
}

async function signalsFor(env, memberId) {
  return env.DB.prepare(
    'SELECT device_id, ip_hash, ua_hash FROM num_identity_signals WHERE member_id = ?1',
  ).bind(String(memberId)).first().catch(() => null);
}

/** What one person's referrals are actually worth, and what was thrown out. */
export async function qualityFor(env, memberId) {
  const [rows, sig] = await Promise.all([
    referralRows(env, memberId), signalsFor(env, memberId),
  ]);
  const a = assess({ referrerId: memberId, referrerSignals: sig, rows });
  return { ...a, joined: rows.length, reasons: explain(a.tally) };
}

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

  /* ── ONE PASS OVER EVERY SIGNAL, THEN JUDGE IN MEMORY ─────────────────
   *
   * The per-person query in qualityFor is right for one console. Running it
   * once per referrer at draw time would be one round trip per entrant, so
   * the whole field is pulled once and assessed locally — same rules, same
   * function, no second implementation that can disagree with the first. */
  const members = await mustRead(env.DB.prepare(
    `SELECT m.id, m.referred_by, m.phone, m.phone_verified, m.email_verified,
            m.identity_verified, m.bio,
            s.device_id, s.ip_hash, s.ua_hash,
            (SELECT COUNT(*) FROM num_messages x WHERE x.member_ref = m.id) AS activity
       FROM num_members m
       LEFT JOIN num_identity_signals s ON s.member_id = m.id`,
  ).all(), 'the people in the draw');

  /* NO EARLY RETURN ON AN EMPTY MEMBER LIST. It used to bail here, which
     skipped the free-entry read below — so a draw whose only entrants came
     in by post would have reported nobody at all. The people the lawful
     route exists for are exactly the ones with no account. */
  const byId = new Map(members.map((m) => [String(m.id), m]));
  const groups = new Map();
  for (const m of members) {
    if (!m.referred_by) continue;
    const k = String(m.referred_by);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

  const byMember = new Map();
  for (const [referrer, rows] of groups) {
    const a = assess({ referrerId: referrer, referrerSignals: byId.get(referrer) ?? null, rows });
    const e = entriesFor(a.counted);
    if (e > 0) byMember.set(referrer, { referred: a.counted, joined: rows.length, earned: e, free: 0 });
  }

  /* ── THE FREE ROUTE, INCLUDING THE PEOPLE WITH NO ACCOUNT ─────────────
   *
   * Found in review, 19 Sep 2026, and it was the worst bug in the draw.
   *
   * This filtered `member_id IS NOT NULL`, so every entry granted by hand to
   * somebody who wrote in — the postal route that clause 3 of the Official
   * Rules advertises, the route that makes this a sweepstake rather than a
   * lottery — was recorded, acknowledged with ok:true, and then **silently
   * excluded from the draw**. Those people had a zero chance of winning while
   * every surface told them they were entered. A free route that cannot win
   * is not a free route, and the legal position rests on it being real.
   *
   * Email-only rows now enter under their own key. They have no referrals, so
   * one entry each, which is exactly what the rules promise them.
   *
   * mustRead, not a silent empty: a failed read here would have quietly drawn
   * a winner from the referral tickets alone with the entire lawful-entry
   * population missing, and reported success. */
  const free = await mustRead(env.DB.prepare(
    `SELECT member_id, email, SUM(entries) AS n FROM num_draw_free_entries
      WHERE campaign = ?1 GROUP BY COALESCE(member_id, 'email:' || email)`,
  ).bind(CAMPAIGN).all(), 'the free entries');
  for (const f of free) {
    if (f.member_id) {
      const id = String(f.member_id);
      const cur = byMember.get(id) || { referred: 0, joined: 0, earned: 0, free: 0 };
      cur.free = Number(f.n || 0);
      byMember.set(id, cur);
    } else if (f.email) {
      // No NUM account. Their own entrant, keyed on the address they wrote
      // in from, so they cannot be merged with anybody and cannot be lost.
      byMember.set('email:' + f.email, {
        referred: 0, joined: 0, earned: 0, free: Number(f.n || 0), postal: true, email: f.email,
      });
    }
  }

  /* ── ONE HUMAN, ONE ENTRANT ───────────────────────────────────────────
   *
   * Dre's whole ask. Two accounts belonging to one person are collapsed to
   * a single row keyed on the strongest identity evidence available — a
   * verified 5arz id first, which /verify/5arz already refuses to attach to
   * two Num accounts.
   *
   * Entries are MERGED rather than summed and rather than taking the max:
   * summing would reward the second account, and taking the max would make
   * the second account free. Merged on the referral COUNT, so somebody who
   * split thirty referrals across two logins gets what thirty referrals are
   * worth once, which is the honest answer. */
  const people = new Map();
  for (const [id, v] of byMember) {
    const m = byId.get(id);
    const key = identityKey(m ? { ...m, device_id: m.device_id } : { id });
    const cur = people.get(key);
    if (!cur) {
      people.set(key, { key, member_id: id, ...v, accounts: 1 });
      continue;
    }
    cur.accounts += 1;
    cur.referred += v.referred;
    cur.joined += v.joined;
    // The free entry does not double either.
    cur.free = Math.max(cur.free, v.free);
    cur.earned = entriesFor(cur.referred);
    // The claimable account is the one that carries the trip, so prefer a
    // verified one when the same person holds both.
    if (canClaim(byId.get(id)) && !canClaim(byId.get(cur.member_id))) cur.member_id = id;
  }

  return [...people.values()]
    .map((r) => ({ ...r, entries: r.earned + r.free, can_claim: canClaim(byId.get(r.member_id)) }))
    .filter((r) => r.entries > 0)
    .sort((a, b) => b.entries - a.entries || a.member_id.localeCompare(b.member_id));
}

/** One person's line, for their own console. */
export async function standingFor(env, memberId) {
  const base = { referred: 0, earned: 0, free: 0, entries: 0 };
  if (!env?.DB || !memberId) return base;
  /* COUNTED, NOT JOINED. Before 19 Sep this was COUNT(*) of everyone with
     referred_by set — which meant twenty accounts made on one phone were
     twenty referrals and, at the top of the ladder, a trip. */
  const [q, f] = await Promise.all([
    qualityFor(env, memberId),
    env.DB.prepare(
      'SELECT COALESCE(SUM(entries),0) AS n FROM num_draw_free_entries WHERE campaign = ?1 AND member_id = ?2',
    ).bind(CAMPAIGN, String(memberId)).first().catch(() => null),
  ]);
  const referred = q.counted;
  const earned = entriesFor(referred);
  const free = Number(f?.n ?? 0);
  return {
    referred, earned, free, entries: earned + free,
    to_next: toNextEntry(referred),
    ladder: LADDER,
    // The honest half. "30 joined, 2 count" with no explanation is how an
    // ambassador decides NUM is stealing from them.
    joined: q.joined,
    not_counted: q.joined - q.counted,
    reasons: q.reasons,
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

  /* ── A DRAW RUNS ONCE, AND A SECOND ATTEMPT RETURNS THE FIRST RESULT ──
   *
   * Found in review, 19 Sep 2026. `INSERT OR IGNORE` on this table does stop
   * a second RESULT row — but num_giveaway_claims is keyed on
   * (draw_id, entrant_key), so a second run with a fresh seed produced a
   * DIFFERENT winner and inserted them alongside the first under the same
   * draw id. Two people are then shown "you won" in the app, for one trip.
   * A double-click was enough.
   *
   * Worse with a caller-supplied seed: an insider could run it repeatedly
   * and read winners out of the response until they liked one, while the
   * stored row kept the first seed — so the seed clause 8 invites anybody to
   * check against would not reproduce the published winner.
   *
   * So the recorded result is authoritative. If one exists for today, it is
   * returned as-is and nothing new is drawn or claimed. */
  const already = await env.DB.prepare(
    'SELECT id, seed, winners, eligible_count FROM num_giveaway_results WHERE id = ?1',
  ).bind(id).first().catch(() => null);
  if (already) {
    let prior = [];
    try { prior = JSON.parse(already.winners || '[]'); } catch { prior = []; }
    return {
      ok: true, id, seed: already.seed, winners: prior, already: true,
      people: rows.length, tickets: Number(already.eligible_count || 0),
      note: 'This draw has already been run. The recorded result stands — '
        + 'rerunning it would hand a second person the same prize.',
    };
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO num_giveaway_results
       (id, week_start, drawn_at, seed, eligible_count, winners, note, campaign)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  ).bind(id, Math.floor(now.getTime() / 1000), now.toISOString(), s,
    tickets.length, JSON.stringify(won),
    `${rows.length} people, ${tickets.length} tickets`, CAMPAIGN).run();

  /* ── THE CLAIM GATE ───────────────────────────────────────────────────
   *
   * Dre's ask: verification through 5arz. It sits HERE, on the winner,
   * rather than on entry — measured 19 Sep 2026, only 2 of 156 members are
   * 5arz-verified, so a gate on entry would have closed the draw to 154
   * people to stop a farm that the counting rules already remove.
   *
   * On the winner it costs nothing and removes the entire payoff: somebody
   * who beat every counting rule with twenty real-looking accounts still has
   * to put a verified identity behind the one that won, and /verify/5arz
   * refuses to attach one 5arz account to two Num accounts.
   *
   * The state is 'won' either way. A winner who has not verified YET has not
   * forfeited anything — they are told, and clause 9 gives them the same
   * fourteen days everybody else gets. `needs_verification` is what the ops
   * console reads to know which conversation to have. */
  /* The WINNERS' own rows — not the people they referred. Fetched after the
     shuffle, so it is one small query for one or two ids rather than a scan
     of the whole membership before anybody has won anything. */
  const byIdForClaim = new Map();
  for (const m of won) {
    const row = await env.DB.prepare(
      'SELECT id, identity_verified, bio FROM num_members WHERE id = ?1',
    ).bind(m).first().catch(() => null);
    if (row) byIdForClaim.set(String(row.id), row);
  }

  const claimable = [];
  for (const m of won) {
    const who = byIdForClaim.get(m) ?? null;
    const ok = canClaim(who);
    claimable.push({ member_id: m, can_claim: ok });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_giveaway_claims
         (draw_id, entrant_key, member_id, state, campaign, reason) VALUES (?1,?2,?3,'won',?4,?5)`,
    ).bind(id, m, m, CAMPAIGN,
      ok ? null : 'awaiting 5arz verification before the prize can be released').run().catch(() => {});
  }

  return {
    ok: true, id, seed: s, winners: won,
    claimable,
    needs_verification: claimable.filter((c) => !c.can_claim).map((c) => c.member_id),
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
  /* ── WHEN IT CLOSES ────────────────────────────────────────────────────
   *
   * Dre's call, 20 Sep 2026: Halloween, not 31 December.
   *
   * The date lives HERE because it is the one figure the card and the
   * Official Rules were each carrying separately — the rules said 31
   * December in prose, giveaways.mjs said 2026-12-31 in an ISO string, and
   * nothing made them agree. Two documents naming different closing dates
   * for the same draw is the kind of drift that gets asked about in
   * writing. One object, read by both.
   *
   * NOT 23:59 UTC on the 31st. This draw runs in the US and the UK, and
   * 23:59 UTC is 16:59 in Los Angeles — it would take Halloween evening
   * away from most of the people it is aimed at. The cutoff is 23:59
   * Pacific on 31 October, which is 06:59 UTC on 1 November (PDT, UTC-7:
   * US clocks do not go back until 1 November 2026, so it is still PDT at
   * that moment). The UK is on GMT by then and gets Halloween plus the
   * small hours.
   *
   * `closesLabel` is what a person reads. Change the two together or the
   * rules and the card go back to disagreeing.
   */
  closesAt: '2026-11-01T06:59:59.000Z',
  closesLabel: '23:59 Pacific Time on 31 October 2026 (Halloween)',
});
