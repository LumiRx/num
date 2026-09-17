// The chain is hedged, not serial: a leader that stalls no longer costs its
// whole timeout before the next brain is asked. 17 Sep 2026, after production
// measured 25–40 s a turn with 62 ms of CPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask } from './brains.mjs';

/** A D1 that swallows brain-state reads and writes. */
const db = {
  prepare() {
    const s = { bind() { return s; }, run: async () => ({}), all: async () => ({ results: [] }), first: async () => null };
    return s;
  },
};

// Two structured Anthropic brains (claude, haiku) are `ready` when the key
// is set; both go through `structuredCall`, which the test controls. The
// order is decided by the directive, so `claude` leads and `haiku` hedges.
const env = { DB: db, ANTHROPIC_API_KEY: 'k', NUM_HEDGE_MS: '1500', NUM_MODEL: 'claude-opus-5' };
const directive = { tier: 'moderate', steps: [{ brain: 'claude', model: 'claude-opus-5' }, { brain: 'haiku', model: 'claude-haiku-4-5' }] };

test('a stalled leader hands over at the hedge and the answer arrives from the next brain', async () => {
  const calls = [];
  const structuredCall = async (_x, model) => {
    calls.push(model);
    if (model === 'claude-opus-5') { await new Promise((r) => setTimeout(r, 6000)); return { reply: 'late', chips: [], picks: [], actions: [], card: null }; }
    await new Promise((r) => setTimeout(r, 200));
    return { reply: 'quick', chips: [], picks: [], actions: [], card: null };
  };
  const t0 = Date.now();
  const out = await ask(env, { structuredCall, messages: [{ role: 'user', content: 'hi' }], persona: 'p', voice: 'v', context: 'c', style: '', directive });
  const ms = Date.now() - t0;
  assert.equal(out.reply, 'quick');
  assert.equal(out._brain, 'haiku');
  assert.ok(ms < 4000, `took ${ms} ms — the hedge did not fire`);
  assert.ok(ms >= 1400, `took ${ms} ms — the leader was not given its head start`);
  assert.deepEqual(calls, ['claude-opus-5', 'claude-haiku-4-5']);
});

test('a leader that answers in time still leads, and nobody else is asked', async () => {
  const calls = [];
  const structuredCall = async (_x, model) => { calls.push(model); return { reply: `from ${model}`, chips: [], picks: [], actions: [], card: null }; };
  const out = await ask(env, { structuredCall, messages: [{ role: 'user', content: 'hi' }], persona: 'p', voice: 'v', context: 'c', style: '', directive });
  assert.equal(out._brain, 'claude');
  assert.deepEqual(calls, ['claude-opus-5']);
});

test('a leader that fails at once hands over at once — no hedge wait', async () => {
  const structuredCall = async (_x, model) => {
    if (model === 'claude-opus-5') throw new Error('claude HTTP 500');
    return { reply: 'backup', chips: [], picks: [], actions: [], card: null };
  };
  const t0 = Date.now();
  const out = await ask(env, { structuredCall, messages: [{ role: 'user', content: 'hi' }], persona: 'p', voice: 'v', context: 'c', style: '', directive });
  assert.equal(out._brain, 'haiku');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(out._tried[0].brain, 'claude');
});
