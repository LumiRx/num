/**
 * PAYING FOR A MEMBERSHIP WITH STARS.
 *
 * ── The ask (7 Sep 2026) ──────────────────────────────────────────────────
 *
 * "We want to add an upgrade and you get our memberships, and you can purchase
 * it with the Stars."
 *
 * Until now the only door into Num Plus or Num Pro was a Stripe card. That is
 * a door a lot of people cannot walk through — travellers without a card the
 * app accepts, members who were paid in Stars for running an errand, anyone
 * who was given Stars by a friend. Every one of them was told "upgrade" and
 * then asked for a card.
 *
 * ── The three rules this file exists to enforce ───────────────────────────
 *
 * 1. PAYING WITH STARS IS NEVER CHEAPER THAN PAYING WITH CASH.
 *
 *    A Star has a real cash price: our own packs sell them from ★5,000 for
 *    $1,425, which is 28.5 cents each. If a $8.98 month cost ★29, that month
 *    would cost $8.27 to anyone who bought the big pack — a quiet 8% discount
 *    for choosing the slower rail, which is exactly backwards.
 *
 *    So the Star price is derived from the CHEAPEST cents-per-Star we sell,
 *    rounded UP. Plus is ★32 ($9.12 at the best rate). Pro is ★102 ($29.07).
 *    Change the packs and the membership price moves with them, on its own,
 *    because it is computed rather than typed.
 *
 * 2. THE WELCOME GRANT CANNOT BUY A MEMBERSHIP.
 *
 *    Every new member is handed ★100 the moment they sign up, before anything
 *    is verified. At ★32 a month that grant is three free months of Plus per
 *    signup, and to anyone with a script it is unlimited free months. This is
 *    not a hypothetical: it is the same shape as the $1-for-★5,000 bug, with
 *    the client replaced by a sign-up form.
 *
 *    So spendable is computed from ORIGIN, exactly the way cashout.mjs
 *    computes what may be turned into money. Everything that is not the
 *    welcome grant can buy a membership; the welcome grant spends on the
 *    things it was meant for and stops at the till.
 *
 * 3. A MEMBER WITH A LIVE CARD SUBSCRIPTION CANNOT ALSO PAY IN STARS.
 *
 *    Stripe would keep charging the card while the Star months ran, and the
 *    member would be paying twice for the same thing without a single screen
 *    ever saying so. Refused, with the fix in the refusal.
 *
 * ── What Stars buy: months, not a subscription ────────────────────────────
 *
 * Stars buy a fixed number of months that simply end. Nothing recurs, nothing
 * auto-renews, no card is stored. That is friendlier, and it is also the only
 * shape that stays clear of B&P §17550.27(b)(3) — see the note at the top of
 * membership.mjs about why the paid tiers may not carry travel benefits.
 *
 * Buying more months while months remain EXTENDS them (grantTier `extend`),
 * because losing paid-for days by topping up early is the kind of small theft
 * people never forgive.
 */
import { STAR_PACKS } from './preflight.mjs';
import { tiers, tierOf, grantTier } from './membership.mjs';

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * Star credits that may NOT be spent on a membership.
 *
 * One entry, and it is the promotional grant. Purchased Stars are the member's
 * own money and spend inside Num, which is what a membership is. Earned Stars
 * (bounty, referral, reward) are ours to give and cost us less here than they
 * would at the cashout desk. The welcome grant is the only credit that was
 * created out of nothing at sign-up.
 */
export const PROMO_KINDS = Object.freeze(['welcome']);

/** The cheapest cents-per-Star we sell. The floor under every Star price. */
export function bestStarRate(packs = STAR_PACKS) {
  const rates = Object.entries(packs ?? {})
    .map(([stars, cents]) => Number(cents) / Number(stars))
    .filter((r) => Number.isFinite(r) && r > 0);
  return rates.length ? Math.min(...rates) : null;
}

