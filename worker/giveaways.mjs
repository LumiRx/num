/**
 * GIVEAWAYS — the list a member sees in their profile, and the button that enters.
 *
 * Dre, 18 Sep: "we need a giveaways tab for our pokemon giveaway listing. and
 * also we will be doing other giveways we can put that in profile page."
 *
 * ── THIS FILE OWNS NO DRAW ───────────────────────────────────────────────
 *
 * The Friday pack draw already exists in three modules that were hard-won:
 * giveaway.mjs (one entry per person per week, two doors), packdraw.mjs (the
 * PACKS code and the reply), fridaydraw.mjs (the seeded draw the console runs).
 * This file is a WINDOW onto them: it lists what is live, says whether this
 * member is in, and the Enter button calls the same `recordEntry` the chat
 * code does. A second writer to the entrants table is the bug 13 Sep fixed;
 * there is still exactly one.
 *
 * Every figure shown comes from growth/fridayrules.mjs RULES — the same
 * object the Official Rules page is rendered from — so the card and the rules
 * cannot name different prizes, ages or countries.
 *
 * ── ENTERING NEEDS A VERIFIED CONTACT ────────────────────────────────────
 *
 * Sending a message needs one (sendgate.mjs), and PACKS in the chat is a
 * message, so the button holds the same line. It also matters for the prize:
 * a winner NUM cannot reach forfeits (fridaydraw.forfeitAndRedraw), and
 * refusing an entry we could never pay out on is kinder than accepting it.
 *
 * Adding a giveaway: add an entry to LIVE with its own `status(env, member)`.
 */
import { RULES } from '../growth/fridayrules.mjs';
import { weekStart, weekEnd, entrantKey, eligibleCount, phoneForMember } from './giveaway.mjs';
import { recordEntry, weekKeyFor, ENTRY_CODE } from './packdraw.mjs';
import { hasVerifiedContact } from './membercontact.mjs';
import {
  CAMPAIGN as TOKYO_ID, PRIZE as TOKYO, LADDER as TOKYO_LADDER,
  standingFor as tokyoStanding, grantFreeEntry as tokyoFreeEntry,
} from '../growth/tokyodraw.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export const FRIDAY_PACKS_ID = 'friday-packs';

/** Where the member is in this week's draw: not in, in, or won the latest one. */
export async function fridayStatus(env, member, nowSec = Math.floor(Date.now() / 1000)) {
  const start = weekStart(nowSec);
  const out = { entered: false, won: null, entries: await eligibleCount(env, nowSec) };
  if (!member?.id) return out;
  const key = entrantKey({ phone: await phoneForMember(env, member.id), memberId: member.id });
  const row = await env.DB.prepare(
    'SELECT 1 AS one FROM num_giveaway_entrants WHERE entrant_key = ?1 AND week_start = ?2',
  ).bind(key, start).first();
  out.entered = !!row;
  // The most recent draw this person won and has not forfeited — told plainly,
  // because the reply in the chat only reaches the people who happen to open it.
  const won = await env.DB.prepare(
    "SELECT c.draw_id, c.state, r.drawn_at FROM num_giveaway_claims c JOIN num_giveaway_results r ON r.id = c.draw_id WHERE c.entrant_key = ?1 AND c.state IN ('won','claimed') ORDER BY r.drawn_at DESC LIMIT 1",
  ).bind(key).first().catch(() => null);
  if (won) out.won = { draw: won.draw_id, state: won.state, drawn_at: won.drawn_at };
  return out;
}

/** Where this member stands in the Tokyo draw.
 *
 *  `entered` is true when they hold ANY entry, earned or free — the card's job
 *  is to say whether they are in the draw, and somebody with four earned
 *  entries who never tapped the free button is very much in it. */
export async function tokyoStatus(env, member) {
  const out = { entered: false, won: null, entries: 0, earned: 0, free: 0, referred: 0, to_next: TOKYO_LADDER.first };
  if (!member?.id) return out;
  const s = await tokyoStanding(env, member.id);
  return { ...out, ...s, entered: s.entries > 0 };
}

