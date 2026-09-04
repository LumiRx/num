/**
 * THE LEDGER OF THINGS THAT ARE BROKEN — the one surface that cannot be
 * silenced by the thing it is trying to report.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * On 3 Sep 2026 the watchman had been reporting four real failures for a
 * month and nobody could see any of them, because its delivery channel was
 * itself the broken thing: 81 dead `ops.alert` rows, every one `line_404`.
 * A month of alarms shouting into a disconnected wire.
 *
 * That is not a bug in the alarm. It is a category error in the design: an
 * alerting system that only PUSHES has a single point of failure at exactly
 * the moment it matters, and the failure is invisible by construction —
 * because the way you would find out is the thing that is broken.
 *
 * So every failure in this product is written HERE first, and telling somebody
 * is a second, best-effort step that may fail without hiding anything. This
 * table is pulled, not pushed:
 *
 *   • /api/admin/failures — what is open, right now, oldest first.
 *   • /api/health — an open critical failure changes the verdict, and the
 *     uptime probe outside Cloudflare has been reading that every five
 *     minutes for a month. It is the one reporting path with a track record.
 *
 * ── THE SEVERITY THAT MATTERS MOST ───────────────────────────────────────
 *
 * `alert_undelivered` is critical, always. "Something is broken" is a
 * degradation; "something is broken AND we could not tell you" is an outage,
 * because from that moment every other number on every other dashboard is
 * unverified. Blindness outranks breakage.
 *
 * ── ONE ROW PER PROBLEM, NOT PER OCCURRENCE ──────────────────────────────
 *
 * 81 identical rows is not 81 problems; it is one problem and 81 reminders,
 * and it buries the other three. Failures dedupe on `kind|subject` and carry
 * a count and a first/last seen. What repeats gets louder, not longer.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_failures (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  detail      TEXT,
  severity    TEXT NOT NULL DEFAULT 'high',
  seen        INTEGER NOT NULL DEFAULT 1,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  told        INTEGER NOT NULL DEFAULT 0,
  told_via    TEXT,
  resolved_at INTEGER
)`;
const IDX = [
  'CREATE INDEX IF NOT EXISTS idx_failures_open ON num_failures(resolved_at, severity, last_seen)',
  'CREATE INDEX IF NOT EXISTS idx_failures_kind ON num_failures(kind, subject)',
];

export const SEVERITY = ['low', 'high', 'critical'];

// Per-database, not per-module. A single module-level flag is the classic
// version of this bug: the first caller creates the table, sets the flag, and
// every later caller with a different binding silently skips creation and
// reads an empty ledger — a failure store that reports no failures.
const built = new WeakSet();
async function ensure(env) {
  const db = env?.DB;
  if (!db || built.has(db)) return;
  try {
    await db.prepare(SCHEMA).run();
    for (const i of IDX) await db.prepare(i).run().catch(() => {});
    built.add(db);
  } catch (e) {
    console.warn('[failures] schema', e?.message ?? e);
  }
}

/** Stable id so the same problem is the same row on every worker instance. */
const keyFor = (kind, subject) =>
  `f_${String(kind).slice(0, 40)}|${String(subject ?? '').slice(0, 120)}`.replace(/\s+/g, ' ');

/**
 * Something is broken. Returns the row so a caller can see whether this is
 * new — `seen === 1` — without a second query.
 *
 * Never throws: a failure in the failure recorder must not become the reason
 * a request fails. It does, however, log loudly, because that is the last
 * line of defence.
 */
export async function record(env, { kind, subject = '', detail = '', severity = 'high' }) {
  const sev = SEVERITY.includes(severity) ? severity : 'high';
  const line = `[failure/${sev}] ${kind} ${subject} ${String(detail).slice(0, 200)}`;
  console.error(line);
  if (!env?.DB || !kind) return null;
  await ensure(env);
  const id = keyFor(kind, subject);
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO num_failures (id, kind, subject, detail, severity, seen, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)
       ON CONFLICT(id) DO UPDATE SET
         seen        = seen + 1,
         last_seen   = ?6,
         detail      = ?4,
         -- A problem that comes back worse is worse. It never quietly
         -- downgrades itself on a later, milder sighting.
         severity    = CASE WHEN ?5 = 'critical' THEN 'critical'
                            WHEN severity = 'critical' THEN 'critical'
                            WHEN ?5 = 'high' OR severity = 'high' THEN 'high'
                            ELSE 'low' END,
         -- Reappearing after a fix reopens it, and it needs telling again.
         resolved_at = NULL,
         told        = CASE WHEN resolved_at IS NOT NULL THEN 0 ELSE told END`,
    ).bind(id, String(kind).slice(0, 40), String(subject).slice(0, 120), String(detail).slice(0, 600), sev, now).run();
    return await env.DB.prepare('SELECT * FROM num_failures WHERE id = ?1').bind(id).first();
  } catch (e) {
    console.error('[failures] could not record —', e?.message ?? e, '::', line);
    return null;
  }
}

/** It works again. Idempotent; resolving something that was never open is fine. */
export async function resolve(env, kind, subject = '') {
  if (!env?.DB || !kind) return false;
  await ensure(env);
  try {
    const r = await env.DB.prepare(
      'UPDATE num_failures SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL',
    ).bind(keyFor(kind, subject), Math.floor(Date.now() / 1000)).run();
    return !!r?.meta?.changes;
  } catch { return false; }
}

/** Mark that a human was actually reached about this one. */
export async function told(env, kind, subject = '', via = '') {
  if (!env?.DB || !kind) return;
  await ensure(env);
  await env.DB.prepare(
    'UPDATE num_failures SET told = 1, told_via = ?2 WHERE id = ?1',
  ).bind(keyFor(kind, subject), String(via).slice(0, 60)).run().catch(() => {});
}

/** What is broken right now, worst and oldest first. */
export async function open(env, { limit = 50 } = {}) {
  if (!env?.DB) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, kind, subject, detail, severity, seen, first_seen, last_seen, told, told_via
       FROM num_failures
      WHERE resolved_at IS NULL
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               first_seen ASC
      LIMIT ?1`,
  ).bind(Math.min(Math.max(1, limit), 200)).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/**
 * The shape /api/health folds into its verdict.
 *
 * `blind` is the field that matters: it is true when something is broken AND
 * nobody was successfully told, which is the state that turns every other
 * green light on every other dashboard into an unverified claim.
 */
export async function summary(env) {
  const rows = await open(env, { limit: 200 });
  const now = Math.floor(Date.now() / 1000);
  const critical = rows.filter((r) => r.severity === 'critical');
  const high = rows.filter((r) => r.severity === 'high');
  // Ten minutes of grace: a failure recorded seconds ago may already be
  // resolving itself, and a monitor that fires on every transient is a
  // monitor people learn to close.
  const settled = (r) => now - r.first_seen > 600;
  const blind = rows.some((r) => !r.told && settled(r) && r.severity !== 'low');
  return {
    open: rows.length,
    critical: critical.length,
    high: high.length,
    blind,
    oldest: rows.length ? rows[0].first_seen : null,
    worst: rows.slice(0, 5).map((r) => ({
      kind: r.kind, subject: r.subject, severity: r.severity, seen: r.seen, told: !!r.told,
    })),
  };
}
