// Tagging must not rewrite the link it is tagging.
//
// ── THE BUG THIS LOCKS SHUT ──────────────────────────────────────────────
//
// `tagged()` used to append its parameter with `u.searchParams.set()` and then
// return `u.toString()`. That does not append — it re-serialises the WHOLE
// query string through the URLSearchParams encoder:
//
//   in   https://m.uber.com/ul/?…&dropoff[formatted_address]=Kata%20Beach
//   out  https://m.uber.com/ul/?…&dropoff%5Bformatted_address%5D=Kata+Beach
//
// Brackets percent-encoded, %20 collapsed to '+'. Legal URL encodings, and a
// general-purpose server decodes both the same way. These are not general-
// purpose servers: they are deep links handed to native apps — Uber's /ul/
// universal link, Grab, Bolt, the airline booking engines — and their parsers
// are hand-rolled.
//
// What makes it worth its own file is WHEN it would have fired. Re-encoding
// only happens on the tagging path, so with NUM_AFFILIATES unset nothing was
// wrong. The day the first affiliate ID landed — most likely a wildcard rule,
// which matches everything — every provider deep link in the product would
// have changed shape at once, weeks after the code that did it was written,
// presenting as "the affiliate programme broke our links".
//
// It was found by pointing scripts/affiliate-dryrun.mjs at a table for the
// first time, which is the entire argument for having a dry-run.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tagged, tag } from './affiliate.mjs';

const env = { NUM_AFFILIATES: JSON.stringify({ '*': { ref: 'num', param: 'ref' } }) };

describe('tagging preserves the link byte for byte', () => {
  test('square brackets and %20 survive untouched', () => {
    const url =
      'https://m.uber.com/ul/?action=setPickup&pickup=my_location' +
      '&dropoff[formatted_address]=Kata%20Beach&dropoff[latitude]=7.82';
    const out = tag(url, env);
    assert.equal(out, `${url}&ref=num`);
    assert.ok(out.includes('dropoff[formatted_address]'), 'brackets were percent-encoded');
    assert.ok(out.includes('Kata%20Beach'), '%20 was rewritten as +');
    assert.ok(!out.includes('+'), 'a space became a plus');
  });

  test('the original is a strict prefix of the tagged URL', () => {
    // The strongest form of the promise: nothing before the tag can differ.
    for (const url of [
      'https://www.opentable.com/s?term=thai&covers=2',
      'https://food.grab.com/th/en/restaurants?search=pad%20thai',
      'https://www.skyscanner.net/transport/flights/hkt/bkk/260901/',
      'https://www.booking.com/searchresults.html?ss=Phuket&checkin=2026-09-01',
    ]) {
      const out = tag(url, env);
      assert.ok(out.startsWith(url), `not a prefix: ${url} → ${out}`);
    }
  });

  test('a fragment stays at the end where it belongs', () => {
    const out = tag('https://example.com/x?a=1#deals', env);
    assert.equal(out, 'https://example.com/x?a=1&ref=num#deals');
  });

  test('a fragment on a URL with no query still gets a "?"', () => {
    assert.equal(tag('https://example.com/x#deals', env), 'https://example.com/x?ref=num#deals');
  });

  test('no query string means the separator is "?", not "&"', () => {
    assert.equal(tag('https://example.com/x', env), 'https://example.com/x?ref=num');
  });

  test('a trailing "?" or "&" does not produce an empty pair', () => {
    assert.equal(tag('https://example.com/x?', env), 'https://example.com/x?ref=num');
    assert.equal(tag('https://example.com/x?a=1&', env), 'https://example.com/x?a=1&ref=num');
  });

  test('the tagged URL is still a valid URL that round-trips its parameters', () => {
    const out = tag('https://example.com/x?a=1&b=two%20words', env);
    const u = new URL(out);
    assert.equal(u.searchParams.get('ref'), 'num');
    assert.equal(u.searchParams.get('b'), 'two words');
  });

  test('ref and subparam values are escaped, not injected', () => {
    // An affiliate ID is typed by hand into a secret. One with an '&' in it
    // must not be able to invent a second parameter on somebody's booking URL.
    const hostile = { NUM_AFFILIATES: JSON.stringify({ '*': { ref: 'a&b=c', param: 'r e f', subparam: 's&x' } }) };
    const out = tagged('https://example.com/x', hostile, { extra: 'p&q' });
    const u = new URL(out.url);
    assert.equal(u.searchParams.get('r e f'), 'a&b=c');
    assert.equal(u.searchParams.get('s&x'), 'p&q');
    assert.equal(u.searchParams.get('b'), null, 'the ref smuggled in a parameter of its own');
  });

  test('the subparam is truncated and never carries the guest', () => {
    const e = { NUM_AFFILIATES: JSON.stringify({ '*': { ref: 'n', param: 'r', subparam: 'sub' } }) };
    const out = new URL(tagged('https://example.com/x', e, { extra: 'z'.repeat(200) }).url);
    assert.equal(out.searchParams.get('sub').length, 40);
  });

  test('an untagged link is returned as the identical string it came in as', () => {
    // Every refusal path. A link a guest cannot follow is worse than a link we
    // are not paid for, and "returned unchanged" has to mean unchanged.
    const url = 'https://m.uber.com/ul/?dropoff[latitude]=7.82&x=a%20b';
    assert.equal(tag(url, {}), url, 'no table');
    assert.equal(tag(url, { NUM_AFFILIATES: '{oops' }), url, 'malformed table');
    assert.equal(tag(url, { NUM_AFFILIATES: '{"other.com":{"ref":"1"}}' }), url, 'no rule for this host');
    assert.equal(tag(`${url}&ref=theirs`, env), `${url}&ref=theirs`, 'already attributed');
    assert.equal(tag(url.replace('https', 'http'), env), url.replace('https', 'http'), 'plain http');
  });
});
