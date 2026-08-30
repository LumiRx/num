import test from 'node:test';
import assert from 'node:assert/strict';
import { geocode, geocodeSweep, geocodeReady, MIN_CONFIDENCE } from './geocode.mjs';

const ENV = { GEOAPIFY_KEY: 'k' };

const hit = (o = {}) => ({
  ok: true,
  json: async () => ({
    results: [{
      lat: 7.8965, lon: 98.2735, formatted: 'Baan Rim Pa, Kalim Beach Rd, Phuket, Thailand',
      country_code: 'th', rank: { confidence: 0.95, match_type: 'full_match' }, ...o,
    }],
  }),
});

test('not connected without a key', async () => {
  assert.equal(geocodeReady({}), false);
  const r = await geocode({}, { text: '123 Some Street, Phuket' }, () => { throw new Error('no fetch'); });
  assert.deepEqual(r, { ok: false, reason: 'not_connected' });
});

test('a name is not an address — too short never leaves the Worker', async () => {
  const r = await geocode(ENV, { text: 'Joe' }, () => { throw new Error('no fetch'); });
  assert.deepEqual(r, { ok: false, reason: 'too_vague' });
});

test('a good match returns coordinates and its confidence', async () => {
  const r = await geocode(ENV, { text: 'Baan Rim Pa, Kalim Beach Rd', country: 'TH' }, async () => hit());
  assert.equal(r.ok, true);
  assert.equal(r.lat, 7.8965);
  assert.equal(r.lng, 98.2735, 'Geoapify says lon; we say lng');
  assert.equal(r.confidence, 0.95);
});

test('country is a bias, not a filter — a wrong context must not erase a right answer', async () => {
  let sent = null;
  await geocode(ENV, { text: 'Kalim Beach Road', country: 'TH' }, async (url) => {
    sent = Object.fromEntries(new URL(url).searchParams);
    return hit();
  });
  assert.equal(sent.bias, 'countrycode:th');
  assert.equal(sent.filter, undefined, 'a filter that is wrong returns nothing at all');
  assert.equal(sent.limit, '1');
  assert.equal(sent.format, 'json');
});

// Migration 0007 states the harm: a bad coordinate lands in cell_lat/cell_lng,
// the index the concierge searches by proximity. "One bad row is one wrong
// answer to 'what is near me', which is the only question NUM exists to
// answer." A geocoder that always returns something IS that failure.
test('a vague address is refused rather than guessed at', async () => {
  const r = await geocode(ENV, { text: 'the shop near the big tree, Phuket' },
    async () => hit({ rank: { confidence: 0.31, match_type: 'inner_part' } }));
  assert.deepEqual(r, { ok: false, reason: 'low_confidence', confidence: 0.31 });
  assert.ok(0.31 < MIN_CONFIDENCE);
});

test('the confidence floor is not generous', () => {
  assert.ok(MIN_CONFIDENCE >= 0.5, 'the middle of the range is "this street, roughly"');
});

// The classic geocoder failure: a street name that also exists in Ohio.
// Country is the one piece of context we hold independently of what the owner
// typed, so a confident answer in the wrong country is still refused.
test('a confident result in the wrong country is refused anyway', async () => {
  const r = await geocode(ENV, { text: 'Beach Road', country: 'TH' },
    async () => hit({ country_code: 'us', rank: { confidence: 0.99, match_type: 'full_match' } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /wrong_country_us/);
});

test('an empty or malformed result is reported, never faked', async () => {
  assert.deepEqual(
    await geocode(ENV, { text: 'somewhere unfindable' }, async () => ({ ok: true, json: async () => ({ results: [] }) })),
    { ok: false, reason: 'no_match' },
  );
  assert.deepEqual(
    await geocode(ENV, { text: 'somewhere unfindable' }, async () => ({ ok: false, status: 401 })),
    { ok: false, reason: 'http_401' },
  );
  const nan = await geocode(ENV, { text: 'somewhere unfindable' },
    async () => hit({ lat: 'not a number' }));
  assert.deepEqual(nan, { ok: false, reason: 'no_match' });
});

// ── THE SWEEP ────────────────────────────────────────────────────────────

function fakeDb(rows) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      const st = {
        _sql: sql, _args: [],
        bind(...a) { st._args = a; return st; },
        async all() { return { results: rows }; },
        async run() { writes.push({ sql, args: st._args }); return { success: true }; },
      };
      return st;
    },
  };
}

const SUB = { id: 's1', name: 'Baan Rim Pa', address: 'Kalim Beach Rd, Patong', country: 'TH' };

test('the sweep does nothing without a key or a database', async () => {
  assert.equal((await geocodeSweep({ DB: fakeDb([]) })).ran, false);
  assert.equal((await geocodeSweep({ GEOAPIFY_KEY: 'k' })).ran, false);
});

test('a good match moves the row to geocoded and records which geocoder', async () => {
  const db = fakeDb([SUB]);
  const out = await geocodeSweep({ ...ENV, DB: db }, async () => hit());
  assert.deepEqual({ ran: out.ran, seen: out.seen, geocoded: out.geocoded }, { ran: true, seen: 1, geocoded: 1 });
  const w = db.writes[0];
  assert.match(w.sql, /status = 'geocoded'/);
  assert.match(w.sql, /WHERE id = \?1 AND status = 'new'/, 'a concurrent sweep must not double-write');
  assert.equal(w.args[1], 7.8965);
  assert.match(w.args[3], /^geoapify@0\.95$/, 'geo_source records the confidence, so a bad batch can be found');
});

test('the business name is sent with the address — it disambiguates the road', async () => {
  let sent = null;
  await geocodeSweep({ ...ENV, DB: fakeDb([SUB]) }, async (url) => {
    sent = new URL(url).searchParams.get('text');
    return hit();
  });
  assert.equal(sent, 'Baan Rim Pa, Kalim Beach Rd, Patong');
});

// A vague address gets the same answer next time and costs another credit.
// Leaving it `new` with the reason attached puts it in front of a human,
// which is the only thing that actually resolves it.
test('a refused row stays new and says why', async () => {
  const db = fakeDb([SUB]);
  const out = await geocodeSweep({ ...ENV, DB: db },
    async () => hit({ rank: { confidence: 0.2, match_type: 'inner_part' } }));
  assert.equal(out.geocoded, 0);
  assert.deepEqual(out.skipped, [{ id: 's1', reason: 'low_confidence' }]);
  const w = db.writes[0];
  assert.ok(!/status = 'geocoded'/.test(w.sql), 'a low-confidence row must not be promoted');
  assert.match(w.args[1], /low_confidence \(0\.2\)/, 'the reason and the score both belong in the note');
});

test('nothing here promotes into places — review stays human', async () => {
  const db = fakeDb([SUB]);
  await geocodeSweep({ ...ENV, DB: db }, async () => hit());
  for (const w of db.writes) {
    assert.ok(!/INSERT INTO places/i.test(w.sql), 'the sweep must never write to places');
    assert.ok(!/status = 'promoted'/.test(w.sql), 'promotion is a human decision');
  }
});

test('one bad row does not stop the batch', async () => {
  const db = fakeDb([SUB, { ...SUB, id: 's2' }, { ...SUB, id: 's3' }]);
  let n = 0;
  const out = await geocodeSweep({ ...ENV, DB: db }, async () => {
    n++;
    return n === 2 ? { ok: false, status: 500 } : hit();
  });
  assert.equal(out.geocoded, 2);
  assert.deepEqual(out.skipped, [{ id: 's2', reason: 'http_500' }]);
});
