// Who may talk to the concierge from a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsHeaders, SITE_ORIGINS } from './guard.mjs';

const allow = (origin) =>
  corsHeaders(new Request('https://app.itsnum.com/api/num', { headers: { Origin: origin } }),
    'https://app.itsnum.com')['Access-Control-Allow-Origin'];

// /api/num answers anyone, with no key and no account — but corsHeaders only
// allowed app.itsnum.com, so a browser on itsnum.com was blocked outright. The
// marketing homepage could show pictures of Num and never Num itself. On
// 1 Sep 2026 it had taken 577 paid Reddit visitors and recorded zero scroll
// events; `first_message_sent` has never fired once, from anywhere.
test('our own site can reach the concierge', () => {
  for (const ours of ['https://itsnum.com', 'https://www.itsnum.com', 'https://app.itsnum.com']) {
    assert.equal(allow(ours), ours, `${ours} cannot call /api/num from a browser`);
  }
});

test('nothing that merely resembles our site is allowed', () => {
  // The whole reason SITE_ORIGINS is a list of literals: /itsnum\.com$/ also
  // matches https://evilitsnum.com, and a regex on your own domain is how an
  // allowlist quietly stops being one.
  for (const theirs of [
    'https://evilitsnum.com',
    'https://itsnum.com.attacker.net',
    'http://itsnum.com',
    'https://itsnum.co',
    'https://sub.itsnum.com',
    'null',
  ]) {
    assert.equal(allow(theirs), undefined, `${theirs} was allowed to call /api/num`);
  }
});

test('the allowlist stays exact strings, not patterns', () => {
  assert.ok(Object.isFrozen(SITE_ORIGINS));
  for (const o of SITE_ORIGINS) {
    assert.equal(typeof o, 'string');
    assert.match(o, /^https:\/\/[a-z.]+$/, `${o} is not a plain https origin`);
  }
});

test('localhost and the native shell still work', () => {
  for (const dev of ['http://localhost:5173', 'http://127.0.0.1:8788', 'capacitor://localhost', 'ionic://localhost']) {
    assert.equal(allow(dev), dev, `${dev} lost access`);
  }
});
