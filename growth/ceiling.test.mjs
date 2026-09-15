// The durable ceiling on the growth worker.
//
// This worker serves every money route — /p/*, /api/venue/*, the whole /biz/
// console — and until 13 Sep 2026 its only limiter was `overLimit`, a Map
// inside one isolate. Its own comment says it is not a distributed limiter, and
// worker/guard.mjs records 14 rapid requests sailing past a 12/minute bucket
// IN PRODUCTION. num-app has had a real binding since launch; this one had
// none, which is why every durable limit added over those two days — the
// check-in guessing lock, the claim resend cap, host signups, partner keys —
// had to be hand-rolled as a COUNT(*) against D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;
const SRC = readFileSync(HERE + 'worker.js', 'utf8');
const WR = readFileSync(HERE + 'wrangler.jsonc', 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/* MEASURED 15 SEP 2026: THIS BINDING DOES NOT ENFORCE.
 * 160 calls on one fixed key, one colo (every cf-ray said DFW), 38 seconds,
 * against 60/60 — all allowed. wrangler --dry-run reports it correctly and the
 * worker gets a well-shaped {success:true} back; it simply never refuses.
 *
 * These tests still assert the binding is DECLARED and wired, because a fast
 * path that may start working is worth keeping and worth keeping correct. They
 * must not be read as evidence that the worker is rate limited. The real limits
 * are the D1 counters and the per-route brakes, and they have their own tests. */
test('the limiter is declared, wired, and not mistaken for a protection', () => {
  const cfg = JSON.parse(WR.replace(/^\s*\/\/.*$/gm, ''));
  assert.ok(Array.isArray(cfg.ratelimits) && cfg.ratelimits.length >= 1,
    'growth has no ratelimits binding — the Map in overLimit() is not a limit');
  const b = cfg.ratelimits.find((x) => x.name === 'ACTION_LIMITER');
  assert.ok(b, 'ACTION_LIMITER must exist — the router calls it by that name');
  assert.ok(b.simple?.limit > 0 && b.simple?.period > 0, 'it needs a real window');
  assert.ok(b.simple.limit <= 120,
    `${b.simple.limit}/min is not a ceiling — the tightest route here allows 5`);

  // The claim in the config must match the measurement. If somebody re-writes
  // that comment into a promise, this is what says no.
  assert.match(WR, /MEASURED NOT TO ENFORCE/,
    'the config must record that this binding was measured not to refuse');
});

test('the ceiling is applied once, in the router, not per handler', () => {
  // Per-handler is how an endpoint added next month quietly has no limit.
  const code = strip(SRC);
  assert.match(code, /if \(await overCeiling\(req, env, p\)\)/,
    'the router must apply it');
  const fetchAt = code.indexOf('async fetch(req, env, ctx)');
  const call = code.indexOf('await overCeiling(req, env, p)');
  assert.ok(call > fetchAt && call - fetchAt < 1800,
    'it must sit near the top of the router, before the route table');
});

test('it fails open, and says so out loud', () => {
  const i = SRC.indexOf('async function overCeiling');
  const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
  assert.match(fn, /return false;/, 'a limiter outage must not take the product down');
  assert.match(fn, /console\.warn\("\[growth\] ACTION_LIMITER threw/,
    'a SILENT fail-open is how you believe you are protected when you are not');
  // A MISSING BINDING MUST SAY SO. It did not, until 15 Sep: 90 parallel
  // requests went through untouched and nothing could tell whether the limiter
  // had allowed them or had never existed. That is the same silent degradation
  // this whole review kept finding in other people's code, written by me, two
  // days after writing the doc about it. guard.mjs has warned here since launch.
  assert.match(fn, /console\.warn\("\[growth\] ACTION_LIMITER is not bound/,
    'a binding that never materialised is indistinguishable from a working one '
    + 'unless it SAYS so — asserting the message alone passes with the call removed');
  assert.match(fn, /if \(!limiter\?\.limit\) \{/,
    'a missing binding must degrade, not throw on every request');
});

test('the beacons are exempt, on purpose and in writing', () => {
  const i = SRC.indexOf('const RATE_LIMIT_EXEMPT');
  assert.ok(i > 0, 'the exemptions must be one named list, not scattered conditions');
  const list = SRC.slice(i, SRC.indexOf(']);', i));
  for (const pth of ['/api/ev', '/api/growth/health']) {
    assert.ok(list.includes(`"${pth}"`), `${pth} must be listed`);
  }
  // The health check has to answer while everything else is being refused, or
  // the first thing an outage breaks is the tool you diagnose it with.
  assert.match(list, /signing the payload/i,
    'the beacon exemption needs its reason beside it');
  assert.match(list, /has to answer while everything else is being refused/i,
    'so does the health exemption — an exemption without a stated reason '
    + 'becomes a hole nobody remembers making');
});

test('the isolate brake is kept, not replaced', () => {
  // Defence in depth: the Map is free and catches a burst on whichever isolate
  // you land on. It was never the guarantee — that is the whole point — but
  // removing it would trade one real layer for another.
  assert.match(SRC, /function overLimit\(key, perMinute\)/,
    'the per-route brakes still rely on it');
  assert.ok(SRC.split('overLimit("').length - 1 >= 10,
    'the per-route limits should still be in place underneath the ceiling');
});

test('health reports what the limiter DOES, not merely that it exists', () => {
  // "bound: true" came back while 90 requests in three seconds, one IP, well
  // past a ceiling of 60, went through untouched. A binding that EXISTS and a
  // binding that WORKS are two different claims and only the second matters.
  const i = SRC.indexOf('async function limiterProbe');
  assert.ok(i > 0, 'health must call the limiter, not just check for its presence');
  const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
  assert.match(fn, /await l\.limit\(\{ key: "healthprobe" \}\)/,
    'it must actually call limit(), on a key of its own so probing spends nobody else\'s budget');
  assert.match(fn, /"not bound"/, 'absent must be distinguishable');
  assert.match(fn, /"bound, allows"|"bound, refuses"/, 'and so must allowed vs refused');
  assert.match(fn, /throws: /, 'and a throw is an answer too, not a shrug');
  // `!out?.success` on a missing field reads as "over the limit" and would
  // refuse everything — so an unreadable reply is worth naming, not ignoring.
  assert.match(fn, /unreadable reply/, 'a wrong-shaped reply must be reported, not coerced');
});

test('health reports whether the ceiling is actually bound', () => {
  // The only way to answer "is the limiter real" without inferring it from a
  // load test — which cannot distinguish "allowed" from "absent".
  assert.match(SRC, /ACTION_LIMITER: await limiterProbe\(env\)/,
    'the deploy check must state what the binding does');
  const i = SRC.indexOf('async function health(env)');
  const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
  assert.match(fn, /ACTION_LIMITER/, 'and it has to be inside health, not merely defined');
});
