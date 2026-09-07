/**
 * THE BACKUP BRAIN CAN NOW SHOW A PLACE CARD. IT STILL CANNOT BOOK ONE.
 *
 * From 5 Sep 2026 both Anthropic brains were out of credit for sixty hours.
 * The chain did its job — nobody saw an error — but every recommendation in
 * that window arrived as a paragraph, because `picks` were the one thing the
 * backup lane could not carry, and picks are what hold the link, the map, the
 * phone number and the booking offer. A backup that turns the product into a
 * chatbot is a backup you still have to fix at 4am.
 *
 * These tests pin the two halves of the fix, and the second half matters more
 * than the first: a prose brain may name places, and may NEVER mint a booking.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readHosted, emitsPicks, byId, roster } from './brains.mjs';
import { resolvePicks } from './placelink.mjs';

const SRC = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const wrap = (o) => JSON.stringify(o);

describe('places come through', () => {
  test('a well-formed answer yields the reply and the picks', () => {
    const out = readHosted(wrap({
      reply: 'Three near you — I would start with the first.',
      picks: [
        { id: 'p1', name: 'Nahm', why: 'the tasting menu is the reason to come' },
        { id: 'p2', name: 'Bo.lan', why: 'quieter, and the garden seats are cool' },
      ],
      chips: [{ id: 'book', label: 'Book a table' }],
    }));
    assert.equal(out.reply, 'Three near you — I would start with the first.');
    assert.equal(out.picks.length, 2);
    assert.deepEqual(out.picks[0], { id: 'p1', name: 'Nahm', why: 'the tasting menu is the reason to come' });
    assert.equal(out.chips.length, 1);
  });

  test('a pick with no name is not a pick', () => {
    const out = readHosted(wrap({ reply: 'ok', picks: [{ why: 'lovely' }, { name: '  ' }, { name: 'Real', why: 'x' }] }));
    assert.equal(out.picks.length, 1);
    assert.equal(out.picks[0].name, 'Real');
  });

  test('an id is optional — the name alone still resolves downstream', () => {
    const out = readHosted(wrap({ reply: 'ok', picks: [{ name: 'Nahm' }] }));
    assert.deepEqual(out.picks[0], { name: 'Nahm' });
  });

  test('a wall of picks is trimmed rather than rendered', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Place ${i}`, why: 'x' }));
    assert.equal(readHosted(wrap({ reply: 'ok', picks: many })).picks.length, 5);
  });

  test('no picks at all is null, not an empty array', () => {
    assert.equal(readHosted(wrap({ reply: 'ok' })).picks, null);
    assert.equal(readHosted(wrap({ reply: 'ok', picks: [] })).picks, null);
    assert.equal(readHosted('just prose').picks, null);
  });
});

describe('THE BOUNDARY — what a prose brain may never do', () => {
  test('anything actionable on a pick is thrown away, however confidently sent', () => {
    const out = readHosted(wrap({
      reply: 'ok',
      picks: [{
        id: 'p1', name: 'Nahm', why: 'good',
        // Every one of these is a thing a guest would act on. None of them
        // may come from a model — they come from the verified row.
        link: 'https://not-real.example', phone: '+66 000 000', address: '1 Fake Rd',
        bookable: true, rating: 5, open: true, price: '$$$$', maps: 'https://evil.example',
      }],
    }));
    assert.deepEqual(out.picks[0], { id: 'p1', name: 'Nahm', why: 'good' });
  });

  test('a card is never read, whatever the model returns', () => {
    const out = readHosted(wrap({ reply: 'Booked!', card: { title: 'Nahm', meta: '8pm', tag: 'confirmed' } }));
    assert.equal(out.card, undefined);
    assert.equal(Object.keys(out).sort().join(','), 'chips,picks,reply');
  });

  test('actions are never read either — the booking rail stays shut', () => {
    const out = readHosted(wrap({
      reply: 'Done',
      actions: [{ type: 'request_delivery', payload: '{}' }, { type: 'book', payload: '{}' }],
    }));
    assert.equal(out.actions, undefined);
  });

  test('the prose lane hard-codes card null and actions empty, ignoring the read', () => {
    const at = code.indexOf('const read = wantJson');
    const lane = code.slice(at, code.indexOf('_tried: tried', at));
    assert.match(lane, /card: null/);
    assert.match(lane, /actions: \[\]/);
    assert.match(lane, /picks: read\.picks/);
    assert.doesNotMatch(lane, /card: read\./);
    assert.doesNotMatch(lane, /actions: read\./);
  });

  test('an invented place never reaches a guest — it is dropped at resolve', () => {
    const partners = [{ id: 'p1', name: 'Nahm', website: 'https://nahm.example' }];
    const fromModel = readHosted(wrap({
      reply: 'ok',
      picks: [{ id: 'p1', name: 'Nahm', why: 'real' }, { id: 'zzz', name: 'A Place I Made Up', why: 'invented' }],
    }));
    const resolved = resolvePicks(fromModel.picks, partners);
    assert.equal(resolved.picks.length, 1);
    assert.equal(resolved.picks[0].name, 'Nahm');
    assert.deepEqual(resolved.dropped, ['A Place I Made Up']);
  });
});

describe('a truncated answer is salvaged, not paid for twice', () => {
  test('a cut-off object still yields the reply the model wrote', () => {
    const out = readHosted('{"reply": "Nahm is the one — the tasting menu is why you go", "picks": [{"id":"p1","na');
    assert.equal(out.reply, 'Nahm is the one — the tasting menu is why you go');
    assert.equal(out.picks, null, 'a half-written pick is not a pick');
  });

  test('escapes survive the salvage', () => {
    const out = readHosted('{"reply": "They call it \\"the garden\\".\\nGo early", "picks": [');
    assert.equal(out.reply, 'They call it "the garden".\nGo early');
  });

  test('a truncated object with NO reply yields nothing, so the brain fails honestly', () => {
    // The alternative is showing a guest `{"picks": [{"id"` — which is exactly
    // the class of thing worker/router.mjs exists to stop.
    assert.equal(readHosted('{"picks": [{"id"').reply, '');
    assert.equal(readHosted('{"reply": ""').reply, '');
  });

  test('nothing that starts with a brace ever reaches a guest as prose', () => {
    for (const bad of ['{"picks": [{"id"', '{"reply"', '{ ', '{"reply": "  "']) {
      assert.doesNotMatch(readHosted(bad).reply, /^\s*\{/);
    }
  });
});

describe('the model is told the right thing', () => {
  test('the json contract asks for picks and forbids typing anything actionable', () => {
    assert.match(code, /PLACES GO IN `picks`, NOT IN `reply`/);
    assert.match(code, /No link, no phone number, no address/);
    assert.match(code, /MUST be copied from the verified partners block/);
  });

  test('it cancels the "three short lines" instruction rather than leaving two rules standing', () => {
    assert.match(code, /This REPLACES the "three short lines" instruction below/);
  });

  test('the word json appears in the prompt, which DeepSeek json mode requires', () => {
    const contract = code.slice(code.indexOf('OUTPUT FORMAT'), code.indexOf('OUTPUT FORMAT') + 1800);
    assert.match(contract, /json/);
  });

  test('the json lane gets room for the wrapper AND the picks', () => {
    assert.match(code, /wantJson \? \{ maxTokens: 1100 \}/);
  });
});

describe('what the chain reports about itself', () => {
  test('the hosted lane is now honestly reported as able to show place cards', () => {
    assert.equal(emitsPicks(byId('hosted')), true);
    assert.equal(emitsPicks(byId('jan')), true);
    assert.equal(emitsPicks(byId('claude')), true);
    assert.equal(emitsPicks(byId('haiku')), true);
  });

  test('Workers AI stays on plain prose and says so', () => {
    for (const id of ['gpt-oss-120b', 'llama-4-scout', 'llama-3.3-70b', 'qwen3-30b', 'mistral-small']) {
      assert.equal(emitsPicks(byId(id)), false, id);
    }
  });

  test('/api/brains carries the flag', () => {
    const r = roster({ ANTHROPIC_API_KEY: 'k', NUM_LLM_BASE_URL: 'https://x/v1' });
    assert.equal(r.find((b) => b.id === 'hosted').picks, true);
    assert.equal(r.find((b) => b.id === 'llama-3.3-70b').picks, false);
  });

  test('picks is NOT the same claim as structured — the backup still cannot book', () => {
    assert.equal(byId('hosted').structured, false);
    assert.equal(emitsPicks(byId('hosted')), true);
  });
});
