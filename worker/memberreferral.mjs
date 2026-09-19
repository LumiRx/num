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
      `SELECT owner_id, owner_type FROM num_referral_codes
        WHERE UPPER(code) = ?1 AND active = 1 AND owner_type IN ('member','ambassador')`,
    ).bind(clean).first().catch(() => null);
    if (!owner?.owner_id) return { ok: false, why: 'unknown code' };

    /* ── ONE HOP, FOR AMBASSADOR CODES ONLY ───────────────────────────────
     *
     * Added 19 Sep 2026 with the ambassador programme. Until then this query
     * read `owner_type = 'member'` and nothing else, which meant an
     * ambassador's code redirected at /r/CODE, logged the arrival, carried
     * ?ref= all the way into signup — and then wrote no edge at all. Every
     * visible part of it worked. Somebody could have posted that link to an
     * audience for six months, earned nothing, and had no error anywhere to
     * tell them why.
     *
     * The share is credited to a MEMBER — that is where the Star balance and
     * the cash-out live — so an ambassador is paid through their member
     * account or not at all. This resolves the code to that account. When
     * there is not one yet it REFUSES with a reason rather than falling
     * through to some default, and the ambassador console says the same thing
     * in words on their own screen.
     *
     * This is a resolution, not a second level: it finds who the one referrer
     * IS, it does not walk a chain. The single-level rule in the header is
     * untouched, and the test that asserts it still passes.
     */
    let payee = String(owner.owner_id);
    if (owner.owner_type === 'ambassador') {
      const amb = await env.DB.prepare(
        "SELECT member_id, status FROM num_ambassadors WHERE id = ?1",
      ).bind(payee).first().catch(() => null);
      if (!amb) return { ok: false, why: 'unknown code' };
      if (amb.status === 'ended') return { ok: false, why: 'ambassador has ended' };
      if (!amb.member_id) return { ok: false, why: 'ambassador has no NUM account yet' };
      payee = String(amb.member_id);
    }

    // Paying somebody for bringing in themselves is not growth, it is a bug
    // with a payout attached.
    if (payee === String(memberId)) return { ok: false, why: 'self-referral' };

    const res = await env.DB.prepare(
      `UPDATE num_members SET referred_by = ?2, referred_pct = ?3, referred_at = ?4
        WHERE id = ?1 AND referred_by IS NULL`,
      // `payee`, NEVER `owner.owner_id`. For a member code they are the same
      // string; for an ambassador code owner_id is the AMBASSADOR row's id,
      // and writing that here would put a value in referred_by that matches
      // no member, so creditMemberReferral would find no referrer and pay
      // nothing — the exact silent failure this whole change exists to end.
    ).bind(memberId, payee, rateFor(env), new Date().toISOString()).run();

    const linked = Number(res?.meta?.changes ?? 0) > 0;

    /* ── TELL THEM IT HAPPENED ────────────────────────────────────────────
     *
     * Dre, 19 Sep 2026: "people need to know their connections are
     * happening."
     *
     * Before this, the only thing that ever reached a referrer was the
     * notification inside creditMemberReferral — which fires when their
     * person SPENDS, weeks later, and may never fire at all. So somebody
     * could post their link, bring in eleven people, and hear nothing for a
     * month. The join is the moment the link is PROVEN to work and it costs
     * nothing to say so.
     *
     * Only on a fresh link. An `already` is a second attempt at an
     * attribution that exists, and announcing it would tell somebody they
     * gained a person they gained last week.
     *
     * Awaited rather than fired and forgotten, because a Worker may be
     * torn down the moment the response is returned and an un-awaited
     * promise is a notification that sometimes arrives. Fully swallowed:
     * see the file — nothing in it may fail a signup.
     */
    if (linked) {
      try {
        const { announceReferral } = await import('./referralannounce.mjs');
        const who = await env.DB.prepare('SELECT name FROM num_members WHERE id = ?1')
          .bind(String(memberId)).first().catch(() => null);
        await announceReferral(env, { referrerId: payee, newMemberName: who?.name });
      } catch (e) {
        console.warn('[memberreferral announce]', e?.message ?? e);
      }
    }

    return { ok: linked, already: !linked, referrer: payee };
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

    /* ── IS THIS ONE PERSON PAYING THEMSELVES? ────────────────────────────
     *
     * Flagged in the 19 Sep review. The one-hop self-referral check above
     * only catches the same ACCOUNT. Two accounts belonging to one human —
     * sign the second up through your own link, book everything from it —
     * is a permanent, uncapped 20% rebate on your own spending, in cashable
     * Stars, and no anti-farming rule touches it because both accounts are
     * genuinely real, verified and active.
     *
     * HELD, NOT REFUSED. A husband referring his wife is exactly what this
     * programme is for, and from the outside it looks identical: two
     * accounts, one sofa, one router. A wrongly refused payment is somebody's
     * money taken silently by a rule they cannot see, which is worse than a
     * wrongly counted referral. So the money is recorded with its reason and
     * a person decides — see worker/migrations/0060. */
    const risk = await sameHumanRisk(env, { memberId: String(memberId), referrerId: String(m.referred_by) });
    if (risk) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO num_referral_holds
           (id, ref, referrer_id, member_id, stars, pct, reason, state, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'held',?8)`,
      ).bind(`hold:${ref}`, String(ref), String(m.referred_by), String(memberId),
        cut, pct, risk, new Date().toISOString()).run().catch(() => {});
      return { credited: 0, held: cut, why: risk };
    }

    /* ── ONE BATCH, OR NOTHING ────────────────────────────────────────────
     *
     * These three used to run as three separate statements with the ledger
     * insert LAST, behind a read that failed open. One read hiccup on a
     * retried settle and the balance was incremented, the ledger insert then
     * threw on the duplicate key, the outer catch swallowed it, and the
     * caller was told nothing was paid — leaving cashable Stars in a wallet
     * with no ledger row to explain them, permanently.
     *
     * A D1 batch is a transaction. The MOVE GOES FIRST so that a duplicate
     * primary key aborts the whole thing before any balance moves: the
     * ledger row is what makes the payment real, and it is now the thing
     * that guards it. The pre-check below is kept only to return a tidy
     * `duplicate` without relying on an exception. */
    const already = await env.DB.prepare('SELECT id FROM num_star_moves WHERE id = ?1')
      .bind(moveId).first().catch(() => null);
    if (already) return { credited: 0, duplicate: true };

    try {
      await env.DB.batch([
        // Kind 'referral' is in cashout.mjs EARNED_KINDS — money they worked
        // for, so it is cashable like any other earning.
        env.DB.prepare(
          "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'referral',?4,?5)",
        ).bind(moveId, m.referred_by, cut, `${pct}% of what Num earned from someone you brought in`, String(memberId)),
        env.DB.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)')
          .bind(m.referred_by),
        env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1')
          .bind(m.referred_by, cut),
      ]);
    } catch (e) {
      // The batch is atomic, so nothing was paid and nothing was recorded.
      // Reported as a duplicate rather than a failure when that is what it
      // was, because a retried settle is not an error.
      const dup = /UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e));
      if (dup) return { credited: 0, duplicate: true };
      throw e;
    }

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

/**
 * Does this look like one person paying themselves?
 *
 * Returns a REASON STRING when it does, and null when it does not. The string
 * is written to the hold row and read by whoever decides, so it has to say
 * what was actually seen rather than "suspicious".
 *
 * ── THE HARD PART IS NOT THE FRAUD, IT IS THE COUPLE ─────────────────────
 *
 * A husband referring his wife, who then books dinners, is exactly what this
 * programme is for. One person running two accounts is the thing it must not
 * pay. From the outside they are identical: two accounts, one sofa, one
 * router, sometimes one tablet.
 *
 * Only one signal truly separates them. /verify/5arz refuses to link one 5arz
 * identity to two Num accounts, so two real people can BOTH verify and one
 * person cannot. Everything else is circumstantial:
 *
 *   both 5arz-verified, different ids  → two people. Never held, whatever
 *                                        else they share. This is the rule
 *                                        that lets a real couple be paid.
 *   the same 5arz id                   → impossible through the app, so if it
 *                                        is ever seen it is data corruption
 *                                        or a bypass. Held either way.
 *   the same verified phone            → signup refuses duplicate numbers, so
 *                                        this should not happen either.
 *   the same device id                 → circumstantial. Held for a person to
 *                                        look at, not refused.
 *
 * NOTHING HERE IS DECIDED ON IP. Production on 19 Sep: 156 members behind 61
 * addresses. Holding a payment because two people share a router would hold
 * most honest referrals in the product.
 *
 * Fails CLOSED-ish on error: if the signals cannot be read the credit is held
 * rather than paid, because an unverifiable payment is the one to look at
 * twice. A held payment is recoverable; a paid one is not.
 */
export async function sameHumanRisk(env, { memberId, referrerId } = {}) {
  if (!env?.DB || !memberId || !referrerId) return null;
  if (String(memberId) === String(referrerId)) return 'the same account';

  let a; let b;
  try {
    a = await env.DB.prepare(
      'SELECT id, phone, phone_verified, identity_verified, bio FROM num_members WHERE id = ?1',
    ).bind(String(memberId)).first();
    b = await env.DB.prepare(
      'SELECT id, phone, phone_verified, identity_verified, bio FROM num_members WHERE id = ?1',
    ).bind(String(referrerId)).first();
  } catch {
    return 'could not check whether these are two people';
  }
  if (!a || !b) return null;

  const idA = fiveId(a);
  const idB = fiveId(b);

  // TWO VERIFIED PEOPLE ARE TWO PEOPLE. Checked before anything else, so a
  // couple who share a tablet and have both verified are paid without a
  // human ever having to look.
  if (idA && idB && idA !== idB) return null;

  if (idA && idB && idA === idB) return 'both accounts are linked to one 5arz identity';

  if (Number(a.phone_verified) === 1 && Number(b.phone_verified) === 1
    && a.phone && b.phone && a.phone === b.phone) {
    return 'both accounts verified the same phone number';
  }

  let sa; let sb;
  try {
    sa = await env.DB.prepare('SELECT device_id FROM num_identity_signals WHERE member_id = ?1')
      .bind(String(memberId)).first();
    sb = await env.DB.prepare('SELECT device_id FROM num_identity_signals WHERE member_id = ?1')
      .bind(String(referrerId)).first();
  } catch {
    return 'could not check whether these are two people';
  }
  if (sa?.device_id && sb?.device_id && sa.device_id === sb.device_id) {
    return 'both accounts were created on the same device';
  }

  return null;
}

/** The 5arz id recorded when this member consented. Mirrors linked5arzId in
 *  worker/air.mjs and five5arzId in growth/entryquality.mjs — never parsed
 *  from a request, only read back out of our own row. */
function fiveId(row) {
  if (!row?.bio) return null;
  try {
    const bio = typeof row.bio === 'string' ? JSON.parse(row.bio) : row.bio;
    const id = bio?.['5arz_id'];
    return typeof id === 'string' && id ? id : null;
  } catch { return null; }
}

/**
 * Release a held payment, or refuse it.
 *
 * MONEY HELD WITH NO WAY TO RELEASE IT IS JUST MONEY TAKEN, slowly, by a
 * queue nobody reads. This is the other half of the hold and it shipped in
 * the same commit for that reason.
 *
 * Releasing replays the ORIGINAL ref, so the star move id is the one that
 * would have been written at settlement time — the payment therefore happens
 * exactly once even if release is clicked twice, and even if the original
 * settle is somehow retried afterwards.
 */
export async function decideHold(env, { ref, release, by = 'ops' } = {}) {
  if (!env?.DB || !ref) return { ok: false, why: 'which hold' };
  const row = await env.DB.prepare('SELECT * FROM num_referral_holds WHERE ref = ?1')
    .bind(String(ref)).first().catch(() => null);
  if (!row) return { ok: false, why: 'no such hold' };
  if (row.state !== 'held') return { ok: true, already: row.state };

  const now = new Date().toISOString();

  if (!release) {
    await env.DB.prepare(
      "UPDATE num_referral_holds SET state='refused', decided_by=?2, decided_at=?3 WHERE ref=?1",
    ).bind(String(ref), String(by), now).run();
    return { ok: true, state: 'refused' };
  }

  const moveId = `memref:${row.ref}`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'referral',?4,?5)",
      ).bind(moveId, row.referrer_id, row.stars,
        `${row.pct ?? rateFor(env)}% of what Num earned from someone you brought in`, row.member_id),
      env.DB.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)')
        .bind(row.referrer_id),
      env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1')
        .bind(row.referrer_id, row.stars),
    ]);
  } catch (e) {
    // Already paid — mark it released so the queue agrees with the ledger
    // rather than offering it again for ever.
    const dup = /UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e));
    if (!dup) return { ok: false, why: 'could not pay that just now' };
  }

  await env.DB.prepare(
    "UPDATE num_referral_holds SET state='released', decided_by=?2, decided_at=?3 WHERE ref=?1",
  ).bind(String(ref), String(by), now).run();

  await notify(env, {
    memberId: row.referrer_id,
    kind: 'referral',
    title: `You earned ★${row.stars}`,
    body: 'Someone you brought to Num used it — your share is in your wallet.',
    url: '/?app',
    tag: `memref:${row.referrer_id}`,
  }).catch(() => {});

  return { ok: true, state: 'released', credited: row.stars };
}

/** Everything waiting on a person, oldest first. */
export async function openHolds(env, limit = 200) {
  if (!env?.DB) return [];
  try {
    const { results = [] } = await env.DB.prepare(
      `SELECT h.*, CAST(julianday('now') - julianday(h.created_at) AS INTEGER) AS days_waiting,
              (SELECT identity_verified FROM num_members WHERE id = h.referrer_id) AS referrer_verified,
              (SELECT identity_verified FROM num_members WHERE id = h.member_id)   AS member_verified
         FROM num_referral_holds h
        WHERE h.state = 'held' ORDER BY h.created_at ASC LIMIT ?1`,
    ).bind(limit).all();
    return results;
  } catch { return []; }
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
