// Offers on a job: who is offering, and when it becomes real.
//
// Two rules carry the weight. A job is confirmed only once the money has
// actually settled — a "confirmed" that a member has not paid for, or that a
// host has not been paid for, is the worst state this product can produce,
// because both plan around it and one of them is wrong. And an agent says it
// is an agent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEE_MAX_MINOR, FEE_MIN_MINOR, PARTY, canConfirm, humanProof, offerCard, quote,
} from './hostoffers.mjs';

const job = (o = {}) => ({ id: 'j1', status: 'open', price_minor: 10000, currency: 'GBP', ...o });
// A real payment covers the GROSS — the host's 10000 plus Num's 500 fee — not
// the host's price. `quote(10000).total`, spelled out so the relationship is
// visible in the fixture rather than hidden in a number.
const pay = (o = {}) => ({ status: 'succeeded', amount_minor: 10500, currency: 'GBP', ...o });

describe('payment settles, then it is confirmed', () => {
  test('a settled payment for the quoted amount confirms', () => {
    const out = canConfirm(job(), pay());
    assert.equal(out.ok, true);
    assert.equal(out.host, 10000, 'the host is owed their price in full');
    assert.equal(out.fee, 500);
    assert.equal(out.total, 10500, 'what the poster owed');
    assert.equal(out.paid, 10500);
  });

  test('an overpaying poster does not enlarge NUM\'s fee', () => {
    // Deriving the split from what arrived would both pocket the extra and
    // charge 5% on a gross that already contained a fee.
    const out = canConfirm(job(), pay({ amount_minor: 20000 }));
    assert.equal(out.ok, true);
    assert.equal(out.host, 10000);
    assert.equal(out.fee, 500, 'the fee follows the quote, not the payment');
    assert.equal(out.paid, 20000);
  });

  test('no payment at all is not a confirmation', () => {
    const out = canConfirm(job(), null);
    assert.equal(out.ok, false);
    assert.match(out.why, /confirmed once it is paid/);
  });

  test('money merely HELD is not money taken', () => {
    // requires_capture is the dangerous one: it reads like success in a
    // dashboard and no money has moved.
    const out = canConfirm(job(), pay({ status: 'requires_capture' }));
    assert.equal(out.ok, false);
    assert.match(out.why, /not settled/);
  });

  test('every unknown payment state is a no', () => {
    for (const s of ['processing', 'requires_action', 'canceled', 'failed', '', null, undefined]) {
      assert.equal(canConfirm(job(), pay({ status: s })).ok, false, `${s} was treated as paid`);
    }
  });

  test('a refund un-confirms, whatever the status says', () => {
    assert.equal(canConfirm(job(), pay({ refunded_at: '2026-09-12' })).ok, false);
  });

  test('underpaying does not confirm', () => {
    assert.equal(canConfirm(job(), pay({ amount_minor: 5000 })).ok, false);
    assert.equal(canConfirm(job(), pay({ amount_minor: 10500 })).ok, true);
  });

  test('paying only the host\'s price does not confirm', () => {
    // 10000 covers the host and not Num. Accepting it would leave the fee to
    // come out of the host after all — the exact outcome poster-pays exists to
    // prevent, arriving quietly through the confirm path instead of the split.
    const out = canConfirm(job(), pay({ amount_minor: 10000 }));
    assert.equal(out.ok, false, 'the fee would have been taken from the host');
    assert.match(out.why, /Less was paid/);
  });


  test('a payment in another currency is not this payment', () => {
    const out = canConfirm(job(), pay({ currency: 'USD' }));
    assert.equal(out.ok, false);
    assert.match(out.why, /different currency/);
  });

  test('a job that is already gone cannot be confirmed again', () => {
    for (const s of ['matched', 'withdrawn', 'expired']) {
      assert.equal(canConfirm(job({ status: s }), pay()).ok, false);
    }
  });

  test('the reason is always said, because "not yet" sends a host elsewhere', () => {
    for (const p of [null, pay({ status: 'failed' }), pay({ refunded_at: 'x' }), pay({ amount_minor: 1 })]) {
      const out = canConfirm(job(), p);
      assert.equal(out.ok, false);
      assert.ok(out.why && out.why.length > 12, 'a refusal with no reason');
    }
  });
});

