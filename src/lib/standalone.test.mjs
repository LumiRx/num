/**
 * The installed app is always the app — never the launch stage.
 *
 * `useStandalone()` decided which of two completely different products to
 * render from `window.innerWidth < 720`. On a phone that is true, so every
 * test and every manual check passed. On an iPad it is false — and the
 * bundled app carries no `?app` in its URL, because its origin is
 * capacitor://localhost/ — so App.tsx fell through to `<LaunchStage />` and a
 * reviewer got a marketing page instead of Num.
 *
 * The target declares iPad, Mac (Designed for iPad) and Apple Vision as
 * supported destinations. All three are wider than 720. This was three of the
 * four devices Apple could have reviewed on, and a certain 2.1 rejection on
 * any of them.
 *
 * ── 16 SEP 2026: WIDTH STOPPED DECIDING ANYTHING ────────────────────────
 *
 * The iPad fix above bolted `native` in FRONT of the width test rather than
 * removing it, so the bad proxy survived for browsers. It came back the same
 * way it always does: the X ad flight sent 136 people to app.itsnum.com in a
 * day, 133 of them US desktop, every one shown a marketing page describing an
 * app they could not open. Zero asked Num anything.
 *
 * So `innerWidth` is gone from routing entirely. Every browser gets the app;
 * the pitch page is kept at `?stage`. Width still decides LAYOUT, in
 * glass.css, where a media query can widen a column without unmounting the
 * product mid-session.
 *
 * Asserted on the source because the decision lives in a React hook that
 * needs a DOM, and the properties that matter are structural.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const hook = src.slice(src.indexOf('function useStandalone'), src.indexOf('export default function App'));

/**
 * Comments stripped before any ordering is measured.
 *
 * The first version of this test compared indexOf('isNativeApp()') against
 * indexOf('innerWidth') across the raw text — and failed, because the comment
 * explaining the bug says "innerWidth < 720" several lines above the code that
 * runs. A test that can be moved by prose is measuring the wrong thing.
 */
const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the native app is still asked about first', () => {
  assert.match(code, /isNativeApp\(\)/,
    'useStandalone no longer asks whether it is running natively');
});

test('WIDTH NO LONGER DECIDES WHICH PRODUCT RENDERS', () => {
  // The whole bug, removed at the root rather than ordered around.
  //
  // `innerWidth < 720` was a proxy for "is this a phone", used to answer "does
  // this person want the product". It was wrong for every iPad (a 2.1
  // rejection risk on three of the four devices Apple could review on) and
  // then wrong for 133 desktop visitors the X flight sent on 16 Sep 2026, none
  // of whom asked Num anything because they never reached it.
  //
  // Layout by width is fine and lives in glass.css. ROUTING by width is what
  // this forbids.
  assert.ok(!/innerWidth/.test(code),
    'width is deciding which product to render again — layout belongs in CSS, not in routing');
});

test('nothing re-renders on resize any more', () => {
  // The width test was state, recomputed on every resize, so dragging a window
  // or rotating an iPad across 720px tore down the app mid-session and swapped
  // in the marketing site. That is what Dre hit signing up on an iPad and
  // described as the screen "glitching out".
  assert.ok(!/addEventListener\('resize'/.test(code),
    'useStandalone listens for resize again — the app can swap itself out mid-session');
});

test('native appears first in the returned expression', () => {
  const ret = code.slice(code.lastIndexOf('return '));
  assert.match(ret, /return\s+native\s*\|\|/,
    'the return no longer leads with native — a wide native device can still fall through to the launch stage');
});

test('App.tsx imports the native helper it depends on', () => {
  assert.match(src, /import \{ isNativeApp \} from '\.\/lib\/native'/,
    'isNativeApp is used without being imported — the bundle will not build');
});

test('the launch stage is KEPT, but behind an explicit ask', () => {
  // The pitch page is good and the investor material links to it, so deleting
  // it would lose something real. It is simply no longer what a stranger who
  // clicked an ad gets by accident: it now requires `?stage`.
  assert.match(src, /return <Suspense fallback=\{null\}><LaunchStage \/><\/Suspense>/,
    'the launch stage branch was removed entirely — the pitch page is gone');
  assert.match(code, /has\('stage'\)/,
    'nothing reaches the launch stage any more — it is unreachable, not just un-default');
});

test('a plain desktop browser gets the app', () => {
  // The property the X flight actually needed: no ?app, no ?stage, wide
  // window, not native — and still the product.
  const ret = code.slice(code.lastIndexOf('return '));
  assert.match(ret, /!stage/,
    'the default is not the app — a desktop visitor falls through to the pitch page again');
});
