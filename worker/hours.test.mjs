// The hours mask — 168 bits that decide whether a guest walks to a locked door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHours, parseSchemaHours, toHex, fromHex, getBit, openNow, hoursLeft } from './hours.mjs';

const at = (mask, day, hour) => getBit(mask, day * 24 + hour); // day 0 = Monday

test('24/7 is every hour of the week', () => {
  const m = parseHours('24/7');
  for (let i = 0; i < 168; i++) assert.ok(getBit(m, i), `hour ${i} missing`);
  assert.equal(toHex(m), 'ff'.repeat(21));
});

test('a plain range applies to every day', () => {
  const m = parseHours('10:00-22:00');
  assert.ok(at(m, 0, 10) && at(m, 6, 21), 'Monday 10:00 and Sunday 21:00 should be open');
  assert.ok(!at(m, 3, 9) && !at(m, 3, 22), 'the edges leaked');
});

test('day ranges and lists', () => {
  const m = parseHours('Mo-Fr 09:00-17:00');
  assert.ok(at(m, 0, 9) && at(m, 4, 16));
  assert.ok(!at(m, 5, 12) && !at(m, 6, 12), 'the weekend was marked open');
  const l = parseHours('Mo,We,Fr 09:00-12:00');
  assert.ok(at(l, 0, 10) && at(l, 2, 10) && at(l, 4, 10));
  assert.ok(!at(l, 1, 10), 'Tuesday was marked open');
});

test('a week-wrapping day range works', () => {
  // Fr-Mo is a real spec and means Fri, Sat, Sun, Mon — not "nothing".
  const m = parseHours('Fr-Mo 18:00-23:00');
  assert.ok(at(m, 4, 19) && at(m, 5, 19) && at(m, 6, 19) && at(m, 0, 19));
  assert.ok(!at(m, 2, 19), 'Wednesday was marked open');
});

test('an overnight bar rolls into the next day', () => {
  // 18:00–02:00 is one shift. Naively this reads as an empty or inverted range.
  const m = parseHours('Mo-Su 18:00-02:00');
  assert.ok(at(m, 0, 23), 'Monday 23:00 should be open');
  assert.ok(at(m, 1, 1), 'the small hours of Tuesday belong to Monday night');
  assert.ok(!at(m, 1, 12), 'midday leaked');
});

test('later rules override earlier ones', () => {
  const m = parseHours('Mo-Su 09:00-18:00; Su off');
  assert.ok(at(m, 0, 12), 'Monday closed');
  assert.ok(!at(m, 6, 12), 'the Sunday closure was ignored — guests sent to a shut door');
});

test('split shifts', () => {
  const m = parseHours('Mo-Fr 09:00-12:00,13:00-17:00');
  assert.ok(at(m, 0, 10) && at(m, 0, 14));
  assert.ok(!at(m, 0, 12), 'the lunch break was filled in');
});

test('a half-hour open time claims the whole hour', () => {
  // Deliberate: the mask is a filter, not a display. 11:30 makes 11 showable.
  const m = parseHours('Mo-Su 11:30-22:30');
  assert.ok(at(m, 0, 11), '11:30 should mark the 11 slot');
  assert.ok(at(m, 0, 22), '22:30 should keep the 22 slot');
});

test('grammar we do not model returns null, never a guess', () => {
  for (const s of ['Mo-Fr sunrise-sunset', 'week 1-52 Mo 09:00-17:00', 'Jan 01 off', '']) {
    assert.equal(parseHours(s), null, `"${s}" produced a mask we cannot stand behind`);
  }
  assert.equal(parseHours('Mo-Fr 09:00-nonsense'), null);
});

test('"never open" is treated as bad data, not as a fact', () => {
  // 111 rows in the live directory have `hours` set to the bare word
  // "closed". A venue open zero hours a week is not a venue — it is a stale
  // string, and acting on it would permanently mark a possibly-trading
  // business shut. Real closures come from the liveness crawl instead.
  assert.equal(parseHours('closed'), null);
  assert.equal(parseHours('Mo-Su off'), null);
  // But a partial closure is real information and must survive.
  const m = parseHours('Mo-Fr 08:00-21:00; Sa 08:00-20:00; Su closed');
  assert.ok(m && at(m, 5, 12) && !at(m, 6, 12));
});

