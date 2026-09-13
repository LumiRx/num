// Sending to an iPhone. Asserted against Apple's published rules, because every
// mistake in this file fails silently — a wrong header or a stale token returns a
// 4xx nobody sees and the person simply never hears from us.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendApns, providerToken, _resetTokenCache, p8ToBytes, buildPayload,
  apnsReady, apnsMissing, APNS_HOST, MAX_PAYLOAD, NEVER_RETRY, DEAD_TOKEN, TOKEN_TTL_MS,
} from './apns.mjs';

/** A real P-256 key, shaped exactly like the .p8 Apple hands you. */
async function p8() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  return {
    pem: '-----BEGIN PRIVATE KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n',
    publicKey: kp.publicKey,
  };
}
const envFor = (pem, over = {}) => ({
  APNS_KEY_P8: pem, APNS_KEY_ID: 'ABC1234567',
  APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'com.itsnum.app', ...over,
});

/** Stand in for APNs. Records what we sent so the headers can be asserted. */
function fakeApns(replies) {
  const calls = [];
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r.throw) throw new Error(r.throw);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'apns-id': 'test-apns-id', ...(r.body ? { 'content-type': 'application/json' } : {}) },
    });
  };
  return calls;
}

/* ── configuration, said out loud ──────────────────────────────────────── */

test('it knows when it cannot send, and names what is missing', () => {
  assert.equal(apnsReady({}), false);
  assert.deepEqual(apnsMissing({}), ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID']);
  assert.deepEqual(
    apnsMissing({ APNS_KEY_P8: 'x', APNS_TEAM_ID: 't', APNS_BUNDLE_ID: 'b' }),
    ['APNS_KEY_ID'],
    'a half-configured sender must say WHICH half — "push is off" is not a diagnosis',
  );
});

test('an unconfigured send refuses rather than pretending', async () => {
  const r = await sendApns({}, { token: 'abc' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NotConfigured');
  assert.deepEqual(r.missing, ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID']);
});

/* ── the provider token ────────────────────────────────────────────────── */

test('the JWT is a real ES256 signature that verifies against the public key', async () => {
  _resetTokenCache();
  const { pem, publicKey } = await p8();
  const jwt = await providerToken(envFor(pem));
  const [h, p, s] = jwt.split('.');
  const dec = (x) => JSON.parse(atob(x.replace(/-/g, '+').replace(/_/g, '/')));

  assert.deepEqual(dec(h), { alg: 'ES256', kid: 'ABC1234567' }, 'Apple requires alg and kid in the header');
  assert.equal(dec(p).iss, 'TEAM123456', 'iss is the team id');
  assert.ok(typeof dec(p).iat === 'number', 'iat must be seconds since epoch');

  const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  assert.equal(sig.length, 64, 'ES256 is the raw r||s pair — a DER signature here is rejected as unverifiable');
  assert.equal(
    await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(`${h}.${p}`)),
    true,
    'if this fails Apple answers InvalidProviderToken and nothing is ever delivered',
  );
});

test('the token is cached, because Apple refuses more than one update per 20 minutes', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  const env = envFor(pem);
  const a = await providerToken(env);
  const b = await providerToken(env);
  assert.equal(a, b, 'minting per send earns 429 TooManyProviderTokenUpdates and the whole batch fails');
  assert.ok(TOKEN_TTL_MS < 60 * 60 * 1000, 'must expire before Apple considers it stale at one hour');
  assert.ok(TOKEN_TTL_MS > 20 * 60 * 1000, 'must outlast the 20-minute update floor');
});

test('a new key id forces a new token rather than reusing a signature for the wrong key', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  const a = await providerToken(envFor(pem));
  const b = await providerToken(envFor(pem, { APNS_KEY_ID: 'ZZZ9999999' }));
  assert.notEqual(a, b, 'UnrelatedKeyIdInToken is what a stale cache would cause here');
});

test('a .p8 whose newlines were lost in a form still works', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  const flat = pem.replace(/\n/g, '');
  assert.equal((await providerToken(envFor(flat))).split('.').length, 3,
    'being strict here costs an afternoon of InvalidProviderToken with a perfectly good key');
});

