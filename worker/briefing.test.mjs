import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { briefingLine, dayIn } from './briefing.mjs';

const tz = 'Asia/Bangkok';
const now = Date.UTC(2026, 8, 2, 8, 0, 0); // 15:00 Bangkok, 2 Sep 2026
const today = dayIn(tz, 0, now);
const tomorrow = dayIn(tz, 1, now);

describe('briefingLine — only about something the person has', () => {
  test('nothing planned → nothing said. No engagement bait.', () => {
    assert.equal(briefingLine([], { tz, now }), null);
    assert.equal(briefingLine([{ title: 'Old', starts_on: '2026-01-01', state: 'planning' }], { tz, now }), null);
  });
  test('today beats tomorrow, and carries the time and place', () => {
    const line = briefingLine([
      { title: 'Dinner at Kata', dest: 'Phuket', starts_on: tomorrow, starts_time: '19:30', state: 'planning' },
      { title: 'Boat day', dest: 'Phi Phi', starts_on: today, starts_time: '08:00', state: 'planning' },
    ], { tz, now });
    assert.match(line, /^Boat day in Phi Phi is today at 08:00\./);
  });
  test('tomorrow, without a time or place, still reads cleanly', () => {
    const line = briefingLine([{ title: 'Market run', starts_on: tomorrow, state: 'planning' }], { tz, now });
    assert.equal(line, 'Market run is tomorrow. Anything you want lined up before then?');
  });
  test('within the week is mentioned once, nearest first; beyond it is not news', () => {
    const line = briefingLine([
      { title: 'Far', starts_on: dayIn(tz, 20, now), state: 'planning' },
      { title: 'Near', starts_on: dayIn(tz, 3, now), state: 'planning' },
      { title: 'Nearer', starts_on: dayIn(tz, 2, now), state: 'planning' },
    ], { tz, now });
    assert.match(line, /^Nearer is coming up on /);
    assert.equal(briefingLine([{ title: 'Far', starts_on: dayIn(tz, 20, now), state: 'planning' }], { tz, now }), null);
  });
  test('a finished plan is never brought up', () => {
    assert.equal(briefingLine([{ title: 'Done', starts_on: today, state: 'done' }], { tz, now }), null);
  });
  test('the day is judged in the destination timezone, not UTC', () => {
    // 23:30 UTC on 2 Sep is already 3 Sep in Bangkok.
    const late = Date.UTC(2026, 8, 2, 23, 30);
    const line = briefingLine([{ title: 'X', starts_on: '2026-09-03', state: 'planning' }], { tz, now: late });
    assert.match(line, /is today/);
  });
  test('an unknown timezone falls back rather than throwing', () => {
    assert.equal(typeof dayIn('Not/AZone', 0, now), 'string');
  });
});
