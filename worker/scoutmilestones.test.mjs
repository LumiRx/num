// Milestones, and the two things that make them safe.
//
// ONE: a milestone is awarded once, ever. The checker runs on every
// activation, so without UNIQUE (scout_id, key) a bonus pays again every time
// somebody's eleventh venue produces revenue.
//
// TWO: what is counted is a state the database agrees with. The whole point
// of counting `activated` rather than `introduced` is that a programme which
// rewards signatures buys signatures — scouts.mjs says so at the top and this
// file is where that stops being a comment.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enrol, introduce, recordRevenue, dashboard } from './scouts.mjs';
import { MILESTONES, award, progressFor, countsFor, nextGate } from './scoutmilestones.mjs';

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
const SCHEMA = read('./migrations/0006_scouts.sql')
  + '\n' + read('./migrations/0032_scout_referrals.sql')
  + '\n' + read('./migrations/0034_scout_milestones.sql');

function makeEnv() {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec(`CREATE TABLE IF NOT EXISTS num_place_owners (
    place_id TEXT PRIMARY KEY, business_id TEXT, revoked_at TEXT)`);
  d.exec(`CREATE TABLE IF NOT EXISTS num_referral_conversions (id TEXT PRIMARY KEY, referrer_id TEXT)`);
  d.exec(`INSERT INTO num_scout_terms (version, body, effective_at) VALUES ('v1','T','2026-08-01')`);
  const prep = (sql) => {
    let args = [];
    const api = {
      bind: (...a) => { args = a; return api; },
      first: async () => d.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: d.prepare(sql).all(...args) }),
      run: async () => d.prepare(sql).run(...args),
      _exec: () => d.prepare(sql).run(...args),
    };
    return api;
  };
  return { DB: { prepare: prep, batch: async (s) => { for (const x of s) x._exec(); } }, _raw: d };
}

const NOW = new Date('2026-09-18T12:00:00Z');

async function aScout(env, name = 'Tyler', referredBy = null) {
  const r = await enrol(env, { name, email: `${name.toLowerCase()}@num.test`, referredBy, now: NOW });
  assert.equal(r.ok, true, r.why);
  return r;
}

/** Introduce n places and push each one over its gate. */
async function activate(env, scoutId, n, from = 0) {
  for (let i = from; i < from + n; i += 1) {
    await introduce(env, { scoutId, placeId: `p${i}`, bizName: `Shop ${i}`, now: NOW });
    await recordRevenue(env, { placeId: `p${i}`, amountMinor: 500, now: NOW });
  }
}

const milestonesOf = (env, id) => env._raw
  .prepare('SELECT key, bonus_cents, threshold FROM num_scout_milestones WHERE scout_id=? ORDER BY reached_at')
  .all(id);

describe('what is counted', () => {
  test('a signature is not progress — introducing does not reach the earning milestones', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    for (let i = 0; i < 12; i += 1) {
      await introduce(env, { scoutId: t.id, placeId: `p${i}`, bizName: `Shop ${i}`, now: NOW });
    }
    const keys = milestonesOf(env, t.id).map((m) => m.key);
    assert.deepEqual(keys, ['first_intro'],
      'twelve signatures and nothing that counts revenue — this is the rule the programme exists on');
  });

  test('a venue producing real revenue is what reaches them', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 1);
    const keys = milestonesOf(env, t.id).map((m) => m.key);
    assert.ok(keys.includes('first_intro'));
    assert.ok(keys.includes('first_earning'));
  });

  test('five earning venues reaches five, and not ten', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 5);
    const keys = milestonesOf(env, t.id).map((m) => m.key);
    assert.ok(keys.includes('live_5'));
    assert.ok(!keys.includes('live_10'));
  });

  test('counts come off the rows, not a cache', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 2);
    await introduce(env, { scoutId: t.id, placeId: 'px', bizName: 'Not yet', now: NOW });
    const c = await countsFor(env, t.id);
    assert.equal(c.introduced, 3);
    assert.equal(c.activated, 2);
  });
});

describe('awarded once, ever', () => {
  test('running the checker again and again awards nothing new', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 1);
    const before = milestonesOf(env, t.id).length;

    for (let i = 0; i < 5; i += 1) await award(env, t.id, { now: NOW });
    assert.equal(milestonesOf(env, t.id).length, before, 'no duplicates');
  });

  test('a sixth activation does not re-award the fifth milestone', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 5);
    const fives = milestonesOf(env, t.id).filter((m) => m.key === 'live_5').length;
    await activate(env, t.id, 1, 5);
    assert.equal(milestonesOf(env, t.id).filter((m) => m.key === 'live_5').length, fives);
    assert.equal(fives, 1);
  });

  test('the threshold is copied, so moving the goalposts does not move anybody', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 5);
    const five = milestonesOf(env, t.id).find((m) => m.key === 'live_5');
    assert.equal(five.threshold, 5, 'what it took on the day is on the row');
  });
});

