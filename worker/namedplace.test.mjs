/**
 * The guest named a business and Num could not see it.
 *
 * 11 Sep 2026. LA Cannabis Club is in the directory (p_76f0caad…, "Cannabis
 * Delivery", Los Angeles, coordinates, phone) and signed up as an active
 * business. Dre asked Num to set up a delivery with it and Num refused,
 * saying Num is not allowed to deliver cannabis — which is not true, and not
 * the reason.
 *
 * The reason: retrieval was CATEGORY-ONLY. There was no `name LIKE` anywhere
 * in the retrieval layer, so naming a business put zero rows about it in the
 * block and the model answered from general knowledge.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { namedPlaces, nameHit, words, norm } from './namedplace.mjs';

let db; let env;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.run = async () => { const { text, args } = run(); database.prepare(text).run(...args); return { meta: {} }; };
    return st;
  },
});

const place = (id, name, cat, biz = null) =>
  db.prepare(`INSERT INTO places (id,name,category,area,phone,website,address,lat,lng,hours_mask,booking_platform,booking_ref,business_id,dest,alive)
              VALUES (?,?,?,NULL,NULL,NULL,NULL,34.04,-118.25,NULL,NULL,NULL,?, 'los-angeles', NULL)`).run(id, name, cat, biz);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, category TEXT, area TEXT, phone TEXT, website TEXT,
    address TEXT, lat REAL, lng REAL, hours_mask TEXT, booking_platform TEXT, booking_ref TEXT, business_id TEXT, dest TEXT, alive INTEGER)`);
  place('p_lacc', 'LA Cannabis Club', 'Cannabis Delivery', 'biz_lacc');
  place('p_bestia', 'Bestia', 'Restaurant');
  place('p_other', 'Cannabis Corner', 'Shop');
  place('p_club', 'The Club', 'Bar');
  env = { DB: d1(db) };
});

describe('the exact sentence that failed', () => {
  test('LA Cannabis Club is found when the guest names it', async () => {
    const out = await namedPlaces(env, { dest: 'los-angeles', text: 'set up a delivery with la cannabis club' });
    assert.equal(out[0]?.id, 'p_lacc');
    assert.equal(out[0]._named, true);
    assert.equal(out[0]._partner, true);
  });

  test('a signed-up partner outranks a same-word directory row', async () => {
    // A promise to the businesses that claim their listing, not an optimisation.
    const out = await namedPlaces(env, { dest: 'los-angeles', text: 'la cannabis club please', limit: 2 });
    assert.equal(out[0].id, 'p_lacc');
  });

  test('the phone and coordinates come with it, so the model can act', async () => {
    const [hit] = await namedPlaces(env, { dest: 'los-angeles', text: 'la cannabis club' });
    assert.ok('phone' in hit && 'lat' in hit && 'booking_platform' in hit);
  });
});

describe('it does not invent a match', () => {
  test('"club" alone drags in nothing', async () => {
    // A single common word is not a name. A confident wrong place is worse
    // than no place.
    assert.deepEqual(await namedPlaces(env, { dest: 'los-angeles', text: 'find me a club tonight' }), []);
  });

  test('a plain category ask matches nothing', async () => {
    assert.deepEqual(await namedPlaces(env, { dest: 'los-angeles', text: 'where should we eat tonight' }), []);
  });

  test('another destination is another directory', async () => {
    assert.deepEqual(await namedPlaces(env, { dest: 'phuket', text: 'la cannabis club' }), []);
  });

  test('a dead listing is never named', async () => {
    db.prepare("UPDATE places SET alive=0 WHERE id='p_lacc'").run();
    const out = await namedPlaces(env, { dest: 'los-angeles', text: 'la cannabis club' });
    assert.ok(!out.some((p) => p.id === 'p_lacc'));
  });

  test('no database is a shape, not a crash', async () => {
    assert.deepEqual(await namedPlaces({}, { dest: 'los-angeles', text: 'x' }), []);
  });
});

describe('the matcher itself', () => {
  test('the whole name inside the sentence is the strongest hit', () => {
    assert.equal(nameHit('Bestia', 'book me a table at bestia'), 2);
  });

  test('punctuation and case do not matter', () => {
    assert.equal(nameHit("Gjelina's", 'dinner at GJELINAS tonight'), 2);
  });

  test('every meaningful word present also counts', () => {
    assert.equal(nameHit('LA Cannabis Club', 'can we order cannabis from la club'), 1);
  });

  test('a partial overlap does not', () => {
    assert.equal(nameHit('Blue Elephant Bangkok', 'somewhere blue tonight'), 0);
  });

  test('stop words alone never match', () => {
    assert.equal(nameHit('The Club', 'take me to a club'), 0);
    assert.deepEqual(words('the a an at in'), []);
  });

  test('norm strips everything that is not a letter or digit', () => {
    // Apostrophes are deleted, not split: "omalleys", never "o malley s".
    assert.equal(norm("O'Malley's Bar & Grill"), 'omalleys bar grill');
    assert.equal(norm('Gjelina\u2019s'), 'gjelinas', 'the curly apostrophe iOS inserts');
  });
});
