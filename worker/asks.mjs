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
// Added 11 Aug with the response quality control. Separate from SCHEMA
// because the table predates it and CREATE TABLE IF NOT EXISTS will not add a
// column to a table that already exists — the reason a migration that looks
// applied can silently do nothing.
//
// Empty string, not NULL, for a clean answer: NULL would mean "never checked",
// and the difference between "nothing wrong" and "not looked at" is the whole
// value of the column once some rows predate the check.
const MIGRATIONS = [
  'ALTER TABLE num_asks ADD COLUMN quality TEXT',
  // Added 15 Aug. member_id is NULL on ~99% of asks because almost nobody
  // asking Num is a member — which is the right product decision and was a
  // measurement disaster: every question arrived from an indistinguishable
  // NULL, so "did anyone come back" had no answer. A SEPARATE column, not a
  // fallback into member_id: anything joining member_id to num_members must
  // keep meaning what it says.
  'ALTER TABLE num_asks ADD COLUMN anon_id TEXT',
  // Added 4 Sep. Our own uptime and MCP-integrity probes ask a real question
  // through the real model path on purpose — that is the only probe that
  // measures what a guest experiences. But they were 277 of 451 rows (61%)
  // and 46% of degraded=1, so "how is the concierge doing" was mostly
  // "how is the probe doing". Marked at write time so every reader can
  // exclude them with one predicate.
  'ALTER TABLE num_asks ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0',
];
let ready = false;

/**
 * The exact questions our probes ask. Kept here, next to the table they
 * pollute, so a change to a probe script and a change to the filter are the
 * same edit. scripts/uptime.mjs and scripts/mcp-integrity.mjs send these.
 */
export const PROBE_TEXTS = Object.freeze([
  'my group needs dinner ideas in patong tonight',
  "I'm in phuket. where should we eat tonight?",
]);

/** True for a question one of our own probes asked. Compared after scrubAsk(). */
export function isProbeText(text) {
  const t = String(text ?? '').trim().toLowerCase();
  return PROBE_TEXTS.some((p) => p.toLowerCase() === t);
}

/**
 * SQL predicate that excludes probe rows without depending on the
 * `synthetic` column existing yet — the column is added lazily on the first
 * write after deploy, and a reader that ran before that write would throw.
 * Text matching is exact and needs no schema. Use as `WHERE ... AND ${NOT_PROBE}`.
 */
export const NOT_PROBE = `text NOT IN (${PROBE_TEXTS.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')})`;

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
export async function recordAsk(env, { text, category = null, dest = null, lane = null, brain = null, degraded = false, cached = false, quality = null, memberId = null, anonId = null }) {
  if (!env?.DB) return;
  const t = scrubAsk(text).trim();
  if (t.length < 2) return;
  // Belt and braces: if the scrub somehow left an identifier shape behind,
  // refuse the row rather than store it.
  if (isIdentifying('text', t)) return;
  try {
    if (!ready) {
      await env.DB.batch(SCHEMA.split(';').map((x) => x.trim()).filter(Boolean).map((x) => env.DB.prepare(x)));
      // One at a time and each failure swallowed: "duplicate column name" is
      // the expected result on every run after the first, and batching would
      // let that expected error roll back the statements around it.
      for (const m of MIGRATIONS) {
        await env.DB.prepare(m).run().catch(() => {});
      }
      ready = true;
    }
    // Return the row id so the cost of THIS question can be joined to it in
    // num_usage.ask_id. Without it, cost is knowable per day and per lane but
    // never per kind of question — which is the only number that tells the
    // router what to route where.
    const res = await env.DB.prepare(
      'INSERT INTO num_asks (text, category, dest, lane, brain, degraded, cached, quality, member_id, anon_id, synthetic) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)',
    ).bind(
      t, category, dest, lane, brain, degraded ? 1 : 0, cached ? 1 : 0,
      // '' means checked and clean; NULL means never checked at all.
      Array.isArray(quality) ? quality.join(',').slice(0, 200) : quality ?? null,
      memberId ? String(memberId).slice(0, 40) : null,
      // Shape-checked, not trusted: the client sends this, so a crafted
      // request must not be able to write arbitrary text into the table.
      /^a_[a-z0-9]{8,64}$/.test(String(anonId ?? '')) ? String(anonId) : null,
      isProbeText(t) ? 1 : 0,
    ).run();
    return res?.meta?.last_row_id ?? null;
  } catch (e) {
    console.warn('[asks]', e?.message ?? e);
  }
  return null;
}
