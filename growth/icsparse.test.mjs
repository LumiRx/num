// Calendars other people wrote, and what we are willing to believe about them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, unfold, unescapeText, icsDate, splitLine } from './icsparse.mjs';

const ics = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
const ev = (lines) => `BEGIN:VEVENT\r\n${lines}\r\nEND:VEVENT`;

test('a plain event comes out whole', () => {
  const { events } = parseIcs(ics(ev(
    'UID:abc-123\r\nSUMMARY:Dinner at Gaggan\r\nLOCATION:Bangkok\r\nDTSTART:20260917T190000\r\nDTEND:20260917T213000',
  )));
  assert.equal(events.length, 1);
  assert.deepEqual(
    { t: events[0].title, s: events[0].starts_at, e: events[0].ends_at, l: events[0].location, u: events[0].uid },
    { t: 'Dinner at Gaggan', s: '2026-09-17 19:00:00', e: '2026-09-17 21:30:00', l: 'Bangkok', u: 'abc-123' },
  );
});

test('a folded line is one line', () => {
  // RFC 5545 wraps at 75 octets. Split first and you get two useless halves.
  const { events } = parseIcs(ics(ev(
    'UID:1\r\nSUMMARY:A very long dinner reservation at a restaurant with a\r\n  rather long name\r\nDTSTART:20260917T190000',
  )));
  assert.equal(events[0].title, 'A very long dinner reservation at a restaurant with a rather long name');
});

test('an all-day event is a date, not midnight', () => {
  const { events } = parseIcs(ics(ev('UID:1\r\nSUMMARY:In Lisbon\r\nDTSTART;VALUE=DATE:20260920')));
  assert.equal(events[0].starts_at, '2026-09-20');
  assert.equal(events[0].all_day, 1);
});

test('a timezone is recorded, not applied', () => {
  // Converting without a tz database would be inventing an offset. The local
  // time as written plus the zone beside it is the honest version.
  const { events } = parseIcs(ics(ev('UID:1\r\nSUMMARY:Call\r\nDTSTART;TZID=Europe/London:20260917T190000')));
  assert.equal(events[0].starts_at, '2026-09-17 19:00:00');
  assert.equal(events[0].tz, 'Europe/London');
});

test('a Z time is kept as UTC and marked as such', () => {
  const { events } = parseIcs(ics(ev('UID:1\r\nSUMMARY:Flight\r\nDTSTART:20260917T190000Z')));
  assert.equal(events[0].utc, true);
});

test('escaped text is unescaped, and a literal backslash survives', () => {
  assert.equal(unescapeText('Table for 4\\, window seat'), 'Table for 4, window seat');
  assert.equal(unescapeText('Line one\\nLine two'), 'Line one\nLine two');
  assert.equal(unescapeText('C:\\\\trip'), 'C:\\trip');
  assert.equal(unescapeText('a\\;b'), 'a;b');
});

test('an alarm inside an event does not become the event', () => {
  // Without the nesting guard, the alarm's DESCRIPTION overwrites the event's
  // and its END:VALARM ends the event early.
  const { events } = parseIcs(ics(ev(
    'UID:1\r\nSUMMARY:Pick-up\r\nDTSTART:20260917T090000\r\n' +
    'BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\n' +
    'LOCATION:Heathrow T5',
  )));
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Pick-up');
  assert.equal(events[0].location, 'Heathrow T5');
  assert.notEqual(events[0].detail, 'Reminder');
});

test('a repeating event is imported once and flagged, never expanded', () => {
  const { events } = parseIcs(ics(ev(
    'UID:1\r\nSUMMARY:Weekly massage\r\nDTSTART:20260917T100000\r\nRRULE:FREQ=WEEKLY;COUNT=10',
  )));
  assert.equal(events.length, 1);
  assert.equal(events[0].repeats, true);
});

test('several events, and a broken one does not take the file down', () => {
  const { events, skipped } = parseIcs(ics([
    ev('UID:1\r\nSUMMARY:Good one\r\nDTSTART:20260917T100000'),
    ev('UID:2\r\nDTSTART:20260918T100000'),               // no summary
    ev('UID:3\r\nSUMMARY:No start at all'),               // no start
    ev('UID:4\r\nSUMMARY:Also good\r\nDTSTART:20260919T100000'),
  ].join('\r\n')));
  assert.deepEqual(events.map((e) => e.title), ['Good one', 'Also good']);
  assert.equal(skipped, 2);
});

test('LF-only and CRLF files read the same', () => {
  const body = 'BEGIN:VEVENT\nUID:1\nSUMMARY:Same\nDTSTART:20260917T100000\nEND:VEVENT';
  const a = parseIcs('BEGIN:VCALENDAR\n' + body + '\nEND:VCALENDAR');
  const b = parseIcs(ics(ev('UID:1\r\nSUMMARY:Same\r\nDTSTART:20260917T100000')));
  assert.deepEqual(a.events[0].title, b.events[0].title);
  assert.deepEqual(a.events[0].starts_at, b.events[0].starts_at);
});

test('a quoted parameter containing a colon does not split the line', () => {
  const p = splitLine('DTSTART;TZID="GMT+01:00":20260917T190000');
  assert.equal(p.name, 'DTSTART');
  assert.equal(p.params.TZID, 'GMT+01:00');
  assert.equal(p.value, '20260917T190000');
});

test('the cap is a cap, and what it cost is reported', () => {
  const many = Array.from({ length: 12 }, (_, i) => ev(`UID:${i}\r\nSUMMARY:E${i}\r\nDTSTART:2026091${i % 10}T100000`)).join('\r\n');
  const { events, skipped } = parseIcs(ics(many), { max: 5 });
  assert.equal(events.length, 5);
  assert.equal(skipped, 7);
});

test('rubbish in, nothing out, no throw', () => {
  for (const junk of ['', 'hello', null, undefined, 'BEGIN:VCALENDAR', '\u0000\u0000']) {
    const r = parseIcs(junk);
    assert.equal(r.events.length, 0, JSON.stringify(junk));
  }
});

test('an unterminated event is not half-imported', () => {
  const r = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Cut off\r\nDTSTART:20260917T100000\r\n');
  assert.equal(r.events.length, 0);
});

test('unfold and icsDate behave on their own', () => {
  assert.deepEqual(unfold('a\r\n b\r\nc'), ['ab', 'c']);
  assert.equal(icsDate('20260917T190000').at, '2026-09-17 19:00:00');
  assert.equal(icsDate('20260917').allDay, true);
  assert.equal(icsDate('nonsense'), null);
});
