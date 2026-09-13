// The Friday draw's entry path, asserted against the REAL migration SQL.
//
// ── WHY THIS FILE WAS REWRITTEN, 13 SEP ──────────────────────────────────
//
// The version this replaces ran against a hand-written fake `env.DB` that
// recorded the SQL string and reported one changed row. It passed every test
// while the shipped code wrote to columns that did not exist in production.
//
// A fake database accepts any statement, so it can only ever check that the
// code called something. The entire bug it needed to catch — two modules
// disagreeing with one schema — is invisible to it by construction.
//
// So the harness below loads 0023 (the table that is live) and 0026 (the one
// that fixes it) and runs the real statements against real SQLite. If a column
// name drifts from the migration again, these fail here rather than in front of
// somebody who was promised a prize.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  weekStart, weekEnd, entrantKey, enter, eligibleCount, phoneForMember,
  ENTRY_KEYWORD, ENTRY_REPLY, E164,
} from './giveaway.mjs';

const M23 = readFileSync(new URL('./migrations/0023_giveaway.sql', import.meta.url), 'utf8');
const M26 = readFileSync(new URL('./migrations/0026_giveaway_entrant_key.sql', import.meta.url), 'utf8');

const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const utc = (s) => new Date(s * 1000).toUTCString();
const nz = (v) => (v === undefined ? null : v);

function expand(sql, binds) {
  if (!/\?\d/.test(sql)) return { sql, args: binds.map(nz) };
  const args = [];
  const out = sql.replace(/\?(\d+)/g, (_, n) => { args.push(nz(binds[Number(n) - 1])); return '?'; });
  return { sql: out, args };
}

/** env.DB in the shape the Worker calls, including `meta.changes`. */
function d1(db) {
  return {
    prepare(sql) {
      const binds = [];
      const go = (fn) => { const e = expand(sql, binds); return db.prepare(e.sql)[fn](...e.args); };
      const api = {
        bind(...a) { binds.push(...a); return api; },
        async first() { return go('all')[0] ?? null; },
        async all() { return { results: go('all') }; },
        async run() { const r = go('run'); return { meta: { changes: Number(r?.changes ?? 0) } }; },
      };
      return api;
    },
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0);');
  let created = 0;
  for (const raw of (M23 + '\n' + M26).split(';')) {
    const stmt = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (!stmt) continue;
    db.exec(stmt + ';');
    if (/^CREATE TABLE/i.test(stmt)) created++;
  }
  assert.equal(created, 5, 'expected 0023 and 0026 to create five tables between them');
  return db;
}

const envOf = (db) => ({ DB: d1(db) });
const FRI = at('2026-09-18T09:00:00Z');

/* ─────────────────────────── the entry period ─────────────────────────── */

test('an entry period opens on Friday 00:00 UTC, not Monday and not local midnight', () => {
  assert.equal(utc(weekStart(at('2026-09-18T00:00:00Z'))), 'Fri, 18 Sep 2026 00:00:00 GMT');
  assert.equal(utc(weekStart(at('2026-09-18T00:00:01Z'))), 'Fri, 18 Sep 2026 00:00:00 GMT');
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
  assert.equal(utc(weekStart(at('2026-10-30T12:00:00Z'))), 'Fri, 30 Oct 2026 00:00:00 GMT');
  assert.equal(utc(weekStart(at('2026-11-05T12:00:00Z'))), 'Fri, 30 Oct 2026 00:00:00 GMT');
  assert.equal(utc(weekStart(at('2026-11-06T12:00:00Z'))), 'Fri, 06 Nov 2026 00:00:00 GMT');
});

test('a period ends one second before the next one opens — no gap, no overlap', () => {
  const a = weekStart(FRI);
  assert.equal(weekEnd(a) + 1, weekStart(at('2026-09-25T00:00:00Z')));
});

/* ────────────────────────── the entrant key ───────────────────────────── */

test('a phone always wins the key, because it is what both doors can produce', () => {
  assert.equal(entrantKey({ phone: '+447700900123' }), 'phone:+447700900123');
  assert.equal(entrantKey({ phone: '+447700900123', memberId: 'mem_a' }), 'phone:+447700900123');
});

test('a member with no phone still gets a key — 73% of members have no number', () => {
  assert.equal(entrantKey({ memberId: 'mem_a' }), 'member:mem_a');
  assert.equal(entrantKey({ phone: '', memberId: 'mem_a' }), 'member:mem_a');
  assert.equal(entrantKey({ phone: 'not a phone', memberId: 'mem_a' }), 'member:mem_a');
});

test('neither is null, never an invented key', () => {
  assert.equal(entrantKey({}), null);
  assert.equal(entrantKey({ phone: '0771234', memberId: '' }), null);
});

test('E164 refuses the shapes people actually type', () => {
  for (const bad of ['07700900123', '+0770090012', '447700900123', '+44 7700 900123', '']) {
    assert.equal(E164.test(bad), false, bad);
  }
  assert.equal(E164.test('+447700900123'), true);
});

/* ──────────────────────────── writing an entry ────────────────────────── */

test('an entry is written against the period, with the phone and the route on it', async () => {
  const db = freshDb();
  const r = await enter(envOf(db), { phone: '+447700900123', source: 'sms', now: FRI });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.key, 'phone:+447700900123');

  const row = db.prepare('SELECT * FROM num_giveaway_entrants').all()[0];
  assert.equal(row.entrant_key, 'phone:+447700900123');
  assert.equal(row.phone, '+447700900123');
  assert.equal(row.source, 'sms');
  assert.equal(row.week_start, weekStart(FRI));
});

