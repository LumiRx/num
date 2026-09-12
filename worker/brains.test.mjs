// The brain chain: which models Num will talk to, in what order, and what each
// one is allowed to do.
//
// The rule this file protects: a brain that cannot produce the full reply schema
// must never be able to mint a booking, and a brain that CAN produce it must
// still be switched on deliberately rather than by arriving in the list. See
// worker/brains.mjs for why — the short version is that a cheap answer beats an
// outage, and an invented reservation is worse than either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BRAINS, byId, canAct, emitsPicks, roster } from './brains.mjs';

/* ── GROK, ADDED 12 SEP 2026 ──────────────────────────────────────────────
 *
 * A fourth independent bill above the prose line. These tests exist because the
 * shared `openai-compatible` adapter makes adding a vendor almost free, and
 * "almost free" is where the two expensive mistakes live: letting a brand-new
 * vendor request real bookings on day one, and sending it another vendor's
 * model name.
 */

test('grok is a structured brain on its own quota', () => {
  const g = byId('grok');
  assert.ok(g, 'the grok brain is gone');
  assert.equal(g.kind, 'openai-compatible', 'no new adapter should have been needed');
  assert.equal(g.structured, true, 'a prose brain cannot produce cards or places');
  assert.equal(emitsPicks(g), true);
});

test('grok needs ONLY its own variables — no shared key with another vendor', () => {
  // A shared variable would mean configuring one vendor silently enabled
  // another, and rotating one key broke two lanes.
  const g = byId('grok');
  assert.deepEqual(g.env.base, ['NUM_XAI_BASE_URL']);
  assert.deepEqual(g.env.key, ['NUM_XAI_KEY']);
  assert.deepEqual(g.env.model, ['NUM_XAI_MODEL']);
  assert.equal(g.ready({}), false, 'unconfigured must not be ready');
  assert.equal(g.ready({ NUM_XAI_BASE_URL: 'https://api.x.ai/v1' }), true);
  // And it must not be switched on by the OpenAI lane's variables.
  assert.equal(g.ready({ NUM_OPENAI_BASE_URL: 'https://api.openai.com/v1' }), false);
});

test('grok cannot act until its OWN switch is set', () => {
  const g = byId('grok');
  assert.equal(canAct(g, {}), false, 'a new vendor must not act on day one');
  assert.equal(canAct(g, { NUM_OPENAI_ACTIONS: '1' }), false,
    'approving OpenAI actions must not approve xAI actions');
  assert.equal(canAct(g, { NUM_XAI_ACTIONS: '1' }), true);
  assert.equal(canAct(g, { NUM_XAI_ACTIONS: 'true' }), false, 'only the exact "1" counts');
});

test('grok declares its own default model, so it is never sent a rival\'s', () => {
  // The adapter used to fall back to 'gpt-5-mini' for ANY openai-compatible
  // brain with no model variable set. Pointed at api.x.ai that fails with a
  // vendor error, which reads like an outage rather than a missing variable.
  const g = byId('grok');
  assert.equal(g.fallbackModel, 'grok-4.6');
  const src = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
  assert.match(src, /brain\.fallbackModel \|\| 'gpt-5-mini'/,
    'the per-brain default is gone; every vendor gets OpenAI\'s model name again');
});

test('grok is ranked for independence, and the note does not pretend it is cheap', () => {
  // grok-4.6 is $2/$6 per Mtok against GPT-5 mini's fraction of that. Ranking
  // it as a cost lane would be a claim the invoice disproves.
  const ids = BRAINS.map((b) => b.id);
  assert.ok(ids.indexOf('grok') > ids.indexOf('openai'), 'grok should sit below the cheaper strict lane');
  assert.ok(ids.indexOf('grok') < ids.indexOf('hosted'), 'a structured brain belongs above a prose one');
  assert.match(byId('grok').note, /independence, not price/i);
});

test('the roster reports grok honestly when it is configured', () => {
  const env = { NUM_XAI_BASE_URL: 'https://api.x.ai/v1', NUM_XAI_MODEL: 'grok-4.6' };
  const row = roster(env).find((r) => r.id === 'grok');
  assert.equal(row.ready, true);
  assert.equal(row.model, 'grok-4.6', 'which vendor is answering guests must never be secret');
  assert.equal(row.can_act, false, '"can produce a booking card" is not "may request the booking"');
  assert.equal(row.picks, true);
});
