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
 * Asserted on the source because the decision lives in a React hook that
 * needs a DOM, and the property that matters — "native wins before width is
 * consulted at all" — is structural.
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

test('the native app short-circuits the width check', () => {
  assert.match(code, /isNativeApp\(\)/,
    'useStandalone no longer asks whether it is running natively — an iPad gets the launch stage again');
  const native = code.indexOf('isNativeApp()');
  const width = code.indexOf('innerWidth');
  assert.ok(native > 0 && native < width,
    'the width check is consulted before the native check — order decides which product an iPad renders');
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

test('the launch stage is still reachable for real browsers', () => {
  // The fix must not delete the marketing page: a desktop browser at
  // itsnum.com should still get the pitch, not a phone-shaped app.
  assert.match(src, /return <LaunchStage \/>/,
    'the launch stage branch was removed — desktop web now renders the app shell');
  assert.match(code, /innerWidth < 720/,
    'the width heuristic was deleted entirely — desktop browsers lose the launch stage');
});
