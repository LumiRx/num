/**
 * One house style for suggesting a place, applied on every turn.
 *
 * Dre, 6 Sep 2026: "when suggesting places we need to provide a standard of
 * text… look at the way Nudge delivers to its users." Nudge reads like the
 * friend who plans: one named place, the single reason it is that one, the two
 * facts that decide whether you can go, and a stop.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SUGGESTION_STYLE, CARD_ORDER, FACT_ORDER, BANNED, styleNotes } from './suggestionstyle.mjs';

test('the style is read on every turn, in the cached block', () => {
  const idx = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(idx, /import \{ SUGGESTION_STYLE \} from '\.\/suggestionstyle\.mjs'/);
  assert.match(idx, /PERSONA \+ '\\n\\n' \+ VOICE \+ '\\n\\n' \+ SUGGESTION_STYLE/,
    'the style must ride with the persona — a rule some turns get is not a standard');
  assert.match(idx, /SUGGESTION_STYLE, cache_control/, 'it is identical every turn, so it belongs in the cached block');
});

test('the style says the six things that make a suggestion, not a paragraph', () => {
  // Rule 1 changed on 7 Sep from "ONE place per suggestion" to "every place
  // goes in `picks`", and the rest shifted down one. The properties this test
  // guards are unchanged — where a place goes, how many, why this one, the
  // facts, sequencing, and stopping — so they are all still pinned, at their
  // new numbers. See the describe block at the foot of this file for why.
  for (const rule of [
    /EVERY place you name goes in `picks`/,
    /PREFER ONE/,
    /ONE line on why THIS one/,
    /how far, whether it is open/,
    /Sequence when it helps/,
    /6\. Stop\./,
  ]) {
    assert.match(SUGGESTION_STYLE, rule);
  }
  assert.match(SUGGESTION_STYLE, /never estimate a distance, a price or an opening time/,
    'the standard must forbid inventing the facts it asks for');
  assert.match(SUGGESTION_STYLE, /answer that constraint explicitly in the first sentence/,
    'a constraint is why they typed instead of searching');
});

test('the card reads image first — less reading up front, tap for more', () => {
  assert.equal(CARD_ORDER[0], 'photo');
  assert.deepEqual([...CARD_ORDER], ['photo', 'name', 'why', 'facts', 'action']);
  assert.deepEqual(FACT_ORDER.map((f) => f.key), ['distance', 'open', 'price']);
  assert.match(FACT_ORDER.find((f) => f.key === 'price').omit_if, /never estimated/);
});

test('a real Num answer passes, and stock travel-brochure prose does not', () => {
  const good = 'Nahm on Sathorn — the tasting menu is the reason to go, and 9pm is the quiet slot. 400 m away, open until 11. Want me to ask them to hold a table?';
  assert.deepEqual(styleNotes(good), []);

  const bad = '**Top picks for you!**\n\n- A hidden gem nestled in bustling Sathorn 🍜\n\n- Whether you want Thai or Italian, there is something for everyone\n\n- Look no further';
  const notes = styleNotes(bad);
  for (const expect of ['hidden gem', 'nestled', 'bustling', 'something for everyone', 'bulleted list of venues', 'bold headings', 'emoji']) {
    assert.ok(notes.some((n) => n.includes(expect)), `missed: ${expect}`);
  }
});

test('it grades, it does not gate — an unusual answer is never blocked', () => {
  const src = readFileSync(new URL('./suggestionstyle.mjs', import.meta.url), 'utf8');
  assert.match(src, /Advisory, not a gate/);
  assert.equal(typeof styleNotes(''), 'object', 'an empty reply returns notes, never throws');
  assert.deepEqual(styleNotes(null), [], 'null must not crash a turn');
});

test('the banned list is phrases, not words a real answer needs', () => {
  for (const p of BANNED) assert.ok(p.length > 4, `"${p}" is short enough to catch innocent prose`);
  // These must all survive: they are things a concierge genuinely says.
  for (const fine of ['The bar is open until 2am.', 'It is a family place, so the eight-year-old is fine.',
    'Local wine, and they know it well.', 'A short walk, five minutes at most.']) {
    assert.deepEqual(styleNotes(fine), [], `the style flagged a good sentence: "${fine}"`);
  }
});

// ── the two rules that disagreed ────────────────────────────────────────
//
// 7 Sep 2026, from a screenshot Dre sent: three massage places run together in
// one sentence with their distances, no cards; then a follow-up that typed a
// street address and a phone number into prose, where a thumb cannot tap them.
//
// The cause was not a missing instruction. Every rule needed already existed —
// two of them, disagreeing, both in the system prompt on the same turn:
//
//   · `reply` schema:  "Do NOT repeat the names, phone numbers, addresses or
//                       links in this prose field."
//   · CONTACT RULE:    "Hand them over so the guest can call or walk in
//                       themselves."
//
// A contradiction in a prompt does not average out. Whichever instruction sits
// nearer the data wins, and it changes turn to turn — which is why the answers
// were inconsistent rather than uniformly wrong. These tests pin the agreement.
describe('the prompt does not argue with itself', () => {
  const raw = readFileSync(new URL('./prompt.mjs', import.meta.url), 'utf8');
  /**
   * What the MODEL reads, not what a maintainer reads.
   *
   * The comments in prompt.mjs quote the old rules on purpose, so the next
   * person can see what was changed and why. Testing the raw file would fail on
   * that history and push somebody to delete the explanation — which is the
   * only record of why the rule reads as it does.
   */
  const promptSrc = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('nothing tells the model to hand a phone number or address to the guest in prose', () => {
    // The exact sentence that produced the screenshot, and the shape of it.
    assert.ok(!/Hand them over so the guest can call/i.test(promptSrc),
      'the old CONTACT RULE is back — it contradicts the reply schema and wins, because it sits next to the rows');
    assert.ok(!/never leave a recommendation as a bare name when Num holds a number/i.test(promptSrc));
  });

  test('the CONTACT RULE now points at the card, and says why', () => {
    const rule = promptSrc.slice(promptSrc.indexOf('CONTACT RULE:'), promptSrc.indexOf('CONTACT RULE:') + 900);
    assert.match(rule, /PUT THE PLACE IN `picks`/);
    assert.match(rule, /cannot be tapped/i, 'it does not say why prose is worse than a card');
    // The honest half survives: where we hold nothing, we say so.
    assert.match(rule, /neither a number nor an address/i);
  });

  test('every place goes in picks — that is what makes it a link', () => {
    // Dre: "we are supposed to be giving the link to any locations that we are
    // suggesting". A pick is the only thing that gets a verified link attached;
    // resolvePicks drops any pick it cannot build one for. So "goes in picks"
    // and "has a link" are the same requirement.
    assert.match(SUGGESTION_STYLE, /EVERY place you name goes in `picks`/);
    assert.match(SUGGESTION_STYLE, /NEVER TYPE CONTACT DETAILS/);
  });

  test('more than one place means more than one card, never one sentence', () => {
    // Dre: "if we are offering more than one suggestion, it needs to be spaced
    // and separated so that it can be easily read."
    assert.match(SUGGESTION_STYLE, /each as its own pick/);
    assert.match(SUGGESTION_STYLE, /Never run several places together in a sentence/);
    // And the failure is quoted in the rule, because a rule with the mistake in
    // it is one a model recognises.
    assert.match(SUGGESTION_STYLE, /490m/);
  });

  test('the house style and the reply schema now say the same thing about how many', () => {
    // The old rule 1 said "ONE place per suggestion. Never a list of four."
    // The schema said "fill `picks` with them… Three near you". Both shipped.
    assert.ok(!/ONE place per suggestion/.test(SUGGESTION_STYLE),
      'rule 1 is back to forbidding what the reply schema asks for');
    assert.match(SUGGESTION_STYLE, /PREFER ONE/);
    assert.match(promptSrc, /RECOMMENDATIONS GO IN `picks`, NOT IN THIS FIELD/);
  });

  test('the numbering survived the edit — a rule nobody can cite is a rule nobody follows', () => {
    const numbered = SUGGESTION_STYLE.split('\n').filter((l) => /^\d\./.test(l));
    assert.deepEqual(numbered.map((l) => l[0]), ['1', '2', '3', '4', '5', '6']);
  });
});
