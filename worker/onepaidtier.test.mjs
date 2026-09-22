/**
 * One paid tier, priced at $4.99 a month or $49 a year — and the gift that
 * happens the first time somebody meets the free ceiling.
 *
 * Decided 21 Sep 2026. Two paid tiers became one because the second tier's
 * whole pitch was "no ceilings", which reads as nothing to a person who has
 * never met the first ceiling — and because a traveller "NUM Pro" at $28.98
 * collided with the business Pro at $19.99, one word meaning two products.
 *
 * The rules these hold:
 *   · exactly one paid tier, and a removed tier fails closed
 *   · the client names the interval and NEVER the amount
 *   · a year is cheaper than twelve months and stays under the $150 line that
 *     §17550.27 would impose if a travel benefit ever did sit behind the price
 *   · the first ceiling is a gift, exactly once, decided by the INSERT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { tiers, onceEver, handleMembership } from './membership.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      try {
        const st = db.prepare(sql);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
        const r = st.run(...args); return { results: [], success: true, meta: { changes: Number(r.changes ?? 0) } };
      } catch { return { results: [], success: true }; }
    },
    first: async () => { try { return db.prepare(sql).get(...args) ?? null; } catch { return null; } },
    run: async () => {
      try { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; }
      catch { return { success: true, meta: { changes: 0 } }; }
    },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const fresh = () => d1(new DatabaseSync(':memory:'));

test('there is exactly one paid tier, and it is NUM Plus at $4.99 / $49', () => {
  const all = tiers({});
  const paid = Object.entries(all).filter(([, t]) => Number(t.price_cents) > 0);
  assert.equal(paid.length, 1, 'two paid tiers is the choice nobody wanted to make');
  const [id, t] = paid[0];
  assert.equal(id, 'plus');
  assert.equal(t.name, 'NUM Plus', 'the product name is capitalised like the product');
  assert.equal(t.price_cents, 499);
  assert.equal(t.price_cents_year, 4900);
  assert.equal(all.free.price_cents, 0);
  assert.equal(t.entitlements.plans_max, null, 'the paid tier has no ceiling to explain');
  assert.equal(all.free.entitlements.plans_max, 3);
});

test('a year costs less than twelve months, and stays under the §17550.27 line', () => {
  const t = tiers({}).plus;
  assert.ok(t.price_cents_year < t.price_cents * 12, 'a year that costs more than months is a trap');
  // $150/yr is the cap a seller-of-travel discount program is held to. NUM's
  // paid tier carries no travel benefit, so the cap does not bite — staying
  // under it anyway means the day it might, the price is not the problem.
  assert.ok(t.price_cents_year <= 15000, 'over $150 a year forecloses the registered route');
});

test('the client picks the interval and the SERVER picks the price', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/checkout/sessions')) calls.push(new URLSearchParams(init?.body ?? ''));
    return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const env = { DB: fresh(), STRIPE_SECRET_KEY: 'sk_test_x' };
    const post = (body) => handleMembership(
      new Request('https://app.itsnum.com/api/membership/subscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), env, '/subscribe');

    await post({ me: 'mem_1', tier: 'plus' });
    await post({ me: 'mem_1', tier: 'plus', interval: 'year' });
    // The attack this guards: a client naming its own number. It is the
    // $1-for-★5,000 hole in a different shirt.
    await post({ me: 'mem_1', tier: 'plus', interval: 'year', amountCents: 1, price_cents: 1 });

    assert.equal(calls.length, 3);
    const [monthly, yearly, liar] = calls;
    assert.equal(monthly.get('line_items[0][price_data][unit_amount]'), '499');
    assert.equal(monthly.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.equal(yearly.get('line_items[0][price_data][unit_amount]'), '4900');
    assert.equal(yearly.get('line_items[0][price_data][recurring][interval]'), 'year');
    assert.equal(liar.get('line_items[0][price_data][unit_amount]'), '4900', 'the body it sent was ignored');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a tier the table does not contain cannot be subscribed to', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  try {
    const res = await handleMembership(
      new Request('https://app.itsnum.com/api/membership/subscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ me: 'mem_1', tier: 'pro' }),
      }), { DB: fresh(), STRIPE_SECRET_KEY: 'sk_test_x' }, '/subscribe');
    assert.equal(res.status, 400);
    assert.equal(called, false, 'the removed tier never reaches Stripe');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the first ceiling is a gift, and only the first', async () => {
  const env = { DB: fresh() };
  assert.equal(await onceEver(env, 'mem_1', 'plans_max_gift'), true);
  assert.equal(await onceEver(env, 'mem_1', 'plans_max_gift'), false);
  assert.equal(await onceEver(env, 'mem_1', 'plans_max_gift'), false, 'and it does not come back next month');
  // Per member, and per thing given.
  assert.equal(await onceEver(env, 'mem_2', 'plans_max_gift'), true);
  assert.equal(await onceEver(env, 'mem_1', 'something_else'), true);
});

test('a gift is never handed out twice to two requests at once', async () => {
  const env = { DB: fresh() };
  const four = await Promise.all([1, 2, 3, 4].map(() => onceEver(env, 'mem_1', 'plans_max_gift')));
  assert.equal(four.filter(Boolean).length, 1, 'the INSERT decides it, not a read-then-write');
});

test('no member id and no database are false, never a free gift', async () => {
  assert.equal(await onceEver({ DB: fresh() }, null, 'plans_max_gift'), false);
  assert.equal(await onceEver({}, 'mem_1', 'plans_max_gift'), false);
});

test('the plan-create path asks for the gift BEFORE it refuses', () => {
  // A source guard, in the house style: the end-to-end path needs half the
  // social schema to exercise, and what actually breaks is somebody tidying
  // the refusal and dropping the two lines above it. Order is the whole
  // point — a refusal written first and a gift checked afterwards is a wall
  // with an apology attached.
  const src = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');
  const gate = src.indexOf("const gate = await may(env, meId, 'plans_max'");
  const gift = src.indexOf("onceEver(env, meId, 'plans_max_gift')", gate);
  const refuse = src.indexOf('reason: \'plans_max\'', gate);
  assert.ok(gate > 0 && gift > 0 && refuse > 0, 'the ceiling, the gift and the refusal must all still be there');
  assert.ok(gift < refuse, 'the gift is checked before anyone is refused');
  assert.match(src.slice(gate, gate + 2600), /!gate\.ok && !gifted/, 'a gifted member must not be refused');
  assert.match(src, /gift: 'plans_max'/, 'and the response says it was a gift');
});
