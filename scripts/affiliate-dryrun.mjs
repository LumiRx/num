#!/usr/bin/env node
/**
 * What Num hands away, and what a proposed affiliate table would do to it.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * `NUM_AFFILIATES` is a secret full of other people's tracking parameters,
 * typed by hand, one programme at a time, weeks apart. Every one of them is a
 * chance to break a link a guest is about to tap — a wrong parameter name
 * earns nothing, and a malformed rule silently disables the whole table
 * (affiliate.mjs parses it as one JSON blob).
 *
 * There is no way to see any of that from the Cloudflare dashboard: a secret
 * is write-only once set. So this runs the REAL tagger over the REAL links the
 * REAL provider tables produce, and prints exactly what would happen — before
 * the secret is touched.
 *
 * It is also the inventory. "Which of your properties do you send traffic to?"
 * is question one on every affiliate application, and the answer is the list
 * below, ranked by reach.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 *
 *   node scripts/affiliate-dryrun.mjs
 *       The inventory alone: every host Num can hand a guest to.
 *
 *   node scripts/affiliate-dryrun.mjs --table '{"opentable.com":{"ref":"12345","param":"ref"}}'
 *   node scripts/affiliate-dryrun.mjs --table-file ./affiliates.json
 *       Dry-run that table. Nothing is written anywhere; this never touches
 *       Cloudflare and never needs a credential.
 *
 *   node scripts/affiliate-dryrun.mjs --table-file ./affiliates.json --json
 *       Machine-readable, for a diff in CI.
 *
 * When the output is what you want, and ONLY then:
 *   printf '%s' "$(cat affiliates.json)" | npx wrangler secret put NUM_AFFILIATES --config wrangler.app.jsonc
 */
import { readFileSync } from 'node:fs';
import { handoffHosts } from '../worker/services.mjs';
import { tagged, affiliates } from '../worker/affiliate.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? '';
};
const asJson = argv.includes('--json');

let raw = flag('--table');
const file = flag('--table-file');
if (file) raw = readFileSync(file, 'utf8');
if (!raw && process.env.NUM_AFFILIATES) raw = process.env.NUM_AFFILIATES;

const env = raw ? { NUM_AFFILIATES: raw } : {};

// Fail loudly on a table affiliate.mjs would silently discard. This is the
// single highest-value check here: a stray comma disables tagging for EVERY
// programme, and production says nothing about it beyond one console.warn.
if (raw) {
  const parsed = affiliates(env);
  if (!Object.keys(parsed).length) {
    console.error('\n  ✗ THE TABLE IS EMPTY OR INVALID.\n');
    console.error('    affiliate.mjs parses NUM_AFFILIATES as one JSON object. If it does not');
    console.error('    parse, tagging is disabled for every programme at once — not just the');
    console.error('    broken line. Fix the JSON before putting this in a secret.\n');
    process.exit(1);
  }
  for (const [host, rule] of Object.entries(parsed)) {
    if (host.startsWith('_')) continue; // "_readme" and friends: notes, not hosts
    // Two modes (affiliate.mjs): `ref` appends a parameter; `wrap` is a
    // click-redirect template that must carry {dest} — the hotel chains'
    // networks (Impact, Partnerize) and Travelpayouts all work this way.
    if (rule?.wrap) {
      if (!/\{dest\}/.test(String(rule.wrap))) console.error(`  ! ${host}: "wrap" has no {dest} placeholder — the guest would never reach the site.`);
      if (/[A-Z]{4,}_[A-Z_]+/.test(String(rule.wrap))) console.error(`  ! ${host}: "wrap" still contains an UPPERCASE placeholder — paste your real ids first.`);
      continue;
    }
    if (!rule?.ref) console.error(`  ! ${host}: no "ref" and no "wrap" — this rule does nothing.`);
    if (/^[A-Z]{4,}_[A-Z_]+$/.test(String(rule?.ref ?? ''))) console.error(`  ! ${host}: "ref" is still a placeholder.`);
    if (rule?.param && /[?&=]/.test(String(rule.param))) {
      console.error(`  ! ${host}: "param" is a parameter NAME, not a query string (got ${JSON.stringify(rule.param)}).`);
    }
  }
}

const hosts = handoffHosts();
const rows = hosts.map((h) => {
  const t = tagged(h.sample, env, { extra: 'phuket' });
  return {
    ...h,
    reach: h.countries.length,
    tagged: t.tagged,
    programme: t.programme,
    reason: t.reason,
    before: h.sample,
    after: t.url,
  };
});

if (asJson) {
  console.log(JSON.stringify({ generated: new Date().toISOString(), hosts: rows }, null, 2));
  process.exit(0);
}

const earning = rows.filter((r) => r.tagged);
const not = rows.filter((r) => !r.tagged);

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n  NUM — outbound handoff inventory (${rows.length} hosts)\n`);
console.log(`  ${pad('HOST', 30)} ${pad('KINDS', 22)} ${pad('CC', 4)} ${pad('TAG', 4)} PROGRAMME / WHY NOT`);
console.log(`  ${'─'.repeat(96)}`);
for (const r of rows) {
  console.log(
    `  ${pad(r.host, 30)} ${pad(r.kinds.join(','), 22)} ${pad(r.reach, 4)} ${pad(r.tagged ? '✓' : '·', 4)} ` +
      (r.tagged ? r.programme : r.reason),
  );
}

console.log(`\n  ${earning.length} of ${rows.length} hosts would be tagged.`);
if (!raw) {
  console.log('  No table supplied — this is the inventory only. Pass --table-file to dry-run one.\n');
} else {
  // A rule that matches nothing is the quiet failure mode: the secret looks
  // right, the dashboard shows a programme, and no link ever carries it.
  const matched = new Set(rows.filter((r) => r.programme).map((r) => r.programme));
  const dead = Object.keys(affiliates(env)).filter((k) => k !== '*' && !matched.has(k));
  if (dead.length) {
    console.log(`\n  ✗ ${dead.length} rule(s) match no host Num actually hands to: ${dead.join(', ')}`);
    console.log('    Either the domain is spelled differently in services.mjs, or we do not');
    console.log('    send that company traffic yet. Check the inventory above.');
  }
  const blocked = not.filter((r) => r.reason === 'already_attributed' || r.reason === 'not_https' || r.reason === 'malformed');
  if (blocked.length) {
    console.log(`\n  ! ${blocked.length} host(s) refused a tag for a reason worth reading:`);
    for (const b of blocked) console.log(`    ${pad(b.host, 30)} ${b.reason}`);
  }
  const sample = earning[0];
  if (sample) {
    console.log('\n  Example of what changes:');
    console.log(`    before  ${sample.before}`);
    console.log(`    after   ${sample.after}`);
  }
  console.log('');
}

// The top of the application queue: widest reach, still unpaid.
const queue = not.filter((r) => r.reason === 'no_programme' || r.reason === 'no_table').slice(0, 12);
if (queue.length) {
  console.log('  APPLY NEXT (widest reach, no programme yet):');
  for (const r of queue) console.log(`    ${pad(r.host, 30)} ${r.reach} countries · ${r.kinds.join(', ')}`);
  console.log('\n  Rank this by REAL volume once num_affiliate_clicks has data:');
  console.log("    npx wrangler d1 execute num-db --remote --config wrangler.app.jsonc \\");
  console.log("      --command \"SELECT host, COUNT(*) n, SUM(tagged) paid FROM num_affiliate_clicks\\");
  console.log("       WHERE ts > strftime('%s','now','-30 days') GROUP BY host ORDER BY n DESC LIMIT 20\"\n");
}
