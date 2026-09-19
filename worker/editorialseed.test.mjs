// The seed is a claim NUM will make in its own voice. It gets checked.
//
// Every row asserts something to a guest — "three Michelin stars, 2026" —
// and a wrong one is worse than silence, because a guest can act on it.
// These are the checks the research discipline was built on: a source, a
// date, and no invented weights.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { WEIGHTS, scoreFor, sayIt } from './editorial.mjs';

const DIR = new URL('../data/editorial/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const seeds = files.map((f) => ({ f, data: JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) }));

describe('the editorial seed', () => {
  test('there is one, and it is not empty', () => {
    assert.ok(seeds.length > 0, 'no seed files');
    assert.ok(seeds.some((s) => (s.data.rows ?? []).length > 20), 'seed is too thin to be real research');
  });

  test('every row carries a source and a date', () => {
    // Unsourced rows do not score (editorial.mjs) and undated ones cannot
    // decay — both would sit in the table for ever doing nothing or, worse,
    // something wrong.
    for (const { f, data } of seeds) {
      for (const r of data.rows) {
        assert.ok(r.source && String(r.source).trim(), `${f}: ${r.name} has no source`);
        assert.match(String(r.awarded_on), /^\d{4}-\d{2}-\d{2}$/, `${f}: ${r.name} has no usable date`);
        assert.ok(r.dest && r.name && r.accolade, `${f}: incomplete row ${JSON.stringify(r)}`);
      }
    }
  });

  test('every weight is one the scale actually defines', () => {
    // A hand-typed weight is an opinion smuggled in as data.
    const allowed = new Set(Object.values(WEIGHTS));
    for (const { f, data } of seeds) {
      for (const r of data.rows) {
        assert.ok(allowed.has(r.weight), `${f}: ${r.name} has weight ${r.weight}, which is not in WEIGHTS`);
      }
    }
  });

  test('the revocations are present — they are the whole point', () => {
    const rows = seeds.flatMap((s) => s.data.rows);
    const revoked = rows.filter((r) => r.kind === 'revoked');
    assert.ok(revoked.length >= 4, `expected the known revocations, found ${revoked.length}`);
    const names = revoked.map((r) => r.name);
    for (const n of ['715', 'Camphor', 'Morihiro', 'Masa']) {
      assert.ok(names.includes(n), `${n} lost an accolade in 2025-26 and must be recorded as such`);
    }
  });

  test('a demoted venue nets out below an undecorated one', () => {
    // Masa is the test case: three stars removed, two retained. It should
    // still rank as a serious restaurant, but not as a three-star one.
    const rows = seeds.flatMap((s) => s.data.rows).filter((r) => r.name === 'Masa');
    assert.equal(rows.length, 2, 'Masa needs both the demotion and the retained two stars');
    const line = sayIt(rows, new Date('2026-09-19T00:00:00Z'));
    assert.match(line, /Two Michelin stars/, `NUM must say two stars, not three — got ${line}`);
    assert.ok(!/Three/i.test(line), 'NUM must never call Masa three-star again');
  });

  test('a fully stripped venue is pushed below zero', () => {
    const rows = seeds.flatMap((s) => s.data.rows).filter((r) => r.name === 'Camphor');
    assert.ok(scoreFor(rows, new Date('2026-09-19T00:00:00Z')) < 0, 'a stripped venue must be demoted, not merely un-boosted');
  });

  test('relocations and disputes are carried as notes, not silently dropped', () => {
    const rows = seeds.flatMap((s) => s.data.rows);
    const angels = rows.find((r) => r.name === "Angel's Share");
    assert.ok(angels?.note && /relocat/i.test(angels.note), "Angel's Share moved; the note must say so");
    const gaggan = rows.find((r) => r.name === 'Gaggan');
    assert.ok(gaggan?.note && /address/i.test(gaggan.note), 'Gaggan has moved before — the caveat must survive');
  });

  test('no duplicate accolade for the same venue, source and date', () => {
    // Mirrors the table's UNIQUE. The key includes the ACCOLADE because one
    // ceremony issues several facts about one venue — Michelin stripped Masa's
    // third star and confirmed its remaining two on the same day. Keying
    // without the accolade made those mutually exclusive, and this test is
    // what caught it before the seed hit the database.
    for (const { f, data } of seeds) {
      const seen = new Set();
      for (const r of data.rows) {
        const k = `${r.dest}|${r.name}|${r.source}|${r.awarded_on}|${r.accolade}`;
        assert.ok(!seen.has(k), `${f}: duplicate row for ${k}`);
        seen.add(k);
      }
    }
  });
});
