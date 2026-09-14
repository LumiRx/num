import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NAGER, GOOGLE_CAL, covers, railFor, isoDay, daysBetween,
  parseIcs, fromNager, NAGER_URL, GOOGLE_URL, holidaysFor, holidayBlock, handleHolidays, realDay,
} from './holidays.mjs';

describe('who Num can actually answer for', () => {
  test('the two rails together cover the markets Num is in', () => {
    // NUM's ten largest countries by directory size, 14 Sep 2026.
    for (const cc of ['US', 'JP', 'TW', 'VN', 'TH', 'GB', 'ES', 'IT', 'FR', 'PH']) {
      assert.equal(covers(cc), true, `${cc} is a top-ten market with no calendar`);
    }
  });

  test('a country neither rail carries is admitted, not faked', () => {
    // Nepal, Laos, the Maldives: checked on 14 Sep 2026, neither rail answers.
    for (const cc of ['NP', 'LA', 'MV']) {
      assert.equal(covers(cc), false);
      assert.equal(railFor(cc), null);
    }
  });

  test('rubbish input is not a country', () => {
    for (const bad of ['', null, undefined, 'THA', 'x', '12', 'th ']) {
      assert.equal(covers(bad), false);
    }
  });

  test('a lowercase code still resolves', () => {
    assert.equal(railFor('th'), 'google');
    assert.equal(railFor('us'), 'nager');
  });

  test('Google is only reached for countries that need it', () => {
    // The point of the fallback is that it is a fallback. If a country sits in
    // both tables and Nager answers it correctly, Google must not be consulted
    // — every entry in GOOGLE_CAL has to justify itself.
    for (const cc of Object.keys(GOOGLE_CAL)) {
      if (NAGER.includes(cc)) {
        assert.equal(cc, 'VN',
          `${cc} is in both tables. Either Nager answers it and it should be removed from `
          + 'GOOGLE_CAL, or there is a documented reason like Vietnam’s missing Tet.');
      }
    }
  });

  test('Hong Kong is NOT on the Google list', () => {
    // It was, on a guess. Nager returns 17 holidays for HK 2026, so the guess
    // was wrong and the entry came out. Named so it does not come back.
    assert.equal(Object.prototype.hasOwnProperty.call(GOOGLE_CAL, 'HK'), false);
    assert.equal(railFor('HK'), 'nager');
  });

  test('Vietnam is on the Google list and the reason is written down', () => {
    assert.equal(railFor('VN'), 'google');
    const src = readFileSync(new URL('./holidays.mjs', import.meta.url), 'utf8');
    assert.match(src, /Tet is absent/);
  });
});

describe('dates, without a date library', () => {
  test('isoDay is UTC and zero-padded', () => {
    assert.equal(isoDay(new Date('2026-01-05T23:59:59Z')), '2026-01-05');
    assert.equal(isoDay(new Date('2026-12-31T00:00:00Z')), '2026-12-31');
  });

  test('a bad date is null, not "Invalid Date"', () => {
    assert.equal(isoDay(new Date('nonsense')), null);
    assert.equal(isoDay('2026-01-01'), null);
    assert.equal(isoDay(null), null);
  });

  test('daysBetween counts whole days and goes negative backwards', () => {
    assert.equal(daysBetween('2026-09-14', '2026-09-14'), 0);
    assert.equal(daysBetween('2026-09-14', '2026-09-15'), 1);
    assert.equal(daysBetween('2026-09-14', '2026-10-14'), 30);
    assert.equal(daysBetween('2026-09-14', '2026-09-01'), -13);
  });

  test('daysBetween crosses a year boundary', () => {
    assert.equal(daysBetween('2026-12-28', '2027-01-04'), 7);
  });

  test('a malformed date returns null rather than NaN days', () => {
    assert.equal(daysBetween('nope', '2026-09-14'), null);
    assert.equal(daysBetween('2026-09-14', ''), null);
  });
});

