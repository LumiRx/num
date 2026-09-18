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
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  // 0020 adds num_host_requests.booking_fee_minor, which 0014 only ever gave
  // to fresh databases — see the header of that file. A second pass reports
  // 'duplicate column name' and is tolerated below.
  'worker/migrations/0020_requests_booking_fee.sql',
  // 0021 is the luxury asset layer — yachts, jets, cars, their photographs and
  // the holds that stop one hull being sold twice. Four new tables plus two
  // ALTERs, so a second pass reports 'duplicate column name' and is tolerated.
  'worker/migrations/0021_luxury_assets.sql',
  // 0022 puts a phone number on a supplier. Without it, inbound photo resolution
  // depends on the supplier already being a NUM member with a matching verified
  // number — which a marina manager in Phuket is not, so every photo he sends
  // queues as an unknown sender forever. Five ALTERs, so a second pass reports
  // 'duplicate column name' and is tolerated below.
  'worker/migrations/0022_supplier_contact.sql',
  // 0023 is the Friday pack draw: an entries table keyed (phone, week_start) so
  // four texts on a Tuesday are one entry, and a draws table holding the seed,
  // the eligible count and the winners. The second table is the one that matters —
  // a draw nobody can reproduce is a stranger on the internet promising prizes.
  // Two CREATE TABLEs and three indexes, all IF NOT EXISTS, so a second pass is a
  // clean no-op rather than an error to tolerate.
  'worker/migrations/0023_giveaway.sql',
  // 0024 is the notification layer: native device tokens (the iOS app has been
  // POSTing APNs tokens to a route that did not exist, so every granted
  // permission was thrown away), what a member has agreed to receive, what they
  // like, and the columns that make a notification measurable instead of
  // write-only. Numbered 0024 and not 0023 because another session took that
  // number for the giveaway while this was being written — two migrations with
  // one number is an ambiguous apply order nobody should have to reason about.
  // Four ALTERs on num_notifications, so a second pass reports 'duplicate column
  // name' and is tolerated below.
  'worker/migrations/0024_notifications.sql',
  // 0025 caps partner-key minting per network. POST /api/partner/signup is
  // unauthenticated and instant, and BOTH its reply and the email it sends
  // carry a live API key — so one script with ten thousand addresses mailed ten
  // thousand working credentials from partners@itsnum.com to inboxes of its own
  // choosing, spending the sending reputation the booking confirmations depend
  // on. One ALTER plus an index, so a second pass reports 'duplicate column
  // name' and is tolerated below.
  //
  // Already applied by hand to production on 13 Sep while closing the finding;
  // re-running is a clean no-op and seals it.
  'worker/migrations/0025_partner_signup_ip.sql',
  // 0026 gives a draw entry ONE identity. 0023 keyed entries (phone, week_start)
  // with phone NOT NULL, and 107 of 147 members have no phone at all — so the
  // app's own entry path, wired live, could not write a row and failed on every
  // attempt while the SMS path worked. `entrant_key` is 'phone:+44…' when we
  // hold a number and 'member:mem_…' otherwise, and the app resolves the phone
  // first so one human cannot hold two tickets. Three CREATE TABLEs, three
  // indexes and one INSERT OR IGNORE that carries 0023's rows forward by id —
  // nothing is dropped or renamed, so a second pass is a clean no-op.
  'worker/migrations/0026_giveaway_entrant_key.sql',
  'worker/migrations/0027_notification_subtitle.sql',
  // The admin door's audit trail: one single-use row per "open that
  // venue's console". One CREATE TABLE and one index, both IF NOT
  // EXISTS, so a second pass is a clean no-op.
  'worker/migrations/0028_admin_console_opens.sql',
  // A venue's own menu: items, prices, stock. One CREATE TABLE and one
  // index, both IF NOT EXISTS, so a second pass is a clean no-op.
  'worker/migrations/0029_products.sql',
  'worker/migrations/0030_expert_docs.sql',
  // How guests rate the answers: the emoji ledger. One CREATE TABLE and
  // three indexes, all IF NOT EXISTS, so a second pass is a clean no-op.
  'worker/migrations/0031_reactions.sql',
  // Who referred an expert, and the one-level override that pays for it.
  // Six ALTERs, each its own statement, plus a rebuild of num_scout_earnings
  // to widen its `kind` CHECK — safe only because that table holds zero rows
  // today, which is why it is happening now rather than later.
  //
  // NOT re-runnable: ALTER TABLE ADD COLUMN and the rebuild both fail on a
  // second pass. It is sealed after its first successful apply, which is what
  // stops that from ever being tried.
  'worker/migrations/0032_scout_referrals.sql',
  // Deep research: one table and two indexes, all IF NOT EXISTS, so a second
  // pass is a clean no-op. The feature this backs had been sold on the pricing
  // card since memberships shipped and had never been built — see the header
  // of worker/research.mjs.
  'worker/migrations/0033_deep_research.sql',
  // Milestones an Expert reaches, plus the last free widening of the
  // earnings `kind` list ('milestone'). Verified zero rows in
  // num_scout_earnings immediately before writing it; NOT re-runnable.
  'worker/migrations/0034_scout_milestones.sql',
  // Pay rails: num_business_rails (a venue's connected Stripe account and its
  // rail opt-outs) plus four ALTERs on num_paylinks for the Stripe references
  // on a paid bill. The table is IF NOT EXISTS; the ALTERs are NOT
  // re-runnable. Code reads the table behind a fallback, so shipping the code
  // before running this is safe — see the file header.
  'worker/migrations/0035_pay_rails.sql',
  // An Expert's own list of shops they found. One CREATE TABLE and two
  // indexes, all IF NOT EXISTS, so a second pass is a clean no-op.
  'worker/migrations/0036_scout_leads.sql',
  // A fleet built from photographs: identified_json and draft on num_assets,
  // batch_id on num_asset_photos, asset_id on num_host_products. Four ALTERs,
  // so a second pass reports 'duplicate column name' and is tolerated below;
  // the three indexes are IF NOT EXISTS. The code reads `draft` behind
  // COALESCE-free queries that only run on the new endpoints, so shipping the
  // worker before this is applied leaves the old fleet card working and the
  // new one answering an error rather than lying.
  'worker/migrations/0037_fleet_intake.sql',
  // The client file: nine ALTERs on num_host_clients and num_host_requests
  // plus num_client_events. The ALTERs are NOT re-runnable and report
  // 'duplicate column name' on a second pass, which is tolerated below. The
  // table and its indexes are IF NOT EXISTS.
  'worker/migrations/0038_client_file.sql',
  // A member's Privy wallet address and a venue's POS connection. The POS
  // token column holds ciphertext, never a bearer token in the clear.
  // Table creates are IF NOT EXISTS; the three paylink ALTERs are NOT
  // re-runnable.
  'worker/migrations/0039_wallets_and_pos.sql',
  // NUM's own photos of places, taken by members who were there, with the
  // proof (venue-code scan or a fix within 150 m) and the reward in cents on
  // every row. Two new tables, all IF NOT EXISTS, no ALTER — re-runnable.
  'worker/migrations/0040_place_photos.sql',
  // A figure read off a photo of a paper bill, waiting for staff to confirm.
  // One table and one index, both IF NOT EXISTS, so a second pass is a no-op.
  'worker/migrations/0041_bill_proposals.sql',
  // A member's capped standing permission for NUM to pay a bill without a tap,
  // plus the attempt log that enforces the per-day ceiling. Two tables and one
  // index, all IF NOT EXISTS.
  'worker/migrations/0042_autopay.sql',
  // How a venue takes a booking (sms, email, its own system, or not at all),
  // which reservation system it already runs, and one account over several
  // addresses. Five tables and their indexes, all IF NOT EXISTS, no ALTER,
  // so a second pass is a no-op.
  'worker/migrations/0043_business_onboarding.sql',
];

