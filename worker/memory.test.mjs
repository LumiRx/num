// Per-member server-side memory.
//
// Before this file, everything "remembering" looked like it worked only
// because the client (src/lib/data.ts) mirrors the whole profile into
// localStorage and sends it back every turn. That covers one browser on one
// device. A guest who is phone-verified (num_members — a real, stable
// identity) and reinstalls the app, or opens Num on a second device, hit
// prompt.mjs's empty KNOWN FACTS block and got asked their name again.
//
// These tests are about the three ways a fix like this goes wrong:
//   1. it forgets to load what was actually saved (loadFacts),
//   2. it saves the wrong things, or corrupts a correction into a duplicate
//      row instead of an update (saveFacts upsert),
//   3. it has no ceiling and one guest's row count can grow without bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  loadFacts, saveFacts, forgetFact, MAX_FACTS_PER_MEMBER, _resetSchemaCache,
} from './memory.mjs';

function env() {
  _resetSchemaCache();
  const d = new DatabaseSync(':memory:');
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
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return { DB, raw: d };
}

test('a brand new member has no known facts, and loading never throws', async () => {
  const { DB } = env();
  const facts = await loadFacts({ DB }, 'mem_1');
  assert.deepEqual(facts, {});
});

test('loadFacts with no DB binding returns empty rather than throwing', async () => {
  assert.deepEqual(await loadFacts({}, 'mem_1'), {});
  assert.deepEqual(await loadFacts(null, 'mem_1'), {});
});

test('loadFacts with no memberId returns empty without touching the DB', async () => {
  const { DB } = env();
  assert.deepEqual(await loadFacts({ DB }, null), {});
  assert.deepEqual(await loadFacts({ DB }, ''), {});
});

test('a remember action round-trips through saveFacts then loadFacts', async () => {
  const { DB } = env();
  await saveFacts({ DB }, 'mem_1', [{ type: 'remember', key: 'dietary', value: 'pescatarian' }]);
  const facts = await loadFacts({ DB }, 'mem_1');
  assert.deepEqual(facts, { dietary: 'pescatarian' });
});

test('non-remember actions are ignored, remember actions are not', async () => {
  const { DB } = env();
  await saveFacts({ DB }, 'mem_1', [
    { type: 'add_booking', booking: { id: 'x' } },
    { type: 'remember', key: 'home_city', value: 'Austin' },
  ]);
  assert.deepEqual(await loadFacts({ DB }, 'mem_1'), { home_city: 'Austin' });
});

test('a later remember for the same key CORRECTS it, not duplicates it', async () => {
  const { DB } = env();
  await saveFacts({ DB }, 'mem_1', [{ type: 'remember', key: 'dietary', value: 'vegan' }]);
  await saveFacts({ DB }, 'mem_1', [{ type: 'remember', key: 'dietary', value: 'vegetarian' }]);
  const facts = await loadFacts({ DB }, 'mem_1');
  assert.deepEqual(facts, { dietary: 'vegetarian' }, 'the correction must win, and there must be only one row');
});

test('facts are scoped per member — one guest never sees another’s', async () => {
  const { DB } = env();
  await saveFacts({ DB }, 'mem_1', [{ type: 'remember', key: 'name', value: 'Dre' }]);
  await saveFacts({ DB }, 'mem_2', [{ type: 'remember', key: 'name', value: 'Sam' }]);
  assert.deepEqual(await loadFacts({ DB }, 'mem_1'), { name: 'Dre' });
  assert.deepEqual(await loadFacts({ DB }, 'mem_2'), { name: 'Sam' });
});

test('keys are case-folded so "Dietary" and "dietary" are the same fact', async () => {
  const { DB } = env();
  await saveFacts({ DB }, 'mem_1', [{ type: 'remember', key: 'Dietary', value: 'pescatarian' }]);
  await saveFacts({ DB }, 'mem_1', [{ type: 'remember', key: 'dietary', value: 'vegan' }]);
  assert.deepEqual(await loadFacts({ DB }, 'mem_1'), { dietary: 'vegan' });
});

