/**
 * Is this business actually able to operate on NUM — and if not, whose move is it?
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Every piece of a business's setup is already checked somewhere. `bizverify`
 * knows about the badge. `bizdash` knows about the pay QR. `biznotify` knows
 * whether anyone will be told about a booking. `claim/onboard.mjs` creates the
 * two rows that make an account chargeable. `bizapproval` knows whether a human
 * ever decided.
 *
 * Nothing joins them. So the one question that matters — "has this business got
 * everything it needs to operate?" — could not be asked of any table, any
 * endpoint, or any screen. Eight businesses were approved on 30 Aug and the
 * honest answer to that question for all eight was: nobody knows.
 *
 * This file is the join. It reads only; it changes nothing. It is the single
 * definition of "ready", so the ops console, the admin API and the per-business
 * agent all answer that question the same way or not at all.
 *
 * ── THE TWO RULES ─────────────────────────────────────────────────────────
 *
 * 1. EVERY ITEM NAMES WHOSE MOVE IT IS. A checklist that mixes "we have not
 *    emailed them" with "they have not filled in their hours" produces a list
 *    nobody can act on, because the two need opposite responses. `owner` is
 *    'num' or 'business' on every item, and the rollup counts them separately.
 *    What NUM owes a business is a debt; what a business has not done is a
 *    nudge. They are not the same and must never be added together.
 *
 * 2. NOTHING IS MARKED DONE THAT WAS NOT MEASURED. Same contract as
 *    bizdash.mjs. An item whose evidence table does not exist yet returns
 *    `unknown`, not `false` — because "we cannot see" and "it is not done" lead
 *    to different actions, and reporting the first as the second is how a
 *    business gets chased for something it already did.
 */

/** The item catalogue. Order is the order a business actually passes through. */
export const ITEMS = Object.freeze([
  // ── NUM's side of the deal ──
  { id: 'decided', label: 'A human decided on the claim', owner: 'num', required: true,
    why: 'Nothing else can start until somebody says yes.' },
  { id: 'account', label: 'Account built (profile + settings)', owner: 'num', required: true,
    why: 'Without these two rows a business is verified but inert — no commission rate, no timezone, no flags.' },
  { id: 'ownership', label: 'Listing ownership recorded', owner: 'num', required: true,
    why: 'This is what lets the owner edit their own listing and nobody else edit it.' },
  { id: 'welcomed', label: 'Told they are live, with the console link', owner: 'num', required: true,
    why: 'A business that was approved and never told is a business that thinks we ignored them.' },
  { id: 'agent', label: 'Their own NUM agent exists', owner: 'num', required: true,
    why: 'The agent is what keeps track of this business between conversations.' },
  // ── The business's side ──
  { id: 'contact', label: 'We can reach them', owner: 'business', required: true,
    why: 'An email or a dialable number. Without one, every message below is undeliverable.' },
  { id: 'hours', label: 'Opening hours published', owner: 'business', required: true,
    why: 'The single detail travellers act on. Wrong hours send a guest to a locked door.' },
  { id: 'phone', label: 'Public phone on the listing', owner: 'business', required: true,
    why: 'The booking desk texts this number. No number, no table held.' },
  { id: 'address', label: 'Address on the listing', owner: 'business', required: true,
    why: 'A traveller has to be able to walk to it.' },
  { id: 'notify', label: 'Somewhere to send booking alerts', owner: 'business', required: true,
    why: 'Otherwise a request arrives and nobody at the business ever learns of it.' },
  { id: 'description', label: 'Description travellers see', owner: 'business', required: false,
    why: 'Optional, but it is what the concierge reads out when someone asks what the place is like.' },
  { id: 'website', label: 'Website on the listing', owner: 'business', required: false,
    why: 'Optional. Also the fastest route to the owner-verified badge.' },
  // ── Switched on deliberately, by us, per business ──
  { id: 'verified_badge', label: 'Owner-verified badge earned', owner: 'business', required: false,
    why: 'Proof of control, earned by the owner. Not required to operate.' },
  { id: 'bookings', label: 'Booking desk switched on', owner: 'num', required: false,
    why: 'Off for everyone today — the desk returns 503 in production. Not a per-business failing.' },
  { id: 'pay_qr', label: 'Pay code issued', owner: 'num', required: false,
    why: 'A setup step, not a missing capability. Stripe is live; the QR is switched on per business.' },
]);

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

