// Response quality control — the checks, and the promise they must not break.
//
// Every hard check below is a bug that reached a paying guest. The most
// important test in this file is the last one: grading must never be able to
// produce silence.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, figuresIn } from './quality.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTEXT = 'VERIFIED NEARBY PARTNERS (real places from Num’s database — prefer these, details are exact):\nKrua Thai — Kata Road — 4.6 (312 reviews) — mains from THB 180\nBaan Rim Pa — Patong — 4.4 (890 reviews)\nA long block of verified grounding so the deflection check has something to argue with. '.padEnd(500, '.');

test('an invented price is caught; a quoted one is not', () => {
  const invented = inspect({
    ask: 'how much is a taxi to the airport',
    reply: 'A car to the airport runs about THB 2,800.',
    context: CONTEXT,
  });
  assert.ok(invented.hard, 'the 2,800 baht incident would ship again');
  assert.ok(invented.flags.some((f) => f.startsWith('invented-money')));

  const quoted = inspect({
    ask: 'where can I eat near Kata',
    reply: 'Krua Thai on Kata Road — mains from THB 180. Solid and close.',
    context: CONTEXT,
  });
  assert.ok(!quoted.flags.some((f) => f.startsWith('invented-')),
    'a price copied verbatim from the verified block was flagged — the check would retry correct answers');
});

test('separators do not make a real number look invented', () => {
  // The model writes "THB 1,200"; the row says "1200". Same number.
  const r = inspect({ ask: 'cost?', reply: 'About THB 1,200.', context: 'transfer 1200 baht fixed' });
  assert.ok(!r.hard, 'comma formatting alone triggered a retry');
});

test('a number the guest supplied is theirs to have repeated', () => {
  const r = inspect({
    ask: 'anywhere good for dinner under 800 baht',
    reply: 'Krua Thai fits under THB 800 comfortably.',
    context: CONTEXT,
  });
  assert.ok(!r.hard, 'echoing the guest’s own budget counted as invention');
});

test('ratings are held to the same rule as prices', () => {
  assert.ok(inspect({ ask: 'is it good', reply: 'It is rated 4.9 — excellent.', context: CONTEXT }).hard,
    'a rating no row holds passed');
  assert.ok(!inspect({ ask: 'is it good', reply: 'Yes — 4.6 from 312 reviews.', context: CONTEXT }).hard,
    'the real rating was rejected');
});

test('distances and times are NOT hard-flagged', () => {
  // Deliberate: these are restated and computed constantly, and a false
  // positive costs a guest a real retry on a correct answer.
  const r = inspect({ ask: 'how far is karon', reply: 'Karon is about 10 minutes up the coast, roughly 4 km.', context: CONTEXT });
  assert.ok(!r.hard, 'a distance triggered a corrective retry — this check must stay narrow');
});

test('deflection with a full context block is caught', () => {
  const r = inspect({ ask: 'where should I eat in Kata', reply: "I don't have that information right now.", context: CONTEXT });
  assert.ok(r.hard && r.flags.includes('deflected-with-context'));
  // But an honest gap with nothing to work from is not a failure.
  assert.ok(!inspect({ ask: 'where should I eat in Ulaanbaatar', reply: "I don't have anything verified there yet.", context: '' }).hard,
    'honesty about an empty directory was punished');
  // The real shape of that gap: the context block is NOT empty — it carries
  // the date line, the location rules and the unsupported-city instruction,
  // ~850 characters with no partner in it. The old check keyed on length and
  // flagged this, then told the model to "answer from the verified block
  // above". There was none. Honesty must pass on the block as it is actually
  // rendered, not only on an empty string.
  const EMPTY_BLOCK = ('Today is Thu 4 Sep 2026, 21:10 UTC. If the guest has said where they are, convert to THEIR timezone. ' +
    'The user is asking about Del Mar. Num has NO partner network there yet — no verified places, no booking, no car. ' +
    'Answer as well as general knowledge allows, and say plainly that booking and partner perks aren\'t live there yet. ' +
    'NEVER answer about a different city instead, and NEVER invent partner venues, exact prices, or opening hours. Create no booking actions. ').padEnd(900, '.');
  assert.ok(!inspect({ ask: 'where should I eat in Del Mar', reply: "I don't have anywhere verified in Del Mar yet — here's what I'd do from general knowledge.", context: EMPTY_BLOCK }).hard,
    'an honest decline over a partner-less block was flagged as deflection');
});

