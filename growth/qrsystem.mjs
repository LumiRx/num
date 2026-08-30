/**
 * qrsystem — tables, the codes stuck to them, who may issue them, and the
 * agent that keeps the whole thing tidy without being asked.
 *
 * The shape, in one paragraph. A venue declares its floor once as rows in
 * `num_resources` ("table 1" … "table 20"). Each active table carries exactly
 * two permanent codes: a PAY STICKER (`num_paylinks`, open amount, one_time=0)
 * and a CHECK-IN code (`num_venue_codes`). Neither ever changes. At payment
 * time a BILL CODE is minted for one table and one amount, is paid once, and
 * dies — and because NUM generated that figure, NUM can finally compute its
 * 10%. An open sticker never reports an amount, which is the whole reason
 * revenue has been stuck at zero.
 *
 * Two rules run through every function here and are asserted in the tests:
 *
 *   1. Money destinations are inherited, never supplied. A bill code copies
 *      its target from the sticker on its own table. Nothing a caller sends
 *      can change where baht lands.
 *   2. Everything is scoped to one business. Every read and every write
 *      carries a business_id, so a session for one venue cannot see or touch
 *      another's floor, codes, staff or takings.
 */

import { mintBillCode, settleBillCode, parseAmount } from '../worker/billqr.mjs';

/* ── small shared helpers ────────────────────────────────────────────────── */

// No 0/O and no 1/I/L. These get read aloud across a noisy restaurant and
// typed in by someone holding a tray.
const ALPHABET = '23456789ACDEFGHJKMNPQRTUVWXY';

