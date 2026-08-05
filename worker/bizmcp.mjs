/**
 * Num for Business — MCP server.
 *
 * The same capabilities as bizapi.mjs, exposed so an AI assistant can claim and
 * manage a listing on a business's behalf. A restaurateur will not log into a
 * dashboard every week; increasingly they will ask an assistant, and the
 * assistant needs somewhere to plug in.
 *
 * Deliberately a thin wrapper over the HTTP API rather than a parallel
 * implementation. Two code paths to the same data drift, and the one that
 * drifts silently is always the one fewer people use. Every tool here calls the
 * same handler a curl would.
 *
 * TOOL DESCRIPTIONS ARE THE INTERFACE
 *
 * A model picks tools by reading their descriptions, so each one says what it
 * does AND what it will refuse. `update_listing` states up front that category
 * and ranking are not editable — otherwise an agent tries, gets an error, and
 * reports back that Num is broken rather than that the request was out of
 * bounds.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST (streamable-HTTP MCP). No SSE — every
 * call here is a short request/response, and a streaming transport would add a
 * connection lifecycle for no benefit.
 */
import { handleBizApi } from './bizapi.mjs';

const rpc = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});
const rpcErr = (id, code, message) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});

const TOOLS = [
  {
    name: 'find_listing',
    description:
      'Find a business listing on Num by name and/or destination. Use this first — every other tool needs a place_id. ' +
      'Returns up to 20 matches with their place_id, address and current details. No authentication needed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Business name, or part of it.' },
        destination: { type: 'string', description: 'Destination slug, e.g. "phuket", "london", "bali".' },
      },
    },
  },
  {
    name: 'start_claim',
    description:
      'Begin proving ownership of a listing. Num sends a verification code to the email or phone number ALREADY PUBLISHED on that listing — ' +
      'you cannot choose where it goes, because that is what makes it proof. ' +
      'Returns a claim_id. The business owner must read the code from their own inbox or phone and give it to you. ' +
      'If the listing has no published contact details this will fail and a human at info@5arz.com must verify instead.',
    inputSchema: {
      type: 'object',
      required: ['place_id'],
      properties: { place_id: { type: 'string', description: 'From find_listing.' } },
    },
  },
  {
    name: 'complete_claim',
    description:
      'Exchange the verification code for an API key. The key is returned ONCE and cannot be recovered — store it immediately. ' +
      'Everything after this point needs it.',
    inputSchema: {
      type: 'object',
      required: ['claim_id', 'code'],
      properties: {
        claim_id: { type: 'string' },
        code: { type: 'string', description: 'The code the owner received.' },
        label: { type: 'string', description: 'Optional name for this key, e.g. "booking system".' },
      },
    },
  },
  {
    name: 'get_listing',
    description: 'Read what Num currently says about the business you hold a key for. Requires api_key.',
    inputSchema: {
      type: 'object',
      required: ['api_key'],
      properties: { api_key: { type: 'string' } },
    },
  },
  {
    name: 'update_listing',
    description:
      'Change what Num says about the business. Editable: name, phone, website, hours, cuisine, address. ' +
      'NOT editable, and no key grants it: category, rating, or position in recommendations. ' +
      'Num ranks on what suits the guest asking, and that is not for sale — do not attempt it or promise it to a business.',
    inputSchema: {
      type: 'object',
      required: ['api_key'],
      properties: {
        api_key: { type: 'string' },
        name: { type: 'string' },
        phone: { type: 'string' },
        website: { type: 'string' },
        hours: { type: 'string', description: 'Free text, e.g. "Mon-Sat 11:00-23:00, Sun closed".' },
        cuisine: { type: 'string' },
        address: { type: 'string' },
      },
    },
  },
  {
    name: 'get_insights',
    description:
      'How often Num surfaced this business to a guest. Requires api_key. ' +
      'May report that measurement is unavailable — if so, report that plainly rather than substituting an estimate.',
    inputSchema: {
      type: 'object',
      required: ['api_key'],
      properties: { api_key: { type: 'string' }, days: { type: 'integer', description: 'Default 7, max 90.' } },
    },
  },
];

/** Build the internal Request each tool maps to, then reuse the HTTP handler. */
function toRequest(name, a, base) {
  const auth = a.api_key ? { Authorization: `Bearer ${a.api_key}` } : {};
  const H = { 'Content-Type': 'application/json', ...auth };
  switch (name) {
    case 'find_listing': {
      const u = new URL(`${base}/v1/places`);
      if (a.name) u.searchParams.set('q', a.name);
      if (a.destination) u.searchParams.set('dest', a.destination);
      return [new Request(u, { method: 'GET' }), '/v1/places'];
    }
    case 'start_claim':
      return [new Request(`${base}/v1/claim`, { method: 'POST', headers: H, body: JSON.stringify({ place_id: a.place_id }) }), '/v1/claim'];
    case 'complete_claim':
      return [new Request(`${base}/v1/verify`, { method: 'POST', headers: H, body: JSON.stringify({ claim_id: a.claim_id, code: a.code, label: a.label }) }), '/v1/verify'];
    case 'get_listing':
      return [new Request(`${base}/v1/profile`, { method: 'GET', headers: H }), '/v1/profile'];
    case 'update_listing': {
      const { api_key, ...fields } = a;
      return [new Request(`${base}/v1/profile`, { method: 'PATCH', headers: H, body: JSON.stringify(fields) }), '/v1/profile'];
    }
    case 'get_insights': {
      const u = new URL(`${base}/v1/insights`);
      if (a.days) u.searchParams.set('days', String(a.days));
      return [new Request(u, { method: 'GET', headers: H }), '/v1/insights'];
    }
    default:
      return [null, null];
  }
}

export async function handleBizMcp(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }
  if (request.method !== 'POST') return rpcErr(null, -32600, 'MCP speaks JSON-RPC over POST.');

  let body;
  try { body = await request.json(); } catch { return rpcErr(null, -32700, 'Parse error.'); }
  const { id = null, method, params = {} } = body;

  if (method === 'initialize') {
    return rpc(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'num-business', version: '1.0.0' },
      instructions:
        'Num is an AI travel concierge. These tools let you claim and manage a business listing on it. ' +
        'Start with find_listing to get a place_id. Claiming requires a code sent to contact details already published ' +
        'on the listing — the owner must read it out; you cannot obtain it yourself, and that is intentional. ' +
        'Ranking and category are never editable.',
    });
  }
  if (method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (method === 'tools/list') return rpc(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    const base = new URL(request.url).origin + '/api/biz';
    const [req, path] = toRequest(name, args, base);
    if (!req) return rpcErr(id, -32602, `Unknown tool: ${name}`);
    const res = await handleBizApi(req, env, path);
    const text = await res.text();
    return rpc(id, {
      // isError lets the model distinguish "Num said no" from "Num broke",
      // which is the difference between it retrying sensibly and giving up.
      isError: !res.ok,
      content: [{ type: 'text', text }],
    });
  }

  return rpcErr(id, -32601, `Method not found: ${method}`);
}
