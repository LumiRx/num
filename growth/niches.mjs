/**
 * What an ambassador is FOR, and the rotation of things a milestone can be.
 *
 * Dre, 19 Sep 2026: "sign up for you niche and get offers directly for your
 * specialty" — and a rotation of giveaways rather than one prize repeated.
 *
 * ── WHY A NICHE IS WORTH MORE THAN A FOLLOWER COUNT ──────────────────────
 *
 * A business looking for somebody to talk about a restaurant does not want
 * the biggest account on the list, it wants somebody whose audience came for
 * food. The reach figure is self-declared and unverified (see
 * ambassador.mjs); the niche is the field that actually makes a match good,
 * and it costs a person four taps to fill in.
 *
 * It also fixes the offers tab. An ambassador who opens it and finds nine
 * things that have nothing to do with them stops opening it, and the tenth
 * offer — the one that was for them — is never seen.
 */

/** The vocabulary. Mirrors the CHECK-free niches_json column in 0055, bound
 *  to it by a test so a niche cannot exist on one side only. Kept short on
 *  purpose: twenty options is a form nobody finishes, and a niche that
 *  matches three people is not a segment. */
export const NICHES = Object.freeze([
  { key: 'food', label: 'Food and restaurants' },
  { key: 'nightlife', label: 'Nightlife and bars' },
  { key: 'luxury', label: 'Luxury travel' },
  { key: 'budget', label: 'Budget and backpacking' },
  { key: 'family', label: 'Family travel' },
  { key: 'adventure', label: 'Adventure and outdoors' },
  { key: 'wellness', label: 'Wellness and spa' },
  { key: 'fashion', label: 'Fashion and style' },
  { key: 'beauty', label: 'Beauty and make-up' },
  { key: 'business', label: 'Business travel' },
  { key: 'culture', label: 'Culture, art and museums' },
  { key: 'nomad', label: 'Remote work and long stays' },
]);

export const NICHE_KEYS = Object.freeze(NICHES.map((n) => n.key));

/** Parse a stored niches_json into a clean list of known keys. */
export function readNiches(json) {
  try {
    const v = JSON.parse(json || '[]');
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map(String).filter((k) => NICHE_KEYS.includes(k)))].slice(0, 6);
  } catch { return []; }
}

/** Normalise whatever a form sent into something storable.
 *
 *  Six is the cap. Somebody who ticks every box is not a specialist and an
 *  "everything" ambassador matches every offer, which makes the whole field
 *  useless for the businesses it exists to serve. */
export function cleanNiches(input) {
  const arr = Array.isArray(input) ? input : [];
  return [...new Set(arr.map(String).filter((k) => NICHE_KEYS.includes(k)))].slice(0, 6);
}

/** How well an offer fits this ambassador.
 *
 *  An offer with NO niches is for everybody and scores neutral rather than
 *  zero — otherwise the general offers sink below every targeted one and the
 *  first ambassador with a niche never sees the open ones again. */
export function offerFit(offerNiches, mine) {
  const o = readNiches(offerNiches);
  if (!o.length) return 1;
  const m = Array.isArray(mine) ? mine : [];
  const hits = o.filter((k) => m.includes(k)).length;
  return hits ? 2 + hits : 0;
}

/* ══ THE ROTATION ═══════════════════════════════════════════════════════
 *
 * Dre, 19 Sep 2026, asked for a rotation rather than one prize repeated: "a
 * private lift in a black car, stars, flights, rooms, clothing, make up,
 * cannabis, sign up for you niche and get offers directly for your
 * specialty."
 *
 * ── WHAT IS IN HERE, AND THE ONE THING THAT IS NOT ──────────────────────
 *
 * Cannabis is not in this pool and cannot be added to it, for reasons that
 * are specific rather than squeamish:
 *
 *   · NUM ships in the Apple App Store and Google Play. Apple's Guideline
 *     1.4.3 prohibits apps that facilitate the illegal use of controlled
 *     substances; a promotion inside the app offering cannabis as a prize
 *     puts the listing at risk, and the listing is the product.
 *   · NUM takes payment through Stripe, whose restricted-business list
 *     covers cannabis. That is an account-termination risk, not a warning.
 *   · The draw this rotation sits beside runs in the United States and the
 *     United Kingdom, 18+, per growth/fridayrules.mjs. Cannabis is a
 *     federally controlled substance in the US and supply is a criminal
 *     offence in the UK. Shipping one as a prize is not a policy question.
 *
 * `beauty` and `wellness` are in the pool and cover a lot of the same
 * audience honestly. If Dre wants to pursue a cannabis-adjacent partnership
 * it is a licensed-operator, single-jurisdiction conversation with a lawyer,
 * not a row in this array.
 *
 * ── AND WHY EACH ROW CARRIES ITS OWN SOURCING TRUTH ─────────────────────
 *
 * `ready` means NUM can hand this over today without asking anybody.
 * `needs` names exactly what is missing for the rest. Rotating a prize NUM
 * cannot actually source is how a milestone becomes an apology.
 */
export const REWARD_POOL = Object.freeze([
  {
    key: 'stars', label: 'Stars', ready: true,
    blurb: 'Credit in their NUM wallet, cashable like any other earning.',
    needs: null,
  },
  {
    key: 'membership', label: 'A membership tier', ready: true,
    blurb: 'A paid tier, granted for a stretch. Costs NUM nothing but margin.',
    needs: null,
  },
  {
    key: 'niche_offer', label: 'An offer in their own niche', ready: true,
    blurb: 'Something matched to what they actually post about. Costs whoever posts the offer, not NUM.',
    needs: null,
  },
  {
    key: 'car', label: 'A private lift in a black car', ready: false,
    blurb: 'A driver to the airport, or a night out, on NUM.',
    needs: 'A VIP host with a car listed, or a one-off booked by hand. num_assets holds zero listable rows.',
  },
  {
    key: 'room', label: 'A room', ready: false,
    blurb: 'A night or two somewhere good.',
    needs: 'The stays partner setting, or a room booked by hand.',
  },
  {
    key: 'flight', label: 'A flight', ready: false,
    blurb: 'Somewhere they have been meaning to go.',
    needs: 'LGT_PARTNER_ID, or a fare bought by hand.',
  },
  {
    key: 'clothing', label: 'Clothing', ready: false,
    blurb: 'Something to wear, from a brand worth naming.',
    needs: 'An actual brand partnership. There is no evidence of one on file.',
  },
  {
    key: 'beauty', label: 'Make-up and beauty', ready: false,
    blurb: 'A set from a brand.',
    needs: 'An actual brand partnership. There is no evidence of one on file.',
  },
]);

/** What NUM could hand over today, without asking anybody. */
export const readyRewards = () => REWARD_POOL.filter((r) => r.ready);

/**
 * Which reward category a given milestone rotates to.
 *
 * DETERMINISTIC, not random: the same ambassador at the same rung always gets
 * the same suggestion, so two people comparing notes see a consistent story
 * and a page refresh does not change what NUM is "thinking of". It is a
 * SUGGESTION to whoever works the milestone queue, never a promise shown to
 * the ambassador — see MYSTERY_LINE in milestones.mjs.
 *
 * Rotating over the ready list only. Suggesting a flight NUM cannot book is
 * how the queue fills up with things nobody actions.
 */
export function rotateReward(ambassadorId, tier) {
  const pool = readyRewards();
  if (!pool.length) return null;
  const s = String(ambassadorId || '') + ':' + String(tier || 0);
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return pool[(h >>> 0) % pool.length];
}
