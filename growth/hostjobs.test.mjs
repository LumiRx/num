// The board: people who want a host, and hosts who want clients.
//
// The thing this file mostly tests is what a host CANNOT see. A board of
// travellers' names, dates and addresses published to every host in the city
// is a list of empty homes, and we would have built it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICES, boardFor, covers, km, mineView, redact, validate,
} from './hostjobs.mjs';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);
const stamp = (n) => new Date(NOW + n * 86400000).toISOString().replace('T', ' ').slice(0, 19);

/** A row as it comes out of the database, with everything on it. */
const job = (o = {}) => ({
  id: 'j1', member_id: 'm_priya', status: 'open',
  city: 'Bangkok', country: 'TH', lat: 13.7563, lng: 100.5018,
  services: '["car","reservation"]', detail: 'Airport pickup and a table Friday',
  starts_on: day(3), party_size: 2,
  created_at: stamp(-1), expires_at: stamp(13),
  // Things that must never reach a host before the member chooses them.
  member_name: 'Priya Sharma', member_email: 'priya@example.com',
  member_phone: '+66811112222', address: '14 Sukhumvit Soi 11', notes: 'Staying at the Marriott',
  ...o,
});
const area = (o = {}) => ({ city: 'Bangkok', country: 'TH', lat: 13.75, lng: 100.50, radius_km: 50, ...o });

describe('what a host may see before the member has chosen them', () => {
  const out = redact(job(), { offers: 3 });

  test('nothing that identifies the person', () => {
    const flat = JSON.stringify(out).toLowerCase();
    for (const secret of ['priya', 'example.com', '66811112222', 'sukhumvit', 'marriott', 'm_priya']) {
      assert.ok(!flat.includes(secret), `a host can see "${secret}" before being chosen`);
    }
    for (const k of Object.keys(out)) {
      assert.ok(!/name|email|phone|address|member_id|notes/.test(k), `field "${k}" leaks the person`);
    }
  });

  test('it is an allowlist, so a new column cannot leak by default', () => {
    // A delete-these-fields version stops protecting anyone the day somebody
    // adds `member_whatsapp`.
    const withNewColumn = redact(job({ member_whatsapp: '+66800000000', passport_no: 'X1234' }));
    assert.ok(!JSON.stringify(withNewColumn).includes('66800000000'));
    assert.ok(!JSON.stringify(withNewColumn).includes('X1234'));
  });

  test('but enough to decide whether to offer', () => {
    assert.equal(out.city, 'Bangkok');
    assert.deepEqual(out.services, ['car', 'reservation']);
    assert.equal(out.detail, 'Airport pickup and a table Friday');
    assert.equal(out.starts_on, day(3));
    assert.equal(out.party_size, 2);
  });

  test('how many hosts already offered — a fact about the job, not the person', () => {
    assert.equal(out.offers, 3);
    assert.equal(redact(job(), { mine: true }).offered, true);
    assert.equal(redact(job()).offered, false);
  });

  test('services survive whether they arrive as JSON or as an array', () => {
    assert.deepEqual(redact(job({ services: ['car'] })).services, ['car']);
    assert.deepEqual(redact(job({ services: 'not json' })).services, []);
    assert.deepEqual(redact(job({ services: null })).services, []);
  });
});

describe('who sees which job', () => {
  test('a host covering the place sees it', () => {
    assert.equal(covers(job(), [area()]), true);
  });

  test('a host 400km away does not, whatever their radius says about the city', () => {
    assert.equal(covers(job(), [area({ city: 'Chiang Mai', lat: 18.79, lng: 98.98 })]), false);
  });

  test('city names match without caring about capitals', () => {
    const noCoords = job({ lat: null, lng: null });
    assert.equal(covers(noCoords, [area({ city: 'bangkok', lat: null, lng: null })]), true);
    assert.equal(covers(noCoords, [area({ city: 'Phuket', lat: null, lng: null })]), false);
  });

  test('a missing coordinate is not the point 0,0', () => {
    // Number(null) is 0. Left alone, a host with no coordinates and a job with
    // none both sit in the Gulf of Guinea, nought kilometres apart, and that
    // host is shown every job on earth.
    const nowhere = job({ lat: null, lng: null, city: 'Bangkok' });
    assert.equal(covers(nowhere, [{ city: 'Lisbon', lat: null, lng: null, radius_km: 50 }]), false);
    assert.equal(covers(nowhere, [{ city: 'Lisbon', lat: 0, lng: 0, radius_km: 50 }]), false);
    assert.equal(covers(job({ lat: 0, lng: 0, city: 'Null Island' }),
      [{ city: 'Lisbon', lat: 0, lng: 0, radius_km: 50 }]), true, '0,0 is a real place');
  });

  test('a host with no areas saved sees nothing', () => {
    // hostintegrity already reports this as drift. A host shown jobs they
    // cannot reach learns to ignore the board.
    assert.equal(covers(job(), []), false);
    assert.equal(covers(job(), [{ city: '', lat: null, lng: null }]), false);
  });

  test('coordinates win over the city name when both sides have them', () => {
    // Same city string, 400km apart — the radius the host actually set decides.
    assert.equal(covers(job(), [area({ city: 'Bangkok', lat: 18.79, lng: 98.98 })]), false);
  });

  test('distance is measured on the globe', () => {
    // Bangkok to Chiang Mai, about 580km as the crow flies. (My first draft of
    // this line said 690 and was simply wrong; the code was right.)
    assert.ok(Math.abs(km(13.7563, 100.5018, 18.7883, 98.9853) - 582) < 20);
    assert.equal(km(13.7563, 100.5018, 13.7563, 100.5018), 0);
  });
});

