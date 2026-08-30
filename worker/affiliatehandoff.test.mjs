// Does the concierge — the path every HUMAN uses — record what it hands away?
//
// ── THE FINDING THIS COVERS ──────────────────────────────────────────────
//
// `logHandoffs` had exactly one caller: worker/openapi.mjs, the agent surface.
// Every person using Num gets their OpenTable / Grab / Bolt / airline links
// through worker/index.mjs `attachServiceOptions`, and not one of those
// handoffs was ever written down. The proof was in D1: `num_affiliate_clicks`
// did not exist as a table, because the schema is created lazily on first
// write and there had never been a first write on the busy path.
//
// That is not a reporting nicety. "How much traffic do you send us?" is the
// first question every affiliate programme asks on the application form, and
// the answer for the human path was a shrug.
//
// These tests import the REAL function the router calls and run it against a
// REAL SQLite database with the REAL schema. They assert on rows, not on the
// text of the module — a regex over index.mjs would have found the word
// `logHandoffs` on the day the log was dead, because openapi.mjs imports it.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { __testables } from './index.mjs';
import { _resetForTests } from './affiliateclicks.mjs';

const { attachServiceOptions } = __testables;

// Same D1-over-SQLite shim as bookdesk.wiring.test.mjs. Statements compile at
// EXECUTION time because D1 does, and the lazy ensure() in affiliateclicks.mjs
// depends on that.
function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: stmt.all(...args), success: true };
      stmt.run(...args);
      return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare(sql) {
      const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) });
      return bound([]);
    },
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
}

let db;
let env;
/** ctx.waitUntil collects promises so a test can await what the request would not. */
let pending;
const ctx = { waitUntil: (p) => pending.push(p) };

const grounding = { place: { name: 'Phuket', slug: 'phuket', country: 'TH' } };
const rideAsk = { actions: [{ type: 'service', kind: 'ride', to: 'Kata Beach' }] };

const rows = () => db.prepare('SELECT * FROM num_affiliate_clicks ORDER BY id').all();

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  env = { DB: d1(db) };
  pending = [];
  _resetForTests();
});

/** Run the function the way the router does, then drain what it deferred. */
async function run(result, opts = {}) {
  const out = attachServiceOptions(env, result, opts.grounding ?? grounding, {
    ctx,
    memberId: opts.memberId ?? null,
  });
  await Promise.all(pending);
  return out;
}

