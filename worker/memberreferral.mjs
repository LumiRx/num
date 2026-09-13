/**
 * Refer a person, earn a share of what Num makes from them.
 *
 * The sibling of `bizreferral.mjs` (refer a BUSINESS, earn 2% of its bookings)
 * and deliberately built to the same shape, because that file already worked
 * out the hard parts: the rate is frozen on the row, attribution is
 * first-touch and permanent, self-referral is blocked, and earnings land as
 * EARNED Stars so they inherit the existing cash-out path.
 *
 * ── THE BREAK THIS FIXES ─────────────────────────────────────────────────
 *
 * Checked against production on 13 Sep 2026: of 148 members, **ZERO** had a
 * referrer recorded. Not a low number — none.
 *
 * Everything upstream worked. Share links carry the code, `/r/CODE` resolves
 * it and logs the arrival, the app reads `?ref=` out of the URL. Then signup
 * sent `{ id, name, phone, email, dest, utm }` to the server and simply did not
 * include it. The code was read into a variable and dropped on the floor.
 *
 * So Num has been running a referral programme that could never pay anybody,
 * and `num_referral_codes` has been minting per-member codes with a
 * `reward_cs` of 500 sitting unused since the table was created. Designing a
 * revenue share before fixing this would have been promising money to people
 * we had no way to identify.
 *
 * ── WHAT A REFERRER EARNS, AND OUT OF WHAT ───────────────────────────────
 *
 * Dre asked for "1% from each friend they bring on for life". That turned out
 * to mean two very different things, and the numbers decided it:
 *
 *   1% of the FRIEND'S BILL      — 80¢ on an $80 dinner, which is 10% of our
 *                                  own revenue. Defensible, and standard for
 *                                  affiliate deals. But UNCOMPUTABLE today:
 *                                  every venue has bill reporting off, which
 *                                  is why they all pay the flat floor.
 *   1% of OUR COMMISSION         — 8¢ on the same dinner. About $2 a year per
 *                                  active user. An influencer with 500 good
 *                                  referrals earns $80 a month, which is not
 *                                  a programme, it is an insult.
 *
 * Dre's call, 13 Sep: **20% of the commission Num actually collected.** It can
 * only ever pay out of money already earned, so it cannot cost more than it
 * makes; it is the one figure we can measure today; and at 500 active
 * referrals it is worth roughly $1,600 a month, which is worth someone's time.
 *
 * ── WHY A COLUMN AND NOT A THIRD TABLE ───────────────────────────────────
 *
 * Two referral systems already existed on 13 Sep 2026 and NEITHER had ever
 * paid anybody:
 *
 *   · `num_referral_conversions` — written by `/ref/signup` on the claim
 *     worker. 5 rows, all `reward_status = 'pending'`, oldest from July, none
 *     ever marked earned. `worker/referral.mjs` holds the code to earn them.
 *   · `num_referral_codes.reward_cs` — 500 (a $5 reward) minted onto every
 *     member's code since the table was created, never once read.
 *
 * A third table would have made it three. So the durable link lives as a
 * COLUMN on the member: a lifetime revenue share needs a permanent
 * member → referrer EDGE, and a conversions table is an event log, which is a
 * different thing. The conversion row stays as the audit trail of the signup;
 * `referred_by` is what every commission reads to know who to pay. They record
 * the same fact for different purposes rather than competing to own it.
 *
 * ── SINGLE LEVEL. THIS IS NOT NEGOTIABLE. ────────────────────────────────
 *
 * A referrer earns from the people THEY brought and from nobody else. Paying
 * someone a slice of their referrals' referrals is a multi-level structure,
 * which is regulated territory in the US and a different company from this
 * one. `creditMemberReferral` reads exactly one `referred_by` hop and never
 * walks a chain; a test asserts it, because this is the kind of thing that
 * gets "improved" into existence by somebody being helpful.
 */
import { notify } from './push.mjs';

/** 20% of what Num collected. Override with MEMBER_REFERRAL_PCT. */
const DEFAULT_PCT = 20;
export const rateFor = (env) => {
  const n = Number(env?.MEMBER_REFERRAL_PCT ?? DEFAULT_PCT);
  // A nonsense rate is a business risk, not a rounding error — clamp hard.
  return Number.isFinite(n) && n > 0 && n <= 50 ? n : DEFAULT_PCT;
};

const MIGRATIONS = [
  // Who brought this member in. NULL for everyone who arrived on their own,
  // which is currently all 148 of them.
  'ALTER TABLE num_members ADD COLUMN referred_by TEXT',
  // Frozen at link time. Changing the rate later must never silently rewrite
  // what somebody was already promised — the same rule bizreferral.mjs uses.
  'ALTER TABLE num_members ADD COLUMN referred_pct INTEGER',
  'ALTER TABLE num_members ADD COLUMN referred_at TEXT',
];
let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  for (const m of MIGRATIONS) await env.DB.prepare(m).run().catch(() => {});
  ready = true;
}
/** Tests only. */
export const __resetSchema = () => { ready = false; };

