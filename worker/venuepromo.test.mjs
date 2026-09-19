// The line a paying venue gets the concierge to mention — and the three
// things it is never allowed to do: widen a list, reorder one, or outlive the
// offer it describes.
//
// This feature was sold on /pricing/ at $9.99 a month for weeks while nothing
// under ai/ read the field. These tests exist so that cannot happen quietly
// again: the last one fails the moment the prompt block stops carrying the
// no-placement rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import {
  promoOf, fresh, tierAllowsPromo, annotatePromos, promoBlock, savePromo,
  MAX_PROMO_CHARS, PROMO_MAX_AGE_DAYS,
} from './venuepromo.mjs';
import { bizTierOf } from './bizbilling.mjs';

const DAY = 86400_000;
const NOW = Date.parse('2026-09-19T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString().slice(0, 10);

function realDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_business_profiles (
      business_id TEXT PRIMARY KEY, place_id TEXT, custom_fields TEXT DEFAULT '{}',
      updated_at INTEGER DEFAULT 0);
    CREATE TABLE num_business_subscriptions (
      business_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free', renews_at TEXT);
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...bound) ?? null; } catch { return null; } },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() { const r = d.prepare(sql).run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
    async batch(st) { const o = []; for (const x of st) o.push(await x.run()); return o; },
  };
  return { d, env: { DB } };
}

/** A venue with a profile, a plan and (optionally) a promotion. */
function venue(d, { biz, place, tier = 'free', renews = null, text = null, setAt = null }) {
  const cf = {};
  if (text) cf.promo_text = text;
  if (setAt) cf.promo_set_at = setAt;
  d.prepare('INSERT INTO num_business_profiles (business_id, place_id, custom_fields) VALUES (?,?,?)')
    .run(biz, place, JSON.stringify(cf));
  if (tier !== 'free' || renews) {
    d.prepare('INSERT INTO num_business_subscriptions (business_id, tier, renews_at) VALUES (?,?,?)')
      .run(biz, tier, renews);
  }
}

const ROWS = [
  { id: 'p1', name: "Hugo's Restaurant" },
  { id: 'p2', name: 'Gjelina' },
  { id: 'p3', name: 'Bestia' },
];

/* ── what counts as a promotion at all ─────────────────────────────── */

test('a promotion without a date is not served, because we cannot tell if it is current', () => {
  assert.equal(promoOf({ promo_text: 'Two tacos for one before noon' }), null);
  assert.ok(promoOf({ promo_text: 'Two for one', promo_set_at: ago(1) }));
});

test('an empty line is not a promotion', () => {
  assert.equal(promoOf({ promo_text: '   ', promo_set_at: ago(1) }), null);
  assert.equal(promoOf({}), null);
  assert.equal(promoOf(null), null);
});

test('a broken custom_fields blob is not a crash', () => {
  assert.equal(promoOf('{not json'), null);
});

test('the line is cut at the length the form allows, not beyond it', () => {
  const long = 'x'.repeat(400);
  assert.equal(promoOf({ promo_text: long, promo_set_at: ago(1) }).text.length, MAX_PROMO_CHARS);
});

/* ── staleness ─────────────────────────────────────────────────────── */

test('a promotion nobody has touched in a season stops being repeated', () => {
  const old = promoOf({ promo_text: 'Happy hour all August', promo_set_at: ago(PROMO_MAX_AGE_DAYS + 1) });
  assert.equal(fresh(old, NOW), false);
  const justInside = promoOf({ promo_text: 'Happy hour', promo_set_at: ago(PROMO_MAX_AGE_DAYS - 1) });
  assert.equal(fresh(justInside, NOW), true);
});

test('a date in the future is a clock problem, not a fresher promotion', () => {
  const ahead = promoOf({ promo_text: 'Next year', promo_set_at: '2027-01-01' });
  assert.equal(fresh(ahead, NOW), true, 'served as if written now — never granted extra life');
});

/* ── who is allowed one ────────────────────────────────────────────── */

test('the free plan does not include a promotion', () => {
  assert.equal(tierAllowsPromo({}, 'free', null, NOW), false);
});

