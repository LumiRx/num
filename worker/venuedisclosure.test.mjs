// A venue that has to say something about itself before a guest arrives.
//
// Aroyo signed up on 7 Sep — a clothing-optional resort. Dre: "since theyre
// clothing optional we need to make sure its within the interest of the user
// first." The delivery age gate is the wrong shape for this: "never volunteer"
// is right for a licensed cannabis retailer and too blunt for a resort, which
// IS a good answer to "where should we stay near the hot springs" — as long as
// the guest is not finding out when they walk in.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  DISCLOSURES, ageFloor, allowedFor, annotate, disclosureBlock, disclosuresOf,
  familyAsk, needsVerified,
} from './venuedisclosure.mjs';

const CO = DISCLOSURES.clothing_optional;
const aroyo = (extra = {}) => ({ id: 'p_aroyo', name: 'Aroyo', disclosures: [CO], ...extra });
const plain = { id: 'p_inn', name: 'The Inn', disclosures: [] };
const verified = { member: { identity_verified: 1 } };

describe('reading what a business declared', () => {
  test('only what the business itself put there', () => {
    assert.deepEqual(disclosuresOf({ disclosures: ['clothing_optional'] }), [CO]);
    assert.deepEqual(disclosuresOf('{"disclosures":["clothing_optional"]}'), [CO]);
  });

  test('a category or a name never becomes a disclosure', () => {
    // Labelling a venue this way when they did not is a libel; failing to when
    // they did is a guest walking into a surprise. Only their own word counts.
    assert.deepEqual(disclosuresOf({ category: 'Nudist Resort', name: 'Naturist Springs' }), []);
    assert.deepEqual(disclosuresOf(null), []);
    assert.deepEqual(disclosuresOf('not json at all'), []);
  });

  test('a disclosure we do not recognise is dropped, not passed through', () => {
    assert.deepEqual(disclosuresOf({ disclosures: ['clothing_optional', 'made_up'] }), [CO]);
  });

  test('the strictest age of several wins', () => {
    assert.equal(ageFloor([DISCLOSURES.members_only, DISCLOSURES.twentyone_plus]), 21);
    assert.equal(ageFloor([DISCLOSURES.members_only]), 0);
    assert.equal(ageFloor([]), 0);
    assert.equal(needsVerified([DISCLOSURES.members_only]), false);
    assert.equal(needsVerified([CO]), true);
  });
});

describe('who may be shown one', () => {
  test('a verified guest asking an adjacent question gets it', () => {
    // The whole point of choosing disclosure over silence: it is allowed to be
    // the answer to "somewhere to stay near the hot springs".
    assert.deepEqual(
      allowedFor([aroyo(), plain], { ...verified, userText: 'somewhere to stay near the hot springs' })
        .map((v) => v.name),
      ['Aroyo', 'The Inn'],
    );
  });

  test('an unverified guest does not, and neither does one we know nothing about', () => {
    const ask = 'a resort for the weekend';
    assert.deepEqual(allowedFor([aroyo(), plain], { member: { identity_verified: 0 }, userText: ask })
      .map((v) => v.name), ['The Inn']);
    assert.deepEqual(allowedFor([aroyo(), plain], { member: null, userText: ask })
      .map((v) => v.name), ['The Inn']);
    assert.deepEqual(allowedFor([aroyo(), plain], { userText: ask }).map((v) => v.name), ['The Inn']);
  });

  test('a family ask returns nothing at all, however well it matches', () => {
    // Reading the disclosure out first does not repair this suggestion. It
    // should not be made.
    for (const ask of [
      'somewhere to stay with the kids',
      'a resort for me and my family',
      'weekend away, two adults and a toddler',
      'family-friendly place near the springs',
      'somewhere my daughter would like',
    ]) {
      assert.deepEqual(allowedFor([aroyo()], { ...verified, userText: ask }), [],
        `a clothing-optional resort was offered for: ${ask}`);
      assert.equal(familyAsk(ask), true);
    }
  });

  test('a family ask suppresses the whole block, not just the flagged venue', () => {
    // Half-answering "somewhere for us and the kids" with the ordinary hotels
    // is correct; the caller falls back to normal ranking. What must not
    // happen is the flagged one surviving because the others were filtered.
    assert.deepEqual(allowedFor([aroyo(), plain], { ...verified, userText: 'trip with the kids' }), []);
  });

  test('an ordinary adult ask is not mistaken for a family one', () => {
    assert.equal(familyAsk('a quiet weekend for two'), false);
    assert.equal(familyAsk('somewhere with a kitchen'), false);
    assert.equal(familyAsk(''), false);
  });

  test('a venue with no disclosures is never gated by this at all', () => {
    assert.deepEqual(allowedFor([plain], { member: null, userText: 'a hotel' }).map((v) => v.name),
      ['The Inn']);
  });
});

