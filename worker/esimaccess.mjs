// eSIM Access — the stand-in supplier until LetsGo2Trip's eSIM API lands
// (their docs are due mid-November).
//
// Why this one: self-serve signup, no minimum, prepaid balance (so Num never
// owes a supplier money it has not collected), wholesale prices far under
// retail, and every order returns a standard activation string that we turn
// into Apple's one-tap install link.
//
// API facts this relies on (checked against their published examples):
//   base    https://api.esimaccess.com/api/v1/open, every call is POST JSON
//   auth    one header, RT-AccessCode
//   money   integer units of 1/10,000 USD (18000 = $1.80)
//   data    bytes (1073741824 = 1 GB)
//   reply   { success, errorCode, errorMsg, obj }
// None of this has been seen from the live account yet. The first
// GET /api/admin/esim after the key is set shows the balance and the plan
// count; if either is missing, this driver needs fixing. No plans means
// salesOpen() keeps every sale closed. A balance it cannot read does NOT close
// sales (an order the supplier then refuses is refunded automatically), so an
// unreadable balance is worth fixing before launch, not after. Also
// unconfirmed: that a repeated transactionId is refused rather than filled
// twice (see RETRY in esimfulfil.mjs).
//
// Every method returns a result object. Nothing throws into a payment path.

export const ESIMACCESS = 'esimaccess';

const BASE = 'https://api.esimaccess.com/api/v1/open';
const MB = 1048576;

export function unitsToCents(units) {
  const n = Number(units);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n / 100) : 0;
}

/** Normalise one supplier package into Num's plan shape. Returns null if unusable. */
export function normalisePackage(p) {
  if (!p || typeof p !== 'object') return null;
  const code = String(p.packageCode || '').trim();
  if (!code) return null;
  if (p.currencyCode && String(p.currencyCode).toUpperCase() !== 'USD') return null;
  const costUnits = Number(p.price);
  if (!Number.isFinite(costUnits) || costUnits <= 0) return null;
  const unit = String(p.durationUnit || 'DAY').toUpperCase();
  const duration = Number(p.duration) || 0;
  const days = unit === 'DAY' ? duration : unit === 'MONTH' ? duration * 30 : unit === 'YEAR' ? duration * 365 : duration;
  const name = String(p.name || '').trim();
  const countries = String(p.location || '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  const daily = Number(p.dataType) === 2 || /\/\s*day\b|per day|daily/i.test(name);
  const unlimited = /unlimited/i.test(name);
  const networks = [];
  for (const loc of Array.isArray(p.locationNetworkList) ? p.locationNetworkList : []) {
    for (const op of Array.isArray(loc?.operatorList) ? loc.operatorList : []) {
      const label = [op?.operatorName, op?.networkType].filter(Boolean).join(' ');
      if (label && !networks.includes(label)) networks.push(label);
    }
  }
  return {
    provider: ESIMACCESS,
    code,
    slug: p.slug ? String(p.slug) : null,
    name,
    costUnits,
    costCs: unitsToCents(costUnits),
    retailCs: unitsToCents(p.retailPrice) || null,
    dataMb: Number(p.volume) > 0 ? Math.round(Number(p.volume) / MB) : null,
    unlimited,
    daily,
    days,
    activateWithinDays: Number(p.unusedValidTime) || null,
    countries,
    scope: countries.length <= 1 ? 'local' : countries.length >= 40 ? 'global' : 'regional',
    topup: Boolean(Number(p.supportTopUpType) || p.supportTopUp),
    networks: networks.slice(0, 6),
  };
}

/** Normalise one allocated profile. */
export function normaliseProfile(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    iccid: e.iccid ? String(e.iccid) : null,
    esimTranNo: e.esimTranNo ? String(e.esimTranNo) : null,
    orderNo: e.orderNo ? String(e.orderNo) : null,
    transactionId: e.transactionId ? String(e.transactionId) : null,
    lpa: typeof e.ac === 'string' ? e.ac.trim() : null,
    qrUrl: typeof e.qrCodeUrl === 'string' && /^https:\/\//.test(e.qrCodeUrl) ? e.qrCodeUrl : null,
    status: e.esimStatus ? String(e.esimStatus) : null,
    smdpStatus: e.smdpStatus ? String(e.smdpStatus) : null,
    expiresAt: e.expiredTime || null,
    totalBytes: Number(e.totalVolume) || null,
    usedBytes: Number(e.orderUsage) || 0,
  };
}

// A supplier "no" is definitive: nothing was ordered, nothing was spent.
// Silence (timeout, 5xx, bad JSON) is not: the order may exist.
// A "that transaction id already exists" no means the FIRST attempt worked.
export function classifyFailure(res) {
  if (res.transport) return 'unknown';
  const msg = `${res.errorCode || ''} ${res.errorMsg || ''}`.toLowerCase();
  if (/exist|duplicat|repeat|already/.test(msg)) return 'duplicate';
  if (/balance|insufficient|credit/.test(msg)) return 'no_balance';
  return 'refused';
}

