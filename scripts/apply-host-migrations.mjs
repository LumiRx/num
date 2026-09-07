#!/usr/bin/env node
/**
 * Apply the VIP host migrations to D1, one statement at a time.
 *
 * WHY THIS EXISTS RATHER THAN `wrangler d1 execute --file`:
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`. 0013, 0014 and 0015 are mostly
 * ALTER TABLE, so a second run — or a first run against a database where
 * someone already applied half of 0013 by hand — fails on the first duplicate
 * column and abandons everything after it. Worse, `--file` inside a
 * transaction rolls the whole thing back, so one duplicate column undoes
 * twenty statements that were fine.
 *
 * So: each statement on its own, duplicates treated as "already done", and
 * anything else stops the run loudly with the statement printed. Re-running
 * this script is safe and is the intended way to finish a partial apply.
 *
 *   node scripts/apply-host-migrations.mjs --dry     print the plan, touch nothing
 *   node scripts/apply-host-migrations.mjs --local   against the local D1
 *   node scripts/apply-host-migrations.mjs           against --remote (production)
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILES = [
  'worker/migrations/0013_host_profile.sql',
  'worker/migrations/0014_host_clients.sql',
  'worker/migrations/0015_host_separation.sql',
  // 0018 is the client-intake half, written alongside 0015 by another pass. It
  // re-adds host_notified_at, which 0015 already creates — that lands as
  // "duplicate column", is treated as already-applied, and is expected rather
  // than a sign something is wrong. It is listed here so one run leaves the
  // host schema whole, in order, instead of two people each applying half.
  'worker/migrations/0018_host_client_intake.sql',
  // 0019 is the supplier layer — eight new tables plus two ALTERs on num_hosts.
  // The CREATEs are IF NOT EXISTS and safe to re-run — the ALTERs are not, so a
  // second pass reports 'duplicate column name' and is tolerated below.
  'worker/migrations/0019_suppliers.sql',
];

const DRY = process.argv.includes('--dry');
const LOCAL = process.argv.includes('--local');
const DB = 'num-db';

/** Split on semicolons after stripping line comments.
 *  All three files are checked by growth/hostseparation.test.mjs to contain no
 *  semicolon inside a comment — which is exactly the thing that would split a
 *  statement in half here and produce two invalid fragments. */
function statements(sql) {
  return sql
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
}

/** Errors that mean "this statement was already applied". Everything else is
 *  a real failure and stops the run. */
const ALREADY = [
  /duplicate column name/i,
  /already exists/i,
];

let applied = 0, skipped = 0;

for (const file of FILES) {
  const stmts = statements(readFileSync(file, 'utf8'));
  console.log(`\n── ${file} — ${stmts.length} statements`);

  for (const [i, sql] of stmts.entries()) {
    const label = `${String(i + 1).padStart(2, '0')}/${stmts.length} ${sql.replace(/\s+/g, ' ').slice(0, 68)}`;
    if (DRY) { console.log(`   plan  ${label}`); continue; }

    try {
      execFileSync('npx', [
        'wrangler', 'd1', 'execute', DB,
        LOCAL ? '--local' : '--remote',
        '--command', sql,
      ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      applied++;
      console.log(`   ok    ${label}`);
    } catch (e) {
      const out = String(e.stdout || '') + String(e.stderr || '');
      if (ALREADY.some((re) => re.test(out))) {
        skipped++;
        console.log(`   have  ${label}`);
        continue;
      }
      console.error(`\n   FAILED on:\n${sql}\n`);
      console.error(out.split('\n').slice(-25).join('\n'));
      process.exit(1);
    }
  }
}

if (DRY) {
  console.log('\nDry run. Nothing was sent.');
} else {
  console.log(`\nDone. ${applied} applied, ${skipped} already there.`);
  console.log('Now check it agrees with itself:');
  console.log('  curl -s "https://itsnum.com/api/host/integrity?key=$ADMIN_KEY" | head -40');
}
