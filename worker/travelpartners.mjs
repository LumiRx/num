// The agencies Num hands travel to — configuration, never a hardcoded company.
//
// ── WHY THIS FILE IS SEPARATE FROM travelreferral.mjs ────────────────────
//
// LetsGo2Trip is a row, not the schema. The first deal may not close; the
// second one certainly will not be with the same company. If the agency's
// address, commission or product list lived inside the referral module, every
// new agency would be a code change, a review and a deploy — which is exactly
// how a partnerships team ends up waiting on engineering to say yes to money.
//
// So: partners arrive as JSON in one secret, `TRAVEL_PARTNERS`, and adding one
// is `wrangler secret put TRAVEL_PARTNERS`. No deploy, no build, no PR.
//
//   [
//     {
//       "id": "letsgo2trip",
//       "name": "LetsGo2Trip",
//       "email": "bookings@example.com",
//       "products": ["flight", "hotel", "package", "transfer"],
//       "dests": ["*"],
//       "commission_bp": { "flight": 300, "hotel": 1000, "package": 1200 },
//       "priority": 10,
//       "active": true
//     }
//   ]
//
// ── THE ROUTING RULE, STATED ONCE ────────────────────────────────────────
//
//   1. An explicit `partner_id` wins, if that partner is active and serves the
//      product. A concierge or an operator who names the agency has a reason.
//   2. Otherwise: every ACTIVE partner that serves this product AND this
//      destination is a candidate.
//   3. Candidates sort by SPECIFICITY first — an agency that names the
//      destination beats one carrying the `*` wildcard — then by `priority`
//      (higher first), then by id so the order is stable and testable.
//   4. No candidate is not an error and not a guess. It returns null and the
//      caller tells the member honestly that there is nobody to hand this to.
//      Routing a Bali package to an agency that only does Gulf flights, because
//      it was the only row, is worse than saying nothing.
//
// Specificity-before-priority is deliberate: it is what lets a generalist sit
// in the config as a catch-all (`"dests": ["*"]`) without stealing the
// destinations a specialist was added for.

/** A partner row that survived validation, with defaults filled in. */
const clean = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim().toLowerCase();
  const email = String(raw.email ?? '').trim();
  // An agency with no id or no address cannot be handed anything. Dropped, not
  // repaired: a partner row we half-understood is how a real traveller's
  // request goes to nobody and is discovered a week later.
  if (!id || !email.includes('@')) return null;
  return Object.freeze({
    id,
    name: String(raw.name ?? id),
    email,
    // Where the partner prefers to be reached outside email — a shared-inbox
    // note, a WhatsApp number. Display only; Num sends nothing to it.
    whatsapp: raw.whatsapp ? String(raw.whatsapp) : null,
    contact: raw.contact ? String(raw.contact) : null,
    products: Array.isArray(raw.products) && raw.products.length
      ? raw.products.map((p) => String(p).toLowerCase())
      : ['*'],
    dests: Array.isArray(raw.dests) && raw.dests.length
      ? raw.dests.map((d) => String(d).toLowerCase().trim())
      : ['*'],
    commission_bp: raw.commission_bp && typeof raw.commission_bp === 'object' ? raw.commission_bp : {},
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0,
    // Absent means active. A partner you have to remember to switch ON is a
    // partner that silently receives nothing on the day you add them.
    active: raw.active !== false,
    // The one place a partner's own SLA is written down, so the runbook and
    // the concierge say the same number.
    sla_hours: Number.isFinite(Number(raw.sla_hours)) ? Number(raw.sla_hours) : 24,
    // ── THE DEEP-LINK TEMPLATE ─────────────────────────────────────────
    //
    // Absent for every partner that works the way the first one did: an email
    // arrives, a human quotes it, Num presents the quote. Present for a
    // partner that runs its own checkout and wants the traveller sent
    // straight into it — LetsGo2Trip's term 1, "a parameterized deep-link to
    // the checkout stepper".
    //
    // A TEMPLATE and not a URL, because the parameters are theirs and we do
    // not get to guess them. Placeholders are `{from}`, `{to}`, `{depart}`,
    // `{ret}`, `{adults}`, `{city}`, `{checkin}`, `{checkout}` — anything
    // unfilled is dropped rather than left as literal braces in somebody's
    // browser. HTTPS only: a deep link over plain http leaks the itinerary
    // and the handoff reference in clear text.
    checkout_url:
      typeof raw.checkout_url === 'string' && /^https:\/\//.test(raw.checkout_url)
        ? raw.checkout_url.slice(0, 500)
        : null,
  });
};