describe('a date that does not exist', () => {
  test('a real day is a real day', () => {
    for (const d of ['2026-01-01', '2026-02-28', '2028-02-29', '2026-12-31']) {
      assert.equal(realDay(d), true, d);
    }
  });

  test('the right shape is not the same as a real date', () => {
    // The bug this test was written for: /^\d{4}-\d{2}-\d{2}$/ accepts all
    // of these, and a traveller was one bad upstream row away from being told
    // to avoid the 45th of the thirteenth month.
    for (const d of ['2026-13-45', '2026-00-10', '2026-02-31', '2026-04-31', '2027-02-29']) {
      assert.equal(realDay(d), false, d);
    }
  });

  test('nothing is not a date', () => {
    for (const d of ['', null, undefined, '2026-1-1', '20260101', 'tomorrow']) {
      assert.equal(realDay(d), false);
    }
  });

  test('an impossible day never reaches the traveller through either rail', () => {
    assert.deepEqual(fromNager([{ date: '2026-02-31', localName: 'Nope', global: true }]), []);
    assert.deepEqual(parseIcs('BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261345\r\nSUMMARY:Nope\r\nEND:VEVENT'), []);
  });
});

describe('reading Google’s calendar', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20260217',
    'SUMMARY:Vietnamese New Year',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20260110',
    'SUMMARY:Working day for New Year Holiday',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20260218',
    'SUMMARY:Tet Holiday',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  test('holidays come through with their dates', () => {
    const out = parseIcs(ics);
    assert.deepEqual(out.map((h) => h.date), ['2026-02-17', '2026-02-18']);
    assert.equal(out[0].name, 'Vietnamese New Year');
  });

  test('a make-up WORKING day is dropped, not reported as a holiday', () => {
    // Vietnam's real 2026 feed lists "Working day for New Year Holiday" on
    // 10 January. That day the country is OPEN. Reporting it as a closure
    // would be worse than saying nothing.
    const out = parseIcs(ics);
    assert.equal(out.some((h) => /working day/i.test(h.name)), false);
  });

  test('a folded long name is put back together', () => {
    const folded = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260405\r\n'
      + 'SUMMARY:His Majesty the King’s Corona\r\n tion Anniversary\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const out = parseIcs(folded);
    assert.equal(out.length, 1);
    assert.match(out[0].name, /Coronation Anniversary/);
  });

  test('a timed event is not a public holiday and is skipped', () => {
    const timed = 'BEGIN:VEVENT\r\nDTSTART:20260405T090000Z\r\nSUMMARY:Something\r\nEND:VEVENT';
    assert.deepEqual(parseIcs(timed), []);
  });

  test('an event with no name is skipped rather than shown blank', () => {
    const noname = 'BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260405\r\nSUMMARY:\r\nEND:VEVENT';
    assert.deepEqual(parseIcs(noname), []);
  });

  test('the Google rail never claims to know national from regional', () => {
    for (const h of parseIcs(ics)) assert.equal(h.national, null);
  });

  test('empty and rubbish input return an empty list, not a throw', () => {
    assert.deepEqual(parseIcs(''), []);
    assert.deepEqual(parseIcs(null), []);
    assert.deepEqual(parseIcs('{"not":"ical"}'), []);
  });
});

describe('reading Nager', () => {
  test('the local name wins over the English one', () => {
    const out = fromNager([{ date: '2026-01-01', localName: 'Neujahr', name: "New Year's Day", global: true }]);
    assert.equal(out[0].name, 'Neujahr');
    assert.equal(out[0].national, true);
  });

  test('a regional holiday is marked regional, not national', () => {
    const out = fromNager([{ date: '2026-06-23', localName: 'Fronleichnam', name: 'Corpus Christi', global: false }]);
    assert.equal(out[0].national, false);
  });

  test('rows without a real date are dropped', () => {
    const out = fromNager([
      { date: 'soon', localName: 'x', global: true },
      { date: '2026-13-45', localName: 'y', global: true },
      { date: '2026-05-01', localName: 'Labour Day', global: true },
    ]);
    assert.equal(out.length, 1);
  });

  test('a non-array is an empty list, not a throw', () => {
    assert.deepEqual(fromNager(null), []);
    assert.deepEqual(fromNager({ error: 'nope' }), []);
  });
});

