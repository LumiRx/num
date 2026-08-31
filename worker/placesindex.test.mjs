import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MIG = new URL('./migrations/0012_places_index_diet.sql', import.meta.url);
const sql = readFileSync(MIG, 'utf8');
const learn = readFileSync(new URL('./learn.mjs', import.meta.url), 'utf8');

test('the diet drops exactly the three indexes that earned nothing', () => {
  for (const idx of ['idx_places_cell', 'idx_places_area_nc', 'idx_places_numrating']) {
    assert.ok(sql.includes(`DROP INDEX IF EXISTS ${idx};`), `${idx} is not dropped`);
  }
});

test('the diet keeps every index a query actually seeks', () => {
  for (const idx of ['idx_places_dest_cat', 'idx_places_dest_name', 'idx_places_cell_cat', 'idx_places_dest_reviews']) {
    assert.ok(!new RegExp(`DROP INDEX IF EXISTS ${idx}\\b`).test(sql), `${idx} must not be dropped`);
  }
  // idx_places_cat is dropped nowhere; console.mjs counts categories across
  // every destination and that is the only index that can serve it.
  assert.ok(!/DROP INDEX IF EXISTS idx_places_cat;/.test(sql));
});

test('the rating index comes back partial, not gone', () => {
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_places_numrating ON places\(num_rating_n\) WHERE num_rating_n > 0;/);
});

test('learn.mjs no longer hides num_rating_n from the planner', () => {
  // COALESCE on a NOT NULL DEFAULT 0 column cannot change the answer, but in a
  // WHERE clause it wraps the column and hides it from the planner — that read
  // was a full scan of every place NUM holds.
  assert.ok(!/WHERE\s+COALESCE\(num_rating_n\s*,\s*0\)/i.test(learn),
    'a filter on num_rating_n must not be wrapped in COALESCE');
  assert.ok(/WHERE num_rating_n\s*>\s*0/.test(learn), 'learn.mjs must still only read rated places');
  // SCORE_TERM keeps its COALESCE: it is a CASE expression used for ranking,
  // never a filter, so no index was ever available to it in the first place.
  assert.ok(/SCORE_TERM/.test(learn));
});

test('the index learn.mjs creates matches the one the migration leaves behind', () => {
  // ensure() runs on every cold start. If it created the full index, it would
  // silently undo the migration on the next deploy.
  assert.ok(learn.includes('ON places(num_rating_n) WHERE num_rating_n > 0'),
    'learn.mjs must create the partial index, not the full one');
  assert.ok(!/ON places\(num_rating_n\)'/.test(learn), 'the full index must not be re-created');
});

test('the migration explains itself to whoever reads it next', () => {
  // A dropped index with no reason recorded is an index somebody re-creates.
  assert.ok(sql.includes('EXPLAIN QUERY PLAN'), 'the evidence must be in the file');
  assert.ok(sql.includes('Deliberately kept'), 'what survived, and why, matters as much as what went');
});

test('migrations are numbered without collision', () => {
  const dir = readdirSync(new URL('./migrations/', import.meta.url));
  const nums = dir.filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, 4));
  assert.equal(new Set(nums).size, nums.length, `duplicate migration number in ${nums.join(', ')}`);
});
