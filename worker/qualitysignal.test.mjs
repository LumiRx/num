// Do not claim a favourite you cannot justify.
//
// ── WHAT HAPPENED ────────────────────────────────────────────────────────
//
// 18 Sep 2026: Dre asked for a hotel downtown and was given Rotex Hotel —
// 2.5 stars on Google — with far better hotels nearby. Nothing had crashed.
// Three true things combined:
//
//   1. `top_places` held 18,843 rows outside Phuket with ZERO ratings, so the
//      score collapsed to "has a phone and a website" and thousands tied.
//   2. discover.mjs orders by `rating DESC NULLS LAST`, which over an
//      all-null column is not an ordering at all.
//   3. The prompt told the model the block was "ranked by quality" and,
//      separately, to always name the ONE it would pick.
//
// So the concierge confidently recommended an arbitrary row, in its own
// voice, because that is precisely what it had been instructed to do.
//
// The enrichment that fills those ratings costs money and takes time. This
// does not: when the candidates carry no quality signal, say so and decline
// to rank. An honest "I can't tell which is best here" keeps the guest's
// trust; a confident wrong pick spends it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * The prompt is assembled from concatenated string literals, so a sentence
 * the model receives as one line is split across `' + '` in the source. Match
 * the sentence the MODEL sees, not the way the file happens to wrap it —
 * otherwise re-wrapping a line silently turns these guards off.
 */
const asSent = (src) => src.replace(/'\s*\n?\s*\+\s*'/g, '').replace(/\s+/g, ' ');

const PROMPT = read('./prompt.mjs');
const PROMPT_SENT = asSent(PROMPT);

describe('the block declares whether it is ranked', () => {
  test('prompt.mjs decides from the data, not from hope', () => {
    assert.match(PROMPT, /const rated = partners\.filter\(\(b\) => b\.rating != null\)\.length;/,
      'the count must come from the partners actually being sent');
    assert.match(PROMPT, /const ranked = rated >= Math\.min\(3, partners\.length\);/,
      'a block needs real ratings before it may be called ranked');
  });

  test('an unrated block forbids a favourite, in words a model cannot miss', () => {
    assert.match(PROMPT_SENT, /NO QUALITY SIGNAL/);
    assert.match(PROMPT_SENT, /Do NOT name one as the one you would pick/);
    assert.match(PROMPT_SENT, /do NOT call any of them best, top, favourite or a gem/i);
  });

  test('distance and hours stay usable — the block is limited, not useless', () => {
    assert.match(PROMPT_SENT, /Distance, opening hours and category are real and may be used/);
  });

  test('the standing rule no longer promises quality ranking unconditionally', () => {
    // This sentence was the actual untruth: every destination but Phuket got
    // a block described as "ranked by quality and distance" that was ranked
    // by neither.
    assert.ok(
      !/own database, ranked by quality and distance/.test(PROMPT),
      'the unconditional "ranked by quality and distance" claim must not come back',
    );
    assert.match(PROMPT_SENT, /when it says NO QUALITY SIGNAL, it is not/);
  });
});

describe('the always-pick-one instructions defer to the block', () => {
  test('brains.mjs carves out the unranked case', () => {
    const b = read('./brains.mjs');
    assert.match(b, /UNLESS the verified block says NO QUALITY SIGNAL/,
      'the "say which ONE you would pick" rule must yield when there is nothing to judge on');
  });

  test('specialists.mjs carves it out too', () => {
    const s = read('./specialists.mjs');
    assert.match(s, /NO QUALITY SIGNAL/);
    assert.match(s, /an opinion would be invented rather than earned/);
  });

  test('every surface that mandates a pick has the carve-out', () => {
    // The rule lives in more than one prompt. A carve-out in one of them is
    // how the behaviour comes back on whichever path was missed.
    const mandates = ['./brains.mjs', './specialists.mjs', './prompt.mjs']
      .map((f) => ({ f, src: read(f) }))
      .filter(({ src }) => /which ONE you would pick/i.test(src));
    assert.ok(mandates.length >= 2, 'expected the pick-one rule on several surfaces');
    for (const { f, src } of mandates) {
      assert.ok(/NO QUALITY SIGNAL/.test(src), `${f} mandates a pick with no carve-out for unranked candidates`);
    }
  });
});
