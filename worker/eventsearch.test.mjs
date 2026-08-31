import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchEvents, formatSearchedEvents } from './eventsearch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

function db() {
  const cache = new Map();
  return {
    cache,
    DB: {
      prepare(q) {
        const go = async (a) => {
          if (/INSERT OR REPLACE INTO num_event_search_cache/.test(q)) {
            cache.set(a[0], { payload: a[1], source: a[2], fetched_at: a[3] });
            return {};
          }
          if (/FROM num_event_search_cache/.test(q)) return cache.get(a[0]) ?? null;
          return {};
        };
        return {
          bind: (...a) => ({ first: async () => go(a), run: async () => go(a), all: async () => ({ results: [] }) }),
          run: async () => ({}), first: async () => null, all: async () => ({ results: [] }),
        };
      },
    },
  };
}

const TM = { id: 'e1', name: 'Full Moon Party', date: '2026-09-05', time: '21:00', venue: 'Haad Rin', genre: 'Music', from: 500, currency: 'THB', url: 'https://x' };

test('search is a FALLBACK — it never runs when we hold our own events', () => {
  // Curated rows are verified and grounded against places we hold; search
  // results are a third party's index. The order is the whole safety property.
  const g = src('grounding.mjs');
  assert.match(g, /wantsEvents\(userText\) && !\(events \?\? \[\]\)\.length/,
    'the live search no longer waits for our own list to be empty');
});

test('a searched event is labelled, never merged with verified ones', () => {
  const block = formatSearchedEvents({ events: [TM], source: 'ticketmaster' });
  assert.match(block, /NOT verified by Num/);
  assert.match(block, /source: Ticketmaster/);
  assert.match(block, /suggest the guest confirms/i);
  assert.match(block, /Full Moon Party/);
  // Two levels of confidence must not share a heading.
  assert.doesNotMatch(block, /LIVE CITY EVENTS/);
  const idx = src('index.mjs');
  assert.match(idx, /formatEvents\(grounding\.events.*formatSearchedEvents\(grounding\.searchedEvents\)/s,
    'the two event blocks are no longer kept separate');
});

test('nothing found renders nothing at all', () => {
  assert.equal(formatSearchedEvents(null), '');
  assert.equal(formatSearchedEvents({ events: [] }), '');
});

test('a TBA date is never printed as a real one', () => {
  // events.tm.shape() already nulls dateTBA/TBD; this block must not invent a
  // placeholder to fill the gap. People book flights around festival dates.
  const block = formatSearchedEvents({ events: [{ name: 'Mystery Fest', date: null, time: null, venue: 'TBC' }], source: 'ticketmaster' });
  assert.match(block, /Mystery Fest/);
  assert.doesNotMatch(block, /on null|at null|undefined/);
});

test('results are cached per destination so twenty guests are one call', async () => {
  const d = db();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ _embedded: { events: [{ id: 'e1', name: 'Full Moon Party', dates: { start: { localDate: '2026-09-05' } } }] }, page: { totalElements: 1 } }) };
  };
  const env = { ...d, TICKETMASTER_API_KEY: 'k' };
  const a = await searchEvents(env, { dest: 'phuket', lat: 7.9, lng: 98.3, country: 'TH', fetchImpl });
  const b = await searchEvents(env, { dest: 'phuket', lat: 7.9, lng: 98.3, country: 'TH', fetchImpl });
  assert.ok(calls <= 1, `the same destination was searched ${calls} times in one window`);
  assert.equal(b?.cached ?? (a === null), true, 'the second ask did not come from cache');
});

test('a destination with no coverage is not re-queried on every ask', async () => {
  // Otherwise a city outside Ticketmaster's footprint hammers the API forever.
  const d = db();
  let calls = 0;
  const env = { ...d, TICKETMASTER_API_KEY: 'k' };
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ _embedded: {}, page: { totalElements: 0 } }) }; };
  await searchEvents(env, { dest: 'nowhere', lat: 1, lng: 1, country: 'TH', fetchImpl });
  await searchEvents(env, { dest: 'nowhere', lat: 1, lng: 1, country: 'TH', fetchImpl });
  assert.ok(calls <= 1, `an empty result re-queried ${calls} times`);
});

test('no key means silence, not an error', async () => {
  const d = db();
  assert.equal(await searchEvents({ ...d }, { dest: 'phuket', lat: 1, lng: 1 }), null);
});

test('a provider failure never costs the guest their answer', async () => {
  const d = db();
  const env = { ...d, TICKETMASTER_API_KEY: 'k' };
  const fetchImpl = async () => { throw new Error('network down'); };
  assert.equal(await searchEvents(env, { dest: 'phuket', lat: 1, lng: 1, country: 'TH', fetchImpl }), null);
});
