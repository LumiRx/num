/**
 * Splitting a bill between friends, without NUM ever touching the money.
 *
 * ── WHY THIS MINTS REAL CODES INSTEAD OF TRACKING SHARES ─────────────────
 *
 * The obvious build is a ledger: one person pays the venue, everyone else owes
 * them, NUM moves the difference around. NUM cannot do that. Taking one
 * person's money and passing it to another is money transmission in all three
 * markets, and it is the single rule this whole system is built to keep —
 * "guest pays venue directly; NUM never holds, routes or deducts".
 *
 * So a split does not move anybody's money. It mints one REAL bill code per
 * person, each for their own share, each a direct charge on the venue's own
 * Stripe account. Four friends produce four charges on the venue's account and
 * NUM is in none of them. It also happens to be the only version that works for
 * the friend who is not a NUM member — they get a link, they pay the venue.
 *
 * ── THE PARENT IS CLOSED THE MOMENT IT IS SPLIT ──────────────────────────
 *
 * Otherwise the same dinner can be paid twice: one friend pays their share
 * while another, looking at the original code on the table, pays the lot. There
 * is no refund path that makes that pleasant. A split parent reports `split`
 * and refuses checkout; the shares are the bill now.
 *
 * ── THE VENUE IS NEVER SHORT BY A PENNY ──────────────────────────────────
 *
 * Shares must sum to the parent EXACTLY. An even split of 2,401 between three
 * people is 800.33, 800.33, 800.33 — which is 2,399.99, and a venue one cent
 * short with the check closed. The remainder always lands on the person doing
 * the splitting, never on a stranger and never on the floor.
 *
 * ── AND THE FEE IS CHARGED ONCE ──────────────────────────────────────────
 *
 * A bill split four ways is one dinner, not four. The commission is computed on
 * the parent, allocated across the shares by largest remainder so the parts sum
 * to exactly the whole, and stamped on each share at split time. Nothing
 * re-derives it later, so the ledger cannot drift from what Stripe collected.
 * Children accrue nothing on their own: billqr.mjs settles the parent once the
 * shares cover it, and that settlement is what reaches the ledger.
 */
import { mintBillCode, parseAmount } from './billqr.mjs';
import { billFor, feeForBill } from './billpay.mjs';
import { deliverShares } from './billreach.mjs';
import { track } from './paytrack.mjs';

const MAX_WAYS = 12;
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/**
 * Split `total` between `ways` people so the parts sum to exactly `total`.
 * The remainder goes to index 0 — the person doing the splitting — because
 * somebody has to carry the odd penny and it should be the person who chose to
 * split, not whoever happens to sort first.
 */
export function evenShares(totalMinor, ways) {
  const n = Math.floor(ways);
  if (!Number.isInteger(totalMinor) || totalMinor <= 0) return null;
  if (!Number.isInteger(n) || n < 2 || n > MAX_WAYS) return null;
  if (totalMinor < n) return null; // fewer minor units than people: not divisible into real bills
  const base = Math.floor(totalMinor / n);
  const out = new Array(n).fill(base);
  out[0] += totalMinor - base * n;
  return out;
}

/**
 * Allocate `feeMinor` across `shares` so the parts sum to exactly `feeMinor`.
 * Largest remainder: proportional floor first, then the leftover pennies go to
 * the biggest shares. Never a rounded-up total — the venue would be charged a
 * fee larger than the one their own terms say.
 */
export function allocateFee(feeMinor, shares) {
  const total = shares.reduce((n, s) => n + s, 0);
  if (!total || !Number.isFinite(feeMinor) || feeMinor <= 0) return shares.map(() => 0);
  const exact = shares.map((s) => (feeMinor * s) / total);
  const out = exact.map((x) => Math.floor(x));
  let left = feeMinor - out.reduce((n, x) => n + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x), share: shares[i] }))
    .sort((a, b) => b.frac - a.frac || b.share - a.share || a.i - b.i);
  for (let k = 0; left > 0; k += 1, left -= 1) out[order[k % order.length].i] += 1;
  return out;
}

/** Is this bill a share of a bigger one, and has it been split already? */
export async function splitStateOf(env, token) {
  if (!env?.DB || !token) return { parent: null, split_at: null };
  const row = await env.DB.prepare(
    'SELECT split_parent, split_at, split_for_member FROM num_paylinks WHERE token = ?1',
  ).bind(String(token).toUpperCase()).first().catch(() => null);
  return {
    parent: row?.split_parent ?? null,
    split_at: row?.split_at ?? null,
    for_member: row?.split_for_member ?? null,
  };
}

