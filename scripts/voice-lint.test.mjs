// The voice lint has to be proved by FAILING, not by passing.
//
// A lint that is clean on day one and clean forever is indistinguishable from
// a lint that does nothing. Every rule below is fired deliberately against a
// fixture, and the negation escape hatch is tested in both directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSource, lintAll, lintFile, LINTED, RULES } from './voice-lint.mjs';

const src = (literal) => `export const COPY = \`${literal}\`;`;
const ids = (findings) => findings.map((f) => f.rule).sort();

/* ── every rule fires ─────────────────────────────────────────────────── */

test('instructing the member trips the lint', () => {
  assert.deepEqual(ids(lintSource(src('You should book that early.'))), ['instructing']);
  assert.deepEqual(ids(lintSource(src('Make sure you bring the passport.'))), ['instructing']);
  assert.deepEqual(ids(lintSource(src('You need to leave by six.'))), ['instructing']);
});

test('accounting language inside a conversation trips the lint', () => {
  assert.deepEqual(ids(lintSource(src('That is included in your plan.'))), ['accounting']);
  assert.deepEqual(ids(lintSource(src('You have two requests remaining this month.'))), ['accounting']);
  assert.deepEqual(ids(lintSource(src('Upgrade to unlock the concierge line.'))), ['accounting']);
});

test('claiming the friendship trips the lint', () => {
  assert.deepEqual(ids(lintSource(src("I'm your friend, remember."))), ['claiming-friendship']);
  assert.deepEqual(ids(lintSource(src("We're in this together."))), ['claiming-friendship']);
});

test('taking credit trips the lint', () => {
  assert.deepEqual(ids(lintSource(src('Glad I could help!'))), ['taking-credit']);
  assert.deepEqual(ids(lintSource(src('I took care of it for you.'))), ['taking-credit']);
});

test('closing down good news trips the lint', () => {
  assert.deepEqual(ids(lintSource(src('Glad it went well.'))), ['closing-good-news']);
  assert.deepEqual(ids(lintSource(src("That's great to hear."))), ['closing-good-news']);
});

test('every declared rule has a fixture that fires it', () => {
  // Guards against a rule being added with a pattern that can never match.
  const fired = new Set(ids(lintSource(src(
    "You should go. That is included in your plan. I'm your friend. Glad I could help. Glad it went well.",
  ))));
  for (const r of RULES) assert.ok(fired.has(r.id), `rule "${r.id}" never fired`);
});

/* ── the negation escape hatch, both directions ───────────────────────── */

test('teaching the rule is allowed — the house voice has to say the phrase', () => {
  assert.deepEqual(lintSource(src('Never tell them you should do anything.')), []);
  assert.deepEqual(lintSource(src("Do not say I'm your friend.")), []);
  assert.deepEqual(lintSource(src('Avoid "glad it went well" — ask them about it instead.')), []);
});

test('a distant negation cannot smuggle a real violation through', () => {
  const far = 'Never do that. ' + 'x'.repeat(80) + ' You should book early.';
  assert.deepEqual(ids(lintSource(src(far))), ['instructing']);
});

/* ── comments are not linted, deliberately ───────────────────────────── */

test('a violation in a comment is ignored, as in travelspeak-lint', () => {
  assert.deepEqual(lintSource('// you should never write this\nconst a = 1;'), []);
  assert.deepEqual(lintSource('/* glad I could help */\nconst a = 1;'), []);
});

/* ── the real surfaces ────────────────────────────────────────────────── */

test('every linted file exists — a missing surface is an unlinted one', () => {
  for (const f of LINTED) {
    assert.equal(lintFile(f).missing, false, `${f} is in LINTED but not on disk`);
  }
});

test('the live voice surfaces are clean', () => {
  const findings = lintAll();
  assert.deepEqual(findings, [], findings.map((f) => `${f.file}:${f.line} [${f.rule}] "${f.match}"`).join('\n'));
});