test('an empty or junk key is refused with a sentence, not a crash', () => {
  assert.throws(() => p8ToBytes(''), /empty or not a PEM/);
  assert.throws(() => p8ToBytes(null), /empty or not a PEM/);
});

/* ── the payload ───────────────────────────────────────────────────────── */

test('the payload carries what the app needs to open the right place', () => {
  const p = JSON.parse(buildPayload({ title: 'A boat', body: 'Saturday is free', url: '/?go=charter', kind: 'suggestion', notifId: 'n1' }));
  assert.equal(p.aps.alert.title, 'A boat');
  assert.equal(p.aps.alert.body, 'Saturday is free');
  assert.equal(p.u, '/?go=charter', 'without the url a tap lands on the home screen and the suggestion is lost');
  assert.equal(p.k, 'suggestion');
  assert.equal(p.n, 'n1', 'the notification id is what lets a tap mark itself read');
});

test('an over-long body is trimmed to fit rather than refused whole', () => {
  const out = buildPayload({ title: 'Hello', body: 'x'.repeat(9000) });
  const bytes = new TextEncoder().encode(out).length;
  assert.ok(bytes <= MAX_PAYLOAD, `payload was ${bytes}, Apple's ceiling is ${MAX_PAYLOAD}`);
  assert.match(JSON.parse(out).aps.alert.body, /…$/, 'a trim should look deliberate');
});

test('the size check counts BYTES, so Thai and emoji cannot smuggle a payload over the line', () => {
  // A character count would pass this and APNs would answer PayloadTooLarge.
  const out = buildPayload({ title: 'ร้านอาหาร', body: '🛥️ต้มยำกุ้ง'.repeat(900) });
  assert.ok(new TextEncoder().encode(out).length <= MAX_PAYLOAD);
});

/* ── the request Apple actually requires ───────────────────────────────── */

test('the request matches Apple spec: path, host, and every required header', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  const calls = fakeApns({ status: 200 });
  const r = await sendApns(envFor(pem), {
    token: 'aabbcc112233', title: 'A boat', body: 'Saturday', url: '/x', kind: 'suggestion', collapseId: 'charter:1',
  });

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, `${APNS_HOST.production}/3/device/aabbcc112233`, 'the path is /3/device/<token>');
  assert.match(c.headers.authorization, /^bearer ey/, 'token auth is "bearer <jwt>", lowercase');
  assert.equal(c.headers['apns-push-type'], 'alert', 'a mismatch lets Apple delay or drop it');
  assert.equal(c.headers['apns-topic'], 'com.itsnum.app', 'for push type alert the topic must be the bare bundle id');
  assert.equal(c.headers['apns-collapse-id'], 'charter:1');
  assert.ok(c.headers['apns-id'], 'our own id, so an error can be traced back');
  assert.ok(Number(c.headers['apns-expiration']) > Math.floor(Date.now() / 1000), 'stored, so an overnight phone still hears in the morning');
});

test('a proactive suggestion goes out at priority 5, not 10', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  const calls = fakeApns({ status: 200 });
  await sendApns(envFor(pem), { token: 'aabb', title: 'A boat' });
  assert.equal(calls[0].headers['apns-priority'], '5',
    'priority 10 means interrupt them now. A suggestion is not that, and using 10 for everything is how an app earns a reputation for being rude');
});

test('a sandbox token goes to the sandbox host', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  const calls = fakeApns({ status: 200 });
  await sendApns(envFor(pem), { token: 'aabb', environment: 'sandbox', title: 'x' });
  assert.ok(calls[0].url.startsWith(APNS_HOST.sandbox),
    'a sandbox token sent to production fails BadDeviceToken — the commonest reason someone concludes push is broken');
});

test('the collapse id is clipped to the 64 bytes Apple allows', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  const calls = fakeApns({ status: 200 });
  await sendApns(envFor(pem), { token: 'aabb', title: 'x', collapseId: 'c'.repeat(200) });
  assert.ok(calls[0].headers['apns-collapse-id'].length <= 64, 'over 64 bytes is BadCollapseId and the push is refused');
});

