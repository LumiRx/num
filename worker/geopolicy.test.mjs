import test from 'node:test';
import assert from 'node:assert/strict';
import { policyFor, policyBrief, screen, substituteFor, POLICIES } from './geopolicy.mjs';

const AE = policyFor('AE');
const SA = policyFor('SA');

test('a country with no policy gets silence, not an empty policy', () => {
  for (const cc of ['GB', 'US', 'TH', 'FR', '', null, undefined]) {
    assert.equal(policyFor(cc), null, String(cc));
    assert.equal(policyBrief(policyFor(cc)), '');
  }
});

// ── THE TWO COUNTRIES ARE NOT ONE ────────────────────────────────────────
//
// Alcohol is legal in licensed UAE venues and naming one is ordinary — Time
// Out Dubai does it weekly. Applying Saudi's rule to Dubai would delete most
// of what makes Num useful there.
test('naming a bar is fine in the UAE and forbidden in Saudi', () => {
  const line = 'For a rooftop I would go to Zuma — the terrace is the good half and the cocktails are excellent.';
  assert.equal(screen(line, AE).ok, true, 'the UAE permits this');
  const bad = screen(line, SA);
  assert.equal(bad.ok, false);
  assert.equal(bad.rule, 'alcohol');
});

test('both countries block LGBTQ venues and gambling', () => {
  for (const p of [AE, SA]) {
    assert.equal(screen('There is a gay bar on the strip I would check out.', p).ok, false);
    assert.equal(screen('I would try the casino at the resort — worth a visit.', p).ok, false);
  }
});

test('Saudi additionally blocks pork', () => {
  const line = 'I would go for the pork belly, it is the best thing on the menu.';
  assert.equal(screen(line, SA).ok, false);
  assert.equal(screen(line, AE).ok, true, 'pork is sold openly in the UAE');
});

// ── ANSWERING IS NOT RECOMMENDING ────────────────────────────────────────
//
// A traveller who asks an honest question and gets a wall is not being
// protected, they are being failed — and they will go and ask something less
// careful instead. The whole filter turns on this distinction.
test('an honest answer about the law is never blocked', () => {
  for (const line of [
    'Alcohol is illegal in the Kingdom, so there is nowhere I can send you for a drink.',
    'You cannot buy alcohol here — I would rather tell you straight.',
    'Gambling is not legal here, so there is nothing for me to point you at.',
    'I am not able to recommend a bar in Riyadh; it is prohibited.',
    'Pork is not available here, so avoid the imported charcuterie question entirely.',
  ]) assert.equal(screen(line, SA).ok, true, `refusal wrongly blocked: ${line}`);
});

test('a refusal that also names the thing is still a refusal', () => {
  // This sentence contains "bar", "recommend" AND the country. The old naive
  // shape would flag the exact behaviour we asked the model for.
  const line = 'I cannot recommend a bar here because alcohol is illegal in Saudi Arabia.';
  assert.equal(screen(line, SA).ok, true);
});

// ── FALSE POSITIVES ARE THEIR OWN HARM ───────────────────────────────────
test('alcohol-free and dry never trip the filter', () => {
  for (const line of [
    'The rooftop does an excellent alcohol-free cocktail list — I would go for the tamarind one.',
    'It is a dry venue, which suits the group.',
    'They do non-alcoholic pairings and they are genuinely good; book the counter.',
  ]) assert.equal(screen(line, SA).ok, true, `false positive: ${line}`);
});

test('ordinary Gulf answers are untouched', () => {
  for (const line of [
    'I would go to Al Hadheerah for the desert setting — book the early sitting.',
    'Riyadh Season is on; the concert programme is worth a look.',
    'For coffee, head to Camel Step. Best flat white in the city.',
    'The souq is better at dusk. Take the abra across, it costs a dirham.',
    'Book the 8pm at Orfali Bros — it is the one table worth planning around.',
  ]) {
    assert.equal(screen(line, SA).ok, true, `SA false positive: ${line}`);
    assert.equal(screen(line, AE).ok, true, `AE false positive: ${line}`);
  }
});

// A reply can refuse in one sentence and recommend in the next. Screening the
// whole blob would let the refusal launder the recommendation.
test('a refusal earlier in the reply does not launder a later recommendation', () => {
  const reply = 'Alcohol is illegal in the Kingdom, so I cannot help there. '
    + 'That said, I would head to the speakeasy behind the souq for cocktails.';
  const r = screen(reply, SA);
  assert.equal(r.ok, false, 'the second sentence must still be caught');
  assert.equal(r.rule, 'alcohol');
  assert.match(r.sentence, /speakeasy/);
});

