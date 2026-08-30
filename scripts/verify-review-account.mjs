#!/usr/bin/env node
/**
 * NUM — App Review demo account verifier
 * ======================================
 * Reads. Never writes, never sends, never deploys.
 *
 *   node scripts/verify-review-account.mjs --phone=+66811234567
 *   node scripts/verify-review-account.mjs --member=mem_xxxxxxxxxxxxxxxxxxxx
 *   node scripts/verify-review-account.mjs --phone=+66… --json
 *
 * Why this exists. `docs/store-submission-checklist.md` §B lists what the
 * reviewer's account must contain before we submit, and the box next to each
 * line has always been ticked by hand. Apple's single largest rejection cause
 * is 2.1 App Completeness — a demo account that does not work or is empty —
 * so "I think I set that up" is not good enough. This asks D1 the same
 * questions the checklist asks, one query per line, and prints PASS/FAIL.
 *
 * It also prints the exact `wrangler secret put` values for the App Review
 * access grant (`worker/social.mjs` — REVIEW_DEMO_*), because the member id it
 * needs is the one thing you cannot know without looking it up.
 *
 * ── WHAT IT CANNOT SEE ────────────────────────────────────────────────────
 * Four §B lines do NOT live in D1 and this script says so rather than
 * pretending: the concierge transcript, the Today canvas bookings, saved
 * Places and visit history are persisted in localStorage on the device
 * (`src/lib/data.ts` saveState → `num-app-state`). They do not travel with a
 * sign-in, so a reviewer on a clean device sees them EMPTY no matter what is
 * in the database. That is a product finding, not a script limitation — see
 * `HQ/divisions/num/APP_REVIEW_RECOVERY.md`.
 */

import { execFileSync } from 'node:child_process';

const DB = 'num-db';
const CONFIG = 'wrangler.app.jsonc';
const argv = process.argv.slice(2);
const val = (f, d = null) => {
  const a = argv.find((x) => x.startsWith(`${f}=`));
  return a ? a.slice(f.length + 1) : d;
};
const JSON_OUT = argv.includes('--json');

const phone = val('--phone');
const member = val('--member');
if (!phone && !member) {
  console.error('Give me one of --phone=+66… or --member=mem_…\n');
  console.error('  node scripts/verify-review-account.mjs --phone=+66811234567');
  process.exit(2);
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler@latest', 'd1', 'execute', DB, '--remote', '--config', CONFIG, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // wrangler prints a banner before the JSON; start at the first bracket.
  const i = out.indexOf('[');
  if (i < 0) throw new Error(`no JSON in wrangler output:\n${out}`);
  return JSON.parse(out.slice(i))[0]?.results ?? [];
}

const ok = (b) => (b ? '  PASS' : '  FAIL');
const results = [];
const check = (line, pass, detail) => {
  results.push({ line, pass: !!pass, detail });
  if (!JSON_OUT) console.log(`${ok(pass)}  ${line}${detail ? `\n        ${detail}` : ''}`);
};

if (!JSON_OUT) console.log('\nNUM — App Review demo account, against docs/store-submission-checklist.md §B\n');

// ── the account itself ─────────────────────────────────────────────────────
const where = member ? `id = ${q(member)}` : `phone = ${q(phone)}`;
const rows = d1(`SELECT id, name, phone, phone_verified, name_locked, ref_code, created_at, seen_at
                 FROM num_members WHERE ${where}`);

if (rows.length === 0) {
  check('The demo account exists', false, `no row in num_members WHERE ${where}`);
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, results }, null, 2));
  else console.log('\nNothing else can be checked without an account. Create it, then run this again.\n');
  process.exit(1);
}
if (rows.length > 1) {
  check('Exactly one account holds this number', false, `${rows.length} rows matched — the grant must be pinned with REVIEW_DEMO_MEMBER`);
}
const me = rows[0];
const id = me.id;

check('The demo account exists', true, `${id} · ${me.name} · ${me.phone} · created ${me.created_at}`);
check('It has a phone number on file (the only credential the app accepts)', !!me.phone);
check(
  'Its number is verified ("verified against a test phone number")',
  me.phone_verified === 1,
  me.phone_verified === 1
    ? 'note: verified CLOSES the recovery branch — the App Review grant is what gets a reviewer in'
    : 'not verified. Do NOT set this by hand to fix a lockout; use the App Review grant instead',
);

// ── §B, line by line ───────────────────────────────────────────────────────
const one = (sql) => Number(d1(sql)[0]?.n ?? 0);

const smsIn = one(`SELECT COUNT(*) n FROM num_inbox WHERE member_id = ${q(id)} AND kind = 'sms'`);
check(
  'At least one message that arrived via SMS (the unified thread)',
  smsIn > 0,
  `num_inbox kind='sms' rows: ${smsIn}`,
);

