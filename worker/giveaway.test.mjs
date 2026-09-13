import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, enter, eligibleCount, ENTRY_KEYWORD, ENTRY_REPLY } from './giveaway.mjs';

const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const utc = (s) => new Date(s * 1000).toUTCString();

test('an entry period opens on Friday 00:00 UTC, not Monday and not local midnight', () => {
  assert.equal(utc(weekStart(at('2026-09-18T00:00:00Z'))), 'Fri, 18 Sep 2026 00:00:00 GMT');
  assert.equal(utc(weekStart(at('2026-09-18T00:00:01Z'))), 'Fri, 18 Sep 2026 00:00:00 GMT');
  // One second earlier still belongs to the period that opened the week before.
  assert.equal(utc(weekStart(at('2026-09-17T23:59:59Z'))), 'Fri, 11 Sep 2026 00:00:00 GMT');
});

test('every day of one period maps to the same opening Friday', () => {
  const days = [
    '2026-09-11T00:00:00Z', '2026-09-12T09:30:00Z', '2026-09-13T18:00:00Z',
    '2026-09-14T23:00:00Z', '2026-09-15T04:00:00Z', '2026-09-16T12:00:00Z',
    '2026-09-17T23:59:58Z',
  ];
  const opens = new Set(days.map((d) => weekStart(at(d))));
  assert.equal(opens.size, 1, 'a period must not split across the days inside it');
  assert.equal(utc([...opens][0]), 'Fri, 11 Sep 2026 00:00:00 GMT');
});

test('the boundary holds across a DST change, because it never touches local time', () => {
  // US DST ends 1 Nov 2026. A local-time implementation shifts by an hour here
  // and quietly moves an entry into the wrong period.
  assert.equal(utc(weekStart(at('2026-10-30T12:00:00Z'))), 'Fri, 30 Oct 2026 00:00:00 GMT');
  assert.equal(utc(weekStart(at('2026-11-05T12:00:00Z'))), 'Fri, 30 Oct 2026 00:00:00 GMT');
  assert.equal(utc(weekStart(at('2026-11-06T12:00:00Z'))), 'Fri, 06 Nov 2026 00:00:00 GMT');
});

/** Minimal D1 double: records the bound statement and reports one changed row. */
function fakeDB({ changes = 1 } = {}) {
  const calls = [];
  return {
    calls,
    DB: {
      prepare(sql) {
        const c = { sql, args: [] };
        return {
          bind(...a) { c.args = a; return this; },
          async run() { calls.push(c); return { meta: { changes } }; },
          async first() { calls.push(c); return { n: 7 }; },
        };
      },
    },
  };
}

test('an entry is written against the period, with the phone and the route in', async () => {
  const f = fakeDB();
  const out = await enter(f, { phone: '+14155550123', source: 'sms', now: at('2026-09-16T12:00:00Z') });
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(utc(out.week), 'Fri, 11 Sep 2026 00:00:00 GMT');

  const c = f.calls[0];
  assert.match(c.sql, /INSERT INTO num_giveaway_entries/);
  assert.equal(c.args[1], '+14155550123');
  assert.equal(c.args[3], out.week, 'the row must be stamped with the period it belongs to');
  assert.equal(c.args[4], 'sms');
});

test('a repeat text in the same period does not add a second entry', async () => {
  // ON CONFLICT DO NOTHING means D1 reports zero changed rows.
  const f = fakeDB({ changes: 0 });
  const out = await enter(f, { phone: '+14155550123', now: at('2026-09-16T12:00:00Z') });
  assert.equal(out.ok, true);
  assert.equal(out.created, false, 'texting four times on Tuesday is still one entry');
  assert.match(f.calls[0].sql, /ON CONFLICT\(phone, week_start\) DO NOTHING/);
});

test('a junk number is refused before it reaches the database', async () => {
  const f = fakeDB();
  for (const bad of ['', '4155550123', '+0', 'PACKS', null, undefined]) {
    const out = await enter(f, { phone: bad });
    assert.equal(out.ok, false, `${bad} must not be stored`);
  }
  assert.equal(f.calls.length, 0);
});

test('a database failure is reported, never thrown — the reply must still go out', async () => {
  const env = { DB: { prepare() { throw new Error('D1 unavailable'); } } };
  const out = await enter(env, { phone: '+14155550123' });
  assert.equal(out.ok, false);
  assert.match(out.error, /D1 unavailable/);
});

test('with no database at all it degrades instead of exploding', async () => {
  assert.equal((await enter({}, { phone: '+14155550123' })).ok, false);
  assert.equal(await eligibleCount({}), 0);
});

test('the eligible count is of distinct people, not of texts', async () => {
  const f = fakeDB();
  const n = await eligibleCount(f, at('2026-09-16T12:00:00Z'));
  assert.equal(n, 7);
  assert.match(f.calls[0].sql, /COUNT\(DISTINCT phone\)/);
});

test('the keyword cannot collide with the compliance keywords', () => {
  const reserved = new Set([
    'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT',
    'START', 'UNSTOP', 'YES', 'OPTIN', 'HELP', 'INFO',
  ]);
  assert.equal(reserved.has(ENTRY_KEYWORD), false);
  assert.match(ENTRY_KEYWORD, /^[A-Z]+$/, 'the handler compares against letters only');
});

test('the confirmation carries the brand, the rules link and STOP, in one segment', () => {
  assert.match(ENTRY_REPLY, /NUM/);
  assert.match(ENTRY_REPLY, /itsnum\.com\/friday-rules/);
  assert.match(ENTRY_REPLY, /STOP/);
  assert.ok(ENTRY_REPLY.length <= 160, `one segment or it costs double: ${ENTRY_REPLY.length}`);
});
