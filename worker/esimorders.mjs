// eSIM orders: one row per purchase, moved through its states by guarded
// UPDATEs so that two webhooks, two cron ticks or two taps can never both win.
//
//   quoted -> checkout -> paid -> ordering -> ready
//                                     \-> refunding -> refunded   (money returned)
//                                     \-> attention  (a human must look)
//   quoted/checkout -> expired (never paid)
//   expired -> paid   (a Checkout page opened before expiry was paid after it:
//                      the traveller paid our price, so they get the eSIM)
//
// 'refunding' is claimed BEFORE Stripe is asked for the money back, so a
// refund and a delivery can never both win, and two refunds never race.
//
// The order id doubles as the supplier's transaction id, so a retried supplier
// call can be recognised as the same purchase.

import { planLabel } from './esimcatalogue.mjs';

const nowIso = () => new Date().toISOString();

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function b64url(bytes) {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function newOrderIds() {
  const hex = [...randomBytes(8)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return { id: `eso_${hex}`, token: b64url(randomBytes(18)) };
}

export function validPhone(p) {
  return typeof p === 'string' && /^\+[1-9]\d{6,14}$/.test(p);
}
export function validEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

/**
 * Create a priced quote from a plan row the server read itself.
 * The price is the plan's server price — never anything a client sent.
 */
export async function createQuote(db, { plan, dest, channel = 'web', phone = null, email = null, name = null, smsOk = false, marketingOk = false, consent = null, ipHash = null, ref = null, utm = null, memberId = null }) {
  if (!plan || !plan.code || !(plan.priceCs >= 50) || !(plan.costUnits > 0)) return { ok: false, error: 'plan_not_sellable' };
  const cleanPhone = validPhone(phone) ? phone : null;
  const cleanEmail = validEmail(email) ? email.toLowerCase() : null;
  const { id, token } = newOrderIds();
  const label = planLabel(plan);
  const marketing = marketingOk && cleanPhone ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO num_esim_orders (id, token, state, provider, plan_code, plan_label, dest_label, country, airport, region, cost_units, cost_cs, price_cs, channel, phone, email, name, member_id, sms_ok, marketing_ok, consent_ip, consent_ua, consent_country, ip_hash, ref, utm, created_at, updated_at)
       VALUES (?,?,'quoted',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(id, token, plan.provider, plan.code, label, dest?.label || 'your trip', dest?.country || null, dest?.airport || null, dest?.region || null, plan.costUnits, plan.costCs, plan.priceCs, channel, cleanPhone, cleanEmail, name ? String(name).slice(0, 80) : null, memberId, smsOk && cleanPhone ? 1 : 0, marketing, marketing && consent?.ip ? String(consent.ip).slice(0, 64) : null, marketing && consent?.userAgent ? String(consent.userAgent).slice(0, 200) : null, marketing && consent?.country ? String(consent.country).slice(0, 8) : null, ipHash, ref ? String(ref).slice(0, 64) : null, utm ? String(utm).slice(0, 200) : null, nowIso(), nowIso())
    .run();
  return { ok: true, order: await getById(db, id) };
}

export const getById = (db, id) => db.prepare('SELECT * FROM num_esim_orders WHERE id = ?').bind(id).first();
export const getByToken = (db, token) =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token)
    ? db.prepare('SELECT * FROM num_esim_orders WHERE token = ?').bind(token).first()
    : Promise.resolve(null);
export const getBySupplierOrder = (db, orderNo) => db.prepare('SELECT * FROM num_esim_orders WHERE provider_order_no = ?').bind(orderNo).first();

async function move(db, id, from, sets, binds = []) {
  const fromList = Array.isArray(from) ? from : [from];
  const r = await db
    .prepare(`UPDATE num_esim_orders SET ${sets}, updated_at = ? WHERE id = ? AND state IN (${fromList.map(() => '?').join(',')})`)
    .bind(...binds, nowIso(), id, ...fromList)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

export const markCheckout = (db, id, sessionId, url) =>
  move(db, id, ['quoted', 'checkout'], "state = 'checkout', stripe_session = ?, stripe_url = ?, stripe_session_at = ?, checkout_attempts = checkout_attempts + 1", [sessionId, url || null, nowIso()]);

/** An open Checkout page younger than this is reused rather than replaced. */
export function reusableCheckout(order, { now = Date.now(), maxAgeMs = 100 * 60000 } = {}) {
  if (order?.state !== 'checkout' || !order.stripe_url || !order.stripe_session_at) return null;
  return now - Date.parse(order.stripe_session_at) < maxAgeMs ? order.stripe_url : null;
}

/**
 * Paid: only once, from quoted/checkout — or from expired, because a Checkout
 * page opened before the quote expired can still be paid after it, and that
 * traveller paid our price and is owed the eSIM, not silence. Contact details
 * from checkout fill gaps, never overwrite.
 */
export const markPaid = (db, id, { sessionId, paymentIntent, paidCs, email, phone, name }) =>
  move(
    db, id, ['quoted', 'checkout', 'expired'],
    "state = 'paid', stripe_session = COALESCE(?, stripe_session), stripe_pi = ?, paid_cs = ?, email = COALESCE(email, ?), phone = COALESCE(phone, ?), name = COALESCE(name, ?), paid_at = ?",
    [sessionId || null, paymentIntent || null, paidCs, validEmail(email) ? email.toLowerCase() : null, validPhone(phone) ? phone : null, name ? String(name).slice(0, 80) : null, nowIso()],
  );

/** Exactly one caller wins the right to place the supplier order. */
export const claimForOrdering = (db, id) => move(db, id, 'paid', "state = 'ordering', attempts = attempts + 1, ordering_at = ?", [nowIso()]);

/** Re-claim an order stuck in 'ordering' with no supplier order number. */
export const reclaimStuck = (db, id, olderThanIso) =>
  db
    .prepare("UPDATE num_esim_orders SET attempts = attempts + 1, ordering_at = ?, updated_at = ? WHERE id = ? AND state = 'ordering' AND provider_order_no IS NULL AND ordering_at < ?")
    .bind(nowIso(), nowIso(), id, olderThanIso)
    .run()
    .then((r) => (r.meta?.changes ?? 0) === 1);

export const saveSupplierOrder = (db, id, orderNo) =>
  db.prepare("UPDATE num_esim_orders SET provider_order_no = ?, updated_at = ? WHERE id = ? AND state = 'ordering' AND provider_order_no IS NULL").bind(orderNo, nowIso(), id).run();

export const markReady = (db, id, p) =>
  move(db, id, 'ordering', "state = 'ready', iccid = ?, esim_tran_no = ?, lpa = ?, qr_url = ?, ready_at = ?, error = NULL", [p.iccid || null, p.esimTranNo || null, p.lpa, p.qrUrl || null, nowIso()]);

/** Claim the right to refund. Exactly one caller wins; delivery can no longer win after it. */
export const claimRefund = (db, id, from, reason) => move(db, id, from, "state = 'refunding', error = ?", [String(reason || '').slice(0, 300)]);
export const markRefunded = (db, id, from, error) => move(db, id, from, "state = 'refunded', refunded_at = ?, error = ?", [nowIso(), String(error || '').slice(0, 300)]);
export const markAttention = (db, id, from, error) => move(db, id, from, "state = 'attention', error = ?", [String(error || '').slice(0, 300)]);
export const noteError = (db, id, error) => db.prepare('UPDATE num_esim_orders SET error = ?, updated_at = ? WHERE id = ?').bind(String(error || '').slice(0, 300), nowIso(), id).run();

export const markSent = (db, id, channel) =>
  db.prepare(`UPDATE num_esim_orders SET ${channel === 'sms' ? 'sms_sent_at' : 'email_sent_at'} = ?, updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), id).run();

export const linkMember = (db, id, memberId) => db.prepare('UPDATE num_esim_orders SET member_id = COALESCE(member_id, ?), updated_at = ? WHERE id = ?').bind(memberId, nowIso(), id).run();

/** Refunds claimed but never finished (the worker died between the claim and Stripe). */
export async function stuckRefunds(db, olderThanIso) {
  const { results } = await db.prepare("SELECT * FROM num_esim_orders WHERE state = 'refunding' AND updated_at < ? ORDER BY updated_at LIMIT 50").bind(olderThanIso).all();
  return results;
}

/** The marketing-consent evidence has moved to num_sms_consent (or is no longer wanted). */
export const clearConsentEvidence = (db, id) =>
  db.prepare('UPDATE num_esim_orders SET consent_ip = NULL, consent_ua = NULL, consent_country = NULL WHERE id = ?').bind(id).run();

/** Orders the sweep should look at: paid but unclaimed, or ordering too long. */
export async function stuckOrders(db, { paidOlderThanIso, orderingOlderThanIso }) {
  const { results } = await db
    .prepare("SELECT * FROM num_esim_orders WHERE (state = 'paid' AND paid_at < ?) OR (state = 'ordering' AND ordering_at < ?) ORDER BY updated_at LIMIT 50")
    .bind(paidOlderThanIso, orderingOlderThanIso)
    .all();
  return results;
}

export const expireOne = (db, id) => move(db, id, ['quoted', 'checkout'], "state = 'expired'");

export const expireQuotes = (db, olderThanIso) =>
  db.prepare("UPDATE num_esim_orders SET state = 'expired', consent_ip = NULL, consent_ua = NULL, consent_country = NULL, updated_at = ? WHERE state IN ('quoted','checkout') AND created_at < ?").bind(nowIso(), olderThanIso).run();

export async function countRecent(db, { phone, ipHash, sinceIso, paidOnly = false }) {
  const col = phone ? 'phone' : 'ip_hash';
  const val = phone || ipHash;
  if (!val) return 0;
  const stateClause = paidOnly ? "AND state IN ('paid','ordering','ready')" : '';
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM num_esim_orders WHERE ${col} = ? AND created_at >= ? ${stateClause}`).bind(val, sinceIso).first();
  return r?.n ?? 0;
}

export async function orderStats(db) {
  const { results } = await db.prepare('SELECT state, COUNT(*) AS n, COALESCE(SUM(paid_cs),0) AS paid_cs FROM num_esim_orders GROUP BY state').all();
  return results;
}

// ---- text-message menu state ------------------------------------------------

export async function saveMenu(db, phone, stage, data, { ttlMin = 30, now = Date.now() } = {}) {
  await db
    .prepare('INSERT INTO num_esim_menus (phone, stage, data, expires_at) VALUES (?,?,?,?) ON CONFLICT(phone) DO UPDATE SET stage=excluded.stage, data=excluded.data, expires_at=excluded.expires_at')
    .bind(phone, stage, JSON.stringify(data || {}), now + ttlMin * 60000)
    .run();
}
export async function getMenu(db, phone, { now = Date.now() } = {}) {
  const r = await db.prepare('SELECT stage, data, expires_at FROM num_esim_menus WHERE phone = ?').bind(phone).first();
  if (!r || r.expires_at < now) return null;
  try { return { stage: r.stage, data: JSON.parse(r.data) }; } catch { return null; }
}
export const clearMenu = (db, phone) => db.prepare('DELETE FROM num_esim_menus WHERE phone = ?').bind(phone).run();

// ---- supplier doorbell dedupe --------------------------------------------------

/** True the first time a notification id is seen, false for repeats. */
export async function firstRing(db, notifyId, type) {
  if (!notifyId) return true;
  const r = await db.prepare('INSERT OR IGNORE INTO num_esim_doorbell (notify_id, type) VALUES (?, ?)').bind(notifyId, type || '').run();
  return (r.meta?.changes ?? 0) === 1;
}
