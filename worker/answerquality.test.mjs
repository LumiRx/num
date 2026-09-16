/**
 * THE FOUR COMPLAINTS, 15 Sep 2026.
 *
 * Dre, from real users: "we aren't giving new recommendations when asking for
 * new ones, no links to the places, the suggestions are short and very few
 * locations and they aren't close to the locations they're asking for."
 *
 * Three of those four traced to ONE number — the retrieval pool was 6 — and
 * the fourth to a field the model was told to copy and never shown. This file
 * is what stops either coming back, because both were invisible: nothing
 * failed, nothing logged, the answers were just quietly thin.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextBlock, REPLY_SCHEMA } from './prompt.mjs';
import { moreOptions } from './moreoptions.mjs';
import { resolvePicks } from './placelink.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const partner = (n) => ({
  id: `p_${n}`, name: `Place ${n}`, category: 'Restaurant', area: 'Hollywood',
  km: 0.4 + n / 10, rating: 4.5, reviews: 400, phone: '+13234642989',
  address: `${n} Sunset Blvd`, website: 'https://example.test', lat: 34.1, lng: -118.33,
});
const pool = (n) => Array.from({ length: n }, (_, i) => partner(i + 1));

/* ── "no links to the places" ──────────────────────────────────────────── */

describe('the link actually attaches', () => {
  test('THE BUG: the partner block gives the model the id it is told to copy', () => {
    // The picks schema says "copy the partner id from the verified block —
    // this is what attaches the link". The block did not contain one. The
    // model cannot copy a field it has never been shown, so every pick fell
    // back to fuzzy name matching, and a name that missed was dropped
    // silently before the guest saw it.
    const b = contextBlock({ place: { name: 'Los Angeles' }, partners: [partner(1)] });
    const line = b.split('\n').find((l) => l.includes('Place 1'));
    assert.ok(line, 'the partner never reached the block at all');
    assert.match(line, /\[p_1\]/, 'the block still hides the id the schema depends on');
  });

  test('the block says what the id is FOR, not just that it exists', () => {
    const b = contextBlock({ place: { name: 'Los Angeles' }, partners: [partner(1)] });
    assert.match(b, /PARTNER ID/);
    assert.match(b, /DROPPED before the guest ever sees it/);
  });

  test('a pick carrying the id resolves to a real tappable link', () => {
    const { picks, dropped } = resolvePicks([{ id: 'p_1', name: 'Place 1', why: 'x' }], [partner(1)]);
    assert.deepEqual(dropped, []);
    assert.equal(picks.length, 1);
    assert.ok(picks[0].link, 'resolved a pick with no link');
  });

  test('the id wins over a name that does not match', () => {
    // The whole reason to carry an id: the model abbreviates names, and a
    // near-miss used to lose the place entirely.
    const { picks, dropped } = resolvePicks(
      [{ id: 'p_1', name: 'totally different name', why: 'x' }], [partner(1)],
    );
    assert.deepEqual(dropped, []);
    assert.equal(picks[0].name, 'Place 1', 'the directory name did not win');
  });
});

/* ── "not giving new recommendations when asking for new ones" ─────────── */

describe('"show me others" has somewhere to go', () => {
  test('THE ARITHMETIC: a pool of 6 runs dry on the SECOND ask', () => {
    // This is the bug, written as a sum. Offer 3, ask for more, 3 remain.
    // Ask again and there are none — so Num told a guest in Los Angeles it
    // had nothing verified left, out of 90,264 places.
    const six = pool(6);
    const first = six.slice(0, 3).map((p) => p.name);
    const r1 = moreOptions({ text: 'show me others', shown: first, partners: six });
    assert.equal(r1.partners.length, 3);
    const second = [...first, ...r1.partners.slice(0, 3).map((p) => p.name)];
    const r2 = moreOptions({ text: 'anything else', shown: second, partners: six });
    assert.equal(r2.partners.length, 0, 'the old pool did NOT run dry — recheck this test');
  });

  test('a pool of 24 survives seven rounds of three', () => {
    const big = pool(24);
    const shown = [];
    for (let round = 0; round < 7; round += 1) {
      const r = moreOptions({ text: 'show me others', shown, partners: big });
      assert.ok(r.partners.length >= 3, `ran dry on round ${round + 1} with ${r.partners.length} left`);
      shown.push(...r.partners.slice(0, 3).map((p) => p.name));
    }
  });

  test('grounding actually asks for the bigger pool', () => {
    const src = readFileSync(join(ROOT, 'worker', 'grounding.mjs'), 'utf8');
    const call = /nearbyPlaces\(env, loc, userText, (\d+)/.exec(src);
    assert.ok(call, 'the nearbyPlaces call moved — this guard is now blind');
    assert.ok(Number(call[1]) >= 18, `pool is ${call[1]}; three-at-a-time exhausts it in ${Math.floor(call[1] / 3)} rounds`);
  });

  test('the block tells the model the extras are a reserve, not a list to read out', () => {
    // A model handed 24 rows with no instruction will try to use them all,
    // which is the opposite failure.
    const b = contextBlock({ place: { name: 'Los Angeles' }, partners: pool(24) });
    assert.match(b, /SHORTLIST TO CHOOSE FROM, NOT A LIST TO READ OUT/);
    assert.match(b, /keep the rest in reserve/);
  });
});

/* ── "the suggestions are short" ───────────────────────────────────────── */

describe('a recommendation carries a real reason', () => {
  const why = () => REPLY_SCHEMA.properties.picks.anyOf
    .find((x) => x.type === 'array').items.properties.why.description;

  test('THE THINNESS: "why" is a sentence now, not twelve words', () => {
    const d = why();
    assert.ok(!/twelve words/.test(d), 'still capped at a fragment');
    assert.match(d, /25 words/);
  });

  test('it asks for something concrete, and shows what concrete means', () => {
    const d = why();
    assert.match(d, /branzino/, 'the worked example is gone — "be specific" alone never works');
  });

  test('it still forbids inventing detail', () => {
    // The cure for thin answers must not become a licence to make things up.
    assert.match(why(), /Never invent a detail you were not given/);
  });

  test('the prose reply stays short — detail belongs on the cards', () => {
    // Deliberately unchanged. Detail in BOTH places is the "says everything
    // twice" clutter Dre named earlier; the fix for thin answers is richer
    // picks, not a longer paragraph.
    const d = REPLY_SCHEMA.properties.reply.description;
    assert.match(d, /RECOMMENDATIONS GO IN `picks`, NOT IN THIS FIELD/);
    assert.match(d, /Never (?:\n|.)*write a URL here/);
  });
});

/* ── "very few locations" ──────────────────────────────────────────────── */

describe('how many get offered', () => {
  test('three by default — Dre\'s rule, unchanged', () => {
    const d = REPLY_SCHEMA.properties.picks.anyOf.find((x) => x.type === 'array').description;
    assert.match(d, /Give THREE options/);
  });

  test('five when they asked broadly, and never "three because I only looked at three"', () => {
    const d = REPLY_SCHEMA.properties.picks.anyOf.find((x) => x.type === 'array').description;
    assert.match(d, /Give FIVE/);
    assert.match(d, /never stop at three because three is all/);
  });

  test('it still refuses to pad the list with invented places', () => {
    const d = REPLY_SCHEMA.properties.picks.anyOf.find((x) => x.type === 'array').description;
    assert.match(d, /never invent a third to fill the list/);
  });
});