test('saveFacts with no memberId, no DB, or an empty action list is a no-op', async () => {
  const { DB } = env();
  await saveFacts(null, 'mem_1', [{ type: 'remember', key: 'name', value: 'Dre' }]);
  await saveFacts({ DB }, null, [{ type: 'remember', key: 'name', value: 'Dre' }]);
  await saveFacts({ DB }, 'mem_1', []);
  await saveFacts({ DB }, 'mem_1', null);
  assert.deepEqual(await loadFacts({ DB }, 'mem_1'), {});
});

test('a remember action missing a key or value is dropped, not stored blank', async () => {
  const { DB } = env();
  await saveFacts({ DB }, 'mem_1', [
    { type: 'remember', key: '', value: 'x' },
    { type: 'remember', key: 'y', value: '' },
    { type: 'remember', key: null, value: null },
  ]);
  assert.deepEqual(await loadFacts({ DB }, 'mem_1'), {});
});

test('a member cannot grow past MAX_FACTS_PER_MEMBER distinct keys', async () => {
  const { DB } = env();
  const many = Array.from({ length: MAX_FACTS_PER_MEMBER + 10 }, (_, i) => ({
    type: 'remember', key: `k${i}`, value: `v${i}`,
  }));
  await saveFacts({ DB }, 'mem_1', many);
  const facts = await loadFacts({ DB }, 'mem_1');
  assert.equal(Object.keys(facts).length, MAX_FACTS_PER_MEMBER, 'the ceiling must actually bind');
});

test('once full, a CORRECTION to an existing key still lands — only brand-new keys wait', async () => {
  const { DB } = env();
  const first = Array.from({ length: MAX_FACTS_PER_MEMBER }, (_, i) => ({
    type: 'remember', key: `k${i}`, value: `v${i}`,
  }));
  await saveFacts({ DB }, 'mem_1', first);
  // Correct an existing key, and try to add one brand new key, in the same call.
  await saveFacts({ DB }, 'mem_1', [
    { type: 'remember', key: 'k0', value: 'corrected' },
    { type: 'remember', key: 'brand_new', value: 'nope' },
  ]);
  const facts = await loadFacts({ DB }, 'mem_1');
  assert.equal(facts.k0, 'corrected', 'a correction to an existing key must never be blocked by the ceiling');
  assert.equal(facts.brand_new, undefined, 'a brand new key past the ceiling must wait, not evict an older fact');
  assert.equal(Object.keys(facts).length, MAX_FACTS_PER_MEMBER);
});

test('long keys and values are truncated, not rejected outright', async () => {
  const { DB } = env();
  const longKey = 'k'.repeat(100);
  const longValue = 'v'.repeat(1000);
  await saveFacts({ DB }, 'mem_1', [{ type: 'remember', key: longKey, value: longValue }]);
  const facts = await loadFacts({ DB }, 'mem_1');
  const [storedKey, storedValue] = Object.entries(facts)[0];
  assert.ok(storedKey.length <= 40, 'key must be capped');
  assert.ok(storedValue.length <= 300, 'value must be capped');
});

test('forgetFact removes exactly one key and leaves the rest', async () => {
  const { DB } = env();
  await saveFacts({ DB }, 'mem_1', [
    { type: 'remember', key: 'name', value: 'Dre' },
    { type: 'remember', key: 'dietary', value: 'vegan' },
  ]);
  await forgetFact({ DB }, 'mem_1', 'dietary');
  assert.deepEqual(await loadFacts({ DB }, 'mem_1'), { name: 'Dre' });
});

test('forgetFact with no memberId or key is a no-op, never throws', async () => {
  const { DB } = env();
  await forgetFact({ DB }, null, 'dietary');
  await forgetFact({ DB }, 'mem_1', null);
  await forgetFact(null, 'mem_1', 'dietary');
});

test('a DB that throws on every call degrades loadFacts to {} instead of failing the turn', async () => {
  const angry = { DB: { prepare() { throw new Error('D1 is down'); } } };
  assert.deepEqual(await loadFacts(angry, 'mem_1'), {});
});

test('a DB that throws on every call makes saveFacts a silent no-op, never a thrown error', async () => {
  const angry = { DB: { prepare() { throw new Error('D1 is down'); } } };
  await assert.doesNotReject(saveFacts(angry, 'mem_1', [{ type: 'remember', key: 'name', value: 'Dre' }]));
});
