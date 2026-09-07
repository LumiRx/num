/**
 * "IS IT OPEN" FOR 124,117 MORE PLACES — from hours the directory already holds.
 *
 * Measured 3 Sep 2026: 175,304 places carry an hours string, and only 51,187
 * of them had ever been parsed into the weekly mask that `open_now` reads.
 * The other 124,117 sat as text nobody looked at, so a guest asking for
 * dinner got `open_now: null` on venues whose hours were in the row the whole
 * time. Across the five most-asked cities, 98.7% of places could not say
 * whether they were open — and 60% of that gap was already in the database.
 *
 * A concierge that cannot say "they close in forty minutes" is a directory.
 *
 * This runs on the five-minute cron, a few hundred rows at a time, until
 * there is nothing left: at 300 per tick it finishes in about a day and a
 * half, and then costs one cheap query per tick forever. Nothing here calls
 * out to anyone; it is the directory reading its own notes.
 *
 * ── WHAT "TRIED AND COULD NOT" LOOKS LIKE ────────────────────────────────
 *
 * A string the parser refuses ("Mo-Su 12:00", an English "Mon-Fri 9am-5pm")
 * is marked with a single `-` in hours_mask. fromHex() returns null for
 * anything that is not 42 hex characters, so every reader still sees
 * "unknown" — it just stops being re-tried every tick. The count of those is
 * reported, because it is the size of the next parser improvement.
 */
import { parseHours, toHex } from './hours.mjs';

export const UNPARSEABLE = '-';

/** One tick. Returns what it did, for the cron log and the tests. */
export async function backfillHours(env, { limit = 300 } = {}) {
  if (!env?.DB) return { scanned: 0, parsed: 0, refused: 0, done: false };
  const { results } = await env.DB.prepare(
    `SELECT id, hours FROM places
      WHERE hours IS NOT NULL AND hours <> ''
        AND (hours_mask IS NULL OR hours_mask = '')
      LIMIT ?1`,
  ).bind(Math.max(1, Math.min(limit, 1000))).all().catch(() => ({ results: [] }));

  const rows = results ?? [];
  if (!rows.length) return { scanned: 0, parsed: 0, refused: 0, done: true };

  const stmts = [];
  let parsed = 0, refused = 0;
  for (const r of rows) {
    const mask = parseHours(r.hours);
    const hex = mask ? toHex(mask) : UNPARSEABLE;
    if (mask) parsed++; else refused++;
    stmts.push(env.DB.prepare('UPDATE places SET hours_mask = ?2 WHERE id = ?1 AND (hours_mask IS NULL OR hours_mask = \'\')').bind(r.id, hex));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    // A batch that fails leaves the rows untouched, and the next tick tries
    // them again. Loud, so a schema surprise is not a silent stall.
    console.error('[hoursbackfill] batch failed', e?.message ?? e);
    return { scanned: rows.length, parsed: 0, refused: 0, done: false, error: String(e?.message ?? e).slice(0, 120) };
  }
  return { scanned: rows.length, parsed, refused, done: rows.length < limit };
}

/** How far along, for the health page. One indexed-ish count; cheap once done. */
export async function progress(env) {
  if (!env?.DB) return null;
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN hours IS NOT NULL AND hours <> '' AND (hours_mask IS NULL OR hours_mask = '') THEN 1 ELSE 0 END) AS todo,
       SUM(CASE WHEN hours_mask = '-' THEN 1 ELSE 0 END) AS refused,
       SUM(CASE WHEN length(hours_mask) = 42 THEN 1 ELSE 0 END) AS parsed
     FROM places`,
  ).first().catch(() => null);
  return row ? { todo: Number(row.todo ?? 0), refused: Number(row.refused ?? 0), parsed: Number(row.parsed ?? 0) } : null;
}
