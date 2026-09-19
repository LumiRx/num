// Can somebody farm a trip out of this?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES, RULE_KEYS, ruleByKey, assess, explain, identityKey, five5arzId, canClaim,
} from './entryquality.mjs';

/** A referred member who passes everything, so each test can spoil one thing. */
const good = (id, over = {}) => ({
  id, phone_verified: 1, email_verified: 0, activity: 3,
  device_id: 'dev_' + id, ip_hash: 'ip_' + id, ua_hash: 'ua_' + id, ...over,
});
const me = { device_id: 'dev_me', ip_hash: 'ip_me', ua_hash: 'ua_me' };

/* ── THE FARM ──────────────────────────────────────────────────────────── */

test('twenty accounts made on one phone are worth one referral, not twenty', () => {
  // The whole attack. Before these rules this was twenty referrals and, at
  // the top of the ladder, a trip.
  const rows = Array.from({ length: 20 }, (_, i) => good('f' + i, { device_id: 'one_phone' }));
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  assert.equal(r.counted, 1, 'the farm counted ' + r.counted);
  assert.equal(r.tally.cluster, 19);
});

test('accounts made on the referrer\'s own device count for nothing', () => {
  const rows = [good('a', { device_id: 'dev_me' }), good('b', { device_id: 'dev_me' })];
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  assert.equal(r.counted, 0);
  assert.equal(r.tally.same_device, 2);
});

test('the referrer cannot refer themselves', () => {
  const r = assess({ referrerId: 'me', referrerSignals: me, rows: [good('me')] });
  assert.equal(r.counted, 0);
  assert.equal(r.tally.self, 1);
});

test('same network AND same browser is rejected', () => {
  const rows = [good('a', { ip_hash: 'ip_me', ua_hash: 'ua_me', device_id: 'other' })];
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  assert.equal(r.tally.same_fingerprint, 1);
});

/* ── AND THE HONEST PEOPLE THE RULES MUST NOT PUNISH ───────────────────── */

test('sharing wifi is NOT a farm — 156 members sit on 61 IPs', () => {
  // A man signing his wife up on the sofa next to him. Same IP, her own
  // phone. Rejecting this would take a real referral away and tell him
  // nothing about why.
  const rows = [good('wife', { ip_hash: 'ip_me', ua_hash: 'ua_hers', device_id: 'her_phone' })];
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  assert.equal(r.counted, 1, 'a shared router was treated as fraud');
});

test('a family sharing one tablet keeps one referral rather than losing all of them', () => {
  const rows = [good('a', { device_id: 'tablet' }), good('b', { device_id: 'tablet' })];
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  assert.equal(r.counted, 1, 'the honest shared-device case lost everything');
  assert.equal(r.tally.cluster, 1);
});

test('members with no signals at all are judged on the other rules, not rejected', () => {
  // 28 of 156 members predate signal collection. Treating "no data" as
  // "guilty" would silently void every referral made before September.
  const rows = [good('a', { device_id: null, ip_hash: null, ua_hash: null })];
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  assert.equal(r.counted, 1);
});

test('a referrer with no signals does not make every referral suspicious', () => {
  const rows = [good('a'), good('b')];
  const r = assess({ referrerId: 'me', referrerSignals: null, rows });
  assert.equal(r.counted, 2);
});

/* ── the two severe rules Dre chose knowingly ──────────────────────────── */

test('an unverified contact does not count, and says it counts later', () => {
  const rows = [good('a', { phone_verified: 0, email_verified: 0 })];
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  assert.equal(r.counted, 0);
  assert.equal(r.tally.no_contact, 1);
  assert.match(ruleByKey('no_contact').why, /as soon as they do/);
});

test('either a phone or an email is enough — it does not need both', () => {
  const rows = [good('a', { phone_verified: 0, email_verified: 1 })];
  assert.equal(assess({ referrerId: 'me', referrerSignals: me, rows }).counted, 1);
});

