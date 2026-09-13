/**
 * A founding host must be able to create an account.
 *
 * ── 6 SEP 2026: THE BUG THIS FILE EXISTS FOR ──────────────────────────────
 *
 * Dre sent a screenshot from a real host's phone:
 *
 *     "Could not reach NUM. Check your connection — nothing was created."
 *
 * Their connection was fine. `hostJoin` wrote the host's own words about
 * themselves with a third statement in its batch, `UPDATE num_hosts SET
 * about = ?`, and there is no `about` column on num_hosts — it is `notes`.
 * D1 batches are ATOMIC, so the failing UPDATE rolled back the host row and
 * the referral code with it. The worker 500'd, the page's `r.json()` threw on
 * an HTML error body, and its `.catch()` blamed the network.
 *
 * `num_hosts` held ZERO rows. It had never worked, and every founding host who
 * tried was lost without a trace — no row, no error we could see, no email.
 *
 * The test runs hostJoin's ACTUAL SQL against a table built from production's
 * real column list. A statement naming a column that does not exist fails here
 * instead of on a host's phone.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const WORKER = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

/**
 * num_hosts as production actually has it (read from D1, 6 Sep 2026).
 * Note what is present and what is NOT: `notes` exists, `about` does not.
 */
const NUM_HOSTS_COLS = 'id,name,company,email,phone,country,code,host_bps,term_months,status,terms_version,agreed_at,agreed_ip,terms_text,notes,created_at,updated_at,console_key,services_json,areas_json,verified_at,pricing_json,charge_mode,currency,tier,calendar_token,notify_phone,sms_opt_in,profile_updated_at,accepts_intros,in_network,blurb,plan_sub_id,plan_status,plan_renews_at,stripe_customer';

