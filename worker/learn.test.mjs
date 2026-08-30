// The first closed loop.
//
// Until 26 Aug 2026 nothing NUM recorded ever changed NUM's behaviour.
// num_asks and num_place_impressions were write-only and ai/places.js read
// neither, so every term in the ranking score had been crawled off the open
// web: Google's stars, Google's review count, whether we hold a phone number.
// A place NUM had recommended four hundred times scored exactly like one it
// had never mentioned.
//
// These tests are about the three ways a loop like this goes wrong:
//
//   1. it learns from the wrong signal (taps, which measure what was already
//      promoted, rather than ratings, which measure how the evening went),
//   2. it lets a thin sample act like a thick one,
//   3. it becomes purchasable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  rollupRatings, learningState, lift, SCORE_TERM,
  MIN_RATINGS, NEUTRAL, WEIGHT, MAX_LIFT, MAX_SINK, _resetSchemaCache,
} from './learn.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLACES = readFileSync(join(HERE, '../ai/places.js'), 'utf8');
const LEARN = readFileSync(join(HERE, 'learn.mjs'), 'utf8');
// The file with its prose stripped, so learn.mjs can SAY "money" in a comment
// about never taking money without failing the test that enforces it.
const LEARN_CODE = LEARN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function env() {
  _resetSchemaCache();
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, rating REAL, reviews INTEGER,
            status TEXT, website TEXT, phone TEXT, km REAL,
            num_rating REAL, num_rating_n INTEGER NOT NULL DEFAULT 0, num_rated_at TEXT);
          CREATE TABLE num_ratings (id TEXT PRIMARY KEY, booking_id TEXT, place_id TEXT,
            stars INTEGER, created_at TEXT DEFAULT (datetime('now')));`);
  const DB = {
    prepare(q) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        run: async () => { d.prepare(q).run(...args.map((v) => v ?? null)); return { meta: {} }; },
        first: async () => d.prepare(q).get(...args.map((v) => v ?? null)) ?? null,
        all: async () => ({ results: d.prepare(q).all(...args.map((v) => v ?? null)) }),
      };
      return stmt;
    },
    batch: async (ss) => { for (const x of ss) await x.run(); return []; },
  };
  return { DB, raw: d };
}

let seq = 0;
function place(e, id, { rating = 4.2, reviews = 200, km = 1 } = {}) {
  e.raw.prepare('INSERT INTO places (id,name,rating,reviews,status,km) VALUES (?,?,?,?,?,?)')
    .run(id, id, rating, reviews, 'unclaimed', km);
}
function rated(e, placeId, stars) {
  for (const s of stars) {
    e.raw.prepare('INSERT INTO num_ratings (id,booking_id,place_id,stars) VALUES (?,?,?,?)')
      .run(`rt${++seq}`, `bk${seq}`, placeId, s);
  }
}

/* ══ a thin sample must not act like a thick one ════════════════════════ */

test('four glowing ratings move nothing', () => {
  // Three ratings averaging 4.7 reads identically to three hundred and is
  // worth nothing like as much. The gate is the whole reason this is safe to
  // ship before there is much data.
  assert.equal(lift(5, MIN_RATINGS - 1), 0);
  assert.equal(lift(1, MIN_RATINGS - 1), 0, 'and a thin sample cannot sink a place either');
});

test('the fifth rating is when it starts to count', () => {
  assert.equal(lift(5, MIN_RATINGS), (5 - NEUTRAL) * WEIGHT);
});

/* ══ being disliked costs more than being liked earns ═══════════════════ */

test('a place our own guests hate is demoted further than a loved one is promoted', () => {
  const loved = lift(5, 50);
  const hated = lift(1, 50);
  assert.equal(loved, MAX_LIFT);
  assert.equal(hated, MAX_SINK);
  assert.equal(Math.abs(hated), loved * 2,
    'a concierge\'s job is not finding the best table, it is never sending anyone somewhere bad');
  // The lift cap is the arithmetic ceiling of a 5.0 average, not an extra
  // limit; the sink cap is a real one and binds from 2.0 down.
  assert.equal(MAX_LIFT, (5 - NEUTRAL) * WEIGHT);
  assert.equal(lift(2, 50), MAX_SINK);
  assert.equal(lift(1.4, 50), lift(1.9, 50), 'below 2.0 the difference is not worth ranking');
});

test('the lift is bounded at both ends', () => {
  for (const avg of [0, 1, 2, 3, 4, 5, 9, -3]) {
    const v = lift(avg, 99);
    assert.ok(v <= MAX_LIFT && v >= MAX_SINK, `${avg} produced ${v}`);
  }
});

test('a place rated exactly at the neutral point moves neither way', () => {
  assert.equal(lift(NEUTRAL, 100), 0);
});

/* ══ the SQL and the JavaScript agree ═══════════════════════════════════ */

test('the score term computes what lift() says it does', () => {
  // Two copies of an arithmetic rule is one rule and one comment. This runs
  // the SQL the ranker actually uses and compares it to the function every
  // other test here checks.
  const e = env();
  const d = e.raw;
  for (const [avg, n] of [[5, 50], [4.6, 12], [4.0, 7], [3.1, 9], [1.0, 30], [4.9, 4], [2.0, 1]]) {
    const row = d.prepare(
      `SELECT ${SCORE_TERM.replace(/num_rating_n/g, '?2').replace(/num_rating\b/g, '?1')} AS v`,
    ).get(avg, n);
    assert.ok(Math.abs(row.v - lift(avg, n)) < 1e-9,
      `SQL gave ${row.v} for avg=${avg} n=${n}, lift() gave ${lift(avg, n)}`);
  }
});

test('the ranker imports the term rather than keeping a second copy of it', () => {
  assert.match(PLACES, /import \{ SCORE_TERM as NUM_RATING_TERM \} from '\.\.\/worker\/learn\.mjs'/);
  assert.match(PLACES, /\+ \$\{NUM_RATING_TERM\}/);
  // And it reads the columns it scores on, or every query throws.
  assert.match(PLACES, /num_rating, num_rating_n'/);
});

/* ══ it changes what the next guest is shown ════════════════════════════ */

test('two identical places rank differently once our guests have spoken', async () => {
  // The whole point, end to end: same stars on Google, same review count,
  // same distance. One of them our guests loved and one they did not.
  const e = env();
  place(e, 'good');
  place(e, 'bad');
  rated(e, 'good', [5, 5, 5, 4, 5, 5]);
  rated(e, 'bad', [2, 1, 2, 3, 1, 2]);

  const before = e.raw.prepare(
    `SELECT id FROM places ORDER BY (COALESCE(rating,3.9) + ${SCORE_TERM}) DESC, id`,
  ).all().map((r) => r.id);
  assert.deepEqual(before, ['bad', 'good'], 'before the rollup they are tied and sort by name');

  const out = await rollupRatings(e);
  assert.equal(out.ok, true);
  assert.equal(out.places, 2);
  assert.equal(out.counted, 2);

  const after = e.raw.prepare(
    `SELECT id FROM places ORDER BY (COALESCE(rating,3.9) + ${SCORE_TERM}) DESC, id`,
  ).all().map((r) => r.id);
  assert.deepEqual(after, ['good', 'bad'], 'after it, the evening people actually had decides');
});

test('a place with four ratings is untouched by the ranking even after a rollup', async () => {
  const e = env();
  place(e, 'thin');
  rated(e, 'thin', [5, 5, 5, 5]);
  await rollupRatings(e);
  const r = e.raw.prepare('SELECT num_rating AS a, num_rating_n AS n FROM places WHERE id=?').get('thin');
  assert.equal(r.n, 4, 'the count is still recorded — it is the ranking that ignores it');
  const v = e.raw.prepare(`SELECT ${SCORE_TERM} AS v FROM places WHERE id=?`).get('thin');
  assert.equal(v.v, 0);
});

test('the rollup is idempotent and recomputes rather than accumulates', async () => {
  const e = env();
  place(e, 'p1');
  rated(e, 'p1', [5, 5, 5, 5, 5]);
  await rollupRatings(e);
  await rollupRatings(e);
  await rollupRatings(e);
  const r = e.raw.prepare('SELECT num_rating AS a, num_rating_n AS n FROM places WHERE id=?').get('p1');
  assert.equal(r.n, 5, 'an incremental counter would read 15 here');
  assert.equal(r.a, 5);
});

test('a rating removed for a takedown stops counting on the next pass', async () => {
  // The reason the rollup is total rather than incremental. A deleted row must
  // be able to leave, and drift in an average is invisible to everyone.
  const e = env();
  place(e, 'p1');
  rated(e, 'p1', [5, 5, 5, 5, 5, 1]);
  await rollupRatings(e);
  assert.equal(e.raw.prepare('SELECT num_rating_n AS n FROM places WHERE id=?').get('p1').n, 6);
  e.raw.prepare("DELETE FROM num_ratings WHERE place_id='p1' AND stars=1").run();
  await rollupRatings(e);
  const r = e.raw.prepare('SELECT num_rating AS a, num_rating_n AS n FROM places WHERE id=?').get('p1');
  assert.equal(r.n, 5);
  assert.equal(r.a, 5);
});

test('a rating with no place attached is not counted against a place', async () => {
  const e = env();
  place(e, 'p1');
  e.raw.prepare('INSERT INTO num_ratings (id,booking_id,place_id,stars) VALUES (?,?,NULL,?)')
    .run('rt_x', 'bk_x', 5);
  const out = await rollupRatings(e);
  assert.equal(out.places, 0);
});

test('a comment with no stars does not become a score', async () => {
  const e = env();
  place(e, 'p1');
  e.raw.prepare('INSERT INTO num_ratings (id,booking_id,place_id,stars) VALUES (?,?,?,NULL)')
    .run('rt_c', 'bk_c', 'p1');
  const out = await rollupRatings(e);
  assert.equal(out.places, 0, 'aftertable.rate() allows a comment without stars; it is not an opinion on quality');
});

/* ══ it cannot be bought ════════════════════════════════════════════════ */

test('nothing money can reach appears in the learned term', () => {
  // Placement is not for sale. gate.test.mjs already fails the build if the
  // merchant page implies it is; this fails it if the ranking quietly starts
  // to make it true.
  for (const word of [
    'commission', 'fee', 'paid', 'payment', 'invoice', 'spend', 'budget',
    'sponsor', 'boost', 'promoted', 'bid', 'priority_seating', 'f_bill_value',
    'num_commissions', 'booking_fee', 'stars_settle', 'tip',
  ]) {
    assert.doesNotMatch(LEARN_CODE, new RegExp(`\\b${word}\\b`, 'i'),
      `learn.mjs code mentions "${word}" — the ranking must not be purchasable`);
    assert.doesNotMatch(SCORE_TERM, new RegExp(word, 'i'));
  }
});

test('the loop learns from ratings and not from what was tapped', () => {
  // A ranker trained on taps learns to promote whatever it already promoted:
  // a place gets tapped because it has a striking photo, or because it was at
  // the top. A rating is given afterwards, by somebody who went.
  for (const table of ['num_place_impressions', 'num_asks', 'num_web_events', 'num_usage']) {
    assert.doesNotMatch(LEARN_CODE, new RegExp(table),
      `learn.mjs reads ${table} — engagement is not quality`);
  }
  assert.match(LEARN_CODE, /FROM num_ratings/);
});

/* ══ a learning system nobody can inspect cannot be caught being wrong ══ */

test('the state of the loop is reportable in numbers a human can check', async () => {
  const e = env();
  place(e, 'p1'); place(e, 'p2');
  rated(e, 'p1', [5, 5, 5, 5, 5]);
  rated(e, 'p2', [4, 4]);
  await rollupRatings(e);
  const st = await learningState(e);
  assert.equal(st.ratings_collected, 7);
  assert.equal(st.places_with_a_rating, 2);
  assert.equal(st.places_changing_the_ranking, 1, 'only p1 has cleared the threshold');
  assert.equal(st.min_ratings_to_count, MIN_RATINGS);
  assert.ok(st.last_rollup, 'a stale loop must be visible');
});

test('a missing database is a quiet no, never a thrown recommendation', async () => {
  assert.equal((await rollupRatings({})).ok, false);
  assert.equal(await learningState({}), null);
  const broken = { DB: { prepare() { throw new Error('D1 down'); } } };
  assert.equal((await rollupRatings(broken)).ok, false);
});

/* ══ the cron ═══════════════════════════════════════════════════════════ */

test('the rollup runs hourly, not on every five-minute tick', () => {
  const idx = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  const sched = idx.slice(idx.indexOf('async scheduled(event, env, ctx)'));
  const body = sched.slice(0, sched.indexOf('\n  },'));
  assert.match(body, /learn\.mjs/);
  assert.match(body, /getUTCMinutes\(\) < 5/,
    'twelve rewrites an hour of a 2.5M-row table for a number that changes daily');
});
