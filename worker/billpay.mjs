/**
 * billpay.mjs — a guest paying a NUM bill code THROUGH NUM, on the venue's
 * own Stripe account.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────────
 *
 *   staff/POS mints a bill code (billqr.mjs)   →  /p/<token> shows the rails
 *   guest picks a Stripe rail                  →  GET /api/bill/<token>/checkout?rail=card
 *   this file creates a Checkout Session ON THE VENUE'S CONNECTED ACCOUNT
 *   (Stripe-Account header — a DIRECT charge) with NUM's application fee
 *   Stripe hosts the payment page              →  guest pays
 *   Stripe signs checkout.session.completed    →  POST /api/pay/webhook/connect
 *   settleBillCode() writes the ledger, markPaid() records the fee collected
 *
 * The venue is merchant of record. Disputes are theirs. The fee is NUM's and
 * arrives in NUM's balance without NUM ever holding the bill. That is the
 * §8 rule ("money never rests with us") kept, with the collection problem
 * money.mjs describes — 10% invoiced weekly and paid never — solved at source.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 *
 * No card numbers (Checkout is Stripe-hosted), no destination charges, no
 * transfers, no `on_behalf_of` — any of those would route the money through
 * NUM's account. No manual capture: a bill code is fixed-amount by staff or
 * POS before it is minted, so the figure is already confirmed; the
 * wrong-figure case is a refund with `refund_application_fee=true`, and
 * manual capture would also rule out every non-card rail.
 *
 * ── THE FEE, AND WHY IT MIRRORS THE LEDGER ───────────────────────────────
 *
 * feeForBill() computes what settleBillCode() will accrue: the venue's
 * commission_bp on a bill tied to a verified booking, the flat walk-in floor
 * otherwise. It reads the SAME columns commission.mjs reads. If the two ever
 * disagree, markPaid() records what was actually collected and the venue's
 * statement shows both — never a silent mismatch.
 */

import { stripeCall, verifyStripeSig } from './pay.mjs';
import { settleBillCode, parseAmount } from './billqr.mjs';
import { floorFor, markPaid } from './commission.mjs';
import { RAILS, railsFor, venueRails, checkoutTypesFor, guestFromRequest, actionFor } from './payrails.mjs';
// The till lives in growth/ because the venue console is served from
// num-growth — but the Stripe webhook lands HERE, on num-app, so this is the
// process that knows a bill was paid and therefore the only one that can
// close the check. One module, bundled into both, rather than a second copy
// that can disagree about what "closed" means.
import { recordExternalPayment } from '../growth/pos/index.mjs';
import { attemptAutoPay } from './autopay.mjs';
import { itemsFor } from './billitems.mjs';
import { track } from './paytrack.mjs';
// 5arz lives in growth/ because the host board is served from num-growth, but
// a bill settles HERE, on num-app. Same reasoning as the POS adapter above:
// one module bundled into both, rather than two copies that can disagree
// about what a binding is.
import { bindTransaction } from '../growth/fivearz.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const SITE = (env) => env.SITE || 'https://itsnum.com';

/** Currencies Stripe treats as zero-decimal; the bill's minor units are already whole. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF']);
const stripeAmount = (minor, currency) => (ZERO_DECIMAL.has(String(currency).toUpperCase()) ? Math.round(minor / 100) : minor);

/** How long a Stripe Checkout session lives. Thirty is Stripe's floor. */
const SESSION_MIN = 30;
/**
 * The idempotency window, deliberately shorter than SESSION_MIN so that a
 * session handed back from a replayed request always has real time left on it.
 * See the note in createBillCheckout.
 */
const WINDOW_MIN = 25;