describe('what NUM keeps — and who pays it', () => {
  // The fee is ADDED to the host's price, never taken out of it. Num's host
  // welcome email promises "no commission on your work, no cut of anything you
  // arrange", and a deduction would have broken that on the day the board
  // shipped. Dre's call, 12 Sep 2026: the poster pays on top.

  test('the host is paid their price IN FULL and the poster pays the fee', () => {
    assert.deepEqual(quote(10000), { host: 10000, fee: 500, total: 10500 });
  });

  test('THE REGRESSION: the fee is never deducted from the host', () => {
    // The shape this replaces was { total: 10000, fee: 500, host: 9500 } — a
    // host quoting 100 receiving 95. If `host` ever comes back less than what
    // was asked for, Num is taking a commission on their work again.
    for (const price of [1, 99, 100, 4321, 99999, 250000, 10000000]) {
      const q = quote(price);
      assert.equal(q.host, price, `the host was short-changed at ${price}`);
      assert.equal(q.total, q.host + q.fee, `the arithmetic lost money at ${price}`);
      assert.ok(q.total >= price, 'the poster must cover the host in full');
    }
  });

  test('floored, so it does not cost more to collect than it collects', () => {
    assert.equal(quote(20000).fee, 1000, '5% where 5% clears the floor');
    assert.equal(quote(200).fee, FEE_MIN_MINOR);
  });

  test('capped, so NUM has no interest in the size of a job it is not doing', () => {
    // The same reason the host-to-host network fee is flat.
    assert.equal(quote(10000000).fee, FEE_MAX_MINOR);
  });

  test('the fee never more than doubles a very small job', () => {
    // The floor is 100 minor units. On a job priced at 50 that would be a 200%
    // markup on the poster, which reads as a mistake rather than a fee.
    const q = quote(50);
    assert.equal(q.fee, 50);
    assert.equal(q.total, 100);
    assert.equal(q.host, 50, 'and the host still gets their price');
  });

  test('nothing quoted, nothing owed', () => {
    for (const v of [0, null, undefined, -5, 'x']) {
      assert.deepEqual(quote(v), { host: 0, fee: 0, total: 0 }, `quote(${v})`);
    }
  });
});

describe('an agent says it is an agent', () => {
  test('the label leads, and names who it works for', () => {
    // "An AI agent" alone tells a member nothing about who is accountable
    // when the car does not turn up.
    const card = offerCard({ id: 'o1', party: 'agent', name: 'Kit', operator_name: 'Bangkok Rides Ltd' });
    assert.equal(card.party, PARTY.AGENT);
    assert.match(card.lead, /^An AI agent, working for Bangkok Rides Ltd/);
  });

  test('it reads as a fact, not as a warning', () => {
    // A declaration that is punished is a declaration nobody makes honestly.
    const lead = offerCard({ party: 'agent', operator_name: 'X' }).lead;
    assert.ok(!/warning|caution|bot|beware/i.test(lead));
  });

  test('an agent can never carry a human credential', () => {
    const card = offerCard({ party: 'agent', operator_name: 'X', pohf_id: 'pohf_123' });
    assert.equal(card.human_verified, false, 'proof-of-human on a machine makes the proof worthless');
  });

  test('anything not declared an agent is treated as a person', () => {
    // The default has to be the honest-by-omission case, and a human offering
    // is the ordinary one.
    assert.equal(offerCard({ name: 'Anna' }).party, PARTY.HUMAN);
    assert.equal(offerCard({ party: 'weird', name: 'Anna' }).party, PARTY.HUMAN);
  });
});

describe('5arz proof of human', () => {
  test('a credential id, never a bare boolean', () => {
    const p = humanProof({ pohf_id: 'pohf_abc', pohf_checked_at: '2026-09-01' });
    assert.equal(p.state, 'verified');
    assert.equal(p.credential, 'pohf_abc');
    assert.match(p.label, /5arz/);
  });

  test('no credential is UNKNOWN, never "not human"', () => {
    // A host who simply has not been through 5arz yet must not be labelled
    // as software.
    const p = humanProof({});
    assert.equal(p.state, 'unknown');
    assert.equal(p.label, null);
    assert.equal(offerCard({ name: 'Anna' }).party, PARTY.HUMAN);
  });

  test('a revoked credential stops claiming anything', () => {
    const p = humanProof({ pohf_id: 'pohf_abc', pohf_revoked_at: '2026-09-10' });
    assert.equal(p.state, 'revoked');
    assert.equal(p.label, null);
    assert.equal(offerCard({ name: 'Anna', pohf_id: 'pohf_abc', pohf_revoked_at: 'x' }).human_verified, false);
  });

  test('a verified human offer says so where the member is choosing', () => {
    const card = offerCard({ name: 'Anna', pohf_id: 'pohf_abc' });
    assert.equal(card.human_verified, true);
    assert.match(card.lead, /Human-verified by 5arz/);
  });
});
