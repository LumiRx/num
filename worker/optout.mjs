/**
 * ONE ANSWER TO "MAY NUM TEXT THIS NUMBER?"
 *
 * Until 4 Sep 2026 a STOP from a number with no consent row changed nothing:
 * applyOptOut ran `UPDATE num_sms_consent SET revoked_at …`, matched zero
 * rows, and the refusal evaporated. The `num_optouts` table that two readers
 * consult (`WHERE contact = ?`) has no `contact` column — it is keyed on a
 * salted hash minted by another codebase — so those reads have always thrown
 * and been swallowed. A friend who was texted an invite and replied STOP could
 * be texted again by the next friend who typed their number.
 *
 * This file owns a plain table this worker can actually write and read, and
 * a single predicate every outbound text to a person must pass. It reads the
 * consent register as well, so a revocation recorded either way still counts.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_text_optouts (
  phone      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'user_stop',
  evidence   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const ready = new WeakSet();
async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  try { await env.DB.prepare(SCHEMA).run(); ready.add(env.DB); } catch { /* read paths tolerate absence */ }
}

const E164 = /^\+[1-9]\d{6,14}$/;
export const validPhone = (p) => E164.test(String(p ?? '').trim());

/** A STOP. Recorded whether or not we ever held consent for the number. */
export async function recordStop(env, phone, { evidence = '', reason = 'user_stop' } = {}) {
  if (!env?.DB || !validPhone(phone)) return { ok: false };
  await ensure(env);
  try {
    await env.DB.prepare(
      `INSERT INTO num_text_optouts (phone, reason, evidence) VALUES (?1, ?2, ?3)
       ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, evidence = excluded.evidence, created_at = datetime('now')`,
    ).bind(String(phone).trim(), reason, String(evidence).slice(0, 200)).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

/** A START / YES after a STOP. */
export async function recordStart(env, phone) {
  if (!env?.DB || !validPhone(phone)) return { ok: false };
  await ensure(env);
  try {
    await env.DB.prepare('DELETE FROM num_text_optouts WHERE phone = ?1').bind(String(phone).trim()).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

/**
 * True when the number has refused. Fails CLOSED: an error reading either
 * table is treated as a refusal, because the one direction this must never
 * fail in is "we texted somebody who said stop".
 */
export async function optedOut(env, phone) {
  if (!env?.DB) return true;
  const p = String(phone ?? '').trim();
  if (!validPhone(p)) return true;
  await ensure(env);
  try {
    const stop = await env.DB.prepare('SELECT 1 AS x FROM num_text_optouts WHERE phone = ?1').bind(p).first();
    if (stop) return true;
  } catch { return true; }
  try {
    const c = await env.DB.prepare('SELECT revoked_at FROM num_sms_consent WHERE phone = ?1').bind(p).first();
    if (c?.revoked_at) return true;
  } catch (e) {
    // The consent table lives with the opt-in page and may be absent in a
    // fresh environment; absence is not a refusal.
    if (!/no such table/i.test(String(e?.message ?? e))) return true;
  }
  return false;
}
