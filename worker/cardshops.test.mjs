// Finding somewhere to buy trading cards, without sending anyone to a bridal shop.
//
// Every false positive below is REAL — pulled from Num's own 2.69M places on
// 12 Sep 2026 by the naive `LIKE '%card%'` query this classifier replaced. They
// are the test suite because they are what actually happens.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cardConfidence, cardLine, dropInfo, sellsCards } from './cardshops.mjs';

describe('the real false positives', () => {
  test('a bridal shop called Cards4ever is not a card shop', () => {
    assert.equal(cardConfidence({ name: 'Cards4ever', category: 'Bridal Shop' }), null);
  });

  test('a Turkish naval vessel is not a card shop', () => {
    // TCG in Istanbul is Türkiye Cumhuriyeti Gemisi, not Trading Card Game.
    // The strongest name signal we have, on a warship.
    assert.equal(cardConfidence({ name: 'TCG Uluçalireis', category: 'Attraction' }), null);
  });

  test('Pokemon\'s Beer Bar is a bar', () => {
    // It matches the single most specific word in the whole vocabulary.
    assert.equal(cardConfidence({ name: "Pokemon's Beer Bar", category: 'Bar' }), null);
  });

  test('greeting-card shops are not card shops', () => {
    for (const p of [
      { name: 'Cards Galore', category: 'Souvenirs & gifts' },
      { name: 'Carnival Cards & Gifts', category: 'Convenience' },
      { name: 'Big C Graphics Wedding Cards', category: 'Souvenirs & gifts' },
      { name: 'Dundee Street Greeting Cards & Gift Shop', category: 'Souvenirs & gifts' },
      { name: 'Earlybird Cards', category: 'Souvenirs & gifts' },
      { name: 'The Card Shop Ickenham Limited', category: 'Convenience' },
    ]) {
      assert.equal(cardConfidence(p), null, `${p.name} was offered as a card shop`);
    }
  });

  test('the exclusion runs BEFORE the name signal, not after', () => {
    // The ordering is the whole defence. A place whose name contains the
    // strongest possible signal must still be refused on its category.
    assert.equal(cardConfidence({ name: 'Pokemon Trading Card Gift Shop', category: 'Souvenirs & gifts' }), null);
    assert.equal(cardConfidence({ name: 'TCG Wedding Stationery', category: 'Hobby Shop' }), null);
  });
});

describe('the real shops', () => {
  test('Bath TCG is certain', () => {
    assert.equal(cardConfidence({ name: 'Bath TCG', category: 'Hobby Shop' }), 'certain');
  });

  test('Legacy Comics and Cards is found even filed under Shopping', () => {
    // Filed as 'Shopping' in Overture. A category-only classifier loses it, and
    // it is exactly the kind of shop a member is asking for.
    assert.equal(cardConfidence({ name: 'Legacy Comics and Cards', category: 'Shopping' }), 'maybe');
  });

  test('a plain hobby or comic shop is likely, not certain', () => {
    // 2,319 of these. They almost all carry cards, and "almost all" is not
    // "certainly", so the sentence Num says has to differ.
    assert.equal(cardConfidence({ name: 'Orcs Nest', category: 'Hobby Shop' }), 'likely');
    assert.equal(cardConfidence({ name: 'Forbidden Planet', category: 'Comic Books Store' }), 'likely');
    assert.equal(cardConfidence({ name: 'Meeple Madness', category: 'Tabletop Games' }), 'likely');
  });

  test('a toy shop with no card signal is just a toy shop', () => {
    // The tempting bulk. 4,005 toy stores would quadruple the dataset and make
    // most answers wrong.
    assert.equal(cardConfidence({ name: 'Hamleys', category: 'Toy Store' }), null);
    assert.equal(sellsCards({ name: 'Hamleys', category: 'Toy Store' }), false);
  });

  test('a toy shop that SAYS it sells cards is kept', () => {
    assert.equal(cardConfidence({ name: 'Sunshine Toys & TCG', category: 'Toy Store' }), 'likely');
  });
});

describe('what Num actually says', () => {
  test('confidence changes the sentence, because it changes the journey', () => {
    assert.match(cardLine({ name: 'Bath TCG', category: 'Hobby Shop' }), /a card shop\./);
    assert.match(cardLine({ name: 'Orcs Nest', category: 'Hobby Shop' }), /very likely/);
    assert.match(cardLine({ name: 'Legacy Comics and Cards', category: 'Shopping' }), /call first/);
  });

  test('a place we would not offer gets no sentence at all', () => {
    assert.equal(cardLine({ name: 'Cards4ever', category: 'Bridal Shop' }), null);
    assert.equal(cardLine({}), null);
  });

  test('rubbish in is null, not a crash', () => {
    for (const p of [null, undefined, {}, { name: '' }, { name: null, category: null }]) {
      assert.equal(cardConfidence(p ?? {}), null);
    }
  });
});

describe('what we refuse to invent', () => {
  test('drop nights are NOT claimed, because we do not have them', () => {
    // Dre asked for "where they do the drops". Set release dates are public;
    // which shop runs a prerelease or gets an allocation lives in that shop's
    // head and nowhere else. A plausible-looking guess here is the bridal shop
    // failure again, one step further from anything checkable.
    const d = dropInfo();
    assert.equal(d.known, false);
    assert.match(d.why, /Ask the shop/);
  });

  test('there is no drops field on a place', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./cardshops.mjs', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    assert.doesNotMatch(code, /drop_night|dropDay|release_night/,
      'per-shop drop data has appeared without a source for it');
  });
});