/** The bill code, the venue it belongs to, and whether it can still be paid. */
export async function billFor(env, tokenValue) {
  const token = String(tokenValue ?? '').trim().toUpperCase();
  if (!token || !env?.DB) return null;
  const row = await env.DB.prepare(
    `SELECT l.token, l.business_id, l.label, l.kind, l.amount, l.currency, l.amount_mode, l.state,
            l.booking_id, l.settled_at, l.created_at, l.one_time, b.name AS venue
       FROM num_paylinks l JOIN businesses b ON b.id = l.business_id
      WHERE l.token = ?1`,
  ).bind(token).first();
  if (!row) return null;
  const amt = row.amount_mode === 'fixed' ? parseAmount(row.amount) : { ok: false };
  return {
    token: row.token, business_id: row.business_id, venue: row.venue, label: row.label,
    kind: row.kind, currency: String(row.currency || 'THB').toUpperCase(),
    amount_minor: amt.ok ? amt.minor : null, amount: amt.ok ? amt.display : null,
    fixed: row.amount_mode === 'fixed', one_time: Number(row.one_time) === 1,
    booking_id: row.booking_id || null,
    state: row.settled_at ? 'paid' : row.state === 'active' ? 'open' : row.state,
    settled_at: row.settled_at || null, created_at: row.created_at,
  };
}

/**
 * The bill, plus the two things a guest looking at it needs that the row
 * itself does not carry: what was on it, and whether it has been split.
 *
 * Both read behind a defined fallback — the lines table and the split columns
 * arrive with migration 0045, and a pay page that 500s between the deploy and
 * the migration is the failure migrationhygiene.test.mjs exists to describe.
 * No lines is the normal case, not an error: most bills are a total.
 */
async function decorate(env, bill) {
  if (!bill) return bill;
  const [items, split] = await Promise.all([
    itemsFor(env, bill.token),
    env.DB.prepare('SELECT split_parent, split_at FROM num_paylinks WHERE token = ?1')
      .bind(bill.token).first().catch(() => null),
  ]);
  // A split parent is not payable — its shares are. Saying so in `state` means
  // every surface refuses it without any of them having to know why.
  const state = bill.state === 'open' && split?.split_at ? 'split' : bill.state;
  return {
    ...bill,
    state,
    items: items ?? [],
    split_parent: split?.split_parent ?? null,
    split_at: split?.split_at ?? null,
  };
}

/**
 * Every rail this bill can be paid by, with the URL that starts each one.
 * ONE list, read by the pay page, the app and the console.
 */
export async function billRails(env, tokenValue, guest = {}) {
  const out = await billAndRails(env, tokenValue, guest);
  if (!out) return null;
  // The venue is TRIMMED on the way out. The full record carries the connected
  // Stripe account id, and this answer is served to a guest's browser.
  return { bill: out.bill, venue: { id: out.venue.id, name: out.venue.name, country: out.venue.country }, rails: out.rails };
}

/**
 * The same read, with the venue's full record kept.
 *
 * createBillCheckout used to call billRails and then venueRails AGAIN, because
 * it needed the connected account id that billRails deliberately strips. That
 * is a second round trip to D1 on the one path where a guest is waiting with
 * their thumb on a button. One read, two callers, one of which trims.
 */
async function billAndRails(env, tokenValue, guest = {}) {
  const bill = await decorate(env, await billFor(env, tokenValue));
  if (!bill) return null;
  const venue = await venueRails(env, bill.business_id);
  if (!venue) return null;
  const rails = railsFor({ ...venue, currency: bill.currency }, guest).map((r) => ({
    ...r, action: actionFor(env, r, bill.token),
  }));
  return { bill, venue, rails };
}

/**
 * What NUM takes at source, in the bill's minor units. Mirrors settleBillCode:
 *   booking verified against this venue → commission_bp (default 10%) of the bill
 *   otherwise                            → the flat walk-in floor (walkin_fee_cs or floorFor)
 * A percentage line already written for the booking wins over the default, so a
 * negotiated rate in num_business_settings is honoured the same way the ledger does.
 */