describe('the urls are the real ones', () => {
  test('Nager', () => {
    assert.equal(NAGER_URL('th', 2026), 'https://date.nager.at/api/v3/PublicHolidays/2026/TH');
  });

  test('Google, with the id escaped so the # and @ survive', () => {
    const u = GOOGLE_URL('en.th');
    assert.match(u, /%23holiday%40group\.v\.calendar\.google\.com/);
    assert.equal(u.includes('#'), false, 'an unescaped # truncates the url');
  });

  test('every host Num asks is one of exactly two', () => {
    const hosts = new Set([
      new URL(NAGER_URL('US', 2026)).host,
      ...Object.values(GOOGLE_CAL).map((c) => new URL(GOOGLE_URL(c)).host),
    ]);
    assert.deepEqual([...hosts].sort(), ['calendar.google.com', 'date.nager.at']);
  });
});

describe('the window', () => {
  const ok = (body, text = false) => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => (text ? body : JSON.stringify(body)),
  });

  test('a country with no calendar reports that, and reports no days', async () => {
    let called = false;
    const r = await holidaysFor('NP', {
      from: '2026-09-14',
      fetchImpl: async () => { called = true; return ok([]); },
    });
    assert.equal(r.covered, false);
    assert.deepEqual(r.days, []);
    assert.equal(called, false, 'an uncovered country should not hit the network');
  });

  test('holidays outside the window are left out', async () => {
    const r = await holidaysFor('US', {
      from: '2026-09-14', days: 30,
      fetchImpl: async () => ok([
        { date: '2026-09-07', localName: 'Labor Day', global: true },
        { date: '2026-10-12', localName: 'Columbus Day', global: true },
        { date: '2026-11-26', localName: 'Thanksgiving', global: true },
      ]),
    });
    assert.deepEqual(r.days.map((d) => d.date), ['2026-10-12']);
    assert.equal(r.days[0].inDays, 28);
  });

  test('a window spanning new year asks for both years', async () => {
    const asked = [];
    await holidaysFor('US', {
      from: '2026-12-20', days: 30,
      fetchImpl: async (u) => { asked.push(u); return ok([]); },
    });
    assert.equal(asked.length, 2);
    assert.ok(asked.some((u) => u.endsWith('/2026/US')));
    assert.ok(asked.some((u) => u.endsWith('/2027/US')));
  });

  test('the same holiday listed twice is shown once', async () => {
    const r = await holidaysFor('US', {
      from: '2026-09-14', days: 60,
      fetchImpl: async () => ok([
        { date: '2026-10-12', localName: 'Columbus Day', global: true },
        { date: '2026-10-12', localName: 'Columbus Day', global: false },
      ]),
    });
    assert.equal(r.days.length, 1);
  });

  test('204 from Nager is not treated as an outage', async () => {
    const r = await holidaysFor('US', {
      from: '2026-09-14',
      fetchImpl: async () => ({ ok: false, status: 204 }),
    });
    assert.equal(r.covered, true);
    assert.notEqual(r.stale, true);
  });

  test('a 500 is stale, and stale is not the same as none', async () => {
    const r = await holidaysFor('US', {
      from: '2026-09-14',
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    assert.equal(r.covered, true);
    assert.equal(r.stale, true);
    assert.deepEqual(r.days, []);
  });

  test('a thrown fetch is stale, not empty', async () => {
    const r = await holidaysFor('TH', {
      from: '2026-09-14',
      fetchImpl: async () => { throw new Error('socket hang up'); },
    });
    assert.equal(r.stale, true);
  });

  test('the Google rail parses ical rather than json', async () => {
    const ics = 'BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260923\r\nSUMMARY:Chakri Day\r\nEND:VEVENT';
    const r = await holidaysFor('TH', {
      from: '2026-09-14', days: 30,
      fetchImpl: async () => ok(ics, true),
    });
    assert.equal(r.rail, 'google');
    assert.equal(r.days[0].name, 'Chakri Day');
  });

  test('days are returned in date order', async () => {
    const r = await holidaysFor('US', {
      from: '2026-09-14', days: 90,
      fetchImpl: async () => ok([
        { date: '2026-11-26', localName: 'Thanksgiving', global: true },
        { date: '2026-10-12', localName: 'Columbus Day', global: true },
      ]),
    });
    assert.deepEqual(r.days.map((d) => d.date), ['2026-10-12', '2026-11-26']);
  });
});

