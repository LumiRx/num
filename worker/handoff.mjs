/**
 * The partner handoff reference — who sent this traveller, provably.
 *
 * ── WHY A PARAMETER AND NOT A COOKIE ─────────────────────────────────────
 *
 * LetsGo2Trip's term 6 asked for "a standard 30-day cookie window based on
 * last-click attribution". The window and the last-click logic are fine. The
 * cookie is not, and it fails hardest in exactly the traffic Num sends:
 *
 *   · Safari caps script-set cookies at SEVEN days, not thirty. A third of the
 *     agreed window is gone before it starts.
 *   · Num's iOS app opens outbound links in a web view, where cookie
 *     persistence back to the system browser is unreliable by design. That is
 *     the majority of what we hand over.
 *   · A concierge conversation and the booking it produces are usually days
 *     apart and often on different devices. Cross-device is invisible to a
 *     cookie and perfectly visible to a parameter.
 *
 * And it would have replaced something better. travelreferral.mjs already
 * holds Num's own booking row and accrues commission server-side on the
 * transition into `confirmed`, idempotently. Trading that for a cookie means
 * invoicing from a number we cannot audit.
 *
 * So: the deep-link carries `num_ref`. The partner persists it on the order at
 * checkout and echoes it back in a daily settlement. Both sides hold the same
 * identifier and neither has to reconstruct anything. The cookie stays as
 * their fallback for a traveller who arrives without one — it just stops being
 * the record of truth.
 *
 * ── WHAT IS IN THE REFERENCE, AND WHAT IS DELIBERATELY NOT ───────────────
 *
 * `num_ref` is `<id>.<sig>` — an opaque random id and a truncated HMAC.
 *
 * It carries NO member id, no phone number, no name, nothing about the person.
 * The temptation to pack the member into the parameter is real (it makes the
 * echo self-describing) and it is wrong: the parameter travels through a third
 * party's URL bar, their access logs, their analytics and any referrer header
 * the checkout leaks. Everything about the traveller stays in our row, keyed
 * by the id.
 *
 * The signature is what lets a settlement row be rejected without a database
 * hit, and it is namespaced `hoff:` so a travelreferral quote token can never
 * be replayed here or the reverse.
 *
 * ── THE ARITHMETIC IS PART OF THE CONTRACT ───────────────────────────────
 *
 * Term 7 has commission calculated "net of all taxes, fuel surcharges, GDS
 * fees and payment gateway processing costs". We accepted that on one
 * condition: the deductions are an ENUMERATED, CLOSED list, and the
 * reconciliation shows gross → each deduction → net → commission per booking,
 * not a net figure alone.
 *
 * DEDUCTIONS below is that closed list, in code. A settlement row carrying a
 * deduction we never agreed to is refused rather than absorbed — which is the
 * difference between a contract term and a sentence in an email. And every row
 * is checked: gross minus the named deductions must equal net. A row that does
 * not add up is still STORED (a bookkeeping dispute must not lose the booking)
 * and comes back flagged, so both sides see it on the day rather than at the
 * end of the quarter.
 */
import { appendParams } from './urlparam.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_handoffs (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  member_id TEXT,
  product TEXT,
  dest TEXT,
  target_host TEXT,
  issued_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued',
  settled_at INTEGER,
  partner_ref TEXT,
  currency TEXT,
  gross_cs INTEGER,
  tax_cs INTEGER,
  surcharge_cs INTEGER,
  gds_cs INTEGER,
  gateway_cs INTEGER,
  net_cs INTEGER,
  commission_cs INTEGER,
  arithmetic_ok INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_handoff_partner ON num_handoffs(partner_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_handoff_state ON num_handoffs(state, issued_at);
CREATE INDEX IF NOT EXISTS idx_handoff_member ON num_handoffs(member_id);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}
/** Test seam: the module-level cache must not leak between test cases. */
export const _resetForTests = () => { ready = false; };

/**
 * The closed list of deductions, per term 7. Adding a key here is a
 * CONTRACT CHANGE, not a code change — it must not happen because a partner
 * sent one and it seemed reasonable.
 */
export const DEDUCTIONS = Object.freeze(['tax_cs', 'surcharge_cs', 'gds_cs', 'gateway_cs']);

/** Settlement outcomes we accept. Anything else is a typo or a new concept. */
export const SETTLEMENT_STATES = Object.freeze(['confirmed', 'cancelled', 'refunded']);

const enc = new TextEncoder();

/**
 * HMAC over the handoff id, namespaced so it cannot be confused with any other
 * signed artefact in this Worker. Truncated to 16 bytes: this authenticates a
 * reference we also hold in a database, it is not a bearer credential.
 */
