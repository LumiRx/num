// The outbound inventory — who Num can hand a guest to.
//
// This list is what an affiliate application asks for on question one, and it
// used to live in four separate tables nobody could read at once. handoffHosts()
// derives it by running the REAL link builders, so it cannot drift from the
// code the way a hand-kept list does. These tests exist to keep that true: they
// assert the derivation actually walks the tables, not that the list contains
// particular companies.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handoffHosts, AIRLINES, HOTEL_GROUPS } from './services.mjs';

const hosts = handoffHosts();
const byHost = new Map(hosts.map((h) => [h.host, h]));

describe('handoffHosts()', () => {
  test('every entry is a real https host with a usable sample link', () => {
    assert.ok(hosts.length > 50, `only ${hosts.length} hosts — the walk is not reaching the tables`);
    for (const h of hosts) {
      const u = new URL(h.sample);
      assert.equal(u.protocol, 'https:', `${h.host} is handed out over plain http`);
      assert.equal(u.hostname.replace(/^www\./, '').toLowerCase(), h.host);
      assert.ok(h.providers.length > 0);
      assert.ok(h.kinds.length > 0);
      assert.ok(h.countries.length > 0);
    }
  });

  test('hosts are unique — one row per company, not one per country', () => {
    assert.equal(byHost.size, hosts.length);
  });

  test('a provider used in many countries reports many countries', () => {
    // Uber is mapped in the majority of BY_COUNTRY. If reach collapses to 1
    // the country walk has stopped happening and the ranking is meaningless.
    const uber = hosts.find((h) => h.host.endsWith('uber.com') && h.kinds.includes('ride'));
    assert.ok(uber, 'no ride host resolving to uber.com');
    assert.ok(uber.countries.length > 10, `uber reach is ${uber.countries.length}`);
  });

  test('the fallback country is exercised, so an unmapped country still gets providers', () => {
    // 'XX' is in no table; it must fall through to FALLBACK rather than
    // producing an empty option list and a guest with nothing to tap.
    const fallbackHosts = hosts.filter((h) => h.countries.includes('XX'));
    assert.ok(fallbackHosts.length >= 4, 'FALLBACK produced almost nothing');
    for (const kind of ['ride', 'food', 'table', 'wellness']) {
      assert.ok(fallbackHosts.some((h) => h.kinds.includes(kind)), `no fallback for ${kind}`);
    }
  });

  test('travel is global, not per country', () => {
    for (const kind of ['flight', 'hotel', 'rail']) {
      const any = hosts.filter((h) => h.kinds.includes(kind));
      assert.ok(any.length > 0, `no ${kind} host`);
      assert.ok(any.every((h) => h.countries.includes('*')), `${kind} was bucketed by country`);
    }
  });

  test('every airline and hotel group appears — they are traffic too', () => {
    // These are handed out by the prompt when a guest holds status, so
    // optionsFor() never names them. Leaving them out of the inventory is how
    // a programme with real volume stays invisible on the application queue.
    const seen = new Set(hosts.flatMap((h) => h.providers));
    for (const id of Object.keys(AIRLINES)) assert.ok(seen.has(id), `airline missing: ${id}`);
    for (const id of Object.keys(HOTEL_GROUPS)) assert.ok(seen.has(id), `hotel group missing: ${id}`);
  });

  test('sorted by reach, widest first', () => {
    const score = (h) => h.countries.length * h.kinds.length;
    for (let i = 1; i < hosts.length; i++) {
      assert.ok(score(hosts[i - 1]) >= score(hosts[i]), `out of order at ${i}`);
    }
  });

  test('no sample link carries a guest detail', () => {
    // The samples are printed by a script and pasted into application forms.
    // They are built from a fixed fake context on purpose.
    for (const h of hosts) {
      assert.ok(!/@/.test(h.sample), `${h.host} sample contains an @`);
      assert.ok(!/mem_/.test(h.sample), `${h.host} sample contains a member id`);
    }
  });
});
