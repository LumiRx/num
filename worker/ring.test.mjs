/**
 * The ring query RUNS (19 Sep 2026). Every other test of nearbyPlaces stubs
 * D1 and never executes the SQL, which is how a correlated subquery on
 * `places.id` in the ORDER BY of a derived table shipped and threw on every
 * ask for 27 hours. This one builds the tables on real SQLite and asks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { nearbyPlaces } from '../ai/places.js';
import { WEIGHTS } from './editorial.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => ({ results: /^\s*(SELECT|PRAGMA|WITH)/i.test(sql) ? db.prepare(sql).all(...args) : (db.prepare(sql).run(...args), []), success: true }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; },
  });
  return { prepare(sql) { const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) }); return bound([]); }, batch: async (s) => Promise.all(s.map((x) => x.run())) };
}

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE places (
  id TEXT PRIMARY KEY, name TEXT, name_local TEXT, category TEXT, lat REAL, lng REAL, cell_lat INTEGER, cell_lng INTEGER, dest TEXT, area TEXT,
  phone TEXT, website TEXT, address TEXT, hours TEXT, cuisine TEXT, rating REAL, reviews INTEGER DEFAULT 0, status TEXT, photo_url TEXT, photo_attr TEXT,
  photo_license TEXT, alive INTEGER, hours_mask TEXT, booking_platform TEXT, booking_ref TEXT, num_rating REAL, num_rating_n INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE num_editorial (id TEXT PRIMARY KEY, place_id TEXT, weight REAL, source TEXT, awarded_on TEXT)`);
db.exec(`CREATE TABLE num_place_impressions (member_id TEXT, place_id TEXT, ts TEXT)`);
const put = (id, name, lat, lng, extra = {}) => db.prepare(
  `INSERT INTO places (id, name, category, lat, lng, cell_lat, cell_lng, dest, area, phone, website, rating, reviews, alive)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
).run(id, name, extra.category ?? 'Seafood Restaurant', lat, lng, Math.floor(lat * 10), Math.floor(lng * 10), 'bangkok', extra.area ?? 'Thonglor', '+6620000000', extra.website ?? 'x.example', extra.rating ?? null, extra.reviews ?? 0, extra.alive ?? null);
// Thonglor, a few hundred metres apart.
put('sea1', 'Laem Charoen Seafood', 13.7310, 100.5820, { rating: 4.4, reviews: 900 });
put('sea2', 'Somboon Seafood', 13.7330, 100.5790, { rating: 4.5, reviews: 3000 });
put('sea3', 'Shut Fish', 13.7320, 100.5800, { rating: 4.9, reviews: 100 });
put('sea4', 'Savoey Thonglor', 13.7300, 100.5830, { rating: 4.2, reviews: 400 });
put('cafe', 'Roots Coffee', 13.7325, 100.5805, { category: 'Café', rating: 4.6 });
// A critic's closure notice on Shut Fish: the filter, not a penalty.
db.prepare("INSERT INTO num_editorial VALUES ('e1','sea3',?, 'Bangkok Post', '2026-09-01')").run(WEIGHTS.closed);
const env = { DB: d1(db) };
const LOC = { dest: { slug: 'bangkok', name: 'Bangkok', country: 'TH', tz: 'Asia/Bangkok', lat: 13.7563, lng: 100.5018 }, lat: 13.7322, lng: 100.5801, label: 'Thonglor', precise: true, source: 'named_area' };

test('the ring returns the seafood places around the guest, ranked, the critic-closed one filtered — and no error', async () => {
  const r = await nearbyPlaces(env, LOC, 'seafood dinner near Thonglor tonight', 6);
  assert.equal(r.error, null, r.error ?? '');
  const names = r.rows.map((x) => x.name);
  assert.ok(names.includes('Somboon Seafood') && names.includes('Laem Charoen Seafood'), names.join(', '));
  assert.ok(!names.includes('Shut Fish'), 'a sourced closure is filtered, not ranked down');
  assert.ok(!names.includes('Roots Coffee'), 'with three seafood rows in the ring, a café is not padded in');
  assert.equal(r.widened, false, 'rows came from the ring, not the destination-wide floor');
  assert.ok(Number.isFinite(r.rows[0].km), 'distance is on the row');
});

test('when the ring throws, the floor still answers from the whole destination and the error is kept', async () => {
  const bad = { DB: { prepare(sql) { const bound = (args) => ({ bind: (...m) => bound([...args, ...m]), all: async () => { if (/cell_lat BETWEEN/.test(sql)) throw new Error('D1_ERROR: no such column: places.id'); return d1(db).prepare(sql).bind(...args).all(); } }); return bound([]); } } };
  const r = await nearbyPlaces(bad, LOC, 'seafood dinner', 6);
  assert.match(String(r.error), /places\.id/);
  assert.equal(r.widened, true);
  assert.ok(r.rows.length >= 2, 'the floor fired');
});
