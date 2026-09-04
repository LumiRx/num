import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistory, subjectFor, loadTurns, saveTurn, WINDOW, KEEP, MAX_CHARS, _resetSchemaCache } from './turns.mjs';

const U = (c) => ({ role: 'user', content: c });
const A = (c) => ({ role: 'assistant', content: c });

describe('mergeHistory — the client wins, the server fills', () => {
  test('a full client thread is returned untouched, server ignored', () => {
    const own = Array.from({ length: WINDOW }, (_, i) => (i % 2 ? A(`a${i}`) : U(`u${i}`)));
    assert.deepEqual(mergeHistory(own, [U('old'), A('older')]), own);
  });
  test('no server turns → client as sent', () => {
    assert.deepEqual(mergeHistory([U('hi')], []), [U('hi')]);
  });
  test('a fresh device gets the stored thread in front of its one new message', () => {
    const server = [U('where should we eat tonight'), A('Three options…')];
    assert.deepEqual(mergeHistory([U('the second one')], server), [...server, U('the second one')]);
  });
  test('a turn the client already shows is not repeated', () => {
    const out = mergeHistory([U('z'), A('w')], [U('x'), A('y'), U('z')]);
    assert.deepEqual(out, [U('x'), A('y'), U('z'), A('w')]);
  });
  test('never opens on an assistant turn', () => {
    const out = mergeHistory([U('now')], [A('orphan'), U('q'), A('r')]);
    assert.deepEqual(out, [U('q'), A('r'), U('now')]);
  });
  test('capped to the window from the end', () => {
    const server = Array.from({ length: 30 }, (_, i) => (i % 2 ? A(`a${i}`) : U(`u${i}`)));
    const out = mergeHistory([U('new')], server);
    assert.ok(out.length <= WINDOW);
    assert.equal(out.at(-1).content, 'new');
    assert.equal(out[0].role, 'user');
  });
  test('junk roles are dropped rather than sent to the model', () => {
    assert.deepEqual(mergeHistory([{ role: 'system', content: 'x' }, U('ok')], []), [U('ok')]);
  });
});

describe('subjectFor — member, else device, else nothing', () => {
  test('member id wins over device', () => assert.equal(subjectFor({ memberId: 'mem_1', anonId: 'dev' }), 'mem_1'));
  test('device is namespaced so it can never collide with a member', () =>
    assert.equal(subjectFor({ memberId: null, anonId: 'dev' }), 'anon:dev'));
  test('nothing → null', () => assert.equal(subjectFor({}), null));
});

// A tiny fake D1 that understands exactly the statements this module runs.
function fakeDb() {
  const rows = [];
  let nextId = 1;
  function exec(sql, args) {
    if (/^CREATE/.test(sql)) return { results: [] };
    if (/^INSERT/.test(sql)) { rows.push({ id: nextId++, subject: args[0], role: args[1], content: args[2] }); return { results: [] }; }
    if (/^SELECT role, content/.test(sql)) {
      const r = rows.filter((x) => x.subject === args[0]).sort((a, b) => b.id - a.id).slice(0, args[1]);
      return { results: r.map(({ role, content }) => ({ role, content })) };
    }
    if (/^DELETE FROM num_member_turns WHERE subject/.test(sql)) {
      const keep = new Set(rows.filter((x) => x.subject === args[0]).sort((a, b) => b.id - a.id).slice(0, args[1]).map((x) => x.id));
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].subject === args[0] && !keep.has(rows[i].id)) rows.splice(i, 1);
      return { results: [] };
    }
    if (/^DELETE FROM num_member_turns WHERE ts/.test(sql)) return { results: [] };
    throw new Error(`unexpected sql: ${sql}`);
  }
  const stmt = (sql) => ({
    bind: (...args) => ({ run: async () => exec(sql, args), all: async () => exec(sql, args) }),
    run: async () => exec(sql, []),
  });
  return { rows, prepare: stmt, batch: async (stmts) => { for (const s of stmts) await s.run(); } };
}

describe('store and reload', () => {
  beforeEach(() => _resetSchemaCache());
  test('round trip, oldest first', async () => {
    const env = { DB: fakeDb() };
    assert.equal(await saveTurn(env, 'mem_1', 'first', 'reply one'), true);
    assert.equal(await saveTurn(env, 'mem_1', 'second', 'reply two'), true);
    assert.deepEqual(await loadTurns(env, 'mem_1'), [U('first'), A('reply one'), U('second'), A('reply two')]);
  });
  test('subjects never bleed into each other', async () => {
    const env = { DB: fakeDb() };
    await saveTurn(env, 'mem_1', 'mine', 'yours');
    assert.deepEqual(await loadTurns(env, 'anon:other'), []);
  });
  test('trimmed to KEEP rows per subject, and clipped per turn', async () => {
    const env = { DB: fakeDb() };
    for (let i = 0; i < 40; i++) await saveTurn(env, 'mem_1', `u${i}`, 'x'.repeat(5000));
    assert.equal(env.DB.rows.length, KEEP);
    assert.ok(env.DB.rows[0].content.length <= MAX_CHARS);
    assert.equal((await loadTurns(env, 'mem_1')).length, WINDOW);
  });
  test('an empty half stores nothing — no orphaned assistant turns', async () => {
    const env = { DB: fakeDb() };
    assert.equal(await saveTurn(env, 'mem_1', '', 'reply'), false);
    assert.equal(await saveTurn(env, 'mem_1', 'ask', ''), false);
    assert.equal(env.DB.rows.length, 0);
  });
  test('no DB → nothing, no throw', async () => {
    assert.deepEqual(await loadTurns({}, 'mem_1'), []);
    assert.equal(await saveTurn({}, 'mem_1', 'a', 'b'), false);
  });
});
