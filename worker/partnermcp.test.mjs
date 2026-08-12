// The partner surface, held to the promises its tool descriptions make.
//
// A partner integration is read once by an engineer and then trusted forever.
// If a tool says "never invents a place" or "you must display attribution",
// that is a contract with someone else's product — and the way those quietly
// stop being true is that nobody tests the sentence, only the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePartnerMcp, partnerFrom, partnerIndex, ATTRIBUTION } from './partnermcp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const post = (body, headers = {}) =>
  new Request('https://app.itsnum.com/api/partner/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
const rpcJson = async (res) => JSON.parse(await res.text());

test('initialize tells the partner what this is and what it refuses', async () => {
  const j = await rpcJson(await handlePartnerMcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize' }), {}));
  assert.equal(j.result.serverInfo.name, 'num-partners');
  assert.match(j.result.instructions, /attribution/i,
    'the handshake does not mention attribution — a partner can ship without it and put us both in breach of ODbL');
  assert.match(j.result.instructions, /never book, charge, or accept personal data/i,
    'the handshake no longer states the hard limits; an agent will try to book and report Num as broken');
});

test('every tool description states a refusal, not just a capability', async () => {
  // A model that learns a limit by hitting an error tells the user the
  // integration is broken. Limits belong in the description.
  const j = await rpcJson(await handlePartnerMcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), {}));
  const tools = j.result.tools;
  assert.equal(tools.length, 4, 'the partner tool set changed — update the integration doc before shipping this');
  for (const t of tools) {
    assert.ok(t.description.length > 120, `${t.name}: description too thin to choose from`);
    assert.match(t.description, /NEVER|never|not|MUST|only/,
      `${t.name}: says what it does but not what it refuses`);
  }
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['concierge_answer', 'list_destinations', 'place_details', 'search_places']);
});

test('unknown tools and bad JSON fail politely, never silently', async () => {
  const bad = await rpcJson(await handlePartnerMcp(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'book_flight', arguments: {} } }), {}));
  assert.equal(bad.error.code, -32602);
  assert.match(bad.error.message, /Unknown tool/,
    'an unknown tool returns something other than a clear refusal — a partner will read it as a Num outage');

  const junk = await handlePartnerMcp(
    new Request('https://app.itsnum.com/api/partner/mcp', { method: 'POST', body: 'not json' }), {},
  );
  assert.equal((await rpcJson(junk)).error.code, -32700);
});

test('a partner is identified when keyed, and served when not', () => {
  // Friction belongs at the money, not at the demo: an engineer evaluating the
  // integration must never have to email anyone to see a result.
  assert.deepEqual(partnerFrom(new Request('https://x/', { headers: { 'X-Partner-Key': 'lg2t_abc123' } })),
    { id: 'lg2t', keyed: true });
  assert.deepEqual(partnerFrom(new Request('https://x/')), { id: null, keyed: false });
});

test('attribution is one string, used everywhere', () => {
  // Two copies of a licence notice means one of them goes stale.
  assert.match(ATTRIBUTION, /OpenStreetMap contributors \(ODbL\)/);
  assert.match(ATTRIBUTION, /must be displayed/i);
  const src = readFileSync(join(HERE, 'partnermcp.mjs'), 'utf8');
  const literals = src.match(/© OpenStreetMap contributors/g) ?? [];
  assert.equal(literals.length, 1,
    'the attribution string is duplicated — one copy will drift out of date and the drifted one will ship');
  for (const fn of ['list_destinations', 'search_places', 'place_details', 'concierge_answer']) {
    assert.ok(src.includes(fn), `${fn} vanished from the handler`);
  }
});

test('the partner surface is wired into the worker', () => {
  // A server nobody routed to is a file, not an integration.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /'\/api\/partner\/mcp'/, 'the MCP endpoint is not routed');
  assert.match(index, /partnerIndex\(\)/, 'the human-readable front door is not routed');
});

test('the front door tells an engineer everything needed to start', async () => {
  const j = JSON.parse(await partnerIndex().text());
  assert.match(j.mcp, /POST \/api\/partner\/mcp/);
  assert.equal(j.tools.length, 4);
  assert.match(j.auth, /Unkeyed calls work/,
    'the index no longer says evaluation is possible without a key — that is the whole point of it');
  assert.ok(j.contact, 'no contact route for a partner who gets stuck');
});

test('concierge_answer calls the endpoint that exists', () => {
  // The first draft of partnermcp.mjs forwarded to `/api/ask`. There is no
  // such route — the concierge's only POST path is `/api/num` — so the most
  // important tool in the partnership would have 404'd on a partner's first
  // call, on the day of the demo. Guessing an internal path is cheap to do and
  // expensive to discover.
  const src = readFileSync(join(HERE, 'partnermcp.mjs'), 'utf8');
  assert.match(src, /fwd\('\/api\/num'/,
    'concierge_answer no longer posts to /api/num — check the route still exists before changing this');
  assert.doesNotMatch(src, /fwd\('\/api\/ask'/, 'the phantom /api/ask endpoint is back');
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /url\.pathname !== '\/api\/num'/,
    'the concierge route moved; partnermcp.mjs forwards to a path that no longer exists');
});

test('partner traffic does not share one rate-limit bucket', () => {
  // The concierge limits by CF-Connecting-IP. A subrequest without it lands
  // every partner on earth in the same 'unknown' bucket, where the busiest one
  // throttles all the others.
  const src = readFileSync(join(HERE, 'partnermcp.mjs'), 'utf8');
  assert.match(src, /'CF-Connecting-IP': request\.headers\.get\('CF-Connecting-IP'\)/,
    'the caller IP is no longer forwarded — partners will throttle each other');
});

test('places come from the directory, never from the reply schema', () => {
  // REPLY_SCHEMA carries reply/card/chips/actions. It has never carried a
  // `picks` array; reading one returns undefined and a partner renders an
  // empty card rail while the prose names three restaurants.
  const src = readFileSync(join(HERE, 'partnermcp.mjs'), 'utf8');
  assert.doesNotMatch(src, /j\.picks/,
    'concierge_answer reads j.picks again — that field does not exist in the reply schema');
  assert.match(src, /FROM places WHERE dest = \?1/,
    'structured places are no longer queried from the directory');
});
