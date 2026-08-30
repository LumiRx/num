// The admin console asked four tables for columns they do not have.
//
// `rows()` catches a failed query and returns [], so the panels rendered
// empty and looked like "nothing has happened yet" rather than "this query
// has never once run". Four of them had been broken for weeks:
//
//   num_health          .at            queried as created_at
//   num_usage           .ts            queried as created_at
//   num_cashouts        .requested_at  queried as created_at
//   num_biz_referrals   .biz_name      queried as business_name
//
// The last two mattered most. The money tab counts pending cashouts by
// filtering the rows the query returns, so a query that always failed
// rendered "0 pending" — not "unknown", but an affirmative statement that
// nobody was waiting to be paid.
//
// This test builds the real tables from the CREATE statements in the repo —
// not a copy of them — and prepares every console query that touches one.
// SQLite refuses to prepare a SELECT naming a column that does not exist, so
// a rename anywhere in the schema fails the build here rather than silently
// blanking a panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');
const CONSOLE = read('console.mjs');

/** Every CREATE TABLE in a source file, as written there. */
function creates(src) {
  const out = new Map();
  const re = /CREATE TABLE IF NOT EXISTS\s+"?(\w+)"?\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    // Walk to the matching close paren so nested parens in CHECK/DEFAULT
    // survive — a regex for the body would stop at the first ")".
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.set(m[1], src.slice(m.index, i));
  }
  return out;
}

const SCHEMA_FILES = ['health.mjs', 'cashout.mjs', 'bizreferral.mjs', 'console.mjs'];
const TABLES = new Map();
for (const f of SCHEMA_FILES) for (const [k, v] of creates(read(f))) if (!TABLES.has(k)) TABLES.set(k, v);

const WATCHED = ['num_health', 'num_usage', 'num_cashouts', 'num_biz_referrals'];

test('the four tables the console got wrong are defined in the repo', () => {
  for (const t of WATCHED) assert.ok(TABLES.has(t), `${t} has no CREATE TABLE in ${SCHEMA_FILES}`);
});

/**
 * Every SQL string in console.mjs that names one of the watched tables.
 *
 * Template holes become 0, which is what they always are here: day counts and
 * epoch seconds. A hole in a column position would produce a syntax error and
 * fail loudly, which is the correct outcome for that too.
 */
function consoleQueries() {
  const found = [];
  const re = /(['"`])((?:SELECT|WITH)[\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(CONSOLE))) {
    const sql = m[2].replace(/\$\{[^}]*\}/g, '0');
    if (!WATCHED.some((t) => new RegExp(`\\b${t}\\b`).test(sql))) continue;
    // Skip anything that also reaches a table this test does not build — the
    // failure would be "no such table", which says nothing about columns.
    const named = [...sql.matchAll(/\b(?:FROM|JOIN)\s+"?(\w+)"?/gi)].map((x) => x[1]);
    if (named.some((t) => !TABLES.has(t))) continue;
    found.push(sql);
  }
  return found;
}

test('every console query against those tables actually prepares', () => {
  const d = new DatabaseSync(':memory:');
  for (const t of WATCHED) d.exec(TABLES.get(t));

  const qs = consoleQueries();
  // If this drops to zero the test has stopped testing anything — a refactor
  // that moved the queries out of console.mjs would otherwise look like a pass.
  assert.ok(qs.length >= 6, `only found ${qs.length} console queries to check`);

  for (const sql of qs) {
    try {
      d.prepare(sql);
    } catch (e) {
      assert.fail(`console query does not match the schema:\n  ${sql}\n  ${e.message}`);
    }
  }
});

test('the specific columns that were wrong are the ones now used', () => {
  // Named individually so a future rename produces a message that says which
  // panel broke, not just "a query failed".
  assert.match(CONSOLE, /at AS created_at\s+FROM num_health/,
    'the infra health panel is querying num_health.created_at again');
  assert.match(CONSOLE, /FROM num_usage WHERE ts >/,
    'the questions-24h count is querying num_usage.created_at again');
  assert.match(CONSOLE, /requested_at AS created_at\s+FROM num_cashouts/,
    'the payout queue is querying num_cashouts.created_at again');
  assert.match(CONSOLE, /biz_name AS business_name[\s\S]{0,60}FROM num_biz_referrals/,
    'the referrals panel is querying num_biz_referrals.business_name again');
});

test('a broken panel query is no longer swallowed in silence', () => {
  // The empty array stays — one broken panel must not blank the whole page —
  // but the silence is what let four of them sit broken for weeks.
  const fn = CONSOLE.slice(CONSOLE.indexOf('async function rows(env, sql'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /console\.warn\(/, 'rows() catches without saying anything');
  assert.match(body, /return \[\]/, 'a failed panel must still return an empty list');
});

test('a table ordered by a TEXT id is not ordered by time', () => {
  // num_cashouts.id and num_biz_referrals.id are TEXT primary keys, so
  // "ORDER BY id DESC LIMIT 10" returns ten arbitrary rows and calls them the
  // most recent. num_health.id is INTEGER AUTOINCREMENT and is fine.
  for (const t of ['num_cashouts', 'num_biz_referrals']) {
    assert.match(TABLES.get(t), /id TEXT PRIMARY KEY/, `${t}.id is no longer TEXT — recheck the ordering`);
  }
  assert.doesNotMatch(CONSOLE, /FROM num_cashouts ORDER BY id\b/);
  assert.doesNotMatch(CONSOLE, /FROM num_biz_referrals ORDER BY id\b/);
});
