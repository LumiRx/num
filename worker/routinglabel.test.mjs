// THE "BRAIN IS DOWN" THAT WAS A LABEL, NOT AN OUTAGE.
//
// Reported 3 Sep 2026. Every brain reported ready, /api/health said ok, and
// brains_state.cooling was empty — while the dashboard showed the most-used
// lane as `moderate:none` with brain NULL on 12 of 41 asks. All twelve were
// corrective retries: the answer was fine, the record of who produced it was
// thrown away by a spread that overwrote `_brain` with nothing.
//
// These are the guards for the columns we make decisions from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepRouting, fallbackRouting, laneLabel } from './routinglabel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Line comments only. Stripping block comments as well eats half of
// index.mjs — a regex literal in there closes one early — and a guard that
// scans the wrong half of a file is a guard that passes for the wrong reason.
const code = (s) => s.replace(/(^|[^:])\/\/.*$/gm, '$1');

test('a corrected answer is never filed as "no brain answered"', () => {
  const prev = { reply: 'bad', _brain: 'haiku', _tried: ['claude', 'haiku'], _degraded: false };
  const out = keepRouting({ reply: 'good', _model: 'claude-opus-5' }, prev);
  assert.equal(out._brain, 'claude');
  assert.notEqual(laneLabel({ tier: 'moderate' }, out), 'moderate:none');
  assert.equal(laneLabel({ tier: 'moderate' }, out), 'moderate:claude');
});

test('the brain that answered FIRST is kept, so escalations stay visible', () => {
  const out = keepRouting({ reply: 'good' }, { _brain: 'haiku', _tried: ['haiku'] });
  assert.equal(out._first, 'haiku');
  assert.deepEqual(out._tried, ['haiku']);
  assert.equal(out._retried, true);
});

test('a retry prices at the model that produced the shipped text', () => {
  const out = keepRouting({ reply: 'good', _model: 'claude-opus-5' }, { _brain: 'haiku', _model: 'claude-haiku-4-5' });
  assert.equal(out._model, 'claude-opus-5');
});

test('a retry with no model reported prices at null, never at the old one', () => {
  // Silently inheriting the previous model would bill an Opus rescue at the
  // Haiku rate — a wrong number is worse than a missing one.
  const out = keepRouting({ reply: 'good' }, { _brain: 'haiku', _model: 'claude-haiku-4-5' });
  assert.equal(out._model, null);
});

test('the reply itself survives the relabelling', () => {
  const out = keepRouting({ reply: 'good', card: { id: 1 }, chips: ['a'] }, { _brain: 'haiku' });
  assert.equal(out.reply, 'good');
  assert.deepEqual(out.card, { id: 1 });
  assert.deepEqual(out.chips, ['a']);
});

test('a turn that recovered on the retry stops being degraded', () => {
  // A corrective retry only returns when the structured Claude path
  // answered. Keeping the old degraded flag would page the uptime probe for
  // an outage that had already resolved in front of the guest — while the
  // fallback below, which really did fail, still pages.
  const out = keepRouting({ reply: 'good' }, { _brain: 'hosted', _degraded: true });
  assert.equal(out._degraded, false);
  assert.equal(out._first, 'hosted');
});

test('the hard-coded fallback is attributed to nobody and pages', () => {
  const out = fallbackRouting('Ask me that once more?', { _brain: 'haiku', _tried: ['haiku'] });
  assert.equal(out._brain, null);
  assert.equal(out._degraded, true);
  assert.equal(laneLabel({ tier: 'moderate' }, out), 'moderate:none');
  // and it still says which brain had tried, so the row is diagnosable
  assert.equal(out._first, 'haiku');
});

test('the fallback carries no card or action a brain never minted', () => {
  const out = fallbackRouting('x', {});
  assert.equal(out.card, null);
  assert.deepEqual(out.actions, []);
});

test('laneLabel survives a missing directive rather than throwing', () => {
  assert.equal(laneLabel(null, { _brain: 'claude' }), 'unknown:claude');
  assert.equal(laneLabel({ tier: 'simple' }, null), 'simple:none');
});

test('the handler never spreads a retry over the result bare again', () => {
  const src = code(readFileSync(join(HERE, 'index.mjs'), 'utf8'));
  // The exact shape of the bug: `{ ...retry, ... }` / `{ ...fixed, ... }`
  // assigned straight to `result`, which drops _brain.
  assert.equal(/result\s*=\s*\{\s*\.\.\.(retry|fixed)\b/.test(src), false,
    'a corrective retry was assigned to result without keepRouting — this is the bug that filed healthy answers as lane :none');
});

test('the lane label is built by laneLabel, not re-inlined', () => {
  const src = code(readFileSync(join(HERE, 'index.mjs'), 'utf8'));
  assert.equal(/\$\{directive\.tier\}:\$\{result\._brain/.test(src), false,
    'the lane string was rebuilt inline; it must come from laneLabel so the :none alarm has one definition');
  assert.match(src, /laneLabel\(directive, result\)/);
});

test('askNum reports the model it actually used on every return', () => {
  const src = code(readFileSync(join(HERE, 'index.mjs'), 'utf8'));
  const body = src.slice(src.indexOf('async function askNum('), src.indexOf('async function logFeatureRequests('));
  // askNum's OWN exits, not the nested parse helper's: every one of them
  // reports usage, so that is the set that must also report the model. The
  // two travel together — a cost with no model attached is a cost nobody
  // can attribute.
  const returns = (body.match(/return \{[\s\S]*?\};/g) ?? []).filter((r) => /_usage:/.test(r));
  assert.ok(returns.length >= 4, `expected several askNum exits, found ${returns.length}`);
  for (const r of returns) {
    assert.match(r, /_model:/, `an askNum return site reports cost but not model:\n${r}`);
  }
});

test('the strong-model escalation updates the reported model', () => {
  const src = code(readFileSync(join(HERE, 'index.mjs'), 'utf8'));
  const i = src.indexOf('NUM_MODEL_STRONG');
  assert.ok(i > 0);
  // usedModel must be reassigned in the same breath as the escalation, or an
  // Opus rescue prices as whatever the cheap lane had chosen.
  assert.match(src.slice(i - 200, i + 200), /usedModel\s*=/);
});

test('the brain chain does not overwrite a real model with the directive null', () => {
  const brains = code(readFileSync(join(HERE, 'brains.mjs'), 'utf8'));
  assert.match(brains, /_model:\s*structuredModel\s*\?\?\s*out\._model/);
});