describe('the board', () => {
  const jobs = [
    job({ id: 'soon', starts_on: day(1) }),
    job({ id: 'later', starts_on: day(9) }),
    job({ id: 'undated', starts_on: null, created_at: stamp(-3) }),
    job({ id: 'newer_undated', starts_on: null, created_at: stamp(-1) }),
    job({ id: 'elsewhere', city: 'Lisbon', lat: 38.72, lng: -9.14 }),
    job({ id: 'taken', status: 'matched' }),
    job({ id: 'gone', expires_at: stamp(-1) }),
    job({ id: 'pulled', status: 'withdrawn' }),
  ];
  const out = boardFor(jobs, { areas: [area()], now: NOW });

  test('only open, unexpired jobs in places this host covers', () => {
    assert.deepEqual(out.map((j) => j.id), ['soon', 'later', 'newer_undated', 'undated']);
  });

  test('soonest needed first — not nearest', () => {
    // A job three kilometres away next month is less useful than one across
    // town on Friday, and covering an area already said the distance is fine.
    assert.equal(out[0].id, 'soon');
    assert.equal(out[1].id, 'later');
  });

  test('undated jobs sit after dated ones, newest first', () => {
    assert.deepEqual(out.slice(2).map((j) => j.id), ['newer_undated', 'undated']);
  });

  test('a job this host already offered on is marked, not hidden', () => {
    const marked = boardFor(jobs, { areas: [area()], offers: [{ job_id: 'soon' }], now: NOW });
    assert.equal(marked.find((j) => j.id === 'soon').offered, true);
    assert.equal(marked.find((j) => j.id === 'later').offered, false);
  });

  test('every row on the board is redacted, without exception', () => {
    const flat = JSON.stringify(boardFor(jobs, { areas: [area()], now: NOW })).toLowerCase();
    for (const secret of ['priya', 'example.com', 'sukhumvit', 'm_priya']) {
      assert.ok(!flat.includes(secret), `"${secret}" reached the board`);
    }
  });

  test('an empty board is a board', () => {
    assert.deepEqual(boardFor([], { areas: [area()], now: NOW }), []);
    assert.deepEqual(boardFor(null, { now: NOW }), []);
  });
});

describe('what is worth posting', () => {
  test('a city and at least one service', () => {
    assert.match(validate({ services: ['car'] }).error, /city/i);
    assert.match(validate({ city: 'Bangkok' }).error, /at least one/i);
    assert.equal(validate({ city: 'Bangkok', services: ['car'] }).ok, true);
  });

  test('a service nobody offers is dropped rather than posted', () => {
    const out = validate({ city: 'Bangkok', services: ['car', 'time travel'] });
    assert.deepEqual(out.value.services, ['car']);
    assert.equal(validate({ city: 'Bangkok', services: ['time travel'] }).ok, false);
  });

  test('a party of nobody, or of a thousand, is neither', () => {
    assert.equal(validate({ city: 'B', services: ['car'], party_size: 0 }).value.party_size, 1);
    assert.equal(validate({ city: 'B', services: ['car'], party_size: 9999 }).value.party_size, 60);
    assert.equal(validate({ city: 'B', services: ['car'] }).value.party_size, 1);
  });

  test('a date that is not a date is left empty, never guessed', () => {
    assert.equal(validate({ city: 'B', services: ['car'], starts_on: 'next week' }).value.starts_on, null);
    assert.equal(validate({ city: 'B', services: ['car'], starts_on: '2026-10-01' }).value.starts_on, '2026-10-01');
  });

  test('every service on offer has words a person would recognise', () => {
    for (const [key, s] of Object.entries(SERVICES)) {
      assert.ok(s.label.length > 3, `${key} has no label`);
      assert.ok(s.hint.length > 20, `${key} does not say what it means`);
      assert.ok(!/^[a-z_]+$/.test(s.label), `${key}'s label is a database word`);
    }
  });
});

describe('the member reading their own post', () => {
  test('they see the hosts by name, because a choice needs names', () => {
    const out = mineView(job(), [
      { offer_id: 'o1', host_id: 'h1', name: 'Anna', blurb: 'Ten years in Bangkok' },
      { offer_id: 'o2', host_id: 'h2', name: 'Kit' },
    ]);
    assert.deepEqual(out.offers.map((o) => o.name), ['Anna', 'Kit']);
    assert.equal(out.offers[0].blurb, 'Ten years in Bangkok');
  });

  test('their own details are theirs to see', () => {
    assert.equal(mineView(job(), []).member_name, 'Priya Sharma');
  });
});
