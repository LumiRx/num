import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseFlightNo, shape, nextPollMs, diff, copyFor } from './flightwatch.mjs';

const T = (iso) => ({ utc: iso.replace('T', ' ').replace(':00Z', 'Z'), local: iso.replace('T', ' ').slice(0, 16) + '+07:00' });
const raw = (over = {}) => ({
  number: 'TG 917', status: 'Expected', airline: { name: 'Thai Airways' },
  departure: { airport: { iata: 'LHR', name: 'London Heathrow' }, scheduledTime: T('2026-09-16T20:25:00Z'), terminal: '2', gate: 'C4' },
  arrival: { airport: { iata: 'BKK', name: 'Suvarnabhumi' }, scheduledTime: T('2026-09-17T08:00:00Z') },
  ...over,
});

test('flight numbers are normalised, and nonsense is refused', () => {
  assert.equal(normaliseFlightNo('tg 917'), 'TG917');
  assert.equal(normaliseFlightNo('TG-917'), 'TG917');
  assert.equal(normaliseFlightNo('dinner tonight'), null);
});

test('shape keeps only what the card needs and drops the space in the number', () => {
  const f = shape(raw());
  assert.equal(f.number, 'TG917');
  assert.equal(f.dep.iata, 'LHR');
  assert.equal(f.arr.sched, '2026-09-17 08:00Z');
  assert.equal(f.dep.gate, 'C4');
});

test('the cadence tightens as departure nears and stops after arrival', () => {
  const f = shape(raw());
  const dep = Date.parse('2026-09-16T20:25:00Z');
  assert.equal(nextPollMs(f, dep - 48 * 3600_000), 24 * 3600_000, 'two days out: once a day');
  assert.equal(nextPollMs(f, dep - 10 * 3600_000), 3 * 3600_000, 'ten hours out: every 3h');
  assert.equal(nextPollMs(f, dep - 60 * 60000), 20 * 60000, 'an hour out: every 20 min');
  assert.equal(nextPollMs(f, dep + 3 * 3600_000), 45 * 60000, 'in the air: every 45 min');
  assert.equal(nextPollMs(f, Date.parse('2026-09-17T07:40:00Z')), 10 * 60000, 'last 45 min: every 10');
  assert.equal(nextPollMs(f, Date.parse('2026-09-17T09:00:00Z')), 0, 'an hour after arrival: done');
  assert.equal(nextPollMs({ ...f, status: 'Canceled' }, dep - 3600_000), 0, 'cancelled: done');
});

test('a 13-minute revision is not a push; 15 is; a gate change is; landing is', () => {
  const before = shape(raw());
  const thirteen = shape(raw({ arrival: { ...raw().arrival, revisedTime: T('2026-09-17T08:13:00Z') } }));
  assert.deepEqual(diff(before, thirteen), []);
  const fifteen = shape(raw({ arrival: { ...raw().arrival, revisedTime: T('2026-09-17T08:15:00Z') } }));
  assert.equal(diff(before, fifteen)[0].kind, 'delay');
  assert.equal(diff(before, fifteen)[0].minutes, 15);
  const gate = shape(raw({ departure: { ...raw().departure, gate: 'D2' } }));
  assert.deepEqual(diff(before, gate), [{ kind: 'gate', from: 'C4', to: 'D2' }]);
  const landed = shape(raw({ status: 'Arrived', arrival: { ...raw().arrival, revisedTime: T('2026-09-17T08:13:00Z'), baggageBelt: '7' } }));
  assert.equal(diff(before, landed).find((e) => e.kind === 'landed').belt, '7');
});

test('the copy has a number in it and never says booked', () => {
  const f = shape(raw());
  const c = copyFor({ kind: 'delay', minutes: 13, arr_local: '2026-09-17 15:13+07:00' }, f);
  assert.equal(c.title, 'TG917 is 13 min late');
  assert.match(c.body, /15:13/);
  const g = copyFor({ kind: 'gate', from: 'C4', to: 'D2' }, f);
  assert.match(g.title, /C4 → D2/);
  for (const ev of [{ kind: 'cancelled' }, { kind: 'landed', at_local: '2026-09-17 15:13+07:00', belt: '7' }, { kind: 'boarding', gate: 'D2' }]) {
    const x = copyFor(ev, f);
    assert.doesNotMatch(`${x.title} ${x.body}`, /booked/i);
  }
});