/**
 * What a price in cents costs in Stars. Rounded UP, always — rounding down is
 * how a discount sneaks in through arithmetic.
 */
export function starPrice(priceCents, packs = STAR_PACKS) {
  const rate = bestStarRate(packs);
  const cents = Number(priceCents);
  if (!rate || !Number.isFinite(cents) || cents <= 0) return null;
  return Math.ceil(cents / rate);
}

/** The Star price list, one entry per paid tier. Server-owned, like the packs. */
export function starTiers(env) {
  const all = tiers(env);
  return Object.entries(all)
    .filter(([, t]) => Number(t.price_cents) > 0)
    .map(([id, t]) => ({
      id,
      name: t.name,
      price_cents: t.price_cents,
      stars_per_month: starPrice(t.price_cents),
      blurb: t.blurb,
    }));
}

/**
 * How many of this member's Stars may go towards a membership.
 *
 * Same shape as cashout.mjs `cashable()`: net the moves whose origin qualifies,
 * then cap by the balance actually on hand. Netting is what makes it safe —
 * a membership purchase writes a negative move of its own, so a second purchase
 * sees the first one without any separate bookkeeping.
 */
export async function spendable(env, memberId) {
  if (!memberId || !env?.DB) return { balance: 0, spendable: 0, promo_locked: 0 };
  const marks = PROMO_KINDS.map((_, i) => `?${i + 2}`).join(',');
  const bal = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1')
    .bind(memberId).first().catch(() => null);
  const own = await env.DB.prepare(
    `SELECT COALESCE(SUM(delta),0) n FROM num_star_moves WHERE member_id=?1 AND kind NOT IN (${marks})`,
  ).bind(memberId, ...PROMO_KINDS).first().catch(() => ({ n: 0 }));

  const balance = Math.max(0, Number(bal?.stars ?? 0));
  const ownNet = Math.max(0, Number(own?.n ?? 0));
  const usable = Math.max(0, Math.min(balance, ownNet));
  return { balance, spendable: usable, promo_locked: balance - usable };
}

/**
 * What this member would pay, and whether they can — asked BEFORE anything is
 * debited, so the app can show a real number instead of a button that fails.
 */
export async function quote(env, { memberId, tier, months = 1 }) {
  const t = tiers(env)[tier];
  if (!t || Number(t.price_cents) <= 0) return { ok: false, error: 'Which plan?' };
  const n = Math.floor(Number(months));
  if (!Number.isFinite(n) || n < 1 || n > 12) return { ok: false, error: 'Between one and twelve months.' };

  const per = starPrice(t.price_cents);
  const cost = per * n;
  const wallet = await spendable(env, memberId);
  const short = Math.max(0, cost - wallet.spendable);

  return {
    ok: true,
    tier,
    name: t.name,
    months: n,
    stars_per_month: per,
    stars: cost,
    cash_equivalent_cents: t.price_cents * n,
    balance: wallet.balance,
    spendable: wallet.spendable,
    promo_locked: wallet.promo_locked,
    affordable: short === 0,
    short,
    // Said out loud rather than discovered at the till.
    note: wallet.promo_locked > 0
      ? `★${wallet.promo_locked.toLocaleString()} of your balance is the welcome gift — that one spends on plans, tabs and errands rather than on a membership.`
      : null,
  };
}

/**
 * Buy months of a tier with Stars.
 *
 * The debit is a CONDITIONAL update the way social.mjs `pay()` is, so a double
 * tap on a bad connection cannot charge twice, and `idem` makes a retried
 * request a no-op rather than a second month.
 *
 * If the grant fails after the debit the Stars go straight back. Money-shaped
 * code has to be able to lose gracefully; a member charged for a membership
 * they did not receive is the one failure that is never worth the risk.
 */
