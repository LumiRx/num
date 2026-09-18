// The rebuild has to be narrowed correctly, or it is worse than not running.
//
// rank_top_places.sql is one DELETE plus one INSERT over the whole `places`
// table — 2,715,566 rows as of 18 Sep 2026. D1 answered it with:
//
//     ✘ [ERROR] D1 DB exceeded its CPU time limit and was reset.
//
// rank_top_places.mjs runs the same SQL once per destination instead. That
// only works if BOTH narrowings land. Each has a distinct failure, and
// neither announces itself:
//
//   · the DELETE must be scoped, or rebuilding Dubai empties all 77
//     destinations and the concierge has nothing to recommend anywhere;
//   · the candidate scan must be scoped, or every destination re-scans all
//     2.7m rows and the CPU limit is hit again, having changed nothing.
//
// The script throws if either replacement misses. These tests prove the
// replacements match the SQL as it stands today, so a reworded WHERE clause
// fails here rather than in production.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(new URL('./rank_top_places.sql', import.meta.url), 'utf8');
const { sqlFor } = await import('./rank_top_places.mjs');

describe('per-destination rebuild', () => {
  test('the DELETE is scoped to one destination', () => {
    const out = sqlFor('dubai');
    assert.ok(!/DELETE FROM top_places;/.test(out), 'the unscoped DELETE would wipe every destination');
    assert.match(out, /DELETE FROM top_places WHERE dest = 'dubai';/);
  });

  test('the candidate scan is scoped, so the window function sees one destination', () => {
    const out = sqlFor('dubai');
    assert.match(out, /WHERE p\.dest = 'dubai'/);
    // and the original conditions survive
    assert.match(out, /AND p\.name IS NOT NULL AND p\.name <> ''/);
    assert.match(out, /p\.lat IS NOT NULL AND p\.lng IS NOT NULL/);
  });

  test('it still produces the same shape of statement', () => {
    const out = sqlFor('dubai');
    assert.match(out, /INSERT INTO top_places/);
    assert.match(out, /ROW_NUMBER\(\) OVER \(/);
    assert.match(out, /WHERE rank <= 30;/);
  });

  test('a destination name with an apostrophe cannot break out of the literal', () => {
    // No such slug today, but a script that builds SQL by string replacement
    // gets this right on day one or never.
    const out = sqlFor("cote d'azur");
    assert.match(out, /WHERE dest = 'cote d''azur'/);
    assert.ok(!/dest = 'cote d'azur'/.test(out));
  });

  test('it refuses rather than silently under-scoping', () => {
    // If someone rewords the SQL, the script must stop, not quietly run a
    // statement that deletes everything or scans everything.
    assert.throws(() => sqlFor('dubai', 'SELECT 1;'), /no longer starts with the full DELETE/);
    assert.throws(
      () => sqlFor('dubai', 'DELETE FROM top_places;\nSELECT 1;'),
      /candidate WHERE clause moved/,
    );
  });

  test('the source SQL still has the two anchors the script edits', () => {
    assert.ok(SQL.includes('DELETE FROM top_places;'));
    assert.ok(SQL.includes("  WHERE p.name IS NOT NULL AND p.name <> ''"));
  });
});
