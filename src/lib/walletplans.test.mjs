/**
 * The plans on the wallet, seen from the app.
 *
 * Reads the source rather than rendering it, like starsgate.test.mjs, because
 * the promises here are facts about the file: WHICH component owns the pricing
 * ladder, and WHEN it is allowed to mount.
 *
 * Two mistakes are being pinned, both of which we have actually made:
 *
 *  1. A second pricing ladder. On 15 Aug 2026 canOfferSubscription() existed
 *     and nothing called it, so the whole ladder rendered on iOS after we had
 *     told App Review the app sells no digital content. The wallet must
 *     RENDER MembershipCard, not rebuild the tiers, so that gate is inherited
 *     rather than re-decided.
 *  2. Work done while nobody is looking. WalletSheet never unmounts — it hides
 *     with `visibility: hidden` and a transform — so an unguarded child fetches
 *     on every app load, for the nine launches in ten where the wallet is
 *     never opened. Against a rate limiter that already answers 429 under
 *     light load, that is three wasted requests per cold start.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../components/app/WalletSheet.tsx', import.meta.url), 'utf8');
// Comments must come out WHOLE, not line-by-line: the rationale above the
// packs block names canOfferSubscription() in prose, and a per-line filter
// keeps the middle lines of a block comment, so counting calls would count
// the explanation of them too.
const code = SRC
  .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

describe('the wallet shows the plans', () => {
  test('a member can buy a plan from the sheet they opened to spend on', () => {
    assert.match(code, /^import MembershipCard from '\.\/MembershipCard';$/m);
    assert.match(code, /<MembershipCard \/>/);
  });

  test('the ladder is rendered, never rebuilt here', () => {
    // No tier, no price, no membership call of its own. If any of these ever
    // appear in this file, someone has started a second ladder and the gate
    // above it is no longer the one MembershipCard carries.
    assert.doesNotMatch(code, /\/api\/membership/);
    assert.doesNotMatch(code, /num plus|num pro/i);
    assert.doesNotMatch(code, /\b(?:898|2898)\b/);
  });
});

describe('it only works while it is open', () => {
  test('MembershipCard mounts behind the open guard', () => {
    const at = code.indexOf('<MembershipCard />');
    assert.ok(at > 0, 'the card is rendered');
    const before = code.slice(0, at);
    assert.match(
      before.slice(before.lastIndexOf('{open')),
      /^\{open && \(/,
      'the card must sit directly inside `{open && (…)}` — it fetches three endpoints on mount',
    );
  });

  test('the guard is load-bearing because this sheet hides instead of unmounting', () => {
    // Stated as the implication, so the day someone makes the sheet unmount
    // for real this test stops demanding the guard instead of lying about why.
    const hides = /visibility: open \? 'visible' : 'hidden'/.test(code);
    if (hides) {
      assert.match(code, /\{open && \([\s\S]{0,200}<MembershipCard \/>/);
    }
  });
});

describe('the iOS promise is inherited, not re-decided', () => {
  test('the gate on the plans is MembershipCard’s own', () => {
    // The packs block has its own canOfferSubscription() call, and should:
    // $500–$5,000 of Stars is a sale this file makes itself. The plans block
    // must NOT add one, because MembershipCard shows a free member their
    // current tier on every platform and gates only the paid rows. A second
    // gate here would hide that, and a second gate is how the first mistake
    // happened.
    const at = code.indexOf('<MembershipCard />');
    const block = code.slice(code.lastIndexOf('{open', at), at);
    assert.doesNotMatch(block, /canOfferSubscription/);
    // Two uses, both about SELLING, neither on the plans: the packs block, and
    // the "Top-ups opening soon" line under payment methods (App Review 3.1.1,
    // 21 Sep 2026 — a promise of a sale is a sale surface too).
    assert.equal((code.match(/canOfferSubscription\(\)/g) ?? []).length, 2, 'two gates in this file: the packs and the top-ups line');
  });
});
