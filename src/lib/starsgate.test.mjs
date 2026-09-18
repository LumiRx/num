/**
 * The Stars upgrade, seen from the app.
 *
 * These read the component source rather than rendering it, for the same
 * reason connections.test.mjs does: the promise being kept here is about WHICH
 * gate the button sits behind, and that is a fact about the file.
 *
 * The gate is not a preference. Our App Review notes say, in these words, that
 * there is no purchase surface in the app on iOS and that this is enforced in
 * code. Stars buying a membership is a sale of a digital service. If it
 * rendered on iOS we would have told Apple something untrue — the exact
 * mistake that was already made once, in Aug 2026, when canOfferSubscription()
 * existed and nothing called it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../components/app/MembershipCard.tsx', import.meta.url), 'utf8');
// Comments come out WHOLE, not line by line: this file explains its own
// history in prose — the link that used to hide the ladder, the badge wording
// we refuse to use — and a per-line filter keeps the middle lines of a block,
// so a test for "that string is gone" would match the note saying it is gone.
const code = SRC
  .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

describe('the iOS gate', () => {
  test('the Star price is never even FETCHED unless selling is allowed here', () => {
    const eff = code.slice(code.indexOf('/api/membership/stars') - 400, code.indexOf('/api/membership/stars'));
    assert.match(eff, /canOfferSubscription\(\)/);
  });

  test('the Stars button lives inside the same block as the card button', () => {
    // 18 Sep 2026: the ladder stopped being folded behind "SEE WHAT MORE ROOM
    // COSTS" — nobody buys what they cannot see — so the gate is now the
    // whole block's only condition rather than `open || not free`. The
    // promise being kept is unchanged: both sale buttons sit inside it.
    const gate = code.indexOf('{canOfferSubscription() && (');
    assert.ok(gate > 0, 'the pricing ladder gate is still there');
    assert.ok(code.indexOf('subscribe(tr.id)') > gate, 'the card button is inside it');
    assert.ok(code.search(/payWithStars\((?:t|tr)\.id\)/) > gate, 'the Stars button is inside it');
  });

  test('the ladder is on screen, not folded behind a link', () => {
    // The regression this guards is a product one: a pricing wall that opens
    // as a grey link reading "see what more room costs" sells nothing.
    assert.doesNotMatch(code, /SEE WHAT MORE ROOM COSTS/);
    assert.match(code, /badgeOf\(tr\)/, 'each tier carries its badge');
  });

  test('no invented social proof on a badge', () => {
    // "Most popular" on a plan that has barely sold is a small lie, and this
    // product does not print one.
    assert.doesNotMatch(code, /most popular|most picked|recommended|best value/i);
  });

  test('every purchase path in this file is gated — no unguarded sale exists', () => {
    for (const call of ['/api/membership/subscribe', '/api/membership/upgrade-with-stars', '/api/membership/stars']) {
      assert.ok(code.includes(call), `${call} is wired`);
    }
    const gates = (code.match(/canOfferSubscription\(\)/g) ?? []).length;
    assert.ok(gates >= 3, `expected the sale surfaces to each carry the gate, found ${gates}`);
  });
});

describe('the client never names a price', () => {
  test('the upgrade body sends the plan and the months, and nothing about money', () => {
    const at = code.indexOf('/api/membership/upgrade-with-stars');
    const body = code.slice(at, at + 500);
    const sent = body.slice(body.indexOf('JSON.stringify({'), body.indexOf('}),'));
    // The KEYS are the contract. `idem` happens to contain the word "stars"
    // because it names the button that made it, which is not a price. `tier`
    // is shorthand, so it carries no colon and is checked on its own.
    const keys = [...sent.matchAll(/([a-z_]+):/g)].map((m) => m[1]);
    assert.deepEqual(keys, ['me', 'months', 'idem'], 'plus `tier`, which is shorthand');
    assert.match(sent, /\btier\b/);
    assert.doesNotMatch(sent, /price|cents|amount|stars:/);
  });

  test('the Star cost is read from the server answer, never computed', () => {
    assert.match(code, /wallet\?\.star_tiers\?\.find/);
    assert.doesNotMatch(code, /28\.5|price_cents\s*\/\s*\d/);
  });
});

describe('what the member is told', () => {
  test('a member who cannot afford it still sees the price, not a blank space', () => {
    assert.match(code, /you have ★\{wallet\?\.spendable \?\? 0\} to spend/);
  });

  test('the welcome gift being unspendable is explained where it applies', () => {
    assert.match(code, /welcome gift/);
  });

  test('it says plainly that Star months do not renew', () => {
    assert.match(code, /nothing renews on its own and no card is stored/);
  });
});
