// Cashing Stars out to 5arz — real money, so the design is about what CANNOT
// happen as much as what can.
//
// ── The one rule that shapes everything ───────────────────────────────────
//
// Stars have two origins and they are not the same asset:
//
//   EARNED   — a runner completed an errand, someone settled a tab in your
//              favour, you did work. Paying that out is a platform paying a
//              person for services. Ordinary. Every gig platform does it.
//
//   PURCHASED — someone handed us cash for Stars. Paying THAT back out in
//              money is cash-in → cash-out, which is the textbook shape of
//              money transmission and needs the licence, in every US state
//              and under EU e-money rules.
//
// So: **only earned Stars are cashable.** Purchased Stars spend inside Num and
// stay there. This isn't caution for its own sake — it's the line that lets us
// pay runners real money today without becoming a money transmitter. Mixing
// the two pools would collapse it, so `cashable()` computes from origin, never
// from the balance.
//
// ── What this file does NOT do ────────────────────────────────────────────
//
// It never sends money. It debits Stars and files a REQUEST that the payout
// desk (a separate Worker, separate keys — money code doesn't share a process
// with app code) picks up, verifies and pays. Duke's §8: money never rests
// with us, provider → recipient.
//
// ── Why it can be dark ────────────────────────────────────────────────────
//
// `CASHOUT_OK` gates the request path. Per the CTO handoff, 21 of 80 members'
// balances disagree with the ledger and `payable_stars` is 0 for everyone —
// paying out against a drifting ledger pays the WRONG PEOPLE THE WRONG
// AMOUNTS, and there is no undo on money that has left. The switch flips when
// INV-1 has been green for 24h, not before.
// ── TWO WALLETS. ONE DIRECTION. ───────────────────────────────────────────
//
//        NUM wallet  ──── cash out ────▶  5arz wallet
//        NUM wallet  ◀──── NOTHING ────   5arz wallet
//
// 5arz Stars NEVER enter Num. Not as a transfer, not as a top-up, not as a
// "link your balance" convenience. The two are separate wallets with separate
// ledgers in separate Workers, and the ONLY thing that crosses is an outbound
// payout request.
//
// Why this is load-bearing, not tidiness:
//   · 5arz Stars are cashable there. If they could flow into Num and back out
//     through Num, Num becomes a second exit for someone else's balance — a
//     value-transfer service, which is the licensing shape we are avoiding.
//   · 5arz's ledger is the one with the known drift (21 of 80 members). Import
//     its numbers and we import its bugs into a ledger that is currently clean.
//   · One-way means a bug over there can never mint Stars over here.
//
// The invariant, in one line a future session can check: **nothing in this
// codebase credits `num_star_balances` from a 5arz source.** `cashout.test.mjs`
// asserts it against the actual source, so breaking it fails the build rather
// than shipping quietly.
import { notify } from './push.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Credits whose origin is work, not cash. Anything not listed is NOT cashable. */
const EARNED_KINDS = ['errand', 'tab', 'bounty', 'referral', 'reward'];

/**
 * The wallet boundary, stated as data so it can be served, tested and read.
 * `inbound_from_5arz: false` is not a setting — there is no code path to turn
 * it on, and the test asserts none appears.
 */