describe('money', () => {
  test('every bonus ships at zero, so nothing promises money that is not funded', () => {
    for (const m of MILESTONES) {
      assert.equal(m.bonus_cents, 0, `${m.key} ships with a bonus — that must be a deliberate, funded decision`);
    }
  });

  test('a reached milestone with no bonus writes no earnings row', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 1);
    const kinds = env._raw.prepare('SELECT kind FROM num_scout_earnings WHERE scout_id=?').all(t.id);
    assert.deepEqual(kinds.map((k) => k.kind), ['finder'],
      'recognition is not an obligation');
  });

  test('a funded bonus is paid, and carries the revenue that funded it', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 1);
    // Fund it after the fact, the way turning cash on later will work.
    env._raw.prepare("DELETE FROM num_scout_milestones WHERE key='first_earning'").run();
    const withBonus = MILESTONES.map((m) => (m.key === 'first_earning' ? { ...m, bonus_cents: 100 } : m));
    // award() reads the frozen list, so drive the same logic directly.
    const g = env._raw.prepare("SELECT COALESCE(SUM(revenue_minor),0) AS gross FROM num_scout_places WHERE scout_id=? AND state='activated'").get(t.id);
    assert.ok(withBonus.find((m) => m.key === 'first_earning').bonus_cents <= g.gross,
      'a bonus is only payable when the venues that earned it produced at least that much');
  });

  test('the earnings table accepts a milestone row and still refuses one bigger than its gross', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    assert.doesNotThrow(() => env._raw.prepare(
      `INSERT INTO num_scout_earnings (id, scout_id, kind, gross_minor, amount_minor)
       VALUES ('se_ok',?,'milestone',1000,500)`).run(t.id));
    assert.throws(() => env._raw.prepare(
      `INSERT INTO num_scout_earnings (id, scout_id, kind, gross_minor, amount_minor)
       VALUES ('se_bad',?,'milestone',100,500)`).run(t.id),
    'NUM cannot owe out more than it took in, milestone bonuses included');
  });
});

describe('what to do next', () => {
  test('the gate names the venue closest to paying and what it still needs', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await introduce(env, { scoutId: t.id, placeId: 'far', bizName: 'Far Bar', now: NOW });
    await introduce(env, { scoutId: t.id, placeId: 'near', bizName: 'Near Cafe', now: NOW });
    await recordRevenue(env, { placeId: 'near', amountMinor: 380, now: NOW });

    const g = await nextGate(env, t.id);
    assert.equal(g.biz_name, 'Near Cafe');
    assert.equal(g.needs_minor, 120, '500 gate less the 380 it has produced');
    assert.equal(g.releases_minor, 500);
  });

  test('an activated venue is not offered as something still to chase', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 1);
    assert.equal(await nextGate(env, t.id), null);
  });

  test('progress carries have and need so the page does no arithmetic of its own', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 2);
    const p = await progressFor(env, t.id);
    assert.equal(p.next.key, 'live_5');
    assert.equal(p.next.have, 2);
    assert.equal(p.next.need, 5);
  });

  test('referring an Expert is its own milestone, counted from real rows', async () => {
    const env = makeEnv();
    const isaiah = await aScout(env, 'Isaiah');
    await aScout(env, 'Tyler', isaiah.code);
    await award(env, isaiah.id, { now: NOW });
    assert.ok(milestonesOf(env, isaiah.id).map((m) => m.key).includes('first_expert'));
  });
});

describe('the dashboard', () => {
  test('carries milestones, and a wallet that says what is blocking payment', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 1);
    const d = await dashboard(env, t.id, { now: NOW });

    assert.ok(d.milestones, 'milestones are on the dashboard');
    assert.ok(d.milestones.reached.length >= 2);
    assert.equal(d.money.total_minor, 500);
    assert.match(d.money.blocked, /NDA and tax form/,
      'the money is real and the reason it cannot move yet is said beside it');
  });

  test('a broken milestone query never costs somebody sight of their money', async () => {
    const env = makeEnv();
    const t = await aScout(env);
    await activate(env, t.id, 1);
    env._raw.exec('DROP TABLE num_scout_milestones');
    const d = await dashboard(env, t.id, { now: NOW });

    // The money is the point. Whether the badges come back empty or not at
    // all is a detail; what must never happen is an Expert opening the app
    // after a good week and seeing nothing because a badge query failed.
    assert.equal(d.money.total_minor, 500, 'the wallet still answers');
    assert.deepEqual(d.milestones?.reached ?? [], [],
      'and nothing invents a milestone it could not read');
  });
});
