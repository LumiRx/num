import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingEmail, weeklyDigest, weeklySweep, prefs, setPrefs } from './biznotify.mjs';

const DB = (h) => ({
  prepare(q) {
    const hit = Object.entries(h).find(([re]) => new RegExp(re).test(q));
    const call = async (a) => (hit ? hit[1](a, q) : null);
    return {
      bind: (...a) => ({
        first: async () => (await call(a)) ?? null,
        all: async () => (await call(a)) ?? { results: [] },
        run: async () => (await call(a)) ?? {},
      }),
      first: async () => (await call([])) ?? null,
      all: async () => (await call([])) ?? { results: [] },
      run: async () => (await call([])) ?? {},
    };
  },
});

test('a week with nothing in it sends NOTHING', async () => {
  // An empty digest is how a sender becomes spam, and calling it news is
  // simply untrue. Silence is what makes the next one worth opening.
  const env = { DB: DB({ 'num_impressions': () => ({ n: 0 }), 'num_booking_requests': () => ({ n: 0 }) }) };
  assert.equal(await weeklyDigest(env, { placeId: 'p1', place: { name: 'Awafi' } }), null);
});

test('a week with something in it reports only what was measured', async () => {
  const env = { DB: DB({ 'num_impressions': () => ({ n: 12 }), 'num_booking_requests': () => ({ n: 0 }) }) };
  const d = await weeklyDigest(env, { placeId: 'p1', place: { name: 'Awafi' } });
  assert.ok(d);
  assert.match(d.text, /Shown to travellers: 12/);
  // A zero it did not measure must not be printed as if it had been.
  assert.doesNotMatch(d.text, /Booking requests: 0/, 'a zero was printed as though it were news');
  assert.match(d.text, /api\/biz\/console\?q=Awafi/);
});

test('the digest never invents or rounds a figure', async () => {
  const env = { DB: DB({ 'num_impressions': () => ({ n: 3 }), 'num_booking_requests': () => ({ n: 1 }) }) };
  const d = await weeklyDigest(env, { placeId: 'p1', place: { name: 'X' } });
  assert.match(d.text, /Shown to travellers: 3/);
  assert.match(d.text, /Booking requests: 1/);
  assert.doesNotMatch(d.text, /about|around|approx|~|estimate/i);
});

test('a failed send is retried next week, not silently skipped', async () => {
  // last_weekly is written only after success. The opposite mistake — marking
  // it sent regardless — is exactly what lost Fingal Hotel's signup alert.
  let marked = 0;
  const env = {
    DB: DB({
      'FROM num_place_owners': () => ({ results: [{ business_id: 'b1', place_id: 'p1', name: 'Awafi' }] }),
      'FROM num_business_notify': () => ({ business_id: 'b1', email: 'o@awafi.co.uk', on_booking: 1, on_weekly: 1, last_weekly: null }),
      'num_impressions': () => ({ n: 5 }),
      'num_booking_requests': () => ({ n: 0 }),
      'UPDATE num_business_notify SET last_weekly': () => { marked += 1; return {}; },
      'CREATE TABLE': () => ({}),
    }),
  };
  const fail = await weeklySweep(env, { send: async () => ({ ok: false, error: 'down' }) });
  assert.equal(fail.sent, 0);
  assert.equal(marked, 0, 'a failed send was recorded as delivered — that week is now lost forever');

  const ok = await weeklySweep(env, { send: async () => ({ ok: true }) });
  assert.equal(ok.sent, 1);
  assert.equal(marked, 1);
});

test('a business that already heard from us this week is left alone', async () => {
  const env = {
    DB: DB({
      'FROM num_place_owners': () => ({ results: [{ business_id: 'b1', place_id: 'p1', name: 'Awafi' }] }),
      'FROM num_business_notify': () => ({ business_id: 'b1', email: 'o@x.com', on_booking: 1, on_weekly: 1, last_weekly: '2026-08-29 10:00:00' }),
      'num_impressions': () => ({ n: 50 }),
      'num_booking_requests': () => ({ n: 3 }),
      'CREATE TABLE': () => ({}),
    }),
  };
  const out = await weeklySweep(env, { send: async () => ({ ok: true }), now: Date.parse('2026-08-30T10:00:00Z') });
  assert.equal(out.sent, 0, 'a second digest went out the day after the first');
});

test('opting out is honoured', async () => {
  const env = {
    DB: DB({
      'FROM num_place_owners': () => ({ results: [{ business_id: 'b1', place_id: 'p1', name: 'Awafi' }] }),
      'FROM num_business_notify': () => ({ business_id: 'b1', email: 'o@x.com', on_booking: 1, on_weekly: 0, last_weekly: null }),
      'num_impressions': () => ({ n: 50 }),
      'CREATE TABLE': () => ({}),
    }),
  };
  assert.equal((await weeklySweep(env, { send: async () => ({ ok: true }) })).sent, 0);
});

test('with no preferences saved, the signup address is inherited and labelled as such', async () => {
  const env = {
    DB: DB({
      'FROM num_business_notify': () => null,
      'FROM num_business_users': () => ({ email: 'edward@morrisons.example' }),
      'CREATE TABLE': () => ({}),
    }),
  };
  const p = await prefs(env, 'b1');
  assert.equal(p.email, 'edward@morrisons.example');
  assert.equal(p.inherited, true, 'an inherited address must be distinguishable from a chosen one');
});

test('the booking email points at the channel that actually holds the table', async () => {
  // The SMS to the venue line is what gets a table held. This email must not
  // imply that replying to it does anything.
  const { subject, text } = bookingEmail({ business: 'Awafi', party: 4, when: 'tonight 8pm', note: 'window seat' });
  assert.match(subject, /Booking request — Awafi/);
  assert.match(text, /texted the number on your listing/);
  assert.match(text, /answering there is what holds the table/);
  assert.match(text, /window seat/);
});

test('preferences round-trip', async () => {
  let saved = null;
  const env = { DB: DB({ 'INSERT INTO num_business_notify': (a) => { saved = a; return {}; }, 'CREATE TABLE': () => ({}) }) };
  const out = await setPrefs(env, 'b1', { email: 'x@y.com', onBooking: true, onWeekly: false });
  assert.equal(out.ok, true);
  assert.deepEqual(saved, ['b1', 'x@y.com', 1, 0]);
});
