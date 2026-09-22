/**
 * The post-signup plans sheet, and the storefront it must never appear on.
 *
 * The commercial tests here matter. The COMPLIANCE ones matter more: an iOS
 * build that offers a Stripe subscription is App Store guideline 3.1.1, and
 * Num's iOS app was sitting at "1.0 Ready for Review" when this was written.
 * A welcome sheet is the loudest possible version of that offer, shown to
 * every new member on first run — which is exactly the screen a reviewer sees.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const SHEET = read('src/components/app/WelcomePlans.tsx');
const APP = read('src/components/app/ConciergeApp.tsx');
const CONCIERGE = read('src/lib/concierge.ts');
const WORKER = read('worker/index.mjs');

/* ── the storefront rule ───────────────────────────────────────────────── */

describe('it does not exist on iOS', () => {
  test('THE GATE: the sheet checks canOfferSubscription before anything else', () => {
    assert.match(SHEET, /import \{ canOfferSubscription \}/);
    const body = SHEET.slice(SHEET.indexOf('export default function WelcomePlans'));
    const gateAt = body.indexOf('canOfferSubscription()');
    const fetchAt = body.indexOf('fetch(');
    assert.ok(gateAt > 0, 'the sheet never checks the platform');
    assert.ok(gateAt < fetchAt, 'it fetches the price list before checking whether it may sell');
  });

  test('it returns null on iOS rather than rendering a softer version', () => {
    assert.match(SHEET, /if \(!selling\) return null;/);
  });

  test('THE THIRD DOOR: the concierge cannot offer a plan on iOS either', () => {
    // MembershipCard already hid the pricing ladder. The chat is a separate
    // way into the same shop, and a message offering a subscription is the
    // same 3.1.1 problem as a button — arguably worse, because nobody
    // reviewing the UI would ever see it.
    assert.match(CONCIERGE, /may_offer_subscription: canOfferSubscription\(\)/);
  });

  test('the SERVER defaults to silence, so an old build never gets a price list', () => {
    // === true, not a truthy check: an older client that never sends the field,
    // or a forged one that sends a string, gets no offer.
    assert.match(WORKER, /parsed\.may_offer_subscription === true/);
    assert.match(WORKER, /maySell \? await upgradeFor/);
  });
});

/* ── what it says ──────────────────────────────────────────────────────── */

describe('what it leads with', () => {
  test('it opens with what is free, not with what is locked', () => {
    const firstHeading = /<h2[^>]*>\s*([^<]+)/.exec(SHEET)?.[1] ?? '';
    assert.match(firstHeading, /free, forever/i, `opened with: ${firstHeading.trim()}`);
  });

  test('NO TRAVEL BENEFIT IS ADVERTISED ON ANY TIER', () => {
    // California B&P §17550.27(a)(1): a paid tier advertising travel access is
    // a "seller of travel discount program" and carries a $100,000 bond Num
    // cannot lawfully post. The benefit lines are derived from entitlements,
    // and the derivation must be incapable of producing a travel line.
    const fn = SHEET.slice(SHEET.indexOf('function raises'), SHEET.indexOf('export default'));
    for (const word of ['flight', 'fare', 'booking', 'priority', 'travel']) {
      assert.ok(!new RegExp(word, 'i').test(fn.replace(/\/\/.*$/gm, '')),
        `"${word}" can reach the benefit list — this is a compliance failure, not a copy nit`);
    }
  });

  test('prices are rendered from the server, never written into the file', () => {
    // MEMBERSHIP_TIERS moves without a deploy. A hard-coded price is a price
    // that will one day contradict the till.
    // Comments stripped first. RUNS.log, 12 Sep: "assert against code, never
    // against prose — your own explanation will satisfy your own grep." This
    // test failed on its own module header on the first run, which is the
    // third time that trap has been hit in this repo.
    const code = SHEET.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/8\.98|28\.98/.test(code), 'a price is hard-coded in the sheet');
    assert.match(SHEET, /api\/membership\/tiers/);
  });

  test('checkout asks for the plan and never names the amount', () => {
    // The server owns the price — this is what stopped fifty cents buying a
    // $28.98 membership.
    const call = SHEET.slice(SHEET.indexOf("'/api/membership/subscribe'"), SHEET.indexOf('window.location.href'));
    assert.match(call, /JSON\.stringify\(\{ me: me\.id, tier \}\)/);
    assert.ok(!/price|amount|cents/.test(call));
  });
});

/* ── the way out ───────────────────────────────────────────────────────── */

describe('saying no is easy', () => {
  test('the decline is full width and the same height as the buy buttons', () => {
    // A "no thanks" that is grey, tiny, or phrased as an insult is the
    // cheapest trick available and the one people remember.
    const out = SHEET.slice(SHEET.indexOf('Not now'));
    assert.match(SHEET, /Not now — start using Num/);
    assert.ok(!/fontSize: (9|10|11)[,}]/.test(out.slice(0, 400)), 'the decline is shrunk');
  });

  test('it is shown once, ever', () => {
    assert.match(SHEET, /const SEEN_KEY = 'num-welcome-plans-v1'/);
    assert.match(SHEET, /localStorage\.setItem\(SEEN_KEY, '1'\)/);
  });

  test('it is marked seen BEFORE the redirect, not after', () => {
    // Otherwise a member who pays and comes back is asked to subscribe again.
    const sub = SHEET.slice(SHEET.indexOf('if (out.url)'), SHEET.indexOf('setNote(out.error'));
    assert.ok(sub.indexOf('markSeen()') < sub.indexOf('window.location.href'));
  });

  test('a blocked localStorage means seen, never a sheet on every launch', () => {
    // Private mode throws. Failing closed shows it once and never again;
    // failing open shows it on every single launch, forever.
    const fn = SHEET.slice(SHEET.indexOf('export const seenWelcomePlans'), SHEET.indexOf('const markSeen'));
    assert.match(fn, /catch \{ return true; \}/);
  });
});

/* ── mounting ──────────────────────────────────────────────────────────── */

describe('mounting', () => {
  test('it is not shown to the demo state or to a signed-out visitor', () => {
    assert.match(APP, /if \(!me\?\.id \|\| demo\) return;/);
  });

  test('localStorage is read once on mount, not on every render', () => {
    assert.match(APP, /useEffect\(\(\) => \{[\s\S]{0,120}seenWelcomePlans\(\)/);
  });
});
