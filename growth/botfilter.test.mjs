// A CRAWLER IS NOT A VISITOR.
//
// 3 Sep 2026, within three hours of the ads landing page going live: 302
// "visitors" — US desktop, no referrer, no campaign, one page view each, not
// one scroll and not one question. The real campaign is 87% mobile and carries
// utm_source=reddit. Those 302 were scanners finding a newly published URL,
// and they were sitting in the denominator of the only conversion rate this
// company is currently judged on: 320 arrivals, 2 conversations, which reads
// as "nobody who arrives is interested" rather than "almost nobody real has
// arrived yet".
//
// That is not a rounding error. It is the number a campaign gets paused over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

/** Lift isBot out of the worker and run it against fake requests. */
function loadIsBot() {
  const start = src.indexOf('const BOT_UA =');
  const end = src.indexOf('function device(req)');
  const body = src.slice(start, end);
  return new Function(`${body}; return isBot;`)();
}
const isBot = loadIsBot();
const ua = (v) => ({ headers: { get: (h) => (h === 'user-agent' ? v : null) } });

test('real phones and browsers are visitors', () => {
  const humans = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    // Reddit's in-app browser — 87% of this traffic, and the single worst
    // thing this filter could get wrong.
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Reddit/Version 2024.1.0/Build 1]',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0',
    'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440]',
  ];
  for (const u of humans) assert.equal(isBot(ua(u)), false, `dropped a real visitor: ${u.slice(0, 60)}`);
});

test('self-declared crawlers are not', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl)',
    'facebookexternalhit/1.1',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/122.0.0.0 Safari/537.36',
    'python-requests/2.31.0',
    'curl/8.4.0',
    'Go-http-client/2.0',
    'Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)',
  ];
  for (const u of bots) assert.equal(isBot(ua(u)), true, `let a crawler into the funnel: ${u.slice(0, 50)}`);
});

test('no user-agent at all is not a person holding a phone', () => {
  assert.equal(isBot(ua('')), true);
  assert.equal(isBot(ua(null)), true);
});

test('the filter runs on the event endpoint, after the allow-list', () => {
  // After, so an unknown event name is still reported as unknown in
  // development rather than being swallowed as "bot".
  const ev = src.slice(src.indexOf('async function ev(req, env)'), src.indexOf('/* ------------------------------------------- GET /api/ev.gif'));
  assert.match(ev, /if \(isBot\(req\)\) return J/, 'the event endpoint still records crawlers');
  assert.ok(ev.indexOf('EVENTS.has(name)') < ev.indexOf('isBot(req)'),
    'the bot check runs before the allow-list, hiding typos as bot traffic');
  assert.match(ev, /ignored: "bot"/, 'a filtered crawler is indistinguishable from a filtered typo in the logs');
});

test('a filtered crawler still gets a 200', () => {
  // A 403 teaches a crawler to retry from somewhere else. Silence is cheaper.
  const ev = src.slice(src.indexOf('async function ev(req, env)'), src.indexOf('/* ------------------------------------------- GET /api/ev.gif'));
  assert.match(ev, /isBot\(req\)\) return J\(\{ ok: true/);
});

test('the filter is conservative on purpose, and says so', () => {
  // Wrongly dropping a real visitor is worse than keeping a stray crawler:
  // you cannot see what you deleted.
  const note = src.slice(src.indexOf('A CRAWLER IS NOT A VISITOR'), src.indexOf('const BOT_UA'));
  assert.match(note, /lies about its user-agent/, 'the honest limits of this filter are no longer written down');
});
