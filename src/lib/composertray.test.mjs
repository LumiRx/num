/**
 * THE THING THAT ACTUALLY STUCK THE SCREEN.
 *
 * Dre, 13 Sep 2026: "we had someone looking at flights and the screen got
 * stuck scrolling."
 *
 * The flight results tray does not live in the thread. It lives in the
 * COMPOSER BAR, which is `flex: 'none'` on purpose — so the bar's height does
 * not jump around while you type. That is a good decision with one fatal
 * consequence nobody had followed through:
 *
 *   · an uncapped list of fares, roughly 100px per offer,
 *   · inside a box that cannot shrink,
 *   · inside a shell that is `height: 100%; overflow: hidden`
 *     and clamps its own scrollTop to zero (holdFrame in ConciergeApp).
 *
 * Five offers push the bar past the bottom of the phone. The thread above
 * collapses, the lower fares are clipped off-screen, and on a short device
 * the text input goes with them — and NOTHING can scroll to reach any of it,
 * because neither the bar nor the tray was a scroll container.
 *
 * That is a stuck screen in the most literal sense available.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 20 Sep 2026: the live-fare tray moved out of ThreadView into its own
// component so the listing page could show the same fares without a second
// copy of the two-tap booking disclosure. Nothing about its behaviour
// changed, so the assertions below are unchanged — they just read both
// files, because that is where the code now lives.
const THREAD = readFileSync(new URL('../components/app/ThreadView.tsx', import.meta.url), 'utf8')
  + readFileSync(new URL('../components/app/FlightTray.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');

const vh = (name) => {
  const m = new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)vh`).exec(CSS);
  assert.ok(m, `--${name} is missing from app.css`);
  return Number(m[1]);
};

describe('neither tray can grow without limit', () => {
  test('the fares tray is capped and scrolls itself', () => {
    const i = THREAD.indexOf('LIVE FARES');
    const box = THREAD.slice(Math.max(0, i - 900), i);
    assert.match(box, /maxHeight: 'var\(--tray-max-flight\)'/);
    assert.match(box, /overflowY: 'auto'/, 'capped but not scrollable just hides the later fares');
  });

  test('the service tray is capped too — its note is free text from the server', () => {
    const i = THREAD.indexOf('KIND_LABEL[h.kind]');
    const box = THREAD.slice(Math.max(0, i - 700), i);
    assert.match(box, /maxHeight: 'var\(--tray-max-service\)'/);
    assert.match(box, /overflowY: 'auto'/);
  });

  test('a flick inside a tray stays inside it', () => {
    // Otherwise the gesture is handed to the shell behind, which is exactly
    // what makes a scroll feel like it catches on iOS.
    assert.equal((THREAD.match(/overscrollBehavior: 'contain'/g) ?? []).length >= 3, true,
      'the thread and both trays each need it');
  });
});

describe('the budget that keeps the text input on screen', () => {
  test('both caps are declared in one place', () => {
    assert.ok(vh('tray-max-flight') > 0);
    assert.ok(vh('tray-max-service') > 0);
  });

  test('BOTH TRAYS OPEN AT ONCE STILL LEAVES THE INPUT REACHABLE', () => {
    // The two are different flows but nothing prevents both being present.
    // Fixed rows below them: discover 42 + chips 46 + input 44 + padding ≈ 160.
    // The shortest phone we support is 667px tall.
    const SHORTEST_PX = 667;
    const FIXED_PX = 160;
    const used = (vh('tray-max-flight') + vh('tray-max-service')) / 100 * SHORTEST_PX + FIXED_PX;
    assert.ok(used < SHORTEST_PX,
      `both trays plus the fixed rows come to ${Math.round(used)}px on a ${SHORTEST_PX}px screen — the input is off the bottom`);
  });

  test('and leaves the thread something to be', () => {
    const SHORTEST_PX = 667;
    const FIXED_PX = 160;
    const left = SHORTEST_PX - ((vh('tray-max-flight') + vh('tray-max-service')) / 100 * SHORTEST_PX + FIXED_PX);
    assert.ok(left >= 100, `only ${Math.round(left)}px of conversation left — the thread has effectively vanished`);
  });

  test('the caps are proportional, not pixel counts', () => {
    // The failure is a proportion of the screen, not a number of offers: six
    // fares are comfortable on a tablet and fatal on an iPhone SE.
    assert.match(CSS, /--tray-max-flight:\s*\d+(\.\d+)?vh/);
    assert.match(CSS, /--tray-max-service:\s*\d+(\.\d+)?vh/);
  });

  test('the arithmetic is written down next to the numbers', () => {
    const i = CSS.indexOf('--tray-max-flight');
    const note = CSS.slice(Math.max(0, i - 1200), i);
    assert.match(note, /667/, 'the next person to raise these needs the sum, not just the values');
    assert.match(note, /flex: none/);
  });
});

describe('why the bar cannot simply scroll instead', () => {
  test('the bar is still flex: none, deliberately', () => {
    // Letting it shrink or scroll would move the text input while somebody is
    // typing, which is the problem the fixed height was solving.
    assert.match(THREAD, /className="glass-bar"[\s\S]{0,200}flex: 'none'/);
  });
});