/**
 * Fill a partner's checkout template and attach nothing else.
 *
 * Deliberately NOT where the handoff reference is added — worker/handoff.mjs
 * mints and appends that, because minting writes a row and this function must
 * stay synchronous and side-effect free. Two responsibilities, two places.
 *
 * @returns the filled URL, or null when the partner has no template.
 */
export function checkoutLink(partner, ctx = {}) {
  const tpl = partner?.checkout_url;
  if (!tpl) return null;
  const filled = tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = ctx[k];
    return v == null || v === '' ? '' : encodeURIComponent(String(v).slice(0, 80));
  });
  // A placeholder nobody filled leaves an empty parameter behind. Harmless to
  // most parsers and ugly in a URL a traveller can see, so drop them.
  try {
    const u = new URL(filled);
    for (const [k, v] of [...u.searchParams]) if (v === '') u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Every configured partner, valid ones only.
 *
 * Never throws. Malformed JSON in a secret must not take the whole travel path
 * down — it degrades to "no partner configured", which the caller already
 * handles honestly, rather than to a 500 on a member's request.
 */
export function partners(env) {
  const raw = env?.TRAVEL_PARTNERS;
  if (!raw) return [];
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[travelpartners] TRAVEL_PARTNERS is not valid JSON —', e?.message ?? e);
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(clean).filter(Boolean);
}

export const partnerById = (env, id) =>
  partners(env).find((p) => p.id === String(id ?? '').trim().toLowerCase()) ?? null;

/** `*` matches anything; otherwise a case-insensitive exact or prefix match. */
const serves = (list, value) => {
  if (list.includes('*')) return true;
  const v = String(value ?? '').toLowerCase().trim();
  if (!v) return false;
  return list.some((entry) => entry === v || v.startsWith(`${entry}/`) || v.endsWith(`, ${entry}`));
};

/** 2 when the partner names this destination, 1 when it carries the wildcard. */
const specificity = (p, dest) => (p.dests.includes('*') ? 1 : serves(p.dests, dest) ? 2 : 0);

/**
 * Which agency this request goes to — or null, honestly.
 *
 * @returns {object|null} the frozen partner row, ready to be copied onto the
 *   referral. The CALLER copies it; nothing downstream re-reads this config for
 *   a referral that has already been sent.
 */
export function routeFor(env, { product = 'flight', dest = null, partner_id = null } = {}) {
  const all = partners(env);
  if (!all.length) return null;
  const prod = String(product ?? '').toLowerCase();

  if (partner_id) {
    const named = all.find((p) => p.id === String(partner_id).toLowerCase());
    // A named partner that is switched off or does not sell this product is a
    // MISS, not a fallback. Silently routing to somebody else would send a
    // traveller's details to a company the operator did not choose.
    return named && named.active && serves(named.products, prod) ? named : null;
  }

  const candidates = all
    .filter((p) => p.active && serves(p.products, prod) && specificity(p, dest) > 0)
    .sort((a, b) =>
      specificity(b, dest) - specificity(a, dest)
      || b.priority - a.priority
      || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

/**
 * The commission Num expects from this partner on this product, in basis
 * points, or null.
 *
 * Null is a real answer and means "not agreed yet" — the referral still goes,
 * and the ledger records an expectation of nothing rather than a number
 * somebody invented. A made-up rate becomes an invoice, and an invoice nobody
 * agreed to is how a first partnership ends.
 */
export function commissionBp(partner, product) {
  if (!partner?.commission_bp) return null;
  const table = partner.commission_bp;
  const n = Number(table[String(product ?? '').toLowerCase()] ?? table.default ?? table['*']);
  return Number.isFinite(n) && n > 0 && n <= 5000 ? Math.round(n) : null;
}

/** Whether any agency is configured at all — surfaced on /api/version. */
export const travelPartnersConfigured = (env) => partners(env).length > 0;