test('real strings from the live directory parse', () => {
  // Sampled from the top of `SELECT hours, COUNT(*) … GROUP BY hours` on
  // 11 Aug 2026 — the shapes that actually exist, not invented ones.
  for (const s of [
    '24/7', 'Mo-Su 10:00-22:00', 'Mo-Sa 10:00-20:00', '10:00-22:00',
    'Mo-Fr 10:00-19:00; Sa 10:00-18:00', 'Mo-Su 12:00-24:00', 'Mo-Su 12:00-00:00',
    'Mo-Fr 07:40-20:00; Sa 07:40-18:00', 'Tu-Sa 10:00-18:00', 'Mo-Su 10:00-02:00',
    'Mo-Su 11:00-01:00', 'Mo-Su 09:00-21:30', 'Mo-Sa 10:00-19:30',
  ]) {
    assert.ok(parseHours(s), `a real directory string stopped parsing: "${s}"`);
  }
  // Midnight in both spellings closes the day, and neither wraps into the next.
  for (const s of ['Mo-Su 12:00-24:00', 'Mo-Su 12:00-00:00']) {
    const m = parseHours(s);
    assert.ok(at(m, 0, 23), `${s}: the last hour before midnight was lost`);
    assert.ok(!at(m, 1, 0), `${s}: midnight leaked into the next day`);
  }
});

test('a quoted comment does not break an otherwise good rule', () => {
  const m = parseHours('Mo-Fr 09:00-17:00 "by appointment"');
  assert.ok(m && at(m, 0, 10));
});

test('hex round-trips, and junk hex is null not zero', () => {
  const m = parseHours('Mo-Fr 09:00-17:00');
  assert.deepEqual(fromHex(toHex(m)), m);
  assert.equal(fromHex('nope'), null);
  assert.equal(fromHex('ff'.repeat(20)), null, 'a short mask was accepted — bits would silently shift');
});

test('42 characters is the whole storage cost', () => {
  assert.equal(toHex(parseHours('24/7')).length, 42);
});

test('schema.org hours land on the same mask', () => {
  const m = parseSchemaHours([
    { dayOfWeek: ['https://schema.org/Monday', 'https://schema.org/Tuesday'], opens: '08:00', closes: '16:00' },
  ]);
  assert.ok(at(m, 0, 9) && at(m, 1, 9));
  assert.ok(!at(m, 2, 9));
});

test('open now is timezone-local, not UTC', () => {
  const m = toHex(parseHours('Mo-Su 09:00-17:00'));
  // 20:00 UTC on a Monday: still mid-afternoon in Los Angeles, night in Bangkok.
  const when = new Date('2026-08-10T20:00:00Z');
  assert.equal(openNow(m, 'America/Los_Angeles', when), true);
  assert.equal(openNow(m, 'Asia/Bangkok', when), false);
});

test("unknown stays unknown — never false, never true", () => {
  // 86,465 of 90,263 Los Angeles places have no hours. If null collapsed to
  // false the city would look empty; if it collapsed to true we would send
  // people to locked doors. It is a third state.
  assert.equal(openNow(null, 'America/Los_Angeles'), null);
  assert.equal(openNow('', 'America/Los_Angeles'), null);
  assert.equal(openNow(toHex(parseHours('24/7')), 'Mars/Olympus'), null, 'a bad timezone must not read as open');
});

test('hoursLeft counts the remaining stretch', () => {
  const m = toHex(parseHours('Mo-Su 09:00-17:00'));
  const when = new Date('2026-08-10T23:00:00Z'); // 16:00 in Los Angeles
  assert.equal(hoursLeft(m, 'America/Los_Angeles', when), 1, 'closing in an hour should read as 1');
  assert.equal(hoursLeft(m, 'Asia/Bangkok', when), 0, 'a closed venue has no time left');
});