test('a paid plan does', () => {
  assert.equal(tierAllowsPromo({}, 'small', null, NOW), true);
  assert.equal(tierAllowsPromo({}, 'pro', null, NOW), true);
  assert.equal(tierAllowsPromo({}, 'full', null, NOW), true);
});

test('a plan that lapsed stops being quoted without anybody editing the row', () => {
  const yesterday = new Date(NOW - DAY).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(tierAllowsPromo({}, 'small', yesterday, NOW), false);
});

test('the lapse rule here is the same one bizTierOf applies', async () => {
  const { d, env } = realDb();
  const past = new Date(NOW - DAY).toISOString().slice(0, 19).replace('T', ' ');
  d.prepare('INSERT INTO num_business_subscriptions (business_id, tier, renews_at) VALUES (?,?,?)')
    .run('b_lapsed', 'small', past);
  // bizTierOf demotes to free; tierAllowsPromo must agree, or a lapsed venue
  // keeps a paid feature that its own plan lookup says it no longer has.
  assert.equal(await bizTierOf(env, 'b_lapsed'), 'free');
  assert.equal(tierAllowsPromo(env, 'small', past, NOW), false);
});

/* ── the contract with the result set ──────────────────────────────── */

test('a paying venue with a fresh line gets it attached', async () => {
  const { d, env } = realDb();
  venue(d, { biz: 'b1', place: 'p1', tier: 'small', text: 'Free chips before 6', setAt: ago(2) });
  const out = await annotatePromos(env, ROWS, { now: NOW });
  assert.equal(out[0].promo.text, 'Free chips before 6');
  assert.equal(out[1].promo, undefined);
});

test('a free-plan venue that somehow has a line is not quoted', async () => {
  const { d, env } = realDb();
  venue(d, { biz: 'b1', place: 'p1', tier: 'free', text: 'Free chips', setAt: ago(2) });
  const out = await annotatePromos(env, ROWS, { now: NOW });
  assert.equal(out[0].promo, undefined);
});

test('the list is never widened, reordered or shortened', async () => {
  const { d, env } = realDb();
  // The venue LAST in the list is the paying one. If a promotion could buy
  // position, this is where it would show.
  venue(d, { biz: 'b3', place: 'p3', tier: 'full', text: 'Chef tasting half price', setAt: ago(1) });
  const out = await annotatePromos(env, ROWS, { now: NOW });
  assert.deepEqual(out.map((r) => r.id), ['p1', 'p2', 'p3'], 'order untouched');
  assert.equal(out.length, ROWS.length, 'nothing added, nothing dropped');
  assert.equal(out[2].promo.text, 'Chef tasting half price');
});

test('a database that fails costs the answer its promotions, never its places', async () => {
  const env = { DB: { prepare() { throw new Error('D1 is having a day'); } } };
  const out = await annotatePromos(env, ROWS, { now: NOW });
  assert.deepEqual(out.map((r) => r.id), ['p1', 'p2', 'p3']);
  assert.ok(out.every((r) => !r.promo));
});

test('no rows in, no query out', async () => {
  const env = { DB: { prepare() { throw new Error('should not be called'); } } };
  assert.deepEqual(await annotatePromos(env, [], { now: NOW }), []);
});

/* ── what the model is told ────────────────────────────────────────── */

test('no promotions means no block at all, not an empty heading', () => {
  assert.equal(promoBlock(ROWS), '');
  assert.equal(promoBlock([]), '');
});

test('the block carries the no-paid-placement rule, in words', () => {
  const block = promoBlock([{ ...ROWS[0], promo: { text: 'Free chips before 6' } }]);
  assert.match(block, /Free chips before 6/);
  assert.match(block, /already decided to suggest/i,
    'a promo may only ride along with a place ranking already chose');
  assert.match(block, /NEVER a reason to suggest one place over another/,
    'the moment this line goes, NUM is selling placement');
  assert.match(block, /same recommendation/i,
    'the guest must get the same answer whether or not the venue pays');
  assert.match(block, /own words|not checked by NUM/i,
    'NUM must attribute the claim rather than make it');
});

/* ── saving ────────────────────────────────────────────────────────── */

