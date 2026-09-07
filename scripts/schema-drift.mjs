/**
 * DOES THE DATABASE HAVE THE COLUMNS THE CODE BELIEVES IN?
 *
 * On 7 September 2026 two production failures had the same shape, hours apart:
 *
 *   1. GET /api/host/requests returned 500 for every host, for weeks. The
 *      SELECT named num_host_requests.booking_fee_minor. Production had no
 *      such column, because 0014 added it inside a CREATE TABLE IF NOT EXISTS
 *      on a table that already existed — which is a silent no-op. The column
 *      reached new databases and no existing one.
 *
 *   2. num_host_areas.lat and .lng were null for every host, so coordinate
 *      matching could never return anybody. Different cause, same signature:
 *      the code assumed something about the database that was not true, and
 *      the failure surfaced as an empty list rather than an error.
 *
 * Both were invisible because nothing compared what the migrations declare
 * against what production actually holds. This does.
 *
 * It is deliberately one-directional. Columns in the database that no
 * migration declares are NOT reported: another worker, an older migration or a
 * hand-run ALTER can legitimately put them there, and crying about those
 * teaches everyone to ignore the output. The dangerous direction is the one
 * where the CODE expects something the DATABASE has not got — that is a 500
 * waiting for the first person to touch it.
 *
 *   node scripts/schema-drift.mjs            check production, exit 1 on drift
 *   node scripts/schema-drift.mjs --local    check the local D1 instead
 *   node scripts/schema-drift.mjs --json     machine-readable, for CI
 *
 * Requires wrangler to be logged in, because it reads the live schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MIGRATIONS = join(ROOT, 'worker', 'migrations');
const DB = 'num-db';

/* ── What the migrations say should exist ──────────────────────────────── */

/**
 * Columns declared for each table, from two places:
 *   CREATE TABLE [IF NOT EXISTS] name ( col type, ... )
 *   ALTER TABLE name ADD COLUMN col type
 *
 * Comments are stripped first. A column named inside a comment is prose, and
 * a checker that reads prose as schema is a checker nobody trusts.
 */
export function declaredColumns(sqlByFile) {
  const tables = new Map();
  const add = (t, c) => {
    if (!t || !c) return;
    if (!tables.has(t)) tables.set(t, new Set());
    tables.get(t).add(c.toLowerCase());
  };

  for (const sql of sqlByFile) {
    const clean = sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');

    for (const m of clean.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\s*\(([\s\S]*?)\)\s*;/gi
    )) {
      const table = m[1];
      // Split the body on top-level commas only — a CHECK (x IN ('a','b'))
      // carries commas that are not column boundaries.
      let depth = 0, cur = '';
      const parts = [];
      for (const ch of m[2]) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += ch;
      }
      parts.push(cur);
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        // Table-level constraints are not columns.
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
        const name = (line.match(/^["`[]?([A-Za-z_][\w]*)["`\]]?/) || [])[1];
        add(table, name);
      }
    }

    for (const m of clean.matchAll(
      /ALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+ADD\s+COLUMN\s+["`[]?([A-Za-z_][\w]*)["`\]]?/gi
    )) {
      add(m[1], m[2]);
    }
  }
  return tables;
}

/** Compare declared against live. Only ever reports the dangerous direction. */
export function drift(declared, liveByTable) {
  const out = [];
  for (const [table, cols] of declared) {
    const live = liveByTable.get(table);
    if (!live) { out.push({ table, missing: null }); continue; }   // whole table absent
    const missing = [...cols].filter((c) => !live.has(c));
    if (missing.length) out.push({ table, missing });
  }
  return out.sort((a, z) => a.table.localeCompare(z.table));
}

/* ── Reading the live schema ───────────────────────────────────────────── */

function liveSchema(local) {
  const sql = "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, "
    + "pragma_table_info(m.name) p WHERE m.type='table'";
  const args = ['wrangler', 'd1', 'execute', DB, local ? '--local' : '--remote',
    '--json', '--command', sql];
  const raw = execFileSync('npx', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // wrangler prints a banner before the JSON on some versions.
  const body = JSON.parse(raw.slice(raw.indexOf('[')));
  const rows = body[0]?.results || [];
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.tbl)) map.set(r.tbl, new Set());
    map.get(r.tbl).add(String(r.col).toLowerCase());
  }
  return map;
}

/* ── Run ───────────────────────────────────────────────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  const local = process.argv.includes('--local');
  const asJson = process.argv.includes('--json');

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const declared = declaredColumns(files.map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')));

  let live;
  try {
    live = liveSchema(local);
  } catch (e) {
    console.error('Could not read the live schema. Is wrangler logged in?');
    console.error(String(e.message || e).split('\n').slice(0, 4).join('\n'));
    process.exit(2);
  }

  const found = drift(declared, live);

  if (asJson) {
    console.log(JSON.stringify({ ok: found.length === 0, drift: found }, null, 2));
    process.exit(found.length ? 1 : 0);
  }

  const where = local ? 'local D1' : 'PRODUCTION';
  if (!found.length) {
    console.log(`Schema matches. ${declared.size} tables declared across ${files.length} migrations, all present in ${where}.`);
    process.exit(0);
  }

  console.error(`\nSCHEMA DRIFT in ${where} — the code expects columns that are not there.\n`);
  for (const d of found) {
    if (d.missing === null) console.error(`  ${d.table}  — the whole table is missing`);
    else console.error(`  ${d.table}  — missing: ${d.missing.join(', ')}`);
  }
  console.error(`
This is what a 500 looks like before anybody hits it. A column added inside a
CREATE TABLE IF NOT EXISTS never reaches a database where the table already
exists — it needs its own ALTER. Write one, register it in
scripts/apply-host-migrations.mjs, and run that before deploying.
`);
  process.exit(1);
}
