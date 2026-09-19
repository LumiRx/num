/**
 * The line a paying venue gets to have the concierge mention.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * 19 Sep 2026. NUM for Business sells "a promotion NUM can mention to
 * travellers" on /pricing/ at $9.99 a month, and `DEFAULT_BIZ_TIERS` grants
 * `promotions: true` on Small and up. The business console writes the line
 * into `num_business_profiles.custom_fields.promo_text`, gated correctly on
 * that entitlement, and `GET /v1/profile` reads it back.
 *
 * A grep for `promo_text` across the whole tree returned bizconsole.mjs and
 * bizapi.mjs and nothing else. Nothing under ai/ ever read it. A business
 * could pay, write its promotion, watch it save — and the concierge would
 * never say it. That is a sold feature that does nothing, which is worse than
 * an unsold one, because somebody's card is on file.
 *
 * ── THE RULE THAT MATTERS MOST ───────────────────────────────────────────
 *
 * /pricing/ says, in as many words, that there is no paid placement. So a
 * promotion must never move a place UP, never add a place that ranking did not
 * already choose, and never be the reason one place is suggested over another.
 * It annotates rows some ordinary piece of ranking already picked — exactly
 * the contract worker/venuedisclosure.mjs has, and for the same reason.
 *
 * If a promo could win an argument between two restaurants, NUM would be an ad
 * network with a concierge stapled to the front, and the guest's trust in
 * every other answer would be worth less. The $9.99 buys a venue the right to
 * be QUOTED once NUM has already decided to name them. It does not buy the
 * decision.
 *
 * ── AND THE SECOND RULE: THESE ARE THEIR WORDS, NOT OURS ─────────────────
 *
 * The line is whatever the venue typed. NUM does not check it, cannot check
 * it, and must not assert it as its own. "They mention a free second taco
 * before noon" is honest; "you'll get a free second taco before noon" is NUM
 * making a promise about somebody else's till. The prompt block below is
 * written to force the first shape.
 *
 * ── AND THE THIRD: A PROMOTION GOES STALE ────────────────────────────────
 *
 * There is no end date on the field and there is no sweep. A venue types
 * "happy hour all August" and, left alone, NUM repeats it next March. That is
 * the same failure as a food truck's pitch outliving the truck
 * (worker/mobilevenue.mjs), and it gets the same treatment: the line carries
 * the day it was written, and one nobody has touched in PROMO_MAX_AGE_DAYS
 * stops being served. The venue's text is not deleted — they own it, and it
 * comes back the moment they save it again.
 */

import { bizTiers } from './bizbilling.mjs';

/** Matches the console input's maxlength. Long enough for an offer, too short for a menu. */
export const MAX_PROMO_CHARS = 140;

/**
 * How long a promotion is allowed to speak for itself.
 *
 * 90 days rather than 30: a venue is not a newsroom, and nagging a restaurant
 * every month to retype the same sentence is how the feature gets abandoned.
 * Long enough to cover a season, short enough that "all August" cannot still
 * be running at Christmas.
 */
export const PROMO_MAX_AGE_DAYS = 90;

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * What the venue wrote, and when — or null.
 *
 * `promo_set_at` is an ISO day string written by whichever door saved the
 * line. A promo with no date is NOT served: every writer records it, so a
 * missing one means the row predates this file or was written by something
 * that is not a promo writer, and in both cases we do not know whether the
 * sentence is current. Withholding is the cheap mistake here; repeating a
 * stale offer to a guest who then turns up expecting it is not.
 */
export function promoOf(customFields) {
  let f = customFields;
  if (typeof f === 'string') { try { f = JSON.parse(f); } catch { return null; } }
  const text = String(f?.promo_text ?? '').trim();
  if (!text) return null;
  const setAt = String(f?.promo_set_at ?? '').trim();
  if (!setAt) return null;
  const t = Date.parse(setAt.length <= 10 ? `${setAt}T00:00:00Z` : setAt);
  if (!Number.isFinite(t)) return null;
  return { text: clip(text, MAX_PROMO_CHARS), set_at: setAt, at: t };
}

/** True while the line is still young enough to repeat. */
export function fresh(promo, now = Date.now()) {
  if (!promo?.at) return false;
  const age = now - promo.at;
  // A date in the future is a clock problem, not a fresher promo. Treat it as
  // written now rather than trusting it for an extra three months.
  return age <= PROMO_MAX_AGE_DAYS * 86400_000;
}

/**
 * Does this tier include promotions, right now?
 *
 * The lapse rule is `bizTierOf`'s, restated here because this reads many
 * businesses in one query and calling that function per row would be a
 * round trip each. venuepromo.test.mjs pins the two together, so the day one
 * changes the other fails rather than drifts.
 */
