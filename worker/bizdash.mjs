/**
 * The parts of the business dashboard that answer "what is actually happening
 * to my listing" — and the version stamp that makes a bug report legible.
 *
 * Kept out of bizconsole.mjs deliberately: that file renders and routes, this
 * one only reads and shapes. Every function here returns DATA, never HTML, so
 * the same numbers can be served to the owner's dashboard, to the admin's
 * see-what-they-see view, and to a test, without three versions of the truth.
 *
 * ── THE HONESTY CONTRACT ──────────────────────────────────────────────────
 *
 * Every figure is either measured or absent. Nothing here estimates, projects,
 * or fills a gap with a plausible number. A merchant makes decisions on these
 * — whether to keep the hours updated, whether Num is worth answering — and an
 * invented figure is the most damaging thing this file could produce. When
 * there is nothing to show it says so in words a person can act on.
 */
import { NOT_PROBE } from './asks.mjs';

/**
 * The dashboard's version, shown to the owner and returned by the API.
 *
 * Bumped by hand when the dashboard changes shape. It exists so "it looked
 * different yesterday" and "which one are you on" are answerable questions —
 * a business emailing about a screen we have already changed is otherwise an
 * unwinnable conversation.
 */
export const DASHBOARD_VERSION = '1.1.0';

/** ISO date of this version, for the footer. */
export const DASHBOARD_RELEASED = '2026-08-30';

/**
 * What travellers actually asked near this business.
 *
 * `num_asks` holds the question and the destination it was answered in. This
 * is the closest honest answer to "what is demand here" that we can give
 * without claiming a traveller asked for THIS venue by name — which we mostly
 * cannot know, and must not imply.
 */
export async function travellerDemand(env, { dest, days = 30, limit = 8 } = {}) {
  if (!env?.DB || !dest) return { available: false, reason: 'No destination on this listing yet.' };
  try {
    const { results } = await env.DB.prepare(
      `SELECT text, COUNT(*) AS n
         FROM num_asks
        WHERE dest = ?1 AND ts >= datetime('now', ?2)
          AND ${NOT_PROBE}
        GROUP BY lower(trim(text))
        ORDER BY n DESC
        LIMIT ?3`,
    ).bind(String(dest), `-${Number(days) || 30} days`, limit).all();
    const rows = results ?? [];
    if (!rows.length) {
      return { available: false, reason: `No traveller asked Num anything in ${dest} in the last ${days} days.` };
    }
    return { available: true, days, dest, asks: rows.map((r) => ({ text: r.text, n: Number(r.n) })) };
  } catch {
    return { available: false, reason: 'Demand data could not be read just now.' };
  }
}

/**
 * The QR code a guest scans to pay this business.
 *
 * Returns STATE, not a promise. `num_paylinks` has no rows in production, so
 * the honest dashboard answer today is "not set up yet, here is how" — and the
 * one thing it must never do is show a merchant a payment surface that cannot
 * take money.
 */
export async function payQr(env, { placeId, businessId } = {}) {
  if (!env?.DB || !placeId) return { ready: false, reason: 'No listing.' };
  try {
    const row = await env.DB.prepare(
      `SELECT id, label, created_at FROM num_paylinks
        WHERE place_id = ?1 OR business_id = ?2
        ORDER BY rowid DESC LIMIT 1`,
    ).bind(String(placeId), businessId ? String(businessId) : '').first();
    if (row?.id) {
      return { ready: true, id: row.id, label: row.label ?? null, created_at: row.created_at ?? null };
    }
  } catch { /* the table may not exist yet — that is itself "not set up" */ }
  return {
    ready: false,
    // Stripe is live (payments: "stripe" on /api/version), so this is a setup
    // step rather than a missing capability — say which it is.
    reason: 'No pay code yet. Card payments run through our processor; ask us to switch yours on and we will '
      + 'issue a QR you can print for the counter.',
  };
}

/** Whether this listing carries the owner-verified badge, and how it was earned. */
export async function verification(env, placeId) {
  if (!env?.DB || !placeId) return { verified: false };
  try {
    const row = await env.DB.prepare(
      'SELECT method, created_at FROM num_business_verification WHERE place_id = ?1 LIMIT 1',
    ).bind(String(placeId)).first();
    if (row) return { verified: true, method: row.method, since: row.created_at };
  } catch { /* table not created until the first verification */ }
  return { verified: false };
}

/**
 * Everything the dashboard shows, in one shape.
 *
 * One function so the owner's view and the admin's see-what-they-see view are
 * the SAME data by construction. An admin preview that assembles its own
 * numbers is a preview of a screen nobody has.
 */
export async function dashboardData(env, { place, plan, insights, bookings }) {
  const [demand, qr, verified] = await Promise.all([
    travellerDemand(env, { dest: place?.dest, days: Math.min(30, plan?.analytics_days ?? 7) }),
    payQr(env, { placeId: place?.place_id ?? place?.id, businessId: plan?.business_id }),
    verification(env, place?.place_id ?? place?.id),
  ]);
  return {
    version: DASHBOARD_VERSION,
    released: DASHBOARD_RELEASED,
    place,
    plan,
    insights,
    bookings: bookings ?? [],
    demand,
    pay_qr: qr,
    verification: verified,
  };
}