let db;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_hosts (${NUM_HOSTS_COLS.split(',').map((c) => `${c} TEXT`).join(', ')})`);
  db.exec(`CREATE TABLE num_referral_codes (code TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, university_id TEXT, reward_cs INTEGER, reward_referee_cs INTEGER, max_conversions INTEGER, max_reward_total_cs INTEGER, active INTEGER, expires_at TEXT, created_at TEXT)`);
});

/** Pull the SQL literals hostJoin actually runs, in order. */
function hostJoinSql() {
  const at = WORKER.indexOf('async function hostJoin');
  assert.ok(at > 0, 'hostJoin has moved or been renamed');
  const raw = WORKER.slice(at, WORKER.indexOf('\n}', WORKER.indexOf('await env.DB.batch([', at)));
  // Strip line comments FIRST. The comment above the batch quotes the broken
  // statement verbatim so the next reader understands the outage — and without
  // this, the extractor reads that quote as live code and reports the bug it
  // is describing. A test that cannot tell an explanation from an instruction
  // is a test that cries wolf for ever.
  const body = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  return [...body.matchAll(/`([^`]*(?:INSERT|UPDATE|SELECT|DELETE)[^`]*)`|"((?:INSERT|UPDATE|DELETE)[^"]*)"/gi)]
    .map((m) => (m[1] ?? m[2]).trim())
    .filter((q) => /num_hosts|num_referral_codes/i.test(q));
}

describe('hostJoin writes', () => {
  test('every statement it runs is valid against the real num_hosts schema', () => {
    for (const sql of hostJoinSql()) {
      assert.doesNotThrow(
        () => db.prepare(sql.replace(/\?\d*/g, '?')),
        `hostJoin runs SQL that production cannot execute — a founding host sees "Could not reach NUM":\n${sql}`,
      );
    }
  });

  test('the batch no longer touches a column that does not exist', () => {
    const cols = new Set(NUM_HOSTS_COLS.split(','));
    assert.ok(!cols.has('about'), 'guard assumption: production has no `about` column');
    const at = WORKER.indexOf('async function hostJoin');
    const fn = WORKER.slice(at, at + 4000).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(fn, /SET about\s*=/, 'the `about` UPDATE is back — this is the exact regression');
  });

  test('what the host tells us about themselves is stored, not discarded', () => {
    const sql = hostJoinSql().find((q) => /INSERT INTO num_hosts/i.test(q));
    assert.ok(sql, 'hostJoin no longer inserts a host');
    assert.match(sql, /\bnotes\b/, 'the form asks "who you look after" — storing it is the whole point');
    // Column count must equal placeholder count, or D1 rejects it at runtime.
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').length;
    const values = sql.slice(sql.lastIndexOf('VALUES'));
    const slots = (values.match(/[?]|,\s*'[^']*'|,\s*\d+/g) ?? []).length;
    assert.equal(cols, slots, `INSERT lists ${cols} columns but supplies ${slots} values`);
  });

  test('the insert actually runs, end to end, with the binds hostJoin supplies', () => {
    const sql = hostJoinSql().find((q) => /INSERT INTO num_hosts/i.test(q)).replace(/\?\d*/g, '?');
    // 15 values since 13 Sep 2026: `terms_text` became a column of its own, so
    // the agreed_ip HASH and the terms text are two binds rather than one
    // sliding into the other. This test is what caught that change, which is
    // the job — it is the guard against exactly the column-slide that put a
    // paragraph of prose in the address field for a month.
    const binds = ['h_1', 'Dre Darville', 'Lumiverse', 'okaayandre@gmail.com', '+13105551234', 'US',
      'DRE7', '300', 'v1', '1757000000', 'a1b2c3d4e5f60718', 'I agree…', 'k_abc', '1757000000',
      'I look after founders who throw events in LA every weekend'];
    assert.doesNotThrow(() => db.prepare(sql).run(...binds));
    const row = db.prepare('SELECT name, email, notes, status, code FROM num_hosts WHERE id=?').get('h_1');
    assert.equal(row.name, 'Dre Darville');
    assert.equal(row.status, 'active');
    assert.match(row.notes, /events in LA/, 'the answer to "who do you look after" must survive the write');
  });
});

describe('what the host is told when it fails', () => {
  test('the page cannot tell a 500 from a dead network — so the write must not 500', () => {
    const page = readFileSync(new URL('../public/hosts/index.html', import.meta.url), 'utf8');
    // `r.json()` throws on an HTML error body, landing in the same .catch() as
    // a real network failure. Pinned so nobody "fixes" the copy instead of the
    // cause, and so the next person knows the message is not evidence.
    assert.match(page, /\.then\(function \(r\) \{ return r\.json\(\); \}\)/);
    assert.match(page, /Could not reach NUM\. Check your connection/);
  });
});

/* ── an email address is not proof of anything ────────────────────────────
 *
 * hostJoin is idempotent by email so a host signing up twice keeps one
 * referral code instead of splitting their earnings. Correct. But the
 * already-exists branch REPLIED WITH THAT HOST'S console_url — the
 * password-less link to their account, their clients and their prices — to
 * anyone who posted their email address.
 *
 * A host's email is the least private thing about them: they are referrers, it
 * goes on their materials. So this was not fake-signup-at-scale, it was account
 * takeover by typing in an address, and it was the quietest thing in the file.
 *
 * The key now goes only where it already lives — their inbox. The referral code
 * and /r/ link stay in the reply because they are public by design and a
 * returning host still has to be told their code rather than shown an error.
 *
 * Verified by restoring console_url and watching these fail. */

const SRC = WORKER;

test('the already-a-host reply never carries a console key', () => {
  const i = SRC.indexOf('if (existing) {');
  assert.ok(i > 0, 'the idempotent-by-email branch must still exist');
  const branch = SRC.slice(i, i + 2600);
  const reply = branch.slice(branch.indexOf('return J({'));
  assert.doesNotMatch(reply, /console_url/,
    'replying with console_url hands a live account to whoever knows the email address');
  assert.doesNotMatch(reply, /console_key/, 'nor the raw key');
  assert.match(reply, /console_emailed: true/, 'it must say the link was sent instead');
  assert.match(reply, /code: existing\.code/, 'a returning host still needs their referral code');
});

test('the console link is emailed to the address on the account', () => {
  const i = SRC.indexOf('if (existing) {');
  const branch = SRC.slice(i, i + 2600);
  assert.match(branch, /sendBatch\(env, \[\{/, 'the branch must actually send');
  assert.match(branch, /to: \[email\]/, 'to the address, which for an existing host is the one on file');
  assert.match(branch, /host_relink/, 'tagged so a spike in these is visible');
  // Somebody probing addresses makes the real host's inbox the alarm, so the
  // mail has to tell them nothing happened rather than frighten them.
  assert.match(branch, /nothing has happened to your account/i,
    'a host who did not ask for this must be told plainly that they are fine');
});

test('one network cannot mint host accounts all day', () => {
  assert.match(SRC, /const HOST_JOINS_PER_NETWORK_PER_DAY = \d+;/);
  const n = Number(SRC.match(/HOST_JOINS_PER_NETWORK_PER_DAY = (\d+)/)[1]);
  assert.ok(n >= 2 && n <= 10, 'two co-founders signing up side by side is real; twenty is not');
  assert.match(SRC, /FROM num_hosts\s*\n\s*WHERE agreed_ip = \?1/,
    'counted in D1 — the isolate-local bucket above it is not a limit');
});

test('agreed_ip holds an address hash, not the terms text', () => {
  // It held the terms text: the INSERT bound 14 values against 16 columns and
  // everything after terms_version slid one place. So the legal record said
  // nothing about who agreed, and the rate limit above would have compared a
  // hash to a paragraph of prose and never fired once.
  const i = SRC.indexOf('INSERT INTO num_hosts');
  assert.ok(i > 0, 'hostJoin must still insert a host');
  const stmt = SRC.slice(i, i + 1400);
  assert.match(stmt, /agreed_ip,terms_text,/, 'the terms need a column of their own');
  const code = stmt.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /iph,\s*String\(b\.terms_text \|\| ""\)/,
    'and the hash must be bound where agreed_ip actually is');
});