describe('what the model is told', () => {
  test('not covered says not covered, and forbids guessing from a neighbour', () => {
    const b = holidayBlock({ covered: false, country: 'NP', days: [] }, { country_name: 'Nepal' });
    assert.match(b, /NOT KNOWN/);
    assert.match(b, /do not guess from a neighbouring/i);
    assert.match(b, /not a failure/);
  });

  test('stale never reads as "nothing is closed"', () => {
    const b = holidayBlock({ covered: true, stale: true, country: 'TH', days: [] });
    assert.match(b, /COULD NOT BE READ/);
    assert.match(b, /Do not report that there are no holidays/);
  });

  test('checked-and-none is stated as a fact, because it is one', () => {
    const b = holidayBlock({ covered: true, country: 'US', from: '2026-09-14', to: '2026-10-14', days: [] });
    assert.match(b, /CHECKED, NONE/);
    assert.match(b, /you can state/);
  });

  test('the three empty states are not interchangeable', () => {
    const none = holidayBlock({ covered: true, country: 'US', from: 'a', to: 'b', days: [] });
    const unknown = holidayBlock({ covered: false, country: 'NP', days: [] });
    const stale = holidayBlock({ covered: true, stale: true, country: 'TH', days: [] });
    assert.equal(new Set([none, unknown, stale]).size, 3);
  });

  test('a coming holiday is dated, counted, and told to arrive early', () => {
    const b = holidayBlock({
      covered: true, rail: 'nager', country: 'US', from: '2026-09-14', to: '2026-10-14',
      days: [{ date: '2026-10-12', name: 'Columbus Day', national: true, inDays: 28 }],
    }, { country_name: 'the United States' });
    assert.match(b, /2026-10-12 — Columbus Day \(national\), in 28 days/);
    assert.match(b, /BEFORE they build a plan/);
  });

  test('today and tomorrow are said in words', () => {
    const b = holidayBlock({
      covered: true, rail: 'nager', country: 'TH', from: '2026-09-14', to: '2026-10-14',
      days: [
        { date: '2026-09-14', name: 'A', national: true, inDays: 0 },
        { date: '2026-09-15', name: 'B', national: true, inDays: 1 },
      ],
    });
    assert.match(b, /A \(national\), today/);
    assert.match(b, /B \(national\), tomorrow/);
  });

  test('a pharmacy is never swept up in "everything is shut"', () => {
    // The whole essentials layer exists so somebody ill can find a chemist.
    // A holiday block that says the country is closed would undo it.
    const b = holidayBlock({
      covered: true, rail: 'nager', country: 'TH', from: 'a', to: 'b',
      days: [{ date: '2026-10-23', name: 'Chulalongkorn Day', national: true, inDays: 5 }],
    });
    assert.match(b, /pharmacy or hospital is a different matter/);
  });

  test('the Google rail admits it cannot tell a holiday from an observance', () => {
    const g = holidayBlock({
      covered: true, rail: 'google', country: 'TH', from: 'a', to: 'b',
      days: [{ date: '2026-10-23', name: 'Chulalongkorn Day', national: null, inDays: 5 }],
    });
    assert.match(g, /does not mark which/);
    const n = holidayBlock({
      covered: true, rail: 'nager', country: 'US', from: 'a', to: 'b',
      days: [{ date: '2026-10-12', name: 'Columbus Day', national: true, inDays: 5 }],
    });
    assert.equal(/does not mark which/.test(n), false);
  });

  test('a long list is capped so it cannot swamp the turn', () => {
    const days = Array.from({ length: 40 }, (_, i) => ({
      date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, name: `H${i}`, national: true, inDays: i,
    }));
    const b = holidayBlock({ covered: true, rail: 'nager', country: 'US', from: 'a', to: 'b', days });
    assert.equal(b.split('\n').filter((l) => l.startsWith('  ')).length, 12);
  });

  test('a null result is null, not a crash', () => {
    assert.equal(holidayBlock(null), null);
  });
});

