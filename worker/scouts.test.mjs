// The scout payout rules, asserted against a real SQLite rather than read.
//
// The rule that matters and the reason it exists: NOTHING IS PAID FOR A
// SIGNATURE. A finder's fee is released only once the business has produced
// its first $5 of revenue to NUM. Paying on verification would make the
// optimal scout strategy "collect fifty signatures on one street", which
// spends real money to buy a directory of listings nobody uses.
//
// These are schema-level guarantees on purpose. Application code can be
// rewritten by someone who does not know why the rule is there; a CHECK
// constraint cannot be talked round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SQL = readFileSync(
  fileURLToPath(new URL('./migrations/0006_scouts.sql', import.meta.url)),
  'utf8',
);

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(SQL);
  return d;
}

const refuses = (d, sql) => assert.throws(() => d.exec(sql));
const allows = (d, sql) => assert.doesNotThrow(() => d.exec(sql));

const SCOUT = (id, code, extra = '') =>
  `INSERT INTO num_scouts (id,name,email,email_lc,code,terms_version,agreed_at${extra ? ',' + extra[0] : ''})
   VALUES ('${id}','A','${id}@b.c','${id}@b.c','${code}','v1','2026-08-26'${extra ? ',' + extra[1] : ''})`;

const PLACE = (id, placeId, state = 'introduced') =>
  `INSERT INTO num_scout_places (id,scout_id,place_id,biz_name,state,finder_cents,share_bps,sub_share_bps)
   VALUES ('${id}','s1','${placeId}','X','${state}',500,2000,2000)`;

const EARN = (id, kind, amount, gross, period = '2026-08') =>
  `INSERT INTO num_scout_earnings (id,scout_id,scout_place_id,kind,amount_minor,gross_minor,period)
   VALUES ('${id}','s1','p1','${kind}',${amount},${gross},'${period}')`;

/* ── the gate itself ────────────────────────────────────────────────────── */

test('the default gate is $5.00 and the default fee is $5.00', () => {
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  const r = d.prepare('SELECT finder_cents, finder_gate_minor FROM num_scouts').get();
  assert.equal(r.finder_gate_minor, 500);
  assert.equal(r.finder_cents, 500);
});

test('a zero gate cannot be configured — that is pay-on-signature', () => {
  // The whole point. If someone could set the gate to 0 the rule would be a
  // comment rather than a rule.
  refuses(db(), SCOUT('s1', 'C1', ['finder_cents,finder_gate_minor', '0,0']));
});

test('a fee larger than the gate cannot be configured', () => {
  // It would mean paying out $20 on a business that produced $5 — NUM losing
  // money by design, on every single introduction.
  refuses(db(), SCOUT('s1', 'C1', ['finder_cents,finder_gate_minor', '2000,500']));
});

test('a fee equal to the gate is allowed, and a smaller one too', () => {
  const d = db();
  allows(d, SCOUT('s1', 'C1', ['finder_cents,finder_gate_minor', '500,500']));
  allows(d, SCOUT('s2', 'C2', ['finder_cents,finder_gate_minor', '500,2000']));
});

/* ── the place state machine ────────────────────────────────────────────── */

test('activated is a state, and it is distinct from verified', () => {
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  allows(d, PLACE('p1', 'PLACE_A', 'verified'));
  allows(d, PLACE('p2', 'PLACE_B', 'activated'));
  refuses(d, PLACE('p3', 'PLACE_C', 'earning'));
  refuses(d, PLACE('p4', 'PLACE_D', 'paid'));
});

test('a verified place starts with no revenue and no activation date', () => {
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  d.exec(PLACE('p1', 'PLACE_A', 'verified'));
  const r = d.prepare('SELECT revenue_minor, activated_at, term_ends_at FROM num_scout_places').get();
  assert.equal(r.revenue_minor, 0, 'verifying earns nothing');
  assert.equal(r.activated_at, null);
  assert.equal(r.term_ends_at, null, 'the term clock has not started');
});

test('revenue cannot go negative', () => {
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  d.exec(PLACE('p1', 'PLACE_A', 'verified'));
  refuses(d, "UPDATE num_scout_places SET revenue_minor = -1 WHERE id = 'p1'");
});

test('a second scout cannot be credited with the same place', () => {
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  d.exec(PLACE('p1', 'PLACE_A'));
  refuses(d, PLACE('p2', 'PLACE_A'));
});

/* ── what may be paid ───────────────────────────────────────────────────── */

test('a $5 finder fee is refused when the business produced nothing', () => {
  // This is the test that encodes the decision. Before the gate, this row was
  // legal — the finder kind was explicitly exempt from the check.
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  d.exec(PLACE('p1', 'PLACE_A', 'verified'));
  refuses(d, EARN('e1', 'finder', 500, 0));
});

test('a $5 finder fee is allowed once $5 has been collected', () => {
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  d.exec(PLACE('p1', 'PLACE_A', 'activated'));
  allows(d, EARN('e1', 'finder', 500, 500));
});

test('the same finder fee cannot be accrued twice', () => {
  // The activation sweep is expected to run repeatedly. Running it twice must
  // not pay twice.
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  d.exec(PLACE('p1', 'PLACE_A', 'activated'));
  d.exec(EARN('e1', 'finder', 500, 500));
  refuses(d, EARN('e2', 'finder', 500, 500));
});

test('no kind of share may exceed what was collected', () => {
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  d.exec(PLACE('p1', 'PLACE_A', 'activated'));
  refuses(d, EARN('e1', 'commission_share', 900, 800));
  refuses(d, EARN('e2', 'subscription_share', 1, 0, '2026-09'));
  allows(d, EARN('e3', 'commission_share', 160, 800, '2026-10'));
});

test('only a manual adjustment may have no gross behind it', () => {
  // A correction is not a share of anything, so it has no gross of its own.
  const d = db();
  d.exec(SCOUT('s1', 'C1'));
  d.exec(PLACE('p1', 'PLACE_A', 'activated'));
  allows(d, EARN('e1', 'adjustment', 300, 0));
});

/* ── no payment instruments, anywhere ───────────────────────────────────── */

test('no scout table holds a payment instrument', () => {
  // California B&P §17550.11 sizes a seller-of-travel bond to money the seller
  // HOLDS. NUM holds none, and these tables are why that stays true.
  const d = db();
  const banned = /card|pan\b|cvv|cvc|iban|swift|sort_code|routing|account_number|bank|wallet|stripe_|paypal/i;
  const tables = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'num_scout%'",
  ).all();
  assert.ok(tables.length >= 4, 'expected the four scout tables');
  for (const t of tables) {
    for (const col of d.prepare(`PRAGMA table_info(${t.name})`).all()) {
      assert.doesNotMatch(col.name, banned, `${t.name}.${col.name}`);
    }
  }
});

/* ── the promise cannot silently change under someone ───────────────────── */

test('the rates a place was introduced on are stored on the place', () => {
  // A scout who joined in August is owed August's terms, even if the
  // programme rate changes next year.
  const d = db();
  const cols = d.prepare('PRAGMA table_info(num_scout_places)').all().map((c) => c.name);
  for (const c of ['finder_cents', 'share_bps', 'sub_share_bps', 'finder_gate_minor']) {
    assert.ok(cols.includes(c), `num_scout_places must carry its own ${c}`);
  }
});
