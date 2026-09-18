// The rails, and the chips above the chat.
//
// Both are layout promises, so they are read off the source: a card width, a
// row count, and the absence of things that made the screen unreadable. The
// three complaints being pinned here were made while looking at the live app
// on 18 Sep 2026, in these words: keep it two across all the way down; the
// buttons are so big on the smaller tabs, make sure there's a picture cover,
// it looks like big buttons, I'm confused what it's for; and we don't need
// the emojis before each one, to save space.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const bare = (s) => s.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const RAIL = read('../components/app/NearbyRail.tsx');
const GRID = read('../components/app/FeatureGrid.tsx');
const THREAD = read('../components/app/ThreadView.tsx');

describe('two across, all the way down', () => {
  test('a rail card is half the row, not a third', () => {
    assert.match(bare(RAIL), /flex: '0 0 calc\(\(100% - 8px\) \/ 2\)'/);
    assert.doesNotMatch(bare(RAIL), /\/ 3\)/);
  });

  test('the feature grid above it is two across too, so the page has one rhythm', () => {
    assert.match(bare(GRID), /gridTemplateColumns: '1fr 1fr'/);
  });

  test('the row still snaps by the page, so a slide brings whole cards', () => {
    assert.match(bare(RAIL), /scrollSnapType: 'x mandatory'/);
    assert.match(bare(RAIL), /scrollSnapAlign: 'start'/);
  });
});

describe('a card with no photo does not read as a button', () => {
  test('the empty cover is not the accent gradient the buttons use', () => {
    // This was the confusion exactly: cover and call-to-action painted the
    // same green, one above the other, inside a rounded box.
    const cover = bare(RAIL).slice(bare(RAIL).indexOf("aspectRatio: '1 / 1'") - 600, bare(RAIL).indexOf("aspectRatio: '1 / 1'") + 900);
    assert.doesNotMatch(cover, /grad-accent|accent-300/);
    assert.match(cover, /background: 'var\(--field-bg\)'/);
  });

  test('it says what kind of thing it is instead', () => {
    assert.match(bare(RAIL), /kindOf\(i\)/);
  });

  test('the kind comes off the feed, and is never invented', async () => {
    const { kindOf } = await import('./railkind.ts');
    assert.equal(kindOf({ sub: 'Street food · London' }), 'Street food');
    assert.equal(kindOf({ sub: 'Italian Restaurant · Soho' }), 'Italian Restaurant');
    assert.equal(kindOf({ sub: null }), null);
    assert.equal(kindOf({ sub: '   ' }), null);
    // A whole sentence is not a kind — better a plain square than a label
    // that wraps over the cover.
    assert.equal(kindOf({ sub: 'The best little place on the whole street · Kata' }), null);
  });
});

describe('one row of chips above the chat, and no emoji', () => {
  test('there is exactly one scrolling chip row now, not two stacked', () => {
    const rows = bare(THREAD).match(/overflowX: 'auto', height: \d+, alignItems: 'center'/g) ?? [];
    assert.equal(rows.length, 1, `expected one chip row, found ${rows.length}`);
  });

  test('nothing renders a leading emoji or sparkle on a chip', () => {
    const t = bare(THREAD);
    assert.doesNotMatch(t, /\{emoji\}/);
    const row = t.slice(t.indexOf("overflowX: 'auto', height: 44"), t.indexOf('enterKeyHint'));
    assert.doesNotMatch(row, /SparklesIcon/);
  });

  test('the row keeps a fixed height, so sending cannot resize the composer', () => {
    // The old two-row version reserved its height for this reason and the
    // reason has not changed: chips clear on send.
    assert.match(bare(THREAD), /overflowX: 'auto', height: 44, alignItems: 'center'/);
  });

  test('what NUM just offered comes before the fixed doors', () => {
    const t = bare(THREAD);
    const row = t.slice(t.indexOf("overflowX: 'auto', height: 44"));
    assert.ok(row.indexOf('chips.map') < row.indexOf("T('Surprise me')"), 'reply chips must be first in the row');
  });
});
