import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsEvents, cityEventsFor, formatEvents } from './cityevents.mjs';
import { contextBlock } from './prompt.mjs';

/* A fake D1 that records what it was asked, so the expiry filter can be proven
   rather than assumed. The whole value of this feature is that it never names
   an event that has finished. */
function fakeDB(rows) {
  let seen = null;
  return {
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            seen = { sql, args };
            return { all: async () => ({ results: rows }) };
          },
        };
      },
    },
    get last() {
      return seen;
    },
  };
}

const ROW = {
  title: 'Por Tor',
  venue: 'Old Town shrines',
  area: 'Phuket Town',
  starts_on: '2026-08-19',
  ends_on: '2026-09-06',
  price_note: 'Free',
  why: 'Almost no tourists.',
  send_copy: 'Want a car at six?',
  date_confidence: 'disputed',
  unique_score: 72,
};

test('an event ask is told apart from a dinner ask', () => {
  // Every one of these is a REAL string from num_asks that Num answered with
  // restaurants when the guest wanted something to do.
  for (const t of [
    'what to do in bangkok',
    'where can we watch the football tonight?',
    'plan saturday with 6 friends',
    'what can i do for fun within walking distance of sawasdee village phuket at my current time',
  ]) {
    assert.ok(wantsEvents(t), `should have wanted events: ${t}`);
  }
  // And these must NOT trigger it — a festival list in front of someone asking
  // for a taxi is worse than no feature at all.
  for (const t of [
    'my group needs dinner ideas in patong tonight',
    'get me a car to the airport tomorrow morning',
    'book us a table at chekhoff at 8 tonight',
    'order dinner to my hotel tonight',
    'where should we eat near kata?',
  ]) {
    assert.ok(!wantsEvents(t), `should NOT have wanted events: ${t}`);
  }
});

test('the query refuses to look past the expiry date', async () => {
  const f = fakeDB([ROW]);
  await cityEventsFor({ DB: f.db }, 'phuket', { today: '2026-08-20' });
  // Both guards must be in the SQL, not just in the comments.
  assert.match(f.last.sql, /expires_at > \?2/, 'expiry filter is missing — stale events would serve');
  assert.match(f.last.sql, /COALESCE\(ends_on, starts_on\) >= \?2/, 'finished events would serve');
  assert.match(f.last.sql, /state = 'live'/);
  assert.equal(f.last.args[0], 'phuket');
  assert.equal(f.last.args[1], '2026-08-20', 'the date must be bound, never interpolated');
});

test('a disputed date is carried to the model, not smoothed over', () => {
  // Por Tor's end date differs between two sources. The model has to know that,
  // or it states a day one source made up.
  const out = formatEvents([ROW], '2026-08-20');
  assert.match(out, /ON NOW/);
  assert.match(out, /END DATE DISPUTED/);
  assert.match(out, /do not state an end date/);
});

test('no events means no block at all', () => {
  assert.equal(formatEvents([]), null);
  const block = contextBlock({ place: { name: 'Tokyo', slug: 'tokyo' }, events: null });
  assert.ok(!/WHAT IS ON HERE/.test(block), 'an empty block would invite the model to fill it');
});

test('the block reaches the prompt, and tells the model it may not invent', () => {
  const block = contextBlock({
    place: { name: 'Phuket', slug: 'phuket', tz: 'Asia/Bangkok' },
    events: formatEvents([ROW], '2026-08-20'),
  });
  assert.match(block, /WHAT IS ON HERE/, 'grounding.events never reached contextBlock');
  assert.match(block, /Por Tor/);
  assert.match(block, /ONLY events you may name/);
  assert.match(block, /Never invent an event, a date or a venue/);
});

test('a D1 failure returns nothing rather than taking the concierge down', async () => {
  const dead = { DB: { prepare() { throw new Error('D1 exploded'); } } };
  assert.deepEqual(await cityEventsFor(dead, 'tokyo'), []);
  assert.deepEqual(await cityEventsFor({}, 'tokyo'), []);
  assert.deepEqual(await cityEventsFor({ DB: {} }, null), []);
});
