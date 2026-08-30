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
import {
  handlePartnerMcp, partnerFrom, partnerIndex, ATTRIBUTION, TOOLS_FOR_TEST,
  enforcePartnerLimit, throttled, UNKEYED_POLICY, LIMIT_UNKEYED_PER_MIN,
} from './partnermcp.mjs';

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
  assert.equal(tools.length, 6, 'the partner tool set changed — update the integration doc before shipping this');
  for (const t of tools) {
    assert.ok(t.description.length > 120, `${t.name}: description too thin to choose from`);
    assert.match(t.description, /NEVER|never|not|MUST|only/,
      `${t.name}: says what it does but not what it refuses`);
  }
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names,
    ['booking_link', 'concierge_answer', 'list_destinations', 'open_places', 'place_details', 'search_places']);
});

test('the booking tool forbids the one sentence that would matter', () => {
  // An agent that renders a prefilled link as "Table booked" sends somebody to
  // a restaurant that is not expecting them. The prohibition has to be in the
  // description, because that is the only part of this file the agent reads.
  const t = TOOLS_FOR_TEST.find((x) => x.name === 'booking_link');
  assert.match(t.description, /does NOT make a reservation/);
  assert.match(t.description, /MUST NOT tell a traveller a table is held/);
  const open = TOOLS_FOR_TEST.find((x) => x.name === 'open_places');
  assert.match(open.description, /NOT an empty city/,
    'nothing warns that thin hours coverage looks identical to a shut city');
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
  for (const fn of ['list_destinations', 'search_places', 'place_details', 'concierge_answer',
                    'open_places', 'booking_link']) {
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
  assert.equal(j.tools.length, 6);
  assert.match(j.auth, /Unkeyed calls work/,
    'the index no longer says evaluation is possible without a key — that is the whole point of it');
  assert.ok(j.contact, 'no contact route for a partner who gets stuck');
  // A partner who needs bookings must find the door in the same breath as the
  // refusal, or they conclude Num cannot do it and integrate someone else.
  assert.match(j.bookings.mcp, /\/api\/concierge\/mcp/);
});

test('the published limit is a number, and the same number the code enforces', async () => {
  // The index said "rate-limited" and nothing more. A partner cannot write a
  // retry policy against an adjective, and — more to the point — an adjective
  // cannot be checked, so nobody could tell whether it was still true.
  const j = JSON.parse(await partnerIndex().text());
  assert.equal(j.auth, UNKEYED_POLICY, 'the index describes a policy other than the one exported next to the limiter');
  assert.match(UNKEYED_POLICY, new RegExp(`${LIMIT_UNKEYED_PER_MIN} per minute per IP`),
    'the published sentence and the enforced constant disagree');
  assert.match(UNKEYED_POLICY, /discovery \(initialize, tools\/list\) is never throttled/,
    'the policy no longer promises open discovery — an agent throttled mid-handshake reports Num as down');
});

test('a throttle is answered in JSON-RPC, not in prose', async () => {
  // The blanket gate in index.mjs answers `{"error": "..."}` with no jsonrpc
  // and no id. An MCP client cannot correlate that with its pending request, so
  // "slow down" arrives as "this server is broken". This surface must not.
  const res = throttled(7, { retryAfter: 30 }, false);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '30');
  const j = JSON.parse(await res.text());
  assert.equal(j.jsonrpc, '2.0');
  assert.equal(j.id, 7, 'the throttle dropped the request id, so the client cannot match it to anything');
  assert.equal(j.error.code, -32003);
  assert.match(j.error.message, /X-Partner-Key/, 'the throttle does not tell an unkeyed caller how to stop being throttled');
  assert.match(j.error.message, /Nothing was changed/);

  const keyed = JSON.parse(await throttled(7, { retryAfter: 5 }, true).text());
  assert.doesNotMatch(keyed.error.message, /POST \/api\/partner\/signup/,
    'a partner who already has a key is being told to go and get one');
});

