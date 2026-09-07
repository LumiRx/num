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
const NUM_HOSTS_COLS = 'id,name,company,email,phone,country,code,host_bps,term_months,status,terms_version,agreed_at,agreed_ip,notes,created_at,updated_at,console_key,services_json,areas_json,verified_at,pricing_json,charge_mode,currency,tier,calendar_token,notify_phone,sms_opt_in,profile_updated_at,accepts_intros,in_network,blurb,plan_sub_id,plan_status,plan_renews_at,stripe_customer';

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
    const binds = ['h_1', 'Dre Darville', 'Lumiverse', 'okaayandre@gmail.com', '+13105551234', 'US',
      'DRE7', '300', 'v1', '1757000000', 'I agree…', 'k_abc', '1757000000',
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
