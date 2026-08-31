// The business MCP surface must not be throttled by a gate that cannot speak
// its language.
//
// 31 Aug 2026: `npm run mcp:integrity` failed on a LIVE deploy with
// "tools/list returned undefined" and "advertised tool does not work" against
// find_listing. Both readings were wrong. A single call answered perfectly and
// returned all six tools; only a burst failed, because the blanket
// 12/min-per-IP gate in index.mjs answered with `{"error":"You are going
// faster than I can keep up"}` — no `jsonrpc`, no `id`. An MCP client cannot
// correlate that to a pending request, so a throttle reads as a protocol
// fault and a healthy surface is reported as broken.
//
// index.mjs already carried a comment above the exemption list saying "Do NOT
// add a route here without giving it a limiter of its own." This route was
// added without one. These tests are that comment, enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bizThrottled, isDiscovery } from './bizmcp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
const bizmcp = readFileSync(join(HERE, 'bizmcp.mjs'), 'utf8');

test('the blanket gate no longer answers for this surface', () => {
  assert.match(index, /isSelfLimitedMcp[\s\S]{0,200}\/api\/biz\/mcp/,
    'the business MCP route is still under the blanket limiter, whose 429 is not JSON-RPC');
  assert.match(index, /!isWebhook && !isSelfLimitedMcp/, 'the exemption is declared but not applied');
});

test('and it limits itself instead — an exemption alone is an open door', () => {
  // Removing the blanket gate without adding a limiter would turn a false
  // "broken" report into a real absence of any ceiling at all.
  assert.match(bizmcp, /enforceRateLimit/, 'exempted from the blanket gate and given no limiter of its own');
  assert.match(bizmcp, /RATE_LIMITER/, 'not reusing the shared binding, so counters will drift apart');
});

test('a throttle is JSON-RPC, correlatable, and waitable', () => {
  const res = bizThrottled(7, 42);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '42');
  return res.json().then((body) => {
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 7, 'without the id an MCP client cannot match this to its request — the whole bug');
    assert.equal(body.error.code, -32003);
    assert.match(body.error.message, /Retry in 42s/);
    assert.match(body.error.message, /Nothing was changed/,
      'a throttled caller must be told no work happened, or it cannot safely retry');
  });
});

test('discovery is never throttled', () => {
  // initialize and tools/list are how an agent finds out what we can do.
  // Charging for them tells an agent that has called nothing yet that it is
  // calling too much — and discovery is a static list, not work.
  assert.equal(isDiscovery('initialize'), true);
  assert.equal(isDiscovery('notifications/initialized'), true);
  assert.equal(isDiscovery('tools/list'), true);
  assert.equal(isDiscovery('tools/call'), false, 'real work must be counted');

  const call = bizmcp.slice(bizmcp.indexOf("if (method === 'tools/call')"));
  assert.match(call.slice(0, 500), /enforceRateLimit/,
    'the limiter is not inside the tools/call branch, so discovery is being counted');
  const listIdx = bizmcp.indexOf("if (method === 'tools/list')");
  const callIdx = bizmcp.indexOf("if (method === 'tools/call')");
  assert.ok(bizmcp.indexOf('enforceRateLimit', listIdx) > callIdx,
    'the limiter runs before tools/list is answered, which throttles the handshake');
});