test('keyed and unkeyed traffic do not share a bucket', async () => {
  // A signed partner integrates from one server address. Bucketing them by IP
  // puts a whole platform's travellers on the ceiling built for anonymous
  // evaluation — the friction landing on the money, which is exactly the thing
  // this file says it will not do.
  const seen = [];
  const env = {
    RATE_LIMITER: { limit: async ({ key }) => { seen.push(['RATE_LIMITER', key]); return { success: true }; } },
    PARTNER_LIMITER: { limit: async ({ key }) => { seen.push(['PARTNER_LIMITER', key]); return { success: true }; } },
  };
  const req = (headers) => new Request('https://app.itsnum.com/api/partner/mcp', { method: 'POST', headers });

  await enforcePartnerLimit(env, req({ 'CF-Connecting-IP': '1.2.3.4' }), { id: null, keyed: false });
  await enforcePartnerLimit(env, req({ 'CF-Connecting-IP': '1.2.3.4', 'X-Partner-Key': 'lg2t_x' }), { id: 'lg2t', keyed: true });

  assert.deepEqual(seen, [['RATE_LIMITER', '1.2.3.4'], ['PARTNER_LIMITER', 'partner:lg2t']],
    'keyed and unkeyed callers are being counted against the same binding and the same key');
});

test('a missing limiter binding is reported, not silently tolerated', async () => {
  // guard.mjs fails open on purpose — a limiter outage must not take the
  // product down. On a surface that publishes a specific number, failing open
  // means the published promise is quietly not being kept, so the caller has to
  // be able to see it. Before this flag existed, "we are limited" and "the
  // binding is missing" were the same observable.
  const out = await enforcePartnerLimit({}, new Request('https://x/', { method: 'POST' }), { id: null, keyed: false });
  assert.equal(out.ok, true, 'a missing binding now blocks traffic — that is an outage, not a safeguard');
  assert.equal(out.degraded, true, 'a missing binding is indistinguishable from an enforced limit');
});

test('discovery is never throttled', () => {
  // Asserted against the source because the limiter call site is what matters:
  // it must sit inside the tools/call branch, after the branches that answer
  // initialize and tools/list.
  const src = readFileSync(join(HERE, 'partnermcp.mjs'), 'utf8');
  const listAt = src.indexOf("method === 'tools/list'");
  // The CALL SITE, not the declaration — indexOf would find the exported
  // function above and pass no matter where it is actually invoked.
  const limitAt = src.indexOf('const limit = await enforcePartnerLimit(');
  assert.ok(listAt > 0 && limitAt > listAt,
    'the rate limiter now runs before tools/list — an agent doing discovery will be throttled and report Num as down');
});

test('the MCP routes are exempt from the blanket POST /api/* gate', () => {
  // That gate answers a bare {"error": …} with no JSON-RPC envelope and counts
  // the handshake against the same twelve as the work. Both of those are wrong
  // for this endpoint, so it limits itself instead — and if the exemption is
  // ever removed without removing the self-limiter, every call is counted twice.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /isSelfLimitedMcp/, 'the MCP endpoints are back under the blanket rate limiter');
  assert.match(index, /!isWebhook && !isSelfLimitedMcp/, 'the exemption is declared but not applied');
});

