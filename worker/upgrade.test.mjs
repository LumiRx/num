/**
 * The offer Num never made — and the restraint that keeps it worth making.
 *
 * 16 Sep 2026: 152 members, 0 subscriptions, and zero mentions of "tier" or
 * "upgrade" anywhere in the prompt. Checkout worked the whole time. Nothing
 * asked.
 *
 * Half of these tests are about NOT selling. That is deliberate: the failure
 * mode of this feature is not "never converts", it is "pitches on every turn
 * and costs us the trust the product is built on". Both are tested.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeBlock, gains, EARNED, NEVER } from './upgrade.mjs';
import { contextBlock, REPLY_SCHEMA } from './prompt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TABLE = {
  free: { name: 'Num', price_cents: 0, entitlements: { plans_max: 3, deep_research_monthly: 3, early_features: false } },
  plus: { name: 'Num Plus', price_cents: 898, entitlements: { plans_max: 25, deep_research_monthly: 40, early_features: true } },
  pro: { name: 'Num Pro', price_cents: 2898, entitlements: { plans_max: null, deep_research_monthly: null, early_features: true } },
};

/* ── the offer exists at all ───────────────────────────────────────────── */

describe('there is now an offer to make', () => {
  test('THE GAP: the prompt knows plans exist', () => {
    // It contained zero mentions of tier, upgrade, Plus, Pro or subscription.
    // A concierge that has never heard of the product cannot sell it, and
    // could not have answered a guest who asked outright.
    const b = contextBlock({ place: { name: 'Los Angeles' }, membership: upgradeBlock({ tier: 'free', table: TABLE, earned: 'asked' }) });
    assert.match(b, /Num Plus is \$8\.98 a month/);
  });

  test('the price comes from the table, never from prose', () => {
    // MEMBERSHIP_TIERS moves prices without a deploy. Copy that restates a
    // price is copy that will one day contradict the server.
    const b = upgradeBlock({ tier: 'free', table: { ...TABLE, plus: { ...TABLE.plus, price_cents: 1200 } }, earned: 'asked' });
    assert.match(b, /\$12 a month/);
    assert.ok(!/8\.98/.test(b));
  });

  test('the benefits are read from entitlements, not written out by hand', () => {
    const g = gains(TABLE.free, TABLE.plus);
    assert.ok(g.some((x) => /25 plans at once, up from 3/.test(x)));
    assert.ok(g.some((x) => /40 deep-research runs a month, up from 3/.test(x)));
    assert.ok(g.some((x) => /new features before anyone else/.test(x)));
  });

  test('unlimited is said as unlimited, not as "null"', () => {
    const g = gains(TABLE.plus, TABLE.pro);
    assert.ok(g.some((x) => /unlimited plans/.test(x)), g.join(' | '));
    assert.ok(g.some((x) => /no monthly cap/.test(x)), g.join(' | '));
    assert.ok(!g.some((x) => /null/.test(x)));
  });

  test('it offers the NEXT tier up, not the most expensive one', () => {
    const b = upgradeBlock({ tier: 'free', table: TABLE, earned: 'asked' });
    assert.match(b, /Num Plus/);
    assert.ok(!/Num Pro is/.test(b), 'jumped straight to the top tier');
  });

  test('a Plus member is offered Pro', () => {
    const b = upgradeBlock({ tier: 'plus', table: TABLE, earned: 'asked' });
    assert.match(b, /Num Pro is \$28\.98/);
  });

  test('the action carries the tier id the checkout needs', () => {
    const b = upgradeBlock({ tier: 'free', table: TABLE, earned: 'asked' });
    assert.match(b, /`upgrade` action with tier "plus"/);
  });
});

/* ── the restraint ─────────────────────────────────────────────────────── */

