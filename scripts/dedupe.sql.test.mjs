import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATE_WORK, DROP_WORK, MERGED, PRECISION, PROTECTED, RICHNESS,
  countSql, deleteSql, fillWorkSql, mergeSql, pairsSql, phoneExpr,
} from './dedupe.sql.mjs';

test('a claimed or rated listing can never be the row that is deleted', () => {
  const sql = pairsSql('TW');
  assert.ok(sql.includes(`r.rich < ${PROTECTED}`), 'protected rows must be excluded from deletion');
  assert.ok(RICHNESS.includes('100*(CASE WHEN business_id IS NOT NULL'), 'a claim must outweigh everything');
  assert.ok(RICHNESS.includes('100*(CASE WHEN COALESCE(num_rating_n,0) > 0'), 'a rating must outweigh everything');
  // A photo and a rating cost money to obtain; contact fields do not.
  assert.ok(RICHNESS.includes('4*(CASE WHEN photo_url IS NOT NULL'));
  assert.ok(RICHNESS.includes('4*(CASE WHEN rating IS NOT NULL'));
});

test('two shops with two different phone numbers are two shops', () => {
  // 7-Eleven has more than one branch per neighbourhood in Taipei. Position
  // and name alone would merge them; the phone number is what tells them apart.
  assert.ok(pairsSql('TW').includes("(r.ph = '' OR k.ph = '' OR r.ph = k.ph)"));
});

test('phone numbers are compared as digits, not as typed', () => {
  const e = phoneExpr('phone');
  for (const ch of [" ',''", "'-',''", "'(',''", "')',''", "'+',''"]) {
    assert.ok(e.includes(ch.trim()), `${ch} must be stripped`);
  }
  // +886 5 227 0661 and +88652270661 are the same restaurant, seen twice.
  const strip = (s) => s.replace(/[ \-()+]/g, '');
  assert.equal(strip('+886 5 227 0661'), strip('+88652270661'));
});

test('the grouping window is tight enough to mean "the same place"', () => {
  // 3 decimal places is ~110m. Wider starts merging neighbours; tighter stops
  // catching the node-and-way pair, which is the whole point.
  assert.equal(PRECISION, 3);
  assert.ok(pairsSql().includes('ROUND(lat,3)') && pairsSql().includes('ROUND(lng,3)'));
});

test('duplicates are only ever collapsed within one destination', () => {
  assert.ok(pairsSql().includes("PARTITION BY dest||'|'||nm"), 'the same name in two cities is two places');
});

test('scoping to a country is quoted, and optional', () => {
  assert.ok(pairsSql('TW').includes("WHERE country = 'TW'"));
  assert.ok(!pairsSql().includes('WHERE country'), 'no country means the whole table');
  assert.ok(pairsSql("O'Brien").includes("country = 'O''Brien'"), 'a quote must not end the string early');
});

test('nothing is deleted before what it knows is moved somewhere it survives', () => {
  const merges = mergeSql();
  assert.equal(merges.length, MERGED.length);
  for (const [i, col] of MERGED.entries()) {
    assert.ok(merges[i].startsWith(`UPDATE places SET ${col} =`));
    assert.ok(merges[i].includes(`WHERE ${col} IS NULL`), 'a value already present must never be overwritten');
    assert.ok(merges[i].includes('id IN (SELECT keep_id FROM _dedupe)'), 'only survivors are enriched');
  }
});

test('the merge never touches what the survivor earned', () => {
  // Merging is for facts about the business. A rating, a photo, a claim and a
  // booking link belong to the row that earned them and are not transferable.
  for (const col of ['rating', 'reviews', 'photo_url', 'business_id', 'status', 'num_rating']) {
    assert.ok(!MERGED.includes(col), `${col} must not be merged between rows`);
  }
});

test('the delete only ever reads from the recorded pairs', () => {
  // A DELETE that recomputes the groups could delete a row the merge step
  // never ran against. The work table is the record of what was decided.
  assert.equal(deleteSql(), 'DELETE FROM places WHERE id IN (SELECT drop_id FROM _dedupe)');
  assert.ok(!deleteSql().includes('ROW_NUMBER'), 'the delete must not re-derive the groups');
});

test('the work table cannot record a row for deletion twice', () => {
  assert.ok(CREATE_WORK.includes('drop_id TEXT NOT NULL PRIMARY KEY'));
  assert.ok(fillWorkSql('TW').startsWith('INSERT OR IGNORE INTO _dedupe (keep_id, drop_id)'));
  assert.equal(DROP_WORK, 'DROP TABLE IF EXISTS _dedupe');
  assert.equal(countSql(), 'SELECT COUNT(*) n FROM _dedupe');
});

test('a survivor is never also a casualty', () => {
  // ROW_NUMBER = 1 defines the survivor and only rn > 1 is ever collected, so
  // a chain of merges cannot delete the row another merge kept.
  const sql = pairsSql();
  assert.ok(sql.includes('keep AS (SELECT g, id, ph FROM r WHERE rn = 1)'));
  assert.ok(sql.includes('WHERE r.rn > 1'));
});

test('ordering is deterministic, so two runs choose the same survivor', () => {
  // Ties broken by id: without it the survivor would vary between runs and a
  // re-run could ping-pong data between two rows.
  assert.ok(pairsSql().includes('ORDER BY rich DESC, id'));
});
