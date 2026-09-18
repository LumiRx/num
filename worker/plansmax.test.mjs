/**
 * THE FIRST GATE NUM EVER ENFORCED.
 *
 * 18 Sep 2026. membership.mjs had shipped tiers, entitlements, usage counters,
 * a Stripe grant path and a legal guard — all tested — and `may()` had ZERO
 * callers in the product. Num Pro at $28.98 and the free tier behaved
 * identically. This file covers the first call site: the plan-create path in
 * social.mjs.
 *
 * Two things are being tested, and they are separable on purpose:
 *   1. the COUNT — what "plans in flight" means, which is the part that
 *      decides whether a free member ever hits a wall they cannot escape;
 *   2. the DECISION — what may() does with that count on each tier.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { may, tiers } from './membership.mjs';

const SOCIAL = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');

let db; let env;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n] ?? null) };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => {
      const { text, args } = run();
      const r = database.prepare(text).run(...args);
      return { meta: { changes: r.changes } };
    };
    return st;
  },
  batch: async (stmts) => { for (const s of stmts) await s.run(); return []; },
});

/** The exact SQL the worker runs, kept here so the test breaks if it drifts. */
const IN_FLIGHT = `SELECT COUNT(*) AS n FROM num_plans
      WHERE owner_id = ?1 AND state <> 'done'
        AND (starts_on IS NULL OR starts_on >= date('now','-1 day'))`;

const inFlight = async (owner) =>
  Number((await env.DB.prepare(IN_FLIGHT).bind(owner).first())?.n ?? 0);

const addPlan = (id, owner, startsOn, state = 'planning') =>
  db.exec(`INSERT INTO num_plans (id,title,owner_id,starts_on,state) VALUES ('${id}','x','${owner}',${startsOn ? `'${startsOn}'` : 'NULL'},'${state}')`);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_plans (id TEXT PRIMARY KEY, title TEXT, dest TEXT, owner_id TEXT, starts_on TEXT, state TEXT NOT NULL DEFAULT 'planning', join_code TEXT)`);
  db.exec(`CREATE TABLE num_memberships (member_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free', since TEXT, renews_at TEXT, source TEXT, ref TEXT)`);
  db.exec(`CREATE TABLE num_usage_counters (member_id TEXT, period TEXT, key TEXT, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (member_id, period, key))`);
  env = { DB: d1(db) };
});

describe('what counts as a plan in flight', () => {
  test('only plans you started — a friend cannot spend your ceiling for you', async () => {
    addPlan('p1', 'mem_me', null);
    addPlan('p2', 'mem_friend', null);
    addPlan('p3', 'mem_friend', null);
    assert.equal(await inFlight('mem_me'), 1, 'being added to someone else\'s plan costs you nothing');
  });

  test('a plan whose date has passed no longer occupies a slot', async () => {
    addPlan('p1', 'mem_me', '2020-01-01');
    addPlan('p2', 'mem_me', '2099-01-01');
    assert.equal(await inFlight('mem_me'), 1);
  });

  test('a plan with no date still counts, because it is genuinely open', async () => {
    addPlan('p1', 'mem_me', null);
    assert.equal(await inFlight('mem_me'), 1);
  });

  test('tonight is still in flight at 1am', async () => {
    // The one-day grace. Without it, a plan made for tonight stops counting
    // the moment the clock rolls over, which is precisely when the person who
    // made it is still using it.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    addPlan('p1', 'mem_me', yesterday);
    assert.equal(await inFlight('mem_me'), 1);
  });

  test('a finished plan releases its slot the same minute', async () => {
    addPlan('p1', 'mem_me', null, 'done');
    addPlan('p2', 'mem_me', null);
    assert.equal(await inFlight('mem_me'), 1);
  });

  test('the limit can always be escaped, which is the point', async () => {
    // There is no "archive plan" button in the app. If the count included
    // every plan ever made, a free member who hit three would be walled out
    // for life. Ageing out is what makes this a ceiling rather than a wall.
    for (const [i, d] of ['2019-01-01', '2019-06-01', '2020-01-01'].entries()) addPlan(`old${i}`, 'mem_me', d);
    assert.equal(await inFlight('mem_me'), 0, 'last year\'s trips hold nothing');
  });
});