/**
 * Record who brought this member in.
 *
 * FIRST TOUCH AND PERMANENT. A member who arrives on Priya's link and later
 * opens Sam's stays Priya's — otherwise the last person to send a link wins,
 * and the person who actually did the persuading loses. `referred_by IS NULL`
 * in the WHERE clause is what enforces it, so a second call is a no-op rather
 * than an overwrite.
 *
 * Returns quietly on every refusal. A referral that cannot be credited must
 * never block a signup.
 */
export async function linkReferral(env, { memberId, code } = {}) {
  if (!env?.DB || !memberId || !code) return { ok: false, why: 'nothing to link' };
  try {
    await ensure(env);
    const clean = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
    if (!clean) return { ok: false, why: 'not a code' };

    const owner = await env.DB.prepare(
      `SELECT owner_id FROM num_referral_codes
        WHERE UPPER(code) = ?1 AND active = 1 AND owner_type = 'member'`,
    ).bind(clean).first().catch(() => null);
    if (!owner?.owner_id) return { ok: false, why: 'unknown code' };

    // Paying somebody for bringing in themselves is not growth, it is a bug
    // with a payout attached.
    if (String(owner.owner_id) === String(memberId)) return { ok: false, why: 'self-referral' };

    const res = await env.DB.prepare(
      `UPDATE num_members SET referred_by = ?2, referred_pct = ?3, referred_at = ?4
        WHERE id = ?1 AND referred_by IS NULL`,
    ).bind(memberId, owner.owner_id, rateFor(env), new Date().toISOString()).run();

    const linked = Number(res?.meta?.changes ?? 0) > 0;
    return { ok: linked, already: !linked, referrer: owner.owner_id };
  } catch (e) {
    console.warn('[memberreferral link]', e?.message ?? e);
    return { ok: false, why: 'could not link' };
  }
}

/**
 * Pay the referrer their share of one commission.
 *
 * `stars` is what NUM collected on this booking, not what the guest spent.
 *
 * BOTH SIDES MUST STILL BE ACTIVE. Dre's call, 13 Sep: the share runs "while
 * both stay active" rather than literally for life. A perpetual obligation on
 * a pre-revenue company survives pivots and acquisitions and cannot be
 * withdrawn from anybody already promised it; ending with the relationship is
 * the same rule the business programme already uses.
 */
export async function creditMemberReferral(env, { memberId, stars, ref } = {}) {
  if (!env?.DB || !memberId || !(stars > 0) || !ref) return { credited: 0 };
  try {
    await ensure(env);

    // ONE HOP. Not a loop, not a recursive CTE, not "walk up the tree". See
    // the header: a second level makes this a different kind of company.
    const m = await env.DB.prepare(
      'SELECT referred_by, referred_pct FROM num_members WHERE id = ?1',
    ).bind(String(memberId)).first().catch(() => null);
    if (!m?.referred_by) return { credited: 0 };

    // The referrer must still exist. A closed account earns nothing, which is
    // what "while both stay active" means in practice.
    const referrer = await env.DB.prepare('SELECT id FROM num_members WHERE id = ?1')
      .bind(m.referred_by).first().catch(() => null);
    if (!referrer) return { credited: 0, why: 'referrer is gone' };

    // The rate frozen on the row at link time, never today's rate.
    const pct = Number(m.referred_pct) > 0 ? Number(m.referred_pct) : rateFor(env);
    const cut = Math.floor((Number(stars) * pct) / 100);
    if (cut < 1) return { credited: 0 };

    // Idempotent on the caller's ref — a retried settle must not pay twice.
    const moveId = `memref:${ref}`;
    const already = await env.DB.prepare('SELECT id FROM num_star_moves WHERE id = ?1')
      .bind(moveId).first().catch(() => null);
    if (already) return { credited: 0, duplicate: true };

    await env.DB.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)')
      .bind(m.referred_by).run();
    await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1')
      .bind(m.referred_by, cut).run();
    // Kind 'referral' is in cashout.mjs EARNED_KINDS — money they worked for,
    // so it is cashable like any other earning.
    await env.DB.prepare(
      "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'referral',?4,?5)",
    ).bind(moveId, m.referred_by, cut, `${pct}% of what Num earned from someone you brought in`, String(memberId)).run();

    await notify(env, {
      memberId: m.referred_by,
      kind: 'referral',
      title: `You earned ★${cut}`,
      body: 'Someone you brought to Num just used it — your share is in your wallet.',
      url: '/?app',
      tag: `memref:${m.referred_by}`,
    }).catch(() => {});

    return { credited: cut, pct };
  } catch (e) {
    console.warn('[memberreferral credit]', e?.message ?? e);
    return { credited: 0 };
  }
}

/** What one member has brought in. For their own screen, and for influencers. */
export async function referralSummary(env, memberId) {
  if (!env?.DB || !memberId) return { referred: 0, earned: 0 };
  try {
    await ensure(env);
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM num_members WHERE referred_by = ?1')
      .bind(String(memberId)).first().catch(() => null);
    const e = await env.DB.prepare(
      "SELECT COALESCE(SUM(delta),0) AS n FROM num_star_moves WHERE member_id = ?1 AND kind = 'referral'",
    ).bind(String(memberId)).first().catch(() => null);
    return { referred: Number(c?.n ?? 0), earned: Number(e?.n ?? 0) };
  } catch { return { referred: 0, earned: 0 }; }
}
