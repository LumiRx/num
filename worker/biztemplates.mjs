/**
 * WHAT A BUSINESS IS ASKED FOR, BY WHAT IT ACTUALLY SELLS.
 *
 * ── WHY (6 Sep 2026) ──────────────────────────────────────────────────────
 *
 * "What you offer" asks every business on Num the same four questions: name,
 * description, section, price. That form is right for a café and wrong for
 * everyone else, and being wrong is expensive in a specific way — a business
 * that cannot see itself in the form fills in two items and leaves, and a
 * listing with two items answers no traveller's question.
 *
 * A dispensary prices by the eighth and must show a licence. A spa sells 60
 * and 90 minutes, not "items". A hotel sells nights. A tour sells seats per
 * person and needs a meeting point. A venue sells tables with a minimum spend.
 * Same database row underneath — `num_business_offerings` is unchanged — but
 * the words, the units, the sections and the examples come from here.
 *
 * ── WHAT A TEMPLATE IS NOT ────────────────────────────────────────────────
 *
 * It is not a rule. Nothing here refuses an entry, and `sections` are
 * SUGGESTIONS a business can ignore or replace. A template that fights a
 * business about its own menu is worse than no template: the business is the
 * authority on what it sells, and our job is to make the first ten minutes
 * feel like somebody had already thought about their trade.
 *
 * ── HOW A BUSINESS GETS ONE ───────────────────────────────────────────────
 *
 * `templateFor(category)` reads the free-text category the business already
 * gave us ("Cannabis Delivery", "Thai restaurant", "day spa") and matches on
 * whole words, longest and most specific first. No match is not a failure —
 * `general` is a real template and a perfectly good form.
 */

/** The one an unrecognised trade gets. Deliberately plain, never empty. */
const GENERAL = Object.freeze({
  id: 'general',
  label: 'What you offer',
  noun: 'item',
  unit: 'item',
  sections: Object.freeze(['Most popular', 'Everything else']),
  example: 'A thing you sell, as you would say it to a guest',
  price_hint: 'Leave empty if it varies',
  delivery: false,
  licence: false,
});

/**
 * `match` is checked as whole words against the business's own category text.
 * Order matters: the FIRST template whose words match wins, so the specific
 * trades sit above the general ones — "cannabis delivery" must not be caught
 * by "delivery", and "hotel spa" should read as a spa only if hotel misses.
 */