export function esimAccessDriver(env = {}, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const base = (env.ESIMACCESS_BASE || BASE).replace(/\/+$/, '');
  const accessCode = env.ESIMACCESS_ACCESS_CODE || '';

  async function call(path, body) {
    if (!accessCode) return { ok: false, transport: false, errorCode: 'not_configured', errorMsg: 'ESIMACCESS_ACCESS_CODE is not set' };
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await fetchImpl(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'RT-AccessCode': accessCode },
        body: JSON.stringify(body || {}),
        signal: ctrl?.signal,
      });
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch { j = null; }
      if (!j || typeof j !== 'object') {
        return { ok: false, transport: true, status: r.status, errorCode: `http_${r.status}`, errorMsg: 'non-JSON reply' };
      }
      if (j.success === true) return { ok: true, obj: j.obj ?? null };
      return { ok: false, transport: r.status >= 500, status: r.status, errorCode: String(j.errorCode ?? ''), errorMsg: String(j.errorMsg ?? '') };
    } catch (err) {
      return { ok: false, transport: true, errorCode: err?.name === 'AbortError' ? 'timeout' : 'network', errorMsg: String(err?.message || err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    id: ESIMACCESS,
    ready: () => Boolean(accessCode),

    async balance() {
      const r = await call('/balance/query', {});
      if (!r.ok) return { ok: false, error: r.errorMsg || r.errorCode };
      const units = Number(r.obj?.balance ?? r.obj?.amount);
      return Number.isFinite(units) ? { ok: true, balanceCs: Math.floor(units / 100) } : { ok: false, error: 'balance missing from reply' };
    },

    async packages({ country = '', packageCode = '' } = {}) {
      const r = await call('/package/list', { locationCode: country, type: 'BASE', packageCode, iccid: '' });
      if (!r.ok) return { ok: false, plans: [], error: r.errorMsg || r.errorCode };
      const list = Array.isArray(r.obj?.packageList) ? r.obj.packageList : [];
      const plans = list.map(normalisePackage).filter(Boolean);
      return { ok: true, plans, dropped: list.length - plans.length };
    },

    /** Place one order. `txnId` must be Num's order id — it is the idempotency key. */
    async order({ planCode, txnId, costUnits }) {
      const units = Number(costUnits);
      if (!planCode || !txnId || !Number.isFinite(units) || units <= 0) {
        return { ok: false, kind: 'refused', error: 'order needs planCode, txnId and costUnits' };
      }
      const r = await call('/esim/order', {
        transactionId: String(txnId),
        amount: units,
        packageInfoList: [{ packageCode: String(planCode), count: 1, price: units }],
      });
      if (r.ok && r.obj?.orderNo) return { ok: true, orderNo: String(r.obj.orderNo) };
      if (r.ok) return { ok: false, kind: 'unknown', error: 'order accepted without an order number' };
      return { ok: false, kind: classifyFailure(r), error: r.errorMsg || r.errorCode };
    },

    async query({ orderNo = '', iccid = '' } = {}) {
      if (!orderNo && !iccid) return { ok: false, profiles: [], error: 'query needs orderNo or iccid' };
      const r = await call('/esim/query', { orderNo, iccid, pager: { pageNum: 1, pageSize: 20 } });
      if (!r.ok) return { ok: false, profiles: [], error: r.errorMsg || r.errorCode };
      const list = Array.isArray(r.obj?.esimList) ? r.obj.esimList : [];
      return { ok: true, profiles: list.map(normaliseProfile).filter(Boolean) };
    },

    /** Cancel a profile that was never installed; the supplier refunds our balance. */
    async cancel({ esimTranNo }) {
      if (!esimTranNo) return { ok: false, error: 'cancel needs esimTranNo' };
      const r = await call('/esim/cancel', { esimTranNo: String(esimTranNo) });
      return r.ok ? { ok: true } : { ok: false, error: r.errorMsg || r.errorCode };
    },
  };
}

/**
 * Webhooks are a doorbell, never the truth. They are unsigned, so nothing in
 * one is trusted: it only tells us WHICH order to re-read through the
 * authenticated API.
 */
export function parseWebhook(body) {
  if (!body || typeof body !== 'object') return null;
  const type = String(body.notifyType || '');
  const c = body.content && typeof body.content === 'object' ? body.content : {};
  return {
    type,
    notifyId: body.notifyId ? String(body.notifyId) : null,
    transactionId: c.transactionId ? String(c.transactionId) : null,
    orderNo: c.orderNo ? String(c.orderNo) : null,
    esimTranNo: c.esimTranNo ? String(c.esimTranNo) : null,
    iccid: c.iccid ? String(c.iccid) : null,
    orderStatus: c.orderStatus ? String(c.orderStatus) : null,
    esimStatus: c.esimStatus ? String(c.esimStatus) : null,
  };
}
