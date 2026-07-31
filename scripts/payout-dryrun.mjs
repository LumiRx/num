// Runs the real preflight + routing modules over a snapshot of the live ledger.
// Read-only, no credentials, nothing deployed — the point is to see exactly
// what the desk would say before anyone is paid.
import { readFileSync } from 'node:fs';
import { buildContext, checkMember, worstSeverity } from '../payouts/preflight.mjs';
import { chooseRail, STAR_CENTS, railReady } from '../payouts/rails.mjs';

const load = (n) => JSON.parse(readFileSync(`/tmp/pf/${n}.json`, 'utf8'));
const members = load('members'), finance = load('finance'), methods = load('methods'), rails = load('rails');

const byId = new Map(members.map((m) => [m.id, m]));
const mineOf = (id) => methods.filter((m) => m.member_id === id);
const context = buildContext(methods);
const env = {}; // no rails configured — exactly production today

const rows = finance.map((f) => {
  const member = byId.get(f.member_id);
  const mine = mineOf(f.member_id);
  const method = mine.find((m) => m.is_default && m.status === 'enabled') ?? mine.find((m) => m.status === 'enabled') ?? mine[0] ?? null;
  const countryRails = rails.filter((r) => r.country === member?.country);
  const amountCents = f.stars_earned * STAR_CENTS;
  const findings = checkMember({ member, finance: f, method, rails: countryRails, context });
  const routing = chooseRail({ member, methods: mine, countryRails, amountCents, env });
  return { id: f.member_id, name: member?.name, country: member?.country, stars: f.stars_earned, amountCents,
    severity: worstSeverity(findings), findings, rail: routing.chosen?.rail ?? null,
    ready: routing.chosen ? railReady(env, routing.chosen.rail) : false, blocked: routing.blocked_reason };
}).sort((a, b) => b.stars - a.stars);

const S = { block: [], hold: [], note: [], clear: [] };
rows.forEach((r) => S[r.severity].push(r));
const money = (c) => '$' + (c / 100).toFixed(2);

console.log(`${rows.length} members hold Stars · ${rows.reduce((n, r) => n + r.stars, 0)} Stars = ${money(rows.reduce((n, r) => n + r.amountCents, 0))}\n`);
console.log(`BLOCKED ${S.block.length}   NEEDS A HUMAN ${S.hold.length}   CLEAR ${S.clear.length + S.note.length}\n`);

console.log('── BLOCKED — the system refuses these');
for (const r of S.block.slice(0, 8)) {
  console.log(`  ${(r.name ?? r.id).slice(0, 22).padEnd(22)} ${String(r.stars).padStart(5)}★ ${money(r.amountCents).padStart(9)}  ${r.country ?? '—'}`);
  r.findings.filter((f) => f.severity === 'block').forEach((f) => console.log(`      ✕ ${f.message}`));
}
if (S.block.length > 8) console.log(`  …and ${S.block.length - 8} more`);

console.log('\n── NEEDS A HUMAN');
for (const r of S.hold) {
  console.log(`  ${(r.name ?? r.id).slice(0, 22).padEnd(22)} ${String(r.stars).padStart(5)}★ ${money(r.amountCents).padStart(9)}  ${r.country ?? '—'}  rail=${r.rail ?? 'none'}`);
  r.findings.filter((f) => f.severity === 'hold').forEach((f) => console.log(`      ! ${f.message}`));
}

console.log('\n── CLEAR TO PAY (once a rail is connected)');
for (const r of [...S.clear, ...S.note]) {
  console.log(`  ${(r.name ?? r.id).slice(0, 22).padEnd(22)} ${String(r.stars).padStart(5)}★ ${money(r.amountCents).padStart(9)}  ${r.country ?? '—'}  rail=${r.rail ?? 'none'} ready=${r.ready}`);
}
const payableNow = [...S.clear, ...S.note, ...S.hold].reduce((n, r) => n + r.amountCents, 0);
console.log(`\nTotal not blocked: ${money(payableNow)} across ${S.clear.length + S.note.length + S.hold.length} members.`);
console.log(`Blocked from paying: ${money(S.block.reduce((n, r) => n + r.amountCents, 0))} across ${S.block.length}.`);
