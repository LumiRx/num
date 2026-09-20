/**
 * NUM · the offer Num never made.
 *
 * ── THE NUMBER THAT STARTED THIS ─────────────────────────────────────────
 *
 * 16 Sep 2026, counted in production: **152 members, 0 subscriptions.**
 * `num_memberships` is empty.
 *
 * Not because the machinery is missing. All of it is built and tested: three
 * tiers with real entitlements (membership.mjs), a Stripe subscription with
 * recurrence Stripe owns, a webhook that grants on invoice.paid and lapses on
 * cancel, and a price guard added after somebody paid fifty cents for a $28.98
 * membership. `/api/membership/subscribe` works today.
 *
 * The gap is that **nothing ever asks.** `prompt.mjs` contained zero mentions
 * of tier, upgrade, Plus, Pro or subscription — so the concierge doing all the
 * talking did not know the plans existed and could not have offered one if a
 * guest asked for it directly. Same shape as the partner id it was told to
 * copy and never shown: complete code wired to nothing.
 *
 * ── WHY THE TIMING RULES ARE THE PRODUCT ─────────────────────────────────
 *
 * A concierge that pitches is not a concierge. The fastest way to destroy the
 * thing Num is selling — "the most helpful, most trusted, keeps every secret"
 * — is to make every answer carry a sales line, and it is the single most
 * likely outcome of handing a model a price list with no rules.
 *
 * So the offer is bound to MOMENTS, not to turns:
 *
 *   · a LIMIT actually reached — they tried a 4th plan on a 3-plan tier. This
 *     is the honest one: they wanted something and the tier stopped them. It
 *     converts because it is true, not because it is persuasive.
 *   · a WIN just landed — a table booked, a trip saved. Offered ONCE, as the
 *     next thing rather than a reward for being pleased.
 *   · they ASKED — about price, about Plus, about what they get.
 *
 * And never: in the first exchange, on a bad day, in an emergency, or twice in
 * one conversation. `EARNED` and `NEVER` below are the whole design; the copy
 * is the easy half.
 */

/** Machine-readable reasons an offer is allowed. The app sends the signals. */
export const EARNED = Object.freeze({
  limit: 'They hit a real limit on their current plan just now.',
  win: 'Something just went right — a booking landed, a plan came together.',
  asked: 'They asked about price, plans, or what an upgrade includes.',
});

/**
 * When Num must stay quiet, whatever else is true.
 *
 * These are refusals, not preferences. A guest whose flight was cancelled is
 * not a sales opportunity, and a product that treats them as one is not the
 * best friend it claims to be.
 */
export const NEVER = Object.freeze([
  'in the first exchange of a conversation — earn it first',
  'more than once in a conversation, even if they hit two limits',
  'when the guest is stressed, lost, ill, delayed, or dealing with anything going wrong',
  'in any emergency, medical, safety or money-trouble conversation',
  'as the whole reply — it is one line after a real answer, never instead of one',
  'to a guest already on the highest tier',
]);

/**
 * Did the guest raise money themselves?
 *
 * Detected HERE rather than trusted from the client, for two reasons: the
 * server sees the actual words, and "asked" is the one signal that must never
 * be missed — a guest asking "how much is Plus?" and getting nothing is worse
 * than any missed upsell.
 *
 * Deliberately narrow. "How much is dinner", "what does the taxi cost" and
 * "any cheap places" are about the CITY, not about Num, and a concierge that
 * answers a restaurant-price question with a subscription pitch is the exact
 * failure this whole module is built to avoid. So the pattern requires a word
 * that can only be about us.
 */
const ABOUT_US = /\b(num ?plus|num ?pro|subscription|subscribe|upgrade|premium|membership|paid plan|free plan|what do i get|how much is num|what does num cost)\b/i;

export function askedAboutPlans(text) {
  return ABOUT_US.test(String(text ?? ''));
}

const money = (cents) => {
  const n = Number(cents ?? 0) / 100;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
};

/**
 * What one tier gives that another does not, in the guest's terms.
 *
 * Reads the entitlements rather than restating them in prose, so a price or a
 * limit changed in MEMBERSHIP_TIERS (which moves without a deploy) can never
 * leave this saying something the server will not honour. Copy that disagrees
 * with the server is how people end up feeling misled.
 */
export function gains(from, to) {
  const a = from?.entitlements ?? {};
  const b = to?.entitlements ?? {};
  const out = [];
  const say = (v) => (v === null ? 'unlimited' : String(v));

  if (a.plans_max !== b.plans_max) {
    out.push(b.plans_max === null
      ? 'unlimited plans running at once, instead of ' + say(a.plans_max)
      : `${say(b.plans_max)} plans at once, up from ${say(a.plans_max)}`);
  }
  if (a.deep_research_monthly !== b.deep_research_monthly) {
    out.push(b.deep_research_monthly === null
      ? 'deep research with no monthly cap'
      : `${say(b.deep_research_monthly)} deep-research runs a month, up from ${say(a.deep_research_monthly)}`);
  }
  if (!a.early_features && b.early_features) out.push('new features before anyone else');
  return out;
}

/**
 * The block the model reads. Null when there is nothing honest to offer.
 *
 * Returning null rather than an empty block matters: an "offer" section that
 * is present but says "not now" invites the model to negotiate with it.
 */