export function newToken(len = 8) {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString();

// Strip control characters only. Spaces and hyphens are load-bearing here —
// they are in "Table 1" and in half the world's email addresses.
export function clean(s, max = 80) {
  return String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

const lc = (s) => String(s ?? '').trim().toLowerCase();

/** Constant-time-ish compare. Not for keys derived from user input length. */
export function sameSecret(a, b) {
  const x = String(a ?? ''); const y = String(b ?? '');
  if (x.length !== y.length || !x.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/* ── roles ───────────────────────────────────────────────────────────────── */

/**
 * A waiter needs exactly one power: put an amount on a table and get a QR back.
 * Everything else — defining the floor, printing stickers, adding staff — is a
 * manager's job. Keeping `bill` the only thing `staff` can do is what makes it
 * safe to hand the link to seasonal floor staff.
 *
 * `settings` is OWNER ONLY, and deliberately not a manager's. The three
 * switches behind it change what the venue is charged (10% of the bill rather
 * than $2 a table) and commit the business to passing on tips it did not
 * previously collect. A manager can run a shift; agreeing to a different
 * billing basis is the owner's signature, not theirs.
 */
export const CAN = Object.freeze({
  owner:    Object.freeze(['tables', 'stickers', 'bill', 'settle', 'revoke', 'staff', 'view', 'settings']),
  manager:  Object.freeze(['tables', 'stickers', 'bill', 'settle', 'revoke', 'view']),
  staff:    Object.freeze(['bill', 'settle', 'view']),
  readonly: Object.freeze(['view']),
});

export function can(role, action) {
  return (CAN[role] ?? []).includes(action);
}

/* ── tables ──────────────────────────────────────────────────────────────── */

const RESOURCE_TYPES = Object.freeze([
  'table', 'room', 'cabana', 'slot', 'vessel', 'seat', 'ticket', 'ride',
]);

export async function listTables(env, businessId) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.type, r.name, r.capacity, r.max_party_size, r.active,
            (SELECT token FROM num_paylinks p
              WHERE p.business_id = r.business_id AND p.resource_id = r.id
                AND p.state='active' AND COALESCE(p.one_time,0)=0
              ORDER BY p.created_at DESC LIMIT 1)            AS sticker,
            (SELECT token FROM num_venue_codes c
              WHERE c.business_id = r.business_id AND c.resource_id = r.id
                AND c.state='active'
              ORDER BY c.created_at DESC LIMIT 1)            AS checkin,
            (SELECT COUNT(*) FROM num_paylinks b
              WHERE b.business_id = r.business_id AND b.resource_id = r.id
                AND COALESCE(b.one_time,0)=1 AND b.state='active'
                AND b.settled_at IS NULL)                    AS open_bills
       FROM num_resources r
      WHERE r.business_id = ?1
      ORDER BY r.active DESC, r.name`,
  ).bind(businessId).all();
  return results ?? [];
}

/**
 * Expand "tables 1 to 20" into names. A venue should never hand-type twenty
 * rows, and twenty hand-typed rows is twenty chances to mislabel a sticker
 * that then gets glued to a table for a year.
 */
export function expandNames({ names, prefix, from, to } = {}) {
  if (Array.isArray(names) && names.length) {
    const out = [];
    for (const n of names) {
      const v = clean(n, 40);
      if (v) out.push(v);
    }
    return out.slice(0, 200);
  }
  const a = Number(from); const b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return [];
  if (a < 0 || b < a || b - a > 199) return [];
  const p = clean(prefix, 20) || 'Table';
  const out = [];
  for (let i = a; i <= b; i++) out.push(`${p} ${i}`.trim());
  return out;
}

export async function createTables(env, businessId, spec = {}) {
  const type = RESOURCE_TYPES.includes(clean(spec.type, 12)) ? clean(spec.type, 12) : 'table';
  const names = expandNames(spec);
  if (!names.length) return { ok: false, reason: 'nothing to create' };

  const capacity = Math.max(1, Math.min(500, Number(spec.capacity) || 1));
  const maxParty = Math.max(1, Math.min(500, Number(spec.max_party_size) || 4));

  const { results: existing } = await env.DB.prepare(
    'SELECT lower(name) AS n FROM num_resources WHERE business_id = ?1',
  ).bind(businessId).all();
  const have = new Set((existing ?? []).map((r) => r.n));

  const made = []; const skipped = [];
  const t = nowSec();
  for (const name of names) {
    if (have.has(name.toLowerCase())) { skipped.push(name); continue; }
    const id = 'res_' + newToken(12).toLowerCase();
    await env.DB.prepare(
      `INSERT INTO num_resources
         (id,business_id,type,name,capacity,max_party_size,
          slot_grain_min,min_slots,max_slots,buffer_min,price_cs,min_spend_cs,
          attributes,active,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,60,1,1,0,0,0,'{}',1,?7,?7)`,
    ).bind(id, businessId, type, name, capacity, maxParty, t).run();
    made.push({ id, name, type });
    have.add(name.toLowerCase());
  }
  return { ok: true, created: made, skipped };
}

export async function setTableActive(env, businessId, resourceId, active) {
  const r = await env.DB.prepare(
    'UPDATE num_resources SET active = ?3, updated_at = ?4 WHERE id = ?1 AND business_id = ?2',
  ).bind(resourceId, businessId, active ? 1 : 0, nowSec()).run();
  return { ok: !!r?.meta?.changes };
}

/* ── the two permanent codes on a table ──────────────────────────────────── */

/**
 * Give every active table the sticker and check-in code it is missing.
 *
 * Idempotent by design — it is what the agent calls every fifteen minutes, so
 * running it twice must never double-issue. A table that already has a live
 * code of a kind is skipped, not re-minted.
 *
 * The sticker's payment target is copied from the venue's existing payment
 * identity. If they have none, no sticker is created and the table is reported
 * as blocked: there is nowhere for the money to go, and a QR that points
 * nowhere is worse than no QR.
 */
export async function ensureTableCodes(env, businessId, { issuedBy = null } = {}) {
  const tables = await listTables(env, businessId);
  const active = tables.filter((t) => t.active);

  const identity = await env.DB.prepare(
    `SELECT kind, target, promptpay_kind, crypto_asset, currency FROM num_paylinks
      WHERE business_id = ?1 AND state='active' AND COALESCE(one_time,0)=0
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(businessId).first().catch(() => null);

  const stickers = []; const checkins = []; const blocked = [];

  for (const t of active) {
    if (!t.sticker) {
      if (!identity?.target) {
        blocked.push({ resource_id: t.id, name: t.name, reason: 'no payment identity yet' });
      } else {
        const tok = newToken();
        await env.DB.prepare(
          `INSERT INTO num_paylinks
             (token,business_id,label,kind,target,promptpay_kind,crypto_asset,amount_mode,amount,
              currency,zone_type,state,created_at,one_time,resource_id,issued_by)
           VALUES (?1,?2,?3,?4,?5,?6,?7,'open',NULL,?8,?9,'active',?10,0,?11,?12)`,
        ).bind(
          tok, businessId, t.name, identity.kind, identity.target,
          identity.promptpay_kind ?? null, identity.crypto_asset ?? null,
          identity.currency || 'THB', t.type, iso(), t.id, issuedBy,
        ).run();
        stickers.push({ resource_id: t.id, name: t.name, token: tok });
      }
    }
    if (!t.checkin) {
      const tok = newToken();
      await env.DB.prepare(
        `INSERT INTO num_venue_codes
           (token,business_id,label,state,created_at,zone_type,resource_id)
         VALUES (?1,?2,?3,'active',?4,?5,?6)`,
      ).bind(tok, businessId, t.name, iso(), t.type, t.id).run();
      checkins.push({ resource_id: t.id, name: t.name, token: tok });
    }
  }
  return { ok: true, stickers, checkins, blocked };
}

/* ── bill codes ──────────────────────────────────────────────────────────── */

/**
 * Put an amount on a table and get back a QR the guest can pay.
 *
 * Everything that decides where the money goes is read from the database.
 * `amount` is the only figure the caller contributes, and parseAmount refuses
 * anything that is not a plain number — a bill NUM cannot read is a bill NUM
 * cannot take a percentage of.
 */
export async function billForTable(env, {
  businessId, resourceId = null, amount, bookingId = null, issuedBy = null, label = null,
  attachBooking = true,
}) {
  const table = resourceId
    ? await env.DB.prepare(
      'SELECT id, name FROM num_resources WHERE id = ?1 AND business_id = ?2',
    ).bind(resourceId, businessId).first().catch(() => null)
    : null;
  if (resourceId && !table) return { ok: false, reason: 'unknown table' };
  let booked = null;

  // Attach the booking unless the caller has explicitly said walk-in
  // (bookingId === '' clears it). Staff should not have to remember this: the
  // difference between an attached and unattached bill is the whole fee, and
  // nobody at a till is thinking about our ledger.
  let booking = bookingId;
  if (attachBooking && booking == null) {
    const found = await openBookingFor(env, businessId, table?.id ?? resourceId);
    booking = found?.id ?? null;
    if (found) booked = found;
  }
  if (booking === '') booking = null;

  const out = await mintBillCode(env, {
    businessId,
    bookingId: booking,
    amount,
    resourceId: table?.id ?? null,
    issuedBy,
    label: label ?? (table ? `Bill · ${table.name}` : null),
  });
  return booked ? { ...out, booking: booked } : out;
}

export async function settleBill(env, businessId, tokenValue, { settledBy = null } = {}) {
  // Scope the settle to the venue that owns the code. Otherwise a session for
  // one venue could close another venue's bill and move their ledger.
  const own = await env.DB.prepare(
    'SELECT token FROM num_paylinks WHERE token = ?1 AND business_id = ?2',
  ).bind(clean(tokenValue, 40).toUpperCase(), businessId).first().catch(() => null);
  if (!own) return { ok: false, reason: 'unknown code' };
  return settleBillCode(env, own.token, { settledBy });
}

export async function openBills(env, businessId) {
  const { results } = await env.DB.prepare(
    `SELECT p.token, p.label, p.amount, p.currency, p.created_at, p.resource_id,
            r.name AS table_name, p.booking_id, p.issued_by
       FROM num_paylinks p
       LEFT JOIN num_resources r ON r.id = p.resource_id
      WHERE p.business_id = ?1 AND COALESCE(p.one_time,0)=1
        AND p.state='active' AND p.settled_at IS NULL
      ORDER BY p.created_at DESC LIMIT 100`,
  ).bind(businessId).all();
  return results ?? [];
}

/* ── staff: emailed magic link, then a session ───────────────────────────── */

const LOGIN_TTL_S = 20 * 60;            // a link is useful for one sitting
const SESSION_TTL_S = 30 * 24 * 3600;   // a phone behind a bar is not re-auth'd daily

/**
 * Start a sign-in. Returns the token to mail — the caller sends the email, so
 * this stays testable without a mail provider.
 *
 * It never reveals whether an address is a real staff member. An unknown email
 * returns the same shape as a known one, because "no such user" on a merchant
 * console is a way to enumerate which venues are on NUM.
 */
export async function startLogin(env, email, { ip = null } = {}) {
  const e = lc(email);
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) return { ok: false, reason: 'bad email' };

  const user = await env.DB.prepare(
    `SELECT u.id, u.business_id, u.role, u.name, u.status, b.name AS business_name
       FROM num_business_users u JOIN businesses b ON b.id = u.business_id
      WHERE lower(u.email) = ?1 AND u.status = 'active' AND b.status = 'active'
      LIMIT 1`,
  ).bind(e).first().catch(() => null);

  if (!user) return { ok: true, sent: false };   // deliberately indistinguishable

  const token = newToken(28);
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO num_biz_logins (token,user_id,business_id,email_lc,expires_at,created_ip,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(token, user.id, user.business_id, e, t + LOGIN_TTL_S, ip, t).run();

  return { ok: true, sent: true, token, user };
}

/** Redeem a mailed token exactly once. */
export async function redeemLogin(env, token) {
  const tok = clean(token, 40);
  if (!tok) return { ok: false, reason: 'missing token' };

  const row = await env.DB.prepare(
    'SELECT token,user_id,business_id,expires_at,used_at FROM num_biz_logins WHERE token = ?1',
  ).bind(tok).first().catch(() => null);
  if (!row) return { ok: false, reason: 'unknown link' };
  if (row.used_at) return { ok: false, reason: 'that link has already been used' };
  if (row.expires_at < nowSec()) return { ok: false, reason: 'that link has expired' };

  // Burn it first. If two taps race, only the one that changed a row proceeds.
  const burn = await env.DB.prepare(
    'UPDATE num_biz_logins SET used_at = ?2 WHERE token = ?1 AND used_at IS NULL',
  ).bind(tok, nowSec()).run();
  if (!burn?.meta?.changes) return { ok: false, reason: 'that link has already been used' };

  const user = await env.DB.prepare(
    `SELECT u.id, u.business_id, u.role, u.name, u.email, b.name AS business_name
       FROM num_business_users u JOIN businesses b ON b.id = u.business_id
      WHERE u.id = ?1 AND u.status='active' AND b.status='active'`,
  ).bind(row.user_id).first().catch(() => null);
  if (!user) return { ok: false, reason: 'that account is no longer active' };

  const sid = newToken(32);
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO num_biz_sessions (sid,user_id,business_id,role,expires_at,created_at,last_seen_at)
     VALUES (?1,?2,?3,?4,?5,?6,?6)`,
  ).bind(sid, user.id, user.business_id, user.role, t + SESSION_TTL_S, t).run();

  return { ok: true, sid, user };
}

export async function sessionUser(env, sid) {
  const s = clean(sid, 40);
  if (!s) return null;
  const row = await env.DB.prepare(
    `SELECT s.sid, s.user_id, s.business_id, s.role, s.expires_at, s.revoked_at,
            u.name, u.email, u.status AS user_status, b.name AS business_name, b.status AS biz_status
       FROM num_biz_sessions s
       JOIN num_business_users u ON u.id = s.user_id
       JOIN businesses b ON b.id = s.business_id
      WHERE s.sid = ?1`,
  ).bind(s).first().catch(() => null);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at < nowSec()) return null;
  // A disabled staff member's live session must die with the account, not at
  // its own expiry thirty days later.
  if (row.user_status !== 'active' || row.biz_status !== 'active') return null;

  await env.DB.prepare('UPDATE num_biz_sessions SET last_seen_at = ?2 WHERE sid = ?1')
    .bind(s, nowSec()).run().catch(() => {});
  return row;
}

export async function endSession(env, sid) {
  await env.DB.prepare('UPDATE num_biz_sessions SET revoked_at = ?2 WHERE sid = ?1')
    .bind(clean(sid, 40), nowSec()).run().catch(() => {});
  return { ok: true };
}

/** Add a staff member. Owners only — enforced by the caller via can(). */
export async function addStaff(env, businessId, { email, name, role }) {
  const e = lc(email);
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) return { ok: false, reason: 'bad email' };
  if (!Object.keys(CAN).includes(role)) return { ok: false, reason: 'unknown role' };

  const dup = await env.DB.prepare(
    'SELECT id FROM num_business_users WHERE business_id = ?1 AND lower(email) = ?2',
  ).bind(businessId, e).first().catch(() => null);
  if (dup) return { ok: false, reason: 'already on this venue', id: dup.id };

  const id = 'bu_' + newToken(12).toLowerCase();
  await env.DB.prepare(
    `INSERT INTO num_business_users (id,business_id,account_id,email,name,role,status,created_at)
     VALUES (?1,?2,NULL,?3,?4,?5,'active',?6)`,
  ).bind(id, businessId, e, clean(name, 60) || null, role, nowSec()).run();
  return { ok: true, id, email: e, role };
}

export async function listStaff(env, businessId) {
  const { results } = await env.DB.prepare(
    `SELECT id, email, name, role, status, created_at
       FROM num_business_users WHERE business_id = ?1 ORDER BY created_at`,
  ).bind(businessId).all();
  return results ?? [];
}

export async function setStaffStatus(env, businessId, userId, status) {
  if (!['active', 'disabled'].includes(status)) return { ok: false, reason: 'bad status' };
  const r = await env.DB.prepare(
    'UPDATE num_business_users SET status = ?3 WHERE id = ?1 AND business_id = ?2',
  ).bind(userId, businessId, status).run();
  if (status === 'disabled') {
    await env.DB.prepare(
      'UPDATE num_biz_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL',
    ).bind(userId, nowSec()).run().catch(() => {});
  }
  return { ok: !!r?.meta?.changes };
}

/* ── the agent ───────────────────────────────────────────────────────────── */

// A bill that has sat unpaid for this long is stale. Long enough that a slow
// table is never cut off mid-meal; short enough that a QR photographed off a
// receipt cannot be paid tomorrow.
export const BILL_TTL_MIN = 90;
// A scan is not a payment. After this we stop waiting and ask a human.
export const CHASE_AFTER_H = 24;

async function log(env, task, action, { businessId = null, ref = null, detail = null } = {}) {
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO num_agent_runs (ran_at,task,business_id,action,ref,detail,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?1)`,
  ).bind(t, task, businessId, action, ref, detail).run().catch(() => {});
}

/**
 * Every active table gets the codes it is missing.
 *
 * This is what makes the system self-maintaining: a manager adds "Table 21" and
 * it becomes scannable within fifteen minutes without anyone remembering to
 * press a second button.
 */
export async function agentIssue(env) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT r.business_id FROM num_resources r
       JOIN businesses b ON b.id = r.business_id
      WHERE r.active = 1 AND b.status = 'active'`,
  ).all();

  let stickers = 0; let checkins = 0; let blocked = 0;
  for (const row of results ?? []) {
    const out = await ensureTableCodes(env, row.business_id, { issuedBy: 'agent' });
    stickers += out.stickers.length;
    checkins += out.checkins.length;
    blocked += out.blocked.length;
    for (const s of out.stickers) {
      await log(env, 'issue', 'sticker', { businessId: row.business_id, ref: s.token, detail: s.name });
    }
    for (const c of out.checkins) {
      await log(env, 'issue', 'checkin', { businessId: row.business_id, ref: c.token, detail: c.name });
    }
    for (const b of out.blocked) {
      await log(env, 'issue', 'flag', { businessId: row.business_id, ref: b.resource_id, detail: b.reason });
    }
  }
  return { stickers, checkins, blocked };
}

/** Revoke bill codes nobody ever paid, so a stale QR cannot be paid later. */
export async function agentExpire(env, { ttlMin = BILL_TTL_MIN } = {}) {
  const cutoff = new Date(Date.now() - ttlMin * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT token, business_id, label FROM num_paylinks
      WHERE COALESCE(one_time,0)=1 AND state='active' AND settled_at IS NULL
        AND created_at < ?1 LIMIT 500`,
  ).bind(cutoff).all();

  let n = 0;
  for (const r of results ?? []) {
    const done = await env.DB.prepare(
      `UPDATE num_paylinks SET state='revoked', revoked_at=?2, revoked_by='agent'
        WHERE token=?1 AND state='active' AND settled_at IS NULL`,
    ).bind(r.token, iso()).run();
    if (done?.meta?.changes) {
      n++;
      await log(env, 'expire', 'revoke', { businessId: r.business_id, ref: r.token, detail: r.label });
    }
  }
  return { expired: n };
}

