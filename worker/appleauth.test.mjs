import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { verifyAppleToken, b64urlToBytes, __resetAppleKeyCache, DEFAULT_AUDIENCE } from './appleauth.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A throwaway RSA pair standing in for Apple's, so these tests exercise the
// REAL signature path rather than a mock of it. A test that stubs out the
// verification is a test of nothing.
const pair = await webcrypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const pubJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const KID = 'test-key-1';
const jwks = { keys: [{ kty: 'RSA', kid: KID, alg: 'RS256', n: pubJwk.n, e: pubJwk.e, use: 'sig' }] };
const fetchKeys = async () => ({ ok: true, json: async () => jwks });

async function mint(claims, { kid = KID, alg = 'RS256', tamper = false } = {}) {
  const h = b64url(JSON.stringify({ alg, kid }));
  const p = b64url(JSON.stringify({
    iss: 'https://appleid.apple.com', aud: DEFAULT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 600, sub: 'apple-user-1', ...claims,
  }));
  const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  const s = b64url(sig);
  return `${h}.${p}.${tamper ? s.slice(0, -3) + (s.endsWith('A') ? 'BBB' : 'AAA') : s}`;
}

test('a genuine token verifies and yields its subject', async () => {
  __resetAppleKeyCache();
  const out = await verifyAppleToken(await mint({ email: 'a@b.com', email_verified: 'true' }), { fetchImpl: fetchKeys });
  assert.equal(out.sub, 'apple-user-1');
  assert.equal(out.email, 'a@b.com');
  assert.equal(out.emailVerified, true, 'Apple sends "true" as a STRING — it must still read as verified');
});

test('a forged signature is refused', async () => {
  __resetAppleKeyCache();
  await assert.rejects(
    verifyAppleToken(await mint({}, { tamper: true }), { fetchImpl: fetchKeys }),
    /bad signature/,
    'a tampered token was accepted — this is an account takeover');
});

test('alg:none and HMAC confusion are refused before any key work', async () => {
  __resetAppleKeyCache();
  const h = b64url(JSON.stringify({ alg: 'none', kid: KID }));
  const p = b64url(JSON.stringify({ iss: 'https://appleid.apple.com', aud: DEFAULT_AUDIENCE, sub: 'evil', exp: Math.floor(Date.now() / 1000) + 600 }));
  await assert.rejects(verifyAppleToken(`${h}.${p}.`, { fetchImpl: fetchKeys }), /unexpected alg/);
  await assert.rejects(verifyAppleToken(await mint({}, { alg: 'HS256' }), { fetchImpl: fetchKeys }), /unexpected alg/);
});

test("a token minted for another app cannot sign in here", async () => {
  __resetAppleKeyCache();
  await assert.rejects(
    verifyAppleToken(await mint({ aud: 'com.someone.else' }), { fetchImpl: fetchKeys }),
    /wrong audience/);
});

test('a token from another issuer is refused', async () => {
  __resetAppleKeyCache();
  await assert.rejects(
    verifyAppleToken(await mint({ iss: 'https://evil.example' }), { fetchImpl: fetchKeys }),
    /wrong issuer/);
});

test('an expired token is refused', async () => {
  __resetAppleKeyCache();
  await assert.rejects(
    verifyAppleToken(await mint({ exp: Math.floor(Date.now() / 1000) - 10 }), { fetchImpl: fetchKeys }),
    /expired/);
});

test('an unknown key id refetches once, then fails closed', async () => {
  __resetAppleKeyCache();
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, json: async () => jwks }; };
  await assert.rejects(
    verifyAppleToken(await mint({}, { kid: 'rotated-away' }), { fetchImpl: counting }),
    /unknown apple key id/);
  assert.equal(calls, 2, 'a rotation should trigger exactly one refetch, then stop');
});

test('malformed input never throws something unexpected', async () => {
  __resetAppleKeyCache();
  for (const bad of ['', 'x', 'a.b', null, undefined, 'a.b.c.d']) {
    await assert.rejects(verifyAppleToken(bad, { fetchImpl: fetchKeys }));
  }
});

test('base64url is decoded as base64url, not base64', () => {
  // '-' and '_' are the whole point; decoding these as base64 gives garbage.
  assert.deepEqual([...b64urlToBytes('-_8')], [251, 255]);
});
