// What a business offers, and what it charges.
//
// The three properties that matter are all refusals: a price may be absent,
// a currency is never guessed, and a menu is never recited whole. Each one is
// a place where inventing something would be easier and worse.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  formatPrice, currencyFor, minorPer, listFor, forPlaces, upsert, hide, show, countFor, UNITS,
} from './bizoffer.mjs';
import { detail } from './pickdetail.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes ?? 0) } }),
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db) };

before(() => {
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT,
    verified_at TEXT, revoked_at TEXT)`);
  db.exec(`CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, country TEXT)`);
  db.exec(`CREATE TABLE num_business_offerings (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, place_id TEXT NOT NULL, section TEXT,
    name TEXT NOT NULL, description TEXT, price_minor INTEGER, price_note TEXT, currency TEXT,
    unit TEXT NOT NULL DEFAULT 'item', available TEXT, position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`);
});

beforeEach(() => {
  for (const t of ['num_place_owners', 'num_business_profiles', 'num_business_offerings']) db.exec(`DELETE FROM ${t}`);
  db.exec("INSERT INTO num_place_owners (place_id,business_id,verified_at) VALUES ('pl_suay','biz_1','2026-08-01')");
  db.exec("INSERT INTO num_business_profiles (business_id,country) VALUES ('biz_1','TH')");
});

describe('prices', () => {
  test('an absent price is absent — "market price" is a real answer', () => {
    assert.equal(formatPrice({ price_minor: null, currency: 'THB' }), null);
    assert.equal(formatPrice({ price_minor: null, currency: 'THB', price_note: 'Market price' }), 'Market price');
    // The one thing it must never do is invent a figure to fill the gap.
    assert.notEqual(formatPrice({ price_minor: null, currency: 'THB' }), '฿0');
  });

  test('zero-decimal currencies are not divided by a hundred', () => {
    // A ¥1,200 bowl of ramen priced at ¥12 is the classic version of this bug.
    assert.equal(minorPer('JPY'), 1);
    assert.equal(formatPrice({ price_minor: 1200, currency: 'JPY' }), '¥1,200');
    assert.equal(formatPrice({ price_minor: 18000, currency: 'THB' }), '฿180');
  });

  test('a currency we cannot work out shows a bare number, never a wrong symbol', () => {
    assert.equal(currencyFor('ZZ'), null);
    assert.equal(currencyFor(null), null);
    assert.equal(formatPrice({ price_minor: 1800, currency: null }), '18');
    // A Thai restaurant priced in dollars is wrong in a way a traveller acts on.
    assert.equal(currencyFor('TH'), 'THB');
    assert.equal(currencyFor('GB'), 'GBP');
  });

  test('the unit rides with the price where it changes what is being bought', () => {
    assert.equal(formatPrice({ price_minor: 250000, currency: 'THB', unit: 'night' }), '฿2,500 per night');
    assert.equal(formatPrice({ price_minor: 18000, currency: 'THB', unit: 'item' }), '฿180');
    assert.equal(formatPrice({ price_minor: 90000, currency: 'THB', unit: 'person', price_note: 'From' }),
      'From ฿900 per person');
  });
});

describe('what an owner can list', () => {
  test('an item takes the currency of where the business is, not one it picks', async () => {
    const out = await upsert(env, 'biz_1', { name: 'Green curry', price: '180' });
    assert.equal(out.ok, true);
    const [row] = await listFor(env, 'biz_1');
    assert.equal(row.currency, 'THB');
    assert.equal(row.price_minor, 18000);
    assert.equal(row.price_label, '฿180');
  });

  test('an item with no price is allowed and says how it is priced instead', async () => {
    await upsert(env, 'biz_1', { name: 'Whole seabass', price: '', price_note: 'Market price' });
    const [row] = await listFor(env, 'biz_1');
    assert.equal(row.price_minor, null);
    assert.equal(row.price_label, 'Market price');
  });

  test('a nameless item is refused — a name is what a traveller hears', async () => {
    const out = await upsert(env, 'biz_1', { name: '   ', price: '180' });
    assert.equal(out.ok, false);
    assert.match(out.error, /name/i);
  });

  test('a price that is not a number, or is absurd, is refused rather than stored', async () => {
    assert.equal((await upsert(env, 'biz_1', { name: 'x', price: '9999999999' })).ok, false);
    // Currency symbols and spaces are stripped rather than rejected — an owner
    // typing "฿180" meant 180.
    const out = await upsert(env, 'biz_1', { name: 'Pad thai', price: '฿ 120' });
    assert.equal(out.ok, true);
    assert.equal((await listFor(env, 'biz_1'))[0].price_minor, 12000);
  });

  test('a unit outside the list falls back to item rather than reaching an answer', async () => {
    await upsert(env, 'biz_1', { name: 'Thing', price: '10', unit: 'per_squiggle' });
    assert.equal((await listFor(env, 'biz_1'))[0].unit, 'item');
    assert.ok(UNITS.includes('night') && UNITS.includes('person'));
  });

  test('a business cannot edit another business item by guessing its id', async () => {
    const { id } = await upsert(env, 'biz_1', { name: 'Mine', price: '10' });
    db.exec("INSERT INTO num_place_owners (place_id,business_id,verified_at) VALUES ('pl_x','biz_2','2026-08-01')");
    db.exec("INSERT INTO num_business_profiles (business_id,country) VALUES ('biz_2','TH')");
    const out = await upsert(env, 'biz_2', { id, name: 'Hijacked', price: '99' });
    assert.equal(out.ok, false);
    assert.equal((await listFor(env, 'biz_1'))[0].name, 'Mine');
  });

  test('hiding stops the concierge saying it, without making them retype it in June', async () => {
    const { id } = await upsert(env, 'biz_1', { name: 'Summer special', price: '200' });
    assert.equal((await hide(env, 'biz_1', id)).ok, true);
    assert.equal(await countFor(env, 'biz_1'), 0);
    assert.equal((await listFor(env, 'biz_1')).length, 1, 'the owner lost their own item');
    assert.equal((await forPlaces(env, ['pl_suay'])).size, 0);
    await show(env, 'biz_1', id);
    assert.equal(await countFor(env, 'biz_1'), 1);
  });
});

describe('what reaches a traveller', () => {
  test('the answer path gets formatted strings, never raw minor units', async () => {
    await upsert(env, 'biz_1', { name: 'Green curry', price: '180' });
    const [item] = (await forPlaces(env, ['pl_suay'])).get('pl_suay');
    assert.equal(item.price, '฿180');
    assert.equal(item.price_minor, undefined,
      'a model handed 18000 eventually reads it out as eighteen thousand');
  });

  test('a menu is capped — a concierge reciting 200 items is useless', async () => {
    for (let i = 0; i < 30; i++) await upsert(env, 'biz_1', { name: `Item ${i}`, price: '10', position: i });
    const list = (await forPlaces(env, ['pl_suay'])).get('pl_suay');
    assert.equal(list.length, 8);
    assert.equal(list[0].name, 'Item 0', 'the cap ignored the owner own order');
  });

  test('it rides onto the pick without changing how anything else is built', () => {
    const pick = detail({ id: 'pl_suay', name: 'Suay' },
      { id: 'pl_suay', cuisine: 'Thai', offerings: [{ name: 'Green curry', price: '฿180' }] }, 'Asia/Bangkok');
    assert.equal(pick.cuisine, 'Thai');
    assert.deepEqual(pick.offerings, [{ name: 'Green curry', price: '฿180' }]);
    // And a place with nothing listed produces exactly what it produced before.
    const bare = detail({ id: 'pl_x', name: 'X' }, { id: 'pl_x', cuisine: 'Thai' }, 'Asia/Bangkok');
    assert.equal(bare.offerings, undefined);
  });

  test('the answer path actually reads it — a table nothing queries answers nobody', () => {
    const idx = src('index.mjs');
    assert.match(idx, /forPlaces/, 'offerings never reach the concierge');
    assert.match(idx, /bizoffer\.mjs/);
    // Best-effort: a failed read must degrade to the answer NUM gave before.
    const block = idx.slice(idx.indexOf("import('./bizoffer.mjs')") - 600, idx.indexOf("import('./bizoffer.mjs')") + 700);
    assert.match(block, /catch/, 'a broken offerings read would take the whole answer down');
  });

  test('it is free on every plan — the concierge must not know less about businesses that pay least', () => {
    const pages = src('bizpages.mjs');
    const block = pages.slice(pages.indexOf("id: 'offerings'"), pages.indexOf("id: 'offerings'") + 400);
    assert.ok(!/needs:\s*\(/.test(block), 'what a business offers went behind a paywall');
  });
});

// ── the API and MCP surface ─────────────────────────────────────────────
//
// A restaurateur will not open a dashboard every week to change a menu; a
// point-of-sale integration or an assistant will. The menu is the thing that
// changes most often, so it is the thing that most needs a machine door.
describe('an assistant can manage the menu', () => {
  test('every offerings route is behind a key, alongside the rest', () => {
    const api = src('bizapi.mjs');
    for (const r of ['/v1/offerings', '/v1/offerings/hide', '/v1/offerings/show']) {
      assert.ok(api.includes(`path === '${r}'`), `${r} is not routed`);
    }
    // They sit after the `authed()` gate and after the placeId check, like
    // every other business route — an unauthenticated menu edit would let
    // anyone price somebody else's restaurant.
    const authAt = api.indexOf('const auth = await authed(request');
    const gate = api.indexOf('const auth = await authed(env, request)');
    const at = api.indexOf("path === '/v1/offerings'");
    assert.ok(at > Math.max(authAt, gate), 'offerings are routed before the key is checked');
  });

  test('the index lists them, so an agent can find them from one URL', () => {
    const api = src('bizapi.mjs');
    const idx = api.slice(api.indexOf('export function bizApiIndex'));
    assert.match(idx, /\/v1\/offerings/);
    // And it says the thing an integration will otherwise get wrong.
    assert.match(idx, /omit or leave empty if it varies/i);
  });

  test('the tools say what they refuse, because that is the interface', () => {
    const mcp = src('bizmcp.mjs');
    for (const t of ['list_offerings', 'set_offering', 'hide_offering']) {
      assert.ok(mcp.includes(`name: '${t}'`), `${t} is not published`);
    }
    const setBlock = mcp.slice(mcp.indexOf("name: 'set_offering'"), mcp.indexOf("name: 'hide_offering'"));
    // A model that tries to set a currency, invents a price, or promises a
    // booking has to be told before it tries — an error after the fact reads
    // to the model as "Num is broken", not "that was out of bounds".
    assert.match(setBlock, /Currency is NOT settable/);
    assert.match(setBlock, /Leave price empty when it varies/);
    assert.match(setBlock, /nothing here is bookable or payable/i);
    const listBlock = mcp.slice(mcp.indexOf("name: 'list_offerings'"), mcp.indexOf("name: 'set_offering'"));
    assert.match(listBlock, /Do not fill in a figure of your own/i);
  });

  test('each tool maps to the same handler a curl would reach — no second implementation', () => {
    const mcp = src('bizmcp.mjs');
    for (const [tool, path] of [
      ['list_offerings', '/v1/offerings'],
      ['set_offering', '/v1/offerings'],
      ['hide_offering', '/v1/offerings/hide'],
    ]) {
      assert.ok(mcp.includes(`case '${tool}':`), `${tool} has no dispatch`);
      assert.ok(mcp.includes(`'${path}'`), `${tool} does not reach ${path}`);
    }
  });

  test('the API and the console share one set of rules about a price', () => {
    // Both call bizoffer.upsert. A second implementation is a second opinion
    // about whether a price may be absent, and one of them will be wrong.
    const api = src('bizapi.mjs');
    assert.match(api, /await import\('\.\/bizoffer\.mjs'\)/);
    assert.ok(!/price_minor\s*=\s*Math\.round/.test(api),
      'bizapi grew its own price arithmetic instead of calling bizoffer');
  });
});
