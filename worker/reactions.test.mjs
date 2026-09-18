// The emoji under an answer reach the team — and only the team.
//
// 18 Sep 2026: reactions had shaped each guest's own style profile for weeks
// and told nobody else anything. These pin the ledger that changes that:
// one row per (person, message), a change of mind replaces rather than adds,
// PII is scrubbed on the way in, and the dashboard's arithmetic is honest
// about what "liked" means.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { record, summary, REACTIONS } from './reactions.mjs';

const MIGRATION = readFileSync(new URL('./migrations/0031_reactions.sql', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const CONSOLE = readFileSync(new URL('./console.mjs', import.meta.url), 'utf8');
const APPLIED = JSON.parse(readFileSync(new URL('./migrations/APPLIED.json', import.meta.url), 'utf8'));

let db; let env;
const binding = () => ({
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      async run() { const r = db.prepare(sql).run(...bound); return { meta: { changes: r.changes } }; },
      async first() { const r = db.prepare(sql).get(...bound); return r ? { ...r } : null; },
      async all() { return { results: db.prepare(sql).all(...bound).map((r) => ({ ...r })) }; },
    };
    return api;
  },
});

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  // The real migration, not a copy of it: if the SQL and the module disagree,
  // this is where it shows.
  db.exec(MIGRATION);
  env = { DB: binding() };
});

const tap = (over = {}) => record(env, {
  index: 3, reaction: 'like', subject: 'Le Du', asked: 'dinner near Sathorn tonight?',
  reply: 'Three I would book tonight: Le Du…', place: 'Bangkok', turn: { lane: 'moderate:haiku', brain: 'haiku', model: 'claude-haiku-4-5' },
  anon: 'anon-1', lang: 'en', ...over,
});

describe('recording a tap', () => {
  test('writes one row with everything the dashboard needs, no join required', async () => {
    const out = await tap();
    assert.equal(out.ok, true);
    const row = db.prepare('SELECT * FROM num_reactions').get();
    assert.equal(row.reaction, 'like');
    assert.equal(row.who, 'a:anon-1');
    assert.equal(row.lane, 'moderate:haiku');
    assert.equal(row.brain, 'haiku');
    assert.equal(row.place, 'Bangkok');
    assert.equal(row.msg_index, 3);
  });

  test('a change of mind on the same message replaces the row — one opinion, not two', async () => {
    await tap({ reaction: 'like' });
    await tap({ reaction: 'no' });
    const rows = db.prepare('SELECT reaction FROM num_reactions').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reaction, 'no');
  });

  test('different messages, or different people, are different rows', async () => {
    await tap({ index: 3 });
    await tap({ index: 5 });
    await tap({ index: 3, anon: 'anon-2' });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM num_reactions').get().c, 3);
  });

  test('a member id outranks the anon id as identity', async () => {
    await tap({ member: 'm-42' });
    assert.equal(db.prepare('SELECT who FROM num_reactions').get().who, 'm:m-42');
  });

  test('refuses what it does not understand, and never throws', async () => {
    assert.equal((await record(env, { index: 1, reaction: 'fire', anon: 'x' })).ok, false, 'unknown reaction');
    assert.equal((await record(env, { index: -1, reaction: 'like', anon: 'x' })).ok, false, 'bad index');
    assert.equal((await record(env, { index: 1, reaction: 'like' })).ok, false, 'no identity');
    assert.equal((await record({}, { index: 1, reaction: 'like', anon: 'x' })).ok, false, 'no database');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM num_reactions').get().c, 0);
  });

  test('a phone number in the question does not become a phone number in the dashboard', async () => {
    await tap({ asked: 'call me on +66 81 234 5678 about dinner' });
    const row = db.prepare('SELECT asked FROM num_reactions').get();
    assert.ok(!/81 234 5678/.test(row.asked), `scrubAsk did not run: ${row.asked}`);
  });

  test('the five reactions are the five the app shows', () => {
    assert.deepEqual([...REACTIONS], ['love', 'like', 'meh', 'no', 'long']);
  });
});