export const TEMPLATES = Object.freeze([
  {
    id: 'cannabis',
    label: 'Your menu',
    noun: 'product',
    unit: 'item',
    match: ['cannabis', 'dispensary', 'weed', 'marijuana', 'cannabis delivery'],
    sections: Object.freeze(['Flower', 'Pre-rolls', 'Edibles', 'Vapes', 'Concentrates', 'Topicals', 'Accessories']),
    example: 'Eighth — Blue Dream',
    price_hint: 'Per unit, as it rings up at the register',
    // The only template that turns these on by default: it is a delivery
    // trade, and it is the one where a missing licence is not a blank field
    // but a legal problem. worker/delivery.mjs enforces both.
    delivery: true,
    licence: true,
    licence_label: 'State retail / delivery licence number',
    age_min: 21,
    note: 'Guests only ever see this where your licence is valid, and only if they are ID-verified in Num.',
  },
  {
    id: 'restaurant',
    label: 'Your menu',
    noun: 'dish',
    unit: 'item',
    match: ['restaurant', 'bistro', 'eatery', 'diner', 'trattoria', 'izakaya', 'steakhouse', 'kitchen', 'grill'],
    sections: Object.freeze(['Starters', 'Mains', 'Sides', 'Desserts', 'Drinks', 'Set menu']),
    example: 'Green curry with jasmine rice',
    price_hint: 'What a guest pays for one',
    delivery: true,
    licence: false,
  },
  {
    id: 'cafe',
    label: 'Your menu',
    noun: 'item',
    unit: 'item',
    match: ['cafe', 'café', 'coffee', 'bakery', 'patisserie', 'juice', 'tea house'],
    sections: Object.freeze(['Coffee', 'Tea', 'Pastries', 'Breakfast', 'Lunch']),
    example: 'Flat white',
    price_hint: 'Single serving',
    delivery: true,
    licence: false,
  },
  {
    id: 'bar',
    label: 'What you serve, and your tables',
    noun: 'offering',
    unit: 'group',
    match: ['bar', 'club', 'nightclub', 'lounge', 'pub', 'speakeasy', 'rooftop'],
    sections: Object.freeze(['Cocktails', 'Bottles', 'Tables & minimums', 'Entry', 'Food']),
    example: 'Booth for 6 — minimum spend',
    price_hint: 'Minimum spend, or price per bottle',
    delivery: false,
    licence: false,
    note: 'A table with a minimum spend belongs here — it is the thing a group asks Num for by name.',
  },
  {
    id: 'spa',
    label: 'Your treatments',
    noun: 'treatment',
    unit: 'session',
    match: ['spa', 'massage', 'wellness', 'salon', 'barber', 'nails', 'clinic', 'sauna', 'onsen'],
    sections: Object.freeze(['Massage', 'Facials', 'Body', 'Hair', 'Nails', 'Packages']),
    example: '60-minute Thai massage',
    price_hint: 'Per session — say the length in the name',
    delivery: false,
    licence: false,
  },
  {
    id: 'stay',
    label: 'Your rooms',
    noun: 'room',
    unit: 'night',
    match: ['hotel', 'hostel', 'resort', 'guesthouse', 'villa', 'apartment', 'riad', 'lodge', 'inn'],
    sections: Object.freeze(['Rooms', 'Suites', 'Extras']),
    example: 'Deluxe double, garden view',
    price_hint: 'Per night, the rate a walk-in would be quoted',
    delivery: false,
    licence: false,
  },
  {
    id: 'tour',
    label: 'Your tours and experiences',
    noun: 'experience',
    unit: 'person',
    match: ['tour', 'tours', 'excursion', 'activity', 'diving', 'sailing', 'cooking class', 'guide', 'rental', 'charter'],
    sections: Object.freeze(['Half day', 'Full day', 'Private', 'Equipment']),
    example: 'Sunset sail, 3 hours',
    price_hint: 'Per person unless you say otherwise',
    delivery: false,
    licence: false,
    note: 'Say where you meet in the description — it is the first thing a guest asks.',
  },
  {
    id: 'shop',
    label: 'What you stock',
    noun: 'product',
    unit: 'item',
    match: ['shop', 'store', 'boutique', 'market', 'grocery', 'pharmacy', 'florist', 'retail'],
    sections: Object.freeze(['Best sellers', 'New in', 'Gifts']),
    example: 'Hand-woven throw',
    price_hint: 'Shelf price',
    delivery: true,
    licence: false,
  },
]);

const BY_ID = new Map([...TEMPLATES, GENERAL].map((t) => [t.id, t]));

/** Whole-word match, so "bar" never matches "barbecue" or "Barcelona". */
const hits = (words, text) => words.some((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(text));

/**
 * The template for a business, from the category it already told us.
 * Never null — an unrecognised trade gets `general`, which is a real form.
 */
export function templateFor(category) {
  const text = String(category ?? '').toLowerCase().trim();
  if (!text) return GENERAL;
  // MOST SIGNALS WINS, THEN DECLARATION ORDER.
  //
  // The first version of this sorted by the longest matching word, which read
  // "Boutique Hotel" as a shop: `boutique` is longer than `hotel`. Word length
  // is not evidence of anything. What actually resolves an ambiguous name is
  // which trade the word belongs to more strongly, and the honest way to
  // encode that is the order these templates are declared in — a list a person
  // can read, argue with and reorder, rather than a number that looks
  // objective and is not.
  const scored = TEMPLATES
    .map((t, i) => ({ t, i, n: t.match.filter((w) => hits([w], text)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i);
  return scored.length ? scored[0].t : GENERAL;
}

/** By id, for a business that has chosen one explicitly. */
export const templateById = (id) => BY_ID.get(String(id ?? '').toLowerCase()) ?? GENERAL;

/** Every template a business could pick from, for a dropdown. */
export const templateChoices = () => [...TEMPLATES, GENERAL].map((t) => ({ id: t.id, label: t.label, noun: t.noun }));

export { GENERAL };
