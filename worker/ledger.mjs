/**
 * One ledger, read by whoever is looking at it.
 *
 * ── WHY A VIEW AND NOT A TABLE ───────────────────────────────────────────
 *
 * Every fact this file reports is already written down somewhere: a settled
 * bill in num_paylinks, a fee in application_fee_minor, a commission in
 * num_commissions, a payout in num_venue_payouts. A ledger table would be a
 * second copy of all of it, and a second copy is a thing that can disagree
 * with the first. When it does, nobody can tell which one is the money.
 *
 * So this derives. It is slower and it cannot drift.
 *
 * ── WHAT A LEDGER IS FOR ─────────────────────────────────────────────────
 *
 * Not a balance. A balance is one number and a number cannot be checked. A
 * ledger is the LINES, in order, each one traceable to a thing that happened,
 * so a person can find the one that is wrong.
 *
 * That is not a philosophical point. On 19 Sep 2026, writing this file is what
 * surfaced that a venue is charged NUM's fee twice on every bill — once by
 * Stripe at source through `application_fee_amount`, and again on Monday's
 * invoice, because `invoiceVenue` bills every accrued commission line and
 * nothing marks a line as already collected. The two charges were in two
 * different tables read by two different screens and the arithmetic was
 * correct on both. Put them on one page in one order and it is the second
 * line down.
 *
 * So the two fees are DELIBERATELY separate entries here, rather than one
 * netted number. `fee_at_source` is money Stripe already moved.
 * `fee_invoiced` is money NUM has asked for. A bill showing both is being
 * charged twice, and a ledger that quietly added them would be hiding the
 * thing it exists to expose.
 *
 * ── THE THREE RULES ──────────────────────────────────────────────────────
 *
 *   1. NOTHING IS SUMMED ACROSS CURRENCIES OR UNITS. A venue that took
 *      dollars and baht has two totals. Stars on a tab and money on a bill
 *      are never one figure — the same rule the wallet keeps between Stars
 *      and USDC, for the same reason: a total of two unlike things is a
 *      number nobody can check. `growth/money.mjs` learned this the hard way
 *      when a ฿70 walk-in floor rendered as $70.00, thirty-three times.
 *   2. PENDING IS NEVER COUNTED AS SETTLED. A share minted for somebody is
 *      money owed, not money moved, and it appears in `open` rather than in
 *      any total.
 *   3. NOTHING IS INFERRED. A payout's status is whatever Stripe said. A
 *      bill with no payer stamped belongs to nobody and appears in nobody's
 *      ledger — not the nearest member, not whoever booked the table.
 */

export const ACTOR = Object.freeze({ MEMBER: 'member', BUSINESS: 'business' });

/** Which way the money went, from the point of view of whoever is reading. */
export const DIRECTION = Object.freeze({ IN: 'in', OUT: 'out' });

/**
 * Every kind of line, and what it means. A closed vocabulary, like
 * paytrack's, so a screen can be written against it and an unknown kind is a
 * bug rather than a surprise.
 */
export const ENTRY = Object.freeze({
  bill_paid: 'a bill you paid',
  share_paid: 'your share of a bill somebody split',
  share_owed: 'a share waiting for you to pay it',
  bill_settled: 'a guest paid a bill through NUM',
  fee_at_source: 'NUM’s fee, taken by Stripe out of that payment',
  fee_invoiced: 'NUM’s fee, billed on a statement',
  venue_share: 'NUM’s share of a priority seat, owed to you',
  payout: 'Stripe moved your balance to your bank',
});

const MAX = 200;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const upper = (c) => String(c || '').toUpperCase() || null;
const minor = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
/** Minor units to the string a person reads. Two decimals; no currency symbol
 *  is invented, because the code is what we actually know. */
const show = (m) => (m == null ? null : (m / 100).toFixed(2));

function entry({ at, kind, direction, amountMinor, currency, counterparty = null, ref = null, state = 'settled', note = null }) {
  return {
    at,
    kind,
    what: ENTRY[kind] ?? kind,
    direction,
    amount_minor: minor(amountMinor),
    amount: show(minor(amountMinor)),
    currency: upper(currency),
    counterparty,
    // 'settled' — it happened. 'pending' — it has not, and it is not in any
    // total. 'failed' — it was attempted and did not.
    state,
    ref,
    note,
  };
}

