/**
 * EVERY SHEET HAS A BACKGROUND.
 *
 * 16 Sep 2026. Dre sent a screenshot of the post-signup plans sheet on his
 * phone. "The concierge is yours. Free, forever." was sitting on top of
 * "Nothing booked yet". The tier cards overlapped the trip-check rows. The
 * $8.98 and $28.98 prices ran through the calendar strip underneath. The
 * sheet had no background at all — the dashboard showed straight through it.
 *
 * `sheetBase` in lib/derive.ts gives a sheet its position, radius, z-index and
 * safe-area padding. It gives it NO background, and its own comment says so:
 * "Sheets rise as rounded glass panels; pair with className='glass-strong'".
 * Sixteen sheets do that. WelcomePlans and ShareToSheet did not.
 *
 * Nothing caught it, and nothing could have: a missing className is not a type
 * error, the component still mounts, the tests still pass, and the sheet still
 * "renders" — it just renders see-through. The only detector was a human
 * looking at a phone.
 *
 * It mattered most on the worst possible screen. WelcomePlans is the one
 * surface in the product whose entire job is to sell a subscription, shown to
 * every new member on first run — while we were paying X for traffic to reach
 * it, with 152 members and zero subscriptions.
 *
 * So the rule is asserted rather than remembered: if a component spreads
 * `sheetBase`, it declares a background.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../components/app/', import.meta.url);

/**
 * The OPENING TAG of the element that spreads sheetBase — nothing else.
 *
 * The first version of this file just asked whether the file contained
 * `className="glass"` or `background:` anywhere. It passed on a deliberately
 * broken WelcomePlans, because the file has buttons, and buttons have
 * backgrounds. A guard that cannot fail is worse than no guard: it reports
 * safety it has not checked.
 *
 * So the tag is isolated: walk back to the `<div` that owns the spread, then
 * forward to the `>` that closes that opening tag, tracking brace depth so a
 * `>` inside a style expression does not end it early.
 */
function openingTag(code) {
  const at = code.indexOf('...sheetBase');
  if (at < 0) return null;
  const open = code.lastIndexOf('<div', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return code.slice(open, i + 1);
  }
  return null;
}

const sheets = readdirSync(DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => ({
    file: f,
    // Comments stripped FIRST. Several tests in this repo have been satisfied
    // by an explanation rather than by code; a paragraph describing
    // glass-strong must never be mistaken for using it.
    code: readFileSync(new URL(f, DIR), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  }))
  .filter((s) => /\.\.\.sheetBase/.test(s.code))
  .map((s) => ({ ...s, tag: openingTag(s.code) }));

test('there are sheets to check at all', () => {
  // If sheetBase is ever renamed this file would otherwise pass by finding
  // nothing, which is the quietest way for a guard to stop guarding.
  assert.ok(sheets.length >= 10, `only found ${sheets.length} sheets — has sheetBase been renamed?`);
});

test('every sheet root was actually located', () => {
  assert.deepEqual(sheets.filter((s) => !s.tag).map((s) => s.file), [],
    'could not isolate the opening tag — the check below would silently pass');
});

test('every sheet declares a background ON ITS OWN ROOT', () => {
  const naked = sheets
    .filter((s) => s.tag && !/className="glass/.test(s.tag) && !/background:/.test(s.tag))
    .map((s) => s.file);
  assert.deepEqual(naked, [],
    'These sheets spread sheetBase but their root element declares no ' +
    'background, so they render transparent over whatever is behind them — ' +
    'exactly how the plans sheet shipped. Add className="glass-strong".');
});

test('a sheet that can overflow says how tall it may get', () => {
  // A sheet with no ceiling runs off the bottom of a small phone and takes its
  // own close button with it. WelcomePlans did: the "Not now — start using
  // Num" button, the only way out, was below the fold.
  const unbounded = sheets
    .filter((s) => s.tag && !/maxHeight|height:/.test(s.tag))
    .map((s) => s.file);
  assert.deepEqual(unbounded, [],
    'These sheets have no height ceiling on their root — on a small screen ' +
    'the last control in them, usually the way out, ends up off-screen.');
});
