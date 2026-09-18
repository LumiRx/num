// Every card on the grid has to go somewhere.
//
// FeaturePage renders any feature declared in features.ts: cover, promise,
// fields, and a primary button carrying the feature's own `cta`. The button
// does this:
//
//     const go = () => { if (!f.compose || !ready) return; … }
//
// So a feature declared without `compose` gets a complete, convincing page.
// The fields accept input. The button enables when they are filled. The tap
// returns early. Nothing happens, nothing is logged, nothing 404s, and there
// is no way to tell from the outside that it is not simply slow.
//
// Three features legitimately have no compose — nightlife, plans and wallet
// open their own surfaces instead, via `opens`, which openFeature() calls
// before FeaturePage is ever reached. That is the other valid wiring.
//
// What must never exist is a feature with neither: a card that opens a page
// whose button is decorative. This test is cheap insurance on a file that is
// designed to be added to, where the cost of forgetting is invisible.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./features.ts', import.meta.url), 'utf8');

/** Each feature's object literal, split on its `id:` line. */
function features() {
  const starts = [...SRC.matchAll(/^ {4}id: '([a-z_]+)'/gm)];
  assert.ok(starts.length > 5, `expected the feature list, found ${starts.length} entries`);
  return starts.map((m, i) => ({
    id: m[1],
    body: SRC.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : SRC.length),
  }));
}

describe('the feature grid is wired', () => {
  test('every feature either composes an ask or opens its own surface', () => {
    const dead = features()
      .filter((f) => !/\bcompose:/.test(f.body) && !/\bopens:/.test(f.body))
      .map((f) => f.id);
    assert.deepEqual(
      dead,
      [],
      `these features open a page whose primary button returns early and does ` +
        `nothing — give them a compose() or an opens(): ${dead.join(', ')}`,
    );
  });

  test('every feature has a cta, so the button is never blank', () => {
    const missing = features().filter((f) => !/\bcta:/.test(f.body)).map((f) => f.id);
    assert.deepEqual(missing, [], `no label on the primary button: ${missing.join(', ')}`);
  });

  test('FeaturePage still returns early without compose', () => {
    // The whole reason the first test exists. If this guard is ever removed or
    // rewritten, the invariant above may no longer be the one that matters,
    // and this test should fail loudly rather than keep asserting a stale rule.
    const page = readFileSync(new URL('../components/app/FeaturePage.tsx', import.meta.url), 'utf8');
    assert.match(
      page,
      // 18 Sep 2026: `!ready` no longer returns silently — it focuses the
      // first field still needed — so the compose guard stands on its own.
      /if \(!f\.compose\) return;/,
      'FeaturePage.go() no longer guards on f.compose — re-check what a missing compose does now',
    );
  });

  test('the parser still recognises the feature list', () => {
    const ids = features().map((f) => f.id);
    assert.ok(ids.includes('flights') && ids.includes('wallet'), `parser lost the list: ${ids.join(', ')}`);
    assert.ok(new Set(ids).size === ids.length, `duplicate feature ids: ${ids.join(', ')}`);
  });
});