describe('it says no by default', () => {
  test('THE DEFAULT IS SILENCE: no signal means do not offer', () => {
    // The whole design. Handed a price list and no rules, a model pitches on
    // every turn — which costs more trust than a subscription is worth.
    const b = upgradeBlock({ tier: 'free', table: TABLE, earned: null });
    assert.match(b, /DO NOT OFFER IT THIS TURN/);
    assert.ok(!/YOU MAY OFFER IT/.test(b));
  });

  test('an unrecognised signal is not a permission', () => {
    const b = upgradeBlock({ tier: 'free', table: TABLE, earned: 'because-i-feel-like-it' });
    assert.match(b, /DO NOT OFFER IT THIS TURN/);
  });

  test('each of the three real moments does grant it', () => {
    for (const reason of Object.keys(EARNED)) {
      const b = upgradeBlock({ tier: 'free', table: TABLE, earned: reason });
      assert.match(b, /YOU MAY OFFER IT THIS TURN/, `${reason} did not earn an offer`);
      assert.ok(b.includes(EARNED[reason]), `${reason} did not say WHY it was earned`);
    }
  });

  test('even when earned, the answer comes first and it is ONE line', () => {
    const b = upgradeBlock({ tier: 'free', table: TABLE, earned: 'limit' });
    assert.match(b, /AFTER you have fully answered/);
    assert.match(b, /ONE line/);
    assert.match(b, /If they do not take it, it does not come up again/);
  });

  test('THE LINE WE DO NOT CROSS: never when something is going wrong', () => {
    // A guest whose flight was cancelled is not a sales opportunity. If this
    // test ever goes, the product has stopped being what it claims to be.
    const b = upgradeBlock({ tier: 'free', table: TABLE, earned: 'win' });
    assert.match(b, /stressed, lost, ill, delayed/);
    assert.match(b, /emergency, medical, safety or money-trouble/);
  });

  test('never in the first exchange, never twice, never instead of an answer', () => {
    const joined = NEVER.join(' ');
    assert.match(joined, /first exchange/);
    assert.match(joined, /more than once in a conversation/);
    assert.match(joined, /never instead of one/);
  });

  test('the top tier gets NO block at all, not a block that says no', () => {
    // A section that is present but says "not now" invites the model to
    // negotiate with it. Absence cannot be argued with.
    assert.equal(upgradeBlock({ tier: 'pro', table: TABLE, earned: 'asked' }), null);
  });

  test('asking about price is always allowed, even unprompted', () => {
    const b = upgradeBlock({ tier: 'free', table: TABLE, earned: null });
    assert.match(b, /If they ask about price or plans themselves, answer straight/);
  });
});

/* ── the promise that must not break ───────────────────────────────────── */

describe('paying never unlocks travel', () => {
  test('the block restates the free-forever promise every time', () => {
    // B&P §17550.27 and the ungate() guard in membership.mjs. A sales block is
    // exactly where that promise would get quietly shaded.
    for (const earned of [null, 'limit', 'win', 'asked']) {
      const b = upgradeBlock({ tier: 'free', table: TABLE, earned });
      assert.match(b, /free forever and stay free/);
      assert.match(b, /never unlocks travel/);
    }
  });

  test('checkout is described as a sheet, never as a completed upgrade', () => {
    const b = upgradeBlock({ tier: 'free', table: TABLE, earned: 'asked' });
    assert.match(b, /charges nothing by itself/);
    assert.match(b, /never say they have upgraded/);
  });
});

/* ── wiring ────────────────────────────────────────────────────────────── */

describe('wiring', () => {
  test('the upgrade action exists and says when it may be used', () => {
    const types = REPLY_SCHEMA.properties.actions.items.properties.type.enum;
    assert.ok(types.includes('upgrade'), 'the model has no way to open checkout');
    const payload = REPLY_SCHEMA.properties.actions.items.properties.payload.description;
    assert.match(payload, /ONLY when the MEMBERSHIP block says you may offer it/);
    assert.match(payload, /CHARGES NOTHING by itself/);
  });

  test('the live turn defaults `earned` to null rather than trusting the client', () => {
    const src = readFileSync(join(ROOT, 'worker', 'index.mjs'), 'utf8');
    assert.match(src, /\['limit', 'win', 'asked'\]\.includes\(parsed\.earned\)/,
      'an arbitrary client string can now authorise a pitch');
  });

  test('a failure in the offer never takes the answer down', () => {
    const src = readFileSync(join(ROOT, 'worker', 'index.mjs'), 'utf8');
    const at = src.indexOf('upgradeFor(env, memberId');
    assert.ok(at > 0);
    assert.match(src.slice(at - 400, at + 400), /catch/, 'the upsell is not wrapped');
  });

  test('no block is rendered when there is nothing to offer', () => {
    const b = contextBlock({ place: { name: 'Los Angeles' }, membership: null });
    assert.ok(!/a month and adds/.test(b));
  });
});