const asks = one(`SELECT COUNT(*) n FROM num_asks WHERE member_id = ${q(id)}`);
check(
  'Concierge thread with real history',
  asks > 0,
  `num_asks rows: ${asks} — NOTE the rendered transcript is device-local (src/lib/data.ts), so this proves the account was USED, not that the reviewer will see it`,
);

const today = new Date().toISOString().slice(0, 10);
const upcoming = one(`SELECT COUNT(*) n FROM num_booking_requests WHERE member_id = ${q(id)} AND on_date >= ${q(today)}`);
const past = one(`SELECT COUNT(*) n FROM num_booking_requests WHERE member_id = ${q(id)} AND on_date < ${q(today)}`);
check('One upcoming booking', upcoming > 0, `num_booking_requests on_date >= ${today}: ${upcoming}`);
check('One past booking', past > 0, `num_booking_requests on_date < ${today}: ${past}`);

const farOut = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
const far = one(`SELECT COUNT(*) n FROM num_booking_requests WHERE member_id = ${q(id)} AND on_date >= ${q(farOut)}`);
check('A far-future booking visible in the calendar', far > 0, `on_date >= ${farOut}: ${far}`);

const stars = d1(`SELECT COUNT(*) n, COALESCE(SUM(delta),0) total FROM num_star_moves WHERE member_id = ${q(id)}`)[0] ?? {};
check(
  'Stars already awarded, and the ledger shows the entry',
  Number(stars.n ?? 0) > 0,
  `num_star_moves rows: ${stars.n ?? 0} · net ${stars.total ?? 0}`,
);
const earned = one(`SELECT COUNT(*) n FROM num_star_moves WHERE member_id = ${q(id)} AND delta > 0 AND (kind LIKE '%visit%' OR kind LIKE '%receipt%' OR kind LIKE '%review%')`);
check('…and at least one of them came from a visit/receipt', earned > 0, `matching num_star_moves rows: ${earned}`);

const plans = d1(`SELECT p.id, p.title, p.join_code FROM num_plans p
                  JOIN num_plan_members m ON m.plan_id = p.id
                  WHERE m.member_id = ${q(id)} AND p.join_code IS NOT NULL`);
check(
  'A shared-plan link that resolves in a browser',
  plans.length > 0,
  plans.length
    ? plans.map((p) => `join code ${p.join_code} · ${p.title} (${p.id})`).join('\n        ')
    : 'no plan with a join_code — nothing for a reviewer to open',
);

const friends = one(`SELECT COUNT(*) n FROM num_links WHERE (a_id = ${q(id)} OR b_id = ${q(id)}) AND state = 'active'`);
check('At least one live connection (People is not empty)', friends > 0, `num_links state='active': ${friends}`);

// ── the four lines D1 cannot answer ────────────────────────────────────────
if (!JSON_OUT) {
  console.log(`
  N/A   2–3 saved places in Places
  N/A   A visit with an uploaded receipt
  N/A   The rendered concierge transcript
  N/A   The Today canvas

        These four are localStorage on the device (src/lib/data.ts saveState).
        They do NOT travel with a sign-in. A reviewer on a clean device sees
        them empty whatever this database contains — see
        HQ/divisions/num/APP_REVIEW_RECOVERY.md §3.
`);
}

// ── the grant ──────────────────────────────────────────────────────────────
const until = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
if (!JSON_OUT) {
  console.log(`App Review access grant — the four secrets, for num-app only:

  npx wrangler secret put REVIEW_DEMO_PHONE  --config ${CONFIG}   # ${me.phone ?? '(no number on file!)'}
  npx wrangler secret put REVIEW_DEMO_MEMBER --config ${CONFIG}   # ${id}
  npx wrangler secret put REVIEW_ACCESS_UNTIL --config ${CONFIG}  # ${until}T00:00:00Z
  npx wrangler secret put REVIEW_DEMO_CODE   --config ${CONFIG}   # 20+ random chars, generated below

  A code, if you want one (do not echo this into a shared terminal):
    node -e "console.log('NUM-REVIEW-'+require('crypto').randomBytes(12).toString('base64url'))"

  Revoke with:  npx wrangler secret delete REVIEW_DEMO_CODE --config ${CONFIG}
  Audit with:   npx wrangler d1 execute ${DB} --remote --config ${CONFIG} \\
                  --command "SELECT * FROM num_identity_signals WHERE ua_hash LIKE 'review-grant:%' ORDER BY created_at DESC"
`);
}

const failed = results.filter((r) => !r.pass);
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed.length === 0, member: me, results }, null, 2));
} else {
  console.log(
    failed.length === 0
      ? '\nAll checkable §B lines PASS. The four N/A lines still need the recovery pack.\n'
      : `\n${failed.length} FAIL:\n  · ${failed.map((f) => f.line).join('\n  · ')}\n`,
  );
}
process.exit(failed.length === 0 ? 0 : 1);
