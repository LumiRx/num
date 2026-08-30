/**
 * money — what NUM is owed, how it asks for it, and who gets paid afterwards.
 *
 * The shape of the money, stated once so nobody has to infer it:
 *
 *   guest → venue    DIRECT, bank to bank, at the table. NUM never holds it.
 *                    This is why NUM is not a Thai payment business and needs
 *                    no E-Payment Licence, and why a venue has its takings
 *                    before the guest stands up.
 *   venue → NUM      10% of bills from guests NUM sent, invoiced weekly.
 *                    This module.
 *   NUM   → host     the host's share of what NUM ACTUALLY COLLECTED. Never a
 *                    share of what NUM merely invoiced.
 *
 * That last rule is the one that matters. Paying a host out of money that has
 * not arrived turns a referral programme into a loan book, and the person who
 * discovers it is the one whose payout bounces.
 */

import { validAddress, ASSETS, quote } from './crypto.mjs';

const nowIso = () => new Date().toISOString();

export function newId(prefix, len = 12) {
  const A = '23456789abcdefghjkmnpqrstuvwxyz';
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < len; i++) s += A[b[i] % A.length];
  return prefix + s;
}

const money = (cs) => (Math.round(cs) / 100).toFixed(2);

/* ── the billing week ────────────────────────────────────────────────────── */

/**
 * The Monday-to-Sunday week that ENDED before `at`.
 *
 * Invoicing a week that has not finished means invoicing Saturday's dinners on
 * Saturday night, then again on Monday. Always bill a closed week.
 */
export function lastFullWeek(at = new Date()) {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay();                    // 0 Sun … 6 Sat
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(d);
  thisMonday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const start = new Date(thisMonday);
  start.setUTCDate(thisMonday.getUTCDate() - 7);
  const end = new Date(thisMonday);
  end.setUTCSeconds(-1);                        // Sunday 23:59:59
  return { start: start.toISOString(), end: end.toISOString() };
}

/* ── what a venue owes ───────────────────────────────────────────────────── */

/**
 * Everything owed and not yet on an invoice, for one venue.
 *
 * `awaiting_value` lines are counted but never summed. A booking we know
 * happened but whose bill we never saw is a real gap in collections, and a
 * total that quietly includes a guess is worse than a total with a caveat.
 */
export async function owed(env, businessId, { currency = null } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT id, booking_id, venue_name, category, rate_bp, basis_cs, amount_cs,
            currency, state, created_at, note
       FROM num_commissions
      WHERE business_id = ?1
        AND invoice_id IS NULL
        AND (paid_cs IS NULL OR paid_cs < COALESCE(amount_cs, 0))
        AND (?2 IS NULL OR currency = ?2)
      ORDER BY created_at`,
  ).bind(String(businessId), currency).all().catch(() => ({ results: [] }));

  const lines = results ?? [];
  const billable = lines.filter((l) => l.state === 'accrued' && (l.amount_cs ?? 0) > 0);
  return {
    lines,
    billable,
    awaiting: lines.filter((l) => l.state === 'awaiting_value').length,
    total_cs: billable.reduce((n, l) => n + l.amount_cs, 0),
    currency: billable[0]?.currency || lines[0]?.currency || 'THB',
  };
}

/**
 * Cut one invoice for one venue, for the closed week.
 *
 * Lines are stamped with the invoice id INSIDE the same pass that creates it,
 * so a line can never appear on two invoices. If the stamping half fails the
 * invoice is voided rather than left standing — an invoice whose lines are
 * still unclaimed will be reissued next Monday on top of itself.
 */
export async function invoiceVenue(env, businessId, { period = null, dueDays = 7 } = {}) {
  const p = period || lastFullWeek();
  const { results } = await env.DB.prepare(
    `SELECT id, amount_cs, currency FROM num_commissions
      WHERE business_id = ?1 AND invoice_id IS NULL AND state = 'accrued'
        AND COALESCE(amount_cs,0) > 0
        AND (paid_cs IS NULL OR paid_cs < amount_cs)
        AND created_at <= ?2
      ORDER BY created_at`,
  ).bind(String(businessId), p.end).all().catch(() => ({ results: [] }));

  const lines = results ?? [];
  if (!lines.length) return { ok: true, skipped: 'nothing owed' };

  // One invoice cannot be part baht and part dollars. Bill the majority
  // currency now; the rest is picked up by the next run rather than silently
  // added together at an exchange rate nobody agreed.
  const currency = lines[0].currency || 'THB';
  const same = lines.filter((l) => (l.currency || 'THB') === currency);
  const total = same.reduce((n, l) => n + (l.amount_cs || 0), 0);
  if (total <= 0) return { ok: true, skipped: 'nothing billable' };

  const id = newId('inv_');
  const due = new Date(Date.now() + dueDays * 86400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO num_invoices
       (id,business_id,period_start,period_end,currency,amount_cs,line_count,state,issued_at,due_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8,?9)`,
  ).bind(id, String(businessId), p.start, p.end, currency, total, same.length, nowIso(), due).run();

  let stamped = 0;
  for (const l of same) {
    const r = await env.DB.prepare(
      'UPDATE num_commissions SET invoice_id = ?2 WHERE id = ?1 AND invoice_id IS NULL',
    ).bind(l.id, id).run().catch(() => null);
    if (r?.meta?.changes) stamped++;
  }

  if (stamped !== same.length) {
    await env.DB.prepare(
      "UPDATE num_invoices SET state='void', note=?2 WHERE id=?1",
    ).bind(id, `stamped ${stamped}/${same.length} lines — voided rather than double-bill`).run();
    await env.DB.prepare('UPDATE num_commissions SET invoice_id = NULL WHERE invoice_id = ?1')
      .bind(id).run().catch(() => {});
    return { ok: false, reason: 'could not claim all lines; nothing invoiced' };
  }

  return { ok: true, id, currency, amount_cs: total, line_count: same.length, period: p, due_at: due };
}

