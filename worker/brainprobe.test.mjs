import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, cooldownFor, fromVendorApi } from './brainstate.mjs';
import { probeBrain, proveBrains, unproven } from './brainprobe.mjs';

// The two bodies, verbatim from production. Everything below turns on the
// difference between them, so they are quoted rather than paraphrased.
const EDGE_403 = '403 {"error":{"type":"forbidden","message":"Request not allowed"}}';
const API_403 = '403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource"},"request_id":"req_011CeVTh3dQVgvqN4qe8175y"}';

const env = () => ({ ANTHROPIC_API_KEY: 'sk-ant-test' });

test('THE 31 AUG INCIDENT: an edge 403 is not a dead key', () => {
  // Both Anthropic brains failed in the same second with EDGE_403 and were
  // classified `auth`, which stood them down for an hour and printed "mint a
  // new key". haiku then made a successful call on the SAME key at 14:29,
  // unprompted — so the credential was never the problem and the remedy would
  // have wasted an evening.
  assert.equal(classify(Object.assign(new Error(EDGE_403), { status: 403 })), 'blocked');
  assert.equal(classify(Object.assign(new Error(API_403), { status: 403 })), 'auth',
    'a real vendor permission error must still read as auth — that one IS the key');
});

test('the vendor envelope is what tells them apart', () => {
  // A real Anthropic error carries `"type":"error"` and a request_id, because
  // something that knows about our account produced it. An edge rejection has
  // neither: the request died before the API saw it.
  assert.equal(fromVendorApi(API_403), true);
  assert.equal(fromVendorApi(EDGE_403), false);
  assert.equal(fromVendorApi('403 Forbidden<html><body>nginx</body></html>'), false);
  assert.equal(fromVendorApi(''), false);
});

test('a 401 is always the credential, whatever the body looks like', () => {
  // 401 is unambiguous — the vendor is saying "I do not accept this key".
  // Only 403 is ambiguous about WHO refused.
  assert.equal(classify(Object.assign(new Error('401 Unauthorized'), { status: 401 })), 'auth');
  assert.equal(classify(new Error('401 Unauthorized: invalid api key')), 'auth');
});

test('a block is cooled down like weather, not like a broken key', () => {
  // An hour of self-inflicted downtime for a condition that cleared itself in
  // under a minute is the cost of getting this wrong.
  assert.equal(cooldownFor('blocked', 1), 60);
  assert.ok(cooldownFor('auth', 1) >= 3600,
    'a genuinely dead key must still stand down hard — this is not a licence to retry it');
  assert.ok(cooldownFor('blocked', 1) < cooldownFor('auth', 1) / 10);
});

test('only a brain nobody is protecting any more gets probed', () => {
  const now = 1_000_000;
  const rows = [
    { brain: 'claude', fails: 1, cooldown_until: now - 5 },   // lapsed: unproven
    { brain: 'haiku', fails: 1, cooldown_until: now + 600 },  // still cooling: leave it
    { brain: 'hosted', fails: 3, cooldown_until: now - 5 },   // not an Anthropic brain
  ];
  assert.deepEqual(unproven(rows, now), ['claude']);
  // A healthy chain must probe nothing at all — that is what makes this free.
  assert.deepEqual(unproven([{ brain: 'claude', fails: 0, cooldown_until: 0 }], now), []);
  assert.deepEqual(unproven([], now), []);
});

test('a probe that recovers clears the standing failure', async () => {
  const writes = [];
  const e = {
    ...env(),
    DB: {
      prepare(sql) {
        return {
          bind(...args) { return { async run() { writes.push({ sql, args }); return {}; }, async first() { return null; } }; },
          async all() { return { results: [{ brain: 'claude', fails: 1, class: 'blocked', cooldown_until: 1 }] }; },
          async run() { return {}; },
        };
      },
      async batch(st) { return st.map((x) => x.run()); },
    },
  };
  const out = await proveBrains(e, { now: 2_000_000, fetchImpl: async () => ({ ok: true, async text() { return ''; } }) });
  assert.deepEqual(out.recovered, ['claude']);
  assert.deepEqual(out.still_down, []);
  assert.ok(writes.some((w) => /UPDATE num_brain_state SET fails = 0/.test(w.sql)),
    'a recovered brain was not cleared, so it would keep reading as broken');
});