export async function buyWithStars(env, { memberId, tier, months = 1, idem = null }) {
  const me = clip(memberId, 40);
  const plan = clip(tier, 20);
  if (!me || !env?.DB) return { ok: false, error: 'Who is upgrading?' };

  const member = await env.DB.prepare('SELECT id FROM num_members WHERE id=?1').bind(me).first().catch(() => null);
  if (!member) return { ok: false, error: 'no such member', status: 404 };

  const q = await quote(env, { memberId: me, tier: plan, months });
  if (!q.ok) return { ...q, status: 400 };

  // Rule 3. Refused with the fix in the refusal, not just the refusal.
  const cur = await env.DB.prepare('SELECT stripe_sub FROM num_memberships WHERE member_id=?1')
    .bind(me).first().catch(() => null);
  if (cur?.stripe_sub) {
    return {
      ok: false,
      status: 409,
      error: 'Your card subscription is still running, so paying in Stars now would charge you twice for the same months. Cancel the card plan first — it stays active until the end of the month you already paid for — then come back and pay in Stars.',
    };
  }

  if (!q.affordable) {
    return {
      ok: false,
      status: 402,
      error: `${q.name} for ${q.months} month${q.months === 1 ? '' : 's'} is ★${q.stars.toLocaleString()} and you have ★${q.spendable.toLocaleString()} to spend.`,
      short: q.short,
      quote: q,
    };
  }

  const key = clip(idem, 80) || crypto.randomUUID();
  const moveId = `${key}:membership`;

  const seen = await env.DB.prepare('SELECT id FROM num_star_moves WHERE id=?1').bind(moveId).first().catch(() => null);
  if (seen) {
    const t = await tierOf(env, me);
    return { ok: true, repeat: true, tier: t, stars: q.stars, note: 'Already done — you were not charged twice.' };
  }

  const debit = await env.DB.prepare(
    'UPDATE num_star_balances SET stars = stars - ?2 WHERE member_id = ?1 AND stars >= ?2',
  ).bind(me, q.stars).run();
  if ((debit?.meta?.changes ?? 0) !== 1) {
    return { ok: false, status: 402, error: 'Not enough Stars.', quote: q };
  }

  const refund = async () => {
    await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1')
      .bind(me, q.stars).run().catch(() => {});
  };

  // The race the balance check alone cannot see: two membership purchases in
  // flight at once, each affordable on its own, together spending more of the
  // member's own Stars than they have. The balance stayed positive because the
  // welcome grant absorbed the difference — which is exactly what rule 2 says
  // must not happen. Re-read after the debit and put it back if it did.
  const after = await spendable(env, me);
  if (after.spendable < 0 || after.balance < after.promo_locked) {
    await refund();
    return { ok: false, status: 409, error: 'Two upgrades arrived at once. Nothing was charged — try that again.' };
  }

  await env.DB.prepare(
    "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'membership',?4,NULL)",
  ).bind(moveId, me, -q.stars, `${q.name} — ${q.months} month${q.months === 1 ? '' : 's'}`).run().catch(() => {});

  const granted = await grantTier(env, me, plan, {
    source: 'stars',
    ref: moveId,
    months: q.months,
    extend: true,
  });

  if (!granted?.ok) {
    await refund();
    await env.DB.prepare('DELETE FROM num_star_moves WHERE id=?1').bind(moveId).run().catch(() => {});
    console.error(`[starmembership] grant failed after debit for ${me} — Stars returned`);
    return { ok: false, status: 503, error: 'Something went wrong setting up your membership, so your Stars are back where they were. Try again in a moment.' };
  }

  const wallet = await spendable(env, me);
  return {
    ok: true,
    tier: plan,
    name: q.name,
    months: q.months,
    stars: q.stars,
    renews_at: granted.renews_at,
    balance: wallet.balance,
    auto_renews: false,
    note: `You're on ${q.name} until ${granted.renews_at?.slice(0, 10)}. Nothing renews on its own — top up with Stars whenever you like.`,
  };
}
