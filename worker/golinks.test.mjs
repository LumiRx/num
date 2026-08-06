// The links every ad dollar flows through.
//
// A campaign link is the one piece of code where a silent mistake is billed by
// the click. On 2026-08-06 roughly 300 Reddit clicks landed on /watch/ — a
// working page, and the wrong destination: the ad had already sold the idea,
// and a second film before anyone could type was a stop rather than a start.
//
// These tests hold the two properties that are expensive to get wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
const GO = index.slice(index.indexOf('const GO = {'), index.indexOf('const to = GO['));

/** The literal destinations, as they will actually be served. */
const entries = [...GO.matchAll(/^\s*([a-z]+):\s*'([^']+)'/gm)].map(([, code, to]) => ({ code, to }));

test('every campaign code has a destination', () => {
  assert.ok(entries.length >= 5, `only ${entries.length} campaign codes parsed — the map shape changed`);
});

test('every destination carries its own attribution', () => {
  // Tagging happens server-side on purpose: some placements append their own
  // utm_source to the destination URL and overwrite ours. A code that forgets
  // its tags spends money we cannot attribute afterwards.
  for (const { code, to } of entries) {
    assert.match(to, /utm_source=/, `/go/${code} has no utm_source — its spend would be unattributable`);
    assert.match(to, /utm_campaign=/, `/go/${code} has no utm_campaign`);
  }
});

test('reddit lands in the app, not on the film page', () => {
  // The creative already carries the film. Paying for a click and then asking
  // for another 30 seconds before the product is reachable loses the visitor
  // at the exact moment of intent.
  const rd = entries.find((e) => e.code === 'rd');
  assert.ok(rd, 'the rd campaign code is gone — 300+ live Reddit clicks point at it');
  assert.ok(!rd.to.startsWith('/watch'), 'reddit traffic is being sent back to the film page');
  assert.match(rd.to, /^\/\?/, 'reddit should land on the app root so InstallPrompt can offer add-to-home-screen');
});

test('an unknown code still lands somewhere real', () => {
  // A typo on a poster should cost attribution, never a visitor.
  assert.match(index, /GO\[[^\]]+\]\s*;[\s\S]{0,400}?to \?\? '\/watch\/'/,
    'an unrecognised /go/ code no longer falls back to a real page');
});

test('the add-to-home prompt exists and is mounted', () => {
  // The whole point of sending Reddit to the app root. If this component were
  // ever unmounted the ad would still "work" and quietly stop asking anyone to
  // install — invisible in every metric except retention.
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  assert.match(stage, /<InstallPrompt\s*\/>/, 'InstallPrompt is not rendered — nobody is asked to install');
  const prompt = readFileSync(join(HERE, '..', 'src', 'components', 'app', 'InstallPrompt.tsx'), 'utf8');
  assert.match(prompt, /display-mode: standalone/,
    'the prompt no longer checks whether Num is already installed — it would nag existing users');
});
