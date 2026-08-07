// The guarantee: a guest never gets a dead reply.
//
// On 2026-08-06 every brain failed at once and the answer was "That one
// slipped away from me — say it once more." Warm, honest, useless: saying it
// again does not help when the cause is a quota that resets tomorrow, and it
// was the answer paid Reddit traffic got thirty seconds after clicking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastResort, readIntent } from './lastresort.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const GROUNDING = {
  place: { name: 'Phuket' },
  partners: [
    { name: 'Baan Rim Pa', km: 3.8 },
    { name: 'Suay Restaurant', km: 1.2 },
    { name: 'Kan Eang At Pier', km: 6.4 },
  ],
};

test('a total brain failure still answers with real places', () => {
  const out = lastResort({ userText: 'dinner tonight', grounding: GROUNDING, place: null });
  assert.ok(out, 'no reply produced — the guest would get the apology instead');
  assert.match(out.reply, /Baan Rim Pa/, 'the reply names no actual place');
  assert.match(out.reply, /3\.8 km/, 'distance is dropped — it is the most useful fact we hold');
});

test('it never claims to have booked anything', () => {
  // A template that cannot be reasoned with must not imply a reservation.
  // Inventing one is worse than the outage it is covering for.
  const out = lastResort({ userText: 'book me a table for four', grounding: GROUNDING, place: null });
  assert.ok(!/\b(booked|confirmed|reserved|held)\b/i.test(out.reply),
    'the no-model reply implies a booking it cannot have made');
  assert.match(out.reply, /can’t book/, 'it does not say plainly that booking is unavailable');
});

test('it never ranks', () => {
  // top_places rows are not quality-ranked anywhere in this product.
  const out = lastResort({ userText: 'best dinner in phuket', grounding: GROUNDING, place: null });
  assert.ok(!/\b(best|top|number one|#1|finest)\b/i.test(out.reply),
    'the reply ranks places the database does not rank');
});

test('with nothing to offer it returns null rather than an empty shell', () => {
  // A template with no content is worse than the honest apology, so the caller
  // keeps its existing wording in that case.
  assert.equal(lastResort({ userText: 'dinner', grounding: { partners: [] }, place: null }), null);
  assert.equal(lastResort({ userText: 'dinner', grounding: null, place: null }), null);
});

test('intent is read well enough to change the opening line', () => {
  assert.equal(readIntent('somewhere for dinner'), 'food');
  assert.equal(readIntent('need a driver to the airport'), 'car');
  assert.equal(readIntent('cocktails tonight'), 'night');
  assert.equal(readIntent('what is the wifi password'), 'other');
});

test('grounding survives into the catch block', () => {
  // The whole mechanism depends on this. `grounding` was const-scoped INSIDE
  // the try, so the catch could not see it — the last-resort reply would have
  // received null every single time and silently fallen through to the
  // apology, looking implemented while doing nothing.
  assert.match(code(index), /let grounding = null;[\s\S]{0,400}try \{/,
    'grounding is not hoisted above the try — the fallback cannot reach the partners it needs');
  assert.ok(!/const grounding = await groundRequest/.test(code(index)),
    'a block-scoped grounding shadows the hoisted one and the catch sees null again');
});

test('the fallback is actually wired into the failure path', () => {
  assert.match(code(index), /lastResort\(\{/, 'the no-model reply is never called');
  assert.match(code(index), /answered from the directory with no model/,
    'answering without a model is not logged — it would be invisible in an incident');
});

test('the self-hosted brain reads the same env names it claims to accept', () => {
  // ready() accepts OLLAMA_BASE_URL or JAN_BASE_URL. If callProse read only
  // one of them, the brain would report itself configured and then fetch
  // "undefined/chat/completions" — a brain that lies about being ready is
  // worse than one that is absent, because the chain stops looking.
  const brains = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  const ready = brains.slice(brains.indexOf("id: 'jan'"), brains.indexOf('];'));
  assert.match(ready, /OLLAMA_BASE_URL \|\| env\.JAN_BASE_URL/, 'ready() no longer accepts the Ollama alias');
  const call = brains.slice(brains.indexOf("brain.kind === 'openai-compatible'"));
  for (const v of ['OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'OLLAMA_API_KEY']) {
    assert.ok(call.includes(v), `callProse ignores ${v} — the brain would report ready and then fail on every call`);
  }
});