test('concierge_answer calls handleNum directly, not a route that may not exist', () => {
  // The first draft of partnermcp.mjs forwarded to `/api/ask`. There is no
  // such route — the concierge's only POST path is `/api/num` — so the most
  // important tool in the partnership would have 404'd on a partner's first
  // call, on the day of the demo. Guessing an internal path is cheap to do and
  // expensive to discover.
  //
  // On 29 Aug 2026 the fetch()-based fwd('/api/num') call — which guessed
  // right about the path but wrong about the mechanism (see the test below) —
  // was replaced with a direct import and call of handleNum(). This checks
  // the new contract: the handler is imported from index.mjs and invoked by
  // name, and the phantom /api/ask path never comes back.
  const src = readFileSync(join(HERE, 'partnermcp.mjs'), 'utf8');
  assert.match(src, /await import\('\.\/index\.mjs'\)/,
    'concierge_answer no longer imports handleNum from index.mjs — check the export still exists before changing this');
  assert.match(src, /handleNum\(/, 'concierge_answer no longer calls handleNum — the direct-call fix regressed');
  assert.doesNotMatch(src, /fwd\('\/api\/ask'/, 'the phantom /api/ask endpoint is back');
  assert.doesNotMatch(src, /fwd\('\/api\/num'/,
    'concierge_answer is fetch()-ing /api/num again — see the 18 Aug 2026 self-fetch/522 note below');
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /export async function handleNum\(request, env, ctx\)/,
    'handleNum is no longer an importable export — concierge_answer has nothing to call directly');
});

test('no tool reaches Num over its own public hostname any more', () => {
  // A Worker fetching its own public hostname loops back through the Cloudflare
  // edge, which answers 522 — a fact this repository already wrote down, in
  // .github/workflows/uptime.yml:6, before this file was written.
  //
  // concierge_answer used to do exactly that: fwd('/api/num') was a subrequest
  // to app.itsnum.com. Measured on 18 Aug 2026 it returned 522 in under a
  // second, deterministically, on every attempt — the most important tool in
  // the partnership, dead for every caller, while tools/list stayed green. The
  // other five tools imported their handler directly and were unaffected.
  //
  // On 29 Aug 2026 /api/num's logic was extracted into handleNum()
  // (worker/index.mjs, exported for exactly this) and concierge_answer now
  // imports and calls it the same way open_places and booking_link already
  // called openapi.mjs. This guards the fix staying fixed: zero loopback call
  // sites, ever, on this surface.
  const src = readFileSync(join(HERE, 'partnermcp.mjs'), 'utf8');
  const loopbacks = src.match(/await fwd\(/g) ?? [];
  assert.equal(loopbacks.length, 0,
    'a tool is fetching Num over its own public hostname again. That subrequest loops back through the ' +
    'edge and answers 522 (see .github/workflows/uptime.yml:6). Import the handler directly instead, as ' +
    'open_places, booking_link and concierge_answer all do now.');
  for (const direct of ["import('./openapi.mjs')", "import('./index.mjs')"]) {
    assert.ok(src.includes(direct), `the direct-import path ${direct} is gone; a tool may be back on the loopback`);
  }
});

test('concierge_answer actually reaches handleNum end to end, not just in source text', async () => {
  // Everything above this test checks partnermcp.mjs's TEXT. This drives the
  // real call: handlePartnerMcp -> callTool -> concierge_answer ->
  // import('./index.mjs') -> handleNum(), with no ANTHROPIC_API_KEY bound, so
  // handleNum answers its own clean 401 with no network call and no DB
  // needed (guard.mjs's enforceRateLimit degrades open with no RATE_LIMITER
  // binding). If concierge_answer were still fetch()-ing its own hostname,
  // this would hit the exact 522 measured on 18 Aug 2026 instead — Node's
  // fetch has no route back to itself either, so that failure mode surfaces
  // here as a network error, not a clean 401.
  const req = new Request('https://app.itsnum.com/api/partner/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'concierge_answer', arguments: { question: 'where should we eat', destination: 'patong' } },
    }),
  });
  const env = {}; // no ANTHROPIC_API_KEY, no RATE_LIMITER, no DB — see comment above
  const ctx = { waitUntil() {} };
  const j = await rpcJson(await handlePartnerMcp(req, env, ctx));
  assert.ok(!j.error, `tools/call itself failed: ${JSON.stringify(j.error)}`);
  const out = JSON.parse(j.result.content[0].text);
  assert.match(out.error, /Num could not answer right now \(401\)/,
    'concierge_answer did not reach handleNum and surface its 401 cleanly — check the direct-import wiring');
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