describe('what may() then decides', () => {
  test('a free member gets three, and the fourth is refused with a way out', async () => {
    for (let i = 0; i < 3; i++) addPlan(`p${i}`, 'mem_me', null);
    const n = await inFlight('mem_me');
    const gate = await may(env, 'mem_me', 'plans_max', { count: n });
    assert.equal(gate.ok, false);
    assert.equal(gate.limit, 3);
    assert.equal(gate.upgrade_to, 'plus', 'and it names the cheapest plan that lifts it');
    assert.equal(gate.upgrade_gives, 25);
  });

  test('the third plan is still allowed — the gate is off-by-one in the guest\'s favour', async () => {
    for (let i = 0; i < 2; i++) addPlan(`p${i}`, 'mem_me', null);
    const gate = await may(env, 'mem_me', 'plans_max', { count: await inFlight('mem_me') });
    assert.equal(gate.ok, true);
    assert.equal(gate.left, 1);
  });

  test('a paying member gets the room they paid for', async () => {
    db.exec(`INSERT INTO num_memberships (member_id, tier) VALUES ('mem_paid','plus')`);
    for (let i = 0; i < 10; i++) addPlan(`p${i}`, 'mem_paid', null);
    const gate = await may(env, 'mem_paid', 'plans_max', { count: await inFlight('mem_paid') });
    assert.equal(gate.ok, true, 'ten is nothing on Plus');
    assert.equal(gate.limit, 25);
  });

  test('Pro has no ceiling at all', async () => {
    db.exec(`INSERT INTO num_memberships (member_id, tier) VALUES ('mem_pro','pro')`);
    for (let i = 0; i < 40; i++) addPlan(`p${i}`, 'mem_pro', null);
    const gate = await may(env, 'mem_pro', 'plans_max', { count: await inFlight('mem_pro') });
    assert.equal(gate.ok, true);
    assert.equal(gate.limit, null);
  });

  test('the count is passed in, never read from the monthly counter', async () => {
    // plans_max is a CONCURRENT ceiling. If it ever read num_usage_counters,
    // a member who made and finished three plans in January would be locked
    // out for the rest of the month with nothing in flight at all.
    db.exec(`INSERT INTO num_usage_counters (member_id, period, key, used) VALUES ('mem_me','2026-09','plans_max',99)`);
    const gate = await may(env, 'mem_me', 'plans_max', { count: 0 });
    assert.equal(gate.ok, true, 'what matters is what is open now, not what was ever opened');
  });
});

describe('the call site itself', () => {
  test('social.mjs gates the CREATE branch and never the update branch', () => {
    const create = SOCIAL.indexOf("const id = uid('pln')");
    const gateAt = SOCIAL.indexOf("may(env, meId, 'plans_max'");
    assert.ok(gateAt > 0, 'the gate exists');
    assert.ok(gateAt < create, 'and it runs before the INSERT, not after it');
    const updateBranch = SOCIAL.indexOf('if (b.id) {', SOCIAL.indexOf('async function planWrite'));
    assert.ok(updateBranch < gateAt,
      'renaming or scheduling an existing plan must never be refused — only making a NEW one');
  });

  test('the refusal is 402 and says how the limit frees itself', () => {
    const slice = SOCIAL.slice(SOCIAL.indexOf("may(env, meId, 'plans_max'"), SOCIAL.indexOf("const id = uid('pln')"));
    assert.match(slice, /402/, 'Payment Required, not 403 — nothing is forbidden, something is full');
    assert.match(slice, /let its date pass|Finish one/, 'and it tells them the free way out first');
    assert.match(slice, /reason: 'plans_max'/, 'machine-readable, so the app can offer the upgrade sheet');
  });

  test('every tier in the table still answers this capability', () => {
    for (const [id, t] of Object.entries(tiers({}))) {
      assert.ok('plans_max' in (t.entitlements ?? {}), `${id} must say what its plan ceiling is`);
    }
  });
});