export async function feeForBill(env, bill) {
  if (!bill?.amount_minor) return { minor: 0, basis: 'none' };

  // A SHARE OF A SPLIT BILL CARRIES ITS OWN ALLOCATION.
  //
  // Computed once, in billsplit.mjs, where every share is in hand and the
  // parts can be made to sum to exactly the fee on the whole dinner. Working
  // it out again here, one share at a time, is how four shares end up adding
  // to a penny more or less than the fee the venue's own terms say — so this
  // reads what was decided rather than deciding again.
  //
  // These three reads are independent of each other and used to run one after
  // another, which is three sequential round trips to D1 on the path where a
  // guest is waiting for a payment page to open. Nothing here reads anything
  // another one writes, so they go together.
  const [share, terms, verified] = await Promise.all([
    env.DB.prepare('SELECT split_parent, application_fee_minor FROM num_paylinks WHERE token = ?1')
      .bind(bill.token).first().catch(() => null),
    env.DB.prepare('SELECT commission_bp, walkin_fee_cs FROM num_business_settings WHERE business_id = ?1')
      .bind(bill.business_id).first().catch(() => null),
    bill.booking_id
      ? env.DB.prepare('SELECT id FROM num_bookings WHERE id = ?1 AND business_id = ?2')
        .bind(String(bill.booking_id), bill.business_id).first().catch(() => null)
      : Promise.resolve(null),
  ]);
  if (share?.split_parent) {
    const minor = Number(share.application_fee_minor);
    return {
      minor: Number.isFinite(minor) && minor > 0 ? Math.min(minor, bill.amount_minor - 1) : 0,
      basis: 'split_share',
    };
  }

  if (verified) {
    const bp = Number.isFinite(terms?.commission_bp) && terms.commission_bp > 0 ? terms.commission_bp : 1000;
    const minor = Math.round((bill.amount_minor * bp) / 10_000);
    return { minor: Math.min(minor, bill.amount_minor - 1), basis: 'percentage', rate_bp: bp };
  }
  const flat = Number.isFinite(terms?.walkin_fee_cs) && terms.walkin_fee_cs > 0 ? terms.walkin_fee_cs : floorFor(bill.currency);
  return { minor: Math.min(flat, Math.max(0, bill.amount_minor - 1)), basis: 'flat' };
}

/**
 * Mint the Checkout Session on the venue's account and hand back the URL.
 * Refuses, with the reason, rather than guessing: an unpaid bill with a
 * clear "why not" beats a session that goes nowhere.
 */