test('a probe that fails re-arms the cooldown instead of probing every tick', async () => {
  const writes = [];
  const e = {
    ...env(),
    DB: {
      prepare(sql) {
        return {
          bind(...args) { return { async run() { writes.push({ sql, args }); return {}; }, async first() { return { fails: 1, class: 'blocked' }; } }; },
          async all() { return { results: [{ brain: 'claude', fails: 1, class: 'blocked', cooldown_until: 1 }] }; },
          async run() { return {}; },
        };
      },
      async batch(st) { return st.map((x) => x.run()); },
    },
  };
  const out = await proveBrains(e, {
    now: 2_000_000,
    fetchImpl: async () => ({ ok: false, status: 403, async text() { return '{"error":{"type":"forbidden","message":"Request not allowed"}}'; } }),
  });
  assert.equal(out.recovered.length, 0);
  assert.equal(out.still_down[0].brain, 'claude');
  assert.equal(out.still_down[0].class, 'blocked', 'the probe disagreed with production about the same error');
  assert.ok(writes.some((w) => /INSERT INTO num_brain_state/.test(w.sql)),
    'the failure was not recorded, so the next tick would probe again immediately');
});

test('the probe reads the body, not just the status line', async () => {
  // Discarding the body would collapse the two 403s back into one and rebuild
  // the exact bug this file exists to fix.
  const asEdge = await probeBrain(env(), 'claude', {
    fetchImpl: async () => ({ ok: false, status: 403, async text() { return '{"error":{"type":"forbidden","message":"Request not allowed"}}'; } }),
  });
  const asApi = await probeBrain(env(), 'claude', {
    fetchImpl: async () => ({ ok: false, status: 403, async text() { return '{"type":"error","error":{"type":"permission_error","message":"no permission"},"request_id":"req_1"}'; } }),
  });
  assert.equal(asEdge.class, 'blocked');
  assert.equal(asApi.class, 'auth');
});

test('the probe is one token and no more', async () => {
  let sent = null;
  await probeBrain(env(), 'haiku', {
    fetchImpl: async (_u, init) => { sent = JSON.parse(init.body); return { ok: true, async text() { return ''; } }; },
  });
  assert.equal(sent.max_tokens, 1, 'a health probe that generates a paragraph is a health probe nobody will keep');
  assert.match(sent.model, /haiku/, 'the probe must call the model the brain actually uses');
  assert.equal(sent.tools, undefined, 'the probe should not carry tools — it is testing reachability, not behaviour');
});

test('no key means no probe, and no pretending', async () => {
  const out = await probeBrain({}, 'claude');
  assert.equal(out.probed, false);
  assert.equal(out.ok, undefined, 'an unprobeable brain must not report a verdict it never earned');
});

test('a brain we cannot reach is skipped, never guessed at', async () => {
  const out = await probeBrain(env(), 'hosted');
  assert.equal(out.probed, false);
  assert.match(out.reason, /not probeable/);
});

test('the manual endpoint and the cron ask the same question', async () => {
  // Two probe implementations would drift, and the one that drifted would be
  // the one nobody ran. /api/brains?probe=1 used to answer `ok: null` for the
  // structured brains — the only two that have ever taken the product down —
  // so during the 31 Aug outage the single hand-reachable diagnostic had
  // nothing to say about the thing that was broken.
  const { readFileSync } = await import('node:fs');
  const brains = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
  const fn = brains.slice(brains.indexOf('export async function probe'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /probeBrain/, 'the manual probe rolls its own check instead of the shared one');
  assert.ok(!/not probed \(a probe costs a real turn\)/.test(body),
    'the structured brains are still opted out of the only probe that could have caught this');
});
