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
import { fold, statementsFor, SQL_FOLD, sqlFoldInJs, FOLD_SUBS } from '../scripts/load_editorial.mjs';
import { DatabaseSync } from 'node:sqlite';

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

// ── THE TWO FOLDS MUST AGREE ──────────────────────────────────────────────
//
// load_editorial.mjs folds names twice: once in JS (fold(), used by tooling
// and by every test that reasons about matching) and once in SQLite (SQL_FOLD,
// which does the matching that actually decides what a guest sees). They were
// written separately and they diverged: the JS stripped every non-alphanumeric,
// the SQL stripped three characters. One comma was enough to leave a
// permanently closed hotel — The Standard, Hollywood — unmatched and therefore
// still recommendable.
//
// A miss is survivable; this whole loader is built to miss rather than guess.
// A miss nobody knows about is not.
describe('the JS fold and the SQL fold agree', () => {
  // sqlFoldInJs runs the very substitution list that builds the SQL, so this
  // compares the real SQL semantics rather than a hopeful restatement of them.
  const asSqlite = sqlFoldInJs;


  test('the generated expression is balanced — this failed at the database once', () => {
    const e = SQL_FOLD('p.name');
    assert.equal((e.match(/\(/g) || []).length, (e.match(/\)/g) || []).length,
      'unbalanced parens: SQLite closes lower() early and rejects the UPDATE');
    assert.equal((e.match(/replace\(/g) || []).length, FOLD_SUBS.length,
      'one replace( per substitution, or the arity is wrong');
  });

  test('SQL_FOLD is the expression the UPDATE actually uses', () => {
    const sql = statementsFor({ rows: [] }).join('\n');
    assert.ok(sql.includes(SQL_FOLD('p.name')), 'the match UPDATE no longer uses SQL_FOLD');
    assert.ok(sql.includes(SQL_FOLD('num_editorial.name')), 'the match UPDATE no longer folds the seed side');
  });

  test('the comma that hid a closed hotel is folded on both sides', () => {
    assert.equal(fold('The Standard, Hollywood'), fold('The Standard Hollywood'));
    assert.equal(asSqlite('The Standard, Hollywood'), asSqlite('The Standard Hollywood'));
  });

  test('both folds agree on every ASCII name in the seed', () => {
    // Accents are the ONE known divergence: SQLite cannot strip them, so
    // 'Mírate' folds to 'mirate' in JS and stays 'mírate' in SQL. That is a
    // miss, never a wrong match. Asserted explicitly so it stays deliberate.
    const accented = [];
    for (const { f, data } of seeds) {
      for (const r of data.rows) {
        if (/[^\x00-\x7F]/.test(r.name)) { accented.push(r.name); continue; }
        assert.equal(asSqlite(r.name), fold(r.name).replace(/ and /g, ' and '),
          `${f}: the two folds disagree on "${r.name}"`);
      }
    }
    assert.ok(accented.length < 15, `${accented.length} accented names is more divergence than expected`);
  });
});

// ── A CITATION MUST BE ABLE TO ARRIVE LATE ───────────────────────────────
//
// The loader is INSERT OR IGNORE, which is what makes re-running research
// safe. It also meant that for a row already in the database, nothing in the
// seed could ever reach it again — so when 24 rows that had loaded with no
// url were re-verified against the published rankings and the urls written
// into the seed, the database kept serving the uncited version and only a
// hand-written migration could have changed that.
//
// The upsert added on 19 Sep 2026 fills a missing url and touches nothing
// else. These run the generated SQL against real SQLite, because the whole
// question is what the database does with a conflict, and no amount of
// reading the string answers it.
describe('loading the same research twice', () => {
  const row = (over = {}) => ({
    dest: 'new-york', name: 'Le Bernardin', bucket: 'eat', accolade: 'Three Michelin stars',
    kind: 'star', weight: WEIGHTS.michelin_3, source: 'MICHELIN Guide',
    awarded_on: '2026-01-01', ...over,
  });
  const TABLE = `CREATE TABLE num_editorial (
    id TEXT PRIMARY KEY, dest TEXT, place_id TEXT, name TEXT, bucket TEXT,
    accolade TEXT, kind TEXT, weight INTEGER, source TEXT, url TEXT,
    awarded_on TEXT, note TEXT,
    UNIQUE (dest, name, source, awarded_on, accolade));
  CREATE TABLE places (id TEXT, dest TEXT, name TEXT);`;

  const load = (db, rows) => {
    for (const sql of statementsFor({ rows })) db.exec(sql);
  };
  const open = () => { const db = new DatabaseSync(':memory:'); db.exec(TABLE); return db; };
  const urlOf = (db) => db.prepare('SELECT url FROM num_editorial').get().url;

  test('a url written into the seed later reaches a row already loaded', () => {
    const db = open();
    load(db, [row({ url: null })]);
    assert.equal(urlOf(db), null, 'the first load should not have invented a citation');
    load(db, [row({ url: 'https://example.com/list' })]);
    assert.equal(urlOf(db), 'https://example.com/list', 'the citation never arrived');
    db.close();
  });

  test('a citation already in the database is never replaced', () => {
    // Whatever is in there was checked by somebody. A re-load is not a reason
    // to prefer the newer string.
    const db = open();
    load(db, [row({ url: 'https://checked.example/first' })]);
    load(db, [row({ url: 'https://example.com/second' })]);
    assert.equal(urlOf(db), 'https://checked.example/first');
    db.close();
  });

  test('re-loading changes nothing a guest would feel', () => {
    // The score is the promise. A weight, accolade or date must not move,
    // whatever a later seed says, or a re-run of the research silently
    // re-ranks the city.
    const db = open();
    load(db, [row()]);
    load(db, [row({ weight: WEIGHTS.michelin_1, accolade: 'Three Michelin stars' })]);
    const got = db.prepare('SELECT weight, accolade, awarded_on FROM num_editorial').get();
    assert.equal(got.weight, WEIGHTS.michelin_3, 'a re-load moved the weight');
    assert.equal(got.accolade, 'Three Michelin stars');
    assert.equal(got.awarded_on, '2026-01-01');
    db.close();
  });

  test('a row already held under an older id does not abort the load', () => {
    // The table has a second UNIQUE, on the natural key. An upsert clause
    // only handles the conflict it names, so without OR IGNORE this case
    // throws — and one such row would take the whole seed down with it.
    const db = open();
    db.exec(`INSERT INTO num_editorial (id, dest, name, bucket, accolade, kind, weight, source, awarded_on)
             VALUES ('an-older-id', 'new-york', 'Le Bernardin', 'eat', 'Three Michelin stars',
                     'star', ${WEIGHTS.michelin_3}, 'MICHELIN Guide', '2026-01-01');`);
    assert.doesNotThrow(() => load(db, [row({ url: 'https://example.com/list' })]));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_editorial').get().n, 1, 'the row was duplicated');
    db.close();
  });
});
