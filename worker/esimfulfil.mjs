// From "paid" to "installed" — or to "refunded", never to "stuck and silent".
//
// The promise to a traveller who has paid is simple: they get a working eSIM
// or they get their money back, and either way they hear about it. Every
// branch below ends in one of those, or in 'attention' with a human alerted.
//
// Supplier orders are placed with Num's order id as the transaction id, so a
// retry after a lost reply is recognisable as the same purchase. That relies
// on the supplier refusing a repeated transaction id, which is still to be
// confirmed on the live account; until it is, a retry that gets anything but
// a clean yes goes to a person, never to an automatic refund (see RETRY below).

import * as O from './esimorders.mjs';
import { parseLpa } from './esimlpa.mjs';
import { sms, email } from './esimcopy.mjs';
import { refundOrder } from './esimstripe.mjs';
import { usd } from './esimprice.mjs';

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

export const installUrl = (origin, order) => `${origin}/esim/o/${order.token}`;

async function pickProfile(driver, order, orderNo) {
  const q = await driver.query({ orderNo });
  if (!q.ok) return { ok: false, error: q.error };
  const mine = q.profiles.filter((p) => !p.transactionId || p.transactionId === order.id);
  const p = mine.find((x) => parseLpa(x.lpa));
  if (p) return { ok: true, profile: { ...p, lpa: parseLpa(p.lpa).lpa } };
  if (q.profiles.length && !mine.length) return { ok: false, foreign: true, error: 'supplier order belongs to another transaction' };
  if (mine.length) return { ok: false, notReady: !mine.some((x) => x.lpa), badLpa: mine.some((x) => x.lpa), error: 'no usable activation code yet' };
  return { ok: false, notReady: true, error: 'no profile allocated yet' };
}

/** Tell the traveller their eSIM is ready, on every channel they gave us. */
export async function deliver(env, db, order, deps) {
  const url = installUrl(deps.origin, order);
  const out = { page: url, sms: 'skipped', email: 'skipped' };
  const textOk = order.phone && (order.sms_ok || order.channel === 'sms' || order.channel === 'whatsapp');
  if (textOk && !order.sms_sent_at) {
    const r = await deps.notify.sms(order.phone, sms.ready(order, url, { textConcierge: Boolean(deps.textConcierge) }), { channel: order.channel, orderId: order.id }).catch((e) => ({ ok: false, error: String(e) }));
    out.sms = r?.ok ? 'sent' : `failed: ${r?.error || 'unknown'}`;
    if (r?.ok) await O.markSent(db, order.id, 'sms');
  }
  if (order.email && !order.email_sent_at) {
    const m = email.ready(order, url);
    const r = await deps.notify.email(order.email, m.subject, m.text, { orderId: order.id }).catch((e) => ({ ok: false, error: String(e) }));
    out.email = r?.ok ? 'sent' : `failed: ${r?.error || 'unknown'}`;
    if (r?.ok) await O.markSent(db, order.id, 'email');
  }
  return out;
}

/**
 * Give the money back and say so. If the refund itself fails, a human is paged.
 *
 * The order is claimed as 'refunding' BEFORE Stripe is asked, from the state
 * the caller saw. If something else moved it first (the eSIM was delivered a
 * moment ago, or another refund won), nothing is refunded: a refund must never
 * race the delivery of the eSIM it is paying back.
 */
export async function refundAndTell(env, db, order, from, reason, deps) {
  if (!(await O.claimRefund(db, order.id, from, reason))) {
    const now = await O.getById(db, order.id);
    return { state: now?.state ?? 'unknown', skipped: 'the order moved on before the refund could start' };
  }
  return completeRefund(env, db, order, reason, deps);
}

/**
 * Refund an order already claimed as 'refunding'. Safe to run again: Stripe is
 * called with the same idempotency key per order, so a resumed refund can
 * never pay twice.
 */
export async function completeRefund(env, db, order, reason, deps) {
  const r = await (deps.refund || refundOrder)(env, order, deps);
  if (!r.ok) {
    await O.markAttention(db, order.id, 'refunding', `refund failed after "${reason}": ${r.error}`);
    await deps.notify.alert(`eSIM ${order.id}: "${reason}" and the automatic refund FAILED (${r.error}). Refund ${usd(order.paid_cs ?? order.price_cs)} by hand in Stripe.`);
    return { state: 'attention' };
  }
  if (!(await O.markRefunded(db, order.id, 'refunding', reason))) return { state: 'refunded', repeat: true };
  const fresh = await O.getById(db, order.id);
  const textOk = fresh.phone && (fresh.sms_ok || fresh.channel === 'sms' || fresh.channel === 'whatsapp');
  if (textOk) await deps.notify.sms(fresh.phone, sms.refunded(fresh), { channel: fresh.channel, orderId: fresh.id }).catch(() => null);
  if (fresh.email) { const m = email.refunded(fresh); await deps.notify.email(fresh.email, m.subject, m.text, { orderId: fresh.id }).catch(() => null); }
  await deps.notify.alert(`eSIM ${order.id} refunded ${usd(order.paid_cs ?? order.price_cs)}: ${reason}`);
  return { state: 'refunded' };
}

