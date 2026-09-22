/**
 * The guard's own judgement, tested offline.
 *
 * routecheck probes production, so it cannot run in the suite. What CAN be
 * tested — and must be, because this guard's whole value is that people
 * believe it — is how it classifies an answer. Two ways to be useless:
 * miss a swallowed form, or fail on a healthy endpoint until somebody
 * deletes the script. Both directions are asserted here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { apiCalls, probe } from './routecheck.mjs';

const reply = (status, type, body = '') => ({
  status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
  text: async () => body,
});

/** A fetch that answers POST and GET differently, like a real endpoint does. */
const fake = (byVerb) => async (_url, opts) => {
  const r = byVerb[opts?.method ?? 'GET'];
  if (!r) throw new Error('no answer configured');
  return r;
};

describe('what counts as swallowed', () => {
  test('a bare 405 with no body is the assets Worker — FAIL', async () => {
    const r = await probe({ host: 'https://itsnum.com', path: '/api/partner/signup' },
      fake({ POST: reply(405, null, '') }));
    assert.equal(r.ok, false);
    assert.match(r.why, /assets Worker/);
  });

  test('a 404 serving the site 404 page — FAIL', async () => {
    const r = await probe({ host: 'https://itsnum.com', path: '/api/nope' },
      fake({ POST: reply(404, 'text/html; charset=utf-8', '<!DOCTYPE html>') }));
    assert.equal(r.ok, false);
    assert.match(r.why, /404 page/);
  });

  test('a JSON validation error is a PASS — the door is open', async () => {
    const r = await probe({ host: 'https://itsnum.com', path: '/api/claims' },
      fake({ POST: reply(400, 'application/json', '{"ok":false,"error":"no_business"}') }));
    assert.equal(r.ok, true);
    assert.equal(r.status, 400);
  });

  test('a GET-only endpoint is asked again properly before being accused', async () => {
    const r = await probe({ host: 'https://itsnum.com', path: '/api/host/summary' },
      fake({
        POST: reply(405, 'text/plain;charset=UTF-8', 'Method Not Allowed'),
        GET: reply(200, 'application/json', '{"ok":true}'),
      }));
    assert.equal(r.ok, true, 'a healthy GET endpoint must not be reported as swallowed');
    assert.equal(r.verb, 'GET');
  });

  test('a 405 that carries a body came from code, not from the assets Worker', async () => {
    const r = await probe({ host: 'https://itsnum.com', path: '/api/something' },
      fake({
        POST: reply(405, 'text/plain', 'Method Not Allowed'),
        GET: reply(405, 'text/plain', 'Method Not Allowed'),
      }));
    assert.equal(r.ok, true, 'something answered — that is a verb problem, not a routing hole');
  });

  test('an unreachable host is reported, never silently passed', async () => {
    const r = await probe({ host: 'https://itsnum.com', path: '/api/x' },
      async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    assert.equal(r.ok, false);
    assert.match(r.why, /unreachable/);
  });
});

describe('finding what a page calls', () => {
  test('relative fetches are found; absolute ones are left alone', () => {
    const found = apiCalls(`
      fetch('/api/partner/signup', {method:'POST'})
      fetch("https://app.itsnum.com/api/partner/mcp")
      window.NUM.call('/api/claim', 'POST', f)
      var ENDPOINT = "/api/claims";
    `);
    assert.ok(found.includes('/api/partner/signup'));
    assert.ok(found.includes('/api/claim'));
    assert.ok(found.includes('/api/claims'));
    assert.ok(!found.some((p) => p.includes('app.itsnum.com')),
      'an absolute URL names its own host and cannot fall through by accident');
  });

  test("a template literal's prefix is not reported as an endpoint", () => {
    // fetch('/api/host/' + path) leaves "/api/host" behind. Probing that
    // reported a failure that was only this regex's shadow.
    const found = apiCalls(`
      fetch('/api/host/' + path + '?k=' + k)
      fetch('/api/host/join', {method:'POST'})
    `);
    assert.ok(found.includes('/api/host/join'));
    assert.ok(!found.includes('/api/host'), 'the prefix is a shadow, not a call');
  });
});
