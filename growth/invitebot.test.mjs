// A SCANNER IS NOT A READER — the invite counters' version of botfilter.test.mjs.
//
// 19 Sep 2026. September's outreach reported 670 opens and 77 clicks against
// 3,538 sends, which reads as a healthy top of funnel. 54 of those 77 clicks
// arrived under sixty seconds after the mail was sent, each URL fetched an
// average of 2.1 times. Over the same eleven days the claim page — whose
// analytics DO filter bots — recorded zero human arrivals, while the rest of
// the site's event log ran 300-700 events a day.
//
// The clicks were corporate mail-security appliances. An afternoon of analysis
// was built on them, and the recommendation that came out of it ("fix the claim
// page, it converts 1.3%") was about a page that was never broken.
//
// This file exists so the next person gets a failing test instead of that
// afternoon. It lives in growth/ rather than accounts/ because the test runner
// in package.json does not glob accounts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksHuman } from '../accounts/invites.js';

const req = (ua) => ({ headers: { get: (h) => (h === 'user-agent' ? ua : null) } });

test('a person on a real browser is a reader', () => {
  const humans = [
    // A restaurant owner on a phone, which is how most of them will arrive.
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  ];
  for (const ua of humans) {
    assert.equal(looksHuman(req(ua)), true, `should be a reader: ${ua}`);
  }
});

test('the things that actually generated September\'s clicks are not readers', () => {
  const machines = [
    'curl/8.4.0',
    'Wget/1.21.3',
    'python-requests/2.31.0',
    'Go-http-client/2.0',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'axios/1.6.2',
    'Java/17.0.9',
    'okhttp/4.12.0',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'facebookexternalhit/1.1',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Puppeteer',
    'Pingdom.com_bot_version_1.4',
  ];
  for (const ua of machines) {
    assert.equal(looksHuman(req(ua)), false, `should not be a reader: ${ua}`);
  }
});

test('no user-agent at all is not a browser a person is holding', () => {
  assert.equal(looksHuman(req('')), false);
  assert.equal(looksHuman(req(null)), false);
});

test('a missing or malformed request never throws — tracking must not break the redirect', () => {
  // handleClaimClick still has to 302 and handleOpenPixel still has to return
  // the GIF even if the runtime hands us something unexpected.
  assert.equal(looksHuman(undefined), false);
  assert.equal(looksHuman({}), false);
  assert.equal(looksHuman({ headers: {} }), false);
});