export function tierAllowsPromo(env, tier, renewsAt, now = Date.now()) {
  if (renewsAt && Date.parse(`${renewsAt}Z`) < now) return false;
  const t = bizTiers(env)[tier];
  return !!t?.entitlements?.promotions;
}

/**
 * Attach each venue's promotion to the rows already in front of the model.
 *
 * NEVER widens the list, never reorders it, never drops a row. On any failure
 * the rows come back exactly as they arrived, with no promos: an answer with
 * no promotion in it is a completely good answer, so there is nothing here
 * worth degrading a result set for.
 */
export async function annotatePromos(env, rows, { now = Date.now() } = {}) {
  if (!env?.DB || !rows?.length) return rows ?? [];
  const ids = rows.map((r) => r.id).filter(Boolean).slice(0, 40);
  if (!ids.length) return rows;
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  try {
    const { results } = await env.DB.prepare(
      `SELECT p.place_id, p.custom_fields, s.tier, s.renews_at
         FROM num_business_profiles p
         LEFT JOIN num_business_subscriptions s ON s.business_id = p.business_id
        WHERE p.place_id IN (${marks})`,
    ).bind(...ids).all();
    const found = new Map();
    for (const r of results ?? []) {
      if (!tierAllowsPromo(env, r.tier ?? 'free', r.renews_at, now)) continue;
      const promo = promoOf(r.custom_fields);
      if (promo && fresh(promo, now)) found.set(r.place_id, promo);
    }
    if (!found.size) return rows;
    return rows.map((r) => (found.has(r.id) ? { ...r, promo: found.get(r.id) } : r));
  } catch (e) {
    console.warn('[promo] read failed, no promotions this answer', e?.message ?? e);
    return rows;
  }
}

/**
 * What the model is told.
 *
 * Empty for almost every answer, and deliberately worded as a permission with
 * three refusals rather than an instruction: the failure mode of a block like
 * this is a model that starts selling.
 */
export function promoBlock(rows) {
  const withPromo = (rows ?? []).filter((r) => r?.promo?.text);
  if (!withPromo.length) return '';
  const lines = [
    'WHAT THESE VENUES SAY ABOUT THEMSELVES RIGHT NOW',
    ...withPromo.map((r) => `- ${r.name}: "${r.promo.text}"`),
    '',
    'These are the venue’s own words, typed by them, not checked by NUM.',
    'If you mention one, attribute it — "they say they are doing X" — never state it as',
    'your own promise, because it is their till and their offer, not ours.',
    'You may mention it ONLY for a place you had already decided to suggest.',
    'It is NEVER a reason to suggest one place over another, never part of a comparison,',
    'and never a reason to move a place up a list. A guest must get the same recommendation',
    'whether or not the venue is paying us.',
    'If it does not fit naturally in what you were going to say anyway, leave it out.',
  ];
  return lines.join('\n');
}

/**
 * Save a line, stamped with the day.
 *
 * Merged into `custom_fields` rather than replacing it, for the same reason
 * saveDisclosures merges: `disclosures`, `licence` and the delivery hours live
 * in the same JSON, and a whole-object write from one form would switch a
 * partner's delivery licence off.
 *
 * The entitlement is NOT checked here. The callers already gate on it before
 * they let the field be edited at all, and a second check in a save path
 * cannot be the one that matters — the read is where the money is enforced,
 * because a venue that lapses after saving must stop being quoted without
 * anybody rewriting their row.
 */
export async function savePromo(env, businessId, text, by = 'console', { now = new Date() } = {}) {
  if (!env?.DB || !businessId) return { ok: false, error: 'no business' };
  const line = clip(String(text ?? '').trim(), MAX_PROMO_CHARS) ?? '';
  const row = await env.DB.prepare(
    'SELECT custom_fields FROM num_business_profiles WHERE business_id=?1',
  ).bind(String(businessId)).first().catch(() => null);
  let f = {};
  try { f = JSON.parse(row?.custom_fields || '{}') || {}; } catch { f = {}; }
  const next = { ...f };
  if (line) {
    next.promo_text = line;
    next.promo_set_at = now.toISOString().slice(0, 10);
    next.promo_by = String(by).slice(0, 60);
  } else {
    // Clearing it clears the date too. A stamp left behind a deleted line
    // would make the next empty save look like a fresh promotion.
    delete next.promo_text;
    delete next.promo_set_at;
    delete next.promo_by;
  }
  try {
    await env.DB.prepare(
      'UPDATE num_business_profiles SET custom_fields=?2,'
      + " updated_at=CAST(strftime('%s','now') AS INTEGER) WHERE business_id=?1",
    ).bind(String(businessId), JSON.stringify(next)).run();
    return { ok: true, promo_text: line || null, promo_set_at: next.promo_set_at ?? null };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}