/**
 * Heal bills that settled but whose ledger row never caught up.
 *
 * settleBillCode is idempotent, so re-running it on an already-settled code is
 * safe: it re-pushes the value and returns `already` if there is nothing to do.
 * A dropped write at payment time self-heals within fifteen minutes instead of
 * becoming a dinner nobody ever billed for.
 */
export async function agentReconcile(env, { limit = 200 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT p.token, p.business_id, p.booking_id, p.amount
       FROM num_paylinks p
       JOIN num_commissions c ON c.booking_id = p.booking_id
      WHERE COALESCE(p.one_time,0)=1 AND p.settled_at IS NOT NULL
        AND p.booking_id IS NOT NULL AND c.state = 'awaiting_value'
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));

  let healed = 0;
  for (const r of results ?? []) {
    const amt = parseAmount(r.amount);
    if (!amt.ok) {
      await log(env, 'reconcile', 'flag', {
        businessId: r.business_id, ref: r.token, detail: 'stored amount unreadable',
      });
      continue;
    }
    const out = await settleBillCode(env, r.token).catch(() => null);
    if (out?.billed) {
      healed++;
      await log(env, 'reconcile', 'settle', {
        businessId: r.business_id, ref: r.token, detail: 'booking ' + r.booking_id,
      });
    }
  }
  return { healed };
}

