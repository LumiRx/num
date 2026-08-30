import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventsReady, covers, REAL_COVERAGE, geohash, tmTime, wantsEvents, shape, search, eventsBlock, blockFor,
} from './events.tm.mjs';

const ENV = { TICKETMASTER_API_KEY: 'k' };

test('not connected without a key', async () => {
  assert.equal(eventsReady({}), false);
  const r = await search({}, { lat: 1, lng: 1 }, () => { throw new Error('should not fetch'); });
  assert.deepEqual(r, { ok: false, reason: 'not_connected' });
});

// Verified against the live API on 30 Aug 2026 — these exact geohashes were
// sent to Ticketmaster and returned 18 events for Edinburgh and 184 for LA.
// If this drifts, the geoPoint search silently starts looking somewhere else.
test('geohash matches what the live API accepted', () => {
  assert.equal(geohash(55.9533, -3.1883), 'gcvwr3y', 'Edinburgh');
  assert.equal(geohash(34.0522, -118.2437), '9q5ctr1', 'Los Angeles');
  assert.equal(geohash(7.8804, 98.3923), 'w1muyfx', 'Phuket');
});

test('geohash precision is a prefix relationship', () => {
  const full = geohash(55.9533, -3.1883, 9);
  assert.ok(full.startsWith(geohash(55.9533, -3.1883, 5)));
});

test('timestamps carry no milliseconds — Discovery rejects them', () => {
  const t = tmTime('2026-08-30T12:34:56.789Z');
  assert.equal(t, '2026-08-30T12:34:56Z');
  assert.ok(!/\./.test(t));
});

// THE COVERAGE TRAP. Their docs list Thailand under "Supported Country Codes",
// which reads like coverage. Measured 30 Aug 2026: TH returns 0 events,
// Bangkok 0, Phuket 0, while Edinburgh returns 327 and Los Angeles 1,693.
// The supported list is where tickets COULD be sold, not where they are.
test('Thailand is documented as supported and is not actually covered', () => {
  assert.equal(covers('TH'), false, 'TH must not be treated as covered — it returns zero events');
  assert.equal(covers('GB'), true);
  assert.equal(covers('US'), true);
  assert.ok(!REAL_COVERAGE.includes('TH'));
});

test('an uncovered country is reported as such, and never searched', async () => {
  const r = await search(ENV, { lat: 7.88, lng: 98.39, country: 'TH' }, () => { throw new Error('should not fetch'); });
  assert.deepEqual(r, { ok: false, reason: 'no_coverage', country: 'TH' });
});

// Saying "nothing is on tonight" in Phuket would be a claim about Phuket when
// it is only a fact about Ticketmaster. Silence is the honest output.
test('an uncovered country produces silence, not an empty-city claim', async () => {
  const block = await blockFor(ENV, { lat: 7.88, lng: 98.39, country_code: 'TH' }, "what's on tonight");
  assert.equal(block, '');
});

test('no coordinates means no search', async () => {
  const r = await search(ENV, { lat: NaN, lng: 1 }, () => { throw new Error('should not fetch'); });
  assert.deepEqual(r, { ok: false, reason: 'no_coordinates' });
});

test('the gate catches asking what is on', () => {
  for (const q of [
    "what's on in phuket tonight? any events or live music",
    'whats on this weekend',
    'any events tomorrow',
    'is there live music near us',
    'any good gigs on',
    'we want to see a show',
    'comedy night anywhere',
    'tickets for this weekend',
    'any concerts this week',
  ]) assert.ok(wantsEvents(q), `missed: ${q}`);
});

// "tonight" on its own is mostly about dinner. A false positive here costs
// every user a network round trip on a turn that never wanted one.
test('the gate ignores the many other things people ask at night', () => {
  for (const q of [
    'where should we eat tonight',
    'book me a table tonight',
    'a car to the airport tonight',
    'something for kids to do tonight 8yrs',
    'is anywhere open tonight',
    'thanks',
    'hire a car',
  ]) assert.equal(wantsEvents(q), false, `false positive: ${q}`);
});

const RAW = {
  id: 'G5v', name: 'John Young',
  url: 'https://www.ticketmaster.co.uk/event/G5v',
  dates: { start: { localDate: '2026-08-30', localTime: '20:00:00', dateTBD: false, dateTBA: false, timeTBA: false } },
  classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' } }],
  priceRanges: [{ min: 22.5, max: 40, currency: 'GBP' }],
  _embedded: { venues: [{ name: 'Backstage at The Green Hotel' }] },
};

