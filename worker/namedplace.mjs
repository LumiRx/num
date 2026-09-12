/**
 * WHEN THE GUEST NAMES A BUSINESS.
 *
 * Dre, 11 Sep 2026: "we have la cannabis club thats signed up when i requested
 * a drop form it eariler it said it can not connect me to a club. it didnt
 * under stand that was the business name."
 *
 * ── THE HOLE ─────────────────────────────────────────────────────────────
 *
 * Retrieval was CATEGORY-ONLY. `nearbyPlaces()` calls `detectCat(text)`, picks
 * a SQL pattern for that category, and returns the best rows nearby. There was
 * no path anywhere in grounding for "the guest said a name" — no `name LIKE`,
 * no lookup, nothing. Confirmed by grepping the whole retrieval layer.
 *
 * So "set up a delivery with LA Cannabis Club" put ZERO rows about LA Cannabis
 * Club in front of the model, even though the place is in the directory
 * (p_76f0caad…, category "Cannabis Delivery", Los Angeles, with coordinates
 * and a phone number) and the business is signed up and active. With nothing
 * verified in the block, the model fell back to its own general knowledge and
 * refused — which is how a signed-up partner got turned away by its own
 * concierge, and why the refusal said something untrue about what Num allows.
 *
 * The same hole breaks "book me a table at Bestia" and every other sentence
 * where the guest already knows where they want to go. It is not a cannabis
 * problem; that is just where it surfaced.
 *
 * ── WHY PARTNERS ARE MATCHED FIRST ───────────────────────────────────────
 *
 * A business that claimed its listing has told us it exists, proven a phone
 * number, and in many cases pays us. If a guest says its name, it must be the
 * row we look at first — never a same-named row from open data. That ordering
 * is a promise to the businesses that sign up, not an optimisation.
 */

/** Words that are never a business name on their own. */
const STOP = new Set([
  'the', 'a', 'an', 'at', 'in', 'on', 'to', 'for', 'with', 'from', 'and', 'or',
  'me', 'my', 'we', 'us', 'our', 'you', 'your', 'i', 'is', 'are', 'be', 'get',
  'can', 'could', 'would', 'please', 'want', 'need', 'like', 'set', 'up', 'book',
  'order', 'delivery', 'deliver', 'table', 'tonight', 'today', 'tomorrow', 'now',
  'some', 'any', 'good', 'best', 'near', 'nearby', 'place', 'places', 'club',
]);

/**
 * Normalise for comparison: lowercase, letters and digits only.
 *
 * Apostrophes are DELETED rather than turned into spaces, and that detail
 * matters more than it looks. Splitting on them turns "Gjelina's" into
 * "gjelina s" — a stray one-letter token, and a name that no longer matches a
 * guest who typed "Gjelinas" without the apostrophe, which is how most people
 * type it on a phone. Deleting gives "gjelinas" on both sides.
 * Covers the curly apostrophe too: iOS substitutes it automatically.
 */
export const norm = (s) =>
  String(s ?? '').toLowerCase().replace(/['’ʼ`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The meaningful words of a name or a sentence. */
export const words = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w));

/**
 * How strongly a place name appears in what the guest said.
 *
 * Not a fuzzy score: the whole name has to be present. "LA Cannabis Club"
 * against "set up a delivery with la cannabis club" matches because every
 * meaningful word of the name (`cannabis`) — plus the full normalised name as
 * a phrase — is in the sentence. Requiring the phrase is what stops "club"
 * alone, or a one-word overlap, from dragging in an unrelated venue: a
 * confident wrong place is worse than no place.
 */
export function nameHit(placeName, text) {
  const n = norm(placeName);
  const t = norm(text);
  if (!n || !t) return 0;
  // The whole name, as written, inside the sentence. Strongest signal there is.
  if (n.length >= 4 && t.includes(n)) return 2;
  const nw = words(placeName);
  // A single meaningful word is not a name. "Bestia" is; "club" is not, which
  // is why it is a stop word.
  if (nw.length < 2) return 0;
  const tw = new Set(words(text));
  return nw.every((w) => tw.has(w)) ? 1 : 0;
}

/**
 * Places the guest appears to have named, best first.
 *
 * Partners (a claimed, unrevoked listing) are searched first and always rank
 * above directory rows. Both queries are scoped to the destination and capped,
 * so this adds one small indexed read to a turn rather than a scan of 2.6m
 * rows.
 */
export async function namedPlaces(env, { dest, text, limit = 2 }) {
  if (!env?.DB || !dest || !text) return [];
  const t = norm(text);
  if (t.length < 3) return [];
  const cols = 'id, name, category, area, phone, website, address, lat, lng, hours_mask, booking_platform, booking_ref, business_id';

  const seen = new Set();
  const out = [];
  const consider = (rows, partner) => {
    for (const r of rows ?? []) {
      if (seen.has(r.id)) continue;
      const hit = nameHit(r.name, text);
      if (!hit) continue;
      seen.add(r.id);
      out.push({ ...r, _named: true, _partner: partner, _hit: hit });
    }
  };

  // 1. Claimed listings in this destination. A small set, and the one that
  //    matters most — see the note at the top of this file.
  const partners = await env.DB.prepare(
    `SELECT ${cols} FROM places
      WHERE dest = ?1 AND business_id IS NOT NULL AND (alive IS NULL OR alive = 1)
      LIMIT 200`,
  ).bind(dest).all().catch(() => ({ results: [] }));
  consider(partners.results, true);

  // 2. The open directory, only if the partners did not answer it. Bounded by
  //    destination and by LIMIT: this must never become a scan.
  if (out.length < limit) {
    const first = words(text)[0] ?? '';
    if (first.length >= 3) {
      const rows = await env.DB.prepare(
        `SELECT ${cols} FROM places
          WHERE dest = ?1 AND (alive IS NULL OR alive = 1) AND name LIKE ?2
          LIMIT 60`,
      ).bind(dest, `%${first}%`).all().catch(() => ({ results: [] }));
      consider(rows.results, false);
    }
  }

  // Partner first, then the stronger match, then the longer name — a longer
  // name that still matched is the more specific one.
  out.sort((a, b) =>
    (b._partner - a._partner) || (b._hit - a._hit) || (String(b.name).length - String(a.name).length));
  return out.slice(0, Math.max(1, limit));
}
