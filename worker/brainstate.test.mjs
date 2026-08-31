// The brain chain is the last thing between a guest and an outage.
//
// On 2026-08-06 all six configured brains failed at once and /api/num returned
// a graceful apology with HTTP 200 — the right answer for the guest, and
// invisible to every monitor we had. These tests guard the two behaviours that
// came out of that: stand a failing brain down for a sensible period, and
// never let standing them down become the outage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, cooldownFor, plan } from './brainstate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const brains = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const B = (id) => ({ id });
const cooling = (...ids) => new Map(ids.map((id) => [id, { cooling: true, fails: 1 }]));

test('EVERY brain cooling still returns every brain', () => {
  // The whole point. A breaker that opens on everything manufactures the
  // outage it exists to prevent — and one of them may have quietly recovered,
  // which we can only discover by asking.
  const chain = [B('claude'), B('gpt-oss-120b'), B('llama-3.3-70b')];
  const { order, healthy } = plan(chain, cooling('claude', 'gpt-oss-120b', 'llama-3.3-70b'));
  assert.equal(order.length, 3, 'a fully-cooled chain dropped brains — that is a self-inflicted outage');
  assert.equal(healthy, 0);
});

test('cooling brains are demoted, not removed', () => {
  const chain = [B('claude'), B('gpt-oss-120b'), B('llama-3.3-70b')];
  const { order } = plan(chain, cooling('claude'));
  assert.deepEqual(order.map((b) => b.id), ['gpt-oss-120b', 'llama-3.3-70b', 'claude'],
    'a cooling brain must sink to last, and must still be there');
});

test('a healthy chain keeps its configured order', () => {
  // Order is a deliberate quality decision — Claude is the only brain that can
  // book anything. Reordering a healthy chain would silently downgrade every
  // answer.
  const chain = [B('claude'), B('gpt-oss-120b')];
  const { order } = plan(chain, new Map());
  assert.deepEqual(order.map((b) => b.id), ['claude', 'gpt-oss-120b']);
});

test('failures are classified by what a human would have to do about them', () => {
  assert.equal(classify(new Error('401 Unauthorized: invalid api key')), 'auth');
  assert.equal(classify(new Error('Your credit balance is too low')), 'quota');
  assert.equal(classify(new Error('429 Too Many Requests')), 'rate');
  assert.equal(classify(new Error('model claude-opus-9 does not exist')), 'model');
  assert.equal(classify(new Error('socket hang up')), 'transient');
  assert.equal(classify(new Error('Daily neuron quota exceeded')), 'quota',
    'Workers AI reports exhaustion in neurons — misreading that as transient would hammer a dead quota');
});

test('a bad key stands down far longer than a busy minute', () => {
  // Waiting does not fix a revoked key, and retrying it every turn burns the
  // latency budget of every guest for nothing.
  assert.ok(cooldownFor('auth', 1) > cooldownFor('rate', 1) * 10,
    'an auth failure cooled down like a rate limit would retry a dead key all day');
  assert.equal(cooldownFor('rate', 1), 60);
});

test('repeat failures back off, but never past an hour', () => {
  assert.ok(cooldownFor('rate', 3) > cooldownFor('rate', 1), 'repeats must back off');
  assert.ok(cooldownFor('quota', 99) <= 3600,
    'an unbounded backoff would leave a recovered brain unused for a whole day');
});

test('the chain consults state before choosing an order', () => {
  assert.match(code(brains), /planChain\(chain\(env\), state\)/,
    'ask() is not using the plan — cooling brains would still be tried first');
});

test('success clears a standing failure', () => {
  // Without this a brain that recovers stays demoted until its cooldown
  // happens to expire, which silently keeps the best brain out of the chain.
  assert.match(code(brains), /recordBrainSuccess\(env, brain\.id, state\)/,
    'a successful answer does not clear the failure record');
});

test('whole-chain failure is logged loudly, not inferred from a status code', () => {
  // /api/num answers 200 with an apology when everything fails. That is right
  // for the guest and invisible to a monitor, so the log line is the only
  // signal that exists at that moment.
  assert.match(code(brains), /console\.error\('\[brains\] EVERY BRAIN FAILED/,
    'the one condition that never shows up as a bad status code is not being logged');
});

// ── 31 Aug 2026: the health check that sent a human after the wrong thing ──

test('the brain health check must actually call the brain', () => {
  // It read, in full: `if (!env.ANTHROPIC_API_KEY) return {ok:false}; return
  // {ok:true}` — a configuration check reported as a health check. So when
  // both Anthropic brains were failing, `brain: ok` was TRUE throughout, and
  // the only thing that noticed was the cooldown table. Then the cooldown
  // lapsed and everything went green with nothing proven either way.
  const health = readFileSync(new URL('./health.mjs', import.meta.url), 'utf8');
  const probe = readFileSync(new URL('./brainprobe.mjs', import.meta.url), 'utf8');
  assert.match(probe, /api\.anthropic\.com/, 'nothing in the probe actually calls the vendor');
  const cron = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(cron, /proveBrains/, 'the probe is never run, so it proves nothing');
  // And the remedy must stop offering "mint a new key" for every class at once.
  assert.match(health, /Blocked:/, 'the operator remedy still lumps every failure class together');
});

test('a recovered brain stops carrying its old error', () => {
  // haiku recovered at 14:29 and still displayed a 403 at 15:41, because
  // recordSuccess cleared fails and cooldown but not last_error. A healthy
  // brain that looks broken is worse than no state at all.
  const src = readFileSync(new URL('./brainstate.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function recordSuccess'));
  const stmt = fn.slice(fn.indexOf('UPDATE num_brain_state'), fn.indexOf('WHERE brain'));
  assert.match(stmt, /last_error\s*=\s*NULL/,
    'recovery leaves the old error attached, so a working brain keeps reading as broken');
});

test('a reasoning model that ran out of room is alive, not dead', () => {
  // 31 Aug: the health probe called gpt-oss-120b and qwen3-30b with a 40-token
  // ceiling. Both are reasoning models — they think before they speak, put the
  // thinking in `reasoning_content`, and had no budget left for `content`. The
  // probe reported both as broken while production, which allows 700, was
  // using them happily. A liveness check that invents outages is worse than
  // none.
  const src = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
  const extract = src.slice(src.indexOf('function extractText'), src.indexOf('async function callProse'));
  assert.match(extract, /reasoning_content/,
    'a model that produced only reasoning still reads as having returned nothing');
  const probeFn = src.slice(src.indexOf('export async function probe'));
  assert.ok(!/maxTokens: 40\b/.test(probeFn.slice(0, probeFn.indexOf('\n}'))),
    'the probe still uses a budget too small for a reasoning model to answer in');
});
