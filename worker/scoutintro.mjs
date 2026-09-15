/**
 * NUM · attaching a Num Expert to what they actually brought in.
 *
 * ── THE HOLE THIS FILLS ──────────────────────────────────────────────────
 *
 * Before this file, a scout's code could only ever be recorded in ONE place:
 * `introduce()` in scouts.mjs, called from the claim VERIFY step, which needs
 * a `place_id` because num_scout_places declares it NOT NULL UNIQUE — that
 * uniqueness is the whole first-scout-wins rule and is not something to
 * loosen.
 *
 * So three of the people who tap an Expert's card were unattributable:
 *
 *   · A business Num holds NO listing for. It types its name into the claim
 *     form, the lead lands in `claims`, and the place is created days later by
 *     a human. By then the tap is long gone. This was most of Isaiah's street:
 *     small shops are exactly the ones missing from a 2.5M-row places table.
 *   · A business that fills the form and never reaches the verify step, which
 *     is the majority — verification is offered only when a listing matched.
 *   · A HOST. Guides, drivers and fixers are not places at all and can never
 *     have a row in num_scout_places.
 *
 * The fix is small and deliberately dumb: write the CODE onto the row that was
 * actually created, on `claims` and on `num_hosts`. A code on a row is not a
 * payout — it is the only durable record that the tap and the sign-up were the
 * same person, and it can be turned into an introduction later, once there is
 * a place to introduce.
 *
 * ── WHAT THIS FILE REFUSES TO DO ─────────────────────────────────────────
 *
 * It does not pay anybody for a host.
 *
 * Every rate a scout agreed to — finder_cents, share_bps, sub_share_bps — is
 * written against A BUSINESS PRODUCING REVENUE TO NUM, and a host produces
 * revenue in a completely different shape (a monthly plan, no per-booking
 * commission). Quietly filing hosts into the same earnings table would invent
 * an obligation nobody priced and nobody agreed to, and it would surface in a
 * dashboard as money six weeks before anyone noticed. The code is recorded,
 * the credit is visible, and what it is worth is a decision for a human with
 * the terms in front of them.
 *
 * The same restraint applies to the claim rows: a code on a lead is a CLAIM
 * TO ATTRIBUTION, not an introduction, and it does not consume the scout's
 * monthly cap. The cap is spent by `introduce()`, at the moment a real place
 * is bound, which is the only moment we can check first-come against it.
 */

/**
 * Columns added in place rather than in a migration file.
 *
 * `claims` and `num_hosts` both predate worker/migrations and are written by
 * num-growth, which has no migration runner. The pattern here is the one
 * memberreferral.mjs already uses on num_members: an idempotent ALTER guarded
 * by a module-level flag, swallowing the "duplicate column name" error that a
 * second run throws. It is not elegant; it is what these two tables support.
 */
const ALTERS = [
  'ALTER TABLE claims ADD COLUMN scout_code TEXT',
  'ALTER TABLE num_hosts ADD COLUMN scout_code TEXT',
];
let ready = false;
export async function ensureScoutColumns(env) {
  if (ready || !env?.DB) return;
  for (const sql of ALTERS) await env.DB.prepare(sql).run().catch(() => {});
  ready = true;
}
/** Tests only. */
export const __resetSchema = () => { ready = false; };

/**
 * Record who introduced a business, and introduce them properly when we can.
 *
 * Returns a plain report rather than throwing. Attribution must never be a
 * reason a real business fails to sign up — that trade is not close.
 *
 * `place` is the matched listing when the owner picked one, otherwise null.
 */
export async function attachScoutToClaim(env, { claimId = null, code = null, place = null } = {}) {
  if (!env?.DB || !code) return { ok: false, why: 'no code' };
  try {
    const { scoutByCode, introduce } = await import('./scouts.mjs');
    const scout = await scoutByCode(env, code);
    // An unknown, paused or ended code records nothing. Writing it anyway
    // would leave rows pointing at a scout who cannot be paid and who may
    // have been removed for cause.
    if (!scout) return { ok: false, why: 'unknown code' };

    await ensureScoutColumns(env);
    if (claimId != null) {
      await env.DB.prepare('UPDATE claims SET scout_code = ?2 WHERE id = ?1 AND scout_code IS NULL')
        .bind(claimId, scout.code).run().catch(() => {});
    }

    // A real listing means we can do the proper thing now: bind the place, spend
    // the cap, let the UNIQUE(place_id) decide first-come. Without one, the code
    // on the claim row is the whole record and that is correct — there is
    // nothing to be first to.
    if (place?.id) {
      await introduce(env, {
        scoutId: scout.id,
        placeId: place.id,
        bizName: place.name,
        dest: place.dest ?? null,
        country: place.country ?? null,
        lat: place.lat ?? null,
        lng: place.lng ?? null,
      });
      return { ok: true, scout: scout.code, introduced: true };
    }
    return { ok: true, scout: scout.code, introduced: false, note: 'recorded on the lead; no listing to bind yet' };
  } catch (e) {
    console.warn('[scoutintro claim]', e?.message ?? e);
    return { ok: false, why: 'could not attach' };
  }
}

/**
 * Record who introduced a host.
 *
 * Deliberately just a column. See the header: a host is not a place and the
 * scout terms do not price one.
 */
export async function attachScoutToHost(env, { hostId = null, code = null } = {}) {
  if (!env?.DB || !code || !hostId) return { ok: false, why: 'no code' };
  try {
    const { scoutByCode } = await import('./scouts.mjs');
    const scout = await scoutByCode(env, code);
    if (!scout) return { ok: false, why: 'unknown code' };
    await ensureScoutColumns(env);
    await env.DB.prepare('UPDATE num_hosts SET scout_code = ?2 WHERE id = ?1 AND scout_code IS NULL')
      .bind(hostId, scout.code).run();
    return { ok: true, scout: scout.code };
  } catch (e) {
    console.warn('[scoutintro host]', e?.message ?? e);
    return { ok: false, why: 'could not attach' };
  }
}

/**
 * What an Expert brought in that is NOT yet a bound introduction.
 *
 * Every number here is named for exactly what it is, and `earning: false` is
 * stated rather than implied. A dashboard that shows "14" next to a dollar
 * sign, where 14 is leads and the dollars require revenue that has not
 * happened, is a dashboard that starts an argument in about six weeks.
 */
export async function pendingFor(env, code) {
  const out = {
    leads: 0,
    hosts: 0,
    earning: false,
    note: 'Businesses you brought that Num had no listing for yet, and hosts you '
      + 'signed up. Neither earns a finder fee today — a fee needs a listing that '
      + 'has produced revenue. They are recorded so you get the credit when they do.',
  };
  if (!env?.DB || !code) return out;
  try {
    await ensureScoutColumns(env);
    const a = await env.DB.prepare(
      'SELECT COUNT(*) n FROM claims WHERE scout_code = ?1 AND place_id IS NULL',
    ).bind(code).first().catch(() => null);
    const b = await env.DB.prepare(
      'SELECT COUNT(*) n FROM num_hosts WHERE scout_code = ?1',
    ).bind(code).first().catch(() => null);
    out.leads = Number(a?.n ?? 0);
    out.hosts = Number(b?.n ?? 0);
  } catch { /* a count is never worth failing a dashboard over */ }
  return out;
}