export async function createBillCheckout(env, tokenValue, railId, { guest = {}, me = null } = {}) {
  if (!env?.STRIPE_SECRET_KEY) return { ok: false, status: 503, reason: 'payments are not configured on this worker' };
  const out = await billAndRails(env, tokenValue, { ...guest, signedIn: true });
  if (!out) return { ok: false, status: 404, reason: 'unknown bill code' };
  const { bill, rails, venue } = out;
  if (bill.state === 'paid') return { ok: false, status: 409, reason: 'this bill is already paid' };
  // A split bill is paid by its shares. Leaving the parent payable is how one
  // dinner gets paid twice — a friend paying their share while somebody else,
  // looking at the code still on the table, pays the lot.
  if (bill.state === 'split') return { ok: false, status: 409, reason: 'this bill was split — pay your own share instead' };
  if (bill.state !== 'open') return { ok: false, status: 410, reason: 'this bill code is no longer active' };
  if (!bill.fixed || !bill.amount_minor) return { ok: false, status: 422, reason: 'this code carries no amount — ask staff for a bill code' };

  const rail = rails.find((r) => r.id === railId && r.source === 'stripe' && r.ready);
  if (!rail) return { ok: false, status: 422, reason: `${RAILS[railId]?.label ?? railId} is not available for this bill` };
  const types = checkoutTypesFor(rails, { only: railId });
  if (!types.length) return { ok: false, status: 422, reason: 'no Stripe payment type for that rail' };

  const fee = await feeForBill(env, bill);
  const site = SITE(env);
  const body = {
    mode: 'payment',
    client_reference_id: bill.token,
    'metadata[num_bill_token]': bill.token,
    'metadata[num_business_id]': bill.business_id,
    'metadata[num_rail]': railId,
    'payment_intent_data[metadata][num_bill_token]': bill.token,
    'payment_intent_data[metadata][num_rail]': railId,
    'payment_intent_data[description]': `${bill.venue} · ${bill.label || 'Bill'} · NUM ${bill.token}`,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': bill.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': stripeAmount(bill.amount_minor, bill.currency),
    'line_items[0][price_data][product_data][name]': `${bill.label || 'Bill'} at ${bill.venue}`,
    success_url: `${site}/p/${encodeURIComponent(bill.token)}?paid=1`,
    cancel_url: `${site}/p/${encodeURIComponent(bill.token)}`,
    // Checkout's floor is 30 minutes; a bill code lives 90. Thirty is right:
    // a session opened at the table is paid at the table or abandoned.
    expires_at: Math.floor(Date.now() / 1000) + SESSION_MIN * 60,
  };
  if (fee.minor > 0) body['payment_intent_data[application_fee_amount]'] = stripeAmount(fee.minor, bill.currency);
  types.forEach((t, i) => { body[`payment_method_types[${i}]`] = t; });

  // ── WHY THE IDEMPOTENCY KEY CARRIES A TIME WINDOW ────────────────────
  //
  // Stripe replays an idempotent request for 24 hours. With a fixed key of
  // `bill:<token>:<rail>`, the SECOND tap on a rail did not create a second
  // session — it returned the first one, byte for byte, including its URL.
  // That is exactly right for a double-tap and exactly wrong thirty-one
  // minutes later: the session has expired, the bill has not (it lives 90
  // minutes), and a guest who opened the page, ordered another drink and came
  // back met a dead Stripe page on a live bill with no way forward but to ask
  // staff. The bill was fine the whole time. The app just kept handing them a
  // corpse.
  //
  // So the key carries a window shorter than the session's life. Inside one
  // window a retry is still idempotent, which is what protects a double-tap on
  // a bad connection; across windows a fresh session is minted, which is what
  // the guest actually needs. The worst case is one redundant session created
  // near a boundary, which simply expires unpaid — creating a spare page costs
  // nothing, handing back a dead one costs the table.
  const window = Math.floor(Date.now() / (WINDOW_MIN * 60_000));
  const idem = `bill:${bill.token}:${railId}:${window}`;
  let session;
  try {
    session = await stripeCall(env, '/checkout/sessions', body, idem, 'POST', { account: venue.stripe_account_id });
  } catch (e) {
    // The venue's account may not have this method switched on in its own
    // Stripe dashboard. Card is always on. Fall to card ONCE, say so, and
    // never silently for a non-card rail the guest explicitly chose.
    if (types[0] !== 'card' && /payment_method_type|payment method/i.test(e?.message ?? '')) {
      await track(env, { token: bill.token, businessId: bill.business_id, kind: 'checkout_refused', rail: railId, memberId: me, detail: `${rail.label} is not switched on in this venue's Stripe account` });
      return { ok: false, status: 422, reason: `${rail.label} is not switched on in ${bill.venue}'s Stripe account yet — choose another way to pay`, stripe: e.message };
    }
    await track(env, { token: bill.token, businessId: bill.business_id, kind: 'checkout_refused', rail: railId, memberId: me, detail: e?.message ?? 'Stripe refused' });
    return { ok: false, status: 502, reason: 'Stripe refused to open the payment page', stripe: e?.message ?? String(e) };
  }
  if (!session?.url) {
    await track(env, { token: bill.token, businessId: bill.business_id, kind: 'checkout_refused', rail: railId, memberId: me, detail: 'Stripe returned no payment page' });
    return { ok: false, status: 502, reason: 'Stripe returned no payment page' };
  }

  // Remember the session on the bill. The columns arrive with migration 0035;
  // before it the webhook still settles by metadata, so a failure here is
  // logged and is not a reason to lose the guest's payment page.
  await env.DB.prepare(
    'UPDATE num_paylinks SET checkout_session_id = ?2, charged_via = ?3, application_fee_minor = ?4 WHERE token = ?1',
  ).bind(bill.token, session.id, railId, fee.minor).run().catch((e) => console.warn('[billpay] could not stamp session', e?.message));

  // WHO IS PAYING, written down at last — and on INTENT, not on success.
  //
  // This is the only moment NUM knows: the webhook arrives from Stripe with
  // the bill token and the venue and nothing about the guest. It means nothing
  // on its own until settled_at is set beside it, because a member who opened
  // a payment page and walked away has not paid anything and their history
  // must not say they did.
  //
  // DELIBERATELY ITS OWN STATEMENT, and it was briefly folded into the one
  // above to save a round trip. That was wrong: paid_by_member arrives with
  // migration 0045, so a combined UPDATE fails whole on any database that has
  // the code and not the column — and it would take the session id and the fee
  // down with it, which is the bill's own record of what it charged. A round
  // trip is cheaper than a migration ordering constraint.
  if (me) {
    await env.DB.prepare('UPDATE num_paylinks SET paid_by_member = ?2 WHERE token = ?1')
      .bind(bill.token, String(me).slice(0, 64)).run()
      .catch((e) => console.warn('[billpay] could not stamp the payer', e?.message));
  }



  await track(env, {
    token: bill.token, businessId: bill.business_id, kind: 'checkout_opened',
    rail: railId, memberId: me, amountMinor: bill.amount_minor,
  });

  return { ok: true, url: session.url, session_id: session.id, fee, types, expires_at: body.expires_at };
}