/** Present, non-empty, not a placeholder. Whitespace and '-' are not an address. */
const has = (v) => {
  const s = String(v ?? '').trim();
  return s.length > 0 && s !== '-' && s !== 'n/a' && s.toLowerCase() !== 'null';
};

/**
 * Read a table that may not exist yet.
 *
 * Several of these tables are created lazily on first use (num_business_notify
 * on the first preference save, num_paylinks on the first pay code). A missing
 * table means "nobody has ever done this", which is a real and reportable
 * state — but it is NOT the same as a failed read, so both come back as
 * `unknown` and the caller says so in words.
 */
async function maybe(env, sql, ...binds) {
  try {
    return await env.DB.prepare(sql).bind(...binds).first();
  } catch {
    return undefined; // undefined = could not look; null = looked, found nothing
  }
}

/**
 * The checklist for one business.
 *
 * Takes rows the caller has already read, so the roster can fetch them in bulk
 * and a single-business call can fetch them one at a time, without two
 * versions of the logic. Everything below is a pure decision over those rows.
 */
export function checklistFor({
  business, profile, settings, owner, place, decision, agent, notify, paylink, verification,
} = {}) {
  const state = {};
  const evidence = {};

  // ── NUM's side ──
  state.decided = decision === undefined ? 'unknown' : !!decision?.decision;
  evidence.decided = decision?.decision
    ? `${decision.decision} by ${decision.decided_by ?? 'unknown'}`
    : null;

  state.account = !!profile && !!settings;
  evidence.account = profile
    ? `${profile.vertical ?? 'unclassified'} · ${profile.commerce_status ?? 'pending'} · ${profile.timezone ?? 'Etc/UTC'}`
    : (business ? 'businesses row exists, profile/settings missing' : null);

  state.ownership = !!owner && !owner.revoked_at;
  evidence.ownership = owner
    ? `${owner.method ?? 'unknown method'} · ${owner.verified_at ?? 'undated'}${owner.revoked_at ? ' · REVOKED' : ''}`
    : null;

  state.welcomed = decision === undefined ? 'unknown' : !!decision?.onboarded;
  evidence.welcomed = decision?.onboarded ? 'welcome email delivered' : null;

  state.agent = !!(agent?.agent_id || profile?.owner_agent);
  evidence.agent = agent?.agent_id ?? profile?.owner_agent ?? null;

  // ── The business's side ──
  const email = profile?.email ?? business?.email ?? null;
  const e164 = profile?.phone_e164 ?? null;
  state.contact = has(email) || has(e164);
  evidence.contact = [has(email) ? 'email' : null, has(e164) ? 'phone' : null]
    .filter(Boolean).join(' + ') || null;

  state.hours = has(place?.hours);
  evidence.hours = has(place?.hours) ? String(place.hours).slice(0, 60) : null;

  state.phone = has(place?.phone);
  evidence.phone = has(place?.phone) ? 'on the listing' : null;

  state.address = has(place?.address);
  evidence.address = has(place?.address) ? String(place.address).slice(0, 60) : null;

  // Two independent ways a business can be told about a booking, and either
  // one counts: the notify preferences row, or the profile's own channel.
  if (notify === undefined && profile === undefined) state.notify = 'unknown';
  else {
    const viaPrefs = !!(notify && has(notify.email) && notify.on_booking);
    const viaProfile = !!(profile && profile.notify_channel && profile.notify_channel !== 'none'
      && has(profile.notify_address));
    state.notify = viaPrefs || viaProfile;
    evidence.notify = viaPrefs ? 'email alerts on' : (viaProfile ? `${profile.notify_channel}` : null);
  }

  state.description = has(place?.cuisine) || has(place?.description);
  state.website = has(place?.website) || has(profile?.website);
  evidence.website = has(place?.website) ? String(place.website).slice(0, 60) : null;

  state.verified_badge = verification === undefined ? 'unknown' : !!verification;
  evidence.verified_badge = verification?.method ? `by ${verification.method}` : null;

  state.bookings = !!settings?.f_bookings;
  state.pay_qr = paylink === undefined ? 'unknown' : !!paylink;
  evidence.pay_qr = paylink?.id ?? null;

  return ITEMS.map((item) => ({
    ...item,
    done: state[item.id] === true,
    unknown: state[item.id] === 'unknown',
    evidence: evidence[item.id] ?? null,
  }));
}

