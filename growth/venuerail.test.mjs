/**
 * venuerail — the venue payment rail picker.
 *
 * 12 Sep 2026. The console offered a venue exactly two ways to say where its
 * money should go: PromptPay, which only exists in Thailand, and a USDC wallet.
 * Meanwhile the sales team was selling the QR in Los Angeles and Edinburgh, and
 * `venue_pay.module.js` had said from the start that the primary rail was "a
 * payment URL they already have (Stripe / PayPal / Square / SumUp link)".
 *
 * The `url` rail was built, validated and rendered on the guest page the whole
 * time. It was simply absent from the dropdown, so an owner outside Thailand
 * reached "Where should your money go?", found nothing usable, and stopped —
 * and nothing downstream can happen without that row: no sticker, no bill code,
 * no amount, no commission.
 *
 * These tests guard the two ways that regresses: the rail disappearing from the
 * picker, and the currency going back to a silent THB default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CURRENCY_BY_COUNTRY } from '../worker/commission.mjs';

const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

/**
 * Build the country→rail table the way the worker builds it.
 *
 * ── WHY THIS NO LONGER PARSES A LITERAL ──────────────────────────────────
 * It used to regex a hand-written `RAIL_BY_COUNTRY = Object.freeze({ TH: {...}
 * })` out of the source. On 12 Sep 2026 that table was refactored into a
 * COMPUTED one — derived from CURRENCY_BY_COUNTRY in worker/commission.mjs,
 * so a venue can never be quoted in one currency and invoiced in another —
 * and these three tests started failing on a change that made the code
 * better. The tests were reading the source's shape rather than its meaning.
 *
 * So the table is composed here from the same two inputs the worker composes
 * it from: the currency map (imported, the real one) and the kind overrides
 * (still a literal, still read from source, because that is the line a
 * careless edit would put PromptPay on the wrong country from).
 */
function railTable() {
  const m = worker.match(/const RAIL_KIND_BY_COUNTRY = Object\.freeze\(\{([^}]*)\}\)/);
  assert.ok(m, 'RAIL_KIND_BY_COUNTRY is gone — every venue is back to guessing');
  const kinds = {};
  for (const e of m[1].matchAll(/([A-Z]{2}):\s*"(\w+)"/g)) kinds[e[1]] = e[2];

  assert.match(worker, /kind: RAIL_KIND_BY_COUNTRY\[cc\] \|\| "url"/,
    'the default rail is no longer the one that works anywhere');

  const out = {};
  for (const [cc, currency] of Object.entries(CURRENCY_BY_COUNTRY)) {
    out[cc] = { kind: kinds[cc] || 'url', currency };
  }
  assert.ok(Object.keys(out).length >= 3, 'the rail table composed as almost empty');
  return out;
}

test('PromptPay is offered to Thailand and to nowhere else', () => {
  const t = railTable();
  assert.equal(t.TH.kind, 'promptpay', 'Thailand lost the only rail its banks speak');
  for (const [cc, r] of Object.entries(t)) {
    if (cc === 'TH') continue;
    assert.notEqual(r.kind, 'promptpay',
      `${cc} is being offered a Thai-only rail — this is the bug that stopped LA and Edinburgh`);
  }
});

test('the countries the team is actually selling in are covered', () => {
  const t = railTable();
  // US and GB are not hypothetical: LA Cannabis Club, Arroyo del Sol,
  // Holiday Inn Express Edinburgh and Morrisons Lounge are all live rows.
  assert.equal(t.US.kind, 'url');
  assert.equal(t.US.currency, 'USD');
  assert.equal(t.GB.kind, 'url');
  assert.equal(t.GB.currency, 'GBP');
});

test('no country is set up to bill its guests in the wrong currency', () => {
  const t = railTable();
  assert.equal(t.TH.currency, 'THB');
  for (const [cc, r] of Object.entries(t)) {
    if (cc === 'TH') continue;
    assert.notEqual(r.currency, 'THB',
      `${cc} would bill in Thai baht — setIdentity falls back to THB, so this is silent`);
  }
});