test('a reply that is only a question is caught', () => {
  assert.ok(inspect({ ask: 'book me dinner tonight', reply: 'What time were you thinking?', context: CONTEXT }).hard);
  assert.ok(!inspect({ ask: 'book me dinner tonight', reply: 'Krua Thai has space tonight. What time?', context: CONTEXT }).hard,
    'answer-then-one-question is the house style and must pass');
});

test('a thin recommendation is soft, never a retry', () => {
  const r = inspect({ ask: 'where should I get breakfast', reply: 'Krua Thai — good coffee, opens at seven.', context: CONTEXT });
  assert.ok(r.flags.includes('thin-recommendation'));
  assert.ok(!r.hard,
    'retrying a thin recommendation pushes the model to invent a third place — exactly the failure the three-option rule must not cause');
});

test('a yes/no question with no verdict is flagged', () => {
  assert.ok(inspect({ ask: 'is Kata beach walkable from here', reply: 'Kata beach is popular in the afternoon.', context: CONTEXT })
    .flags.includes('no-verdict'));
  assert.ok(!inspect({ ask: 'is Kata beach walkable from here', reply: 'Yes — about eight minutes down the hill.', context: CONTEXT })
    .flags.includes('no-verdict'));
});

test('figuresIn reads the shapes guests actually see', () => {
  const kinds = figuresIn('THB 1,200 or $45, rated 4.6 stars').map((f) => `${f.kind}:${f.n}`);
  assert.deepEqual(kinds, ['money:1200', 'money:45', 'rating:46']);
});