describe('the scoreboard', () => {
  test('liked is positive against negative; too long is its own line, not a vote', async () => {
    await tap({ index: 1, reaction: 'love' });
    await tap({ index: 2, reaction: 'like' });
    await tap({ index: 3, reaction: 'no' });
    await tap({ index: 4, reaction: 'long' });
    const s = await summary(env, { days: 7 });
    assert.equal(s.totals.n, 4);
    assert.equal(s.totals.approval, 67, '2 of 3 opinions positive; 🥱 is not an opinion about the place');
    assert.equal(s.totals.long_pct, 25);
    assert.equal(s.totals.people, 1);
    assert.equal(s.by_reaction.long, 1);
  });

  test('folds by lane, brain and place, busiest first', async () => {
    await tap({ index: 1, reaction: 'like', turn: { lane: 'moderate:haiku', brain: 'haiku' } });
    await tap({ index: 2, reaction: 'no', turn: { lane: 'complex:hosted', brain: 'hosted' }, place: 'Lisbon' });
    await tap({ index: 3, reaction: 'love', turn: { lane: 'complex:hosted', brain: 'hosted' }, place: 'Lisbon' });
    const s = await summary(env);
    assert.equal(s.by_lane[0].lane, 'complex:hosted');
    assert.equal(s.by_lane[0].n, 2);
    assert.equal(s.by_lane[0].approval, 50);
    assert.equal(s.by_brain.find((b) => b.brain === 'haiku').approval, 100);
    assert.equal(s.by_place[0].place, 'Lisbon');
  });

  test('"read these first" is the rejected and the too-long, with the question that produced them', async () => {
    await tap({ index: 1, reaction: 'love' });
    await tap({ index: 2, reaction: 'no', asked: 'a quiet bar?' });
    await tap({ index: 3, reaction: 'long' });
    const s = await summary(env);
    assert.equal(s.worst.length, 2);
    assert.ok(s.worst.every((w) => w.reaction !== 'love'));
    assert.ok(s.worst.some((w) => w.asked === 'a quiet bar?'));
  });

  test('an empty ledger is an empty scoreboard, not an error', async () => {
    const s = await summary(env);
    assert.equal(s.totals.n, 0);
    assert.equal(s.totals.approval, null);
    assert.deepEqual(s.worst, []);
  });

  test('no database is not a crash', async () => {
    assert.equal((await summary({})).totals.n, 0);
  });
});

describe('wired, not just written', () => {
  test('POST /api/react exists on the app worker and answers with CORS', () => {
    const i = INDEX.indexOf("url.pathname === '/api/react'");
    assert.ok(i > 0, 'the route is gone');
    assert.match(INDEX.slice(i, i + 400), /request\.method === 'POST'/);
    assert.match(INDEX.slice(i, i + 400), /import\('\.\/reactions\.mjs'\)/);
    assert.match(INDEX.slice(i, i + 400), /cors\)/);
  });

  test('the answer carries `turn` so the app can file a reaction by lane and brain', () => {
    assert.match(INDEX, /const turn = \{ lane: answeredLane, brain: result\._brain \?\? null/);
    assert.match(INDEX, /place: grounding\.place \? grounding\.place\.name : null, turn,/);
  });

  test('/admin/reactions sits BEHIND the isAdmin guard', () => {
    const guard = CONSOLE.indexOf("if (!(await isAdmin(env, request))) return json({ error: 'unauthorized' }, 401);");
    const route = CONSOLE.indexOf("path === '/admin/reactions'");
    assert.ok(guard > 0 && route > guard, 'the reactions summary must not be reachable without an admin session');
  });

  test('the migration is registered as pending until production has it', () => {
    const all = [...Object.keys(APPLIED.sealed ?? APPLIED.applied ?? {}), ...(APPLIED.pending ?? [])];
    assert.ok(all.includes('0031_reactions.sql'), 'add the migration to APPLIED.json or stage will not apply it');
  });
});