/**
 * POST /api/pay/webhook/connect — events Stripe sends for the venues'
 * connected accounts. Signed with its OWN endpoint secret
 * (STRIPE_CONNECT_WEBHOOK_SECRET); no secret means no webhook, exactly as the
 * platform endpoint behaves. Idempotent: settleBillCode() flips settled_at
 * once and markPaid() rewrites the same paid_cs.
 */
/**
 * Bind the human behind a paid bill, at 5arz.
 *
 * ── WHY HERE, AND WHY THIS IS THE FIRST CALLER ───────────────────────────
 *
 * growth/fivearz.mjs has carried bindTransaction since it was written, fully
 * tested, with no caller anywhere in the codebase. Its own comment calls it
 * "5arz revenue surface #3", and it says plainly that it must be called AFTER
 * a payment settles, because binding an unpaid job records a human behind
 * money that never moved. Until bill pay there was no settled payment with a
 * member behind it to bind. Now there is, and this is it.
 *
 * Three guards, all of which are the point rather than caution:
 *
 * - Only a bill we KNOW a member paid. paid_by_member is stamped on intent and
 *   means nothing until settled_at sits beside it; binding a bill with no
 *   payer would assert a human we cannot name.
 * - Never blocks, never throws, never retried. The money moved seconds ago. A
 *   partner being down is not a reason to fail a webhook and have Stripe retry
 *   a settled bill.
 * - Off unless FIVEARZ_API_KEY is set, and killable with NUM_OFF_BILLBIND.
 */
async function bindHuman(env, bill, memberId) {
  if (!memberId || !env?.FIVEARZ_API_KEY || env.NUM_OFF_BILLBIND === '1') return null;
  try {
    const out = await bindTransaction(env, {
      paymentRef: bill.token,
      memberId,
      // Which venue the money went to. 5arz stores it as the work reference;
      // it is the only piece of context that makes a binding legible later.
      workRef: bill.business_id,
    });
    if (!out?.ok) console.warn('[billpay] 5arz did not bind', bill.token, out?.error ?? '');
    return out;
  } catch (e) {
    console.warn('[billpay] 5arz bind threw', String(e?.message ?? e).slice(0, 120));
    return null;
  }
}

/**
 * Close the check in the venue's own till, once the ledger is written.
 *
 * Never in a way that can turn a successful payment into a failed one: the
 * guest's money moved several seconds ago. A till that refuses is logged and
 * left for the venue's POS panel to show — a member of staff clearing one
 * check by hand is a small annoyance; a webhook that 500s and makes Stripe
 * retry a settled bill is not.
 */
