/**
 * Retention — the sweep that makes num_retention_policy true.
 *
 * The policy table has existed since the consent work: twelve rows naming a
 * table, a time column, how long to keep it, and what to do after — delete,
 * anonymise, archive — each with its legal basis. On 4 Sep 2026 every row's
 * `last_purged_at` was NULL. Nothing had ever read the table. The policy was
 * a promise written down and never kept, which is worse than no policy: a
 * regulator, a member, or a partner reading it would reasonably believe it
 * was in force.
 *
 * This module reads that table and does what it says, once an hour from the
 * scheduled() handler. Three things it will not do:
 *
 *   · Trust the policy row. Table and column names come from a database
 *     row, which is a string somebody can edit. Every identifier is checked
 *     against sqlite_master before it is interpolated, and only the three
 *     known strategies run. A policy naming a table or column that does not
 *     exist is skipped and reported, not executed.
 *   · Archive. `strategy = 'archive'` (wallet transactions, 7 years) has no
 *     archive destination yet. Those rows are left alone and the run says so.
 *   · Delete a financial record. Anonymise strips the subject; the row and
 *     its amounts stay. That is the strategy the policy chose for bookings,
 *     orders and requests, and this module does not second-guess it.
 *
 * Beyond the policy table it also drains three queues the code already
 * writes to and never emptied: soft-deleted messages past `purge_after`,
 * expired answer-cache rows, and the passenger records sweep in
 * passengers.mjs (which existed, tested, with no caller).
 */

const IDENT = /^[a-z_][a-z0-9_]*$/;
const STRATEGIES = new Set(['delete', 'anonymise', 'archive']);

/** Columns of a table as {name: type}, or null when the table does not exist. */
async function columnsOf(env, table) {
  if (!IDENT.test(table)) return null;
  const exists = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1").bind(table).first();
  if (!exists) return null;
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const out = {};
  for (const c of results ?? []) out[String(c.name)] = String(c.type || '').toUpperCase();
  return out;
}

/** The cutoff in the column's own units: epoch seconds for INTEGER, ISO-ish text otherwise. */
function cutoffFor(colType, retainDays, now) {
  const t = now - retainDays * 86400 * 1000;
  if (colType.includes('INT') || colType.includes('REAL') || colType.includes('NUM')) return Math.floor(t / 1000);
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/** Apply one policy row. Returns what happened, never throws. */
export async function applyPolicy(env, p, { now = Date.now() } = {}) {
  const table = String(p.table_name || '');
  const timeCol = String(p.time_column || '');
  const subject = p.subject_column ? String(p.subject_column) : null;
  const strategy = String(p.strategy || '');
  const days = Number(p.retain_days);
  const base = { table, strategy, rows: 0 };
  if (!STRATEGIES.has(strategy)) return { ...base, skipped: `unknown strategy '${strategy}'` };
  if (!Number.isFinite(days) || days < 1) return { ...base, skipped: 'retain_days must be a positive number' };
  if (!IDENT.test(timeCol) || (subject && !IDENT.test(subject))) return { ...base, skipped: 'column name is not a plain identifier' };
  const cols = await columnsOf(env, table).catch(() => null);
  if (!cols) return { ...base, skipped: 'table does not exist' };
  if (!(timeCol in cols)) return { ...base, skipped: `no column ${timeCol}` };
  if (strategy === 'archive') return { ...base, skipped: 'no archive destination configured — rows untouched' };
  if (strategy === 'anonymise' && (!subject || !(subject in cols))) return { ...base, skipped: 'anonymise needs a subject_column that exists' };

  const cutoff = cutoffFor(cols[timeCol], days, now);
  try {
    let r;
    if (strategy === 'delete') {
      r = await env.DB.prepare(`DELETE FROM ${table} WHERE ${timeCol} < ?1`).bind(cutoff).run();
    } else {
      r = await env.DB.prepare(`UPDATE ${table} SET ${subject} = NULL WHERE ${timeCol} < ?1 AND ${subject} IS NOT NULL`).bind(cutoff).run();
    }
    const rows = Number(r?.meta?.changes ?? 0);
    await env.DB.prepare('UPDATE num_retention_policy SET last_purged_at = ?1, last_purged_rows = ?2 WHERE table_name = ?3')
      .bind(Math.floor(now / 1000), rows, table).run().catch(() => {});
    return { ...base, rows, cutoff };
  } catch (e) {
    return { ...base, error: String(e?.message ?? e) };
  }
}

/**
 * The hourly sweep. Reads active policies, applies each, then drains the
 * three queues the code writes and never emptied. Every step is isolated:
 * one bad policy row cannot stop the others, and none of it can throw into
 * the cron handler.
 */
export async function runRetention(env, { now = Date.now() } = {}) {
  const report = { policies: [], queues: {}, errors: [] };
  if (!env?.DB) return report;

  let policies = [];
  try {
    ({ results: policies = [] } = await env.DB.prepare('SELECT * FROM num_retention_policy WHERE active = 1').all());
  } catch (e) {
    report.errors.push(`policy table unreadable: ${e?.message ?? e}`);
  }
  for (const p of policies) report.policies.push(await applyPolicy(env, p, { now }));

  const nowS = Math.floor(now / 1000);
  const q = async (name, sql, ...args) => {
    try {
      const r = await env.DB.prepare(sql).bind(...args).run();
      report.queues[name] = Number(r?.meta?.changes ?? 0);
    } catch (e) {
      report.queues[name] = null;
      report.errors.push(`${name}: ${e?.message ?? e}`);
    }
  };
  // Soft-deleted messages past their grace period.
  await q('messages_purged', 'DELETE FROM num_messages WHERE purge_after IS NOT NULL AND purge_after < ?1', nowS);
  // Expired shared answers. 18 of 21 rows were expired on 4 Sep and nothing removed them.
  await q('answer_cache_expired', 'DELETE FROM num_answer_cache WHERE expires_at < ?1', nowS);

  // Passenger records: the sweep in passengers.mjs was written and tested
  // and had no caller. Dynamic import so a missing module cannot break the cron.
  try {
    const { retentionSweep } = await import('./passengers.mjs');
    report.queues.passengers = await retentionSweep(env, { now });
  } catch (e) {
    report.errors.push(`passengers: ${e?.message ?? e}`);
  }

  return report;
}
