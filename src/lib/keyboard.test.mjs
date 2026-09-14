/**
 * THE BLACK GAP UNDER THE KEYBOARD.
 *
 * Dre, 14 Sep 2026: "the keypad keeps having a black gap when clicking a text
 * box … when adding in a plan name it does it and also other places."
 *
 * ── WHAT WAS HAPPENING ───────────────────────────────────────────────────
 *
 * The shell was sized `height: var(--vvh, 100dvh)`, where --vvh was the
 * visualViewport height published by App.tsx. Opening the keyboard shrank the
 * shell, which put the focused input above the keyboard — correct, and the
 * reason the code was written that way.
 *
 * What it also did was leave a strip of bare page between the bottom of the
 * shrunken shell and the bottom of the screen. `html, body` is painted
 * #14100e — the near-black stage the DESKTOP launch frame floats a
 * phone-shaped column on. Inside the app nothing floats, so that colour could
 * only ever appear as a mistake. It appeared as a black band flashing in and
 * out under the keyboard on every tap into a field.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────
 *
 * Stop moving the shell's outer edge. It stays exactly one viewport tall and
 * absorbs the keyboard as PADDING, so the ground never leaves the screen and
 * only the content box moves. App.tsx publishes --kb (the keyboard height)
 * instead of --vvh (what was left over) — a variable named for what it
 * measures is harder to use wrongly than one named for a result.
 *
 * Plus a second, independent guard: the installed app never paints the dark
 * stage at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const GLASS = read('../styles/glass.css');
const APP = read('../App.tsx');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const shellRule = () => {
  const at = GLASS.indexOf('.app-shell {');
  assert.ok(at > -1, '.app-shell is gone');
  return GLASS.slice(at, GLASS.indexOf('}', at));
};

describe('the shell never shrinks away from the bottom of the screen', () => {
  test('it is a full viewport tall, always', () => {
    assert.match(shellRule(), /height:\s*100dvh/,
      'a shell shorter than the screen shows whatever is painted behind it');
  });

  test('the keyboard is absorbed as padding, not by resizing', () => {
    assert.match(shellRule(), /padding-bottom:\s*var\(--kb, 0px\)/);
  });

  test('and the padding is inside the 100dvh, not added to it', () => {
    // Without border-box the shell grows past the screen and the document
    // gains exactly the scroll height html.num-standalone exists to remove.
    assert.match(shellRule(), /box-sizing:\s*border-box/);
  });

  test('the old visible-height sizing is gone from the rule', () => {
    assert.doesNotMatch(code(shellRule()), /--vvh/,
      'sizing the shell to the visible height is what produced the black band');
  });
});

describe('what App.tsx publishes', () => {
  const boot = code(APP);

  test('it measures the keyboard, not the leftovers', () => {
    assert.match(boot, /setProperty\('--kb', `\$\{gap\}px`\)/);
    assert.match(boot, /const gap = Math\.round\(window\.innerHeight\) - Math\.round\(vv\.height\)/,
      'the gap between the layout viewport and the visible one IS the keyboard');
  });

  test('nothing still writes the old variable', () => {
    assert.doesNotMatch(boot, /--vvh/);
  });

  test('browser chrome is not mistaken for a keyboard', () => {
    // A collapsing toolbar is tens of pixels. Padding the shell for that
    // makes the app twitch while somebody scrolls.
    assert.match(boot, /KEYBOARD_MIN = 120/);
    assert.match(boot, /gap > KEYBOARD_MIN/);
  });

  test('it still writes only on a real change, not once per animation frame', () => {
    assert.match(boot, /Math\.abs\(gap - pinned\) > 2/);
    assert.match(boot, /requestAnimationFrame/);
    assert.doesNotMatch(boot, /addEventListener\('scroll'/,
      "scroll fires constantly while the keyboard animates and carries no size information");
  });

  test('closing the keyboard returns to zero rather than deleting the property', () => {
    assert.match(boot, /setProperty\('--kb', '0px'\)/);
  });
});

describe('the installed app never paints the desktop stage', () => {
  test('#14100e is still the stage for the browser launch frame', () => {
    // Not a regression to remove — it is right where a phone-shaped column
    // genuinely floats on a dark ground.
    assert.match(GLASS, /background:\s*#14100e/);
  });

  test('but html.num-standalone overrides it with the app ground', () => {
    const at = GLASS.indexOf('html.num-standalone,');
    assert.ok(at > -1);
    const block = GLASS.slice(at, at + 220);
    assert.match(block, /background:\s*var\(--color-bg/,
      'if anything ever shrinks the shell again, what shows must be the theme, not a near-black nobody chose');
  });

  test('the override follows the theme rather than hardcoding one colour', () => {
    const at = GLASS.indexOf('html.num-standalone,');
    const block = GLASS.slice(at, at + 220);
    assert.match(block, /--color-bg, #faf7f4/, 'with a light fallback for a theme that has not loaded');
  });
});

describe('a sheet lands above the keyboard, which is where the bug was reported', () => {
  test('sheets are positioned inside the padded content box', () => {
    // The plan-name field is in a sheet: `position: absolute; bottom: 0`
    // inside ConciergeApp's relative root, which is height:100% of the
    // shell's CONTENT box. Pad the box and bottom:0 becomes the top of the
    // keyboard — no per-sheet work, which is why "and also other places" is
    // covered by the same change.
    const derive = read('./derive.ts');
    const at = derive.indexOf('export const sheetBase');
    const rule = derive.slice(at, derive.indexOf('};', at));
    assert.match(rule, /position: 'absolute'/);
    assert.match(rule, /bottom: 0/);
    const app = read('../components/app/ConciergeApp.tsx');
    assert.match(app, /height: '100%'[^}]*position: 'relative'/,
      'the sheets’ containing block must be the full height of the padded shell');
  });
});