/* ── THE MEMBER ──────────────────────────────────────────────────────────
 * What one person has paid through NUM, and what is waiting for them.
 *
 * A bill with no `paid_by_member` has no payer and appears here for nobody.
 * That is not a gap to be filled by guessing at the nearest member: half the
 * worth of a history is being able to trust that everything in it is yours.
 */

export async function memberEntries(env, memberId, { limit = 60 } = {}) {
  if (!env?.DB || !memberId) return [];
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || 60)), MAX);
  const out = await env.DB.prepare(
    `SELECT l.token, l.label, l.amount, l.currency, l.settled_at, l.charged_via,
            l.split_parent, b.name AS venue
       FROM num_paylinks l
       JOIN businesses b ON b.id = l.business_id
      WHERE l.paid_by_member = ?1 AND l.settled_at IS NOT NULL
      ORDER BY l.settled_at DESC
      LIMIT ?2`,
  ).bind(String(memberId), n).all().catch(() => null);

  return (out?.results ?? []).map((r) => entry({
    at: r.settled_at,
    kind: r.split_parent ? 'share_paid' : 'bill_paid',
    direction: DIRECTION.OUT,
    // `amount` on a paylink is the major-unit string the venue typed. Minor
    // units are derived from it here rather than stored twice.
    amountMinor: Math.round(Number(r.amount) * 100),
    currency: r.currency,
    counterparty: r.venue,
    ref: r.token,
    // The rail that actually settled it, never the one that was offered.
    note: r.charged_via || null,
  }));
}

/**
 * Shares minted for this member that nobody has paid yet.
 *
 * Separate from the entries above and never added to them: this is money
 * owed. It is also the thing a member most wants to see, which is why it has
 * its own list rather than a state flag buried in a long history.
 */
export async function memberOpen(env, memberId, { limit = 20 } = {}) {
  if (!env?.DB || !memberId) return [];
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || 20)), MAX);
  const out = await env.DB.prepare(
    `SELECT l.token, l.amount, l.currency, l.created_at, l.split_parent, b.name AS venue
       FROM num_paylinks l
       JOIN businesses b ON b.id = l.business_id
      WHERE l.split_for_member = ?1
        AND l.settled_at IS NULL
        AND l.state = 'active'
        AND l.revoked_at IS NULL
      ORDER BY l.created_at DESC
      LIMIT ?2`,
  ).bind(String(memberId), n).all().catch(() => null);

  return (out?.results ?? []).map((r) => entry({
    at: r.created_at,
    kind: 'share_owed',
    direction: DIRECTION.OUT,
    amountMinor: Math.round(Number(r.amount) * 100),
    currency: r.currency,
    counterparty: r.venue,
    ref: r.token,
    state: 'pending',
    note: 'not paid yet',
  }));
}

/* ── THE BUSINESS ────────────────────────────────────────────────────────
 * What came in through NUM, what NUM took, and what Stripe moved.
 *
 * Three different sets of money and they are never one number. A Stripe
 * payout is the venue's WHOLE balance — their own card sales, their own
 * refunds, their own adjustments — and at a venue doing real trade most of it
 * never came near NUM. So a payout line sits in this ledger as a movement of
 * the venue's balance and is not summed with anything NUM settled.
 */