/**
 * The stage, derived from the checklist rather than stored.
 *
 * Stored stages drift: something changes the world and forgets to change the
 * column, and then the column is a claim about the past. This is recomputed on
 * every read, so it cannot be wrong about the row it was computed from.
 */
export function stageOf(checklist) {
  const done = (id) => checklist.find((c) => c.id === id)?.done === true;
  const listing = ['hours', 'phone', 'address'].every(done);
  if (!done('account')) return 'prospect';
  if (!done('welcomed')) return 'account_built';
  if (!listing) return 'welcomed';
  if (!done('notify')) return 'listing_ready';
  return 'operating';
}

export const STAGES = Object.freeze([
  { id: 'prospect', label: 'Signed up, no account yet' },
  { id: 'account_built', label: 'Account built, not told yet' },
  { id: 'welcomed', label: 'Told, listing incomplete' },
  { id: 'listing_ready', label: 'Listing complete, unreachable for bookings' },
  { id: 'operating', label: 'Operating' },
]);

/** What is outstanding, split by whose move it is. Required items only. */
export function outstanding(checklist) {
  const open = checklist.filter((c) => c.required && !c.done);
  return {
    ours: open.filter((c) => c.owner === 'num'),
    theirs: open.filter((c) => c.owner === 'business'),
    unknown: checklist.filter((c) => c.unknown).map((c) => c.id),
    optional_open: checklist.filter((c) => !c.required && !c.done && !c.unknown).map((c) => c.id),
  };
}

/**
 * One business, fully resolved.
 *
 * Six small indexed reads rather than one join across nine tables: three of
 * those tables are created lazily and a join would fail whole rather than
 * degrade to `unknown` on the one part that is missing.
 */
export async function readinessFor(env, businessId) {
  if (!env?.DB || !businessId) return null;
  const id = String(businessId);

  const business = await maybe(env, 'SELECT id, name, status, created_at FROM businesses WHERE id = ?1', id);
  if (!business) return null;

  const profile = await maybe(env,
    `SELECT business_id, vertical, commerce_status, country, city, timezone, place_id,
            phone_e164, email, website, notify_channel, notify_address, owner_agent, verified_at
       FROM num_business_profiles WHERE business_id = ?1`, id);
  const settings = await maybe(env,
    'SELECT business_id, f_bookings, commission_bp, updated_at FROM num_business_settings WHERE business_id = ?1', id);
  const owner = await maybe(env,
    `SELECT place_id, method, verified_at, revoked_at, claim_id
       FROM num_place_owners WHERE business_id = ?1 AND revoked_at IS NULL LIMIT 1`, id);

  const placeId = owner?.place_id ?? profile?.place_id ?? null;
  const place = placeId
    ? await maybe(env,
      `SELECT id, name, dest, area, address, phone, website, hours, cuisine, category, rating
         FROM places WHERE id = ?1`, placeId)
    : null;

  // The decision ledger is keyed on the growth-worker `claims` row, not on the
  // business — a business reached through the app or the self-serve console
  // has no claims row at all, and that is not a missing decision. Look it up
  // through the ownership record's claim_id where there is one.
  const decision = owner?.claim_id
    ? (await maybe(env,
      'SELECT decision, decided_by, onboarded, created_at FROM num_claim_decisions WHERE claim_id = ?1',
      String(owner.claim_id)) ?? null)
    : null;

  const agent = await maybe(env, 'SELECT agent_id, state FROM num_business_agents WHERE business_id = ?1', id);
  const notify = await maybe(env,
    'SELECT email, on_booking FROM num_business_notify WHERE business_id = ?1', id);
  const paylink = placeId
    ? await maybe(env, 'SELECT id FROM num_paylinks WHERE place_id = ?1 OR business_id = ?2 LIMIT 1', placeId, id)
    : undefined;
  const verification = placeId
    ? await maybe(env, 'SELECT method FROM num_business_verification WHERE place_id = ?1 LIMIT 1', placeId)
    : undefined;

  const checklist = checklistFor({
    business, profile, settings, owner, place, decision, agent, notify, paylink, verification,
  });

  return {
    business_id: id,
    name: business.name ?? place?.name ?? '(unnamed)',
    place_id: placeId,
    dest: place?.dest ?? profile?.city ?? null,
    vertical: profile?.vertical ?? null,
    commerce_status: profile?.commerce_status ?? null,
    agent_id: agent?.agent_id ?? profile?.owner_agent ?? null,
    created_at: business.created_at ?? null,
    stage: stageOf(checklist),
    checklist,
    outstanding: outstanding(checklist),
  };
}