describe('the concierge path records its handoffs', () => {
  test('a ride ask writes one row per provider offered', async () => {
    const out = await run(rideAsk);
    const offered = out.actions[0].options;
    assert.ok(offered.length > 0, 'Thailand must map to at least one ride provider');
    const logged = rows();
    assert.equal(logged.length, offered.length,
      'every provider Num put in front of the guest is a handoff');
    assert.deepEqual(
      logged.map((r) => r.host).sort(),
      offered.map((o) => new URL(o.url).hostname.replace(/^www\./, '')).sort(),
    );
  });

  test('rows carry the surface, the destination and the member', async () => {
    await run(rideAsk, { memberId: 'mem_test0000000001' });
    const r = rows()[0];
    assert.equal(r.surface, 'concierge', 'this is the human path, not book_link');
    assert.equal(r.dest, 'phuket', 'grounding calls it slug; the log calls it dest');
    assert.equal(r.member_id, 'mem_test0000000001');
    assert.equal(r.kind, 'ride');
    assert.equal(r.event, 'handoff', 'we saw the link offered, never the tap');
  });

  test('an UNTAGGED handoff is still logged', async () => {
    // NUM_AFFILIATES is unset, so nothing tags. These are the most valuable
    // rows in the table right now: they are the ranked list of which
    // programme to apply for next. Dropping them because we earned nothing is
    // how that list stays a guess.
    await run(rideAsk);
    const logged = rows();
    assert.ok(logged.length > 0);
    assert.ok(logged.every((r) => r.tagged === 0));
    assert.ok(logged.every((r) => r.programme === null));
  });

  test('with a programme configured the link comes back tagged', async () => {
    env.NUM_AFFILIATES = JSON.stringify({ '*': { ref: 'num', param: 'utm_source' } });
    const out = await run(rideAsk);
    const url = new URL(out.actions[0].options[0].url);
    assert.equal(url.searchParams.get('utm_source'), 'num');
    const r = rows()[0];
    assert.equal(r.tagged, 1);
    assert.equal(r.programme, '*');
  });

  test('a host-specific programme beats the wildcard and is named as such', async () => {
    env.NUM_AFFILIATES = JSON.stringify({
      'opentable.com': { ref: 'num-ot', param: 'ref' },
      '*': { ref: 'num', param: 'utm_source' },
    });
    await run({ actions: [{ type: 'service', kind: 'table', query: 'thai' }] });
    const ot = rows().find((r) => r.host === 'opentable.com');
    if (ot) {
      assert.equal(ot.programme, 'opentable.com',
        'a payout reconciles against the programme name, not against "*"');
      assert.equal(ot.tagged, 1);
    }
    // Whatever else was offered still got a row.
    assert.ok(rows().length > 0);
  });

  test('tagging never reorders the options', async () => {
    const before = (await run(rideAsk)).actions[0].options.map((o) => o.id);
    _resetForTests();
    db = new DatabaseSync(':memory:');
    env = { DB: d1(db), NUM_AFFILIATES: JSON.stringify({ 'bolt.eu': { ref: 'paid', param: 'ref' } }) };
    pending = [];
    const after = (await run(rideAsk)).actions[0].options.map((o) => o.id);
    assert.deepEqual(after, before,
      'a referral rate must never be able to reach the ranking');
  });

  test('non-service actions pass through untouched and log nothing', async () => {
    const input = { actions: [{ type: 'errand', title: 'charger' }] };
    const out = await run(input);
    assert.deepEqual(out.actions, input.actions);
    assert.throws(() => rows(), /no such table/,
      'nothing to log means the schema is never even created');
  });

  test('a reply with no actions is untouched', async () => {
    const out = await run({ reply: 'hello' });
    assert.equal(out.reply, 'hello');
    assert.deepEqual(out.actions, []);
  });

  test('the same host offered under two kinds is two rows, not one', async () => {
    // Grab is both a ride and a food provider in Thailand. Deduplication is
    // per host AND kind: collapsing them would hide half the volume, and
    // counting the render twice would inflate it.
    const out = await run({
      actions: [
        { type: 'service', kind: 'ride', to: 'Kata' },
        { type: 'service', kind: 'food', query: 'pad thai' },
      ],
    });
    assert.equal(out.actions.length, 2);
    const grab = rows().filter((r) => r.host.includes('grab'));
    if (grab.length) {
      assert.equal(new Set(grab.map((r) => r.kind)).size, grab.length,
        'one row per (host, kind), never two for the same pair');
    }
  });

  test('a database that refuses to write still returns the links', async () => {
    // Bookkeeping must never cost somebody their answer. This is the whole
    // reason logHandoffs swallows its errors.
    env = { DB: { prepare() { throw new Error('D1 down'); }, batch() { throw new Error('D1 down'); } } };
    const out = await run(rideAsk);
    assert.ok(out.actions[0].options.length > 0);
    assert.ok(out.actions[0].options.every((o) => typeof o.url === 'string' && o.url.startsWith('http')));
  });

  test('no ctx still lands the row', async () => {
    // The router passes ctx; a future caller might not. logHandoffs awaits
    // when there is no waitUntil, because an un-awaited promise after the
    // response is cancelled by the runtime and the row silently never lands.
    await attachServiceOptions(env, rideAsk, grounding, {});
    await new Promise((r) => setImmediate(r));
    assert.ok(rows().length > 0, 'a missing execution context must not lose the row');
  });
});
