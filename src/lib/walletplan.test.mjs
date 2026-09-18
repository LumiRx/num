// An upsell for a door we do not open.
//
// canOfferSubscription() returns false on iOS, and every paid row in
// MembershipCard sits behind it. That gate is correct and is not in question:
// the App Review notes say in these words that there is "no purchase surface
// in the app" on iOS, "enforced in code, not by policy". Until 15 Aug that
// function existed and nothing called it, and the whole pricing ladder
// rendered on iOS after we had told Apple it could not.
//
// What was wrong was the half above the gate. The kicker read UPGRADE and the
// line under it promised "More plans, deeper research, new things first" —
// both unconditional. So a free member on iOS opened the wallet, read an
// advertisement, and found nothing beneath it to tap. Reported 18 Sep as
// "when clicking the wallet at the top it has plan and you can't click it".
//
// Rule: where upgrading is impossible, do not advertise it. State the plan.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CARD = readFileSync(new URL('../components/app/MembershipCard.tsx', import.meta.url), 'utf8');

describe('the wallet plan card', () => {
  test('the UPGRADE kicker is conditional on being able to upgrade', () => {
    assert.match(
      CARD,
      /current === 'free' && canOfferSubscription\(\) \? t\('UPGRADE'\) : t\('YOUR PLAN'\)/,
      'UPGRADE must not show where every paid row is hidden',
    );
  });

  test('the sales line is conditional too', () => {
    assert.match(CARD, /canOfferSubscription\(\)\s*\?\s*t\('More plans, deeper research, new things first\.'\)/,
      'the pitch belongs only where there is something to buy');
    assert.match(CARD, /t\('You are on the free plan, and everything you have used so far is part of it\.'\)/,
      'and a plain statement of the plan belongs where there is not');
  });

  test('the iOS gate itself is untouched', () => {
    // If this ever stops holding, the problem is far larger than a kicker.
    assert.match(CARD, /\{canOfferSubscription\(\) && \(/, 'the paid rows must stay behind the gate');
    assert.match(CARD, /if \(!me\?\.id \|\| !canOfferSubscription\(\)\) return;/, 'subscribe must stay gated');
  });

  test('no pointer to buy it somewhere else', () => {
    // Steering a member off-app to purchase is the other way to break the
    // promise made to App Review, and it would look like a helpful fix.
    const ios = CARD.slice(CARD.indexOf('You are on the free plan'), CARD.indexOf('You are on the free plan') + 400);
    assert.ok(!/itsnum\.com|https?:|on the web|visit |browser/i.test(ios),
      'the free-plan line must not point anywhere to purchase');
  });
});