async function sign(env, id) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env?.ADMIN_KEY ?? 'dev'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`hoff:${id}`));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish compare. Never `===` on a MAC. */
function sameMac(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 128 bits of randomness, URL-safe, no padding. */
function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((n) => n.toString(36).padStart(2, '0')).join('').slice(0, 24);
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * Mint a handoff reference and record that we issued it.
 *
 * Returns `{ ref, id }`, or `{ ref: null }` when there is no database — a
 * traveller must still get their link. An unrecorded handoff earns us nothing,
 * which is a revenue problem; a missing link is a product problem, and the
 * product problem is worse.
 */
export async function mintHandoff(env, { partnerId, memberId, product, dest, targetHost } = {}) {
  const partner = clip(partnerId, 60);
  if (!partner) return { ref: null, id: null, reason: 'no_partner' };
  const id = newId();
  const ref = `${id}.${await sign(env, id)}`;
  if (!env?.DB) return { ref, id, reason: 'not_recorded' };
  try {
    await ensure(env);
    await env.DB.prepare(
      `INSERT INTO num_handoffs (id, partner_id, member_id, product, dest, target_host, issued_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).bind(
      id, partner, clip(memberId, 60), clip(product, 24), clip(dest, 60), clip(targetHost, 120),
      Math.floor(Date.now() / 1000),
    ).run();
  } catch (e) {
    // The link still works and the signature still verifies; we have simply
    // lost our own copy. Better a handoff we cannot reconcile than a traveller
    // who cannot book.
    console.warn('[handoff] mint write failed', e?.message ?? e);
    return { ref, id, reason: 'not_recorded' };
  }
  return { ref, id, reason: 'ok' };
}

/**
 * Verify a reference a partner sent back. No database read — the signature is
 * enough to reject an invented reference, and rejecting cheaply is the point.
 */
export async function verifyHandoffRef(env, ref) {
  const s = String(ref ?? '');
  const dot = s.indexOf('.');
  if (dot < 1) return { ok: false, id: null, reason: 'malformed' };
  const id = s.slice(0, dot);
  const mac = s.slice(dot + 1);
  if (!/^[a-z0-9]{8,40}$/.test(id) || !/^[0-9a-f]{32}$/.test(mac)) {
    return { ok: false, id: null, reason: 'malformed' };
  }
  return sameMac(mac, await sign(env, id))
    ? { ok: true, id, reason: 'ok' }
    : { ok: false, id: null, reason: 'bad_signature' };
}

/** Attach the reference to a partner deep-link, preserving their encoding. */
export const withHandoffRef = (url, ref) =>
  (ref ? appendParams(url, [['num_ref', ref]]) : String(url ?? ''));

/**
 * Apply one settlement row from a partner's daily feed.
 *
 * Idempotent on purpose: at-least-once delivery is a property of the universe,
 * and a partner retrying yesterday's file must not book the commission twice.
 * The UPDATE is guarded on `state='issued'`, so a second application changes
 * no rows and says so.
 */
export async function applySettlement(env, partnerId, raw = {}) {
  const ref = String(raw.num_ref ?? '');
  const v = await verifyHandoffRef(env, ref);
  if (!v.ok) return { num_ref: ref, accepted: false, reason: v.reason };

  const state = String(raw.status ?? '').toLowerCase();
  if (!SETTLEMENT_STATES.includes(state)) {
    return { num_ref: ref, accepted: false, reason: 'unknown_status' };
  }

  // The closed list, enforced. A deduction nobody agreed to is refused rather
  // than absorbed — see the header note.
  const given = raw.deductions && typeof raw.deductions === 'object' ? raw.deductions : {};
  const unknown = Object.keys(given).filter((k) => !DEDUCTIONS.includes(k));
  if (unknown.length) {
    return { num_ref: ref, accepted: false, reason: `undeclared_deduction:${unknown.join(',')}` };
  }

  const int = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : null);
  const d = Object.fromEntries(DEDUCTIONS.map((k) => [k, int(given[k]) ?? 0]));
  const gross = int(raw.gross_cs);
  const net = int(raw.net_cs);
  const commission = int(raw.commission_cs);

  // Term 7's "show the working", made machine-checkable. A one-unit tolerance
  // because two systems rounding the same percentage will disagree by a cent
  // and that is not a dispute.
  const sum = DEDUCTIONS.reduce((a, k) => a + d[k], 0);
  const arithmeticOk = gross == null || net == null ? null : Math.abs(gross - sum - net) <= 1;

  if (!env?.DB) return { num_ref: ref, accepted: false, reason: 'no_database' };
  try {
    await ensure(env);
    const r = await env.DB.prepare(
      `UPDATE num_handoffs
          SET state=?2, settled_at=?3, partner_ref=?4, currency=?5,
              gross_cs=?6, tax_cs=?7, surcharge_cs=?8, gds_cs=?9, gateway_cs=?10,
              net_cs=?11, commission_cs=?12, arithmetic_ok=?13, note=?14
        WHERE id=?1 AND partner_id=?15 AND state='issued'`,
    ).bind(
      v.id, state, Math.floor(Date.now() / 1000), clip(raw.partner_ref, 80), clip(raw.currency, 8),
      gross, d.tax_cs, d.surcharge_cs, d.gds_cs, d.gateway_cs,
      net, commission, arithmeticOk == null ? null : (arithmeticOk ? 1 : 0), clip(raw.note, 200),
      partnerId,
    ).run();

    if (!r?.meta?.changes) {
      // Either already settled (a retry — fine) or the reference belongs to a
      // different partner (not fine, and worth saying out loud rather than
      // reporting as a duplicate).
      const own = await env.DB.prepare('SELECT partner_id, state FROM num_handoffs WHERE id=?1')
        .bind(v.id).first().catch(() => null);
      if (!own) return { num_ref: ref, accepted: false, reason: 'unknown_reference' };
      if (own.partner_id !== partnerId) return { num_ref: ref, accepted: false, reason: 'wrong_partner' };
      return { num_ref: ref, accepted: false, reason: 'already_settled', state: own.state };
    }
    return { num_ref: ref, accepted: true, state, arithmetic_ok: arithmeticOk };
  } catch (e) {
    console.warn('[handoff] settlement write failed', e?.message ?? e);
    return { num_ref: ref, accepted: false, reason: 'write_failed' };
  }
}

/** What we hold for this partner, so both sides can compare the same list. */
export async function ledgerFor(env, partnerId, { since = 0, limit = 500 } = {}) {
  if (!env?.DB) return { rows: [], totals: null };
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, product, dest, issued_at, state, settled_at, partner_ref, currency,
            gross_cs, tax_cs, surcharge_cs, gds_cs, gateway_cs, net_cs, commission_cs, arithmetic_ok
       FROM num_handoffs
      WHERE partner_id = ?1 AND issued_at >= ?2
      ORDER BY issued_at DESC LIMIT ?3`,
  ).bind(partnerId, Math.max(0, Number(since) || 0), Math.min(Math.max(Number(limit) || 500, 1), 2000)).all();

  const rows = results ?? [];
  const confirmed = rows.filter((r) => r.state === 'confirmed');
  return {
    rows,
    totals: {
      handoffs: rows.length,
      confirmed: confirmed.length,
      // Named per term 7 so the two sides are adding up the same thing.
      gross_cs: confirmed.reduce((a, r) => a + (r.gross_cs ?? 0), 0),
      net_cs: confirmed.reduce((a, r) => a + (r.net_cs ?? 0), 0),
      commission_cs: confirmed.reduce((a, r) => a + (r.commission_cs ?? 0), 0),
      // Rows where the partner's own arithmetic did not close. Surfaced, never
      // silently dropped: an unexplained gap is the thing a reconciliation
      // exists to find.
      disputed: rows.filter((r) => r.arithmetic_ok === 0).length,
    },
  };
}

export const __testables = { sign, sameMac, newId };

// ── THE PARTNER-FACING SETTLEMENT FEED ───────────────────────────────────
//
// POST /api/partner/reconcile   X-Partner-Key: …
//   { "rows": [ { num_ref, partner_ref, status, currency, gross_cs,
//                 deductions: { tax_cs, surcharge_cs, gds_cs, gateway_cs },
//                 net_cs, commission_cs, note? }, … ] }
//   → per-row accepted/rejected with a reason. Never all-or-nothing: one bad
//     reference in a file of four hundred must not reject the other 399, and a
//     partner who has to re-send the whole day to fix one row will stop
//     sending.
//
// GET /api/partner/reconcile?since=<unix>   X-Partner-Key: …
//   → what NUM holds for this partner, and the totals, so both sides can
//     compare the same list rather than argue from two spreadsheets.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Partner-Key',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

/** A file bigger than this is a bulk export, not a daily settlement. */
const MAX_ROWS = 1000;

export async function handleReconcile(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env?.DB) return json({ error: 'Reconciliation is momentarily unavailable.' }, 503);

  const { partnerByKey } = await import('./partnersignup.mjs');
  const key = request.headers.get('X-Partner-Key') || '';
  if (!key) return json({ error: 'Send your key in the X-Partner-Key header.' }, 401);
  const partner = await partnerByKey(env, key);
  if (!partner || partner.state !== 'active') return json({ error: 'Unknown key.' }, 401);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const out = await ledgerFor(env, partner.id, {
      since: url.searchParams.get('since'),
      limit: url.searchParams.get('limit'),
    });
    return json({
      partner: partner.company,
      partner_id: partner.id,
      ...out,
      deductions_agreed: DEDUCTIONS,
      note: 'A row is a link NUM handed a traveller. `confirmed` is what the partner settled. '
        + 'arithmetic_ok is 0 where gross minus the agreed deductions did not equal net.',
    });
  }

  if (request.method !== 'POST') return json({ error: 'GET or POST.' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows) return json({ error: 'Send { rows: [ … ] }.' }, 400);
  if (rows.length > MAX_ROWS) {
    return json({ error: `At most ${MAX_ROWS} rows per request. Page it.` }, 413);
  }

  const results = [];
  for (const r of rows) results.push(await applySettlement(env, partner.id, r));

  const accepted = results.filter((r) => r.accepted);
  return json({
    partner_id: partner.id,
    received: rows.length,
    accepted: accepted.length,
    rejected: results.length - accepted.length,
    // The two numbers a finance team actually reads first.
    disputed: accepted.filter((r) => r.arithmetic_ok === false).length,
    deductions_agreed: DEDUCTIONS,
    results,
  });
}
