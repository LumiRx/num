import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  hostOf, domainOfEmail, emailProvesListing, siteToken, checkSite, PUBLIC_MAILBOXES,
} from './bizverify.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('a personal mailbox proves the mailbox, not the business', () => {
  // Four of the eight real signups on file used gmail/hotmail addresses, so
  // this is the common case. Without it one Gmail account would verify every
  // listing that happens to publish a Gmail address.
  for (const email of ['owner@gmail.com', 'x@hotmail.co.uk', 'y@icloud.com', 'z@yahoo.com']) {
    const out = emailProvesListing(email, { website: 'https://awafi.co.uk' });
    assert.equal(out.ok, false, `${email} verified a business it has no relationship with`);
    assert.match(out.reason, /personal mailbox/);
  }
  assert.ok(PUBLIC_MAILBOXES.has('gmail.com'));
});

test('but a personal mailbox still works when it IS the published contact', () => {
  // makani and Morrisons Lounge both published gmail addresses on the listing.
  // Proving control of the exact address we already held is real proof.
  const out = emailProvesListing('edinburghmakani@gmail.com', { email: 'edinburghmakani@gmail.com' });
  assert.equal(out.ok, true);
  assert.equal(out.via, 'listing email');
});

test('a company domain matching the listing website verifies', () => {
  const out = emailProvesListing('reception@hieedinburgh.co.uk', { website: 'https://www.hieedinburgh.co.uk/rooms' });
  assert.equal(out.ok, true);
  assert.equal(out.via, 'website domain');
});

test('a domain that merely looks similar does NOT verify', () => {
  for (const email of ['a@hieedinburgh.co.uk.evil.com', 'a@notheedinburgh.co.uk', 'a@hieedinburgh.com']) {
    assert.equal(emailProvesListing(email, { website: 'https://hieedinburgh.co.uk' }).ok, false,
      `${email} passed as the hotel's own domain`);
  }
});

test('the evidence is always checked against what we held BEFORE the claim', () => {
  // SEC-006 in one line: a claimant who supplies both the proof and the thing
  // it is compared against has proved nothing.
  assert.equal(emailProvesListing('anyone@attacker.com', {}).ok, false,
    'a listing with no website or email on file was verified by a stranger');
  assert.equal(emailProvesListing('anyone@attacker.com', { website: null, email: null }).ok, false);
});

test('the website token is stable per place and never shared between places', async () => {
  const env = { BIZ_VERIFY_SECRET: 'shhh' };
  const a1 = await siteToken(env, 'place-a');
  const a2 = await siteToken(env, 'place-a');
  const b = await siteToken(env, 'place-b');
  assert.equal(a1, a2, 'an owner returning tomorrow would be given a different token');
  assert.notEqual(a1, b, 'two venues share a token — one could verify the other');
  assert.match(a1, /^num-verify-[0-9a-f]{32}$/);
  assert.equal(await siteToken({}, 'place-a'), null, 'a token was minted with no secret configured');
});

test('the site check reads the LISTING\'s domain, never one the claimant names', async () => {
  // If the claimant could name the URL they would host the token themselves
  // and verify a venue they do not own. The check would pass and prove nothing.
  const env = { BIZ_VERIFY_SECRET: 'shhh' };
  const token = await siteToken(env, 'p1');
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return { ok: true, text: async () => `hello\n${token}\n` };
  };
  const out = await checkSite(env, { id: 'p1', website: 'http://www.awafi.co.uk/menu', evil: 'https://attacker.com' }, { fetchImpl });
  assert.equal(out.ok, true);
  assert.ok(asked.every((u) => u.startsWith('https://awafi.co.uk/')), `fetched ${asked.join(', ')}`);
  assert.ok(!asked.some((u) => u.includes('attacker.com')));
});

test('a site without the token fails, and says exactly what to do', async () => {
  const env = { BIZ_VERIFY_SECRET: 'shhh' };
  const fetchImpl = async () => ({ ok: true, text: async () => 'not here' });
  const out = await checkSite(env, { id: 'p1', website: 'awafi.co.uk' }, { fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /num-verify-[0-9a-f]{32}/, 'the owner was not told the token');
  assert.match(out.reason, /\.well-known\/num-verify\.txt/, 'the owner was not told where to put it');
});

test('a listing with no website says so instead of failing obscurely', async () => {
  const out = await checkSite({ BIZ_VERIFY_SECRET: 's' }, { id: 'p1', website: null });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no website on file/);
});

test('a network failure is not a verification', async () => {
  const env = { BIZ_VERIFY_SECRET: 'shhh' };
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const out = await checkSite(env, { id: 'p1', website: 'awafi.co.uk' }, { fetchImpl });
  assert.equal(out.ok, false, 'an unreachable site verified the business');
});

test('host and domain parsing survive what people actually type', () => {
  assert.equal(hostOf('HTTPS://WWW.Awafi.co.uk/menu?x=1'), 'awafi.co.uk');
  assert.equal(hostOf('awafi.co.uk'), 'awafi.co.uk');
  assert.equal(hostOf(''), null);
  assert.equal(hostOf(null), null);
  assert.equal(domainOfEmail('Reception@Fingal.CO.UK'), 'fingal.co.uk');
  assert.equal(domainOfEmail('not an email'), null);
});
