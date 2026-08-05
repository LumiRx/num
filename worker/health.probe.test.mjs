// A monitor that cannot see the product is decoration.
//
// On 4 Aug 2026 itsnum.com served an infinite 301 loop for hours. In that
// window healthCron ran 288 times and reported zero failures, because every
// check inspected an internal dependency — D1, the model key, Stripe, Twilio —
// and none of them fetched the actual site. All the ingredients were in the
// kitchen; nobody checked a meal came out.
//
// These tests pin the properties that make the new probe able to see it. They
// exercise checkPublic against fake fetches rather than the live internet, so
// the suite stays deterministic and offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'health.mjs'), 'utf8');

// Lift checkPublic out of the module and run it against a stub fetch. Importing
// health.mjs wholesale would drag in Workers globals; the function is
// self-contained, so evaluating it in isolation tests the real code path.
function loadCheckPublic(fakeFetch) {
  const start = src.indexOf('async function checkPublic(');
  const end = src.indexOf('export async function runHealth');
  const body = src.slice(start, end);
  const factory = new Function('fetch', 'AbortSignal', `${body}; return checkPublic;`);
  return factory(fakeFetch, { timeout: () => null });
}

const okRes = (body, status = 200) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: () => null },
  text: async () => body,
});

test('a redirect loop is reported as a FAILURE, not followed', async () => {
  // The exact shape of the outage: 301 whose Location is the request path.
  const check = loadCheckPublic(async () => ({
    status: 301, ok: false,
    headers: { get: (h) => (h === 'location' ? '/' : null) },
    text: async () => '',
  }));
  const r = await check('https://itsnum.com/', 'NUM');
  assert.equal(r.ok, false, 'a 301 loop passed the health check — this is the 4 Aug outage, undetected');
  assert.equal(r.status, 301);
  assert.match(r.remedy, /redirect loop/i, 'the alert does not tell the reader what a self-referential 301 means');
});

test('redirects are never followed', () => {
  // fetch() and curl will happily chase a loop and report the last hop, which
  // reads as a slow success. Refusing to follow is what turns it into a no.
  const fn = src.slice(src.indexOf('async function checkPublic('), src.indexOf('export async function runHealth'));
  assert.match(fn, /redirect:\s*'manual'/,
    "the probe follows redirects, so a loop would look like a slow 200 instead of a failure");
});

test('a 200 serving the wrong page still fails', async () => {
  // A parked page, a stale deploy, or the SPA shell where the marketing site
  // belongs are all 200s — and all outages to the person reading them.
  const check = loadCheckPublic(async () => okRes('<html>parked domain</html>'));
  const r = await check('https://itsnum.com/', 'NUM');
  assert.equal(r.ok, false, 'a 200 with the wrong content passed — content is not being asserted');
  assert.match(r.remedy, /does not contain/i);
});

test('the healthy case passes', async () => {
  const check = loadCheckPublic(async () => okRes('<html><title>NUM — concierge</title></html>'));
  const r = await check('https://itsnum.com/', 'NUM');
  assert.equal(r.ok, true, 'a genuinely healthy page was reported as failing — this would cry wolf');
});

test('an unreachable host fails without throwing', async () => {
  // A monitor that can crash is a monitor that stops monitoring.
  const check = loadCheckPublic(async () => { throw new Error('network unreachable'); });
  const r = await check('https://itsnum.com/', 'NUM');
  assert.equal(r.ok, false);
  assert.match(r.remedy, /could not be reached/i);
});

test('the cross-Worker probe is wired in', () => {
  const rh = src.slice(src.indexOf('export async function runHealth'));
  assert.match(rh, /site_public:/, 'itsnum.com is not checked');
  assert.match(rh, /checkPublic\('https:\/\/itsnum\.com\//, 'the marketing site URL is not probed');
});

test('this Worker never probes its own hostname', () => {
  // A Worker fetching its own public host makes a subrequest that loops back
  // into itself; Cloudflare answers 522. The first version of this file did
  // exactly that and reported a false "down" while the app was healthy.
  // Crying wolf is worse than the blind spot, because people mute wolves.
  const rh = src.slice(src.indexOf('export async function runHealth'));
  assert.ok(!/checkPublic\('https:\/\/app\.itsnum\.com/.test(rh),
    'num-app is probing app.itsnum.com — its own host. That returns 522 and produces a false outage.');
});

test('the self-probe limitation is documented, not silently dropped', () => {
  // A missing check that nobody knows is missing is how the 4 Aug outage
  // stayed invisible. The gap has to be written down where the next person
  // reading this file will see it.
  const rh = src.slice(src.indexOf('export async function runHealth'));
  assert.match(rh, /522/, 'the reason the app self-probe was removed is not recorded');
  assert.match(rh, /external/i, 'no note that an external prober is needed to cover the app host');
});

test('a dead front door is DOWN, not merely degraded', () => {
  // "Degraded" gets read as "a feature is off". A site nobody can load is not
  // a degraded feature, and the alert wording has to say so.
  const rh = src.slice(src.indexOf('export async function runHealth'));
  const down = rh.slice(rh.indexOf('const DOWN'), rh.indexOf('const verdict'));
  for (const k of ['site_public']) {
    assert.ok(down.includes(k), `${k} failing would only report 'degraded' — an outage would read as a minor issue`);
  }
});

test('the public endpoint reports what the cron saw, not a fresh probe', () => {
  // On 4 Aug the endpoint re-ran the probe per request and reported "down"
  // while the cron reported "ok" — the monitor disagreeing with itself. It
  // also made every uptime poll trigger an outbound fetch.
  const h = src.slice(src.indexOf('const out = await runHealthFromLastRun') - 900,
                      src.indexOf('// PUBLIC gets the verdict'));
  assert.match(h, /runHealthFromLastRun/,
    'the public endpoint re-probes on every request instead of reading the last cron result');
});

test('a stalled cron is reported as down, not as a stale ok', () => {
  // A monitor that serves a fifteen-minute-old "ok" after the cron dies is
  // lying by omission — the exact failure mode this whole file exists to end.
  const fn = src.slice(src.indexOf('async function runHealthFromLastRun'), src.indexOf('export async function runHealth'));
  assert.match(fn, /health_cron_stalled/, 'a dead cron would still report the last good verdict');
  assert.match(fn, /ageMin > \d+/, 'there is no staleness threshold');
});