test('grading can never produce silence', () => {
  // The contract, in code: inspect() has no path that returns a reply, so it
  // cannot withhold one. And the caller keeps the original whenever the retry
  // is not strictly better.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  // `keepRouting(...)` since 3 Sep 2026 — the retry is still gated on
  // `!after.hard`, it just no longer throws away the record of which brain
  // answered on its way through. See worker/routinglabel.mjs.
  assert.match(index, /if \(!after\.hard\) \{\s*\n\s*result = keepRouting\(\{ \.\.\.fixed/,
    'the retry is taken unconditionally — a worse retry would replace a good answer');
  assert.match(index, /flags: \[\.\.\.quality\.flags, 'retry-error'\]/,
    'a thrown retry is no longer caught — a failed grade would cost the guest the reply they already had');
  const quality = readFileSync(join(HERE, 'quality.mjs'), 'utf8');
  assert.ok(!/return\s+FALLBACK|reply:/.test(quality),
    'quality.mjs now returns a reply — it grades, it must not answer');
});

test('the ask row carries the flags', () => {
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /quality: quality\.flags/,
    'flags are computed and thrown away — the whole point is being able to see quality per question');
  // And the check must run BEFORE the row is written, or it records the
  // grade of a reply that was then replaced.
  assert.ok(index.indexOf('let quality = inspect(') < index.indexOf('quality: quality.flags'),
    'the ask is recorded before the reply is graded');
});

// ── 3 Sep 2026: every recommendation carries a link ─────────────────────────
//
// Dre: "If we are giving a recommendation for a restaurant, it needs to be
// clear... every time we give a recommendation for a place, we need to give a
// link to the location. The AI agent that checks the message before it is sent
// needs to be checking that the message is clean and organized."
//
// These are that check.
describe('a recommendation without linked picks does not ship', () => {
  const ASK = 'where should we eat tonight in kata?';
  const PICK = { id: 'p1', name: 'Baan Rim Pa', link: 'https://baanrimpa.com/', phone: '+66 76 340 789', why: 'Cliffside tables' };
  const PICK2 = { id: 'p2', name: 'Suay', link: 'https://maps.example/2', phone: null, why: 'Chef-led, walkable' };

  test('places listed in prose with an empty picks array is a HARD flag', () => {
    const out = inspect({
      ask: ASK,
      reply: 'Baan Rim Pa is lovely, or try Suay Restaurant, or Kan Eang at Chalong.',
      picks: [],
      context: 'VERIFIED NEARBY PARTNERS…',
    });
    assert.equal(out.hard, true);
    assert.ok(out.flags.includes('recommendation-without-picks'));
    assert.match(out.note, /`picks`/);
  });

  test('honestly having nothing is NOT flagged — it must never be retried into an invention', () => {
    const out = inspect({
      ask: ASK,
      reply: 'I have nothing verified near you for that tonight. Want me to look further out?',
      picks: [],
      context: 'x',
    });
    assert.equal(out.flags.includes('recommendation-without-picks'), false);
  });

  test('picks present → no flag, whatever the prose says', () => {
    const out = inspect({ ask: ASK, reply: 'Three near you — the first is what I would do.', picks: [PICK, PICK2], context: 'x' });
    assert.equal(out.flags.includes('recommendation-without-picks'), false);
  });

  test('picks null (not a recommendation turn) is never flagged', () => {
    const out = inspect({ ask: 'is the beach walkable?', reply: 'Yes — about ten minutes.', picks: null, context: 'x' });
    assert.equal(out.flags.includes('recommendation-without-picks'), false);
  });
});

describe('the model never writes a URL', () => {
  test('an http link in the prose is a hard flag', () => {
    const out = inspect({ ask: 'where should we eat?', reply: 'Try https://baanrimpa.com for the menu.', picks: [], context: 'x' });
    assert.equal(out.hard, true);
    assert.ok(out.flags.includes('model-written-url'));
    assert.match(out.note, /verified directory/);
  });
  test('a bare domain counts too', () => {
    assert.ok(inspect({ ask: 'x', reply: 'See baanrimpa.com', picks: null, context: 'x' }).flags.includes('model-written-url'));
    assert.ok(inspect({ ask: 'x', reply: 'See www.baanrimpa.co.uk', picks: null, context: 'x' }).flags.includes('model-written-url'));
  });
  test('prices and times are not URLs — the check must not cry wolf', () => {
    for (const r of ['They open at 7.30 and it is about £24.50.', 'Roughly 1.2 km away, 4.5 stars.', 'Ready in 2.5 hours.']) {
      assert.equal(inspect({ ask: 'x', reply: r, picks: null, context: r }).flags.includes('model-written-url'), false, r);
    }
  });
});

describe('the message does not repeat the cards', () => {
  const PICKS = [
    { name: 'Baan Rim Pa', link: 'https://a', phone: '+66 76 340 789' },
    { name: 'Suay', link: 'https://b', phone: null },
  ];
  test('restating every pick in prose is flagged (softly)', () => {
    const out = inspect({ ask: 'where should we eat?', reply: 'Baan Rim Pa is great, and Suay is also good.', picks: PICKS, context: 'x' });
    assert.ok(out.flags.includes('picks-restated-in-prose'));
    assert.equal(out.hard, false);
  });
  test('naming only your top pick is good writing, not clutter', () => {
    const out = inspect({ ask: 'where should we eat?', reply: 'Three near you — Baan Rim Pa is what I would do.', picks: PICKS, context: 'x' });
    assert.equal(out.flags.includes('picks-restated-in-prose'), false);
  });
  test('a phone number in the prose is always duplication now', () => {
    const out = inspect({ ask: 'where should we eat?', reply: 'Call them on +66 76 340 789.', picks: PICKS, context: 'x' });
    assert.ok(out.flags.includes('phone-in-prose'));
  });
});