/** Read the supplier's allocation and, if it is usable, finish the order. */
export async function finishFromSupplier(env, db, order, deps) {
  const driver = deps.driverFor(order.provider);
  const got = await pickProfile(driver, order, order.provider_order_no);
  if (got.ok) {
    const moved = await O.markReady(db, order.id, got.profile);
    const fresh = await O.getById(db, order.id);
    if (moved) return { state: 'ready', delivery: await deliver(env, db, fresh, deps) };
    // A person refunded this order while the supplier was still allocating.
    // The traveller has their money back, so the profile is never sent; hand
    // it back to the supplier so Num is not paying for it.
    if ((fresh.state === 'refunding' || fresh.state === 'refunded') && got.profile.esimTranNo && driver.cancel) {
      const c = await driver.cancel({ esimTranNo: got.profile.esimTranNo }).catch((e) => ({ ok: false, error: String(e) }));
      await deps.notify.alert(`eSIM ${order.id}: the supplier delivered a profile after the order was refunded. ${c?.ok ? 'It was cancelled with the supplier.' : `It could NOT be cancelled (${c?.error}); cancel ${got.profile.esimTranNo} in the ${order.provider} console.`}`);
    }
    return { state: fresh.state };
  }
  if (got.foreign || got.badLpa) {
    await O.markAttention(db, order.id, 'ordering', got.error);
    await deps.notify.alert(`eSIM ${order.id}: ${got.error}. Paid ${usd(order.paid_cs ?? order.price_cs)}; not delivered.`);
    return { state: 'attention' };
  }
  return { state: 'ordering', waiting: got.error };
}

/** A retried order the supplier said no to: a person decides, with the transaction id in hand. */
async function toAPerson(db, order, what, deps) {
  await O.markAttention(db, order.id, 'ordering', `${what}; the first, unanswered attempt may have created the order`);
  await deps.notify.alert(`eSIM ${order.id}: the first supplier call went unanswered and ${what}. The first call may still have bought the eSIM: look up transaction ${order.id} in the ${order.provider} console, then finish the order or refund it (POST /api/admin/esim {"action":"refund","id":"${order.id}"}).`);
  return { state: 'attention' };
}

/** Place the supplier order for a paid order. Safe to call more than once. */
export async function fulfil(env, db, orderId, deps) {
  if (!(await O.claimForOrdering(db, orderId))) return { skipped: 'not claimable (already claimed or not paid)' };
  const order = await O.getById(db, orderId);
  return placeAndFinish(env, db, order, deps);
}

async function placeAndFinish(env, db, order, deps) {
  const driver = deps.driverFor(order.provider);
  // RETRY: an earlier attempt went unanswered, so it may have created the
  // supplier order after all. From here on only a clean yes (or the supplier
  // recognising the transaction id) is trusted; any "no" goes to a person, who
  // can see in the supplier console whether the first attempt bought an eSIM.
  // Refunding automatically here could leave Num paying for an eSIM it never
  // delivered, or deliver one after the money went back.
  const retry = (order.attempts ?? 1) > 1;
  if (!driver?.ready()) {
    if (retry) return toAPerson(db, order, 'supplier not configured on a retry', deps);
    return refundAndTell(env, db, order, 'ordering', 'supplier not configured', deps);
  }
  const r = await driver.order({ planCode: order.plan_code, txnId: order.id, costUnits: order.cost_units });
  if (!r.ok) {
    if (retry && (r.kind === 'no_balance' || r.kind === 'refused')) return toAPerson(db, order, `the retry got "${r.error}"`, deps);
    if (r.kind === 'no_balance') {
      await deps.notify.alert(`eSIM supplier balance is too low to fill ${order.id}. Top up the ${order.provider} balance now; new sales will pause until you do.`);
      return refundAndTell(env, db, order, 'ordering', 'supplier balance too low', deps);
    }
    if (r.kind === 'refused') return refundAndTell(env, db, order, 'ordering', `supplier refused: ${r.error}`, deps);
    if (r.kind === 'duplicate') {
      await O.markAttention(db, order.id, 'ordering', `supplier says this order already exists: ${r.error}`);
      await deps.notify.alert(`eSIM ${order.id}: a retry found the supplier order already exists but we never saw its number. Look it up in the supplier console and finish or refund it.`);
      return { state: 'attention' };
    }
    await O.noteError(db, order.id, `supplier did not answer: ${r.error}`);
    return { state: 'ordering', waiting: 'supplier did not answer; the sweep will retry with the same transaction id' };
  }
  await O.saveSupplierOrder(db, order.id, r.orderNo);
  const placed = { ...order, provider_order_no: r.orderNo };
  for (const wait of deps.pollMs ?? [1500, 3000, 5000, 8000]) {
    await (deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms))))(wait);
    const f = await finishFromSupplier(env, db, placed, deps);
    if (f.state !== 'ordering') return f;
  }
  return { state: 'ordering', waiting: 'allocated later; the supplier doorbell or the sweep will finish it' };
}

