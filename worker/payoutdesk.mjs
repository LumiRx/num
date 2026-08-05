// The bridge from Num to the payout desk.
//
// ── What was broken ──────────────────────────────────────────────────────
//
// Cash-out debited a member's Stars, wrote a row into `num_cashouts` (num-db),
// told them "on its way to 5arz", and stopped. The desk reads
// `cashout_requests` in a different database and never saw it. Money left the
// balance and reached nobody, and every layer reported success.
//
// ── The rule this file exists to enforce ─────────────────────────────────
//
//   NOTHING IS DEBITED UNTIL THE DESK HAS ACKNOWLEDGED THE REQUEST.
//
// Not "written locally and hopefully swept". Not "queued and assumed". The
// desk answers with an id and a status, or the member's Stars never move. That
// ordering is the entire fix: it is the difference between a promise and a
// receipt, and it is the same lesson as the $1 pack and the silent push —
// never report success for something you have not confirmed.
//
// ── One honest limitation, stated up front ───────────────────────────────
//
// The desk pays from `member_finance.stars_earned` in the 5arz ledger. A Num
// member's earned Stars live in num-db and are NOT in that ledger, so the desk
// will answer "Only 0 Stars available" for anyone who earned them here. That
// is a real architectural gap and it is NOT this file's to invent a way
// around: funding it by writing into the 5arz ledger from here would merge the
// two wallets, which is precisely the boundary we built and tested to keep.
//
// So this bridge is complete, correct, and will refuse honestly until the desk
// grows a path that reads Num's ledger for `origin: 'num'` requests. When it
// does, nothing here changes. Until then the refusal names the reason instead
// of taking someone's Stars into a void.

const DESK = 'https://num-payouts.thatislumi.workers.dev';

/**
 * The desk uses the same session scheme as the operator console: POST the
 * admin key once, get a short-lived token, send it as X-Admin-Session.
 * Cached per isolate — minting one per cash-out would be a needless round trip
 * and a needless place to fail.
 */
let cached = { token: null, at: 0 };
const SESSION_TTL_MS = 10 * 60 * 1000;

async function session(env) {
  if (!env.PAYOUT_DESK_KEY) return null;
  if (cached.token && Date.now() - cached.at < SESSION_TTL_MS) return cached.token;
  try {
    const r = await fetch(`${env.PAYOUT_DESK_URL || DESK}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: env.PAYOUT_DESK_KEY }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      console.warn('[desk] session refused', r.status);
      return null;
    }
    const d = await r.json();
    if (!d?.token) return null;
    cached = { token: d.token, at: Date.now() };
    return d.token;
  } catch (err) {
    console.warn('[desk] session unreachable', err?.message ?? err);
    return null;
  }
}

/** Is the bridge configured at all? Used by health and by the status route. */
export const deskReady = (env) => !!env.PAYOUT_DESK_KEY;

/**
 * Ask the desk to queue a payout.
 *
 * Returns `{ ok: true, id, status }` only when the desk has actually recorded
 * it. Every other outcome is `{ ok: false, reason, retryable }` — and the
 * caller MUST treat that as "do not debit".
 *
 * `idempotencyKey` is ours and stable per cash-out attempt, so a retry after a
 * network timeout cannot queue the same payout twice: the desk recognises the
 * key and returns the original request instead of making a second one.
 */
export async function queuePayout(env, { memberId, stars, idempotencyKey }) {
  if (!deskReady(env)) {
    return {
      ok: false,
      retryable: false,
      reason: 'The payout desk isn’t connected to Num yet, so nothing was taken from your balance.',
      detail: 'PAYOUT_DESK_KEY unset',
    };
  }
  const token = await session(env);
  if (!token) {
    return {
      ok: false,
      retryable: true,
      reason: 'I couldn’t reach the payout desk just now — nothing was taken. Try again shortly.',
      detail: 'session mint failed',
    };
  }

  try {
    const r = await fetch(`${env.PAYOUT_DESK_URL || DESK}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Session': token },
      body: JSON.stringify({
        member_id: memberId,
        stars,
        idempotency_key: idempotencyKey,
        // Says where these Stars came from. The desk can use it to decide
        // which ledger to read; today it ignores it, which is why this path
        // still refuses for Num-earned Stars rather than paying the wrong one.
        origin: 'num',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const d = await r.json().catch(() => ({}));

    if (!r.ok) {
      // The desk's own words are better than anything we could paraphrase —
      // "Only 0 Stars available" tells the operator exactly what is wrong.
      return {
        ok: false,
        retryable: r.status >= 500,
        reason: d?.error ?? `The payout desk turned that down (${r.status}). Nothing was taken.`,
        findings: d?.findings ?? null,
        detail: `desk ${r.status}`,
      };
    }
    if (!d?.id) {
      return { ok: false, retryable: true, reason: 'The payout desk answered without a reference — nothing was taken.', detail: 'no id in response' };
    }
    return { ok: true, id: d.id, status: d.status ?? 'queued', already: !!d.already, amount_cents: d.amount_cents ?? null, rail: d.rail ?? null };
  } catch (err) {
    // A timeout is the dangerous case: the desk MAY have recorded it. We do
    // not debit, and the idempotency key means a retry resolves to the same
    // request rather than a duplicate payout.
    return {
      ok: false,
      retryable: true,
      reason: 'The payout desk didn’t answer in time — nothing was taken. Try again and I’ll pick up the same request.',
      detail: err?.message ?? String(err),
    };
  }
}
