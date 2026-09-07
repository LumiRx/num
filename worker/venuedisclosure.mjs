/**
 * Venues that have to say something about themselves before a guest arrives.
 *
 * ── THE SITUATION ────────────────────────────────────────────────────────
 *
 * 7 Sep 2026: Aroyo signed up — a clothing-optional resort. Dre: "since theyre
 * clothing optional we need to make sure its within the interest of the user
 * first."
 *
 * Nothing in NUM could express that. A place is a row in `places` with a
 * category and a rating; the concierge ranks it and reads out the name. The
 * one nearby idea, `delivery.mjs`'s age gate, is the wrong shape here — it is
 * "never volunteer, only when the guest asks", which is right for a licensed
 * cannabis retailer and too blunt for a resort. A clothing-optional resort IS
 * a good answer to "where should we stay near the hot springs". It is a
 * terrible answer if the guest finds out when they walk in.
 *
 * ── SO THE RULE IS NOT SILENCE, IT IS DISCLOSURE ─────────────────────────
 *
 * The venue may be suggested for the things it genuinely is. What it may never
 * do is arrive undescribed. The disclosure leads — first sentence, before the
 * praise, before the price — so a guest who does not want it can skip it in
 * two words and a guest who does want it has found exactly what they were
 * after.
 *
 * That order is the whole design. "Aroyo is a beautiful hillside resort with
 * cedar tubs and, by the way, it is clothing optional" is a sentence that
 * wastes somebody's time and then surprises them. "Aroyo is clothing optional
 * — a hillside resort with cedar tubs" is the same fact doing its job.
 *
 * ── WHAT IT REFUSES ──────────────────────────────────────────────────────
 *
 *   1. An unverified guest. Identity-verified 18+ only, using the same member
 *      check `delivery.mjs` already runs for age-restricted partners. NUM
 *      knowing somebody's age is what makes this a gate rather than a hope.
 *   2. A family ask. "Somewhere for us and the kids" must never return this,
 *      whatever the ranking says and however well it matches on category.
 *      A disclosure read out first does not repair that suggestion; it should
 *      not be made.
 *   3. Inventing the disclosure. It is only ever what the BUSINESS put on
 *      their own profile. Nothing here infers "clothing optional" from a
 *      category, a name, or a description, because a venue wrongly labelled
 *      this way is a libel and a venue wrongly labelled the other way is a
 *      guest walking into a surprise.
 */

/**
 * The catalogue.
 *
 * `lead` is the exact words the concierge must open with. It is written as the
 * venue would write it about itself — plain, unembarrassed, not a warning
 * label. A guest reading "clothing optional" learns what they need; a guest
 * reading "ADULT CONTENT WARNING" learns what we think of the venue.
 */
export const DISCLOSURES = Object.freeze({
  clothing_optional: {
    id: 'clothing_optional',
    lead: 'clothing optional',
    age_min: 18,
    verified_only: true,
    why: 'A guest has to know before they book, not when they arrive.',
  },
  adults_only: {
    id: 'adults_only',
    lead: 'adults only',
    age_min: 18,
    verified_only: false,
    why: 'Turning up with children to a venue that will not admit them ruins a day.',
  },
  members_only: {
    id: 'members_only',
    lead: 'members only',
    age_min: 0,
    verified_only: false,
    why: 'A guest who cannot get in should learn that here rather than at the door.',
  },
  twentyone_plus: {
    id: 'twentyone_plus',
    lead: '21 and over',
    age_min: 21,
    verified_only: true,
    why: 'Licensed premises where ID is checked at the door.',
  },
});

/** Whatever the business put on their profile, filtered to things we know. */
export function disclosuresOf(customFields) {
  let f = customFields;
  if (typeof f === 'string') { try { f = JSON.parse(f); } catch { return []; } }
  const raw = Array.isArray(f?.disclosures) ? f.disclosures : [];
  return raw.map((d) => DISCLOSURES[String(d)]).filter(Boolean);
}

