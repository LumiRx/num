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

test('the desktop landing page can scroll and has a way in', () => {
  // The page ad traffic lands on. It shipped with `overflow: hidden` around
  // two 852px-tall phone frames and no button — on a laptop shorter than the
  // frames, the mockups were clipped, the page would not scroll to reveal
  // them, and the only call to action was grey footer text. Every desktop
  // click from Reddit hit that.
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  assert.ok(!/overflow:\s*'hidden'/.test(stage),
    "the landing page hides its overflow again — content taller than the viewport becomes unreachable");
  assert.match(stage, /Open Num/,
    'the landing page has no primary call to action');
  assert.match(stage, /id="on-your-phone"/,
    'the desktop → phone handoff section is gone; a laptop visitor cannot install from here and needs telling how');
  // Scoped to the NAV declaration, NOT the whole file. The first version of
  // this matched /itsnum.com\/how-it-works/ anywhere, which the FOOTER also
  // satisfies — deleting the entire nav left the test green. A guard that a
  // duplicate link elsewhere can satisfy is not guarding anything.
  const nav = stage.slice(stage.indexOf('const NAV'), stage.indexOf('export default'));
  assert.ok(nav.includes('how-it-works') && nav.includes('itsnum.com/'),
    'the nav no longer links back to the site — an ad visitor has only the back button');
  assert.match(stage, /href="https:\/\/itsnum\.com\/"[\s\S]{0,400}NUM/,
    'the brand mark no longer links home');
  assert.ok(/FEATURES/.test(stage) && /Cars that actually turn up/.test(stage),
    'the feature list is gone; the mockup alone does not say what Num does');
});

test('a phone visitor is asked to install, a laptop visitor is not', () => {
  // "Add to your home screen" is impossible advice on a laptop and the single
  // most valuable thing a phone visitor can do. Getting the primary CTA
  // backwards asks people for something they cannot give.
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  assert.match(stage, /onPhone\s*\?/, 'the primary call to action no longer varies by device');
  assert.match(stage, /Add Num to my home screen/, 'phones are not offered the install as the primary action');
  assert.match(stage, /Open Num/, 'there is no way into the app');
});

test('the headline scales instead of being pinned to one size', () => {
  // A fixed 44px headline is small on a 1440px laptop and oversized on a
  // 360px phone — the two viewports this page actually gets.
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  const h1 = stage.slice(stage.indexOf('<h1'), stage.indexOf('</h1>'));
  assert.match(h1, /clamp\(/, 'the headline uses a fixed font size and will not read well on both phone and laptop');
});

test('the two ad landing pages make the same promise', () => {
  // /watch/ and the app root are both live ad destinations. If their feature
  // copy drifts, the product someone was sold depends on which link they
  // happened to click.
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  const watch = readFileSync(join(HERE, '..', 'app-public', 'watch', 'index.html'), 'utf8');
  for (const promise of ['Cars that actually turn up', 'Plan together', 'Split anything', 'It thinks ahead']) {
    assert.ok(watch.includes(promise), `/watch/ no longer promises "${promise}"`);
    assert.ok(stage.includes(promise), `the app landing no longer promises "${promise}"`);
  }
});

test('install steps agree with the floating prompt', () => {
  // A visitor sees InstallPrompt AND this section. Two different sets of
  // instructions for the same three taps is worse than one set.
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  const prompt = readFileSync(join(HERE, '..', 'src', 'components', 'app', 'InstallPrompt.tsx'), 'utf8');
  for (const step of ['Add to Home Screen', 'Install app']) {
    assert.ok(prompt.includes(step) && stage.includes(step),
      `"${step}" appears in one place but not the other — the two install guides have drifted`);
  }
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
