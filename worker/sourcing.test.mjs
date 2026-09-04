// Who found this place — the lookup that makes a handoff attributable.
//
// These tests drive the module against a D1 stand-in. They assert on the row
// that comes back and on the QUERIES that were run, because two of the
// properties that matter most here are invisible in the return value: that a
// voided introduction stops attributing, and that a whole reply costs one
// query rather than one per link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributionFor, attributionsFor, _resetForTests } from './sourcing.mjs';

/**
 * D1 stand-in over a list of num_scout_places rows.
 *
 * It applies the query's own state filter rather than pre-filtering the
 * fixture, so a test can hand it a voided row and find out what the REAL
 * WHERE clause does with it — which is the only version of that test worth
 * writing.
 */
function db(rows = [], { fail = false } = {}) {
  const queries = [];
  return {
    queries,
    DB: {
      prepare(q) {
        queries.push(q.replace(/\s+/g, ' ').trim());
        const live = /state IN \('introduced','verified','activated'\)/.test(q);
        const match = (ids) => rows.filter(
          (r) => ids.includes(r.place_id) && (!live || ['introduced', 'verified', 'activated'].includes(r.state)),
        );
        return {
          bind(...ids) {
            return {
              async all() {
                if (fail) throw new Error('D1_ERROR: no such table: num_scout_places');
                return { results: match(ids) };
              },
              async first() {
                if (fail) throw new Error('D1_ERROR: no such table: num_scout_places');
                return match(ids)[0] ?? null;
              },
            };
          },
        };
      },
    },
  };
}

const place = (place_id, scout_id, state = 'activated') => ({
  place_id, scout_id, state, id: `sp_${place_id}`, scout_place_id: `sp_${place_id}`, code: 'ADAM',
});

test.beforeEach(() => _resetForTests());

/* ── the basic question ─────────────────────────────────────────────────── */

test('a place somebody introduced resolves to that scout', async () => {
  const env = db([place('hotel-1', 'sc_adam')]);
  const a = await attributionFor(env, 'hotel-1');
  assert.equal(a.scoutId, 'sc_adam');
  assert.equal(a.code, 'ADAM');
  assert.equal(a.state, 'activated');
});

test('a place nobody introduced resolves to null, not to a guess', async () => {
  const env = db([place('hotel-1', 'sc_adam')]);
  assert.equal(await attributionFor(env, 'some-osm-cafe'), null);
});

test('no DB and no place id are both null, never a throw', async () => {
  assert.equal(await attributionFor({}, 'hotel-1'), null);
  assert.equal(await attributionFor(db([]), ''), null);
  assert.equal(await attributionFor(db([]), null), null);
});

/* ── the property a scout programme lives or dies on ────────────────────── */

test('a VOIDED introduction attributes nothing', async () => {
  // A void that only changes a state column while new rows keep being written
  // with the old scout on them is a void in name only. The WHERE clause has to
  // enforce it, which is why the stand-in runs the real filter.
  const env = db([place('hotel-1', 'sc_adam', 'void')]);
  assert.equal(await attributionFor(env, 'hotel-1'), null);
});

test('a REJECTED introduction attributes nothing', async () => {
  const env = db([place('hotel-1', 'sc_adam', 'rejected')]);
  assert.equal(await attributionFor(env, 'hotel-1'), null);
});

test('introduced and verified attribute, long before anything is owed', async () => {
  // Attribution is not payment. A place still waiting on its first $5 of
  // revenue must already be attributed, or the usage that decides whether it
  // ever crosses the gate goes unrecorded.
  for (const state of ['introduced', 'verified']) {
    _resetForTests();
    const env = db([place('hotel-1', 'sc_adam', state)]);
    assert.equal((await attributionFor(env, 'hotel-1'))?.scoutId, 'sc_adam', state);
  }
});

/* ── it must never cost anybody their link ──────────────────────────────── */

test('a broken table costs the attribution, never a throw', async () => {
  const env = db([place('hotel-1', 'sc_adam')], { fail: true });
  assert.equal(await attributionFor(env, 'hotel-1'), null);
  assert.deepEqual([...(await attributionsFor(env, ['hotel-1'])).keys()], []);
});

test('a failed lookup is NOT cached', async () => {
  // A schema mid-migration should start attributing the moment it finishes.
  // Caching the failure would mean the first minute of every deploy silently
  // loses attributions that the database was about to be able to answer.
  const broken = db([place('hotel-1', 'sc_adam')], { fail: true });
  await attributionFor(broken, 'hotel-1');
  const working = db([place('hotel-1', 'sc_adam')]);
  assert.equal((await attributionFor(working, 'hotel-1'))?.scoutId, 'sc_adam');
});

/* ── cost ───────────────────────────────────────────────────────────────── */

test('a repeated place is answered from cache, not from D1', async () => {
  const env = db([place('hotel-1', 'sc_adam')]);
  await attributionFor(env, 'hotel-1');
  await attributionFor(env, 'hotel-1');
  await attributionFor(env, 'hotel-1');
  assert.equal(env.queries.length, 1, 'three asks for one place must be one query');
});

test('a MISS is cached too', async () => {
  // The miss is the common case — almost no place has a scout — so an uncached
  // miss would mean this file costs a query on nearly every link NUM hands out.
  const env = db([]);
  await attributionFor(env, 'osm-cafe');
  await attributionFor(env, 'osm-cafe');
  assert.equal(env.queries.length, 1);
});

test('a whole reply is one query, not one per link', async () => {
  const env = db([place('hotel-1', 'sc_adam'), place('hotel-2', 'sc_adam'), place('hotel-3', 'sc_sean')]);
  const map = await attributionsFor(env, ['hotel-1', 'hotel-2', 'hotel-3', 'osm-cafe']);
  assert.equal(env.queries.length, 1);
  assert.equal(map.get('hotel-1').scoutId, 'sc_adam');
  assert.equal(map.get('hotel-3').scoutId, 'sc_sean');
  assert.equal(map.get('osm-cafe'), undefined, 'a place with no scout is absent, not null-valued');
});

test('the batch answers from cache and only asks for what it is missing', async () => {
  const env = db([place('hotel-1', 'sc_adam'), place('hotel-2', 'sc_adam')]);
  await attributionFor(env, 'hotel-1');
  env.queries.length = 0;
  const map = await attributionsFor(env, ['hotel-1', 'hotel-2']);
  assert.equal(env.queries.length, 1);
  assert.equal(map.size, 2, 'the cached one must still come back in the map');
  assert.equal(map.get('hotel-1').scoutId, 'sc_adam');
});

test('a batch of only-cached places runs no query at all', async () => {
  const env = db([place('hotel-1', 'sc_adam')]);
  await attributionFor(env, 'hotel-1');
  env.queries.length = 0;
  const map = await attributionsFor(env, ['hotel-1']);
  assert.equal(env.queries.length, 0);
  assert.equal(map.get('hotel-1').scoutId, 'sc_adam');
});

test('the batch is bounded — a runaway reply cannot become a runaway query', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => place(`h${i}`, 'sc_adam'));
  const env = db(rows);
  await attributionsFor(env, rows.map((r) => r.place_id));
  const binds = (env.queries[0].match(/\?\d+/g) ?? []).length;
  assert.ok(binds <= 50, `IN list must be capped, got ${binds}`);
});

test('attributionsFor tolerates junk input without throwing', async () => {
  const env = db([]);
  assert.equal((await attributionsFor(env, null)).size, 0);
  assert.equal((await attributionsFor({}, ['a'])).size, 0);
  assert.equal((await attributionsFor(env, [null, '', undefined])).size, 0);
});
