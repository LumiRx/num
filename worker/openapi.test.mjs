// The open-business and bookings API.
//
// The single most important property under test: nothing in this surface can
// be honestly read as "Num booked a table". Everything else is detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleOpen, handleBookLink, handlePlatforms } from './openapi.mjs';
import { parseHours, toHex } from './hours.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ALWAYS = toHex(parseHours('24/7'));
const NINE_TO_FIVE = toHex(parseHours('Mo-Su 09:00-17:00'));

/** Minimal D1 stand-in: returns whatever the test queued, in order. */
const db = (rows, tz = 'America/Los_Angeles') => ({
  prepare(q) {
    return {
      bind: () => this.prepare(q),
      first: async () => (/FROM destinations/.test(q) ? { tz } : rows[0] ?? null),
      all: async () => ({ results: rows }),
    };
  },
});
const get = (qs) => new Request(`https://app.itsnum.com/api/open?${qs}`);
const post = (body) => new Request('https://app.itsnum.com/api/book/link', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('dest is required rather than silently defaulted', async () => {
  const r = await handleOpen(get(''), { DB: db([]) });
  assert.equal(r.status, 400, 'a missing destination returned data for somewhere — which somewhere?');
});

test('open=now returns only verified-open venues', async () => {
  const rows = [
    { id: '1', name: 'Always', hours_mask: ALWAYS, dest: 'los-angeles' },
    { id: '2', name: 'Daytime', hours_mask: NINE_TO_FIVE, dest: 'los-angeles' },
    { id: '3', name: 'Unchecked', dest: 'los-angeles' },
  ];
  const j = await (await handleOpen(get('dest=los-angeles&open=now'), { DB: db(rows) })).json();
  const names = j.places.map((p) => p.name);
  assert.ok(names.includes('Always'));
  assert.ok(!names.includes('Unchecked'),
    'a venue with no verified hours was returned as open — that is a locked door with our name on it');
});

test('the thin-coverage warning ships with the response', async () => {
  // Without this a partner reads a 3-item list as "Los Angeles is shut".
  const j = await (await handleOpen(get('dest=los-angeles&open=now'), { DB: db([]) })).json();
  assert.match(j.coverage_note, /not because they are shut/);
});

test('open_now keeps three states in the payload', async () => {
  const rows = [{ id: '3', name: 'Unchecked', dest: 'los-angeles' }];
  const j = await (await handleOpen(get('dest=los-angeles'), { DB: db(rows) })).json();
  assert.equal(j.places[0].open_now, null, 'unknown hours were flattened into a boolean');
  assert.match(j.coverage_note, /null means Num has not verified/);
});

test('open-now is refused rather than computed in the wrong timezone', async () => {
  const r = await handleOpen(get('dest=nowhere&open=now'), { DB: db([{ id: '1' }], null) });
  assert.equal(r.status, 422, 'UTC was applied to a destination with no timezone on record');
});

test('closed-down businesses are excluded in the query itself', () => {
  const src = readFileSync(join(HERE, 'openapi.mjs'), 'utf8');
  assert.match(src, /\(alive IS NULL OR alive = 1\)/);
  assert.match(src, /Unknown \(never checked\) stays in/,
    'the reason NULL must remain eligible is gone — someone will tighten this to alive = 1 and empty the directory');
});

test('a booking link is never a booking', async () => {
  const row = { id: '9', name: 'Bestia', dest: 'los-angeles', booking_platform: 'resy', booking_ref: 'bestia' };
  const j = await (await handleBookLink(post({ place_id: '9', party: 4, date: '2026-08-12', time: '19:30' }), { DB: db([row]) })).json();
  assert.equal(j.bookable, true);
  assert.equal(j.booked, false, 'the response could be read as a confirmation');
  assert.equal(j.mode, 'deeplink');
  assert.match(j.disclosure, /has not held a table/);
  assert.match(j.url, /seats=4/, 'the party size was dropped — the guest re-enters it');
});

test('an unbookable venue gets an honest refusal and a phone number', async () => {
  const row = { id: '9', name: 'Walk-ins Only', dest: 'los-angeles', phone: '+1 213 555 0111' };
  const r = await handleBookLink(post({ place_id: '9' }), { DB: db([row]) });
  const j = await r.json();
  assert.equal(r.status, 200, 'an unbookable venue read as an error — callers will show a failure state');
  assert.equal(j.bookable, false);
  assert.equal(j.phone, '+1 213 555 0111', 'the fallback that actually works was withheld');
});

test('the platform list admits nothing books by API yet', async () => {
  const j = await handlePlatforms().json();
  assert.ok(j.platforms.length >= 8);
  assert.ok(j.platforms.every((p) => p.mode === 'deeplink'));
  assert.match(j.note, /No platform is "api" yet/);
});

test('no endpoint here takes money or personal data', () => {
  const src = readFileSync(join(HERE, 'openapi.mjs'), 'utf8');
  for (const forbidden of [/\bstripe\b/i, /\bcard\b/i, /\bemail\b/i, /\bpayment\b/i, /body\?\.name\b/]) {
    assert.ok(!forbidden.test(src.replace(/^\s*\*.*$/gm, '')),
      `the open API grew a ${forbidden} surface — this endpoint is unauthenticated`);
  }
});

test('the booking routes are reachable, not shadowed by /api/book', () => {
  // Found in the 11 Aug revenue audit: `/api/book/link` and
  // `/api/book/platforms` were registered BELOW `startsWith('/api/book')`,
  // which dispatches to bookdesk. Both 404'd in production from the moment
  // they shipped. Prefix routing kills new siblings silently — nothing errors,
  // the route is simply never reached.
  const src = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  const link = src.indexOf("'/api/book/link'");
  const platforms = src.indexOf("'/api/book/platforms'");
  const prefix = src.indexOf("startsWith('/api/book')");
  assert.ok(link > 0 && platforms > 0 && prefix > 0, 'a booking route vanished from the worker');
  assert.ok(link < prefix, '/api/book/link is shadowed by the /api/book prefix again');
  assert.ok(platforms < prefix, '/api/book/platforms is shadowed by the /api/book prefix again');
});
