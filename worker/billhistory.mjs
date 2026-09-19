/**
 * Every bill a member has paid through NUM, and every tab they were part of.
 *
 * ── WHY THIS COULD NOT EXIST UNTIL NOW ───────────────────────────────────
 *
 * A bill recorded `issued_by` and `settled_by`, and both are STAFF ids. The
 * Stripe session carried the bill token and the business id and nothing about
 * the guest. So a member could pay twenty bills through NUM and there was no
 * row anywhere that said so. This was never a missing screen — it was a fact
 * nobody wrote down. Migration 0045 adds `paid_by_member`, billpay.mjs stamps
 * it when a signed-in member opens a payment page, and this reads it back.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────
 *
 * It will not guess. A bill paid in a browser by somebody who was not signed
 * in has no payer, and it does not appear in anybody's history — not the
 * nearest member, not the person who booked the table. Half the value of a
 * history is being able to trust that what is in it is yours.
 *
 * It also shows nothing that has not been PAID. A payer is stamped on intent,
 * the moment a payment page is opened, so an unsettled row means somebody
 * opened Stripe and walked away. Listing that as "a bill you paid" would be a
 * lie of exactly the kind this codebase keeps refusing to tell.
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const MAX = 100;

/**
 * Bills this member paid, newest first.
 *
 * The tables and columns arrive with migration 0045, so the whole read sits
 * behind a defined fallback: an empty history on a worker that has the code
 * and not the column is the truth as far as it can see, and it is a great deal
 * better than a 500 on somebody's account screen.
 */
export async function billsFor(env, memberId, { limit = 40 } = {}) {
  if (!env?.DB || !memberId) return [];
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || 40)), MAX);
  const out = await env.DB.prepare(
    `SELECT l.token, l.label, l.amount, l.currency, l.settled_at, l.charged_via,
            l.split_parent, l.business_id, b.name AS venue,
            (SELECT COUNT(*) FROM num_bill_items i WHERE i.token = l.token) AS item_count
       FROM num_paylinks l
       JOIN businesses b ON b.id = l.business_id
      WHERE l.paid_by_member = ?1 AND l.settled_at IS NOT NULL
      ORDER BY l.settled_at DESC
      LIMIT ?2`,
  ).bind(String(memberId), n).all().catch(() => null);

  return (out?.results ?? []).map((r) => ({
    token: r.token,
    venue: r.venue,
    label: r.label,
    amount: r.amount,
    currency: String(r.currency || 'THB').toUpperCase(),
    paid_at: r.settled_at,
    // 'card', 'pay_by_bank', 'autopay' … the rail that actually settled it,
    // not the one that was offered.
    via: r.charged_via || null,
    // A share of a bill somebody split. Worth saying on the row, because
    // "£18.75 at The Anchor" reads oddly next to a dinner for four.
    share_of: r.split_parent || null,
    items: Number(r.item_count) || 0,
  }));
}

/** What was on one of those bills. Empty is the normal case, not an error. */
export async function itemsOf(env, memberId, token) {
  if (!env?.DB || !memberId || !token) return null;
  const mine = await env.DB.prepare(
    'SELECT token FROM num_paylinks WHERE token = ?1 AND paid_by_member = ?2 AND settled_at IS NOT NULL',
  ).bind(String(token).toUpperCase(), String(memberId)).first().catch(() => null);
  if (!mine) return null; // not theirs, or not paid: the same answer either way
  const out = await env.DB.prepare(
    'SELECT name, qty, unit_minor, line_minor FROM num_bill_items WHERE token = ?1 ORDER BY pos',
  ).bind(mine.token).all().catch(() => null);
  return out?.results ?? [];
}

/**
 * Tabs this member is on — the shared ones, open and closed.
 *
 * Kept in the same answer as the bills because to a member they are one
 * question: what have I spent, and with whom. They are different things in the
 * database and stay different things here; nothing is added up across them,
 * because Stars on a tab and money on a bill are not the same unit and a
 * single total would be a number that means nothing.
 */
export async function tabsFor(env, memberId, { limit = 20 } = {}) {
  if (!env?.DB || !memberId) return [];
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || 20)), MAX);
  const out = await env.DB.prepare(
    `SELECT t.id, t.code, t.title, t.venue, t.state, t.created_at, t.closed_at,
            (SELECT COUNT(*) FROM num_tab_members m WHERE m.tab_id = t.id) AS people,
            (SELECT COALESCE(SUM(i.stars), 0) FROM num_tab_items i WHERE i.tab_id = t.id) AS stars
       FROM num_tabs t
       JOIN num_tab_members me ON me.tab_id = t.id AND me.member_id = ?1
      ORDER BY t.created_at DESC
      LIMIT ?2`,
  ).bind(String(memberId), n).all().catch(() => null);

  return (out?.results ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    venue: r.venue || null,
    state: r.state,
    people: Number(r.people) || 0,
    stars: Number(r.stars) || 0,
    opened_at: r.created_at,
    closed_at: r.closed_at || null,
  }));
}

/**
 * GET /api/bills?me=<id>            → bills and tabs
 * GET /api/bills/<token>?me=<id>    → what was on that one
 */
export async function handleBills(request, env, path) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  const url = new URL(request.url);
  const me = String(url.searchParams.get('me') ?? '').slice(0, 64);
  if (!me) return json({ error: 'who?' }, 401);

  const one = path.match(/^\/([A-Za-z0-9]{4,40})\/?$/);
  if (one) {
    const items = await itemsOf(env, me, one[1]);
    if (items === null) return json({ error: 'not one of your bills' }, 404);
    return json({ token: one[1].toUpperCase(), items });
  }

  const [bills, tabs] = await Promise.all([
    billsFor(env, me, { limit: url.searchParams.get('limit') ?? 40 }),
    tabsFor(env, me),
  ]);
  return json({ bills, tabs });
}
