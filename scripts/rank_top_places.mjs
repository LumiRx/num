#!/usr/bin/env node
/**
 * NUM · rebuild top_places, one destination at a time.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * `scripts/rank_top_places.sql` is a single DELETE plus a single INSERT that
 * runs a window function over the whole `places` table. That table now holds
 * 2,715,566 rows, and on 18 Sep 2026 the rebuild came back:
 *
 *     ✘ [ERROR] D1 DB exceeded its CPU time limit and was reset.
 *
 * Nothing was rebuilt, and — worse — a rebuild that dies halfway through a
 * full-table DELETE is the one failure mode that could leave the concierge
 * with no recommendations at all. D1 rolls back, so the table survived, but
 * the job simply cannot complete at this size in one statement.
 *
 * The work is naturally partitioned: every row in top_places belongs to
 * exactly one destination, ranking happens PARTITION BY (dest, bucket), and no
 * destination's ranking depends on another's. So the same SQL runs per
 * destination — a few thousand candidate rows each instead of 2.7 million —
 * and each statement finishes well inside the limit.
 *
 * It is also restartable, which the single statement was not. A run that dies
 * at Prague has already rebuilt everything before Prague, and re-running it
 * for the remaining destinations costs nothing extra.
 *
 * Usage:
 *   node scripts/rank_top_places.mjs --dry                 # show the plan
 *   node scripts/rank_top_places.mjs --dest=dubai          # one destination
 *   node scripts/rank_top_places.mjs --go                  # every destination
 *   node scripts/rank_top_places.mjs --go --from=prague    # resume after a failure
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (n) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return hit === undefined ? null : (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true);
};
const DB = flag('db') || 'num-db';

const SQL = readFileSync(join(ROOT, 'scripts/rank_top_places.sql'), 'utf8');

/**
 * The per-destination form of the same SQL.
 *
 * Two edits, and both must hold or the rebuild is wrong rather than merely
 * slow: the DELETE is narrowed to this destination so the others are left
 * alone, and the candidate scan is narrowed so the window function sees only
 * this destination's rows. Asserted rather than assumed — a silent miss on
 * either would either wipe every other destination or scan the whole table
 * again, and both look like success from the outside.
 */
export function sqlFor(dest, sql = SQL) {
  const lit = `'${String(dest).replace(/'/g, "''")}'`;
  let out = sql.replace('DELETE FROM top_places;', `DELETE FROM top_places WHERE dest = ${lit};`);
  if (out === sql) throw new Error('rank_top_places.sql no longer starts with the full DELETE — re-read it');
  const before = out;
  out = out.replace(
    "  WHERE p.name IS NOT NULL AND p.name <> ''",
    `  WHERE p.dest = ${lit}\n    AND p.name IS NOT NULL AND p.name <> ''`,
  );
  if (out === before) throw new Error('the candidate WHERE clause moved — re-read rank_top_places.sql');
  return out;
}

function d1(args) {
  return execFileSync('npx', ['wrangler', 'd1', ...args], { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}

function destinations() {
  const out = d1(['execute', DB, '--remote', '--json', '--command',
    'SELECT DISTINCT dest FROM places WHERE dest IS NOT NULL AND dest <> "" ORDER BY dest']);
  const parsed = JSON.parse(out);
  const rows = parsed?.[0]?.results ?? parsed?.result?.[0]?.results ?? [];
  return rows.map((r) => r.dest).filter(Boolean);
}

// Only when run as a command. A test importing sqlFor() must not shell out to
// wrangler, and must certainly not rebuild anything.
const isCli = !!process.argv[1] && process.argv[1].endsWith('rank_top_places.mjs');
if (isCli) main();

function main() {
  const only = flag('dest');
  const from = flag('from');
  // --dry always wins. A dry run that executes because another flag was also
  // present is the worst possible bug in a script whose live mode rewrites the
  // table the concierge reads.
  const go = !flag('dry') && (flag('go') || !!only);

  let list = only ? [String(only)] : destinations();
  if (from) {
    const i = list.indexOf(String(from));
    if (i < 0) { console.error(`--from=${from} is not a destination`); process.exit(2); }
    list = list.slice(i);
}

  console.log(`${list.length} destination(s), one statement each, against ${DB}`);
  if (!go) {
    console.log('\nDry run. Nothing executed. The SQL for the first one:\n');
    console.log(sqlFor(list[0]).split('\n').slice(0, 6).join('\n') + '\n  …');
    console.log('\nRe-run with --go (or --dest=<slug>) to execute.');
    process.exit(0);
}

  const dir = mkdtempSync(join(tmpdir(), 'numrank-'));
  let done = 0;
  for (const dest of list) {
    const file = join(dir, `${dest}.sql`);
    writeFileSync(file, sqlFor(dest));
    process.stdout.write(`  ${dest} … `);
    try {
      d1(['execute', DB, '--remote', '--yes', '--file', file]);
      done += 1;
      console.log('ok');
    } catch (e) {
      console.log('FAILED');
      console.error(`\n${String(e.stderr || e.message).trim().split('\n').slice(-4).join('\n')}\n`);
      console.error(`Rebuilt ${done} of ${list.length}. Resume with:\n  node scripts/rank_top_places.mjs --go --from=${dest}\n`);
      process.exit(1);
    }
}
  console.log(`\n✓ ${done} destination(s) rebuilt.`);
}