test('shape keeps what a concierge would say out loud', () => {
  const e = shape(RAW);
  assert.equal(e.name, 'John Young');
  assert.equal(e.venue, 'Backstage at The Green Hotel');
  assert.equal(e.date, '2026-08-30');
  assert.equal(e.time, '20:00:00');
  assert.equal(e.genre, 'Rock', 'genre is more useful than segment when both exist');
  assert.equal(e.from, 22.5);
  assert.equal(e.currency, 'GBP');
});

// Both of these came back from the real API in the first two records fetched.
test('the real oddities in their data are handled', () => {
  const undef = shape({ ...RAW, classifications: [{ segment: { name: 'Undefined' }, family: false }] });
  assert.equal(undef.genre, null, '"Undefined" is not a genre and must not be printed');

  const noPrice = shape({ ...RAW, priceRanges: null });
  assert.equal(noPrice.from, null, 'priceRanges is frequently null and must not throw');
});

// A concierge who fills an unset time with a plausible 20:00 has invented the
// single fact the traveller will plan their evening around.
test('a TBA time is null rather than guessed', () => {
  const tba = shape({ ...RAW, dates: { start: { localDate: '2026-09-01', localTime: '19:00:00', timeTBA: true } } });
  assert.equal(tba.time, null);
  assert.equal(tba.date, '2026-09-01');

  const tbd = shape({ ...RAW, dates: { start: { localDate: '2026-09-01', dateTBD: true } } });
  assert.equal(tbd.date, null);
});

const fakeFetch = (events, total = null) => async (url) => {
  const u = new URL(url);
  fakeFetch.last = Object.fromEntries(u.searchParams);
  return { ok: true, json: async () => ({ _embedded: { events }, page: { totalElements: total ?? events.length } }) };
};

test('a real search sends a geohash and a bounded date window', async () => {
  const f = fakeFetch([RAW]);
  const r = await search(ENV, { lat: 55.9533, lng: -3.1883, country: 'GB', days: 7 }, f);
  assert.equal(r.ok, true);
  assert.equal(r.events[0].name, 'John Young');
  assert.equal(fakeFetch.last.geoPoint, 'gcvwr3y');
  assert.equal(fakeFetch.last.sort, 'date,asc');
  assert.ok(!/\./.test(fakeFetch.last.startDateTime), 'milliseconds would be rejected');
  const span = new Date(fakeFetch.last.endDateTime) - new Date(fakeFetch.last.startDateTime);
  assert.ok(Math.abs(span - 7 * 86400000) < 60000, 'the window must be the days asked for');
});

test('size is capped so a search cannot flood the prompt', async () => {
  const f = fakeFetch([]);
  await search(ENV, { lat: 1, lng: 1, size: 500 }, f);
  assert.equal(fakeFetch.last.size, '20');
});

test('a broken Ticketmaster costs a block, never a reply', async () => {
  assert.equal(await blockFor(ENV, { lat: 55.95, lng: -3.18, country_code: 'GB' }, "what's on",
    async () => ({ ok: false, status: 429 })), '');
  assert.equal(await blockFor(ENV, { lat: 55.95, lng: -3.18, country_code: 'GB' }, "what's on",
    async () => { throw new Error('ECONNRESET'); }), '');
  assert.equal(await blockFor(ENV, { lat: 55.95, lng: -3.18, country_code: 'GB' }, "what's on",
    async () => ({ ok: true, json: async () => ({ nonsense: true }) })), '');
});

test('the prompt block states the facts AND forbids the booking', () => {
  const block = eventsBlock({ ok: true, events: [shape(RAW)] });
  assert.match(block, /John Young/);
  assert.match(block, /2026-08-30 20:00/);
  assert.match(block, /GBP22\.5/);
  assert.match(block, /CANNOT book/i);
  assert.match(block, /never invent one/i);
  // Discovery is ticketed events only. Without this the model implies a city
  // with no listings has nothing happening, which is rarely true anywhere.
  assert.match(block, /not the whole city/i);
});

test('a TBC time reaches the prompt as TBC', () => {
  const block = eventsBlock({ ok: true, events: [shape({ ...RAW, dates: { start: { localDate: '2026-09-01', timeTBA: true } } })] });
  assert.match(block, /time TBC/);
});

test('no events means no block', () => {
  assert.equal(eventsBlock({ ok: true, events: [] }), '');
  assert.equal(eventsBlock({ ok: false, reason: 'http_500' }), '');
  assert.equal(eventsBlock(null), '');
});
