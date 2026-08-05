// The one number a merchant makes decisions on.
//
// Until this shipped, Num could not answer "how many people did you send me?"
// — the business dashboard had nothing true to sell, promotions had no baseline,
// and the invite copy had to lean on a demand proxy instead of delivered value.
//
// The risk here is not a crash, it is a plausible wrong number. Six partners go
// to the model and it might name two; counting all six inflates every merchant
// by 3x, and nobody would ever notice from the outside. These tests exist mostly
// to keep the count honest under change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordImpressions } from './impressions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'impressions.mjs'), 'utf8');
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
const places = readFileSync(join(HERE, '..', 'ai', 'places.js'), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A DB stub that records what would have been written. */
function fakeDb() {
  const written = [];
  const stmt = { bind: (...a) => ({ __row: a }) };
  return {
    written,
    prepare: () => stmt,
    // ensure() creates the schema through the same batch(), so only rows that
    // actually came from bind() count — otherwise the CREATE statements would
    // show up as phantom impressions and every assertion here would be wrong.
    batch: async (rows) => { rows.forEach((r) => { if (r && r.__row) written.push(r.__row); }); },
  };
}
const P = (id, name) => ({ id, name });

test('a place merely CONSIDERED is not an impression', async () => {
  // The whole integrity of the number. Six candidates, one mentioned.
  const DB = fakeDb();
  await recordImpressions({ DB }, {
    partners: [P('p1', 'Baan Rim Pa'), P('p2', 'Suay Restaurant'), P('p3', 'Kan Eang At Pier')],
    reply: 'Baan Rim Pa is the one — cliffside, book the 7pm.',
  });
  assert.equal(DB.written.length, 1, 'counted places the guest was never told about — every merchant inflated');
  assert.equal(DB.written[0][0], 'p1');
});

test('the featured card outranks a passing mention', async () => {
  const DB = fakeDb();
  await recordImpressions({ DB }, {
    partners: [P('p1', 'Suay Restaurant'), P('p2', 'Baan Rim Pa')],
    reply: 'Suay Restaurant or Baan Rim Pa — both good.',
    card: { title: 'Baan Rim Pa' },
  });
  const bySurface = Object.fromEntries(DB.written.map((r) => [r[0], r[3]]));
  assert.equal(bySurface.p2, 'card', 'the card was not recorded as the strongest surface');
  assert.equal(bySurface.p1, 'named', 'a mention in the text was not recorded');
});

test('short names do not match by accident', async () => {
  // "Bar", "Deli" and "Zoo" are real listing names. Counting an impression
  // every time the word "bar" appears would make the numbers worthless in
  // exactly the categories that matter most.
  const DB = fakeDb();
  await recordImpressions({ DB }, {
    partners: [P('p1', 'Bar'), P('p2', 'Zoo')],
    reply: 'There is a great bar near the zoo, but I would skip both.',
  });
  assert.equal(DB.written.length, 0, 'a three-letter listing name matched ordinary prose');
});

test('accents and punctuation do not lose a merchant their credit', async () => {
  const DB = fakeDb();
  await recordImpressions({ DB }, {
    partners: [P('p1', 'Café Léon')],
    reply: 'Cafe Leon does the best breakfast on that street.',
  });
  assert.equal(DB.written.length, 1, '"Café Léon" did not match "Cafe Leon" — accented names would silently never count');
});

test('rows without an id are skipped, never guessed by name', async () => {
  // Pre-`id` partner rows exist. Matching those on name across cities would
  // credit the wrong business — "The Bridge" exists in most of them.
  const DB = fakeDb();
  await recordImpressions({ DB }, {
    partners: [{ name: 'Baan Rim Pa' }],
    reply: 'Baan Rim Pa is the one.',
  });
  assert.equal(DB.written.length, 0, 'an id-less row was logged — that credits a place we cannot identify');
});

test('bookkeeping never breaks the answer', async () => {
  const DB = { prepare: () => { throw new Error('d1 down'); } };
  const out = await recordImpressions({ DB }, { partners: [P('p1', 'Baan Rim Pa')], reply: 'Baan Rim Pa.' });
  assert.equal(out.logged, 0, 'a database failure escaped into the request path');
});

test('partner rows carry an id at all', () => {
  // Without this the log can only match on name, which is the fragile thing
  // this whole module exists to avoid.
  assert.match(places, /const SELECT_COLS = 'id,/,
    'places are selected without an id — impressions could only be matched by name');
});

test('recording is deferred, never awaited on the request path', () => {
  // A merchant's analytics must never be a reason a guest waits for an answer
  // that is already computed.
  assert.match(code(index), /ctx\.waitUntil\(recordImpressions\(/,
    'impressions are awaited inline — a slow write would delay the reply');
});

test('what the guest asked is truncated, not stored whole', () => {
  // Useful to a merchant ("they wanted dinner near Kata"), but a concierge
  // transcript is not something to retain at length.
  assert.match(code(src), /slice\(0, 120\)/, 'the guest request is stored untruncated');
});
