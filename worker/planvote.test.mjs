/**
 * Voting on ONE idea, and the plan's own door into the chat.
 *
 * 6 Sep 2026. `num_plan_members.vote` answers "am I coming at all" — one
 * answer per person for the whole plan — and it has been mistaken for choosing
 * between ideas since it shipped. Five friends who are all "in" still had no
 * way to say which of four restaurants they wanted, which is the exact moment
 * a group gives up and eats where they can see from the hotel door.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');

let db; let env;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      let i = 0;
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      const args = order.map((n) => st.binds[n]);
      return { text, args };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
});

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_plans (id TEXT PRIMARY KEY, title TEXT, dest TEXT, owner_id TEXT, starts_on TEXT, state TEXT, join_code TEXT UNIQUE)`);
  db.exec(`CREATE TABLE num_plan_members (plan_id TEXT, member_id TEXT, name TEXT, role TEXT, vote TEXT, PRIMARY KEY (plan_id, member_id))`);
  db.exec(`CREATE TABLE num_plan_items (id TEXT PRIMARY KEY, plan_id TEXT, title TEXT, status TEXT)`);
  db.exec(`CREATE TABLE num_plan_item_votes (item_id TEXT, member_id TEXT, vote TEXT, created_at TEXT, PRIMARY KEY (item_id, member_id))`);
  db.exec(`INSERT INTO num_plans VALUES ('pl_1','Bangkok weekend','bangkok','mem_a',NULL,'planning','ABC123')`);
  db.exec(`INSERT INTO num_plan_members VALUES ('pl_1','mem_a','Dre','owner',NULL),('pl_1','mem_b','Sam','member',NULL)`);
  db.exec(`INSERT INTO num_plan_items VALUES ('it_1','pl_1','Nahm','idea'),('it_2','pl_1','Bo.lan','idea')`);
  env = { DB: d1(db) };
});

/** The tally logic, exercised directly against the same SQL the worker runs. */
async function tally(planId) {
  const { results } = await env.DB.prepare(
    `SELECT v.item_id, v.member_id, v.vote FROM num_plan_item_votes v
       JOIN num_plan_items i ON i.id = v.item_id
      WHERE i.plan_id = ?1`,
  ).bind(planId).all();
  const out = {};
  for (const r of results) {
    const t = (out[r.item_id] ??= { up: 0, down: 0, voters: [] });
    if (r.vote === 'up') t.up += 1; else t.down += 1;
    t.voters.push({ member_id: r.member_id, vote: r.vote });
  }
  return out;
}

describe('per-item voting', () => {
  test('two people can disagree about the same idea and both are counted', async () => {
    db.exec(`INSERT INTO num_plan_item_votes VALUES ('it_1','mem_a','up','t'),('it_1','mem_b','down','t')`);
    const t = await tally('pl_1');
    assert.deepEqual({ up: t.it_1.up, down: t.it_1.down }, { up: 1, down: 1 });
    assert.equal(t.it_2, undefined, 'an idea nobody voted on has no tally, not a zero row');
  });

  test('a person has exactly one vote per idea — changing it replaces, never adds', () => {
    db.exec(`INSERT INTO num_plan_item_votes VALUES ('it_1','mem_a','up','t')`);
    db.exec(`INSERT INTO num_plan_item_votes (item_id,member_id,vote,created_at) VALUES ('it_1','mem_a','down','t2')
             ON CONFLICT(item_id, member_id) DO UPDATE SET vote=excluded.vote`);
    const rows = db.prepare(`SELECT vote FROM num_plan_item_votes WHERE item_id='it_1' AND member_id='mem_a'`).all();
    assert.equal(rows.length, 1, 'a second vote must replace the first, not stack');
    assert.equal(rows[0].vote, 'down');
  });

  test('the handler refuses a stranger, an unknown idea, and a nonsense vote', () => {
    assert.match(SRC, /if \(!meId \|\| !itemId \|\| !want\) return json\(\{ error: 'me, item_id and vote \(up\|down\) required' \}/);
    assert.match(SRC, /if \(!item\) return json\(\{ error: 'That idea is no longer on the plan\.' \}, 404\)/);
    assert.match(SRC, /if \(!\(await memberOf\(env, item\.plan_id, meId\)\)\) return json\(\{ error: 'not your plan' \}, 403\)/,
      'membership must be checked against the ITEM\'s plan, not a plan id the caller supplied');
  });

  test('tapping the same way twice clears the vote rather than double-counting', () => {
    assert.match(SRC, /const mine = prev\?\.vote === want \? null : want;/);
    assert.match(SRC, /DELETE FROM num_plan_item_votes WHERE item_id=\?1 AND member_id=\?2/);
  });

  test('the feed narrates a vote cast, and stays quiet on an un-vote', () => {
    const at = SRC.indexOf("async function itemVote");
    const fn = SRC.slice(at, SRC.indexOf('async function voteTally'));
    assert.match(fn, /if \(mine\) \{\s*await event\(/, 'an un-vote must not be narrated to the group');
    assert.match(fn, /likes.*passed on/s);
  });
});

describe("the plan's own door into the chat", () => {
  test('a plan with a join code gets a link that opens the chat on that plan', () => {
    assert.match(SRC, /ask_link: plan\?\.join_code/);
    assert.match(SRC, /app\.itsnum\.com\/\?plan=\$\{encodeURIComponent\(plan\.join_code\)\}&ask=1/);
    assert.match(SRC, /: null,/, 'a plan with no join code must get null, never a broken link');
  });

  test('every item carries the tally and my own vote, so a button renders without a second call', () => {
    assert.match(SRC, /votes: \{ up: v\.up, down: v\.down \}/);
    assert.match(SRC, /my_vote: \(v\.voters \?\? \[\]\)\.find\(\(x\) => x\.member_id === meId\)\?\.vote \?\? null/);
  });

  test('the route is registered', () => {
    assert.match(SRC, /path === '\/plan\/item\/vote' && post/);
  });
});