async function closeTill(env, bill) {
  const link = await env.DB.prepare(
    'SELECT pos_vendor, pos_order_id, pos_closed_at, application_fee_minor FROM num_paylinks WHERE token = ?1',
  ).bind(bill.token).first().catch(() => null);
  if (!link?.pos_order_id || link.pos_closed_at) return null;
  const pos = await recordExternalPayment(env, bill.business_id, {
    orderId: link.pos_order_id,
    amountMinor: bill.amount_minor,
    currency: bill.currency,
    reference: bill.token,
    feeMinor: Number(link.application_fee_minor) || null,
  }).catch((e) => ({ ok: false, reason: e?.message ?? 'till unreachable' }));
  if (pos?.ok) {
    await env.DB.prepare("UPDATE num_paylinks SET pos_closed_at = datetime('now') WHERE token = ?1")
      .bind(bill.token).run().catch(() => null);
    await track(env, { token: bill.token, businessId: bill.business_id, kind: 'till_closed', rail: link.pos_vendor ?? null });
  } else {
    console.warn('[billpay] the bill is paid but the check is still open in the till:', bill.token, pos?.reason);
    // The one failure a guest feels at the door, so it is recorded where the
    // venue's own console can show it rather than only in a log nobody reads.
    await track(env, {
      token: bill.token, businessId: bill.business_id, kind: 'till_failed',
      rail: link.pos_vendor ?? null, detail: pos?.reason ?? 'till unreachable',
    });
  }
  return pos;
}

export async function handleConnectWebhook(request, env) {
  const payload = await request.text();
  const ok = await verifyStripeSig(env, payload, request.headers.get('Stripe-Signature'), env.STRIPE_CONNECT_WEBHOOK_SECRET);
  if (!ok) {
    console.warn('[billpay] connect webhook rejected — bad or missing signature');
    return json({ error: 'bad signature' }, 400);
  }
  let event = {};
  try { event = JSON.parse(payload); } catch { return json({ error: 'bad payload' }, 400); }
  const account = event.account || null;

  if (event.type === 'checkout.session.completed') {
    const s = event.data?.object ?? {};
    if (s.payment_status && s.payment_status !== 'paid') return json({ received: true, ignored: 'unpaid' });
    const token = s.metadata?.num_bill_token || s.client_reference_id;
    if (!token) return json({ received: true, ignored: 'not a bill' });
    const settled = await settleBillCode(env, token, { settledBy: `stripe:${account ?? 'connect'}` });
    // Record what NUM collected at source against the line the ledger wrote.
    const bill = await billFor(env, token);
    const fee = Number(s.payment_intent_data?.application_fee_amount) || null;
    if (settled?.ok && bill) {
      // ── WHICH LINE DOES THIS MONEY BELONG TO ───────────────────────────
      //
      // Normally the bill that was just paid. But a SHARE of a split bill has
      // no line of its own: four friends splitting one dinner are one dinner,
      // and billqr.mjs accrues the commission once, on the parent, when the
      // shares cover it. So a share records nothing here, and the moment the
      // last one lands the parent's settlement reports the fees every share
      // collected — recorded once, against the parent's line.
      // Who paid it, read back rather than assumed: the webhook itself carries
      // nothing about the guest, and paid_by_member only counts now that
      // settled_at is beside it.
      const payer = (await env.DB.prepare('SELECT paid_by_member FROM num_paylinks WHERE token = ?1')
        .bind(bill.token).first().catch(() => null))?.paid_by_member ?? null;
      await bindHuman(env, bill, payer);
      await track(env, {
        token: bill.token, businessId: bill.business_id, memberId: payer,
        kind: settled.split_parent ? 'share_paid' : 'paid',
        rail: s.metadata?.num_rail ?? 'stripe',
        amountMinor: bill.amount_minor,
        detail: settled.split_parent ? `share of ${settled.split_parent}` : null,
      });
      if (settled.split_parent) {
        const p = settled.parent;
        if (p?.settled && Number.isFinite(p.fees_minor) && p.fees_minor >= 0) {
          const parentBill = await billFor(env, settled.split_parent);
          const key = p.result?.booking_id || `bill:${settled.split_parent}`;
          await markPaid(env, key, p.fees_minor);
          await track(env, {
            token: settled.split_parent, businessId: bill.business_id, kind: 'paid',
            rail: 'split', amountMinor: parentBill?.amount_minor ?? null,
            detail: 'every share landed',
          });
          if (parentBill) await closeTill(env, parentBill);
        }
      } else {
        const feeMinor = fee ?? (await env.DB.prepare('SELECT application_fee_minor FROM num_paylinks WHERE token = ?1')
          .bind(bill.token).first().catch(() => null))?.application_fee_minor ?? null;
        const key = settled.booking_id || `bill:${bill.token}`;
        if (Number.isFinite(feeMinor) && feeMinor >= 0) await markPaid(env, key, feeMinor);
      }
      await env.DB.prepare('UPDATE num_paylinks SET payment_intent_id = ?2, charged_via = COALESCE(charged_via, ?3) WHERE token = ?1')
        .bind(bill.token, String(s.payment_intent ?? ''), s.metadata?.num_rail ?? 'stripe').run()
        .catch((e) => console.warn('[billpay] could not stamp intent', e?.message));
    }
    // ── CLOSE THE CHECK IN THE VENUE'S OWN TILL ──────────────────────────
    //
    // Only after the ledger is written, and never in a way that can turn a
    // successful payment into a failed one: the guest's money moved several
    // seconds ago. A till that refuses is logged and left for the venue's POS
    // panel to show — a member of staff clearing one check by hand is a small
    // annoyance; a webhook that 500s and makes Stripe retry a settled bill is
    // not.
    let pos = null;
    // A share never closes a check on its own — the check is the parent's, and
    // closing it on the first of four payments would tell the venue a table
    // had paid when three quarters of it had not. The split path above closes
    // it at the moment the shares cover the bill.
    if (settled?.ok && !settled.already && !settled.split_parent && bill) pos = await closeTill(env, bill);

    return json({ received: true, settled: !!settled?.ok, already: !!settled?.already, pos_closed: !!pos?.ok });
  }

  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    // Honest gap, stated: the commission ledger has no reversal path yet. The
    // event is logged with the token so a person can act on it; a refund the
    // venue issues from its own dashboard without refund_application_fee
    // leaves NUM's fee with NUM until someone reverses it by hand.
    const c = event.data?.object ?? {};
    console.warn('[billpay]', event.type, 'on connected account', account, 'bill', c.metadata?.num_bill_token ?? '?');
    return json({ received: true, noted: event.type });
  }
  return json({ received: true });
}

