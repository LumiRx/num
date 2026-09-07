/**
 * The courier a business does not have to own — and the two rules that keep
 * it from hurting somebody.
 *
 * The cannabis refusal is the one to read first. It is not a policy note, it
 * is a code path, because the failure it prevents is a licensed dispensary
 * dispatching a courier who refuses the pickup with a paid order on the
 * counter and a guest waiting.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eligible, driveRequest, quoteFor, dispatch, totalWithCourier, COURIER_REFUSES } from './courier.mjs';

const ENV = { DOORDASH_DEVELOPER_ID: 'a', DOORDASH_KEY_ID: 'b', DOORDASH_SIGNING_SECRET: 'c' };
const SHOP = { id: 'b1', name: 'Kata Flowers', address: '12 Kata Rd, Phuket', phone: '+66 76 000 000' };
const ORDER = { id: 'o1', short_code: 'K204', status: 'accepted', address: '4 Beach Rd', subtotal_cs: 3400, note: 'ring twice' };

describe('THE CANNABIS RULE IS CODE, NOT A FOOTNOTE', () => {
  test('a licensed dispensary is refused before a quote is ever requested', () => {
    const r = eligible({ env: ENV, business: { ...SHOP, regulated: 'cannabis' }, order: ORDER });
    assert.equal(r.ok, false);
    assert.equal(r.regulated, true);
    assert.match(r.why, /won’t carry cannabis/);
    // And it says what DOES work, rather than only what does not.
    assert.match(r.why, /your own driver/);
  });

  test('it refuses on the trade, not on the wording of the local law', () => {
    // Legal in California, legal in Bangkok, still refused — because the
    // courier's terms are the binding constraint, not the statute.
    for (const reg of ['cannabis', 'CANNABIS', 'Cannabis']) {
      assert.equal(eligible({ env: ENV, business: { ...SHOP, regulated: reg }, order: ORDER }).ok, false, reg);
    }
    assert.deepEqual([...COURIER_REFUSES], ['cannabis']);
  });

  test('an ordinary shop is not caught by it', () => {
    assert.equal(eligible({ env: ENV, business: SHOP, order: ORDER }).ok, true);
    assert.equal(eligible({ env: ENV, business: { ...SHOP, regulated: null }, order: ORDER }).ok, true);
  });
});

describe('what has to be true before a courier moves', () => {
  test('an unaccepted order cannot summon one', () => {
    const r = eligible({ env: ENV, business: SHOP, order: { ...ORDER, status: 'pending_business' } });
    assert.equal(r.ok, false);
    assert.match(r.why, /Accept the order first/);
  });

  test('preparing still can — the courier is for an order already committed to', () => {
    assert.equal(eligible({ env: ENV, business: SHOP, order: { ...ORDER, status: 'preparing' } }).ok, true);
  });

  test('a missing pickup address or phone is explained, not greyed out', () => {
    // A disabled button with no reason is how a partner decides the feature
    // is broken and stops looking.
    assert.match(eligible({ env: ENV, business: { ...SHOP, address: null }, order: ORDER }).why, /pickup address/);
    assert.match(eligible({ env: ENV, business: { ...SHOP, phone: null }, order: ORDER }).why, /phone number/);
  });

  test('with DoorDash unconfigured it says so kindly and points at the fallback', () => {
    const r = eligible({ env: {}, business: SHOP, order: ORDER });
    assert.equal(r.ok, false);
    assert.match(r.why, /own driver still works/);
  });
});

describe('the money', () => {
  test('the courier fee REPLACES the shop’s own fee — never stacks on it', () => {
    // One journey, one delivery fee. A guest charged the shop's $5 and the
    // courier's $9 for the same trip has been charged twice and would be
    // right to say so.
    const t = totalWithCourier({ subtotal_cs: 3400, delivery_fee_cs: 500, courier_fee_cs: 975 });
    assert.equal(t.delivery_fee_cs, 975);
    assert.equal(t.total_cs, 3400 + 975);
  });

  test('with no courier the shop’s own fee stands', () => {
    const t = totalWithCourier({ subtotal_cs: 3400, delivery_fee_cs: 500, courier_fee_cs: 0 });
    assert.equal(t.total_cs, 3900);
    assert.equal(t.courier_fee_cs, 0);
  });

  test('commission is charged on GOODS ONLY, as it always has been', () => {
    const t = totalWithCourier({ subtotal_cs: 3400, delivery_fee_cs: 500, courier_fee_cs: 975 });
    assert.equal(t.commissionable_cs, 3400);
    // Marking up a courier would make the honest option the expensive one and
    // send the business back to turning delivery orders away.
    assert.ok(t.commissionable_cs < t.total_cs);
  });

  test('nonsense numbers cannot produce a negative total', () => {
    const t = totalWithCourier({ subtotal_cs: -5, delivery_fee_cs: NaN, courier_fee_cs: '  ' });
    assert.equal(t.total_cs, 0);
  });
});

describe('the Drive payload', () => {
  const req = driveRequest({ business: SHOP, order: ORDER, reference: 'num_o1' });

  test('pickup is the shop, dropoff is the guest, and the order can be found', () => {
    assert.equal(req.pickup_address, '12 Kata Rd, Phuket');
    assert.equal(req.dropoff_address, '4 Beach Rd');
    assert.match(req.pickup_instructions, /K204/);
    assert.equal(req.external_delivery_id, 'num_o1');
  });

  test('the declared value is the GOODS, not the goods plus the delivery', () => {
    // Declaring the fee too would be insuring the delivery of the delivery.
    assert.equal(req.order_value, 3400);
  });

  test('the courier always has a number to ring', () => {
    assert.equal(driveRequest({ business: SHOP, order: { ...ORDER, phone: null }, reference: 'x' }).dropoff_phone_number, SHOP.phone);
  });
});

describe('when the vendor says no', () => {
  const noQuote = { ...ENV };

  test('a refused quote never shows the vendor’s words to a partner', async () => {
    // Same rule as the guest side: our partners read our sentences, not
    // DoorDash's error envelope.
    const out = await quoteFor(noQuote, { business: { ...SHOP, regulated: 'cannabis' }, order: ORDER });
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.why, /error|HTTP|\{|null|undefined/i);
  });

  test('dispatch refuses without a quote — no courier without a price seen first', async () => {
    const out = await dispatch(ENV, { business: SHOP, order: ORDER, quoteId: null });
    assert.equal(out.ok, false);
    assert.match(out.why, /Get a quote first/);
  });
});

describe('the file itself', () => {
  const SRC = readFileSync(new URL('./courier.mjs', import.meta.url), 'utf8');
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('there is no markup applied to the courier fee anywhere', () => {
    assert.doesNotMatch(code, /fee_cs\s*\*\s*[\d.]/);
    assert.doesNotMatch(code, /markup|margin/i);
  });

  test('the eligibility gate runs before every vendor call', () => {
    for (const fn of ['quoteFor', 'dispatch']) {
      const at = code.indexOf(`export async function ${fn}`);
      const body = code.slice(at, at + 300);
      assert.match(body, /const gate = eligible\(/, fn);
    }
  });
});
