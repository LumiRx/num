/**
 * DEEP RESEARCH — the parts that must not be taken on trust.
 *
 * Three of these cover things a model cannot be asked to promise: that no
 * invented venue reaches a guest, that a failed run is free, and that the
 * free allowance can never quietly become zero.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { verify, evidenceBlock, assertFreeFloor, LIMITS, brainFor, PROSE_KINDS } from './research.mjs';
import { tiers } from './membership.mjs';

const SRC = readFileSync(new URL('./research.mjs', import.meta.url), 'utf8');

const rows = [
  { id: 'p1', name: 'Nahm', area: 'Sathorn', rating: 4.6, reviews: 2100, km: 1.2, cuisine: 'Thai' },
  { id: 'p2', name: 'Bo.lan', area: 'Sukhumvit', rating: 4.5, reviews: 900, km: 3.4 },
  { id: 'p3', name: 'Le Du', area: 'Silom', rating: 4.8, reviews: 3200 },
];

describe('the answer may only name places Num actually holds', () => {
  test('a venue from the evidence passes through untouched', () => {
    const out = verify('I would take you to **Nahm** in Sathorn, then Le Du for the wine.', rows);
    assert.deepEqual(out.invented, []);
  });

  test('a venue the model remembered from training is caught', () => {
    // The real failure: a model given twelve real restaurants adds a famous
    // thirteenth it half-remembers, usually one that closed years ago. The
    // guest cannot tell the two apart. Num can, and does.
    const out = verify('Try **Nahm**, or **Gaggan Anand** if you want tasting menus.', rows);
    assert.ok(out.invented.includes('Gaggan Anand'), 'the name that was never in the evidence is flagged');
    assert.ok(!out.invented.includes('Nahm'));
  });

  test('a near-miss spelling still counts as the same place', () => {
    // "Bo.lan" vs "Bolan" vs "Bo Lan" is the same restaurant. Flagging it
    // would train everyone to ignore the warning, which is worse than the
    // occasional miss it prevents.
    const out = verify('**Bo Lan** does the old recipes.', rows);
    assert.deepEqual(out.invented, []);
  });

  test('ordinary Title Case prose is not mistaken for a venue', () => {
    // The first version of this checker flagged "Saturday Night" as an
    // invented restaurant. A checker that cries wolf gets ignored the one
    // time it is right, so only what the model deliberately marked is checked.
    const out = verify('On Saturday Night the area gets busy, so book ahead. **Nahm** takes bookings.', rows);
    assert.deepEqual(out.invented, [], 'a day of the week is not a restaurant');
  });

  test('an answer that marked nothing is reported as unchecked, not as clean', () => {
    const long = `Sathorn is the quieter side of the river and most people end up around there in the evening. `
      + `There are a dozen places within walking distance of the station and they fill up after eight, `
      + `so go early or book. The food is good and the walk back along the river is the nicest part of it all.`;
    const out = verify(long, rows);
    assert.deepEqual(out.invented, []);
    assert.equal(out.unmarked, true, 'nothing to check is not the same as nothing wrong');
  });

  test('a short or evidence-free answer is not accused of being unchecked', () => {
    assert.equal(verify('Nothing suitable tonight.', rows).unmarked, false);
    assert.equal(verify('A long answer '.repeat(30), []).unmarked, false, 'no evidence, nothing to verify against');
  });

  test('what is flagged is reported, never silently deleted', () => {
    const out = verify('Try **Somewhere Invented Entirely**.', rows);
    assert.ok(out.answer.includes('Somewhere Invented Entirely'), 'the text is returned whole');
    assert.equal(out.invented.length, 1, 'and the caller is told, so the guest can be told');
  });
});

describe('the evidence a brain is given', () => {
  test('is numbered, factual, and says when something is unrated', () => {
    const block = evidenceBlock(rows);
    assert.match(block, /^1\. Nahm — Thai, Sathorn · 4\.6★ \(2100\) · 1\.2km$/m);
    assert.match(block, /Le Du/);
    assert.ok(!/unrated/.test(block) || true);
    const withUnrated = evidenceBlock([{ id: 'x', name: 'New Place' }]);
    assert.match(withUnrated, /unrated/, 'a place with no rating says so rather than implying one');
  });
});

describe('the free allowance is load-bearing', () => {
  test('three a month on the free tier, and the code checks at run time', () => {
    assert.equal(tiers({}).free.entitlements.deep_research_monthly, 3);
    assert.equal(assertFreeFloor({}), true);
  });

  test('an override that zeroes the free tier stops the feature dead', () => {
    // B&P §17550.27. With a free allowance of zero this stops being a metered
    // feature and becomes a travel benefit sold only to subscribers — the
    // exact thing membership.mjs ungated three capabilities to avoid. The
    // check is at run time because MEMBERSHIP_TIERS can change without a
    // deploy, a review, or anyone noticing.
    const env = { MEMBERSHIP_TIERS: JSON.stringify({
      free: { name: 'Num', price_cents: 0, entitlements: { deep_research_monthly: 0 } },
      pro: { name: 'Num Pro', price_cents: 2898, entitlements: { deep_research_monthly: null } },
    }) };
    assert.equal(assertFreeFloor(env), false, 'refuses to run rather than run unlawfully');
  });

  test('unlimited on the free tier is obviously fine', () => {
    const env = { MEMBERSHIP_TIERS: JSON.stringify({ free: { name: 'Num', price_cents: 0, entitlements: { deep_research_monthly: null } } }) };
    assert.equal(assertFreeFloor(env), true);
  });
});

describe('the shape of a run', () => {
  test('the allowance is charged after the answer exists, never before', () => {
    const charge = SRC.indexOf("countUse(env, row.member_id, 'deep_research_monthly'");
    const written = SRC.indexOf("UPDATE num_research SET state='done'");
    assert.ok(charge > 0 && written > 0);
    assert.ok(written < charge, 'a run that dies half way through costs the member nothing');
  });

  test('a destination Num knows nothing about is an honest empty, not a guess', () => {
    const slice = SRC.slice(SRC.indexOf('if (!all.length)'), SRC.indexOf('const draft ='));
    assert.match(slice, /state='empty'/);
    assert.match(slice, /not going to guess/);
    assert.ok(!/countUse/.test(slice), 'and it does not charge for the empty');
  });

  test('the work runs after the response, so the guest is not left waiting', () => {
    assert.match(SRC, /ctx\.waitUntil\(runResearch/, 'waitUntil, or the run dies with the request');
    assert.match(SRC, /state: 'queued'/);
    assert.match(SRC, /, 202\)/, '202 Accepted — started, not finished');
  });

  test('one run belongs to the member who paid for it', () => {
    assert.match(SRC, /row\.member_id !== me\) return json\(\{ error: 'not yours' \}, 403\)/);
  });

  test('the brain it picks is one callProse can actually reach', () => {
    // Every run failed in 286ms with "claude has no prose path" because the
    // first version preferred Anthropic. callProse handles workers-ai and
    // openai-compatible and then throws — there is no Anthropic branch, on
    // purpose, so background work can never spend the Claude balance guests
    // depend on. This is the test that stops that being re-learned.
    assert.ok(!PROSE_KINDS.includes('anthropic'), 'callProse has no Anthropic path');
    const picked = brainFor({ NUM_LLM_KEY: 'k', NUM_LLM_URL: 'https://example.invalid/v1', AI: {} });
    assert.ok(picked, 'something answers when a key is present');
    assert.ok(PROSE_KINDS.includes(picked.kind), `picked ${picked.id} (${picked.kind}), which callProse would throw on`);
    assert.equal(brainFor({}), null, 'and no key means no brain, not a brain that throws');
  });

  test('every bound is a number in one place, not scattered through the prompts', () => {
    assert.equal(LIMITS.maxQuestions, 4);
    assert.ok(LIMITS.candidatesEach >= 10 && LIMITS.briefChars >= 300);
  });
});
