// Rules about migrations that are cheap to break and expensive to find.
//
// growth/hostseparation.test.mjs already checked the semicolon rule, but only
// against four named files. Every migration added since then — 0019 through 0022
// — was outside it, which is the normal way a guard stops guarding: it keeps
// passing while the thing it protects grows past it.
//
// This reads the registry rather than a hand-written list, so a migration added
// tomorrow is covered the moment it is registered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

/** The files the host migration runner actually applies, read from the runner. */
function registered() {
  const src = read('scripts/apply-host-migrations.mjs');
  const block = src.slice(src.indexOf('['), src.indexOf('];') + 2);
  return [...block.matchAll(/'(worker\/migrations\/[^']+\.sql)'/g)].map((m) => m[1]);
}

test('the registry is not empty and the files it names exist', () => {
  const files = registered();
  assert.ok(files.length >= 8, `expected the registry to name several migrations, found ${files.length}`);
  for (const f of files) assert.ok(read(f).length > 0, `${f} is registered but empty or missing`);
});

test('no registered migration hides a semicolon in a comment', () => {
  // The runner strips line comments BEFORE splitting on ';', so this is belt and
  // braces rather than a live bug today. It stays because the next runner
  // somebody writes will not necessarily strip first — and a statement split in
  // half produces two invalid fragments and a migration that half-applied.
  for (const f of registered()) {
    const sql = read(f);
    sql.split('\n').forEach((line, i) => {
      const c = line.indexOf('--');
      assert.ok(!(c !== -1 && line.slice(c).includes(';')),
        `${f} line ${i + 1}: a semicolon inside a comment splits a statement in half in a naive runner`);
    });
  }
});

/* ── THE SEAL ──────────────────────────────────────────────────────────────
 *
 * How booking_fee_minor actually went missing, which is worth stating exactly
 * because the obvious explanation is the wrong one.
 *
 * 0014 created num_host_requests. It was applied. Later, somebody EDITED 0014 to
 * add booking_fee_minor to that CREATE TABLE. Re-running 0014 then did nothing at
 * all, because the table already existed and the statement is IF NOT EXISTS — so
 * the new column reached every fresh database and no live one. Production served
 * 500s from /api/host/requests for weeks while every test passed and every POST
 * to the same endpoint succeeded.
 *
 * No amount of reading the SQL finds that. The file is correct. The problem is
 * that it changed after it had been applied.
 *
 * So applied migrations are SEALED by content hash. Editing one fails here, with
 * the instruction: add a new migration with an ALTER.
 */

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const manifest = JSON.parse(read('worker/migrations/APPLIED.json'));

test('no sealed migration has been edited since it was applied', () => {
  const broken = [];
  for (const [file, hash] of Object.entries(manifest.sealed)) {
    const actual = sha256(readFileSync(new URL('migrations/' + file, import.meta.url)));
    if (actual !== hash) broken.push(file);
  }
  assert.deepEqual(broken, [],
    `${broken.join(', ')} changed after being applied to production. Re-running an edited `
    + 'CREATE TABLE IF NOT EXISTS is a silent no-op, so the change reaches fresh databases '
    + 'and no live one. Revert the edit and add a NEW migration with an ALTER instead. If the '
    + 'edit is only a comment, re-seal with: node scripts/apply-host-migrations.mjs --seal');
});

test('every registered migration is either sealed or explicitly pending', () => {
  // The first version of this asserted "at most one unsealed", which was true on
  // the day it was written and wrong a day later — two sessions each adding a
  // migration is normal, and a test that fails for that is a test people delete.
  //
  // The real invariant is that nobody is GUESSING. A migration is either sealed
  // (production has exactly this content) or listed as pending (production has
  // not had it yet). Something in neither list means somebody added a migration
  // and nobody knows whether it shipped — which is the whole question this file
  // exists to keep answerable.
  const pending = new Set(manifest.pending || []);
  const unaccounted = registered()
    .map((f) => f.replace('worker/migrations/', ''))
    .filter((f) => !(f in manifest.sealed) && !pending.has(f));
  assert.deepEqual(unaccounted, [],
    `these migrations are neither sealed nor listed as pending, so whether production has them is a guess: ${unaccounted.join(', ')}`);
});

test('a sealed migration is never run again on production', () => {
  // 18 Sep 2026: a stage died re-running 0032's table rebuild on a database
  // that already had it. The seal means "production has this exact content";
  // the runner must act on that, not just record it.
  const src = read('scripts/apply-host-migrations.mjs');
  assert.match(src, /const TODO = LOCAL \? FILES : FILES\.filter\(\(f\) => !isSealed\(f\)\);/,
    'the remote run must skip sealed files whose hash still matches');
  assert.match(src, /for \(const file of TODO\)/, 'the apply loop must walk TODO, not FILES');
});

test('nothing is claimed as both applied and pending', () => {
  const both = (manifest.pending || []).filter((f) => f in manifest.sealed);
  assert.deepEqual(both, [], `${both.join(', ')} is listed as pending AND sealed — one of the two is a lie`);
});

test('the seal itself says why it exists, for whoever finds it next', () => {
  assert.match(manifest._why, /no-op/i);
  assert.match(manifest._why, /ALTER/);
});

test('every ALTER is its own statement, so one failure cannot take the others with it', () => {
  for (const f of registered()) {
    const sql = read(f).replace(/--[^\n]*/g, ' ');
    for (const stmt of sql.split(';')) {
      const alters = (stmt.match(/ALTER\s+TABLE/gi) || []).length;
      assert.ok(alters <= 1,
        `${f}: ${alters} ALTERs in one statement — a duplicate-column error on the first would roll back the rest`);
    }
  }
});

test('every .sql file in the migrations folder is registered, or deliberately not', () => {
  // A migration written and never registered is the other half of the same
  // failure: the column exists in the repo, the tests that read the file pass,
  // and production never gets it.
  const onDisk = readdirSync(new URL('migrations/', import.meta.url))
    .filter((f) => f.endsWith('.sql')).sort();
  const reg = new Set(registered().map((f) => f.replace('worker/migrations/', '')));

  // These predate the host runner and are applied elsewhere. Named explicitly so
  // the list cannot quietly grow.
  const ELSEWHERE = new Set(onDisk.filter((f) => /^00(0[0-9]|1[0-2]|1[67])_/.test(f)));

  const unaccounted = onDisk.filter((f) => !reg.has(f) && !ELSEWHERE.has(f));
  assert.deepEqual(unaccounted, [],
    `these migrations exist but nothing applies them: ${unaccounted.join(', ')}`);
});
