// The guessing lock on POST /api/venue/arrive.
//
// WHY THIS FILE EXISTS. A guest's check-in code is four characters — one letter
// and three digits from a deliberately readable alphabet, about 20,000
// possibilities. The venue token it is presented against is PRINTED ON A TABLE
// CARD, so it is public by design and the code is the only secret in the chain.
// A hit flips the booking to `completed` and stamps a 10% commission, so a
// scripted guesser was able to invoice a venue for dinners nobody ate.
//
// The old guard was `overLimit`, a Map inside one Worker isolate. Its own
// comment says it is not a distributed limiter, growth binds nothing that could
// give it durable state, and 14 rapid requests were measured sailing past a
// 12/minute bucket in production. So the counter had to move to D1.
//
// These are source assertions, the convention in this repo for worker.js: the
// file is 468k and cannot be imported, so the wiring is checked as text. Each
// one was verified by deleting the line it guards and watching it fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

test('the attempt counter reads D1, not an in-memory bucket', () => {
  assert.match(SRC, /async function arriveGuessing\(env, vtok, iph\)/,
    'the lock must exist as its own function');
  const fn = SRC.slice(SRC.indexOf('async function arriveGuessing'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /FROM num_venue_scans/,
    'the count must come from the table that already records every attempt');
  assert.doesNotMatch(body, /overLimit|buckets/,
    'an isolate-local Map cannot rate limit a Worker — that was the whole bug');
  assert.match(body, /COUNT\(DISTINCT detail\)/,
    'counting distinct CODES, not requests: one code retried is a mistype, not an attack');
});

test('a locked-out network is refused before the booking is looked up', () => {
  const i = SRC.indexOf('const guess = await arriveGuessing(env, vtok, iph)');
  assert.ok(i > 0, 'the lock must actually be called in venueArrive');
  const lookup = SRC.indexOf('FROM num_bookings\n      WHERE business_id = ? AND UPPER(short_code) = ?');
  assert.ok(lookup > i,
    'the check has to come FIRST — after the lookup, a blocked guesser still learns whether the code was right');

  // Ordering alone is not the guard. The refusal itself has to be there, and it
  // has to be between the call and the lookup. Written this way because an
  // ordering-only assertion passed happily with the whole branch stubbed out.
  const between = SRC.slice(i, lookup);
  assert.match(between, /if \(guess\.network\) \{/,
    'the per-network branch must be what stands between the counter and the lookup');
  assert.match(between, /error: "slow_down" \}, 429\)/,
    'and it must actually refuse — 429, not a log line and a shrug');
  assert.match(between, /outcome: "guess_locked"/,
    'a refusal nobody records is a refusal nobody can investigate');
});

test('an unknown venue token never reaches the counter', () => {
  const venueMiss = SRC.indexOf('return J({ ok: false, error: "unknown_venue" }, 404)');
  const lock = SRC.indexOf('const guess = await arriveGuessing(env, vtok, iph)');
  assert.ok(venueMiss < lock,
    'a garbage token must cost one cheap read, not a scan-table aggregate');
});

test('the venue-wide brake stops the billing, not the desk', () => {
  const i = SRC.indexOf('if (guess.venue) {');
  assert.ok(i > 0, 'the distributed case must be handled separately from the per-network one');
  const block = SRC.slice(i, i + 700);
  // A lockout would hand anyone a way to shut a venue's check-in desk by
  // guessing at it. So the guest is still welcomed; only the money stops.
  assert.match(block, /perk: venue\.perk_text/,
    'the walk-in welcome must still render — a lockout would be a denial of service on the venue');
  assert.match(block, /outcome: "guess_brake"/, 'and it must be recorded');
  const update = SRC.indexOf("SET status='completed', completed_at=?, commission_cs=?");
  assert.ok(i < update,
    'the brake must sit BEFORE the row that completes the booking and stamps the commission');
});

test('both thresholds are stated as named numbers, per hour', () => {
  assert.match(SRC, /const ARRIVE_MISSES_PER_NETWORK = \d+;/);
  assert.match(SRC, /const ARRIVE_MISSES_PER_VENUE = \d+;/);
  const net = Number(SRC.match(/ARRIVE_MISSES_PER_NETWORK = (\d+)/)[1]);
  const ven = Number(SRC.match(/ARRIVE_MISSES_PER_VENUE = (\d+)/)[1]);
  assert.ok(net < ven, 'one network must be stopped sooner than a whole venue is braked');
  // 20,000 candidates at these rates is years, not minutes. If somebody raises
  // these numbers, this is the line that asks them to do the division first.
  assert.ok(ven <= 100, 'above ~100 misses an hour the lock stops being a lock');
});

test('the payment destination is an owner decision, not a manager one', () => {
  const i = SRC.indexOf('async function qrIdentitySet');
  assert.ok(i > 0);
  const fn = SRC.slice(i, i + 1400);
  assert.match(fn, /QR\.can\(who\.role, "settings"\)/,
    'setting where every guest payment lands must need `settings` (owner only)');
  assert.doesNotMatch(fn, /QR\.can\(who\.role, "stickers"\)/,
    'managers hold `stickers` so they can print table cards — that must not also move the money');
});

test('the console key is never carried off the offers page as a Referer', () => {
  // /biz/* URLs carry ?k=<console key>. /tonight/ is same-origin, so a plain
  // rel="noopener" still sends the full URL — key included — and the analytics
  // handler persists referrers into num_web_events.
  const links = SRC.match(/<a href="\/tonight\/"[^>]*>/g) || [];
  assert.ok(links.length > 0, 'the link should still be there');
  for (const a of links) {
    assert.match(a, /noreferrer/,
      'a same-origin link from a key-bearing page must be noreferrer: ' + a);
  }
});