export async function businessEntries(env, businessId, { days = 90, limit = 120 } = {}) {
  if (!env?.DB || !businessId) return [];
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || 120)), MAX);
  const since = `-${Math.max(1, Math.floor(Number(days) || 90))} days`;

  // A split bill settles on the PARENT — that is where the money and the
  // commission both sit. Counting the shares as well would double the venue's
  // own takings on their own screen.
  const bills = await env.DB.prepare(
    `SELECT token, label, amount, currency, settled_at, charged_via, application_fee_minor
       FROM num_paylinks
      WHERE business_id = ?1
        AND settled_at IS NOT NULL
        AND split_parent IS NULL
        AND settled_at > datetime('now', ?2)
      ORDER BY settled_at DESC
      LIMIT ?3`,
  ).bind(String(businessId), since, n).all().catch(() => null);

  const lines = [];
  for (const r of bills?.results ?? []) {
    const amountMinor = Math.round(Number(r.amount) * 100);
    lines.push(entry({
      at: r.settled_at,
      kind: 'bill_settled',
      direction: DIRECTION.IN,
      amountMinor,
      currency: r.currency,
      ref: r.token,
      note: r.label || null,
    }));
    // The deduction, as its own line. See the header: netting this into the
    // figure above is how a venue is charged twice and nobody notices.
    const fee = minor(r.application_fee_minor);
    if (fee && fee > 0) {
      lines.push(entry({
        at: r.settled_at,
        kind: 'fee_at_source',
        direction: DIRECTION.OUT,
        amountMinor: fee,
        currency: r.currency,
        ref: r.token,
        note: `taken by Stripe from ${r.token} before it reached your balance`,
      }));
    }
  }

  // What NUM has ALSO asked for on a statement. `booking_id` is `bill:<token>`
  // on a bill line, which is how a fee taken at source and a fee invoiced can
  // be matched to the same bill by whoever reads this.
  const owed = await env.DB.prepare(
    `SELECT id, booking_id, amount_cs, currency, state, created_at, invoice_id, note
       FROM num_commissions
      WHERE business_id = ?1
        AND COALESCE(amount_cs, 0) > 0
        AND created_at > datetime('now', ?2)
      ORDER BY created_at DESC
      LIMIT ?3`,
  ).bind(String(businessId), since, n).all().catch(() => null);

  for (const c of owed?.results ?? []) {
    const onBill = String(c.booking_id || '').startsWith('bill:')
      ? String(c.booking_id).slice(5).toUpperCase()
      : null;
    lines.push(entry({
      at: c.created_at,
      kind: 'fee_invoiced',
      direction: DIRECTION.OUT,
      amountMinor: c.amount_cs,
      currency: c.currency,
      ref: onBill ?? c.booking_id ?? c.id,
      // 'accrued' is owed and not yet asked for; an invoice_id means it has
      // been. Copied, never inferred.
      state: c.invoice_id ? 'invoiced' : 'pending',
      note: c.note || null,
    }));
  }

  /* TWO TABLES WITH PAYOUT IN THE NAME, AND THEY RUN IN OPPOSITE DIRECTIONS.
   *
   * `num_business_payouts` is STRIPE moving the venue's own balance to the
   * venue's own bank — the venue's money, most of which never came near NUM.
   * `num_venue_payouts` is NUM owing the venue a share of a priority-seating
   * fee a guest paid US — money coming the other way.
   *
   * Confusing them would put a venue's own bank transfer on their screen as
   * income from NUM, which is why both are read here by name. */
  const payouts = await env.DB.prepare(
    `SELECT id, amount_minor, currency, status, arrives_on, failure, created_at
       FROM num_business_payouts
      WHERE business_id = ?1
      ORDER BY created_at DESC
      LIMIT 12`,
  ).bind(String(businessId)).all().catch(() => null);

  for (const p of payouts?.results ?? []) {
    lines.push(entry({
      at: p.created_at,
      kind: 'payout',
      direction: DIRECTION.OUT,
      amountMinor: p.amount_minor,
      currency: p.currency,
      ref: p.id,
      // Stripe's word, copied. A failed payout must not read as arriving and
      // one in transit must not read as paid.
      state: p.status === 'paid' ? 'settled' : p.status,
      note: p.failure || (p.arrives_on ? `expected ${p.arrives_on}` : null),
    }));
  }

  // NUM's side: a share of a priority seat, owed to the venue. Only 'paid' is
  // settled — 'accrued' and 'payable' are money that has not moved, and a
  // venue reading a payable line as arrived would be planning around it.
  const shares = await env.DB.prepare(
    `SELECT id, booking_id, amount_cs, currency, state, created_at, paid_at
       FROM num_venue_payouts
      WHERE business_id = ?1
        AND state <> 'void'
        AND created_at > datetime('now', ?2)
      ORDER BY created_at DESC
      LIMIT 40`,
  ).bind(String(businessId), since).all().catch(() => null);

  for (const v of shares?.results ?? []) {
    lines.push(entry({
      at: v.paid_at || v.created_at,
      kind: 'venue_share',
      direction: DIRECTION.IN,
      amountMinor: v.amount_cs,
      currency: v.currency,
      ref: v.booking_id,
      state: v.state === 'paid' ? 'settled' : 'pending',
      note: v.state === 'paid' ? null : 'not paid out yet',
    }));
  }

  return lines.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* ── TOTALS ──────────────────────────────────────────────────────────────── */

