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

test('the worker that serves the money has a real limiter bound', () => {
  const cfg = JSON.parse(WR.replace(/^\s*\/\/.*$/gm, ''));
  assert.ok(Array.isArray(cfg.ratelimits) && cfg.ratelimits.length >= 1,
    'growth has no ratelimits binding — the Map in overLimit() is not a limit');
  const b = cfg.ratelimits.find((x) => x.name === 'ACTION_LIMITER');
  assert.ok(b, 'ACTION_LIMITER must exist — the router calls it by that name');
  assert.ok(b.simple?.limit > 0 && b.simple?.period > 0, 'it needs a real window');
  assert.ok(b.simple.limit <= 120,
    `${b.simple.limit}/min is not a ceiling — the tightest route here allows 5`);
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
  assert.match(fn, /if \(!limiter\?\.limit\) return false;/,
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