export const WALLET_SEPARATION = Object.freeze({
  wallets: ['num', '5arz'],
  outbound_num_to_5arz: true,
  inbound_from_5arz: false,
  shared_ledger: false,
  statement: 'Num and 5arz are separate wallets. Earned Num Stars can be paid out to 5arz. Nothing comes back the other way.',
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_cashouts (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, stars INTEGER NOT NULL,
  dest TEXT NOT NULL, dest_ref TEXT,
  state TEXT NOT NULL DEFAULT 'requested',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_cashouts_member ON num_cashouts(member_id, requested_at);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * How many Stars this member may take out as money.
 *
 * Computed from ORIGIN: lifetime earned credits, minus everything already
 * cashed out or requested, then capped by the balance actually on hand. The
 * cap matters — earning ★500 and spending ★400 in-app leaves ★100 cashable,
 * not ★500.
 */
export async function cashable(env, memberId) {
  await ensure(env);
  const marks = EARNED_KINDS.map((_, i) => `?${i + 2}`).join(',');
  // NET, not just the credits. Posting an errand debits you and cancelling it
  // credits you back — counting only the positive side would let someone post,
  // cancel, and watch bought Stars reappear as "earned". Netting makes that a
  // round trip to zero, which is what it actually is. A runner who was paid
  // nets positive; that is the only way to end up cashable.
  const earned = await env.DB.prepare(
    `SELECT COALESCE(SUM(delta),0) n FROM num_star_moves WHERE member_id=?1 AND kind IN (${marks})`,
  ).bind(memberId, ...EARNED_KINDS).first().catch(() => ({ n: 0 }));
  const taken = await env.DB.prepare(
    "SELECT COALESCE(SUM(stars),0) n FROM num_cashouts WHERE member_id=?1 AND state<>'rejected'",
  ).bind(memberId).first().catch(() => ({ n: 0 }));
  const bal = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1')
    .bind(memberId).first().catch(() => null);

  const balance = Number(bal?.stars ?? 0);
  const earnedNet = Math.max(0, Number(earned?.n ?? 0) - Number(taken?.n ?? 0));
  return {
    balance,
    cashable: Math.max(0, Math.min(balance, earnedNet)),
    // Named so the UI can say the true thing rather than a vague refusal.
    locked_purchased: Math.max(0, balance - Math.min(balance, earnedNet)),
  };
}

export async function handleCashout(request, env, path) {
  const post = request.method === 'POST';
  const url = new URL(request.url);
  const open = env.CASHOUT_OK === '1';

  if (path === '/status' || path === '/' || path === '') {
    return json({
      open,
      destination: '5arz',
      rule: 'Earned Stars can be cashed out. Purchased Stars spend inside Num and are not cashable.',
      earned_kinds: EARNED_KINDS,
      blocked_reason: open
        ? null
        : 'Cash-out opens once the Star ledger reconciles (CTO handoff Track A). Paying out against a drifting ledger pays the wrong amounts, and money out has no undo.',
      money_path: 'Num files the request; the payout desk verifies and sends. Funds never rest with Num.',
    });
  }

  if (path === '/quote') {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ error: 'who?' }, 400);
    const q = await cashable(env, me);
    return json({ ...q, open });
  }

  if (path === '/request' && post) {
    if (!open) {
      return json({
        ok: false,
        error: 'Cash-out isn’t open yet. Your earned Stars are safe and counted — you’ll be able to take them out as soon as it opens.',
      }, 403);
    }
    const b = await request.json().catch(() => ({}));
    const me = clip(b.me, 40);
    const stars = Math.floor(Number(b.stars));
    const destRef = clip(b.dest_ref, 120); // 5arz account / wallet handle
    if (!me || !Number.isFinite(stars) || stars <= 0) return json({ ok: false, error: 'How many Stars?' }, 400);

    const q = await cashable(env, me);
    if (stars > q.cashable) {
      return json({
        ok: false,
        error: q.locked_purchased > 0
          ? `You can cash out ${q.cashable} Stars. The other ${q.locked_purchased} were bought rather than earned — those spend inside Num.`
          : `You can cash out ${q.cashable} Stars right now.`,
        ...q,
      }, 409);
    }

    // Debit first, conditionally. If the balance moved under us, nothing
    // happens — the same guard the escrow uses.
    const debit = await env.DB.prepare(
      'UPDATE num_star_balances SET stars = stars - ?2 WHERE member_id = ?1 AND stars >= ?2',
    ).bind(me, stars).run().catch(() => null);
    if (!(debit?.meta?.changes > 0)) return json({ ok: false, error: 'That didn’t go through — try again.' }, 409);

    const id = `co_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    try {
      await env.DB.prepare(
        'INSERT INTO num_cashouts (id, member_id, stars, dest, dest_ref) VALUES (?1,?2,?3,?4,?5)',
      ).bind(id, me, stars, '5arz', destRef).run();
      await env.DB.prepare(
        "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'cashout',?4,'5arz')",
      ).bind(`${id}:out`, me, -stars, 'Cash-out to 5arz').run().catch(() => {});
    } catch (err) {
      // Never leave a member short because our write failed.
      await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(me, stars).run().catch(() => {});
      console.error('[cashout] rolled back', err?.message ?? err);
      return json({ ok: false, error: 'That didn’t go through — nothing was taken.' }, 500);
    }

    await notify(env, {
      memberId: me,
      kind: 'cashout',
      title: 'Cash-out requested',
      body: `${stars} Stars are on their way to your 5arz account.`,
      url: '/?app',
      tag: `cashout:${id}`,
    }).catch(() => {});

    return json({ ok: true, id, stars, dest: '5arz', state: 'requested' });
  }

  if (path === '/history') {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ cashouts: [] });
    await ensure(env);
    const { results } = await env.DB.prepare(
      'SELECT id, stars, dest, state, requested_at, settled_at FROM num_cashouts WHERE member_id=?1 ORDER BY rowid DESC LIMIT 25',
    ).bind(me).all();
    return json({ cashouts: results ?? [] });
  }

  return json({ error: 'not found' }, 404);
}
