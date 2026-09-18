import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signState, verifyState, startUrl, finishConnect, connectReady, connectNeeds, setRailsOff } from './connect.mjs';

const env = { STRIPE_CLIENT_ID: 'ca_test', STRIPE_SECRET_KEY: 'sk_test_platform' };

test('state is signed and expires; a forged or foreign business id is refused', async () => {
  const s = await signState(env, 'biz_1');
  assert.equal(await verifyState(env, s), 'biz_1');
  assert.equal(await verifyState(env, s.replace('biz_1', 'biz_2')), null, 'swapping the business breaks the signature');
  assert.equal(await verifyState(env, s + 'x'), null);
  assert.equal(await verifyState({ ...env, STRIPE_SECRET_KEY: 'other' }, s), null, 'another key cannot verify it');
  const old = await signState(env, 'biz_1', Math.floor(Date.now() / 1000) - 31 * 60);
  assert.equal(await verifyState(env, old), null, 'thirty minutes, then dead');
});

test('the start URL asks Stripe for a Standard account with read_write, and none is offered unconfigured', async () => {
  const u = new URL(await startUrl(env, 'biz_1', { origin: 'https://itsnum.com' }));
  assert.equal(u.origin + u.pathname, 'https://connect.stripe.com/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'ca_test');
  assert.equal(u.searchParams.get('scope'), 'read_write');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://itsnum.com/biz/connect/callback');
  assert.equal(await verifyState(env, u.searchParams.get('state')), 'biz_1');
  assert.equal(await startUrl({}, 'biz_1', { origin: 'x' }), null);
  assert.equal(connectReady({}), false);
  assert.equal(connectNeeds({ STRIPE_CLIENT_ID: 'ca' }).length, 1);
});

test('finishConnect exchanges the code, reads charges_enabled from Stripe, and records the account', async () => {
  const writes = [];
  const DB = { prepare: (sql) => ({ bind: (...a) => ({ run: async () => { writes.push({ sql, a }); return {}; } }) }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/oauth/token')) {
      assert.match(String(init.body), /grant_type=authorization_code/);
      assert.match(String(init.body), /client_secret=sk_test_platform/);
      return new Response(JSON.stringify({ stripe_user_id: 'acct_venue' }), { status: 200 });
    }
    if (String(url).endsWith('/accounts/acct_venue')) {
      return new Response(JSON.stringify({ id: 'acct_venue', charges_enabled: true, payouts_enabled: false, country: 'GB', default_currency: 'gbp', business_profile: { name: 'The Longtail' } }), { status: 200 });
    }
    throw new Error('unexpected ' + url);
  };
  try {
    const state = await signState(env, 'biz_1');
    const out = await finishConnect({ ...env, DB }, { code: 'ac_123', state });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.account.id, 'acct_venue');
    assert.equal(out.account.charges_enabled, true);
    assert.equal(out.account.default_currency, 'GBP');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].a, ['biz_1', 'acct_venue', 1, 'GB', 'GBP']);
    // A bad state never reaches Stripe.
    const bad = await finishConnect({ ...env, DB }, { code: 'ac_123', state: 'biz_2.1.zzz' });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /expired|not issued/);
    // Stripe's own error is passed through in words.
    const err = await finishConnect({ ...env, DB }, { error: 'access_denied', error_description: 'The user denied your request' });
    assert.equal(err.reason, 'The user denied your request');
  } finally { globalThis.fetch = realFetch; }
});

test('setRailsOff keeps only rails NUM knows', async () => {
  let saved;
  const DB = { prepare: () => ({ bind: (_b, json) => ({ run: async () => { saved = json; return {}; } }) }) };
  const out = await setRailsOff({ DB }, 'biz_1', ['paypal', 'paypal', 'bogus', 'card'], ['card', 'paypal', 'link']);
  assert.deepEqual(out, ['paypal', 'card']);
  assert.equal(saved, '["paypal","card"]');
});
