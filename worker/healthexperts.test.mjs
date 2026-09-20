/**
 * The health check that would have caught the placeholder emails.
 *
 * On 17 Sep 2026 both Num Experts in production had a literal placeholder
 * where their email should be — 'REPLACE_WITH_ISAIAHS_EMAIL' and
 * '<<ADAM_EMAIL>>'. Two seed files were run without the substitution, and
 * nothing objected, because a hand-written INSERT bypasses `enrol()` and its
 * validation.
 *
 * It sat for sixteen days. Nothing in the programme mailed an Expert, so there
 * was never a bounce to notice. The day sign-in became an emailed link, both
 * were locked out of their own earnings.
 *
 * A test over the source could not have found this: the bad value was in the
 * database. So the check reads the database, and this file feeds it the exact
 * shape production was actually in.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { checkExperts } from './health.mjs';

let db;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
});

const expert = (id, email, cap = 60, lc = null) =>
  `INSERT INTO num_scouts (id,name,email,email_lc,code,status,monthly_claim_cap)
   VALUES ('${id}','${id}','${email}','${lc ?? email.toLowerCase()}','C${id.slice(0, 4).toUpperCase()}','active',${cap === null ? 'NULL' : cap})`;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_scouts (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_lc TEXT,
    code TEXT, status TEXT, monthly_claim_cap INTEGER)`);
});

/**
 * The check on its own.
 *
 * Deliberately NOT through `runHealth`: that fires every other probe too — a
 * live fetch of itsnum.com, a D1 write, the brain — so a unit test of this one
 * function would depend on the network and on ten unrelated things being
 * configured. It is wired into the health run, and the last test here asserts
 * that separately.
 */
const experts = () => checkExperts({ DB: d1(db) });

describe('the Expert health check', () => {
  test('clean Experts pass', async () => {
    db.exec(expert('ok1', 'sean@example.com'));
    db.exec(expert('ok2', 'isaiah@example.com'));
    const c = await experts();
    assert.equal(c.ok, true);
    assert.equal(c.experts, 2);
  });

  test('THE REAL PRODUCTION STATE is caught', async () => {
    // Verbatim, both of them, as found in num-db on 17 Sep 2026.
    db.exec(expert('isaiah', 'REPLACE_WITH_ISAIAHS_EMAIL'));
    db.exec(expert('adam', '<<ADAM_EMAIL>>', null));
    const c = await experts();
    assert.equal(c.ok, false, 'the state that actually shipped reads as healthy');
    assert.equal(c.bad_email, 2);
    assert.equal(c.uncapped, 1, "Adam's missing fraud cap went unnoticed");
    assert.match(c.remedy, /cannot sign in and cannot be paid/);
  });

  test('an address updated in only ONE of the two columns is caught', async () => {
    // `email` is what gets mailed; `email_lc` is what sign-in matches on.
    // Fixing one and not the other gives an Expert who can be emailed a link
    // they can never redeem — and it looks correct from either column alone.
    db.exec(expert('half', 'sean@example.com', 60, 'old@example.com'));
    const c = await experts();
    assert.equal(c.ok, false);
    assert.equal(c.split_email, 1);
    assert.match(c.remedy, /mail works, sign-in does not/);
  });

  test('an uncapped Expert alone is enough to flag', async () => {
    db.exec(expert('nocap', 'fine@example.com', null));
    const c = await experts();
    assert.equal(c.ok, false);
    assert.equal(c.uncapped, 1);
    assert.equal(c.bad_email, 0);
  });

  test('paused Experts are not counted — they cannot sign in anyway', async () => {
    db.exec(expert('gone', 'REPLACE_ME'));
    db.exec(`UPDATE num_scouts SET status='ended' WHERE id='gone'`);
    const c = await experts();
    assert.equal(c.ok, true);
  });

  test('it is wired into the health run, and degrades rather than downs', () => {
    // A check nobody calls is a check that does not exist, so the wiring is
    // asserted. And `experts` is deliberately absent from DOWN: nothing here
    // is broken for a traveller, and calling it `down` would make the word
    // mean less the next time something really is.
    const src = readFileSync(new URL('./health.mjs', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /experts: await checkExperts\(env\)/,
      'checkExperts is never called — the check does not run');
    const down = /const DOWN = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
    assert.ok(!/experts/.test(down), 'a placeholder email now reports the whole product as down');
  });
});