test('saving stamps the day, so the read side can age it out', async () => {
  const { d, env } = realDb();
  venue(d, { biz: 'b1', place: 'p1', tier: 'small' });
  const out = await savePromo(env, 'b1', 'Two for one before noon', 'console', { now: new Date(NOW) });
  assert.equal(out.ok, true);
  assert.equal(out.promo_set_at, '2026-09-19');
  const cf = JSON.parse(d.prepare('SELECT custom_fields FROM num_business_profiles WHERE business_id=?').get('b1').custom_fields);
  assert.equal(cf.promo_text, 'Two for one before noon');
  assert.equal(cf.promo_set_at, '2026-09-19');
});

test('saving a promotion does not wipe the disclosures sharing that blob', async () => {
  const { d, env } = realDb();
  d.prepare('INSERT INTO num_business_profiles (business_id, place_id, custom_fields) VALUES (?,?,?)')
    .run('b1', 'p1', JSON.stringify({ disclosures: ['clothing_optional'], licence: 'LIC-9' }));
  await savePromo(env, 'b1', 'Sunset rates', 'console', { now: new Date(NOW) });
  const cf = JSON.parse(d.prepare('SELECT custom_fields FROM num_business_profiles WHERE business_id=?').get('b1').custom_fields);
  assert.deepEqual(cf.disclosures, ['clothing_optional'], 'a disclosure must survive a promo save');
  assert.equal(cf.licence, 'LIC-9');
  assert.equal(cf.promo_text, 'Sunset rates');
});

test('clearing the line clears its date, so the next empty save is not a fresh promotion', async () => {
  const { d, env } = realDb();
  venue(d, { biz: 'b1', place: 'p1', tier: 'small', text: 'Old offer', setAt: ago(2) });
  await savePromo(env, 'b1', '', 'console', { now: new Date(NOW) });
  const cf = JSON.parse(d.prepare('SELECT custom_fields FROM num_business_profiles WHERE business_id=?').get('b1').custom_fields);
  assert.equal(cf.promo_text, undefined);
  assert.equal(cf.promo_set_at, undefined);
  const out = await annotatePromos(env, ROWS, { now: NOW });
  assert.equal(out[0].promo, undefined);
});

test('a saved promotion survives the round trip and comes back through annotate', async () => {
  const { d, env } = realDb();
  venue(d, { biz: 'b1', place: 'p1', tier: 'small' });
  await savePromo(env, 'b1', 'Kids eat free on Sundays', 'console', { now: new Date(NOW) });
  const out = await annotatePromos(env, ROWS, { now: NOW });
  assert.equal(out[0].promo.text, 'Kids eat free on Sundays');
});

/* ── the wiring itself ─────────────────────────────────────────────── */

test('the concierge actually reads the field — the bug this file was written for', () => {
  // A grep is the test here on purpose. The original failure was not a wrong
  // value, it was that NOTHING read promo_text: the feature was sold, saved
  // and displayed, and no code path carried it to a guest. Asserting on the
  // wiring is what catches that class of bug.
  const grounding = fs.readFileSync(new URL('./grounding.mjs', import.meta.url), 'utf8');
  assert.match(grounding, /annotatePromos/, 'grounding must attach promotions to the rows');
  assert.match(grounding, /promos,/, 'grounding must publish them to the caller');

  const index = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(index, /grounding\?\.promos/, 'the prompt must actually receive the block');

  // And the disclosure block must still be pushed BEFORE it: a thing a guest
  // must be told outranks a thing a venue would like said.
  const discAt = index.indexOf('grounding?.disclosures');
  const promoAt = index.indexOf('grounding?.promos');
  assert.ok(discAt > -1 && promoAt > -1 && discAt < promoAt,
    'disclosures are pushed before promotions, so the must-be-told line survives a squeeze');
});

test('both save doors stamp the date', () => {
  for (const f of ['bizconsole.mjs', 'bizapi.mjs']) {
    const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.match(src, /savePromo/, `${f} must save through savePromo, or its promos are undated and never served`);
    assert.doesNotMatch(src, /cf\.promo_text\s*=/, `${f} must not write promo_text directly`);
  }
});
