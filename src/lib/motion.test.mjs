// Motion is one clock, everywhere, and never in the way.
//   · every bottom sheet rises in (sheet-in), or transitions if it stays mounted
//   · a reveal that ends at rest uses `backwards` fill — a `both`/`forwards`
//     fill pins the final transform and silently kills :hover/:active later
//   · the doors on TODAY and the rails stagger in; a tab change rises in
//   · while TONIGHT is still fetching, the rail's room is held by a skeleton
//   · reduced-motion collapses every animation and transition
// Run: node --test src/lib/motion.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const app = fileURLToPath(new URL('../components/app/', import.meta.url));
const read = (f) => readFileSync(join(app, f), 'utf8');
const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');

test('every sheet built on sheetBase rises in, or transitions when it stays mounted', () => {
  const sheets = readdirSync(app).filter((f) => f.endsWith('.tsx') && read(f).includes('sheetBase'));
  assert.ok(sheets.length >= 20, `found ${sheets.length} sheets`);
  const still = sheets.filter((f) => {
    const src = read(f);
    return !src.includes('sheet-in') && !/transition: 'transform \.32s/.test(src);
  });
  assert.deepEqual(still, [], 'sheets that snap into place');
});

test('rise-in ends at rest and hands the transform back (backwards fill)', () => {
  assert.match(css, /\.rise-in \{ animation: rise-in [^;]* backwards; \}/);
  assert.doesNotMatch(css, /\.rise-in \{ animation: rise-in [^;]* (both|forwards); \}/);
});

test('the doors stagger in, the rails stagger in, a tab change rises in', () => {
  const grid = read('FeatureGrid.tsx');
  assert.match(grid, /className="press tap rise-in"/);
  assert.match(grid, /animationDelay: `\$\{Math\.min\(n, \d+\) \* \d+\}ms`/);
  assert.match(read('NearbyRail.tsx'), /className="glass lift rise-in"/);
  assert.match(read('ConciergeApp.tsx'), /<div key=\{view\} className="rise-in"/);
});

test('TONIGHT holds its room with a skeleton only while the first fetch is out', () => {
  const strip = read('TonightStrip.tsx');
  assert.match(strip, /function RailSkeleton\(\)/);
  assert.match(strip, /className="skel"/);
  assert.match(strip, /return loading \? <RailSkeleton \/> : null;/);
  // Loading flips off on success AND on failure, or the shimmer would run forever.
  assert.ok((strip.match(/setLoading\(false\)/g) ?? []).length >= 3);
});

test('a confirmed booking pops once; nothing else in the thread does', () => {
  const thread = read('ThreadView.tsx');
  assert.match(thread, /className=\{m\.card\.tag === 'confirmed' \? 'check-pop' : undefined\}/);
});

test('reduced motion collapses every animation and transition', () => {
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{[^}]*animation-duration: 0\.01ms !important;[^}]*transition-duration: 0\.01ms !important;/);
});