/** Refund a bill paid through Stripe, taking NUM's fee back with it. */
export async function refundBill(env, tokenValue, { amountMinor = null, reason = 'requested_by_customer' } = {}) {
  const bill = await billFor(env, tokenValue);
  if (!bill) return { ok: false, reason: 'unknown bill code' };
  const venue = await venueRails(env, bill.business_id);
  const row = await env.DB.prepare('SELECT payment_intent_id FROM num_paylinks WHERE token = ?1').bind(bill.token).first().catch(() => null);
  if (!row?.payment_intent_id || !venue?.stripe_account_id) return { ok: false, reason: 'this bill was not paid through Stripe' };
  const body = { payment_intent: row.payment_intent_id, refund_application_fee: true, reason };
  if (amountMinor) body.amount = stripeAmount(amountMinor, bill.currency);
  try {
    const r = await stripeCall(env, '/refunds', body, `refund:${bill.token}:${amountMinor ?? 'full'}`, 'POST', { account: venue.stripe_account_id });
    return { ok: true, refund_id: r.id, status: r.status };
  } catch (e) {
    return { ok: false, reason: e?.message ?? 'Stripe refused the refund' };
  }
}

/* ── routes: /api/bill/… ──────────────────────────────────────────────────── */

export async function handleBill(request, env, path) {
  const m = path.match(/^\/([A-Z0-9]{4,40})(?:\/(checkout|rails|autopay))?\/?$/i);
  if (!m) return json({ error: 'not found' }, 404);
  const token = m[1].toUpperCase();
  const sub = m[2] || 'rails';
  const url = new URL(request.url);
  const guest = { ...guestFromRequest(request), signedIn: url.searchParams.get('in') === '1' };

  if (sub === 'rails' && request.method === 'GET') {
    let out;
    try { out = await billRails(env, token, guest); } catch (e) {
      console.warn('[billpay] rails read failed', e?.message);
      return json({ error: 'could not read this bill right now' }, 503);
    }
    if (!out) return json({ error: 'unknown bill code' }, 404);
    return json(out);
  }

  /* ── POST /api/bill/<token>/autopay ────────────────────────────────────
   *
   * The app asks; the server decides. Every guard lives in autopay.mjs — opted
   * in, under the member's own cap, same currency, under the daily ceiling,
   * venue connected — and a no is always a specific no so the sheet can say
   * which one. A refusal is a 200: "we did not pay this" is an answer, not an
   * error, and the guest is simply back at the buttons.
   *
   * A POST, not a side effect on the GET that renders the sheet. A screen
   * being drawn must never move somebody's money. */
  if (sub === 'autopay' && request.method === 'POST') {
    const me = String(url.searchParams.get('me') ?? '').slice(0, 64);
    if (!me) return json({ error: 'who?' }, 401);
    const bill = await decorate(env, await billFor(env, token));
    if (!bill) return json({ error: 'unknown bill code' }, 404);
    // 'split' lands here too: a parent that has been split is not payable, and
    // auto-pay must refuse it for the same reason checkout does.
    if (bill.state !== 'open') return json({ ok: false, tap: true, why: 'not_open' });
    if (!bill.fixed || !bill.amount_minor) return json({ ok: false, tap: true, why: 'no_amount' });
    let venue;
    try { venue = await venueRails(env, bill.business_id); } catch (e) {
      console.warn('[billpay] autopay venue read', e?.message);
      return json({ ok: false, tap: true, why: 'venue_unreadable' });
    }
    const fee = await feeForBill(env, bill);
    const out = await attemptAutoPay(env, { memberId: me, bill, venue, feeMinor: fee.minor });
    if (out.ok) {
      await env.DB.prepare(
        'UPDATE num_paylinks SET charged_via = COALESCE(charged_via, ?2), application_fee_minor = COALESCE(application_fee_minor, ?3) WHERE token = ?1',
      ).bind(bill.token, 'autopay', fee.minor).run().catch(() => null);
      await env.DB.prepare('UPDATE num_paylinks SET paid_by_member = ?2 WHERE token = ?1')
        .bind(bill.token, me).run().catch(() => null);
    }
    await track(env, {
      token: bill.token, businessId: bill.business_id,
      kind: out.ok ? 'autopay_paid' : 'autopay_refused',
      rail: 'autopay', memberId: me,
      amountMinor: out.ok ? bill.amount_minor : null,
      // The specific no, not "it did not work": over_cap and
      // needs_authentication are different problems with different fixes.
      detail: out.ok ? null : (out.why ?? 'refused'),
    });
    return json(out);
  }

  if (sub === 'checkout' && request.method === 'GET') {
    const rail = String(url.searchParams.get('rail') || 'card');
    let res;
    const me = String(url.searchParams.get('me') ?? '').slice(0, 64) || null;
    // Recorded BEFORE Stripe is asked, so a rail that always fails to open
    // still shows up as a thing guests keep choosing.
    await track(env, { token, kind: 'rail_chosen', rail, memberId: me });
    try { res = await createBillCheckout(env, token, rail, { guest, me }); } catch (e) {
      console.warn('[billpay] checkout failed', e?.message);
      return json({ error: 'could not open the payment page' }, 503);
    }
    if (!res.ok) {
      // A browser tapped a rail card; send it back to the pay page with the
      // reason so the guest reads it where they were, not a JSON blob.
      const back = `${SITE(env)}/p/${encodeURIComponent(token)}?why=${encodeURIComponent(res.reason)}`;
      if ((request.headers.get('accept') || '').includes('text/html')) {
        return new Response(null, { status: 303, headers: { location: back, 'cache-control': 'no-store' } });
      }
      return json({ error: res.reason }, res.status || 400);
    }
    return new Response(null, { status: 303, headers: { location: res.url, 'cache-control': 'no-store' } });
  }
  return json({ error: 'not found' }, 404);
}