/** The shares a split produced, with who each one was sent to and whether it is paid. */
export async function sharesFor(env, parentToken) {
  if (!env?.DB || !parentToken) return [];
  const out = await env.DB.prepare(
    `SELECT token, amount, currency, split_for_member, settled_at, paid_by_member, application_fee_minor
       FROM num_paylinks WHERE split_parent = ?1 ORDER BY created_at`,
  ).bind(String(parentToken).toUpperCase()).all().catch(() => null);
  return out?.results ?? [];
}

/**
 * Split a bill into one real code per person.
 *
 * `people` is [{ member_id, name }] — the first is whoever is doing the
 * splitting. `amounts` is optional: minor units per person, in the same order,
 * for an uneven split. Given neither, it splits evenly.
 */
export async function splitBill(env, parentToken, { people, amounts = null, by = null, note = null } = {}) {
  const parent = await billFor(env, parentToken);
  if (!parent) return { ok: false, status: 404, reason: 'unknown bill code' };
  if (!parent.fixed || !parent.amount_minor) return { ok: false, status: 422, reason: 'this code carries no amount to split' };
  if (parent.state === 'paid') return { ok: false, status: 409, reason: 'this bill is already paid' };
  if (parent.state !== 'open') return { ok: false, status: 410, reason: 'this bill code is no longer active' };

  const already = await splitStateOf(env, parent.token);
  if (already.split_at) return { ok: false, status: 409, reason: 'this bill has already been split' };
  if (already.parent) return { ok: false, status: 409, reason: 'a share cannot be split again' };

  // Contact details are carried through rather than dropped. A share for a
  // friend who is not on NUM has no member_id and used to have no way of
  // reaching anybody at all; the number their friend typed at the table is
  // the whole of what makes that share deliverable.
  const who = (people ?? []).map((p) => ({
    member_id: clip(p?.member_id, 40),
    name: clip(p?.name, 60),
    phone: clip(p?.phone, 20),
    email: clip(p?.email, 160),
  }));
  if (who.length < 2) return { ok: false, status: 422, reason: 'a split needs at least two people' };
  if (who.length > MAX_WAYS) return { ok: false, status: 422, reason: `${MAX_WAYS} ways is the most` };

  let parts;
  if (amounts) {
    if (!Array.isArray(amounts) || amounts.length !== who.length) {
      return { ok: false, status: 422, reason: 'one amount per person, please' };
    }
    parts = amounts.map((a) => Math.round(Number(a)));
    if (parts.some((a) => !Number.isInteger(a) || a <= 0)) return { ok: false, status: 422, reason: 'every share has to be more than zero' };
    const sum = parts.reduce((n, a) => n + a, 0);
    // Stated plainly rather than silently adjusted: a split that does not add
    // up is a venue short of money or a guest overcharged, and neither should
    // be fixed by code quietly moving somebody's number.
    if (sum !== parent.amount_minor) {
      return {
        ok: false, status: 422,
        reason: `those shares come to ${(sum / 100).toFixed(2)}, and the bill is ${parent.amount}`,
      };
    }
  } else {
    parts = evenShares(parent.amount_minor, who.length);
    if (!parts) return { ok: false, status: 422, reason: 'this bill is too small to split that many ways' };
  }

  // The fee, once, on the whole dinner — then divided so the parts sum to it.
  const fee = await feeForBill(env, parent);
  const feeParts = allocateFee(fee.minor, parts);

  // Mint the shares BEFORE closing the parent. If minting fails halfway the
  // parent is still payable in full, which is a working bill; closing it first
  // would leave a table with a dead code and no shares.
  const made = [];
  for (let i = 0; i < who.length; i += 1) {
    const amt = parseAmount((parts[i] / 100).toFixed(2));
    if (!amt.ok) return { ok: false, status: 422, reason: `share ${i + 1} is not a payable amount` };
    const one = await mintBillCode(env, {
      businessId: parent.business_id,
      // No booking on a share, deliberately. The commission belongs to the
      // dinner, and billqr.mjs accrues it once when the parent settles. A
      // booking here would have each share accrue on its own.
      bookingId: '',
      amount: amt.display,
      currency: parent.currency,
      label: who[i].name ? `${parent.label || 'Bill'} · ${who[i].name}` : `${parent.label || 'Bill'} · share ${i + 1}`,
      issuedBy: by,
    });
    if (!one?.ok) return { ok: false, status: 502, reason: one?.reason ?? 'could not mint a share', made: made.length };
    await env.DB.prepare(
      'UPDATE num_paylinks SET split_parent = ?2, split_for_member = ?3, application_fee_minor = ?4 WHERE token = ?1',
    ).bind(one.token, parent.token, who[i].member_id, feeParts[i]).run();
    made.push({
      token: one.token, member_id: who[i].member_id, name: who[i].name,
      phone: who[i].phone, email: who[i].email,
      amount_minor: parts[i], amount: amt.display, currency: parent.currency, fee_minor: feeParts[i],
    });
  }

  // Close the parent to direct payment, and only if it is still unpaid — a
  // guest who paid the whole thing in the seconds this took must not end up
  // with a settled bill and four live shares against it.
  const closed = await env.DB.prepare(
    "UPDATE num_paylinks SET split_at = datetime('now') WHERE token = ?1 AND settled_at IS NULL AND split_at IS NULL",
  ).bind(parent.token).run();
  if (!closed?.meta?.changes) {
    // Undo: the shares were never sent to anyone yet, so revoking them is free.
    await Promise.all(made.map((m) => env.DB.prepare(
      "UPDATE num_paylinks SET state = 'revoked', revoked_at = datetime('now') WHERE token = ?1 AND settled_at IS NULL",
    ).bind(m.token).run().catch(() => null)));
    return { ok: false, status: 409, reason: 'that bill was paid while it was being split' };
  }

  /* ── HANDING THE SHARES OVER ─────────────────────────────────────────
   *
   * This was one `notify()` per member_id and nothing else, which on 19 Sep
   * 2026 meant: zero push tokens on the whole member base, so zero people
   * told, and a share minted for a friend who is not on NUM got not even
   * that — it had no member_id to notify.
   *
   * billreach.mjs owns the ladder now: a link that always works, the in-app
   * row, a text under friendtext's consent rules, an email if we hold one.
   * The result is carried back so the app can say, per person, whether NUM
   * reached them or whether somebody has to pass the link along. That
   * distinction is the difference between a split that works and a split
   * that looks like it worked.
   *
   * Never allowed to fail the split. The shares are minted, the parent is
   * closed, the money is correct; a rail that would not carry a message is
   * not a reason to unwind any of that. */
  const splitter = by
    ? await env.DB.prepare('SELECT id, name, phone_verified FROM num_members WHERE id = ?1')
        .bind(by).first().catch(() => null)
    : null;

  const handed = await deliverShares(env, {
    shares: made,
    parent: {
      token: parent.token,
      venue: parent.venue,
      currency: parent.currency,
      business_id: parent.business_id,
    },
    from: splitter ?? {},
    note,
  }).catch((e) => {
    console.error('[billsplit] handing over the shares threw', String(e?.message ?? e).slice(0, 200));
    return null;
  });

  await track(env, {
    token: parent.token, businessId: parent.business_id, kind: 'split',
    memberId: by, amountMinor: parent.amount_minor,
    detail: `${made.length} ways`,
  });

  // Each share gets its link and the plain sentence about whether it was sent,
  // merged onto the row the app already renders, so there is one list on
  // screen rather than two that can disagree.
  const bySlug = new Map((handed?.shares ?? []).map((h) => [h.token, h]));
  const shares = made.map((m) => {
    const h = bySlug.get(m.token);
    return h ? { ...m, link: h.link, sent_by: h.reached, say: h.say, to: h.to } : m;
  });

  return {
    ok: true,
    parent: parent.token,
    currency: parent.currency,
    total_minor: parent.amount_minor,
    fee_minor: fee.minor,
    shares,
    // How many NUM itself got to a person, and how many are links for the
    // splitter to hand over. A handover is a real outcome, not a failure.
    reached: handed?.reached ?? 0,
    handover: handed?.handover ?? shares.length,
  };
}

export async function handleSplit(request, env, path) {
  const m = path.match(/^\/api\/bill\/([A-Za-z0-9]{4,40})\/split$/);
  if (!m) return null;
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (env.NUM_OFF_BILLSPLIT === '1') return json({ error: 'splitting is off just now' }, 503);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad body' }, 400); }
  const out = await splitBill(env, m[1], {
    people: body.people,
    amounts: body.amounts ?? null,
    by: clip(body.by, 40),
    // A line the splitter types — "the wine was mine" — carried into the
    // message their friend receives. Clipped here rather than trusted.
    note: clip(body.note, 120),
  });
  if (!out.ok) return json({ error: out.reason }, out.status ?? 400);
  return json(out);
}