const DRY = process.argv.includes('--dry');
const LOCAL = process.argv.includes('--local');
const SEAL_ONLY = process.argv.includes('--seal');
const DB = 'num-db';

/* ── THE SEAL ───────────────────────────────────────────────────────────────
 *
 * A migration that has been applied must never be edited again. Re-running an
 * edited CREATE TABLE IF NOT EXISTS is a silent no-op, so the edit reaches fresh
 * databases and no live one — which is exactly how booking_fee_minor went
 * missing for weeks while every test passed.
 *
 * So every successful REMOTE apply records the file's content hash in
 * APPLIED.json, and worker/migrationhygiene.test.mjs fails if a sealed file ever
 * changes. --local never seals: a local database is not production.
 */
const MANIFEST = 'worker/migrations/APPLIED.json';

function sealFiles(files) {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  let added = 0;
  for (const f of files) {
    const name = f.replace('worker/migrations/', '');
    const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
    if (m.sealed[name] !== hash) { m.sealed[name] = hash; added++; }
    // Sealing means production now HAS it, so it is no longer pending. Leaving it
    // in both lists would make the manifest claim two contradictory things, and
    // worker/migrationhygiene.test.mjs fails on exactly that.
    if (Array.isArray(m.pending)) m.pending = m.pending.filter((p) => p !== name);
  }
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  return added;
}

