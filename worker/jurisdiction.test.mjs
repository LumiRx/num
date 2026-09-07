/**
 * A licensed trade is offered ONLY where its licence is good.
 *
 * 6 Sep 2026. Num carries licensed cannabis retailers on the same terms as any
 * other business — and the one thing that cannot be left to a radius on a form
 * is jurisdiction. Cannabis is federally illegal in the US, so an LA shop
 * offered to a guest in Miami is not a bad recommendation, it is a federal
 * crime we routed. These tests exist so that can never be one edit away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DELIVERY_JURISDICTIONS, jurisdictionOf, allowedFor, deliveryBlock } from './delivery.mjs';
import { DESTINATIONS } from '../scripts/destinations.mjs';

test('every jurisdiction names a real destination, an authority and the date it was checked', () => {
  const slugs = new Set(DESTINATIONS.map((d) => d.slug));
  for (const [code, j] of Object.entries(DELIVERY_JURISDICTIONS)) {
    assert.ok(j.slugs.length, `${code} covers nowhere`);
    for (const s of j.slugs) assert.ok(slugs.has(s), `${code} names a destination that does not exist: ${s}`);
    assert.ok(j.age_min >= 21, `${code} must set an age floor of at least 21`);
    assert.match(j.authority, /\w{4}/, `${code} must name the regulator a person can check with`);
    assert.match(j.checked, /^\d{4}-\d{2}-\d{2}$/, `${code} must record when a person last read the rules`);
  }
});

test('California is open; nowhere else is, until somebody reads the rules and says so', () => {
  assert.equal(jurisdictionOf('los-angeles')?.code, 'US-CA');
  assert.equal(jurisdictionOf('orange-county')?.code, 'US-CA');
  assert.equal(jurisdictionOf('miami'), null, 'Florida was opened without a check');
  assert.equal(jurisdictionOf('new-york'), null);
  assert.equal(jurisdictionOf('bangkok'), null, 'a US licence can never reach Thailand');
  assert.equal(jurisdictionOf('london'), null);
  assert.equal(jurisdictionOf(''), null);
  assert.equal(jurisdictionOf(null), null);
  assert.equal(jurisdictionOf('LOS-ANGELES')?.code, 'US-CA', 'case must not decide legality');
});

test('the lookup fails closed on anything it does not recognise', () => {
  for (const junk of ['los-angeles-ish', 'us-ca', '../los-angeles', 'los angeles', undefined]) {
    assert.equal(jurisdictionOf(junk), null, `junk was treated as a jurisdiction: ${String(junk)}`);
  }
});

test('partnersNear refuses an unknown guest location before it reads a single row', () => {
  const src = readFileSync(new URL('./delivery.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function partnersNear'), src.indexOf('export function allowedFor'));
  const gate = fn.indexOf('const here = jurisdictionOf(dest);');
  const query = fn.indexOf('SELECT b.id AS business_id');
  assert.ok(gate !== -1 && gate < query, 'the jurisdiction gate must come before the query, not after');
  assert.match(fn, /if \(!here\) return \[\];/, 'no jurisdiction must mean no partners');
  assert.match(fn, /theirs\.code !== here\.code/, 'a partner from another jurisdiction must be skipped');
});

test('the age floor is the jurisdiction’s, and a partner can only be stricter', () => {
  const src = readFileSync(new URL('./delivery.mjs', import.meta.url), 'utf8');
  assert.match(src, /age_min: Math\.max\(Number\(f\.age_min\) \|\| 0, here\.age_min \|\| 0\)/,
    'a partner that sets 0 must still inherit the jurisdiction floor');
});

test('an age-restricted partner still needs a verified guest, and never reaches a hosted member', () => {
  const partners = [{ business_id: 'b1', name: 'Shop', age_min: 21, jurisdiction: 'US-CA' }];
  assert.deepEqual(allowedFor(partners, { member: { identity_verified: 0 }, hasHost: false }), []);
  assert.equal(allowedFor(partners, { member: { identity_verified: 1 }, hasHost: false }).length, 1);
  assert.deepEqual(allowedFor(partners, { member: { identity_verified: 1 }, hasHost: true }), [],
    'a guest with a host is looked after by their host');
});

test('the brain is told it may never move anything between places', () => {
  const block = deliveryBlock([{
    business_id: 'b1', name: 'LA Cannabis Club', category: 'Cannabis Delivery', km: 1.2,
    fee_cs: 500, age_min: 21, hours: 'Daily 10–21', licence: 'C9-0000123',
    items: [{ id: 'i1', name: 'Sample', price_cs: 2000, unit: 'item' }],
  }]);
  assert.match(block, /licensed where this guest is/);
  assert.match(block, /never discuss carrying anything between cities or states/);
  assert.match(block, /21\+ only/);
  assert.match(block, /licence C9-0000123/);
  assert.match(block, /offer ONLY when the guest asks/);
});

test('a cannabis submission without its licence is refused, with a sentence a person can act on', async () => {
  const { __testables } = await import('./bizsubmit.mjs').then((m) => ({ __testables: m })).catch(() => ({}));
  const src = readFileSync(new URL('./bizsubmit.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(input\.regulated && !clean\(input\.licence, 60\)\)/,
    'a licensed trade must not be able to submit without its licence');
  assert.match(src, /needs its licence number before we can list it/);
  assert.match(src, /regulated: input\.regulated \? 'cannabis' : null/);
});
