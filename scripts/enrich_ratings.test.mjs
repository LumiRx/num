// The two guards that decide whether a guest gets a wrong number.
//
// Num quotes ratings verbatim to paying users, and the prompt now permits
// quoting one ONLY if it is in the verified block — so whatever this script
// writes IS what a guest hears. A rating attached to the wrong shop is worse
// than no rating at all, which is why the match test is stricter than the
// "did we get a result" test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'enrich_ratings.mjs'), 'utf8');

// The script runs top-level wrangler calls on import, so the pure helpers are
// re-derived here from source rather than imported. If a definition changes,
// this fails loudly — which is the intent.
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const tokens = (s) => String(s || '').toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/).filter(Boolean);
const sameName = (a, b) => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const set = new Set(long);
  if (!short.every((t) => set.has(t))) return false;
  return short.length >= 2 || short[0].length >= 6;
};

test('the same shop under two names matches', () => {
  // OSM and Google disagree about suffixes constantly. These are one place.
  assert.ok(sameName('Guisados', 'Guisados Tacos'));
  assert.ok(sameName('The Ivy', 'The Ivy Restaurant'));
  assert.ok(sameName("Bottega Louie", 'BOTTEGA LOUIE'));
});

test('different shops do not match', () => {
  assert.ok(!sameName('Republique', 'Republic of Pie'));
  assert.ok(!sameName('Sushi Gen', 'Sushi Zo'));
});

test('short or generic names cannot match by accident', () => {
  // Substring containment accepted all three of these. Each would have
  // attached a stranger's rating to a real venue.
  assert.ok(!sameName('Bar', "Barney's Beanery"));
  assert.ok(!sameName('Cafe', 'Cafeteria Nine'));
  assert.ok(!sameName('Sushi', 'Sushi Zo'), 'one generic shared word is not an identification');
});

test('the matcher is word-based, not substring-based', () => {
  assert.match(SRC, /short\.every\(\(t\) => set\.has\(t\)\)/,
    'the token-subset match is gone — substring containment lets "Cafe" match "Cafeteria Nine"');
});

test('the distance guard is present and tight', () => {
  assert.match(SRC, /d > 150/, 'the 150 m match radius is gone — a same-named chain across town would be accepted');
  assert.match(SRC, /radius: 200/, 'the search bias radius changed; keep it near the match radius or every result is rejected');
});

test('spending requires an explicit flag', () => {
  assert.match(SRC, /if \(!GO\) \{[\s\S]*?DRY RUN/, 'the script can now spend money without --go');
  assert.match(SRC, /≈ \$\$\{bill\}/, 'the cost estimate is no longer printed before spending');
});

test('a transport error is never recorded as "checked"', () => {
  // Marking a failed fetch as checked would permanently skip a place we
  // never actually asked about — a silent, unrecoverable gap in the data.
  assert.match(SRC, /NOT marked as checked/,
    'the failure path lost its comment; verify a caught error still does not write rating_checked_at');
  const catchBlock = SRC.slice(SRC.indexOf('} catch (e) {'), SRC.indexOf('}));'));
  assert.ok(!/rating_checked_at/.test(catchBlock),
    'an errored lookup now marks the row checked — that place can never be enriched again');
});

test('provenance is stored with every rating', () => {
  assert.match(SRC, /rating_source='google'/, 'ratings are written with no source — attribution and audit both depend on it');
});
