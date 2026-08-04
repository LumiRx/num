// A monitor is only worth what it catches, so these tests are written as the
// outages themselves — each one replays a failure that has actually happened
// or that would go unnoticed, and asserts the probe says no.
//
// They never touch the network. evaluate() is pure by design precisely so the
// judgement can be exercised offline; the network half is a five-line fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, TARGETS } from './uptime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const site = TARGETS.find((t) => t.name === 'site');
const app = TARGETS.find((t) => t.name === 'app');
const health = TARGETS.find((t) => t.name === 'app_health');

const res = (over = {}) => ({ status: 200, location: null, body: '', error: null, ...over });

test('the 4 Aug redirect loop is caught', () => {
  // The exact shape: apex 301s to a retired Pages project which 301s back.
  const v = evaluate(site, res({ status: 301, location: 'https://itsnum.com/' }));
  assert.equal(v.ok, false, 'a 301 loop passed — this is the outage that ran for hours, undetected');
  assert.match(v.remedy, /redirect loop/i, 'the alert does not explain what a self-referential 301 means');
  assert.match(v.remedy, /Redeploy/i, 'the alert names no action for the person reading it');
});

test('a 200 serving the wrong page is still an outage', () => {
  // Parked domain, stale deploy, SPA shell where the marketing site belongs.
  const v = evaluate(site, res({ body: '<html>parked domain</html>' }));
  assert.equal(v.ok, false, 'content is not being asserted — a 200 was taken as proof the product is there');
  assert.match(v.reason, /missing/i);
});

test('a healthy page passes', () => {
  // Crying wolf is how monitors get muted, so the happy path is pinned too.
  assert.equal(evaluate(site, res({ body: '<a href="https://itsnum.com/app">' })).ok, true);
  assert.equal(evaluate(app, res({ body: '{"version":"0.8.148"}' })).ok, true);
  assert.equal(evaluate(health, res({ body: '{"verdict":"ok","failing":0}' })).ok, true);
});

test('an unreachable host fails without throwing', () => {
  const v = evaluate(site, res({ error: 'getaddrinfo ENOTFOUND' }));
  assert.equal(v.ok, false);
  assert.match(v.remedy, /DNS/i, 'no pointer to the layer that actually broke');
});

test('a self-reported unhealthy verdict is surfaced, not swallowed', () => {
  // The endpoint answers 200 even when it is telling you it is broken. Reading
  // only the status code would score this a pass.
  const v = evaluate(health, res({ body: '{"verdict":"down","failing":2}' }));
  assert.equal(v.ok, false, 'health said "down" in a 200 body and the probe called it fine');
});

test('the app is probed at an endpoint only running code can answer', () => {
  // A cached static asset survives the Worker being dead. /api/version cannot
  // be served from cache alone, so it proves execution rather than delivery.
  assert.match(app.url, /\/api\//, 'the app probe hits a static path — a CDN cache could pass it with the Worker dead');
});

test('the app host is covered here because the Worker cannot cover itself', () => {
  // The entire reason this file exists. If someone removes it believing
  // worker/health.mjs has it handled, the blind spot returns silently.
  //
  // Asserted per-target, not with .some(). A .some() check over all targets
  // passes as long as ANY of them mentions the host — so repointing the
  // version probe at the wrong hostname slips through while a sibling target
  // keeps the assertion green. That is a guard that guards nothing.
  const host = (u) => new URL(u).host;
  assert.equal(host(app.url), 'app.itsnum.com',
    'the app probe is not pointed at app.itsnum.com — and health.mjs cannot probe it (self-fetch returns 522)');
  assert.equal(host(health.url), 'app.itsnum.com', 'the health probe left the app host');
  assert.equal(host(site.url), 'itsnum.com', 'the marketing site is unprobed');
});

test('redirects are never followed', () => {
  // fetch() chases a loop and reports the final hop, which reads as a slow
  // success. Refusing to follow is the single line that makes a loop visible.
  const src = readFileSync(join(HERE, 'uptime.mjs'), 'utf8');
  assert.match(src, /redirect:\s*'manual'/,
    'the probe follows redirects, so a loop would look like a slow 200 rather than a failure');
});

test('a failed probe exits non-zero, because that is what sends the alert', () => {
  // Printing "FAIL" and exiting 0 gives a green workflow and no notification —
  // a monitor that reports outages to nobody.
  const src = readFileSync(join(HERE, 'uptime.mjs'), 'utf8');
  assert.match(src, /process\.exit\(out\.ok \? 0 : 1\)/,
    'the script exits 0 on failure, so the workflow stays green and no alert is sent');
});

test('the workflow runs on a schedule, not only on push', () => {
  // An outage does not wait for a commit. A prober that only runs in CI on
  // push is a test, not a monitor.
  //
  // Anchored to the start of a line. An unanchored /schedule:/ also matches
  // "xschedule:", "# schedule:" and any other typo or comment-out that would
  // silently stop the monitor — which is precisely the mutation this test is
  // supposed to catch.
  const wf = readFileSync(join(HERE, '..', '.github', 'workflows', 'uptime.yml'), 'utf8');
  assert.match(wf, /^\s{2}schedule:$/m, 'no schedule key — this only runs when someone pushes');
  assert.match(wf, /^\s+- cron: '[^']+'$/m, 'no cron expression');
  assert.match(wf, /^\s{2}workflow_dispatch:$/m, 'cannot be run by hand during an incident');
});
