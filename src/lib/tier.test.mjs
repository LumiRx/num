// The upgrade nudge under a landed booking: one line, free tier only, never on
// iOS, and it promises nothing NUM does not deliver — no fee waiver (there is
// no member booking fee today), no travel perk (see MembershipCard header).
// Run: node --test src/lib/tier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tier = readFileSync(new URL('./tier.ts', import.meta.url), 'utf8');
const thread = readFileSync(new URL('../components/app/ThreadView.tsx', import.meta.url), 'utf8');
const member = readFileSync(new URL('../components/app/MembershipCard.tsx', import.meta.url), 'utf8');

const nudge = /export const NUDGE = '([^']+)'/.exec(tier)?.[1] ?? '';
const cta = /export const NUDGE_CTA = '([^']+)'/.exec(tier)?.[1] ?? '';

test('the nudge is one short line and makes no claim NUM cannot keep', () => {
  assert.ok(nudge.length > 0 && nudge.length <= 60, `nudge is ${nudge.length} chars`);
  assert.doesNotMatch(nudge, /fee|waiv|free booking|discount|lounge|upgrade to business|flight|hotel|priority/i);
  assert.doesNotMatch(cta, /fee|waiv/i);
});

test('shouldNudge: free tier on a selling platform only — unknown tier renders nothing', () => {
  const body = /export const shouldNudge = \([^)]*\)(?:: boolean)? => ([^;]+);/.exec(tier)?.[1];
  assert.ok(body, 'shouldNudge is exported as an arrow');
  const shouldNudge = new Function('tier', 'canOffer', `return (${body});`);
  assert.equal(shouldNudge('free', true), true);
  assert.equal(shouldNudge('free', false), false, 'iOS sells nothing');
  assert.equal(shouldNudge('plus', true), false);
  assert.equal(shouldNudge('pro', true), false);
  assert.equal(shouldNudge(null, true), false, 'no flash before the tier is known');
});

test('ThreadView shows it only under a landed booking card, behind the one iOS gate', () => {
  assert.match(thread, /import \{ canOfferSubscription \} from '\.\.\/\.\.\/lib\/native'/);
  assert.match(thread, /shouldNudge\(tier, canOfferSubscription\(\)\)/);
  assert.match(thread, /m\.card\.tag === 'confirmed' \|\| m\.card\.tag === 'hold' \|\| m\.card\.tag === 'deposit'/);
  assert.match(thread, /<UpgradeNudge \/>/);
  // The thread uses literals so the i18n scanner catalogues them; they must be
  // the very words tier.ts declares, or the two drift apart silently.
  assert.ok(thread.includes(`t('${nudge}')`), 'thread renders NUDGE verbatim through t()');
  assert.ok(thread.includes(`t('${cta}')`), 'thread renders NUDGE_CTA verbatim through t()');
  // No second gate: the component must not read the platform any other way.
  assert.doesNotMatch(thread, /nativePlatform\(\)\s*[!=]==?\s*'ios'/);
});

test('an in-place upgrade forgets the cached tier so the nudge stops at once', () => {
  assert.match(member, /import \{ forgetTier \} from '\.\.\/\.\.\/lib\/tier'/);
  const stars = member.indexOf('/api/membership/upgrade-with-stars');
  assert.ok(stars > 0);
  assert.ok(member.indexOf('forgetTier();', stars) > stars, 'forgetTier() runs after the stars upgrade succeeds');
});

test('tier.ts only ever opens the wallet — the plan ladder lives there, not in the thread', () => {
  assert.match(tier, /openPlans = \(\): void => store\.set\(\{ walletOpen: true \}\)/);
  assert.doesNotMatch(tier, /\bprice\b|\$\d|€|£/);
});
