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
  FEE_MAX_MINOR, FEE_MIN_MINOR, PARTY, canConfirm, humanProof, offerCard, split,
} from './hostoffers.mjs';

const job = (o = {}) => ({ id: 'j1', status: 'open', price_minor: 10000, currency: 'GBP', ...o });
const pay = (o = {}) => ({ status: 'succeeded', amount_minor: 10000, currency: 'GBP', ...o });

describe('payment settles, then it is confirmed', () => {
  test('a settled payment for the quoted amount confirms', () => {
    const out = canConfirm(job(), pay());
    assert.equal(out.ok, true);
    assert.equal(out.total, 10000);
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
    assert.equal(canConfirm(job(), pay({ amount_minor: 10000 })).ok, true);
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

describe('what NUM keeps', () => {
  test('a small percentage of the payment, not a charge for offering', () => {
    assert.deepEqual(split(10000), { total: 10000, fee: 500, host: 9500 });
  });

  test('floored, so it does not cost more to collect than it collects', () => {
    assert.equal(split(200).fee, FEE_MIN_MINOR);
  });

  test('capped, so NUM has no interest in the size of a job it is not doing', () => {
    // The same reason the host-to-host network fee is flat.
    assert.equal(split(10000000).fee, FEE_MAX_MINOR);
  });

  test('the fee never exceeds the payment', () => {
    const s = split(50);
    assert.ok(s.fee <= s.total);
    assert.equal(s.host, s.total - s.fee);
  });

  test('nothing paid, nothing split', () => {
    assert.deepEqual(split(0), { total: 0, fee: 0, host: 0 });
    assert.deepEqual(split(null), { total: 0, fee: 0, host: 0 });
    assert.deepEqual(split(-5), { total: 0, fee: 0, host: 0 });
  });

  test('the host is always paid the remainder exactly', () => {
    for (const t of [1, 99, 100, 4321, 99999, 250000]) {
      const s = split(t);
      assert.equal(s.fee + s.host, s.total, `the split lost money at ${t}`);
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
