/**
 * The business you own, in the app you already signed into.
 *
 * ── THE GAP ──────────────────────────────────────────────────────────────
 *
 * Delivery orders reach a partner through the WEB business console, which is
 * authenticated by a `numbiz_` key. That is right for a laptop behind a
 * counter and wrong for the person this was built for: Alfredo at LA Cannabis
 * Club, who will be holding a phone and driving.
 *
 * Dre, 7 Sep: "when they sign into the app with their phone number they get
 * the requests for their business in their app."
 *
 * Today he signs in, becomes an ordinary member, and sees nothing. His own
 * orders are three taps away in a browser he has to find a key for.
 *
 * ── THE AUTHORISATION, AND WHY IT IS SOUND ───────────────────────────────
 *
 * This hands one person another party's live orders — names, addresses, money.
 * It gets exactly one rule and the rule is a coincidence of two proofs:
 *
 *   1. `num_members.phone_verified = 1` — this member received a one-time code
 *      at this number and typed it back. They control the handset.
 *   2. `num_place_owners.phone` — the listing was claimed by someone who
 *      received a one-time code AT THAT SAME PUBLISHED NUMBER. That is the
 *      whole anti-hijack property of claiming (bizapi.mjs): the code goes to
 *      the contact already published on the listing, never to one the claimant
 *      supplies.
 *
 * Both are OTP proofs of control of the same E.164 number, so matching them is
 * not weaker than either. It is the same test, run twice.
 *
 * ── WHAT IS DELIBERATELY NOT MATCHED ─────────────────────────────────────
 *
 * `num_business_profiles.phone_e164` is NOT used, and that omission is the
 * important line in this file. That column is derived from the listing's
 * PUBLISHED number — which is public, printed on the door, and on the website.
 * Matching it would mean: verify any phone that happens to equal a business's
 * public number and you are shown its orders. For most venues those two
 * numbers are the same string, so the difference only shows up as a hole.
 *
 * An unverified member matches nothing, ever, whatever their profile says.
 */

const clip = (v, n = 64) => (v == null ? null : String(v).slice(0, n));

/**
 * E.164, or null. Deliberately strict: a loose comparison here is an
 * authorisation bug, and "+1 818 667 6918" must not be treated as a different
 * person from "+18186676918" while "8186676918" must not silently match a
 * different country's number.
 */
export function e164(raw) {
  const s = String(raw ?? '').replace(/[^\d+]/g, '');
  if (!s.startsWith('+')) return null;
  const d = s.slice(1).replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}

/**
 * Which businesses this member has proved they run.
 *
 * Returns [] for anyone unverified, anyone with no phone, and anyone whose
 * number claimed nothing. [] is the safe answer to every uncertainty here.
 */
export async function businessesForMember(env, memberId) {
  if (!env?.DB || !memberId) return [];

  const me = await env.DB.prepare(
    'SELECT id, phone, phone_verified FROM num_members WHERE id = ?1 LIMIT 1',
  ).bind(clip(memberId, 40)).first().catch(() => null);

  // The gate. An unverified phone is a string somebody typed.
  if (!me || !me.phone_verified) return [];
  const phone = e164(me.phone);
  if (!phone) return [];

  const { results } = await env.DB.prepare(
    `SELECT o.business_id, o.place_id, o.verified_at, b.name, p.name AS place_name, p.dest
       FROM num_place_owners o
       JOIN businesses b ON b.id = o.business_id AND b.status = 'active'
       LEFT JOIN places p ON p.id = o.place_id
      WHERE o.revoked_at IS NULL AND o.phone = ?1
      ORDER BY o.verified_at ASC`,
  ).bind(phone).all().catch(() => ({ results: [] }));

  return (results ?? []).map((r) => ({
    business_id: r.business_id,
    name: r.name ?? r.place_name ?? 'Your business',
    place_id: r.place_id ?? null,
    dest: r.dest ?? null,
    since: r.verified_at ?? null,
  }));
}

/**
 * Does this member run this business? The check every write goes through.
 *
 * Re-resolved from the database on every call rather than trusted from a
 * client-supplied business_id — an id in a request body is a wish, not a
 * permission.
 */
export async function ownsBusiness(env, memberId, businessId) {
  if (!businessId) return false;
  const mine = await businessesForMember(env, memberId);
  return mine.some((b) => String(b.business_id) === String(businessId));
}
