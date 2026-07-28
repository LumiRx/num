#!/usr/bin/env node
/**
 * NUM — invite pool audit
 * =======================
 * Reads nothing, sends nothing, writes nothing. Runs the whole emailable pool
 * through the same classifier the sender uses and reports what would happen,
 * so the shape of the list is known before a single invite goes out.
 *
 *   node scripts/invite_audit.mjs
 *   node scripts/invite_audit.mjs --country=GB
 *
 * Three questions it answers:
 *   1. how many are the wrong audience, and why
 *   2. how many still land on generic copy (the mail-merge smell)
 *   3. how the remainder splits by jurisdiction tier
 */

import { execFileSync } from 'node:child_process';
import { catOf, riskOf, excludeReason, normaliseCategory } from './invite_gen.mjs';

const DB = 'num-db';
const argv = process.argv.slice(2);
const val = (f, d) => { const a = argv.find(x => x.startsWith(f + '=')); return a ? a.slice(f.length + 1) : d; };

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const where = [`email IS NOT NULL`, `email <> ''`, `email LIKE '%@%'`];
const countries = (val('--country', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if (countries.length) where.push(`upper(country) IN (${countries.map(q).join(',')})`);

const SQL = `SELECT id, name, category, dest, area, country, email FROM leads WHERE ${where.join(' AND ')}`;

console.log('\nReading the emailable pool from D1…');
const out = execFileSync('npx', [
  'wrangler@latest', 'd1', 'execute', DB, '--remote', '--json', '--command', SQL,
], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const rows = JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
console.log(`  ${rows.length} rows\n`);

const excl = {}, tiers = {}, nouns = {}, unmapped = {};
let sendable = 0, generic = 0;
const domains = new Map();

for (const r of rows) {
  const why = excludeReason(r);
  if (why) { excl[why] = (excl[why] || 0) + 1; continue; }
  sendable++;

  const tier = riskOf(r.country);
  tiers[tier] = (tiers[tier] || 0) + 1;

  const noun = catOf(r.category, r.name).noun;
  nouns[noun] = (nouns[noun] || 0) + 1;
  if (noun === 'somewhere good nearby') {
    generic++;
    const c = String(r.category || '(blank)');
    unmapped[c] = (unmapped[c] || 0) + 1;
  }

  const d = String(r.email).toLowerCase().split('@')[1];
  domains.set(d, (domains.get(d) || 0) + 1);
}

const table = (obj, n = 99) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `    ${String(v).padStart(6)}  ${k}`).join('\n');

const pct = n => `${(100 * n / rows.length).toFixed(1)}%`;

console.log(`WRONG AUDIENCE — dropped before any send: ${rows.length - sendable} (${pct(rows.length - sendable)})`);
console.log(table(excl));

console.log(`\nSENDABLE: ${sendable} (${pct(sendable)})`);
console.log(`\n  by jurisdiction tier`);
console.log(table(tiers));

console.log(`\n  what the traveller is asking for (top 20)`);
console.log(table(nouns, 20));

console.log(`\nSTILL GENERIC: ${generic} (${(100 * generic / (sendable || 1)).toFixed(1)}% of sendable)`);
if (generic) {
  console.log(`  categories with no mapping — worth adding if any are large:`);
  console.log(table(unmapped, 25));
}

const multi = [...domains.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
console.log(`\nSHARED DOMAINS: ${multi.length} domains hold more than one address ` +
            `(${multi.reduce((s, [, n]) => s + n, 0)} addresses; one per domain per run is enforced)`);
console.log(table(Object.fromEntries(multi.slice(0, 10))));
console.log('');
