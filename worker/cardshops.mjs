/**
 * Finding somewhere to buy trading cards.
 *
 * Added 12 Sep 2026 alongside the Friday pack draw. A giveaway that hands
 * somebody a card pack and cannot tell them where to buy another is a gimmick;
 * one attached to a real capability is a product.
 *
 * ── WHY THIS IS A CLASSIFIER AND NOT A `LIKE '%card%'` ───────────────────
 *
 * The obvious query is the wrong one, and it is wrong in an embarrassing
 * direction. Run against our own 2.69M places, matching "cards" in a name
 * returns, in order of frequency: greeting-card shops. Also found:
 *
 *   · "Cards4ever"          — a BRIDAL SHOP in Edinburgh
 *   · "Cards Galore"        — a greeting-card chain, ten branches in London
 *   · "TCG Uluçalireis"     — a TURKISH NAVAL VESSEL in Istanbul. TCG there is
 *                             Türkiye Cumhuriyeti Gemisi, not Trading Card Game
 *   · "Pokemon's Beer Bar"  — a bar in Pattaya
 *   · "Big C Graphics Wedding Cards" — exactly what it says
 *
 * Sending a member to a bridal shop for booster packs is a worse answer than
 * "I don't know", because it costs them a journey and it costs us the belief
 * that Num checks anything. So the name signal is only ever read TOGETHER with
 * the category, an explicit exclusion list runs first, and the result carries
 * how confident we are instead of pretending.
 *
 * Measured against production on 12 Sep 2026:
 *   196 certain · 2,319 likely · 113 name-only · 79 correctly excluded
 *
 * ── WHAT WE CANNOT KNOW, AND THEREFORE DO NOT CLAIM ──────────────────────
 *
 * Dre asked for "where they do the drops". Set RELEASE DATES are public and
 * knowable. Which shop runs a Friday-night prerelease, holds a midnight queue
 * or gets an allocation is NOT in any dataset we have, and cannot be derived
 * from one — it lives in each shop's own head. Inventing it would be the same
 * failure as the bridal shop, one step further from anything checkable.
 *
 * So `drops` is not a field here. The honest version is to ask the shops, the
 * way we ask venues everything else, and record what they answer. Until then
 * Num says what it knows: this shop sells cards, here are its hours.
 */

/** Categories that genuinely sell trading cards, from our own Overture data. */
export const CARD_CATEGORIES = Object.freeze([
  'Hobby Shop',          // 1,876 — the reliable one
  'Comic Books Store',   //   624 — almost all carry singles and packs
  'Tabletop Games',      //    17 — small, and exactly right
]);

/**
 * Categories that stock cards SOMETIMES. Kept separate on purpose: a general
 * toy shop may have a spinner rack or nothing at all, and a member sent to one
 * expecting a card counter has been misled by a confident-sounding answer.
 */
export const MAYBE_CATEGORIES = Object.freeze(['Toy Store', 'Games', 'Anime']);

/** Name fragments that mean trading cards. */
const NAME_YES = [
  'pokemon', 'pokémon', 'tcg', 'trading card', 'card game', 'collectib',
  'comic', 'games workshop', 'magic the gathering', 'yugioh', 'yu-gi-oh',
];

/**
 * Name fragments and categories that mean something else entirely.
 *
 * Checked FIRST and unconditionally. Every one of these is a real false
 * positive from production, not a hypothetical.
 */
const NAME_NO = [
  'greeting', 'wedding', 'bridal', 'stationer', 'gift', 'souvenir',
  'birthday card', 'sim card', 'business card', 'credit card', 'beer bar',
];
const CATEGORY_NO = [
  'Bar', 'Café', 'Restaurant', 'Attraction', 'Bridal Shop', 'Souvenirs & gifts',
  'Supermarket', 'Convenience', 'Cards And Stationery Store', 'Retail',
];

const lower = (v) => String(v ?? '').toLowerCase();
const has = (hay, needles) => needles.some((n) => hay.includes(n));

/**
 * How sure are we that this place sells trading cards?
 *
 * @returns {'certain'|'likely'|'maybe'|null} null means do not offer it at all.
 */
export function cardConfidence(place = {}) {
  const name = lower(place.name);
  const category = String(place.category ?? '');
  if (!name) return null;

  // FIRST, AND WITHOUT EXCEPTION. A place called "Pokemon's Beer Bar" matches
  // the strongest name signal we have and is a bar.
  if (has(name, NAME_NO)) return null;
  if (CATEGORY_NO.includes(category)) return null;

  const goodCat = CARD_CATEGORIES.includes(category);
  const maybeCat = MAYBE_CATEGORIES.includes(category);
  const goodName = has(name, NAME_YES);

  if (goodCat && goodName) return 'certain';
  if (goodCat) return 'likely';
  // A name-only hit outside a known-good category is the weakest evidence we
  // act on, and only because "Bath TCG" filed under the wrong category is a
  // real shop we would otherwise lose.
  if (goodName && maybeCat) return 'likely';
  if (goodName) return 'maybe';
  if (maybeCat) return null;   // a toy shop with no card signal is just a toy shop
  return null;
}

/** Is this worth showing at all? */
export const sellsCards = (place) => cardConfidence(place) !== null;

/**
 * What Num should actually SAY about it.
 *
 * The confidence is not decoration — it changes the sentence, because "they
 * sell cards" and "they might sell cards" send a member on two different
 * journeys and only one of them can be wrong without it being our fault.
 */
export function cardLine(place = {}) {
  const c = cardConfidence(place);
  if (!c) return null;
  const name = String(place.name ?? '').trim();
  if (c === 'certain') return `${name} — a card shop.`;
  if (c === 'likely') return `${name} — a hobby and comic shop, so cards are very likely.`;
  return `${name} — worth a call first; it may or may not carry cards.`;
}

/**
 * The SQL Num uses to find them near a member.
 *
 * Exported as a string rather than run here so the same predicate is testable
 * and cannot drift from the classifier above — the two are asserted equivalent
 * in cardshops.test.mjs, which is the only thing stopping the query and the
 * code disagreeing about what a card shop is.
 */
export const CARD_SQL_CATEGORIES = Object.freeze([...CARD_CATEGORIES, ...MAYBE_CATEGORIES]);

/**
 * Set release dates are knowable; shop drop nights are not.
 *
 * Deliberately a stub that returns nothing rather than a guess. See the header:
 * the day this returns invented data is the day the feature is worth less than
 * not having it.
 */
export function dropInfo() {
  return { known: false, why: 'Num does not have per-shop release-night data. Ask the shop.' };
}