/**
 * Everyone, in one call.
 *
 * Capped, because this is read by a console page and an unbounded roster is a
 * page that stops loading the week the pilot works. Ordered by need rather
 * than by date: the businesses with the most outstanding on OUR side first,
 * because those are the ones where the delay is ours to fix.
 */
export async function roster(env, { limit = 200 } = {}) {
  if (!env?.DB) return { businesses: [], prospects: [], counts: {} };

  const { results: ids } = await env.DB.prepare(
    'SELECT id FROM businesses ORDER BY created_at DESC LIMIT ?1',
  ).bind(limit).all().catch(() => ({ results: [] }));

  const businesses = [];
  for (const row of ids ?? []) {
    const r = await readinessFor(env, row.id).catch(() => null);
    if (r) businesses.push(r);
  }

  // Claims that never became an account. Not a failing of the business — it is
  // the clearest signal that a door is broken, so it is reported separately
  // rather than mixed into the roster as a business with a bad score.
  const { results: prospects } = await env.DB.prepare(
    `SELECT c.id, c.business_name, c.contact_name, c.email, c.phone, c.country,
            c.state, c.created_at, c.place_id
       FROM claims c
      WHERE NOT EXISTS (
              SELECT 1 FROM num_place_owners o
               WHERE o.claim_id = CAST(c.id AS TEXT) AND o.revoked_at IS NULL)
      ORDER BY c.created_at ASC
      LIMIT 100`,
  ).all().catch(() => ({ results: [] }));

  const counts = { total: businesses.length, prospects: (prospects ?? []).length };
  for (const s of STAGES) counts[s.id] = businesses.filter((b) => b.stage === s.id).length;
  counts.blocked_on_us = businesses.filter((b) => b.outstanding.ours.length > 0).length;
  counts.blocked_on_them = businesses.filter(
    (b) => b.outstanding.ours.length === 0 && b.outstanding.theirs.length > 0,
  ).length;

  return { businesses, prospects: prospects ?? [], counts, items: ITEMS, stages: STAGES };
}

/**
 * What NUM owes, as a list of actions rather than a list of complaints.
 *
 * Grouped by ITEM, not by business, because that is how the work is actually
 * done: one person switching on one thing for eleven businesses, not eleven
 * separate errands.
 */
export function debts(rosterOut) {
  const byItem = new Map();
  for (const b of rosterOut.businesses ?? []) {
    for (const c of b.outstanding.ours) {
      if (!byItem.has(c.id)) byItem.set(c.id, { id: c.id, label: c.label, why: c.why, businesses: [] });
      byItem.get(c.id).businesses.push({ business_id: b.business_id, name: b.name });
    }
  }
  return [...byItem.values()].sort((a, b) => b.businesses.length - a.businesses.length);
}

export { BY_ID as ITEMS_BY_ID };
