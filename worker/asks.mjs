/**
 * Every question a guest asks, kept — scrubbed first.
 *
 * Until this existed, the question TEXT survived only when a partner
 * impression fired (num_place_impressions.asked). A guest asking "is there a
 * pharmacy open past midnight" with no partner match vanished entirely:
 * counted in num_usage, content lost. That content is the product roadmap —
 * what people want that Num can't do yet, which categories are asked in
 * which destination, what the ads are actually bringing in — and it was
 * being dropped at the exact moment it was expressed.
 *
 * ── PRIVACY IS STRUCTURAL, NOT POLICY ────────────────────────────────────
 *
 * The text is scrubbed with the SAME patterns the model prompt uses
 * (worker/redact.mjs): emails, phone numbers and card-length digit runs are
 * replaced before the row exists. There is no raw copy anywhere. A table of
 * what travellers want is an asset; a table of who wanted it is a liability,
 * so member linkage is a stable id only and the scrub cannot be bypassed —
 * record() applies it internally rather than trusting callers to remember.
 */
import { isIdentifying } from './redact.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  category TEXT,
  dest TEXT,
  lane TEXT,
  brain TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  member_id TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_num_asks_ts ON num_asks(ts);
CREATE INDEX IF NOT EXISTS idx_num_asks_dest ON num_asks(dest, ts);
`;
let ready = false;

/** Emails, phones and long digit runs become placeholders, in place. */
export function scrubAsk(text) {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
    .slice(0, 280);
}

/**
 * Keep one question. Fail-soft and fire-and-forget: analytics must never
 * cost a guest a reply, so callers wrap this in waitUntil and every failure
 * is swallowed after one log line.
 */
export async function recordAsk(env, { text, category = null, dest = null, lane = null, brain = null, degraded = false, cached = false, memberId = null }) {
  if (!env?.DB) return;
  const t = scrubAsk(text).trim();
  if (t.length < 2) return;
  // Belt and braces: if the scrub somehow left an identifier shape behind,
  // refuse the row rather than store it.
  if (isIdentifying('text', t)) return;
  try {
    if (!ready) {
      await env.DB.batch(SCHEMA.split(';').map((x) => x.trim()).filter(Boolean).map((x) => env.DB.prepare(x)));
      ready = true;
    }
    await env.DB.prepare(
      'INSERT INTO num_asks (text, category, dest, lane, brain, degraded, cached, member_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
    ).bind(t, category, dest, lane, brain, degraded ? 1 : 0, cached ? 1 : 0, memberId ? String(memberId).slice(0, 40) : null).run();
  } catch (e) {
    console.warn('[asks]', e?.message ?? e);
  }
}