/** Scanned but never settled for a day. Reported, never auto-billed. */
export async function agentChase(env, { afterH = CHASE_AFTER_H } = {}) {
  const cutoff = new Date(Date.now() - afterH * 3600_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT p.token, p.business_id, p.label, p.amount,
            (SELECT COUNT(*) FROM num_pay_events e WHERE e.token = p.token) AS events
       FROM num_paylinks p
      WHERE COALESCE(p.one_time,0)=1 AND p.settled_at IS NULL
        AND p.created_at < ?1 AND (p.revoked_by IS NULL OR p.revoked_by <> 'agent')
      LIMIT 200`,
  ).bind(cutoff).all().catch(() => ({ results: [] }));

  let flagged = 0;
  for (const r of results ?? []) {
    if (!r.events) continue;         // never scanned — nothing to chase
    flagged++;
    await log(env, 'chase', 'flag', {
      businessId: r.business_id,
      ref: r.token,
      detail: `${r.events} scan(s), ${r.amount} never settled`,
    });
  }
  return { flagged };
}

/**
 * A bill code is for one table and one party. Many DIFFERENT people scanning
 * one is a link that has left the table it was minted for — photographed and
 * forwarded, or posted in a group chat.
 *
 * The signal is deliberately drawn from a bill code and not a sticker: a
 * sticker being scanned by hundreds of strangers is a busy restaurant, which
 * is the thing working. `num_pay_events` records `visitor_id` and `ip_hash`
 * and no country, so distinct visitors is what there is to count.
 *
 * Reported, never revoked. Killing a venue's live code on a guess stops them
 * taking money, and a wrong guess costs them a dinner service.
 */
export async function agentWatch(env, { minVisitors = 8, days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');
  const { results } = await env.DB.prepare(
    `SELECT e.token, e.business_id,
            COUNT(DISTINCT COALESCE(e.visitor_id, e.ip_hash)) AS people,
            COUNT(*) AS scans
       FROM num_pay_events e
       JOIN num_paylinks p ON p.token = e.token AND COALESCE(p.one_time,0) = 1
      WHERE e.kind='scan' AND e.day >= ?1
        AND COALESCE(e.visitor_id, e.ip_hash) IS NOT NULL
      GROUP BY e.token, e.business_id
      HAVING people >= ?2
      LIMIT 100`,
  ).bind(since, minVisitors).all().catch(() => ({ results: [] }));

  let flagged = 0;
  for (const r of results ?? []) {
    flagged++;
    await log(env, 'watch', 'flag', {
      businessId: r.business_id,
      ref: r.token,
      detail: `${r.people} different people scanned one bill code in ${days}d (${r.scans} scans) — possible leaked link`,
    });
  }
  return { flagged };
}

/**
 * One pass. Ordered so that anything it creates this minute is not immediately
 * expired by the next step, and so reconciliation happens before we chase
 * anything for being unsettled.
 *
 * Each task is isolated: one failing table, one malformed amount or one
 * missing column must not stop the other four from running.
 */
export async function runAgent(env, { tasks = null } = {}) {
  const want = (t) => !tasks || tasks.includes(t);
  const out = { ran_at: nowSec() };
  const step = async (name, fn) => {
    if (!want(name)) return;
    try { out[name] = await fn(); } catch (e) { out[name] = { error: String(e).slice(0, 200) }; }
  };
  await step('issue', () => agentIssue(env));
  await step('reconcile', () => agentReconcile(env));
  await step('expire', () => agentExpire(env));
  await step('chase', () => agentChase(env));
  await step('watch', () => agentWatch(env));
  return out;
}

export async function agentLog(env, { businessId = null, limit = 100 } = {}) {
  const q = businessId
    ? env.DB.prepare(
      `SELECT ran_at, task, action, ref, detail FROM num_agent_runs
        WHERE business_id = ?1 ORDER BY id DESC LIMIT ?2`,
    ).bind(businessId, limit)
    : env.DB.prepare(
      'SELECT ran_at, task, business_id, action, ref, detail FROM num_agent_runs ORDER BY id DESC LIMIT ?1',
    ).bind(limit);
  const { results } = await q.all();
  return results ?? [];
}

/* ── the payment identity ────────────────────────────────────────────────
 * The one thing that has to exist before any of the rest produces a baht:
 * somewhere for the money to go. Everything else in this file inherits from
 * it — a table sticker copies it, and a bill code copies the sticker.
 *
 * It is deliberately a normal paylink row rather than a new concept. The
 * inheritance rule in billqr.mjs already reads "the venue's active, non
 * one-time code", so the seed IS the identity, and there is no second place
 * where a payment destination can live and drift out of step.
 */

export const IDENTITY_LABEL = 'House';

/**
 * The venue's payment identity, or null.
 *
 * The house seed (no table of its own) wins over a table sticker. They carry
 * the same target today, but a venue that later gives one table its own
 * account must not have that table silently become the whole venue's identity.
 */
export async function identityOf(env, businessId) {
  return env.DB.prepare(
    `SELECT token, label, kind, target, promptpay_kind, crypto_asset, currency, created_at
       FROM num_paylinks
      WHERE business_id = ?1 AND state = 'active' AND COALESCE(one_time,0) = 0
      ORDER BY (resource_id IS NULL) DESC, created_at ASC
      LIMIT 1`,
  ).bind(businessId).first().catch(() => null);
}

/**
 * Set it, once.
 *
 * There is no edit, for the same reason a paylink target has never been
 * editable: a destination that can be changed after the QR is printed is a
 * destination someone else can change. Moving bank accounts means retiring the
 * codes and issuing new ones, which is loud and leaves both halves in the log.
 *
 * `kind` / `target` arrive already validated by the caller — validPayTarget is
 * the worker's, and it is the only thing that decides what a legal PromptPay
 * id or payout URL looks like.
 */
export async function setIdentity(env, businessId, {
  kind, target, promptpayKind = null, cryptoAsset = null, currency = 'THB', issuedBy = null,
} = {}) {
  if (!kind || !target) return { ok: false, reason: 'missing payment target' };

  const existing = await identityOf(env, businessId);
  if (existing) {
    return {
      ok: false,
      reason: 'this venue already has a payment identity — retire it before setting another',
      token: existing.token,
    };
  }

  const tok = newToken();
  await env.DB.prepare(
    `INSERT INTO num_paylinks
       (token,business_id,label,kind,target,promptpay_kind,crypto_asset,amount_mode,amount,
        currency,state,created_at,one_time,issued_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'open',NULL,?8,'active',?9,0,?10)`,
  ).bind(tok, businessId, IDENTITY_LABEL, kind, target, promptpayKind, cryptoAsset,
         currency, iso(), issuedBy).run();

  // Every table that was waiting on this can now be printed.
  const codes = await ensureTableCodes(env, businessId, { issuedBy });
  return { ok: true, token: tok, kind, target, codes };
}

/**
 * Retire the identity and every table sticker that inherited it.
 *
 * Check-in codes are deliberately left alone: they carry no money, they are
 * printed on the same card, and revoking them would make a venue reprint
 * everything to change a bank account.
 *
 * Nothing is deleted. A revoked row still explains where money used to go,
 * which is the question asked when a guest says they paid and the venue says
 * they did not.
 */
export async function retireIdentity(env, businessId, { by = null } = {}) {
  const who = by || 'venue';
  const stamp = iso();

  const kill = async (rows) => {
    let n = 0;
    for (const r of rows ?? []) {
      const done = await env.DB.prepare(
        `UPDATE num_paylinks SET state='revoked', revoked_at=?2, revoked_by=?3
          WHERE token=?1 AND state='active'`,
      ).bind(r.token, stamp, who).run();
      if (done?.meta?.changes) n++;
    }
    return n;
  };

  const { results: seeds } = await env.DB.prepare(
    `SELECT token FROM num_paylinks
      WHERE business_id = ?1 AND state = 'active' AND COALESCE(one_time,0) = 0`,
  ).bind(businessId).all();

  // Unsettled bills inherited the target the venue has just disowned. Leaving
  // them live means a guest can still pay into an account the venue said stop
  // using — which is the whole reason someone retires an identity. They are
  // cancelled too, and the count is returned separately so the console can say
  // "re-issue these" rather than the venue discovering it at the till.
  //
  // A SETTLED bill is never touched: it is a record of money that already moved.
  const { results: bills } = await env.DB.prepare(
    `SELECT token FROM num_paylinks
      WHERE business_id = ?1 AND state = 'active'
        AND COALESCE(one_time,0) = 1 AND settled_at IS NULL`,
  ).bind(businessId).all();

  const retired = await kill(seeds);
  const cancelledBills = await kill(bills);
  return { ok: true, retired, cancelled_bills: cancelledBills };
}

/** How many active tables are waiting on an identity before they can be printed. */
export async function tablesWaiting(env, businessId) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM num_resources r
      WHERE r.business_id = ?1 AND r.active = 1
        AND NOT EXISTS (SELECT 1 FROM num_paylinks p
                         WHERE p.business_id = r.business_id AND p.resource_id = r.id
                           AND p.state='active' AND COALESCE(p.one_time,0)=0)`,
  ).bind(businessId).first().catch(() => null);
  return r?.n || 0;
}