describe('the route', () => {
  const call = (qs, fetchImpl) => handleHolidays(
    new Request(`https://app.itsnum.com/api/travel/holidays${qs}`), {}, { fetchImpl },
  );

  test('a missing country is a 400, not a guess', async () => {
    const res = await call('');
    assert.equal(res.status, 400);
  });

  test('a three-letter code is rejected', async () => {
    assert.equal((await call('?country=THA')).status, 400);
  });

  test('an uncovered country answers 200 with the honest note', async () => {
    const res = await call('?country=NP');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.covered, false);
    assert.match(body.note, /rather than guess/);
  });

  test('a covered country carries no note to explain away', async () => {
    const body = await (await call('?country=US&from=2026-09-14', async () => ({
      ok: true, status: 200, json: async () => [], text: async () => '[]',
    }))).json();
    assert.equal(body.covered, true);
    assert.equal(body.note, null);
  });

  test('the window is clamped so nobody can ask for a century', async () => {
    let asked = 0;
    await call('?country=US&from=2026-09-14&days=99999', async () => {
      asked += 1;
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    });
    // 365 days from mid-September touches two years and no more.
    assert.equal(asked, 2);
  });

  test('a nonsense days value falls back to the default rather than NaN', async () => {
    const body = await (await call('?country=US&from=2026-09-14&days=abc', async () => ({
      ok: true, status: 200, json: async () => [], text: async () => '[]',
    }))).json();
    assert.equal(body.to, '2026-10-14');
  });

  test('the answer is cacheable, because a national calendar is not live data', async () => {
    const res = await call('?country=NP');
    assert.match(res.headers.get('cache-control'), /max-age=\d+/);
  });
});

describe('the turn is actually wired', () => {
  const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
  const IDX = read('index.mjs');
  const PROMPT = read('prompt.mjs');

  test('the block is built from the destination country and reaches the context', () => {
    // Matched as a parameter, not as the END of the parameter list — the list
    // grows, and a test pinned to the closing brace fails on somebody else's
    // unrelated work. Same lesson as `shown` and `entryDocs` before it.
    assert.match(PROMPT, /contextBlock\(\{[\s\S]{0,500}?\bholidays = null\b/);
    assert.match(PROMPT, /if \(holidays\) lines\.push\(holidays\)/);
    assert.match(IDX, /holidaysFor, holidayBlock, covers/);
    assert.match(IDX, /holidays,/);
  });

  test('an uncovered country never reaches the network from the turn', () => {
    // covers() is checked BEFORE holidaysFor is called, so a country with no
    // calendar costs nothing on every single turn in that country.
    assert.match(IDX, /if \(covers\(holidayCc\)\)/);
  });

  test('a calendar that will not load cannot take the turn down with it', () => {
    const slice = IDX.slice(IDX.indexOf('let holidays = null;'), IDX.indexOf('const groundingBlock'));
    assert.match(slice, /try \{/);
    assert.match(slice, /\} catch \{/);
  });

  test('the persona knows the three states are different answers', () => {
    assert.match(PROMPT, /A CLOSED COUNTRY IS NOT A BAD PLAN/);
    assert.match(PROMPT, /never treat a missing calendar as an empty one/);
    assert.match(PROMPT, /never be told to stay in/);
  });

  test('the route exists and is its own path', () => {
    assert.match(IDX, /url\.pathname === '\/api\/travel\/holidays'/);
    assert.match(IDX, /handleHolidays/);
  });
});
