#!/usr/bin/env node
/**
 * NUM · collapse a place stored twice into a place stored once.
 *
 *   node scripts/dedupe_places.mjs --country=TW --dry
 *   node scripts/dedupe_places.mjs --country=TW
 *   node scripts/dedupe_places.mjs                 # every country
 *
 * Run it after any ingest. OSM maps a great many businesses as both a node and
 * a building way; our id is a hash of name and position, so the two land as two
 * rows — the same restaurant twice, one of them missing the phone number.
 *
 * What it will not do: delete a claimed listing, delete a rated one, or merge
 * two rows whose phone numbers disagree. The rules live in dedupe.sql.mjs and
 * are unit-tested there.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  CREATE_WORK, DROP_WORK, countSql, deleteSql, fillWorkSql, mergeSql, pairsSql,
} from './dedupe.sql.mjs';

const DB = 'num-db';
const OUT = 'sql';
const argv = process.argv.slice(2);
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const COUNTRY = flag('country') ? flag('country').toUpperCase() : null;
const DRY = argv.includes('--dry');

function d1(sql, { json = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  const f = `${OUT}/_dedupe_step.sql`;
  writeFileSync(f, sql);
  const args = ['wrangler@latest', 'd1', 'execute', DB, '--remote', `--file=${f}`, '-y'];
  if (json) args.push('--json');
  const out = execFileSync('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env });
  return json ? JSON.parse(out.slice(out.indexOf('['))) : out;
}

const scope = COUNTRY ? `country ${COUNTRY}` : 'every country';

if (DRY) {
  const r = d1(`SELECT COUNT(*) n FROM (${pairsSql(COUNTRY)})`, { json: true });
  console.log(`${scope}: ${r[0].results[0].n.toLocaleString()} rows would be merged away.`);
  console.log('Nothing was changed. Drop --dry to run it.');
  process.exit(0);
}

console.log(`Deduplicating ${scope}.`);
d1(DROP_WORK);
d1(CREATE_WORK);
d1(fillWorkSql(COUNTRY));
const n = d1(countSql(), { json: true })[0].results[0].n;
console.log(`  ${n.toLocaleString()} duplicate rows identified`);
if (!n) { d1(DROP_WORK); console.log('  nothing to do'); process.exit(0); }

// Merge before delete, always. A row removed before its phone number was
// copied across is a phone number nobody has any more.
for (const [i, sql] of mergeSql().entries()) {
  d1(sql);
  console.log(`  merged field ${i + 1}/${mergeSql().length}`);
}
d1(deleteSql());
console.log(`  ${n.toLocaleString()} rows removed`);
d1(DROP_WORK);
console.log('Done. Re-runnable: a second pass finds nothing because the survivors are unique.');