/* ── Apple's error rules, followed exactly ─────────────────────────────── */

test("410 Unregistered means the app is gone — the token is dead, not retried", async () => {
  _resetTokenCache();
  const { pem } = await p8();
  fakeApns({ status: 410, body: { reason: 'Unregistered', timestamp: 1789000000000 } });
  const r = await sendApns(envFor(pem), { token: 'aabb', title: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.dead, true, 'retrying this forever is what gets a provider throttled');
  assert.equal(r.retriable, false);
  assert.equal(r.timestamp, 1789000000000, 'Apple returns when it learned the token died — worth keeping');
});

test('every reason Apple says never to retry is marked not retriable', async () => {
  const { pem } = await p8();
  for (const reason of NEVER_RETRY) {
    _resetTokenCache();
    fakeApns({ status: reason === 'PayloadTooLarge' ? 413 : reason === 'Forbidden' ? 403 : 400, body: { reason } });
    const r = await sendApns(envFor(pem), { token: 'aabb', title: 'x' });
    assert.equal(r.retriable, false, `${reason} must never be retried — Apple says so explicitly`);
  }
});

test('a bad token is disabled, a busy server is not', async () => {
  const { pem } = await p8();
  for (const [status, reason, dead] of [
    [400, 'BadDeviceToken', true],
    [400, 'DeviceTokenNotForTopic', true],
    [410, 'ExpiredToken', true],
    [429, 'TooManyRequests', false],
    [503, 'ServiceUnavailable', false],
    [500, 'InternalServerError', false],
  ]) {
    _resetTokenCache();
    fakeApns({ status, body: { reason } });
    const r = await sendApns(envFor(pem), { token: 'aabb', title: 'x' });
    assert.equal(r.dead, dead, `${reason} should ${dead ? '' : 'NOT '}kill the token`);
    assert.equal(DEAD_TOKEN.has(reason), dead);
  }
});

test('429 and 5xx come back with a wait, and Apple asks 15 minutes for 5xx', async () => {
  const { pem } = await p8();
  _resetTokenCache();
  fakeApns({ status: 429, body: { reason: 'TooManyRequests' } });
  const busy = await sendApns(envFor(pem), { token: 'aabb', title: 'x' });
  assert.ok(busy.retryAfterMs > 0);
  assert.equal(busy.retriable, true);

  _resetTokenCache();
  fakeApns({ status: 503, body: { reason: 'ServiceUnavailable' } });
  const down = await sendApns(envFor(pem), { token: 'aabb', title: 'x' });
  assert.equal(down.retryAfterMs, 15 * 60_000, 'Apple: retry 5xx after 15 minutes');
});

test('an expired provider token clears the cache so the NEXT send succeeds', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  const calls = fakeApns([
    { status: 403, body: { reason: 'ExpiredProviderToken' } },
    { status: 200 },
  ]);
  const env = envFor(pem);
  const first = await sendApns(env, { token: 'aabb', title: 'x' });
  assert.equal(first.ok, false);
  const second = await sendApns(env, { token: 'aabb', title: 'x' });
  assert.equal(second.ok, true, 'without clearing the cache the whole run fails behind one stale JWT');
  assert.notEqual(calls[0].headers.authorization, calls[1].headers.authorization, 'a fresh token must have been minted');
});

test('a network failure is retriable and never kills the token', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  fakeApns({ throw: 'connection reset' });
  const r = await sendApns(envFor(pem), { token: 'aabb', title: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.dead, false, 'a dropped connection says nothing about whether the phone exists');
  assert.ok(r.retryAfterMs > 0);
});

test('an error body that is not JSON still yields a usable verdict', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  globalThis.fetch = async () => new Response('<html>gateway</html>', { status: 502 });
  const r = await sendApns(envFor(pem), { token: 'aabb', title: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HTTP 502', 'the status alone is enough to decide — a parse failure must not throw');
  assert.equal(r.dead, false);
});

test('a missing token is refused before any network call', async () => {
  _resetTokenCache();
  const { pem } = await p8();
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response(null, { status: 200 }); };
  const r = await sendApns(envFor(pem), { token: '', title: 'x' });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});
