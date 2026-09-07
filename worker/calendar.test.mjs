// A guest whose table was confirmed got a line in a chat thread and nothing
// they could put where they actually look. These pin the .ics output for
// bookings, plans and events — and the three refusals: not confirmed, no
// date, not yours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  icsEscape, icsFold, floating, plus, vevent, calendar,
  bookingEvent, planEvents, eventEvent, handleCalendar,
} from './calendar.mjs';

function reorder(sql, args) {
  const idx = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (!idx.length) return args;
  return idx.map((i) => (args[i - 1] === undefined ? null : args[i - 1]));
}
function d1(db) {
  return {
    prepare(sql) {
      const st = { sql, args: [] };
      st.bind = (...a) => { st.args = a; return st; };
      const run = (fn) => fn(db.prepare(st.sql.replace(/\?(\d+)/g, '?')), reorder(st.sql, st.args));
      st.run = async () => ({ meta: { changes: run((s, a) => s.run(...a)).changes } });
      st.first = async () => run((s, a) => s.get(...a)) ?? null;
      st.all = async () => ({ results: run((s, a) => s.all(...a)) });
      return st;
    },
  };
}
function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_booking_requests (id TEXT PRIMARY KEY, member_id TEXT, venue_name TEXT, venue_phone TEXT, party_size INTEGER, on_date TEXT, at_time TEXT, note TEXT, state TEXT, answered_at TEXT)`);
  db.exec(`CREATE TABLE num_plans (id TEXT PRIMARY KEY, title TEXT, dest TEXT, owner_id TEXT, starts_on TEXT, starts_time TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE num_plan_members (plan_id TEXT, member_id TEXT)`);
  db.exec(`CREATE TABLE num_plan_items (id TEXT PRIMARY KEY, plan_id TEXT, title TEXT, place TEXT, address TEXT, day TEXT, time TEXT, status TEXT, cost TEXT, note TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE num_events (id TEXT PRIMARY KEY, host_id TEXT, title TEXT, day TEXT, time TEXT, place TEXT, address TEXT, dress TEXT, note TEXT, slug TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE num_event_guests (token TEXT PRIMARY KEY, event_id TEXT)`);
  db.exec(`INSERT INTO num_booking_requests VALUES ('br1','m1','Blue Elephant','+6622133333',4,'2026-09-12','19:30','window table','confirmed','2026-09-04 10:00:00')`);
  db.exec(`INSERT INTO num_booking_requests VALUES ('br2','m1','Gaggan',NULL,2,'2026-09-13','20:00',NULL,'requested',NULL)`);
  db.exec(`INSERT INTO num_booking_requests VALUES ('br3','m1','Tonight Place','+1',2,NULL,'21:00',NULL,'confirmed',NULL)`);
  db.exec(`INSERT INTO num_plans VALUES ('p1','Phi Phi weekend','Phi Phi','m1','2026-10-03','08:00','2026-09-01 00:00:00')`);
  db.exec(`INSERT INTO num_plan_members VALUES ('p1','m2')`);
  db.exec(`INSERT INTO num_plan_items VALUES ('i1','p1','Boat day','Tonsai pier',NULL,'2026-10-03','08:00','confirmed','~THB 1,200 pp','bring sunscreen','2026-09-02 00:00:00')`);
  db.exec(`INSERT INTO num_plan_items VALUES ('i2','p1','Somewhere for dinner',NULL,NULL,NULL,NULL,'idea',NULL,NULL,NULL)`);
  db.exec(`INSERT INTO num_plan_items VALUES ('i3','p1','Cancelled thing',NULL,NULL,'2026-10-04','10:00','cancelled',NULL,NULL,NULL)`);
  db.exec(`INSERT INTO num_events VALUES ('e1','m1','Dre''s birthday','2026-09-20','19:00','Soho House','76 Dean St, London','smart','cake at 10','dres-birthday','2026-09-01 00:00:00')`);
  db.exec(`INSERT INTO num_event_guests VALUES ('tok_guest1','e1')`);
  return { DB: d1(db), APP_ORIGIN: 'https://app.itsnum.com' };
}
const get = (env, path) => handleCalendar(new Request('https://app.itsnum.com' + path), env, new URL('https://app.itsnum.com' + path));

test('escaping and folding follow RFC 5545, so Apple and Outlook both parse it', () => {
  assert.equal(icsEscape('a,b;c\\d\nnext'), 'a\\,b\\;c\\\\d\\nnext');
  const folded = icsFold('SUMMARY:' + 'x'.repeat(200));
  for (const line of folded.split('\r\n')) assert.ok(line.length <= 75, `line of ${line.length} octets`);
  assert.ok(folded.split('\r\n').slice(1).every((l) => l.startsWith(' ')), 'continuation lines begin with a space');
});

test('a date is filed as written or not at all — never guessed', () => {
  assert.deepEqual(floating('2026-09-12', '19:30'), { value: '20260912T193000', allDay: false });
  assert.deepEqual(floating('2026-09-12', null), { value: '20260912', allDay: true });
  assert.equal(floating('tonight', '19:30'), null, '"tonight" is not a date');
  assert.equal(floating('12 Sep', '19:30'), null);
  assert.equal(floating('2026-13-40', '19:30'), null, 'month 13 is not a month');
  assert.deepEqual(floating('2026-09-12', '25:99'), { value: '20260912', allDay: true }, 'a nonsense time falls back to the day, not to a made-up hour');
});

test('times are floating: no Z, no TZID — 19:30 is 19:30 where the table is', () => {
  const ev = bookingEvent({ id: 'br1', venue_name: 'Blue Elephant', party_size: 4, on_date: '2026-09-12', at_time: '19:30', state: 'confirmed' });
  assert.match(ev, /DTSTART:20260912T193000\r\n/);
  assert.match(ev, /DTEND:20260912T210000\r\n/, 'a table defaults to ninety minutes');
  assert.doesNotMatch(ev, /DTSTART:\d+T\d+Z/);
  assert.doesNotMatch(ev, /TZID/);
});

test('plus() crosses midnight and month ends correctly', () => {
  assert.equal(plus('20260930T233000', 90), '20261001T010000');
  assert.equal(plus('20260228', 0), '20260301', 'all-day end is the next day (exclusive), 2026 is not a leap year');
});

test('only a CONFIRMED booking becomes a calendar entry', () => {
  assert.equal(bookingEvent({ id: 'x', state: 'requested', on_date: '2026-09-12', at_time: '19:00', venue_name: 'A' }), null);
  assert.equal(bookingEvent({ id: 'x', state: 'declined', on_date: '2026-09-12', at_time: '19:00', venue_name: 'A' }), null);
  assert.ok(bookingEvent({ id: 'x', state: 'confirmed', on_date: '2026-09-12', at_time: '19:00', venue_name: 'A' }));
});

test('a plan files its start and every DATED item; ideas without a day and cancelled items stay out', () => {
  const events = planEvents(
    { id: 'p1', title: 'Phi Phi weekend', dest: 'Phi Phi', starts_on: '2026-10-03', starts_time: '08:00' },
    [
      { id: 'i1', title: 'Boat day', day: '2026-10-03', time: '08:00', status: 'confirmed', place: 'Tonsai pier' },
      { id: 'i2', title: 'Dinner somewhere', day: null, time: null, status: 'idea' },
      { id: 'i3', title: 'Cancelled', day: '2026-10-04', time: '10:00', status: 'cancelled' },
      { id: 'i4', title: 'Beach', day: '2026-10-04', time: null, status: 'idea' },
    ],
    'https://app.itsnum.com',
  );
  assert.equal(events.length, 3, 'plan start + boat day + beach');
  const text = events.join('\n');
  assert.match(text, /SUMMARY:Boat day/);
  assert.match(text, /DTSTART;VALUE=DATE:20261004\r\n/, 'an item with a day and no time is all-day');
  assert.match(text, /Still an idea — not booked\./, 'an idea says so — a calendar must not upgrade it to a booking');
  assert.doesNotMatch(text, /Cancelled/);
  assert.doesNotMatch(text, /Dinner somewhere/);
});

test('an event links back to its RSVP page', () => {
  const ev = eventEvent({ id: 'e1', title: 'Party', day: '2026-09-20', time: '19:00', place: 'Soho House', slug: 'party' }, 'https://app.itsnum.com');
  assert.match(ev, /URL:https:\/\/app\.itsnum\.com\/e\/party/);
  assert.match(ev, /LOCATION:Soho House/);
});

test('GET /api/calendar/booking.ics returns a file the member can save, with bearer-safe headers', async () => {
  const env = fresh();
  const res = await get(env, '/api/calendar/booking.ics?id=br1&me=m1');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  assert.match(res.headers.get('content-disposition'), /num-blue-elephant\.ics/);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const body = await res.text();
  assert.match(body, /^BEGIN:VCALENDAR\r\n/);
  assert.match(body, /SUMMARY:Blue Elephant — table for 4/);
  assert.match(body, /Venue: \+6622133333/);
  assert.match(body, /END:VCALENDAR\r\n$/);
});

test('somebody else\'s member id gets nothing, not a 200 with an empty calendar', async () => {
  const env = fresh();
  assert.equal((await get(env, '/api/calendar/booking.ics?id=br1&me=m9')).status, 404);
  assert.equal((await get(env, '/api/calendar/plan.ics?id=p1&me=m9')).status, 404);
  assert.equal((await get(env, '/api/calendar/event.ics?id=e1&me=m9')).status, 404);
  assert.equal((await get(env, '/api/calendar/event.ics?token=nope')).status, 404);
});

test('a booking that is not confirmed, or has no date, is refused with a reason', async () => {
  const env = fresh();
  const pending = await get(env, '/api/calendar/booking.ics?id=br2&me=m1');
  assert.equal(pending.status, 409);
  assert.match(await pending.text(), /not confirmed yet/);
  const undated = await get(env, '/api/calendar/booking.ics?id=br3&me=m1');
  assert.equal(undated.status, 409);
  assert.match(await undated.text(), /no date/);
});

test('a plan is readable by its owner AND its members, and lists dated items only', async () => {
  const env = fresh();
  for (const me of ['m1', 'm2']) {
    const res = await get(env, `/api/calendar/plan.ics?id=p1&me=${me}`);
    assert.equal(res.status, 200, `${me} should be able to read plan p1`);
    const body = await res.text();
    assert.equal((body.match(/BEGIN:VEVENT/g) ?? []).length, 2, 'plan start + boat day');
    assert.match(body, /X-WR-CALNAME:Phi Phi weekend/);
  }
});

test('an event guest uses the token they were sent; the host uses their id', async () => {
  const env = fresh();
  const guest = await get(env, '/api/calendar/event.ics?token=tok_guest1');
  assert.equal(guest.status, 200);
  assert.match(await guest.text(), /SUMMARY:Dre's birthday/);
  const host = await get(env, '/api/calendar/event.ics?id=e1&me=m1');
  assert.equal(host.status, 200);
  assert.match(await host.text(), /URL:https:\/\/app\.itsnum\.com\/e\/dres-birthday/);
});

test('the route is GET-only and unknown files 404', async () => {
  const env = fresh();
  const post = await handleCalendar(new Request('https://app.itsnum.com/api/calendar/booking.ics', { method: 'POST' }), env, new URL('https://app.itsnum.com/api/calendar/booking.ics'));
  assert.equal(post.status, 405);
  assert.equal((await get(env, '/api/calendar/other.ics')).status, 404);
});