/** Cut invoices for every venue with something owed. Safe to run twice. */
export async function invoiceAll(env, { period = null } = {}) {
  const p = period || lastFullWeek();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT business_id FROM num_commissions
      WHERE invoice_id IS NULL AND state='accrued' AND COALESCE(amount_cs,0) > 0
        AND business_id IS NOT NULL AND created_at <= ?1`,
  ).bind(p.end).all().catch(() => ({ results: [] }));

  const made = []; const skipped = [];
  for (const r of results ?? []) {
    const out = await invoiceVenue(env, r.business_id, { period: p });
    if (out.ok && out.id) made.push(out); else skipped.push({ business_id: r.business_id, ...out });
  }
  return { period: p, invoiced: made.length, made, skipped };
}

export async function invoicesFor(env, businessId, { limit = 24 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT id, period_start, period_end, currency, amount_cs, line_count, state,
            issued_at, due_at, paid_at, paid_cs, paid_ref
       FROM num_invoices WHERE business_id = ?1 ORDER BY issued_at DESC LIMIT ?2`,
  ).bind(String(businessId), limit).all().catch(() => ({ results: [] }));
  return results ?? [];
}

export async function invoiceLines(env, invoiceId) {
  const { results } = await env.DB.prepare(
    `SELECT id, booking_id, venue_name, category, rate_bp, basis_cs, amount_cs, currency, note, created_at
       FROM num_commissions WHERE invoice_id = ?1 ORDER BY created_at`,
  ).bind(String(invoiceId)).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/**
 * Record that a venue's payment arrived.
 *
 * Marks the invoice AND every line on it, because "paid" living only on the
 * invoice means `unpaid()` — the collections list — keeps showing lines that
 * were settled weeks ago.
 *
 * Releasing the host share is the last step and is deliberately after the
 * money is recorded: a host is paid out of what NUM collected, never out of
 * what NUM invoiced.
 */
export async function payInvoice(env, invoiceId, { ref = null, amountCs = null } = {}) {
  const inv = await env.DB.prepare(
    'SELECT id, business_id, amount_cs, currency, state FROM num_invoices WHERE id = ?1',
  ).bind(String(invoiceId)).first().catch(() => null);
  if (!inv) return { ok: false, reason: 'unknown invoice' };
  if (inv.state === 'void') return { ok: false, reason: 'that invoice was voided' };
  if (inv.state === 'paid') return { ok: true, already: true, id: inv.id };

  const paid = Number.isFinite(amountCs) && amountCs > 0 ? Math.round(amountCs) : inv.amount_cs;

  const flip = await env.DB.prepare(
    `UPDATE num_invoices SET state='paid', paid_at=?2, paid_cs=?3, paid_ref=?4
      WHERE id=?1 AND state='open'`,
  ).bind(inv.id, nowIso(), paid, ref).run();
  if (!flip?.meta?.changes) return { ok: true, already: true, id: inv.id };

  const lines = await invoiceLines(env, inv.id);
  for (const l of lines) {
    await env.DB.prepare(
      `UPDATE num_commissions SET paid_cs = COALESCE(amount_cs,0), paid_at = ?2 WHERE id = ?1`,
    ).bind(l.id, nowIso()).run().catch(() => {});
  }

  const released = await releaseHostShare(env, lines.map((l) => l.booking_id).filter(Boolean));
  return { ok: true, id: inv.id, paid_cs: paid, lines: lines.length, host_released: released.released };
}

/* ── NUM's own payment details ───────────────────────────────────────────── */

/**
 * Where a venue sends the 10%.
 *
 * Config, not a constant, and it fails loudly rather than inventing one. A
 * statement that renders a QR pointing at nothing would have venues paying a
 * PromptPay ID that does not exist, and the errors would arrive as "we paid
 * you weeks ago".
 */
export function payee(env) {
  const name = env.NUM_PAYEE_NAME || '5arz Inc';
  const id = String(env.NUM_PAYEE_PROMPTPAY || '').replace(/[^0-9]/g, '');

  // A wallet address is the rail that works today. PromptPay needs a Thai
  // bank account and 5arz is a Delaware company; USDC does not care where a
  // company is registered, so a venue can settle the 10% before the Thai
  // account exists. Both are offered when both are configured — the venue
  // picks.
  const wallet = validAddress(env.NUM_PAYEE_WALLET || '');
  const asset = env.NUM_PAYEE_ASSET || 'usdc-base';

  const methods = [];
  if (id) methods.push({ kind: 'promptpay', promptpay: id });
  if (wallet.ok && ASSETS[asset]) {
    methods.push({
      kind: 'crypto', address: wallet.address, asset_key: asset,
      asset: ASSETS[asset].asset, chain: ASSETS[asset].chain, label: ASSETS[asset].label,
    });
  }

  if (!methods.length) {
    return {
      ok: false,
      reason: 'NUM has no account to be paid into — set NUM_PAYEE_PROMPTPAY (Thai bank) ' +
              'or NUM_PAYEE_WALLET (a USDC address)',
    };
  }
  // `promptpay` is kept at the top level so the existing statement page and
  // its QR route keep working unchanged.
  return { ok: true, name, methods, promptpay: id || null };
}

/* ── hosts ───────────────────────────────────────────────────────────────── */

/**
 * Move a host's earnings along, but only as far as the money has actually got.
 *
 * `accrued` — the booking completed, we are owed.
 * `collected` — the VENUE HAS PAID US. Only now is the host's share real.
 * `payable` — queued for the next payout run.
 * `paid` — sent, with a reference.
 *
 * Called from payInvoice with the bookings that invoice covered. An earning
 * whose booking is not on a paid invoice is never touched.
 */
export async function releaseHostShare(env, bookingRefs = []) {
  const refs = (bookingRefs || []).map(String).filter(Boolean);
  if (!refs.length) return { released: 0 };

  let released = 0;
  for (const ref of refs) {
    const rows = await env.DB.prepare(
      `SELECT id, state FROM num_host_earnings WHERE booking_ref = ?1 AND state = 'accrued'`,
    ).bind(ref).all().catch(() => ({ results: [] }));
    for (const r of rows.results ?? []) {
      const done = await env.DB.prepare(
        `UPDATE num_host_earnings
            SET state='payable', collected_at=?2, payable_at=?2
          WHERE id=?1 AND state='accrued'`,
      ).bind(r.id, nowIso()).run().catch(() => null);
      if (done?.meta?.changes) released++;
    }
  }
  return { released };
}

/**
 * Build the payout run: everything payable, grouped by host.
 *
 * A run is a draft until somebody actually sends the money. Nothing is marked
 * paid here, because this function has no idea whether a transfer succeeded.
 */
export async function buildPayoutRun(env, { currency = null, minMinor = 0 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.host_id, e.currency, e.host_share_minor, e.booking_ref,
            h.name AS host_name, h.email AS host_email, h.status AS host_status
       FROM num_host_earnings e
       JOIN num_hosts h ON h.id = e.host_id
      WHERE e.state = 'payable'
        -- Already assigned to a run. Without this, building a second run
        -- before the first one is sent queues the same money twice and the
        -- host is paid twice — the earning stays 'payable' until the transfer
        -- is confirmed, so state alone cannot tell them apart.
        AND e.payout_ref IS NULL
        AND (?1 IS NULL OR e.currency = ?1)
      ORDER BY e.host_id, e.created_at`,
  ).bind(currency).all().catch(() => ({ results: [] }));

  const rows = (results ?? []).filter((r) => r.host_status !== 'ended');
  if (!rows.length) return { ok: true, skipped: 'nothing payable' };

  const byHost = new Map();
  for (const r of rows) {
    const key = r.host_id + '|' + r.currency;
    if (!byHost.has(key)) {
      byHost.set(key, {
        host_id: r.host_id, host_name: r.host_name, host_email: r.host_email,
        currency: r.currency, total_minor: 0, earning_ids: [], bookings: [],
      });
    }
    const g = byHost.get(key);
    g.total_minor += r.host_share_minor;
    g.earning_ids.push(r.id);
    g.bookings.push(r.booking_ref);
  }

  // A payout smaller than the fee to send it costs the host money. Those roll
  // into the next run rather than being sent.
  const hosts = [...byHost.values()].filter((h) => h.total_minor >= minMinor);
  const held = [...byHost.values()].filter((h) => h.total_minor < minMinor);
  if (!hosts.length) return { ok: true, skipped: 'all below the minimum', held: held.length };

  const currencyOut = hosts[0].currency;
  const same = hosts.filter((h) => h.currency === currencyOut);
  const id = newId('run_');
  const total = same.reduce((n, h) => n + h.total_minor, 0);

  await env.DB.prepare(
    `INSERT INTO num_payout_runs (id,currency,total_minor,host_count,line_count,state,created_at)
     VALUES (?1,?2,?3,?4,?5,'draft',?6)`,
  ).bind(id, currencyOut, total, same.length,
    same.reduce((n, h) => n + h.earning_ids.length, 0), nowIso()).run();

  // Stamp the earnings so a second run cannot pick up the same money.
  for (const h of same) {
    for (const eid of h.earning_ids) {
      await env.DB.prepare(
        "UPDATE num_host_earnings SET payout_ref = ?2 WHERE id = ?1 AND state='payable' AND payout_ref IS NULL",
      ).bind(eid, id).run().catch(() => {});
    }
  }

  return {
    ok: true, id, currency: currencyOut, total_minor: total,
    hosts: same.map((h) => ({
      host_id: h.host_id, name: h.host_name, email: h.host_email,
      amount: money(h.total_minor), lines: h.earning_ids.length, bookings: h.bookings,
    })),
    held: held.length,
  };
}

/** The money left. Marks every earning in the run paid, with the reference. */
export async function markPayoutSent(env, runId, { ref = null } = {}) {
  const run = await env.DB.prepare(
    'SELECT id, state FROM num_payout_runs WHERE id = ?1',
  ).bind(String(runId)).first().catch(() => null);
  if (!run) return { ok: false, reason: 'unknown run' };
  if (run.state === 'paid') return { ok: true, already: true, id: run.id };

  const flip = await env.DB.prepare(
    "UPDATE num_payout_runs SET state='paid', paid_at=?2, paid_ref=?3 WHERE id=?1 AND state='draft'",
  ).bind(run.id, nowIso(), ref).run();
  if (!flip?.meta?.changes) return { ok: true, already: true, id: run.id };

  const done = await env.DB.prepare(
    `UPDATE num_host_earnings SET state='paid', paid_at=?2
      WHERE payout_ref = ?1 AND state = 'payable'`,
  ).bind(run.id, nowIso()).run();

  return { ok: true, id: run.id, earnings_paid: done?.meta?.changes ?? 0 };
}

export async function hostLedger(env, hostId) {
  const { results } = await env.DB.prepare(
    `SELECT id, booking_ref, currency, booking_minor, our_commission_minor, host_share_minor,
            state, completed_at, collected_at, payable_at, paid_at, payout_ref
       FROM num_host_earnings WHERE host_id = ?1 ORDER BY created_at DESC LIMIT 200`,
  ).bind(String(hostId)).all().catch(() => ({ results: [] }));

  const rows = results ?? [];
  const sum = (state) => rows.filter((r) => r.state === state)
    .reduce((n, r) => n + r.host_share_minor, 0);
  return {
    lines: rows,
    // Named for what they mean to the host, not for our state machine.
    waiting_on_the_venue: sum('accrued'),
    due_to_you: sum('payable'),
    paid_to_you: sum('paid'),
    currency: rows[0]?.currency || 'GBP',
  };
}
