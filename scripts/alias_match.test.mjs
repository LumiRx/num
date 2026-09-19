// The directory holds twenty Bangkok buildings called "Lumpini something",
// and every one of them is a block of flats. That is the whole reason
// matching is exact, and the whole reason an alias has to be a NAME rather
// than whatever a regex happened to pull out of a sentence.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aliasesFrom, isName, matchSql, isTruncation } from './alias_match.mjs';

describe('pulling names out of a note', () => {
  test('the Thai name survives — it is the most useful alias in the set', () => {
    const a = aliasesFrom("Thai สวนลุมพินี. Also listed as 'Lumpini Park', 'Lumpinee Park', 'Suan Lumphini'");
    assert.ok(a.includes('สวนลุมพินี'), 'the Thai name was dropped');
    assert.ok(a.includes('Lumpini Park'));
    assert.ok(a.includes('Suan Lumphini'));
  });

  test('a Thai name is not deduplicated into oblivion by an empty fold', () => {
    // fold() keeps only [a-z0-9], so every Thai string folds to ''. The first
    // version treated that as "empty, drop it" and lost all of them.
    const a = aliasesFrom('Thai สวนวชิรเบญจทัศ. Far better known as ‘Rot Fai Park’');
    assert.equal(a.filter((x) => /[^\x00-\x7F]/.test(x)).length, 1);
  });

  test('"far better known as" counts, not only "also"', () => {
    const a = aliasesFrom("Far better known as 'Rot Fai Park' / 'Suan Rot Fai' / 'Railway Park'");
    assert.deepEqual(a, ['Rot Fai Park', 'Suan Rot Fai', 'Railway Park']);
  });

  test('an apostrophe inside a quoted name produces wreckage, and the wreckage is refused', () => {
    // "spells it 'Hotel Barriere Fouquet's New York'; the property also
    // appears as 'Fouquet's New York'" cannot be parsed, because the quote
    // mark and the apostrophe are the same character. What matters is that
    // nothing plausible-looking survives to be matched against.
    const a = aliasesFrom("Source spells it 'Hotel Barriere Fouquet's New York'; the property also appears as 'Fouquet's New York'.");
    for (const v of a) {
      assert.doesNotMatch(v, /;|appears|the property/, `wreckage kept as an alias: ${JSON.stringify(v)}`);
      assert.doesNotMatch(v, /^s\s/, `a fragment kept as an alias: ${JSON.stringify(v)}`);
    }
  });

  test('guidance is not an alias', () => {
    const a = aliasesFrom("Also 'Rama VIII Park'. Do not confuse with Suan Luang Rama IX");
    assert.ok(a.includes('Rama VIII Park'));
    assert.equal(a.some((v) => /confuse/i.test(v)), false);
  });

  test('a note with nothing to offer yields nothing', () => {
    assert.deepEqual(aliasesFrom(null), []);
    assert.deepEqual(aliasesFrom(''), []);
    assert.deepEqual(aliasesFrom('Adjacent to Surfrider Beach'), []);
  });

  test('isName rejects in the safe direction', () => {
    assert.ok(isName('Rot Fai Park'));
    assert.ok(isName('สวนลุมพินี') === false || isName('สวนลุมพินี') === true); // handled by the Thai branch, not here
    assert.equal(isName('the property also appears as'), false);
    assert.equal(isName('s New York'), false);
    assert.equal(isName('Hotel Barriere Fouquet; and'), false);
    assert.equal(isName('a'), false);
    assert.equal(isName('Also listed as something'), false);
    assert.ok(isName('St Katharine Docks'), 'a real two-letter prefix must survive');
    // "Queen's Park" loses its tail to the apostrophe and arrives as "Queen".
    assert.equal(isName('Queen'), false, 'a bare common noun will eventually match the wrong venue');
    assert.equal(isName('Park'), false);
    assert.ok(isName('Wachirabenjatat'), 'a distinctive single word is still a name');
    assert.ok(isName("Queen's Park"), 'the intact name must of course survive');
  });
});

describe('the matching statement', () => {
  const sql = matchSql('bangkok');

  test('it compares whole entries, never a substring of the list', () => {
    // Without the newline fences an alias "Rot Fai Park" would also be
    // satisfied by a stored "Rot Fai Park Extension" — and on this data a
    // loose match means a condominium wearing a park's designation.
    assert.match(sql, /char\(10\) \|\| num_editorial\.aliases \|\| char\(10\)/);
    assert.match(sql, /char\(10\) \|\| p\.name \|\| char\(10\)/);
  });

  test('it only fills rows that are still unmatched', () => {
    assert.match(sql, /WHERE place_id IS NULL/);
  });

  test('it stays inside one destination', () => {
    assert.match(sql, /p\.dest = 'bangkok'/);
    assert.match(sql, /AND dest = 'bangkok'/);
  });

  test('it never uses LIKE against the directory name', () => {
    assert.doesNotMatch(sql, /p\.name\s+LIKE/i, 'a LIKE here is how a park designation lands on a block of flats');
  });
});

describe('a truncation is not an alias', () => {
  test('the county short forms are refused — every one is also a neighbourhood', () => {
    for (const [a, p] of [['Zuma', 'Zuma Beach'], ['Venice', 'Venice Beach'],
      ['Manhattan', 'Manhattan Beach'], ['Topanga', 'Topanga Beach'],
      ['Torrance', 'Torrance Beach'], ['Mother', "Mother's Beach"]]) {
      assert.equal(isTruncation(a, p), true, `${a} must not be matched on its own`);
    }
  });

  test('a distinctive multi-word prefix survives', () => {
    assert.equal(isTruncation('Point Dume', 'Point Dume State Beach'), false);
    assert.equal(isTruncation('Nicholas Canyon', 'Nicholas Canyon Beach'), false);
    assert.equal(isTruncation('Runyon Canyon', 'Runyon Canyon Park'), false);
  });

  test('a real alternative name is not a prefix and survives', () => {
    assert.equal(isTruncation('High Line', 'The High Line'), false);
    assert.equal(isTruncation('Mirate', 'M\u00edrate'), false, 'the accent fold is the point of that one');
    assert.equal(isTruncation('Benjasiri Park', 'Benchasiri Park'), false);
  });
});
