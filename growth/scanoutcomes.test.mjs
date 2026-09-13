// Every scan outcome the code writes must be one the table will accept.
//
// num_venue_scans.outcome has a CHECK constraint. logScan catches its own
// INSERT failure — correctly, because a logging problem must never cost a guest
// their perk — so a new outcome that the table rejects does not break anything
// visible. It just never lands.
//
// That is how the guessing lock shipped working and unobservable: the refusal
// fired on the tenth guess exactly as designed, and wrote nothing, because
// 'guess_locked' was not in the CHECK list. The security sweep reads this table.
// For a security event the row IS the alert, so a rejected write is a missing
// alarm, not a missing log line.
//
// This test is the thing that stops it happening again: it reads the outcomes
// out of the worker and the CHECK list out of the migration and requires the
// first to be a subset of the second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const SRC = readFileSync(join(HERE, 'worker.js'), 'utf8');

/** Outcomes the CHECK constraint allows, from the newest migration that sets it. */
function allowedOutcomes() {
  const dir = join(HERE, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let list = null;
  for (const f of files) {
    // Strip SQL line comments FIRST. Without this the extractor happily reads a
    // name out of a comment, so commenting an outcome out of the constraint
    // still "passed" — the test agreed with a migration that would have
    // rejected the write. Caught by mutating the migration and watching this
    // stay green, which is the only way that class of bug ever shows up.
    const sql = readFileSync(join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    const m = sql.match(/outcome\s+TEXT NOT NULL CHECK \(outcome IN \(([\s\S]*?)\)\)/);
    if (m) list = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  }
  assert.ok(list, 'no migration defines the outcome CHECK — this test cannot protect anything');
  return list;
}

/** Outcomes the worker actually writes, from every logScan call site. */
function writtenOutcomes() {
  const found = new Set();
  for (const m of SRC.matchAll(/outcome:\s*"([a-z_]+)"/g)) found.add(m[1]);
  return [...found];
}

test('the migration really defines the outcome list', () => {
  const allowed = allowedOutcomes();
  assert.ok(allowed.length >= 9, `expected at least the 9 outcomes; got ${allowed.join(',')}`);
  for (const must of ['guess_locked', 'guess_brake']) {
    assert.ok(allowed.includes(must), `${must} must be permitted — the lock writes it`);
  }
});

test('every outcome the worker writes is one the table accepts', () => {
  const allowed = allowedOutcomes();
  const written = writtenOutcomes();
  assert.ok(written.length >= 7, 'expected to find the logScan call sites');
  for (const o of written) {
    assert.ok(
      allowed.includes(o),
      `the worker writes outcome "${o}" but the CHECK constraint rejects it — `
      + 'that write will be swallowed and, if it is a security event, the alarm never rings. '
      + `Allowed: ${allowed.join(', ')}`,
    );
  }
});

test('a rejected scan write says which outcome was rejected', () => {
  // "scan log failed" alone reads like a transient blip. The outcome is what
  // turns it into "you added an outcome and forgot the migration".
  assert.match(SRC, /console\.warn\("\[venue\] scan log failed:", row\.outcome/);
});