test('a repeat text in the same period does not add a second entry', async () => {
  const db = freshDb();
  const env = envOf(db);
  await enter(env, { phone: '+447700900123', now: FRI });
  const again = await enter(env, { phone: '+447700900123', now: FRI });
  assert.equal(again.ok, true);
  assert.equal(again.created, false, 'the second text must not create a row');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM num_giveaway_entrants').all()[0].n, 1);
});

test('the same person entering by BOTH doors holds one ticket, not two', async () => {
  const db = freshDb();
  const env = envOf(db);
  db.exec("INSERT INTO num_members (id,name,phone) VALUES ('mem_dre','Dre','+447700900123')");

  await enter(env, { phone: '+447700900123', source: 'sms', now: FRI });
  // The app path resolves the number first — that is what makes the keys meet.
  const phone = await phoneForMember(env, 'mem_dre');
  const second = await enter(env, { phone, memberId: 'mem_dre', source: 'app', now: FRI });

  assert.equal(second.created, false, 'the app entry must collapse onto the text entry');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM num_giveaway_entrants').all()[0].n, 1);
  assert.equal(await eligibleCount(env, FRI), 1);
});

test('a member with no number on file can still enter, and counts once', async () => {
  const db = freshDb();
  const env = envOf(db);
  db.exec("INSERT INTO num_members (id,name,phone) VALUES ('mem_e','Emailer',NULL)");
  assert.equal(await phoneForMember(env, 'mem_e'), null);

  const a = await enter(env, { phone: null, memberId: 'mem_e', source: 'app', now: FRI });
  const b = await enter(env, { phone: null, memberId: 'mem_e', source: 'app', now: FRI });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.key, 'member:mem_e');
  assert.equal(await eligibleCount(env, FRI), 1);
});

test('two different people in one period are two entries', async () => {
  const db = freshDb();
  const env = envOf(db);
  await enter(env, { phone: '+447700900123', now: FRI });
  await enter(env, { phone: '+14155550199', now: FRI });
  await enter(env, { memberId: 'mem_solo', now: FRI });
  assert.equal(await eligibleCount(env, FRI), 3);
});

test('the same person next week is a new entry, because it is a new draw', async () => {
  const db = freshDb();
  const env = envOf(db);
  await enter(env, { phone: '+447700900123', now: FRI });
  const next = await enter(env, { phone: '+447700900123', now: at('2026-09-25T09:00:00Z') });
  assert.equal(next.created, true);
  assert.equal(await eligibleCount(env, FRI), 1, 'last week still has exactly one');
  assert.equal(await eligibleCount(env, at('2026-09-25T09:00:00Z')), 1);
});

test('a malformed number is refused rather than stored as a person', async () => {
  const db = freshDb();
  const r = await enter(envOf(db), { phone: '07700900123', now: FRI });
  assert.equal(r.ok, false);
  assert.match(r.error, /E\.164/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM num_giveaway_entrants').all()[0].n, 0);
});

test('no phone and no member is refused, never keyed on nothing', async () => {
  const db = freshDb();
  const r = await enter(envOf(db), { now: FRI });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing to enter/);
});

test('a write failure is reported, never returned as a successful entry', async () => {
  const env = { DB: { prepare() { throw new Error('no such column: week_key'); } } };
  const r = await enter(env, { phone: '+447700900123', now: FRI });
  assert.equal(r.ok, false, 'the exact production failure must not read as ok');
  assert.match(r.error, /no such column/);
});

/* ───────────────────────── the migration itself ───────────────────────── */

test('0026 carries every 0023 row forward, keyed by phone', async () => {
  // A database that already has live SMS entries in the old table, as production does.
  const db = new DatabaseSync(':memory:');
  for (const raw of M23.split(';')) {
    const s = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (s) db.exec(s + ';');
  }
  db.exec("INSERT INTO num_giveaway_entries (id,phone,member_id,week_start,source,created_at)"
    + " VALUES ('ge_old','+447700900123',NULL,1789344000,'sms',1789344100)");
  for (const raw of M26.split(';')) {
    const s = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (s) db.exec(s + ';');
  }
  const row = db.prepare('SELECT * FROM num_giveaway_entrants').all()[0];
  assert.equal(row.id, 'ge_old', 'the id is carried, so a re-run cannot duplicate it');
  assert.equal(row.entrant_key, 'phone:+447700900123');
  assert.equal(row.week_start, 1789344000);
  // Nothing was dropped. The old table is still there, untouched.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM num_giveaway_entries').all()[0].n, 1);
});

test('0026 is safe to run twice — no drops, no renames, no duplicate rows', () => {
  const db = freshDb();
  db.exec("INSERT INTO num_giveaway_entries (id,phone,member_id,week_start,source,created_at)"
    + " VALUES ('ge_x','+14155550199',NULL,1789344000,'sms',1)");
  for (let pass = 0; pass < 2; pass += 1) {
    for (const raw of M26.split(';')) {
      const s = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
      if (s) db.exec(s + ';');
    }
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM num_giveaway_entrants').all()[0].n, 1);
});

/* ──────────────────────────── the reply text ──────────────────────────── */

test('the keyword and the confirmation are what the rules page promises', () => {
  assert.equal(ENTRY_KEYWORD, 'PACKS');
  assert.ok(ENTRY_REPLY.length <= 160, `one SMS segment, got ${ENTRY_REPLY.length}`);
  assert.match(ENTRY_REPLY, /itsnum\.com\/friday-rules/);
  assert.match(ENTRY_REPLY, /STOP/);
});
