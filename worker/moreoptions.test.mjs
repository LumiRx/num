/**
 * "GIVE ME MORE" MUST MEAN MORE.
 *
 * Dre, 14 Sep 2026: "when people are making request they get 3 and ask for
 * more and get the same 3 suggestions again."
 *
 * The cause was not forgetfulness. The VERIFIED NEARBY PARTNERS block is the
 * same list in the same order every turn, ranked by quality and distance, and
 * the model is told to prefer it and give three. On the second ask it did
 * exactly what it did on the first — correctly, from identical input.
 *
 * So the fix removes the option rather than forbidding it: the places already
 * shown are taken OUT of the block. A model cannot repeat what it cannot see.
 * These tests pin that, and pin the two ways it could go wrong — stripping
 * places from a guest who never asked for alternatives, and quietly serving a
 * repeat when the list runs out instead of admitting it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanShown, moreOptions, shownBlock, wantsMore, withoutShown } from './moreoptions.mjs';
import { validatePayload } from './guard.mjs';

const P = (...names) => names.map((name, i) => ({ id: `p${i}`, name }));
const THREE = ['Gjelina', 'Felix', 'Rossoblu'];

describe('what counts as asking for more', () => {
  for (const t of [
    'more', 'any more?', 'give me 3 more', 'show me more places', 'more options',
    'anything else', 'what else', 'other options', 'others?', 'something different',
    'different places', 'alternatives', 'none of those', 'not these',
    "I don't like these", 'do not like them', 'keep going', 'next 3',
  ]) test(`yes: ${JSON.stringify(t)}`, () => assert.equal(wantsMore(t), true));

  for (const t of [
    'book the first one', 'what time do they open', 'is Gjelina good for a date',
    'the second one please', 'can you call them', 'yes', 'thanks',
    'somewhere quiet', 'what about tomorrow',
  ]) test(`no: ${JSON.stringify(t)}`, () => assert.equal(wantsMore(t), false));

  test('a whole paragraph is not a "more" ask', () => {
    // Narrow on purpose: a false positive strips good places from a guest who
    // never asked for alternatives, which is worse than the bug being fixed.
    assert.equal(wantsMore('x'.repeat(240) + ' more'), false);
  });

  test('nothing at all is not an ask', () => {
    for (const t of [null, undefined, '', '   ']) assert.equal(wantsMore(t), false);
  });
});

describe('the seen ones come out of the block', () => {
  test('a "more" ask removes exactly what was shown', () => {
    const out = moreOptions({
      text: 'anything else?',
      shown: THREE,
      partners: P('Gjelina', 'Felix', 'Rossoblu', 'Kismet', 'Bavel', 'Here’s Looking At You'),
    });
    assert.equal(out.more, true);
    assert.deepEqual(out.partners.map((p) => p.name), ['Kismet', 'Bavel', 'Here’s Looking At You']);
  });

  test('matching survives punctuation, case and spacing', () => {
    // The name reaches us from the model's own output, so it will not be
    // byte-identical to the row it came from.
    const left = withoutShown(P("Here's Looking At You", 'Bavel'), ['heres looking at you']);
    assert.deepEqual(left.map((p) => p.name), ['Bavel']);
  });

  test('an ORDINARY turn keeps every place, including the shown ones', () => {
    // "is Gjelina good for a date" must not have Gjelina removed from the
    // block, or the model cannot answer a question about its own pick.
    const out = moreOptions({
      text: 'is Gjelina good for a date?',
      shown: THREE,
      partners: P('Gjelina', 'Felix', 'Kismet'),
    });
    assert.equal(out.more, false);
    assert.equal(out.partners.length, 3);
  });

  test('nothing shown yet changes nothing', () => {
    const partners = P('Gjelina', 'Felix');
    assert.equal(withoutShown(partners, []).length, 2);
    assert.equal(moreOptions({ text: 'more', shown: [], partners }).partners.length, 2);
  });
});

describe('what the model is told', () => {
  test('a first turn says nothing at all', () => {
    assert.equal(shownBlock({ shown: [], more: false }), null);
    assert.equal(moreOptions({ text: 'where should I eat', shown: [], partners: [] }).block, null);
  });

  test('an ordinary turn is a quiet reminder, not a contract', () => {
    const b = shownBlock({ shown: THREE, more: false });
    assert.match(b, /ALREADY SHOWN/);
    for (const n of THREE) assert.ok(b.includes(n), n);
    assert.doesNotMatch(b, /THREE THEY HAVE NOT SEEN/);
    // Referring back to a pick they are considering is the right behaviour.
    assert.match(b, /Referring back to one they are considering is fine/);
  });

  test('a "more" ask is an explicit contract naming every seen place', () => {
    const b = moreOptions({ text: 'more', shown: THREE, partners: P('Kismet', 'Bavel', 'Ètra') }).block;
    assert.match(b, /THEY ASKED FOR MORE/);
    assert.match(b, /THREE THEY HAVE NOT SEEN/);
    for (const n of THREE) assert.ok(b.includes(n), n);
    assert.match(b, /not a rewording of one/, 'the same place under another name is still a repeat');
  });

  test('it asks for the DIFFERENCE to be led with, because that is why they asked', () => {
    const b = shownBlock({ shown: THREE, more: true, remaining: 5 });
    assert.match(b, /different neighbourhood/i);
  });

  test('running out is admitted, never padded with a repeat', () => {
    const out = moreOptions({ text: 'anything else', shown: THREE, partners: P(...THREE) });
    assert.equal(out.partners.length, 0);
    assert.match(out.block, /NOTHING VERIFIED LEFT NEARBY/);
    assert.match(out.block, /widen the area/);
    assert.match(out.block, /Never pad the gap with a repeat/);
    assert.match(out.block, /not from Num's own verified list|not from Num’s own verified list/,
      'general-knowledge names must be labelled as such');
  });

  test('plenty left means no false apology', () => {
    const out = moreOptions({ text: 'more', shown: ['Gjelina'], partners: P('Gjelina', 'Kismet', 'Bavel', 'Ètra') });
    assert.doesNotMatch(out.block, /NOTHING VERIFIED LEFT/);
  });
});

describe('the list we carry is bounded and clean', () => {
  test('duplicates collapse and blanks disappear', () => {
    assert.deepEqual(cleanShown(['Felix', 'felix', ' Felix ', '', null, 'Bavel']), ['Felix', 'Bavel']);
  });

  test('forty is the ceiling', () => {
    assert.equal(cleanShown(Array.from({ length: 90 }, (_, i) => `Place ${i}`)).length, 40);
  });

  test('a name cannot be used to smuggle a paragraph into the prompt', () => {
    assert.equal(cleanShown(['x'.repeat(400)])[0].length, 80);
  });
});

describe('the field actually survives the front door', () => {
  // THE FAILURE THIS CATCHES: validatePayload is a whitelist. The app could
  // send `shown` and the reader could read `parsed.shown`, and with the field
  // missing from that whitelist the array would arrive empty on every single
  // turn — a feature wired end to end and dead in the middle, with nothing
  // anywhere reporting a problem.
  const base = { messages: [{ role: 'user', content: 'more please' }] };

  test('it is carried through, trimmed and de-blanked', () => {
    const out = validatePayload({ ...base, shown: ['Gjelina', '  Felix  ', '', 7] });
    assert.deepEqual(out.shown, ['Gjelina', 'Felix']);
  });

  test('absent means empty, never undefined', () => {
    assert.deepEqual(validatePayload(base).shown, []);
  });

  test('the wrong type is a 400, not a silent drop', () => {
    const out = validatePayload({ ...base, shown: 'Gjelina' });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
  });

  test('it is capped at the front door too, not only downstream', () => {
    const out = validatePayload({ ...base, shown: Array.from({ length: 200 }, (_, i) => `P${i}`) });
    assert.equal(out.shown.length, 40);
    assert.equal(validatePayload({ ...base, shown: ['y'.repeat(500)] }).shown[0].length, 80);
  });
});

describe('the turn is actually wired', () => {
  const IDX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const PROMPT = readFileSync(new URL('./prompt.mjs', import.meta.url), 'utf8');

  test('the reader passes the app’s list in', () => {
    assert.match(IDX, /shown: parsed\.shown \?\? \[\]/);
  });

  test('the FILTERED partners reach the context block, not the raw ones', () => {
    // The whole fix is this one substitution. If contextBlock is ever handed
    // grounding.partners again, the bug is back and nothing else would say so.
    const at = IDX.indexOf('const groundingBlock = contextBlock({');
    const call = IDX.slice(at, IDX.indexOf('});', at));
    assert.match(call, /partners: rotation\.partners/);
    assert.doesNotMatch(call, /partners: grounding\.partners/);
    assert.match(call, /shown: rotation\.block/);
  });

  test('contextBlock renders it', () => {
    assert.match(PROMPT, /if \(shown\) lines\.push\(shown\)/);
    // Matched as a parameter, not as the END of the parameter list — the
    // list grows (entryDocs landed beside it the same afternoon) and a test
    // pinned to the closing brace fails on somebody else's unrelated work.
    assert.match(PROMPT, /contextBlock\(\{[\s\S]{0,400}?\bshown = null\b/);
  });

  test('and the persona carries the rule in its own words', () => {
    assert.match(PROMPT, /IF THEY ASK FOR MORE, THEY ARE TELLING YOU THE FIRST SET MISSED/);
    assert.match(PROMPT, /TASTE CHOOSES THE PLACES, NOT JUST THE WORDS/);
  });
});

describe('taste is a question Num can now ask', () => {
  test('there is a dimension for what they like DOING', async () => {
    const { nextQuestion } = await import('./soulprofile.mjs');
    // Every other dimension describes HOW somebody travels — who with, how
    // fast, how loud, how much. None asked what they enjoy doing, which is
    // the answer that changes WHICH places get picked.
    const q = nextQuestion({ crew: 'two', pace: 'slow' }, { topic: 'plan', asked: [] });
    assert.equal(q.key, 'doing');
    assert.match(q.ask, /love doing/i);
  });

  test('it is reachable when choosing a venue too, not only a whole day', async () => {
    const { nextQuestion } = await import('./soulprofile.mjs');
    const q = nextQuestion({ crew: 'two', atmosphere: 'quiet' }, { topic: 'venue', asked: [] });
    assert.equal(q?.key, 'doing');
  });

  test('and it is never asked twice, or once it is known', async () => {
    const { nextQuestion } = await import('./soulprofile.mjs');
    assert.notEqual(nextQuestion({ doing: 'markets' }, { topic: 'plan', asked: [] })?.key, 'doing');
    assert.notEqual(nextQuestion({}, { topic: 'plan', asked: ['doing', 'crew', 'pace'] })?.key, 'doing');
  });
});
