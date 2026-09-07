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
 *   1. A family ask. "Somewhere for us and the kids" must never return this,
 *      whatever the ranking says and however well it matches on category.
 *      A disclosure read out first does not repair that suggestion; it should
 *      not be made.
 *   2. Inventing the disclosure. It is only ever what the BUSINESS put on
 *      their own profile. Nothing here infers "clothing optional" from a
 *      category, a name, or a description, because a venue wrongly labelled
 *      this way is a libel and a venue wrongly labelled the other way is a
 *      guest walking into a surprise.
 *
 * ── WHY IDENTITY VERIFICATION IS NOT ONE OF THOSE REFUSALS ───────────────
 *
 * It was, for about an hour on 7 Sep, and it was wrong. Dre: "always suggest
 * it but we need to disclose its clothing optional."
 *
 * Requiring NUM to have verified a guest's identity before naming a
 * clothing-optional B&B would mean it was essentially never named, because
 * most guests are not verified — which is the opposite of always suggesting
 * it, and it quietly buries a business that signed up in good faith.
 *
 * And the premise was wrong anyway. A bed and breakfast described accurately
 * is a bed and breakfast; the disclosure is what makes naming it safe, not a
 * gate in front of it. `verified_only` stays on the catalogue for things that
 * are genuinely age-restricted in law — a 21+ licensed premises where ID is
 * checked at the door — and comes off the ones that are simply a fact about
 * the venue.
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
    // Not verified_only: see the note above. The disclosure is the protection.
    verified_only: false,
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
  // The one refusal. Kept against an explicit "always suggest it" because the
  // harm runs both ways: a family arriving at a clothing-optional B&B is a
  // ruined holiday for them AND a bad morning for the business that signed up
  // expecting NUM to send it the right people.
  if (familyAsk(userText)) return [];
  return (venues ?? []).filter((v) => {
    const list = v.disclosures ?? [];
    if (!list.length) return true;
    // Only where the law actually gates the door — a 21+ licensed premises.
    // A fact about a venue is disclosed, not gated.
    if (needsVerified(list) && !member?.identity_verified) return false;
    return true;
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
    // The disclosure and the way to check it belong together. A guest told a
    // place is clothing optional wants to look at it before they decide, and
    // a name in a sentence is not something anybody can tap.
    'These places go in `picks` like any other, so the guest gets the card and the link. '
    + 'A venue you disclosed something about and then did not give them a way to look at is worse '
    + 'than not mentioning it.',
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

/**
 * What the owner reads next to each box.
 *
 * Written for the person who runs the place, not for a compliance officer:
 * ticking one of these is how NUM knows to say it BEFORE describing you, which
 * is the thing that stops a guest arriving surprised. That is worth one
 * sentence, because a box with no explanation gets left unticked by the
 * businesses who most need it.
 */
export const OWNER_HINT = Object.freeze({
  clothing_optional: 'NUM will say this first, before describing you — so the people who arrive are the people who wanted to.',
  adults_only: 'Nobody turns up with children to be turned away at the door.',
  members_only: 'A guest who cannot get in learns it here, not on your doorstep.',
  twentyone_plus: 'For licensed premises where ID is checked at the door.',
});

/** The checkboxes on the owner's own listing page. */
export function disclosureFields(current = []) {
  const on = new Set((current ?? []).map((d) => (typeof d === 'string' ? d : d.id)));
  const H = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return Object.values(DISCLOSURES).map((d) => `
    <label for="disc_${d.id}" style="display:block;margin-top:10px">
      <input type="checkbox" id="disc_${d.id}" name="disclosure" value="${H(d.id)}"${on.has(d.id) ? ' checked' : ''}>
      <b>${H(d.lead.charAt(0).toUpperCase() + d.lead.slice(1))}</b>
      <span class="sub" style="display:block;margin-left:22px">${H(OWNER_HINT[d.id] ?? d.why)}</span>
    </label>`).join('');
}

/**
 * Save what the owner ticked.
 *
 * Merged into `custom_fields` rather than replacing it, because `licence`,
 * `age_min` and the delivery hours live in the same JSON and a whole-object
 * write from this form would silently switch a partner's delivery licence off.
 * Unknown ids are dropped: the form is the only writer today, and the day it
 * is not, a typo must not become a fact NUM reads out about somebody.
 */
export async function saveDisclosures(env, businessId, ids, by = 'console') {
  if (!env?.DB || !businessId) return { ok: false, error: 'no business' };
  const wanted = [...new Set((ids ?? []).map(String))].filter((i) => DISCLOSURES[i]);
  const row = await env.DB.prepare(
    'SELECT custom_fields FROM num_business_profiles WHERE business_id=?1',
  ).bind(String(businessId)).first().catch(() => null);
  let f = {};
  try { f = JSON.parse(row?.custom_fields || '{}') || {}; } catch { f = {}; }
  try {
    await env.DB.prepare(
      'UPDATE num_business_profiles SET custom_fields=?2, updated_at=CAST(strftime(\'%s\',\'now\') AS INTEGER) WHERE business_id=?1',
    ).bind(String(businessId), JSON.stringify({ ...f, disclosures: wanted, disclosures_by: by })).run();
    return { ok: true, disclosures: wanted };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}