/* ── binding a bill to the booking that earned it ────────────────────────
 * The 10% is only ever charged on a guest NUM actually sent. That link is the
 * booking id on the bill code: no booking, `settleBillCode` treats the payment
 * as a walk-in and bills nothing — which is correct, and which also means a
 * console that never attaches a booking can never earn anything at all.
 */

// A table is usually billed at the end of a sitting, which can run well past
// the booked time, and staff sometimes mint the code while the guest is still
// being seated.
const BOOKING_EARLY_S = 2 * 3600;
const BOOKING_LATE_S = 5 * 3600;

/**
 * The confirmed booking this table is most likely being billed for.
 *
 * Prefers a booking on the same table, then the most recent one that started.
 * Returns null rather than guessing when nothing is in the window — attaching
 * the wrong booking bills the wrong guest's host and corrupts the ledger, so
 * "no booking" is the safer answer.
 */
export async function openBookingFor(env, businessId, resourceId = null, { at = null } = {}) {
  const t = Math.floor((at ? new Date(at).getTime() : Date.now()) / 1000);
  return env.DB.prepare(
    `SELECT id, short_code, party_size, starts_at, resource_id
       FROM num_bookings
      WHERE business_id = ?1
        AND status = 'confirmed'
        AND starts_at BETWEEN ?2 AND ?3
        AND id NOT IN (
          SELECT booking_id FROM num_paylinks
           WHERE business_id = ?1 AND booking_id IS NOT NULL AND settled_at IS NOT NULL)
      ORDER BY (resource_id IS NOT NULL AND resource_id = ?4) DESC, starts_at DESC
      LIMIT 1`,
  ).bind(businessId, t - BOOKING_LATE_S, t + BOOKING_EARLY_S, resourceId)
    .first().catch(() => null);
}

/** Bookings a bill could reasonably be attached to right now, for the console. */
export async function billableBookings(env, businessId, { at = null } = {}) {
  const t = Math.floor((at ? new Date(at).getTime() : Date.now()) / 1000);
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.short_code, b.party_size, b.starts_at, b.resource_id, r.name AS table_name
       FROM num_bookings b
       LEFT JOIN num_resources r ON r.id = b.resource_id
      WHERE b.business_id = ?1 AND b.status = 'confirmed'
        AND b.starts_at BETWEEN ?2 AND ?3
        AND b.id NOT IN (
          SELECT booking_id FROM num_paylinks
           WHERE business_id = ?1 AND booking_id IS NOT NULL AND settled_at IS NOT NULL)
      ORDER BY b.starts_at DESC LIMIT 20`,
  ).bind(businessId, t - BOOKING_LATE_S, t + BOOKING_EARLY_S).all().catch(() => ({ results: [] }));
  return results ?? [];
}