test('a mention with no sending verb is discussion, not a recommendation', () => {
  assert.equal(screen('The hotel has a bar on the top floor.', SA).ok, true);
  assert.equal(screen('Some resorts have casinos elsewhere in the region.', SA).ok, true);
});

test('the flagged sentence is returned, so a human can see what tripped', () => {
  const r = screen('Sure — I would go to the sports bar on Tahlia for the match.', SA);
  assert.equal(r.ok, false);
  assert.match(r.sentence, /sports bar/);
  assert.ok(r.sentence.length <= 160);
});

// ── THE BRIEF ────────────────────────────────────────────────────────────
test('the UAE brief permits alcohol and still forbids the two criminal topics', () => {
  const b = policyBrief(AE);
  assert.match(b, /Alcohol is legal in licensed venues/i);
  assert.match(b, /LGBTQ/i);
  assert.match(b, /gambling/i);
  assert.ok(!AE.block.includes('alcohol'), 'blocking alcohol would delete most of Dubai');
});

test('the Saudi brief carries the two things that get people in real trouble', () => {
  const b = policyBrief(SA);
  assert.match(b, /RAMADAN IS NOT ETIQUETTE HERE/);
  assert.match(b, /non-Muslims are legally barred/i);
  assert.match(b, /Riyadh Season|concerts/i, 'it must also say what IS a good answer');
});

test('both briefs tell the model to answer a direct legal question honestly', () => {
  assert.match(policyBrief(AE), /answer honestly/i);
  assert.match(policyBrief(SA), /honest and useful/i);
});

// ── THE SUBSTITUTE ───────────────────────────────────────────────────────
//
// A bare refusal is a failure with better manners. The traveller asked a real
// question; they get the true reason and somewhere else to go.
test('every substitute gives a reason and an onward offer', () => {
  for (const rule of ['alcohol', 'lgbtq_venue', 'gambling', 'pork']) {
    const s = substituteFor(rule);
    assert.ok(s.length > 80, `${rule} substitute is too thin`);
    assert.match(s, /\?/, `${rule} must offer something next`);
  }
  assert.ok(substituteFor('unknown-rule').length > 30, 'an unknown rule still answers');
});

test('every blocked rule has a substitute — a gate with no exit is a dead end', () => {
  for (const p of Object.values(POLICIES)) {
    for (const rule of p.block) {
      assert.notEqual(substituteFor(rule), undefined, `${p.country}/${rule}`);
    }
  }
});

test('nothing throws on empty or odd input', () => {
  assert.equal(screen('', SA).ok, true);
  assert.equal(screen(null, SA).ok, true);
  assert.equal(screen('anything', null).ok, true);
});

// ── IS THE GATE ACTUALLY ON THE PATH? ────────────────────────────────────
//
// Four rails shipped in this session with passing unit tests and could not
// fire in production, because nothing checked they were wired in. A content
// filter that exists but never runs is worse than none: it is the reason
// nobody looks again.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.mjs'), 'utf8');

test('the brief is pushed into the prompt before generation', () => {
  assert.match(SRC, /policyBrief\(policyFor\(grounding\?\.place\?\.country_code\)\)/,
    'the geo brief is no longer built from the place');
  assert.match(SRC, /system\.push\(\{ type: 'text', text: geo \}\)/,
    'the geo brief is built but never added to the prompt');
});

test('the screen runs after generation and substitutes on a hit', () => {
  assert.match(SRC, /screenReply\(reply\.reply, policy\)/, 'the reply is no longer screened');
  assert.match(SRC, /reply: substituteFor\(verdict\.rule\)/, 'a blocked reply must be replaced, not passed through');
});

// The card and actions were produced by the same turn that produced the
// blocked sentence. Passing them through would send the traveller to the
// venue the text was stopped from naming.
test('a blocked turn drops its card and actions too', () => {
  const i = SRC.indexOf('reply: substituteFor(verdict.rule)');
  assert.ok(i > 0);
  const block = SRC.slice(i, i + 400);
  assert.match(block, /card: null/, 'the card survives a block — it points at the same place');
  assert.match(block, /actions: \[\]/, 'the actions survive a block');
});

test('the brief sits after the specialist brief, which is the one that would recommend a bar', () => {
  assert.ok(SRC.indexOf('specialistBrief(specialist)') < SRC.indexOf('const geo = policyBrief'),
    'the geo policy must come after the specialist, or the specialist wins');
});
