// Memory meets the directory (worker/pickrescue.mjs), on real SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findInDirectory, unverifiedPick, seedWord, mapSearchUrl } from './pickrescue.mjs';
import { resolvePicks } from './placelink.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => ({ results: db.prepare(sql).all(...args), success: true }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true, meta: { changes: 1 } }; },
  });
  return { prepare(sql) { const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) }); return bound([]); } };
}
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, name_local TEXT, category TEXT, area TEXT, rating REAL, reviews INTEGER, phone TEXT, website TEXT, address TEXT, hours TEXT, cuisine TEXT, status TEXT, photo_url TEXT, photo_attr TEXT, photo_license TEXT, alive INTEGER, hours_mask TEXT, booking_platform TEXT, booking_ref TEXT, num_rating REAL, num_rating_n INTEGER DEFAULT 0, lat REAL, lng REAL, dest TEXT)`);
const put = (id, name, extra = {}) => db.prepare('INSERT INTO places (id, name, name_local, category, area, rating, reviews, phone, website, alive, lat, lng, dest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(id, name, extra.name_local ?? null, 'Restaurant', extra.area ?? 'Thonglor', extra.rating ?? null, extra.reviews ?? 0, extra.phone ?? '+6620000000', extra.website ?? null, extra.alive ?? null, extra.lat ?? 13.73, extra.lng ?? 100.58, extra.dest ?? 'bangkok');
put('som1', 'Somboon Seafood Bangna', { rating: 4.3, reviews: 900, lat: 13.66, lng: 100.63 });
put('som2', 'สมบูรณ์โภชนา (Somboon Seafood)', { rating: 4.5, reviews: 6000, lat: 13.735, lng: 100.58 });
put('laem', 'Laem Charoen Seafood Central Embassy', { rating: 4.4, reviews: 2000, website: 'laemcharoen.example' });
put('dead', 'Somboon Seafood Old Branch', { alive: 0 });
put('other', 'Somboon Seafood', { dest: 'chiang-mai' });
const env = { DB: d1(db) };

test('a memory pick is found in the full directory by name — the better-rated, living row in THIS destination', async () => {
  const r = await findInDirectory(env, { dest: 'bangkok', lat: 13.73, lng: 100.58, names: ['Somboon Seafood (Thonglor branch)', 'Laem Charoen Seafood', 'Jay Fai'] });
  assert.deepEqual(r.missing, ['Jay Fai']);
  const names = r.rows.map((x) => x.name);
  assert.ok(names.includes('สมบูรณ์โภชนา (Somboon Seafood)'), 'the 6000-review Somboon, not the dead branch, not Chiang Mai: ' + names.join(' | '));
  assert.ok(names.includes('Laem Charoen Seafood Central Embassy'));
  const som = r.rows.find((x) => x.name.includes('Somboon'));
  assert.ok(Number.isFinite(som.km) && som.km < 2, 'distance from the guest is on the row');
});

test('a found row goes through the same door as a block pick and comes out with a real link', async () => {
  const r = await findInDirectory(env, { dest: 'bangkok', names: ['Laem Charoen Seafood'] });
  const { picks, dropped } = resolvePicks([{ name: 'Laem Charoen Seafood', why: 'the crab' }], r.rows);
  assert.equal(dropped.length, 0);
  assert.equal(picks[0].link_kind, 'website');
  assert.equal(picks[0].why, 'the crab');
});

test('not in the directory → a flagged map search, nothing invented, never a bare name', () => {
  const p = unverifiedPick({ name: 'Jay Fai', why: 'the crab omelette' }, 'Bangkok');
  assert.equal(p.unverified, true);
  assert.equal(p.link, mapSearchUrl('Jay Fai', 'Bangkok'));
  assert.equal(p.phone, null);
  assert.equal(p.address, null);
  assert.equal(p.open_now, null);
  assert.equal(unverifiedPick({ name: '' }, 'Bangkok'), null);
});

test('the seed word skips articles and the city, and lookups are bounded', async () => {
  assert.equal(seedWord('The Raw Bar Thonglor'), 'raw');
  assert.equal(seedWord('Nahm'), 'nahm');
  assert.equal(seedWord('A'), null);
  const many = Array.from({ length: 12 }, (_, i) => `Place ${i}`);
  const r = await findInDirectory(env, { dest: 'bangkok', names: many });
  assert.equal(r.rows.length + r.missing.length, 8, 'eight lookups at most');
});
