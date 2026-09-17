/**
 * The fences, not the renderer.
 *
 * HTMLRewriter is a Workers runtime global and does not exist in `node
 * --test`, so this file deliberately does NOT try to prove the rewriting
 * works — it proves the decisions the rewriting is made of: what never gets
 * translated, what a language URL looks like, and that the price a page
 * shows is the price the checkout will charge.
 *
 * The rule the money tests encode: worker/planprice.mjs is the ONLY source
 * of a plan price. A page, a Checkout Session and a webhook that disagree by
 * one currency is a refunded customer, so they are asserted together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTranslatable, langHref, headLinks, switcher, LANGS, KEEP } from './site.mjs';
import { priceFor, formatPrice, currencyForRequest, PRICED_CURRENCIES } from './planprice.mjs';

test('the rate card is never handed to a translation model', () => {
  // Money, in every currency NUM prices in.
  for (const s of ['$9.99', '£19.99', '€50', '฿349', '$2.00 (£1.50 · €2.00 · ฿70)']) {
    assert.equal(isTranslatable(s), false, `${s} must stay verbatim`);
  }
  // Percentages — the commission rates.
  for (const s of ['10% of the bill', '15% on a room', '20% on an activity']) {
    assert.equal(isTranslatable(s), false, `${s} must stay verbatim`);
  }
  // Bare decimals, which m2m100 reformats.
  assert.equal(isTranslatable('9.99'), false);
  // The brand vocabulary.
  for (const w of KEEP) assert.equal(isTranslatable(w), false, `${w} must stay in English`);
  // Ordinary prose still goes through, or the site would ship in English.
  assert.equal(isTranslatable('Text it. It is booked.'), true);
  assert.equal(isTranslatable('Free to list. Pay when a booking happens.'), true);
  // Whitespace and punctuation carry nothing to translate.
  assert.equal(isTranslatable('   '), false);
  assert.equal(isTranslatable('—'), false);
});

test('a language lives on a path Google can index, and Arabic is right-to-left', () => {
  assert.equal(langHref('/business/pricing/', 'en'), '/business/pricing/');
  assert.equal(langHref('/business/pricing/', 'th'), '/th/business/pricing/');
  assert.equal(LANGS.ar.dir, 'rtl');
  for (const [code, meta] of Object.entries(LANGS)) {
    assert.ok(meta.name, `${code} needs a name in its own script`);
    assert.ok(meta.dir === 'ltr' || meta.dir === 'rtl');
  }
  const head = headLinks('/hosts/');
  for (const code of Object.keys(LANGS)) assert.match(head, new RegExp(`hreflang="${code}"`));
  assert.match(head, /hreflang="x-default"/);
  // The switcher must never be translated, or the language names arrive in
  // the language you are trying to leave.
  assert.match(switcher('/hosts/', 'th'), /translate="no"/);
  assert.match(switcher('/hosts/', 'th'), /value="\/th\/hosts\/" selected/);
});

test('the price a page shows is the price the checkout charges, in every currency', () => {
  for (const cur of PRICED_CURRENCIES) {
    for (const tier of ['small', 'pro', 'full']) {
      for (const kind of ['biz', 'host']) {
        const cents = priceFor(kind, tier, cur);
        assert.ok(Number.isInteger(cents) && cents > 0, `${kind}/${tier}/${cur} needs a whole-minor-unit price`);
      }
    }
  }
  // The numbers the pages and the rate card state.
  assert.equal(formatPrice(priceFor('biz', 'small', 'USD'), 'USD'), '$9.99');
  assert.equal(formatPrice(priceFor('host', 'pro', 'GBP'), 'GBP'), '£19.99');
  assert.equal(formatPrice(priceFor('biz', 'full', 'EUR'), 'EUR'), '€50');
  assert.equal(formatPrice(priceFor('biz', 'small', 'THB'), 'THB'), '฿349');
  // A chosen baht price, not a converted one: ฿349 is not 999 cents of anything.
  assert.notEqual(priceFor('biz', 'small', 'THB'), priceFor('biz', 'small', 'USD'));
  // The free tier is not purchasable, and a typo buys nothing.
  assert.equal(priceFor('biz', 'free', 'USD'), null);
  assert.equal(priceFor('biz', 'gold', 'USD'), null);
  assert.equal(priceFor('nonsense', 'pro', 'USD'), null);
});

test('currency comes from the request, and never from something a caller can set', () => {
  const req = (country) => new Request('https://itsnum.com/business/pricing/', {
    headers: country ? { 'CF-IPCountry': country } : {},
  });
  assert.equal(currencyForRequest(req('TH'), {}), 'THB');
  assert.equal(currencyForRequest(req('GB'), {}), 'GBP');
  assert.equal(currencyForRequest(req('FR'), {}), 'EUR');
  assert.equal(currencyForRequest(req('US'), {}), 'USD');
  // A country NUM does not price falls to USD rather than to nothing.
  assert.equal(currencyForRequest(req('JP'), {}), 'USD');
  assert.equal(currencyForRequest(req(''), {}), 'USD');
  // A query string cannot buy a cheaper plan.
  const forged = new Request('https://itsnum.com/business/pricing/?currency=THB', {
    headers: { 'CF-IPCountry': 'US' },
  });
  assert.equal(currencyForRequest(forged, {}), 'USD');
});
