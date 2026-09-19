/**
 * The guest scans the table's own sticker and sees their actual bill.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
 *
 * Every other path to a bill needs a member of staff: they tap the table and
 * type a figure, or they photograph the slip and confirm what the model read.
 * Lightspeed K-Series is the first till that can answer "what does table seven
 * owe?" on its own, and it returns the lines with it. So at a venue on
 * K-Series the whole thing collapses to one action by the guest: scan the
 * permanent sticker already on the table, see the real order, pay it.
 *
 * ── THE MAPPING IS STORED, NEVER GUESSED ─────────────────────────────────
 *
 * K-Series keys checks by tableNumber. NUM keys its floor by a name a venue
 * chose — "Table 7", "T7", "Terrace 2", "Bar 3". Parsing digits out of that
 * works most of the time, and the one time it does not, a guest is shown
 * somebody else's dinner and invited to pay for it. That is precisely the
 * failure the Square and Clover adapters refuse to risk by leaving the match
 * to a human, and it does not stop being that failure because a third till
 * exposes the field.
 *
 * So `suggestTableNumber` produces a SUGGESTION for the console to offer and a
 * person to confirm, and nothing here reads a check for a table that has no
 * stored mapping. An unmapped table behaves exactly as a Square venue does:
 * staff type the figure.
 *
 * ── AND THE GUEST CONFIRMS IT IS THEIRS ──────────────────────────────────
 *
 * Even correctly mapped, a check can belong to the party before yours if the
 * table was not cleared on the till. So the check is SHOWN — items, when it
 * was opened, how many covers — and the guest raises it as a bill themselves.
 * This module never mints from a page being drawn.
 */
import { mintBillCode } from './billqr.mjs';
import { saveItems } from './billitems.mjs';
import { currencyFor } from './billphoto.mjs';
import { connectionFor, withFreshToken, adapterFor } from '../growth/pos/index.mjs';

/**
 * The digits in a table's name, offered to a human and never used alone.
 *
 * Returns null rather than a bad guess: "Terrace" has no number, and "Table
 * 12A" is ambiguous enough that somebody should say what the till calls it.
 */
export function suggestTableNumber(name) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  const nums = s.match(/\d+/g);
  // Exactly one run of digits, or it is not a suggestion worth making.
  if (!nums || nums.length !== 1) return null;
  // And nothing clinging to it: "12A" is not 12 as far as a till is concerned.
  if (/\d[A-Za-z]/.test(s) || /[A-Za-z]\d/.test(s.replace(/^[A-Za-z]+\s*/, ''))) return null;
  const n = nums[0].replace(/^0+(?=\d)/, '');
  return n.length <= 6 ? n : null;
}

/** What this venue's till calls this table, if a person has said. */
export async function tillTableFor(env, businessId, resourceId) {
  if (!env?.DB || !businessId || !resourceId) return null;
  const row = await env.DB.prepare(
    'SELECT pos_table, name FROM num_resources WHERE id = ?1 AND business_id = ?2',
  ).bind(String(resourceId), String(businessId)).first().catch(() => null);
  return row?.pos_table ? { table: String(row.pos_table), name: row.name ?? null } : null;
}

/**
 * The live check for this table, or a reason there isn't one.
 *
 * Every no is a specific no, because the pay page has to say something true
 * to a guest standing at the table rather than showing a blank.
 */
export async function liveCheckFor(env, businessId, resourceId) {
  const mapped = await tillTableFor(env, businessId, resourceId);
  if (!mapped) return { ok: false, why: 'unmapped' };

  const conn0 = await connectionFor(env, businessId);
  if (!conn0) return { ok: false, why: 'no_till' };

  const adapter = adapterFor(conn0.vendor);
  // Only a till that can be asked about ONE table qualifies. Reading every
  // open check and picking one by amount would be the guess this module
  // exists to refuse.
  if (typeof adapter?.checkForTable !== 'function') return { ok: false, why: 'till_has_no_tables' };

  const conn = await withFreshToken(env, conn0);
  if (!conn?.usable) return { ok: false, why: 'till_needs_reconnecting' };

  let check;
  try {
    check = await adapter.checkForTable(env, conn, mapped.table);
  } catch (e) {
    console.warn('[tillbill] could not read the check', e?.message ?? e);
    return { ok: false, why: 'till_unreachable' };
  }
  if (!check) return { ok: false, why: 'nothing_open' };
  if (!(check.amount_minor > 0)) return { ok: false, why: 'nothing_owed' };

  // The till does not say what currency it is in — K-Series has no such field
  // — so it comes from the venue's own profile, exactly as a photographed
  // bill does.
  const currency = await currencyFor(env, businessId);
  return { ok: true, check: { ...check, currency }, table: mapped.table, resource_name: mapped.name };
}

/**
 * Raise that check as a NUM bill code, once.
 *
 * Called from a guest's explicit action, never from a page render. If a live
 * bill already exists for this check the SAME code comes back: a guest
 * tapping twice, or two friends both tapping, must not produce two payable
 * codes for one dinner.
 */
export async function billFromCheck(env, businessId, resourceId, { issuedBy = null } = {}) {
  const live = await liveCheckFor(env, businessId, resourceId);
  if (!live.ok) return { ok: false, reason: live.why };
  const { check } = live;

  const existing = await env.DB.prepare(
    `SELECT token FROM num_paylinks
      WHERE business_id = ?1 AND pos_order_id = ?2 AND settled_at IS NULL AND state = 'active'
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(businessId, String(check.ref)).first().catch(() => null);
  if (existing?.token) return { ok: true, token: existing.token, already: true, check };

  const amount = (check.amount_minor / 100).toFixed(2);
  const out = await mintBillCode(env, {
    businessId,
    amount,
    currency: check.currency,
    resourceId,
    issuedBy,
    label: check.name || (live.resource_name ? `Bill · ${live.resource_name}` : null),
    posVendor: check.vendor,
    posOrderId: check.ref,
  });
  if (!out?.ok) return { ok: false, reason: out?.reason ?? 'could not make the bill code' };

  // The lines the till already had. A failure here costs the itemisation and
  // not the bill — the same order billqr.mjs uses for the POS reference.
  if (check.items?.length) await saveItems(env, out.token, check.items);

  return { ok: true, token: out.token, url: out.url, amount, currency: check.currency, check, items: check.items?.length ?? 0 };
}

/** Why a guest is not being shown a live bill, in words they can act on. */
export function whyNot(reason, venue = 'the venue') {
  switch (reason) {
    case 'unmapped':
    case 'till_has_no_tables':
    case 'no_till':
      return null; // Nothing to explain: this venue simply does it the usual way.
    case 'nothing_open':
      return `${venue} has nothing open on this table yet. Ask staff for the bill when you are ready.`;
    case 'nothing_owed':
      return 'This table has nothing left to pay.';
    case 'till_needs_reconnecting':
    case 'till_unreachable':
      return `Could not reach ${venue}'s till just now — ask staff for the bill and everything else works as normal.`;
    default:
      return null;
  }
}
