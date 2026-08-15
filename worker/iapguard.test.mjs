// Apple guideline 3.1.1 — nothing that is digital content may be sold in the
// iOS app outside IAP.
//
// Found 15 Aug while checking publish-readiness: `STARS_SALE_OK=1` is live and
// the wallet rendered $150–$1,425 Star packs on every platform. Stars are spent
// INSIDE the app (errands, tabs, bounties), so they are digital content. Our
// own App Review notes say "The app sells NO digital content and offers NO
// subscriptions on iOS" — a reviewer would have read that sentence with the
// packs on screen. The rejection is the small cost; the false statement to
// App Review is the large one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, '..', 'src', p), 'utf8');

test('Star packs are not offered on iOS', () => {
  const wallet = src('components/app/WalletSheet.tsx');
  assert.match(wallet, /import \{ canOfferSubscription \}/,
    'the wallet no longer imports the platform gate');
  const gate = wallet.indexOf('canOfferSubscription()');
  const packs = wallet.indexOf('buyPack(');
  assert.ok(gate > 0 && gate < packs,
    'the top-up panel renders before the iOS gate — Star packs are for sale on iOS again');
});

test('the gate is one function, not a second opinion', () => {
  // Membership and Stars must answer "may we sell here" identically. Two
  // notions of it means one of them gets updated and the other ships.
  const native = src('lib/native.ts');
  assert.match(native, /canOfferSubscription = \(\): boolean => nativePlatform\(\) !== 'ios'/,
    'the platform gate changed shape — re-check both the wallet and the membership card');
  const card = src('components/app/MembershipCard.tsx');
  assert.match(card, /canOfferSubscription/, 'the membership card lost its gate');
  // Both sale surfaces in the card — the teaser and the paid rows — must be
  // behind it. Gating only one leaves a live "SEE WHAT MORE ROOM COSTS" on iOS.
  assert.match(card, /current === 'free' && canOfferSubscription\(\)/,
    'the upgrade teaser renders on iOS');
  assert.match(card, /\(open \|\| current !== 'free'\) && canOfferSubscription\(\)/,
    'the priced tier rows render on iOS');
});

test('what we told App Review is what the code does', () => {
  // The submission notes name this exact function as the enforcement. If the
  // notes and the code ever disagree again, this fails before a reviewer sees it.
  const card = src('components/app/MembershipCard.tsx');
  const wallet = src('components/app/WalletSheet.tsx');
  for (const [name, file] of [['membership', card], ['wallet', wallet]]) {
    assert.ok(file.includes('canOfferSubscription()'),
      `${name}: App Review was told this surface is gated in code and it is not`);
  }
});

test('the cash-out and balance panels still show everywhere', () => {
  // Hiding the WALLET on iOS would be over-correction: a balance and a ledger
  // are not a sale, and a traveller who earned Stars must still see them.
  const wallet = src('components/app/WalletSheet.tsx');
  const gateEnd = wallet.indexOf('EARNED — the money side');
  assert.ok(gateEnd > wallet.indexOf('canOfferSubscription()'),
    'the earned/cash-out panel was swept inside the iOS gate — earned Stars would vanish on iOS');
});