/** The catalogue. The shape is the contract the profile renders. */
export const LIVE = Object.freeze([
  Object.freeze({
    id: FRIDAY_PACKS_ID,
    title: 'Friday Pokémon pack draw',
    prize: `${RULES.winnersPerWeek} winners a week, ${RULES.packsPerWinner} sealed Pokémon trading card pack each`,
    how: `Tap Enter, or send ${ENTRY_CODE} to NUM`,
    who: `${RULES.countries.join(' and ')}, ${RULES.minAge}+ · one entry each per week · free`,
    rules_url: `https://${RULES.site}/friday-rules`,
    // Not affiliated — clause 11 of the rules, and it belongs beside the word Pokémon wherever it appears.
    note: 'Not sponsored by or affiliated with Nintendo or The Pokémon Company.',
    status: fridayStatus,
    enter: (env, member) => recordEntry(env, { memberId: member.id, source: 'profile' }),
  }),
  /* ── THE TOKYO TRIP ──────────────────────────────────────────────────
   *
   * Entries are EARNED by bringing people to NUM, and the Enter button is
   * the FREE route rather than the only route. That is not a quirk of the
   * UI, it is the clause that keeps the draw lawful: a prize draw whose
   * entries must be earned by recruiting can be treated as requiring
   * consideration, and a draw with consideration is a lottery.
   *
   * So the button says "enter free", it asks for nothing, and anybody who
   * taps it is in the draw alongside the people who brought in fifty.
   */
  Object.freeze({
    id: TOKYO_ID,
    title: TOKYO.title,
    prize: TOKYO.what,
    how: `Enter free here, or earn more entries: ${TOKYO_LADDER.first} people you bring to NUM is one entry, `
      + `${TOKYO_LADDER.second} is two, then one more for every ${TOKYO_LADDER.step} after that`,
    who: `${RULES.countries.join(' and ')}, ${RULES.minAge}+ · free to enter · no purchase necessary`,
    rules_url: `https://${RULES.site}/tokyo-rules`,
    note: 'Entries are counted from real signups. Free entry needs no referrals at all. '
      + 'A winner verifies their identity with 5arz before the prize is released — free, and inside NUM.',
    // Not the Friday week. Without this the card would tell everybody the
    // trip closes this Sunday.
    closesAt: '2026-12-31T23:59:59.000Z',
    status: tokyoStatus,
    enter: (env, member) => tokyoFreeEntry(env, { memberId: member.id, source: 'profile' }),
  }),
]);

async function memberFor(env, me) {
  if (!me) return null;
  return env.DB.prepare('SELECT id, phone, phone_verified, email, email_verified FROM num_members WHERE id = ?1').bind(me).first();
}

/** Everything the profile shows, for this member. */
export async function list(env, me, nowSec = Math.floor(Date.now() / 1000)) {
  const member = await memberFor(env, me);
  const start = weekStart(nowSec);
  const items = [];
  for (const g of LIVE) {
    const s = await g.status(env, member, nowSec);
    items.push({
      id: g.id, title: g.title, prize: g.prize, how: g.how, who: g.who, rules_url: g.rules_url, note: g.note,
      // The Friday draw closes on Sunday; a one-off campaign does not. An
      // item that knows its own end date says so, rather than inheriting a
      // week boundary that has nothing to do with it.
      closes_at: g.closesAt ?? new Date(weekEnd(start) * 1000).toISOString(),
      draw_label: weekKeyFor(new Date(nowSec * 1000)),
      ...s,
    });
  }
  return { ok: true, can_enter: !!(member && hasVerifiedContact(member)), giveaways: items };
}

export async function handleGiveaways(request, env, path, url) {
  if (!env?.DB) return json({ error: 'no database' }, 503);
  if (request.method === 'GET' && (path === '/' || path === '')) {
    return json(await list(env, String(url.searchParams.get('me') ?? '').trim() || null));
  }
  if (request.method === 'POST' && path === '/enter') {
    const b = await request.json().catch(() => ({}));
    const me = String(b.me ?? '').trim();
    const g = LIVE.find((x) => x.id === String(b.id ?? ''));
    if (!g) return json({ error: 'unknown giveaway' }, 404);
    if (!me) return json({ error: 'sign in first' }, 401);
    const member = await memberFor(env, me);
    if (!member) return json({ error: 'unknown member' }, 404);
    if (!hasVerifiedContact(member)) return json({ error: 'verify_to_send', message: 'Verify a number or an email first — a prize needs somewhere to go.' }, 403);
    const r = await g.enter(env, member);
    if (!r.ok) return json({ ok: false, error: r.why ?? 'could not record that entry' }, 500);
    const s = await g.status(env, member);
    return json({ ok: true, id: g.id, already: !!r.already, ...s });
  }
  return json({ error: 'not found' }, 404);
}