export function upgradeBlock({ tier = 'free', table = {}, used = {}, earned = null } = {}) {
  const current = table[tier];
  if (!current) return null;

  // Highest tier already. There is no honest offer, so there is no block.
  const ladder = Object.entries(table)
    .filter(([, t]) => Number(t?.price_cents ?? 0) > Number(current.price_cents ?? 0))
    .sort((x, y) => Number(x[1].price_cents) - Number(y[1].price_cents));
  if (!ladder.length) return null;

  const [nextId, next] = ladder[0];
  const adds = gains(current, next);
  if (!adds.length) return null;

  const L = [];
  L.push(`THIS GUEST IS ON ${String(current.name ?? tier).toUpperCase()}${current.price_cents ? ` (${money(current.price_cents)}/month)` : ' (free)'}.`);

  const usedBits = Object.entries(used ?? {})
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  if (usedBits.length) L.push(`Used this month — ${usedBits.join(', ')}.`);

  L.push('');
  L.push(`${String(next.name ?? nextId)} is ${money(next.price_cents)} a month and adds:`);
  for (const a of adds) L.push(`  · ${a}`);
  L.push('');
  L.push('To offer it, emit an `upgrade` action with tier "' + nextId + '". That opens a checkout '
    + 'sheet the guest taps — it charges nothing by itself, so never say they have upgraded, only '
    + 'that it is there if they want it.');
  L.push('');

  if (earned && EARNED[earned]) {
    L.push(`YOU MAY OFFER IT THIS TURN. ${EARNED[earned]}`);
    L.push('ONE line, AFTER you have fully answered what they asked. Name the single thing that '
      + 'changes for THEM — the limit they just hit, the thing they were trying to do — not the '
      + 'feature list. Then drop it. If they do not take it, it does not come up again.');
  } else {
    L.push('DO NOT OFFER IT THIS TURN. Nothing has earned it, and an unprompted pitch costs more '
      + 'trust than a subscription is worth. Answer what they asked and say nothing about plans. '
      + 'If they ask about price or plans themselves, answer straight and warmly — that is always '
      + 'allowed.');
  }
  L.push('');
  L.push('NEVER offer: ' + NEVER.join('; ') + '.');
  L.push('The concierge, plans, friends and live fare search are free forever and stay free. '
    + 'Paying raises limits, depth and speed — never unlocks travel. Never imply otherwise.');

  return L.join('\n');
}

/**
 * Everything a turn needs, read from the live tier table and the member's row.
 *
 * Never throws: an upsell that takes a concierge answer down with it is a bad
 * trade in every direction.
 */
/**
 * AT MOST ONE INVITATION A DAY, PER MEMBER.
 *
 * The offer engine already refuses to pitch twice in a conversation. That is
 * not the same as twice in a day: two conversations on one afternoon are two
 * separate pitches to the same person, and the second one is the one that
 * makes somebody stop opening the app.
 *
 * The cap covers the PROACTIVE reasons only — `win` and `limit`. A guest who
 * asks the price themselves is answered every single time; refusing to quote a
 * price to somebody who asked is not restraint, it is rudeness, and it is the
 * one behaviour guaranteed to lose a sale that was already half made.
 *
 * Written to num_usage_counters with period = the DATE rather than the month.
 * `period` is free text and the primary key is (member_id, period, key), so a
 * daily row needs no migration and expires by simply never being read again.
 *
 * Marked when the offer is PERMITTED rather than when the model actually makes
 * it. That over-counts slightly on a turn where the model chooses to stay
 * quiet, and that is the correct direction to be wrong in: the failure it
 * prevents (two pitches in a day) is worse than the one it causes (one missed
 * pitch).
 */
const today = () => new Date().toISOString().slice(0, 10);
const CAPPED = new Set(['win', 'limit']);

export async function offeredToday(env, memberId) {
  try {
    const row = await env.DB.prepare(
      'SELECT used FROM num_usage_counters WHERE member_id=?1 AND period=?2 AND key=?3',
    ).bind(memberId, today(), 'upgrade_offer').first();
    return Number(row?.used ?? 0) > 0;
  } catch {
    // An unreadable counter must not silence a legitimate offer, and must not
    // fail an answer either. Fail OPEN here: the worst case is one extra
    // invitation, not a broken reply.
    return false;
  }
}

export async function markOfferedToday(env, memberId) {
  try {
    await env.DB.prepare(
      `INSERT INTO num_usage_counters (member_id, period, key, used) VALUES (?1,?2,?3,1)
         ON CONFLICT(member_id, period, key) DO UPDATE SET used = used + 1`,
    ).bind(memberId, today(), 'upgrade_offer').run();
  } catch { /* bookkeeping must never break the reply */ }
}

export async function upgradeFor(env, memberId, { earned = null } = {}) {
  if (!env?.DB || !memberId) return null;
  try {
    const { tiers, tierOf } = await import('./membership.mjs');
    const table = tiers(env);
    const tier = await tierOf(env, memberId);
    let used = {};
    try {
      const { results } = await env.DB.prepare(
        'SELECT key, used FROM num_usage_counters WHERE member_id=?1 AND period=?2',
      ).bind(memberId, new Date().toISOString().slice(0, 7)).all();
      used = Object.fromEntries((results ?? []).map((r) => [r.key, r.used]));
    } catch { /* counters are colour, never a blocker */ }
    // The day's cap, applied to the proactive reasons only.
    let allow = earned;
    if (allow && CAPPED.has(allow) && await offeredToday(env, memberId)) allow = null;
    const block = upgradeBlock({ tier, table, used, earned: allow });
    // Spend the day's one invitation only when the block actually grants it.
    if (allow && CAPPED.has(allow) && block) await markOfferedToday(env, memberId);
    return block;
  } catch (e) {
    console.warn('[upgrade]', e?.message ?? e);
    return null;
  }
}