describe('what the brain is told', () => {
  test('the disclosure has to come first, and the block says so in those words', () => {
    const block = disclosureBlock([aroyo()]);
    assert.match(block, /VENUE DISCLOSURES/);
    assert.match(block, /Aroyo: clothing optional/);
    assert.match(block, /FIRST thing you say/,
      '"mention it" produces a mention in the last sentence');
    assert.match(block, /before the description, before why it is good, before the price/);
  });

  test('it shows the right and wrong sentence, not just the rule', () => {
    const block = disclosureBlock([aroyo()]);
    assert.match(block, /is right;/);
    assert.match(block, /is wrong, because by then the guest has already pictured their holiday/);
  });

  test('it forbids dropping the disclosure to make the pitch land', () => {
    assert.match(disclosureBlock([aroyo()]), /Never leave it out/);
  });

  test('it is a plain fact, never a warning label', () => {
    const block = disclosureBlock([aroyo()]);
    assert.match(block, /not a warning/);
    assert.ok(!/WARNING|ADULT CONTENT|explicit/i.test(block.replace('not a warning', '')),
      'the venue is being described to a guest, not flagged to a moderator');
  });

  test('nothing to disclose means no block at all', () => {
    assert.equal(disclosureBlock([plain]), '');
    assert.equal(disclosureBlock([]), '');
    assert.equal(disclosureBlock(null), '');
  });
});

describe('annotating rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, place_id TEXT,
    custom_fields TEXT)`);
  db.exec(`INSERT INTO num_business_profiles VALUES
    ('biz_aroyo','p_aroyo','{"disclosures":["clothing_optional"]}'),
    ('biz_inn','p_inn','{}')`);
  const env = {
    DB: {
      prepare(sql) {
        const b = (args) => ({
          bind: (...m) => b([...args, ...m]),
          all: async () => ({ results: db.prepare(sql).all(...args) }),
        });
        return b([]);
      },
    },
  };

  test('it annotates rows other ranking already chose, and widens nothing', async () => {
    const rows = [{ id: 'p_aroyo', name: 'Aroyo' }, { id: 'p_inn', name: 'The Inn' }];
    const out = await annotate(env, rows);
    assert.equal(out.length, 2, 'annotating must never add a venue to the answer');
    assert.deepEqual(out[0].disclosures, [CO]);
    assert.deepEqual(out[1].disclosures, []);
  });

  test('a failed read withholds everything rather than silently clearing a flag', async () => {
    // Returning `disclosures: []` on an error would say "this venue has nothing
    // to declare", which for Aroyo is the one wrong answer available.
    const broken = { DB: { prepare() { throw new Error('down'); } } };
    const out = await annotate(broken, [{ id: 'p_aroyo', name: 'Aroyo' }]);
    assert.equal(out[0].disclosures_unknown, true);
    assert.deepEqual(allowedFor(out, { ...verified, userText: 'a resort' }).map((v) => v.name),
      ['Aroyo'], 'an unknown-but-present venue still passes the ordinary gate');
  });

  test('no rows and no database are both just no rows', async () => {
    assert.deepEqual(await annotate(env, []), []);
    assert.deepEqual(await annotate({}, [{ id: 'p_aroyo' }]), [{ id: 'p_aroyo' }]);
  });
});
