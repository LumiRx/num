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

test('reddit lands somewhere it can act immediately, never back on the film', () => {
  // The creative already carries the film. Paying for a click and then asking
  // for another 30 seconds before the product is reachable loses the visitor
  // at the exact moment of intent. THAT is the rule — not any one URL.
  //
  // This assertion used to be `match(rd.to, /^\/\?/)`, pinning Reddit to the
  // app root. That was the right destination when the app root was the only
  // surface with a way in. On 2026-08-08 Dre added /install/, a page whose one
  // job is add-to-home-screen. Rewriting the assertion to the intent rather
  // than deleting it: the destination is free to change, the rule is not.
  const rd = entries.find((e) => e.code === 'rd');
  assert.ok(rd, 'the rd campaign code is gone — 300+ live Reddit clicks point at it');
  assert.ok(!rd.to.startsWith('/watch'), 'reddit traffic is being sent back to the film page');

  const ALLOWED = ['/', '/install/'];
  assert.ok(ALLOWED.includes(rd.to.split('?')[0]),
    `reddit points at ${rd.to.split('?')[0]} — that surface has not been shown to offer an immediate way in`);
});

test('the install page exists, has no video wall, and asks above the fold', () => {
  // The failure this guards is specific and has happened: paid traffic landing
  // on a page that looks fine and cannot be acted on. A missing file, a video
  // added later, or a CTA that drifts below the fold each reproduce it.
  const page = readFileSync(join(HERE, '..', 'app-public', 'install', 'index.html'), 'utf8');

  assert.ok(!/<video|<iframe/i.test(page),
    'a video or embed appeared on /install/ — that is the exact stop that cost 300 clicks');

  // The ask must be reachable before anyone scrolls, and again while scrolling.
  const firstCta = page.indexOf('class="cta"');
  assert.ok(firstCta > -1, '/install/ has no call to action at all');
  assert.ok(firstCta < page.indexOf('</head>') + 6000,
    'the first CTA on /install/ has drifted too far down the document to be above the fold');
  assert.match(page, /class="dock"/,
    'the sticky mobile CTA is gone — Reddit traffic is overwhelmingly phones');

  // Measurement, or the paid click is invisible and the funnel starts late.
  assert.match(page, /\/api\/analytics\.js/, '/install/ is not being measured');

  // Install steps for all three platforms. iPhone users sent to a Chrome menu
  // that does not exist simply give up, and we never hear about it.
  for (const p of ['ios', 'android', 'desktop']) {
    assert.match(page, new RegExp(`data-p="${p}"`), `/install/ has no steps for ${p}`);
  }
});

test('the page still reads correctly with no campaign tag and no JavaScript', () => {
  // The hero adapts to the visitor (phuket vs global). Adaptive copy is where
  // landing pages quietly break: the variant is applied by replacing text, so
  // a script that throws, a campaign tag that never arrives, or a link from
  // somewhere unexpected must all leave a page that still sells.
  //
  // Hence: the global copy is what ships in the HTML, and the script only ever
  // overwrites it. This test pins that direction — if someone later empties
  // the markup and renders the hero from JS, this fails.
  const page = readFileSync(join(HERE, '..', 'app-public', 'install', 'index.html'), 'utf8');

  const hero = page.slice(page.indexOf('<h1>'), page.indexOf('</h1>'));
  assert.ok(hero.replace(/<[^>]+>/g, '').trim().length > 10,
    'the headline is empty in the served HTML — it is being rendered by script');

  const lede = page.slice(page.indexOf('id="lede"'), page.indexOf('id="lede"') + 400);
  assert.ok(lede.replace(/<[^>]+>/g, '').trim().length > 40,
    'the hero paragraph ships empty — a visitor with no JS sees nothing');

  // At least one example ask must exist in the markup, not only in the variant.
  assert.match(page, /class="chip">[^<]{10,}/,
    'the example asks are script-only — they vanish if the variant code fails');
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

test('the phone mockup does not swallow the page scroll', () => {
  // The frames hold the REAL app, with its own scrollable thread, centred in
  // the viewport where the cursor lands. Live pointer events meant the wheel
  // scrolled the app inside the frame and the page looked frozen — reported
  // three times as "the page won't scroll" and misdiagnosed twice as CSS.
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  const frames = stage.slice(stage.indexOf('SCROLL, NOT CAPTURE'), stage.indexOf('</IOSDevice>'));
  assert.match(frames, /pointerEvents:\s*'none'/,
    'the mockup is interactive again — it will capture the wheel and the page will appear stuck');
});

test('install is one tap where the platform allows it', () => {
  // "Can it just prompt the phone?" On Android: yes — beforeinstallprompt,
  // captured in the SHELL because Chrome fires it once, early, often before
  // the bundle parses. Captured late = every button demoted to an
  // instruction card on the exact devices that support the native sheet.
  // On iOS no API exists, so the steps remain — that is Apple, not us.
  const shell = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
  assert.match(shell, /beforeinstallprompt/, 'the shell no longer captures the install event — one-tap is dead for the whole visit');
  assert.match(shell, /e\.preventDefault\(\)/, 'Chrome shows its own mini-infobar over ours — two prompts fight for the same tap');
  const stage = readFileSync(join(HERE, '..', 'src', 'components', 'canvas', 'LaunchStage.tsx'), 'utf8');
  assert.match(stage, /promptInstall/, 'the landing CTA never uses the captured event — Android guests get instructions for a sheet that was one tap away');
  const prompt = readFileSync(join(HERE, '..', 'src', 'components', 'app', 'InstallPrompt.tsx'), 'utf8');
  assert.match(prompt, /ADD — ONE TAP/, 'the floating prompt lost its native path');
  assert.match(prompt, /setOpen\(true\); \/\/ declined/, 'a declined native sheet leaves the guest with nothing — no fallback to the manual steps');
});
