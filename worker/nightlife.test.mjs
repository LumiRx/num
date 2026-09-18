// NIGHTLIFE — its own screen, nearest first.
//
// Dre, 18 Sep 2026: "clubs and nightlife is its own tab, also we should
// populate that closest to wherever the user is." The promises worth pinning:
// the mode exists and is reached, every shelf is ordered by distance, a club
// is never also a bar, tonight's nights keep the music and drop the matinee,
// and nothing on the screen promises entry.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const DISCOVER = read('./discover.mjs');
const SHEET = read('../src/components/app/NightlifeSheet.tsx');
const FEATURES = read('../src/lib/features.ts');
const bare = (s) => s.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('the mode', () => {
  test('nightlife is a mode /api/discover understands', () => {
    assert.match(bare(DISCOVER), /g\('mode'\) === 'nightlife' \? 'nightlife'/);
    assert.match(bare(DISCOVER), /if \(mode === 'nightlife'\) \{/);
  });

  test('every shelf is nearest first', () => {
    const block = bare(DISCOVER).slice(bare(DISCOVER).indexOf("if (mode === 'nightlife')"), bare(DISCOVER).indexOf("if (mode === 'tonight')"));
    assert.match(block, /sort\(\(a, b\) => \(a\.km \?\? 1e9\) - \(b\.km \?\? 1e9\)\)/, 'places are ordered by distance');
    assert.match(block, /sort\(\(a, b\) => \(a\.distance_km \?\? 1e9\) - \(b\.distance_km \?\? 1e9\)\)/, 'nights are ordered by distance');
  });

  test('a club is not also a bar', () => {
    const block = bare(DISCOVER).slice(bare(DISCOVER).indexOf("if (mode === 'nightlife')"), bare(DISCOVER).indexOf("if (mode === 'tonight')"));
    assert.match(block, /const clubIds = new Set\(clubs\.map/);
    assert.match(block, /bars = shelf\(r2\?\.rows \?\? \[\]\)\.filter\(\(b\) => !clubIds\.has\(b\.id\)\)/);
  });

  test('the shelf only carries what NUM can stand behind — rated ONLY, stricter than TONIGHT', () => {
    // The first London run, with TONIGHT's unrated fallback, put a travel
    // agency under CLUBS and an occupational-health clinic under LIVE MUSIC.
    const block = bare(DISCOVER).slice(bare(DISCOVER).indexOf("if (mode === 'nightlife')"), bare(DISCOVER).indexOf("if (mode === 'tonight')"));
    assert.match(block, /\.filter\(\(r\) => r\.rating != null\)/);
    assert.doesNotMatch(block, /rated\.length >= 3 \? rated : rows/, 'no unrated fallback on this shelf');
  });

  test('a nightclub is its own intent, above bar, and a travel lounge is not one', async () => {
    const { detectCat } = await import('../ai/places.js');
    assert.equal(detectCat('nightclub club dancing'), 'nightclub');
    assert.equal(detectCat('live music venue jazz'), 'livemusic');
    assert.equal(detectCat('bar cocktails late night'), 'bar');
  });

  test('the genre travels from Ticketmaster so the matinee can be left behind', () => {
    assert.match(bare(DISCOVER), /genre: e\.genre \?\? null,/);
    assert.match(bare(DISCOVER), /const NIGHT = \/music\|dance\|electronic/);
  });

  test('the ratings enrichment knows what a nightclub is', () => {
    assert.match(read('./placeratings.mjs'), /night_club: 'nightclubs'/);
  });
});

describe('the screen', () => {
  test('it is a door on TODAY that opens a screen, not a question', () => {
    assert.match(FEATURES, /id: 'nightlife', kicker: 'NIGHTLIFE'/);
    assert.match(FEATURES, /opens: \(\) => store\.set\(\{ featureOpen: null, nightlifeOpen: true \}\)/);
  });

  test('the distance is on the screen and NEAR ME re-ranks', () => {
    assert.match(bare(SHEET), /Ranked by distance from where you are/);
    assert.match(bare(SHEET), /fixPosition\(\)/);
  });

  test('nothing promises entry', () => {
    const s = bare(SHEET);
    assert.match(s, /it never promises entry/);
    assert.doesNotMatch(s, /guaranteed|guarantee entry|skip the (line|queue)|free entry/i);
  });

  test('a night opens inside NUM like every other event', () => {
    assert.match(bare(SHEET), /openEventCard\(\{/);
    assert.doesNotMatch(bare(SHEET), /window\.open/);
  });

  test('the shell knows how to close it', () => {
    const app = read('../src/components/app/ConciergeApp.tsx');
    assert.ok((app.match(/nightlifeOpen/g) ?? []).length >= 5, 'sheetOpen, closeSheets (twice), overlayOpen and the back handler');
    assert.match(app, /<NightlifeSheet \/>/);
  });
});
