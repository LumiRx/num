// Structured output on the cheap lane — and the boundary it must not cross.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHosted } from './brains.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('a JSON reply yields prose and chips', () => {
  const r = readHosted('{"reply":"Krua Thai — solid and close.","chips":[{"id":"book","label":"Book a table"}]}');
  assert.equal(r.reply, 'Krua Thai — solid and close.');
  assert.deepEqual(r.chips, [{ id: 'book', label: 'Book a table' }]);
});

test('a fenced block is unwrapped', () => {
  // The most common shape when a model is told to be conversational AND to
  // return JSON.
  const r = readHosted('```json\n{"reply":"Yes — eight minutes downhill."}\n```');
  assert.equal(r.reply, 'Yes — eight minutes downhill.');
});

test('plain prose from a vendor that ignored response_format still works', () => {
  const r = readHosted('Krua Thai is open until ten. Want me to call?');
  assert.equal(r.reply, 'Krua Thai is open until ten. Want me to call?');
  assert.equal(r.chips, null);
});

test('broken JSON is shown as prose, never lost', () => {
  // The guarantee: no input to this function costs a guest their answer.
  const half = '{"reply":"Krua Thai is the one, ';
  // Compared trimmed: the reader trims, which is right — a reply with
  // trailing whitespace renders as an odd gap in the bubble.
  assert.equal(readHosted(half).reply, half.trim());
  assert.equal(readHosted('').reply, '');
  assert.equal(readHosted(null).reply, '');
});

test('JSON with no reply falls back to the raw text', () => {
  // Returning the parsed object here would show a guest an empty bubble —
  // worse than showing them the JSON.
  const raw = '{"chips":[{"id":"x","label":"y"}]}';
  assert.equal(readHosted(raw).reply, raw);
});

test('bare-string chips are accepted and slugged', () => {
  const r = readHosted('{"reply":"ok","chips":["Book a table","Somewhere cheaper"]}');
  assert.deepEqual(r.chips.map((c) => c.id), ['book-a-table', 'somewhere-cheaper']);
});

test('chips are capped and junk is dropped', () => {
  const r = readHosted('{"reply":"ok","chips":[1,null,{"nope":1},"a","b","c","d","e"]}');
  assert.ok(r.chips.length <= 4, 'an unbounded chip array reached the UI');
  assert.ok(r.chips.every((c) => c.id && c.label));
});

test('the cheap lane can never mint a card or an action', () => {
  // Every card tag in REPLY_SCHEMA is a booking state — confirmed, hold,
  // deposit, paid. A prose model producing "confirmed" is the worst bug this
  // product could ship, so the parser has no path to either field.
  const r = readHosted('{"reply":"done","card":{"title":"Table","meta":"8pm","tag":"confirmed"},"actions":[{"type":"air"}]}');
  assert.equal(r.card, undefined, 'the hosted parser now returns a card');
  assert.equal(r.actions, undefined, 'the hosted parser now returns actions');
  const src = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  assert.match(src, /card: null,\s*\n\s*chips: read\.chips,\s*\n\s*actions: \[\],/,
    'the hosted return grew a card or an action — that is a security boundary, not a feature gap');
});

test('degraded means the turn needed something we could not do', () => {
  // Hard-coded `true` would page us on every correctly-routed recommendation
  // forever: scripts/uptime.mjs treats degraded:true as an outage. A monitor
  // that cries wolf on success trains you to ignore it on the night it is
  // right.
  const src = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  assert.match(src, /_degraded: !directive \|\| directive\.tier === 'critical' \|\| directive\.tier === 'complex'/,
    'degraded is hard-coded again — the uptime probe will report a permanent outage');
  const probe = readFileSync(join(HERE, '..', 'scripts', 'uptime.mjs'), 'utf8');
  assert.match(probe, /downIfBodyMatches: \/"degraded"\\s\*:\\s\*true\//,
    'the probe no longer treats degraded as an outage — check that was intentional before relaxing the line above');
});

test('only the hosted lane is asked for JSON', () => {
  // Workers AI models are small enough that demanding a wrapper costs more
  // answers than it gains chips.
  const src = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  assert.match(src, /const wantJson = brain\.kind === 'openai-compatible';/);
});