/**
 * The safety net, run on a schedule. Every order that should have moved and
 * has not is pushed along, and anything that cannot be pushed pages a human.
 */
export async function sweep(env, db, deps, { now = Date.now() } = {}) {
  const report = { fulfilled: 0, finished: 0, retried: 0, attention: 0, expired: 0 };
  const stuck = await O.stuckOrders(db, { paidOlderThanIso: iso(now - 2 * MIN), orderingOlderThanIso: iso(now - 3 * MIN) });
  for (const o of stuck) {
    if (o.state === 'paid') { await fulfil(env, db, o.id, deps); report.fulfilled++; continue; }
    if (o.provider_order_no) {
      const f = await finishFromSupplier(env, db, o, deps);
      if (f.state === 'ready') report.finished++;
      else if (f.state === 'ordering' && o.ordering_at < iso(now - 60 * MIN)) {
        await O.markAttention(db, o.id, 'ordering', 'supplier has not allocated a profile in an hour');
        await deps.notify.alert(`eSIM ${o.id}: supplier order ${o.provider_order_no} has not produced a profile in an hour. Chase the supplier or refund.`);
        report.attention++;
      }
      continue;
    }
    if (o.ordering_at < iso(now - 10 * MIN) && (await O.reclaimStuck(db, o.id, iso(now - 10 * MIN)))) {
      if (o.attempts >= 3) {
        await O.markAttention(db, o.id, 'ordering', 'supplier unreachable after 3 attempts');
        await deps.notify.alert(`eSIM ${o.id}: supplier unreachable after 3 attempts. Check the supplier, then finish or refund.`);
        report.attention++;
        continue;
      }
      await placeAndFinish(env, db, await O.getById(db, o.id), { ...deps, pollMs: [0] });
      report.retried++;
    }
  }
  // A refund that was claimed but never finished (the worker stopped between
  // the claim and Stripe). Stripe's idempotency key makes finishing it safe.
  report.refundsResumed = 0;
  for (const o of await O.stuckRefunds(db, iso(now - 10 * MIN))) {
    await completeRefund(env, db, o, o.error || 'refund resumed', deps);
    report.refundsResumed++;
  }
  const ex = await O.expireQuotes(db, iso(now - 24 * 60 * MIN));
  report.expired = ex.meta?.changes ?? 0;
  return report;
}

/** Cancel any profile the supplier allocated to an order that has been refunded. */
async function cancelLateProfiles(db, order, orderNo, deps) {
  const driver = deps.driverFor(order.provider);
  const q = await driver.query({ orderNo }).catch((e) => ({ ok: false, error: String(e) }));
  if (!q?.ok) return { ignored: `refunded order; supplier query failed: ${q?.error}` };
  const mine = (q.profiles || []).filter((p) => p.esimTranNo && (!p.transactionId || p.transactionId === order.id));
  if (!mine.length) return { ignored: 'refunded order; no profile to cancel' };
  const results = [];
  for (const p of mine) {
    const c = await driver.cancel({ esimTranNo: p.esimTranNo }).catch((e) => ({ ok: false, error: String(e) }));
    results.push(c?.ok ? `${p.esimTranNo} cancelled` : `${p.esimTranNo} NOT cancelled (${c?.error}) - cancel it in the ${order.provider} console`);
  }
  await deps.notify.alert(`eSIM ${order.id}: the supplier delivered after the order was refunded. ${results.join('; ')}.`);
  return { state: order.state, lateProfiles: results };
}

/** Supplier notification: find the order it points at, then re-read the truth. */
export async function onDoorbell(env, db, bell, deps) {
  if (!bell) return { ignored: 'unreadable' };
  if (bell.type === 'CHECK_HEALTH') return { ok: true };
  if (!(await O.firstRing(db, bell.notifyId, bell.type))) return { duplicate: true };
  let order = bell.transactionId ? await O.getById(db, bell.transactionId) : null;
  if (!order && bell.orderNo) order = await O.getBySupplierOrder(db, bell.orderNo);
  // A profile arriving for an order a person already refunded: the traveller
  // has their money back and never gets it, so hand it back to the supplier.
  if (order && (order.state === 'refunded' || order.state === 'refunding') && (order.provider_order_no || bell.orderNo)) {
    return cancelLateProfiles(db, order, order.provider_order_no || bell.orderNo, deps);
  }
  if (!order || order.state !== 'ordering') return { ignored: 'no order waiting on this' };
  if (!order.provider_order_no && bell.orderNo) {
    await O.saveSupplierOrder(db, order.id, bell.orderNo);
    order = await O.getById(db, order.id);
  }
  if (!order.provider_order_no) return { ignored: 'no supplier order number yet' };
  return finishFromSupplier(env, db, order, deps);
}
