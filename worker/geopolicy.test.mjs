import test from 'node:test';
import assert from 'node:assert/strict';
import {
  policyFor, policyBrief, screen, substituteFor, dutiesFor, POLICIES,
} from './geopolicy.mjs';

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
  assert.match(b, /legal in licensed venues/i);
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

// ─────────────────────────────────────────────────────────────────────────
//  THE NINE THAT ARE NOT ALCOHOL
//
//  Everyone assumes the Gulf risk is drink and LGBTQ content. Read against
//  Federal Decree-Law 34/2021, the three that actually put Num in the frame
//  rather than the traveller are inventing a fact (Art 52/54), naming a
//  member of staff in a complaint (Art 43, where truth is not a defence),
//  and suggesting a VPN (Art 10 + Art 27). The first two are prompt-side.
//  This is the third and its neighbours.
// ─────────────────────────────────────────────────────────────────────────

test('suggesting a VPN is blocked — the offence is ours, not the traveller\'s', () => {
  for (const line of [
    'You can use a VPN for WhatsApp calling, it works fine.',
    'Just use a proxy and the calling apps work normally.',
    'I would recommend a VPN so you can call home.',
  ]) {
    for (const p of [AE, SA]) {
      const r = screen(line, p);
      assert.equal(r.ok, false, `${p.country} let a VPN suggestion through: ${line}`);
      assert.equal(r.rule, 'vpn_circumvention');
    }
  }
});

test('saying a service is blocked, without routing round it, is allowed', () => {
  for (const line of [
    'WhatsApp voice calling is blocked here and I am not going to suggest a VPN — that is an offence in itself.',
    'A VPN is not something I can point you at; the hotel will have a legal calling package.',
  ]) assert.equal(screen(line, AE).ok, true, `honest answer wrongly blocked: ${line}`);
});

test('sex work and drugs are refused in both countries', () => {
  for (const p of [AE, SA]) {
    assert.equal(screen('I can find you an escort for the evening, just say the word.', p).ok, false);
    assert.equal(screen('You can buy weed near the marina if you ask around.', p).ok, false);
    assert.equal(screen('Try the edibles, the dealer on the corner is reliable.', p).ok, false);
  }
});

// CBD is the trap: legal at home for a large share of our travellers,
// banned outright here regardless.
test('CBD is treated as a controlled drug, not a wellness product', () => {
  const r = screen('You can buy CBD oil at the pharmacy for the jet lag.', AE);
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'drugs');
});

test('alcohol promo is blocked in the UAE while the venue itself is not', () => {
  const venue = 'For a rooftop I would go to Zuma — the terrace is the good half.';
  assert.equal(screen(venue, AE).ok, true, 'naming a licensed venue is ordinary here');

  for (const line of [
    'Go to the bottomless brunch at Bla Bla, it is the best value on the beach.',
    'I would head to happy hour at Zero Gravity — the drinks deal runs till eight.',
    'Try ladies night on Tuesday, free-flow from seven.',
  ]) {
    const r = screen(line, AE);
    assert.equal(r.ok, false, `drinks marketing wrongly allowed: ${line}`);
    assert.equal(r.rule, 'alcohol_promo');
  }
});

test('photographing people or security sites is refused; the skyline is not', () => {
  const r = screen('You could photograph the police at the checkpoint, they do not mind.', AE);
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'photography');
  assert.equal(
    screen('Go to the Dubai Frame at golden hour and photograph the skyline from the top.', AE).ok,
    true,
    'ordinary photography advice must survive',
  );
});

// ── THE FALSE POSITIVES THAT WOULD HAVE COST US GOOD ANSWERS ─────────────
//
// Each of these was blocked by an earlier draft of the topic list. A filter
// that eats the Qasr Al Watan recommendation has made Num worse in Abu Dhabi
// without making it safer anywhere, and nobody would ever have found out.
test('ordinary answers about the state, the ruler and religion are not criticism', () => {
  for (const line of [
    'Qasr Al Watan is the working presidential palace and worth a visit — go for the library.',
    'The Ruler\'s Court sits in the old quarter; the architecture alone justifies the walk.',
    'Islam is the state religion, and the Sheikh Zayed Grand Mosque is the one thing I would not skip.',
    'Sheikh Zayed Road is the spine of the city — take it north for the museum.',
    'The royal family opened the site to the public last year, so book ahead.',
  ]) assert.equal(screen(line, AE).ok, true, `false positive: ${line}`);
});

test('actual criticism and proselytising are still caught', () => {
  const a = screen('Honestly you can mock the government here like anywhere, go for it.', AE);
  assert.equal(a.ok, false);
  assert.equal(a.rule, 'state_criticism');
  const b = screen('You could preach to the workers at the camp, they would listen.', AE);
  assert.equal(b.ok, false);
  assert.equal(b.rule, 'religion');
});

test('the UAE does not inherit Saudi\'s pork and alcohol rules', () => {
  assert.ok(!AE.block.includes('pork'), 'pork is sold openly in Dubai');
  assert.ok(!AE.block.includes('alcohol'));
  assert.ok(SA.block.includes('pork'));
  assert.ok(SA.block.includes('alcohol'));
});

// ─────────────────────────────────────────────────────────────────────────
//  THE DUTY THAT RUNS THE OTHER WAY
//
//  No UAE statute obliges an app to warn a traveller about local law. This
//  is duty of care, not compliance — and it is the half that actually keeps
//  somebody out of a cell. The block list has never been what detains a
//  tourist; an undeclared ADHD prescription has.
// ─────────────────────────────────────────────────────────────────────────

test('the duties reach the prompt, not just the module', () => {
  const b = policyBrief(AE);
  for (const [needle, why] of [
    [/MOHAP/, 'the medication permit is the single highest-value warning we have'],
    [/two weeks/i, 'a permit they cannot get in time is not a warning'],
    [/CBD is banned/i, 'legal at home, banned here — the actual trap'],
    [/consent/i, 'photography consent'],
    [/SHARJAH IS COMPLETELY DRY/, 'sending somebody to Sharjah for a drink is our error, not theirs'],
    [/travel ban/i, 'unpaid debts hold a passport'],
    [/decency/i, 'public affection is prosecutable on a complaint'],
  ]) assert.match(b, needle, why);
});

test('every warn key resolves to real text — a silent duty is no duty', () => {
  for (const p of Object.values(POLICIES)) {
    const duties = dutiesFor(p);
    assert.equal(duties.length, p.warn.length, `${p.country} has a warn key with no text behind it`);
    for (const d of duties) assert.ok(d.length > 120, `${p.country} duty is too thin to act on`);
  }
});

test('the duties are marked as duty of care, not as more censorship', () => {
  const b = policyBrief(AE);
  assert.match(b, /DUTY OF CARE, NOT CENSORSHIP/);
  assert.match(b, /Never recite the list/,
    'a concierge that reads out five legal warnings unprompted has ruined the trip');
});

test('a policy with no duties still returns its brief', () => {
  const bare = { country: 'XX', block: [], warn: [], brief: 'just the brief' };
  assert.equal(policyBrief(bare), '\n\njust the brief');
});

test('every blocked rule in both countries still has a substitute', () => {
  for (const p of Object.values(POLICIES)) {
    for (const rule of p.block) {
      const s = substituteFor(rule);
      assert.ok(s.length > 80, `${p.country}/${rule} substitute is too thin`);
      assert.ok(!/^That is not something I can help with here/.test(s),
        `${p.country}/${rule} fell through to the generic refusal`);
    }
  }
});