/**
 * One total per currency per kind. Never one figure.
 *
 * Pending lines are excluded — they are money that has not moved, and a total
 * that includes them is a forecast wearing a ledger's clothes.
 */
export function totals(entries) {
  const by = new Map();
  for (const e of entries) {
    if (e.state !== 'settled' || e.amount_minor == null || !e.currency) continue;
    const key = `${e.currency}|${e.kind}`;
    by.set(key, (by.get(key) ?? 0) + e.amount_minor);
  }
  return [...by.entries()]
    .map(([key, m]) => {
      const [currency, kind] = key.split('|');
      return { currency, kind, what: ENTRY[kind] ?? kind, amount_minor: m, amount: show(m) };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.kind.localeCompare(b.kind));
}

/**
 * Bills carrying BOTH a fee taken at source and a fee on a statement.
 *
 * This is a defect detector, not a feature, and it lives here because this is
 * the only place both facts are in one list. While
 * `growth/money.mjs:invoiceVenue` bills every accrued line regardless of what
 * Stripe already took, this returns rows; when that is fixed it returns none,
 * and a venue console showing a non-empty list is a venue being overcharged
 * right now.
 */
export function chargedTwice(entries) {
  const source = new Map();
  for (const e of entries) {
    if (e.kind === 'fee_at_source' && e.ref) source.set(e.ref, e);
  }
  const out = [];
  for (const e of entries) {
    if (e.kind !== 'fee_invoiced' || !e.ref) continue;
    const s = source.get(e.ref);
    if (!s) continue;
    out.push({
      bill: e.ref,
      currency: e.currency,
      at_source_minor: s.amount_minor,
      invoiced_minor: e.amount_minor,
      invoiced_state: e.state,
      why: 'this bill has a fee taken by Stripe at source AND a fee on a statement',
    });
  }
  return out;
}

/* ── THE ANSWER ──────────────────────────────────────────────────────────── */

/**
 * One shape for every actor, so a screen written for a member works for a
 * venue. `open` is always its own list and is never folded into `totals`.
 */
export async function ledgerFor(env, { actor, id, days = 90, limit = 120 } = {}) {
  if (!env?.DB || !id) return { actor, entries: [], open: [], totals: [], currencies: [] };

  const entries = actor === ACTOR.BUSINESS
    ? await businessEntries(env, id, { days, limit })
    : await memberEntries(env, id, { limit });
  const open = actor === ACTOR.BUSINESS ? [] : await memberOpen(env, id);

  return {
    actor,
    entries,
    open,
    totals: totals(entries),
    // Said out loud so a screen never has to guess whether it is showing one
    // currency or three.
    currencies: [...new Set(entries.map((e) => e.currency).filter(Boolean))].sort(),
    ...(actor === ACTOR.BUSINESS ? { charged_twice: chargedTwice(entries) } : {}),
  };
}

/**
 * GET /api/ledger?me=<member id>
 * GET /api/ledger?business=<business id>   (behind the console's own auth)
 */
export async function handleLedger(request, env) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  const url = new URL(request.url);
  const me = String(url.searchParams.get('me') ?? '').slice(0, 64);
  if (!me) return json({ error: 'who?' }, 401);
  const out = await ledgerFor(env, {
    actor: ACTOR.MEMBER,
    id: me,
    limit: url.searchParams.get('limit') ?? 60,
  });
  return json(out);
}
