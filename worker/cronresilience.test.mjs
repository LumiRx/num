// NOTHING STOPS, AND NOTHING GETS LOST.
//
// 19 Sep 2026. The booking crawler wrote 40 rows every five minutes without a
// gap, stopped dead at 20:16, and stayed stopped for over two hours with
// 339,356 venues still queued. Every health check was green throughout: the
// cron fired, D1 wrote, the site answered, a brain replied. It was found by
// somebody querying the table for an unrelated reason.
//
// Two faults, one lesson each:
//
//   1. In the bizapproval cron closure, `hoursbackfill`, `bookingbackfill` and
//      `consensus` were each carefully wrapped in their own try/catch — and
//      all three sat behind awaits that had none. A guarded step behind an
//      unguarded one is not guarded.
//
//   2. Nothing watched them. The monitor knew the front door was open and did
//      not know the machinery behind it had stopped.
//
// These tests pin both. The first is a source assertion on purpose: the bug
// was not a wrong value, it was an await without a guard, and only the shape
// of the code shows that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SRC = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

/** The bizapproval closure: from its waitUntil to its trailing .catch. */
function bizClosure() {
  // Anchored on the closure's own first statement, not on the module name:
  // './bizapproval.mjs' is imported by an admin route far earlier in the file,
  // and anchoring there sliced in 150 unrelated handlers.
  const start = SRC.indexOf('let autoApproveAll = null, staleDigest = null;');
  assert.ok(start > -1, 'the bizapproval cron closure has moved or gone');
  const end = SRC.indexOf("})().catch((e) => console.error('[bizapproval]'", start);
  assert.ok(end > start, 'could not find the end of the bizapproval closure');
  return SRC.slice(start, end);
}

test('every await in the bizapproval cron chain is individually guarded', () => {
  const body = bizClosure();
  const lines = body.split('\n');

  // Track try-depth by brace counting from the `try {` keyword. Crude, and
  // right for this shape: every guard in this file is a flat `try { … } catch`.
  let depth = 0;
  const unguarded = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\/\//.test(line)) continue;
    const opensTry = /^try\s*\{/.test(line);
    if (depth > 0) {
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
      if (depth < 0) depth = 0;
      continue;
    }
    if (opensTry) { depth = 1; continue; }
    if (/\bawait\b/.test(line)) unguarded.push(line);
  }

  assert.deepEqual(unguarded, [],
    'an await outside a try/catch in this chain takes every job below it down '
    + `silently. Unguarded: ${unguarded.join(' || ')}`);
});

test('the three sweeps are still the jobs this protects', () => {
  const body = bizClosure();
  for (const job of ['backfillHours', 'backfillBookings', 'runConsensus']) {
    assert.ok(body.includes(job), `${job} is no longer in the chain these guards exist for`);
  }
});

/* ── the watchman ──────────────────────────────────────────────────── */

function dbWith({ lastScan, unscanned }) {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE places (id TEXT PRIMARY KEY, website TEXT, booking_platform TEXT);
    CREATE TABLE num_booking_scan (place_id TEXT PRIMARY KEY, outcome TEXT, checked_at TEXT);
  `);
  d.prepare('INSERT INTO places (id,website,booking_platform) VALUES (?,?,NULL)').run('p_done', 'https://a.test');
  d.prepare('INSERT INTO num_booking_scan (place_id,outcome,checked_at) VALUES (?,?,?)')
    .run('p_done', 'none', lastScan);
  if (unscanned) {
    d.prepare('INSERT INTO places (id,website,booking_platform) VALUES (?,?,NULL)').run('p_todo', 'https://b.test');
  }
  return {
    DB: {
      prepare(sql) {
        const bound = [];
        const api = {
          bind(...a) { bound.push(...a); return api; },
          async first() { return d.prepare(sql).get(...bound) ?? null; },
          async all() { return { results: d.prepare(sql).all(...bound) }; },
          async run() { return { meta: { changes: 0 } }; },
        };
        return api;
      },
    },
  };
}

const iso = (minsAgo) =>
  new Date(Date.now() - minsAgo * 60000).toISOString().slice(0, 19).replace('T', ' ');

async function sweeps(env) {
  // checkSweeps directly rather than through runHealth: the full run also
  // fetches itsnum.com and writes to D1, and a unit test that needs the
  // internet to check a timestamp is a test that goes red for the wrong reason.
  const { checkSweeps } = await import('./health.mjs');
  return checkSweeps(env);
}

test('a crawler that has gone quiet with work still queued is NOT ok', async () => {
  const env = dbWith({ lastScan: iso(140), unscanned: true });
  const s = await sweeps(env);
  assert.ok(s, 'health must expose a sweeps check');
  assert.equal(s.ok, false, 'two hours of silence with a full queue is the exact outage this exists for');
  assert.equal(s.booking_sweep, 'stalled');
  assert.ok(s.quiet_minutes >= 120);
  assert.match(s.remedy, /queue is not empty/i);
});

test('a crawler that ticked a moment ago is fine', async () => {
  const env = dbWith({ lastScan: iso(3), unscanned: true });
  const s = await sweeps(env);
  assert.equal(s.ok, true);
  assert.equal(s.booking_sweep, 'running');
});

test('silence with an EMPTY queue is success, not an alarm', async () => {
  // A finished crawler is supposed to stop writing. An alarm that fires on
  // completion is an alarm somebody switches off, and then it is not an alarm.
  const env = dbWith({ lastScan: iso(600), unscanned: false });
  const s = await sweeps(env);
  assert.equal(s.ok, true, 'a finished queue must never be reported as a stall');
  assert.equal(s.booking_sweep, 'queue empty');
});

test('a sweep that has never run is not a stalled sweep', async () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE places (id TEXT PRIMARY KEY, website TEXT, booking_platform TEXT);
    CREATE TABLE num_booking_scan (place_id TEXT PRIMARY KEY, outcome TEXT, checked_at TEXT);
    INSERT INTO places (id,website,booking_platform) VALUES ('p1','https://a.test',NULL);
  `);
  const env = { DB: { prepare(sql) {
    const bound = [];
    const api = { bind(...a) { bound.push(...a); return api; },
      async first() { return d.prepare(sql).get(...bound) ?? null; },
      async all() { return { results: d.prepare(sql).all(...bound) }; },
      async run() { return { meta: { changes: 0 } }; } };
    return api;
  } } };
  const s = await sweeps(env);
  assert.equal(s.ok, true);
  assert.equal(s.booking_sweep, 'never run');
});

test('a failed read is reported as unknown, never as a stall', async () => {
  const env = { DB: { prepare() { throw new Error('D1 is having a day'); } } };
  const s = await sweeps(env);
  assert.equal(s.ok, true, 'a monitor that cannot read must not invent an outage');
  assert.equal(s.booking_sweep, 'unknown');
});

test('a stalled sweep is degraded, not down', async () => {
  // The product still answers guests while a crawler sleeps. Putting this in
  // DOWN would page somebody at 3am for a job that can wait until morning —
  // and a pager that cries wolf is how the next real outage gets ignored.
  const health = readFileSync(new URL('./health.mjs', import.meta.url), 'utf8');
  const down = /const DOWN = \[([^\]]*)\]/.exec(health);
  assert.ok(down, 'the DOWN list has moved');
  assert.doesNotMatch(down[1], /sweeps/, 'a sleeping crawler is not the product being down');
});