test('somebody who signed up and never used NUM does not count yet', () => {
  const rows = [good('a', { activity: 0 })];
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  assert.equal(r.tally.inactive, 1);
  assert.match(ruleByKey('inactive').why, /first time they do/);
});

/* ── EVERY REJECTION HAS TO BE EXPLAINABLE ─────────────────────────────── */

test('every rule carries a reason written for the ambassador to read', () => {
  for (const r of RULES) {
    assert.ok(r.why && r.why.length > 25, r.key + ' has no explanation');
    assert.ok(r.label && r.label.length > 3, r.key + ' has no label');
    // No jargon in something a person reads about their own money.
    for (const word of ['sybil', 'fingerprint hash', 'fraud', 'cheat', 'abuse']) {
      assert.equal(r.why.toLowerCase().includes(word), false, `${r.key} says "${word}"`);
    }
  }
});

test('the tally becomes sentences, biggest first', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => good('n' + i, { phone_verified: 0 })),
    good('x', { activity: 0 }),
  ];
  const r = assess({ referrerId: 'me', referrerSignals: me, rows });
  const said = explain(r.tally);
  assert.equal(said[0].key, 'no_contact');
  assert.equal(said[0].n, 5);
  assert.ok(said[0].why.length > 25);
  assert.equal(said.length, 2);
});

test('nothing rejected means nothing to explain', () => {
  assert.deepEqual(explain({}), []);
  const r = assess({ referrerId: 'me', referrerSignals: me, rows: [good('a')] });
  assert.deepEqual(explain(r.tally), []);
});

test('the rule keys are unique and stable', () => {
  assert.equal(new Set(RULE_KEYS).size, RULES.length);
  // Consoles and stored tallies reference these strings.
  for (const k of ['self', 'same_device', 'cluster', 'no_contact', 'inactive']) {
    assert.ok(RULE_KEYS.includes(k), k + ' was removed');
  }
});

/* ── one human, one entrant ────────────────────────────────────────────── */

test('a verified 5arz id is the strongest key, and it wins over everything', () => {
  const m = { id: 'm1', phone: '+4477', phone_verified: 1, device_id: 'd1',
    bio: JSON.stringify({ '5arz_id': 'mem_abc123' }) };
  assert.equal(identityKey(m), '5arz:mem_abc123');
});

test('two Num accounts with the same 5arz id are one entrant', () => {
  const bio = JSON.stringify({ '5arz_id': 'mem_same' });
  assert.equal(identityKey({ id: 'a', bio }), identityKey({ id: 'b', bio }));
});

test('a verified phone is next, and an unverified one is not used at all', () => {
  assert.equal(identityKey({ id: 'm', phone: '+4477', phone_verified: 1 }), 'phone:+4477');
  // An unverified number is a string somebody typed.
  assert.equal(identityKey({ id: 'm', phone: '+4477', phone_verified: 0, device_id: 'd' }), 'device:d');
});

test('with no evidence at all a person is still their own entrant', () => {
  assert.equal(identityKey({ id: 'm9' }), 'member:m9');
  assert.equal(identityKey(null), null);
});

test('a malformed bio does not crash the draw or invent an identity', () => {
  for (const bio of ['not json', '', null, '{"5arz_id":7}', '[]']) {
    assert.equal(five5arzId({ bio }), null);
  }
});

/* ── the claim gate ────────────────────────────────────────────────────── */

test('claiming needs BOTH the verified flag and a real 5arz link', () => {
  assert.equal(canClaim({ identity_verified: 1, bio: JSON.stringify({ '5arz_id': 'mem_x' }) }), true);
  // A flag with no link behind it is the shape a bad migration leaves.
  assert.equal(canClaim({ identity_verified: 1, bio: null }), false);
  assert.equal(canClaim({ identity_verified: 0, bio: JSON.stringify({ '5arz_id': 'mem_x' }) }), false);
  assert.equal(canClaim(null), false);
});