if (SEAL_ONLY) {
  // --seal RE-SEALS A FILE THAT IS ALREADY SEALED. It is for the one legitimate
  // edit to an applied migration: a comment or a typo in prose, which changes the
  // hash without changing a single statement.
  //
  // It deliberately refuses to seal a file that is not already in the manifest.
  // A new migration is sealed by APPLYING it, because the seal's whole meaning is
  // "production has this exact content" — and sealing one production has never
  // seen both protects a lie and locks the file before anyone can fix it.
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const known = FILES.filter((f) => f.replace('worker/migrations/', '') in m.sealed);
  const unknown = FILES.filter((f) => !known.includes(f));
  const n = sealFiles(known);
  console.log(n
    ? `Re-sealed ${n} migration${n === 1 ? '' : 's'} — commit worker/migrations/APPLIED.json.`
    : 'Nothing to re-seal — every applied migration already matches its hash.');
  for (const f of unknown) {
    console.log(`Not sealing ${f} — it has never been applied. Apply it and it seals itself.`);
  }
  process.exit(0);
}

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

// ── A SEALED MIGRATION IS NEVER RUN AGAIN ──────────────────────────────────
//
// 18 Sep 2026, 05:11 UTC: a stage died inside 0032_scout_referrals.sql — a
// table rebuild that production already had (its comment above even says the
// seal "stops that from ever being tried"). It did not: this loop walked every
// registered file on every pass, trusting IF NOT EXISTS and the ALREADY list
// to make that harmless. A rebuild (CREATE _new → INSERT → DROP → RENAME) is
// not harmless twice, and neither is any migration whose author wrote "NOT
// re-runnable". The seal means "production has this exact content" — so on a
// remote run, a sealed file with a matching hash is done, and is skipped.
// --local still runs everything: a fresh local database has nothing yet.
const sealed = (() => {
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')).sealed ?? {}; } catch { return {}; }
})();
const isSealed = (file) => {
  const name = file.replace('worker/migrations/', '');
  return name in sealed && sealed[name] === createHash('sha256').update(readFileSync(file)).digest('hex');
};
const TODO = LOCAL ? FILES : FILES.filter((f) => !isSealed(f));
if (!LOCAL && TODO.length < FILES.length) {
  console.log(`\n── schema: ${FILES.length - TODO.length} sealed migration(s) skipped — production has them`);
}

for (const file of TODO) {
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
  // Only a remote apply seals. A local database is not production, and sealing
  // from one would protect a hash that production has never seen.
  if (!LOCAL) {
    const n = sealFiles(FILES);
    if (n) console.log(`Sealed ${n} migration${n === 1 ? '' : 's'} — commit worker/migrations/APPLIED.json.`);
  }
  console.log('Now check it agrees with itself:');
  console.log('  curl -s "https://itsnum.com/api/host/integrity?key=$ADMIN_KEY" | head -40');
}
