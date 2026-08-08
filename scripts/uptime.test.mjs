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

test('the entrypoint check cannot silently no-op', () => {
  // `import.meta.url === \`file://${process.argv[1]}\`` does not match when the
  // checkout path contains a space or any character needing percent-encoding.
  // When it fails it fails invisibly: nothing runs, exit code 0, workflow
  // green, zero probes. pathToFileURL does the encoding correctly.
  const src = readFileSync(join(HERE, 'uptime.mjs'), 'utf8');
  assert.ok(!/file:\/\/\$\{process\.argv\[1\]\}/.test(src),
    'the entrypoint uses a hand-built file:// URL — on a path with a space the probe silently does nothing and reports success');
  assert.match(src, /pathToFileURL\(process\.argv\[1\]\)/, 'the entrypoint guard is not encoding-safe');
});

// NOTE — there is deliberately no test here that shells out and probes the
// live site. `release:stage` is gated on `npm test`, so a network assertion in
// this suite would mean an outage blocks shipping the fix for that outage. The
// end-to-end path is covered instead by the workflow's `push:` trigger on
// scripts/uptime.mjs, which runs the real thing whenever the probe changes.

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

// ── the synthetic ask ─────────────────────────────────────────────────────
//
// On 6–7 Aug every GET probe was green while every actual question was being
// answered by the fallback: a ReferenceError fired after the model had already
// answered, and `degraded: true` rode back in a 200. Status-code monitoring
// cannot see that. Only asking a real question can.

const ask = TARGETS.find((t) => t.name === 'ask');

test('the monitor asks a real question, not just GETs', () => {
  assert.ok(ask, 'the synthetic ask target is gone — the monitor is back to measuring servers instead of answers');
  assert.equal(ask.method, 'POST', 'the ask probe no longer POSTs — it cannot reach the model path');
  assert.match(ask.body, /"my /, 'the probe question lost its first-person marker — the answer cache will serve it and the model path goes unmeasured');
});

test('a degraded answer is an outage, even inside a 200', () => {
  // The exact body shape from the two lost days.
  const v = evaluate(ask, res({ body: '{"reply":"Here is what is near you...","degraded":true,"lane":"last-resort"}' }));
  assert.equal(v.ok, false, 'degraded:true passed the monitor — the two-day outage would be invisible again');
  assert.match(v.remedy, /CODE BUG/i, 'the remedy no longer warns that this can be a code bug rather than quota');
  assert.match(v.remedy, /num_brain_events/, 'the remedy no longer points at the table that settles code-bug vs outage');
});

test('a healthy answer passes', () => {
  const v = evaluate(ask, res({ body: '{"reply":"Issara on Kata Beach — lively, a kilometre away.","card":null}' }));
  assert.equal(v.ok, true, 'a working answer failed the probe — it would alert on every healthy turn');
});