/** The strictest age any of a venue's disclosures demands. */
export const ageFloor = (list) => (list ?? []).reduce((n, d) => Math.max(n, d.age_min || 0), 0);

/** True when at least one disclosure insists NUM has actually checked who this is. */
export const needsVerified = (list) => (list ?? []).some((d) => d.verified_only);

/**
 * Asks that must never return one of these, whatever else matches.
 *
 * Deliberately broad and deliberately about the PEOPLE, not the activity: it
 * is the presence of a child in the party that settles it, and no amount of
 * disclosure makes that suggestion appropriate. False positives here cost a
 * suggestion. A false negative costs a family a holiday.
 */
const FAMILY = /\b(kid|kids|child|children|toddler|baby|babies|infant|son|daughter|grandkid|grandchild|family[- ]friendly|my family|the family|nephew|niece|school run|stroller|pram)\b/i;

export const familyAsk = (text) => FAMILY.test(String(text ?? ''));

/**
 * Which of these venues this guest may be shown.
 *
 * Fails CLOSED on every branch: no member record, no verification, an unknown
 * age — all of them mean no. A gate that opens when it is unsure is not a gate.
 */
export function allowedFor(venues, { member, userText = '' } = {}) {
  if (familyAsk(userText)) return [];
  return (venues ?? []).filter((v) => {
    const list = v.disclosures ?? [];
    if (!list.length) return true;
    if (needsVerified(list) && !member?.identity_verified) return false;
    return ageFloor(list) === 0 || !!member?.identity_verified;
  });
}

/**
 * The paragraph the brain reads.
 *
 * It says WHERE the words go, not merely that they matter. "Mention that it is
 * clothing optional" produces a mention in the last sentence; the whole point
 * is the first one.
 */
export function disclosureBlock(venues) {
  const withAny = (venues ?? []).filter((v) => (v.disclosures ?? []).length);
  if (!withAny.length) return '';
  const lines = ['VENUE DISCLOSURES (facts these places have told us about themselves):'];
  for (const v of withAny) {
    lines.push(`- ${v.name}: ${v.disclosures.map((d) => d.lead).join(', ')}`);
  }
  lines.push(
    'Rule: when you suggest one of these places, the disclosure is the FIRST thing you say about it '
    + '— before the description, before why it is good, before the price. Write it the way the venue '
    + 'writes it, as a plain fact and not a warning. "Aroyo is clothing optional — a hillside resort '
    + 'with cedar tubs" is right; "Aroyo is a hillside resort with cedar tubs, and it is also clothing '
    + 'optional" is wrong, because by then the guest has already pictured their holiday. '
    + 'Never leave it out to make a suggestion land better.',
  );
  return lines.join('\n');
}

/**
 * Read what businesses have declared, for the places already in front of the
 * model. Never widens the result set — this only annotates rows that some
 * other, ordinary piece of ranking already chose.
 */
export async function annotate(env, rows) {
  if (!env?.DB || !rows?.length) return rows ?? [];
  const ids = rows.map((r) => r.id).filter(Boolean).slice(0, 40);
  if (!ids.length) return rows;
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  let found = new Map();
  try {
    const { results } = await env.DB.prepare(
      `SELECT p.place_id, p.custom_fields
         FROM num_business_profiles p
        WHERE p.place_id IN (${marks})`,
    ).bind(...ids).all();
    found = new Map((results ?? []).map((r) => [r.place_id, disclosuresOf(r.custom_fields)]));
  } catch (e) {
    // A read that fails must not silently strip a disclosure off a venue that
    // has one. Everything is withheld instead: no annotation, and the caller's
    // gate sees venues it cannot clear.
    console.warn('[disclosure] read failed', e?.message ?? e);
    return rows.map((r) => ({ ...r, disclosures: [], disclosures_unknown: true }));
  }
  return rows.map((r) => ({ ...r, disclosures: found.get(r.id) ?? [] }));
}