test('an unknown country falls to the rail that works anywhere, never to PromptPay', () => {
  const m = worker.match(/function railFor\(country\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'railFor is gone');
  assert.match(m[1], /kind:\s*"url"/, 'the fallback must be the venue\'s own payment page');
  assert.ok(!/promptpay/.test(m[1]), 'an unknown country must never be handed a Thai-only rail');
});

test('the console offers the payment-page rail, in words an owner understands', () => {
  assert.match(worker, /url:'My own payment page/,
    'the url rail is missing from the picker — this is the whole bug');
  assert.match(worker, /promptpay:'PromptPay/);
  assert.match(worker, /crypto:'USDC on Base/);
});

test('the rail that fits the venue goes first in the list', () => {
  assert.match(worker, /var first=j\.suggest_kind\|\|'url'/,
    'the picker ignores the suggestion, so the default is wrong again');
  assert.match(worker, /order=\[first\]\.concat/);
});

test('the identity endpoint tells the console which country the venue is in', () => {
  assert.match(worker, /SELECT country FROM num_business_profiles WHERE business_id = \?1/);
  assert.match(worker, /suggest_kind: suggest\.kind/);
  assert.match(worker, /suggest_currency: suggest\.currency/);
});

test('currency travels with both the check and the save', () => {
  // Two calls, and the second is the one that writes. A currency on the
  // preview and not on the confirm looks right on screen and stores THB.
  const calls = worker.match(/post\('\/api\/venue\/identity',\{[^}]*\}/g) || [];
  assert.equal(calls.length, 2, 'the identity screen no longer makes exactly two calls');
  for (const c of calls) {
    assert.match(c, /currency:cur\.value/, `a call omits the currency: ${c}`);
  }
});

test('a payment page is verified by opening it, not by scanning a QR of it', () => {
  assert.match(worker, /a payment page has no QR to preview/,
    'the preview still answers "bad id" for a perfectly good URL');
  assert.match(worker, /Open my payment page and check it is mine/);
});

test('the saved-identity card can describe a payment page', () => {
  // It used to say "Paid bank to bank, straight into this account" whatever
  // the rail was, which is false for a Stripe link and alarming for a wallet.
  assert.match(worker, /Guests are sent straight to this page to pay you/);
});

/* ── a venue is never quoted in somebody else's money ─────────────────────
 * Every paylink creator fell back to the literal "THB" when the caller sent no
 * currency — and the /biz/pay form has no currency field and posts none, so an
 * LA or Edinburgh venue's fixed-amount code was stored in baht and rendered to
 * their guest as a 34px "THB 45.00".
 *
 * The identity picker on /biz/tables already had a comment apologising for this
 * exact failure; the fix had landed on one creation surface and not the other
 * two, and the picker's own server-side fallback was still THB.
 *
 * Verified by putting "THB" back and watching this fail. */
test('no paylink creator falls back to a hardcoded currency', () => {
  const code = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const falls = [...code.matchAll(/PAY_CURRENCIES\.includes\([\s\S]{0,120}?:\s*([^;]+);/g)];
  assert.ok(falls.length >= 3, `expected every creator; found ${falls.length}`);
  for (const m of falls) {
    assert.doesNotMatch(m[1], /["']THB["']/,
      'a hardcoded baht fallback bills a London venue in Thai baht: ' + m[1].trim());
    assert.match(m[1], /currencyForVenue\(env,/,
      'the fallback has to come from the venue, not from wherever we launched first');
  }
});

test('the venue currency comes from its country and falls to USD', () => {
  const i = worker.indexOf('async function currencyForVenue');
  assert.ok(i > 0, 'the helper must exist');
  const fn = worker.slice(i, worker.indexOf('\n}\n', i));
  assert.match(fn, /FROM num_business_profiles/, 'read the country we hold for them');
  assert.match(fn, /railFor\(/, 'and reuse the rail table rather than a second mapping that can drift');
  // railFor's own default, read from the source rather than imported — this
  // file cannot import worker.js. Asserted because the entire bug was a default
  // that assumed everyone was where we happened to launch first.
  const rf = worker.slice(worker.indexOf('function railFor(country)'));
  assert.match(rf.slice(0, 220), /currency: "USD"/,
    'an unknown country is far likelier to be anywhere than Thailand');
});
