import test from 'node:test';
import assert from 'node:assert/strict';
import { localName, isRightScript, LANGS } from './localname.ingest.mjs';

// THE PRODUCTION BUG, AS A TEST.
//
// The old selector took the first `name:*` key that was not `name:en`, and
// object key order is whatever order the OSM contributor used. Measured across
// the seven UAE destinations on 30 Aug 2026: 735 name_local values, only 508
// Arabic — 42 Cyrillic, 15 CJK, 170 Latin. A Russian name handed to a Dubai
// taxi driver is worse than no name, because it looks like help.
test('a Dubai venue tagged in Russian first still yields the Arabic name', () => {
  const tags = { name: 'Zuma', 'name:ru': 'Зума', 'name:ar': 'زوما', 'name:en': 'Zuma' };
  assert.equal(localName(tags, 'AE', 'Zuma'), 'زوما');
});

test('a wrong-language name is discarded, not stored', () => {
  // Only Russian on the tag. There is no Arabic to find, so the honest answer
  // is nothing at all.
  assert.equal(localName({ name: 'Zuma', 'name:ru': 'Зума' }, 'AE', 'Zuma'), null);
  assert.equal(localName({ name: 'Zuma', 'name:zh': '祖玛' }, 'AE', 'Zuma'), null);
  assert.equal(localName({ name: 'Zuma', 'name:de': 'Zuma Restaurant' }, 'AE', 'Zuma'), null);
});

// A `name:ar` holding a Latin transliteration is common in OSM and is not the
// sign. Trusting the tag key alone would print "Al Hadheerah" as the Arabic.
test('a mislabelled tag is caught by checking the script, not the key', () => {
  assert.equal(localName({ name: 'Al Hadheerah', 'name:ar': 'Al Hadheerah Restaurant' }, 'AE', 'Al Hadheerah'), null);
  assert.equal(localName({ name: 'Nobu', 'name:th': 'Nobu Bangkok' }, 'TH', 'Nobu'), null);
});

test('the local name is never just the primary name again', () => {
  assert.equal(localName({ name: 'مطعم', 'name:ar': 'مطعم' }, 'AE', 'مطعم'), null);
});

// A Latin-script market has no second name to give. Storing "Le Bristol" as
// the local name of Le Bristol is noise the concierge would then print.
test('Latin-script destinations get no local name at all', () => {
  for (const cc of ['GB', 'US', 'FR', 'ES', 'IT', 'DE', 'AU', 'BR']) {
    assert.equal(LANGS[cc], undefined, `${cc} must not be in the language map`);
    assert.equal(localName({ name: 'X', 'name:fr': 'Le X' }, cc, 'X'), null);
  }
});

test('the markets NUM actually serves are covered', () => {
  for (const [cc, lang] of [['AE', 'ar'], ['SA', 'ar'], ['QA', 'ar'], ['TH', 'th'], ['JP', 'ja'], ['CN', 'zh']]) {
    assert.ok(LANGS[cc]?.includes(lang), `${cc} should read ${lang}`);
  }
});

test('Thai still works — this must not regress the market we run on', () => {
  assert.equal(localName({ name: 'Raya', 'name:th': 'ร้านระย้า', 'name:zh': '拉亚' }, 'TH', 'Raya'), 'ร้านระย้า');
});

// When the English name arrived through name:en, the bare `name` is often the
// sign itself. That is exactly the value we want and the old code skipped it.
test('a bare name already in the local script is used', () => {
  assert.equal(localName({ name: 'مقهى الرمال', 'name:en': 'Sands Cafe' }, 'AE', 'Sands Cafe'), 'مقهى الرمال');
  assert.equal(localName({ 'int_name': 'مطعم البحر', name: 'Sea Restaurant', 'name:en': 'Sea Restaurant' }, 'AE', 'Sea Restaurant'), 'مطعم البحر');
});

test('missing or malformed tags never throw', () => {
  assert.equal(localName(null, 'AE', 'X'), null);
  assert.equal(localName({}, 'AE', 'X'), null);
  assert.equal(localName({ 'name:ar': 123 }, 'AE', 'X'), null);
  assert.equal(localName({ 'name:ar': '  ' }, 'AE', 'X'), null);
  assert.equal(localName({ 'name:ar': 'زوما' }, null, 'X'), null);
});

test('isRightScript is the cleanup predicate for rows already stored', () => {
  assert.equal(isRightScript('زوما', 'AE'), true);
  assert.equal(isRightScript('Зума', 'AE'), false, 'the 42 Cyrillic rows must fail this');
  assert.equal(isRightScript('祖玛', 'AE'), false, 'the 15 CJK rows must fail this');
  assert.equal(isRightScript('Zuma', 'AE'), false, 'the 170 Latin rows must fail this');
  assert.equal(isRightScript('ร้านระย้า', 'TH'), true);
  assert.equal(isRightScript('Raya', 'TH'), false);
  assert.equal(isRightScript('anything', 'GB'), false, 'Latin markets hold no local name');
});
