/**
 * Num Concierge — MCP server. The surface where an agent can HIRE Num.
 *
 * ── WHY THIS IS A THIRD ENDPOINT AND NOT A SEVENTH PARTNER TOOL ──────────
 *
 * `request_table` was written for /api/partner/mcp and moved here on purpose.
 * partnermcp.mjs refuses commerce in its header comment (:18-23) and repeats
 * the refusal in its handshake and in six tool descriptions: "These tools never
 * book, charge, or accept personal data." Adding a booking tool there would
 * have broken three promises at once:
 *
 *   1. NO COMMERCE. The refusal is not squeamishness — it is what lets a
 *      partner's security review approve the integration in an afternoon. A
 *      read-only directory and a system that can make a stranger's phone ring
 *      are not the same risk and should not share one API key policy.
 *   2. NO PII. Partner tools accept a destination and a question. Booking needs
 *      a person: who the table is for, and a number the venue can call back.
 *   3. NO ANONYMOUS ACCESS. /api/partner/mcp is deliberately open so an
 *      engineer can evaluate it without emailing anyone (see PUBLIC BY DECISION
 *      in partnermcp.mjs). "Anyone on the internet, unauthenticated" is the
 *      correct policy for reading a restaurant's opening hours and an obviously
 *      wrong one for texting that restaurant.
 *
 * The codebase already had the right answer to this shape of question: biz and
 * partner are two files because they are two trust levels. Bookings are a
 * third. So this is a third file, on a third route, with its own key rule.
 *
 * ── WHAT AN AGENT GETS, AND WHAT IT CANNOT GET ───────────────────────────
 *
 * `request_table` is the same call BookSheet.tsx makes for a human, through the
 * same handler, and it inherits every guarantee bookdesk.mjs gives a human:
 *
 *   • CONFIRM-FIRST. The venue confirms; Num never does. The response is
 *     `state: "requested"`, `booked: false`, `confirmed: false` — always, with
 *     no code path that returns anything else. An agent that renders this as
 *     "table booked" has been told four times in three fields not to.
 *   • KILL SWITCH. bookdeskEnabled(env) gates it exactly as it gates the app.
 *     `wrangler secret put BOOKDESK_ENABLED false` stops agents and humans in
 *     the same instant, with no deploy — which is the only kind of kill switch
 *     worth having.
 *   • E.164 OR NOTHING. venueE164 refuses a number without a country code
 *     rather than guessing +1 and texting a stranger in Ohio about a table in
 *     Phuket.
 *   • A MEMBER, NOT A STRANGER. `member_id` is required. Num books for people
 *     it knows, and the confirmation goes to that member's own device by push.
 *     An agent cannot book for an anonymous third party, which also means this
 *     surface takes no new personal data: the identity already exists on Num.
 *
 * There is no `cancel_table` and no `confirm_table`. bookdesk allows exactly
 * one transition, made by the venue, and an agent-facing tool that could flip a
 * state the venue owns would be a second source of truth about whether a table
 * exists.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST, matching bizmcp.mjs and partnermcp.mjs
 * so a partner learns one shape.
 */
import { bookdeskEnabled } from './bookdesk.mjs';
import { partnerFrom, logPartnerCall, ATTRIBUTION } from './partnermcp.mjs';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Partner-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const rpc = (id, result, status = 200, extra = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status, headers: { ...CORS, ...extra } });
const rpcErr = (id, code, message, status = 200, extra = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status, headers: { ...CORS, ...extra } });

/**
 * Two tools. Ask, and check what came back.
 *
 * The descriptions carry the confirm-first rule in capitals because they are
 * the only part of this file the calling model reads, and the single sentence
 * that must never be generated — "your table is booked" — has to be forbidden
 * where the model is looking when it decides what to say.
 */
const TOOLS = [
  {
    name: 'request_table',
    title: 'Ask a venue to hold a table',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      'Ask a venue to hold a table for a Num member. Num texts the venue and the venue answers by tapping a link; ' +
      'the member is notified on their own device the moment it does. ' +
      'THIS DOES NOT CONFIRM A TABLE. The response is always `state: "requested"`, `booked: false`, `confirmed: false`, ' +
      'and you MUST NOT tell anyone a table is held, booked, reserved or confirmed on the strength of it — say it has ' +
      'been requested and the venue is being asked. Use booking_status to find out what the venue decided. ' +
      'Requires member_id: Num only books for members it has already verified, so you cannot book for an anonymous ' +
      'traveller — have them connect their Num account first. A venue phone number MUST carry its country code ' +
      '(+66, +1, +44); a number without one is REFUSED rather than guessed at. ' +
      'Never invent a venue phone number — no number is a normal, honest state and the desk works those by hand.',
    inputSchema: {
      type: 'object',
      required: ['member_id', 'venue_name'],
      properties: {
        member_id: { type: 'string', description: 'The Num member the table is for. They must already exist on Num.' },
        venue_name: { type: 'string', description: 'The venue, as the guest would say it.' },
        place_id: { type: 'string', description: 'From search_places on /api/partner/mcp. Optional, and worth sending: it identifies the venue for real.' },
        venue_phone: { type: 'string', description: 'E.164 with country code, e.g. "+66812345678". Omit if you do not have one — never guess.' },
        party_size: { type: 'integer', description: 'Covers, 1–40. Default 2.' },
        on_date: { type: 'string', description: 'YYYY-MM-DD. Omit for tonight.' },
        at_time: { type: 'string', description: 'HH:MM, 24-hour, local to the venue.' },
        note: { type: 'string', description: 'Anything the venue needs to know — allergies, a high chair, a window table.' },
      },
    },
  },
  {
    name: 'booking_status',
    title: 'Check what the venue decided',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      "A member's table requests and what each venue decided: requested | confirmed | declined. " +
      'Only `confirmed` means a table exists — report `requested` as still waiting, never as success, and never ' +
      'guess at the outcome of one that is still open. Venues answer when service quiets down, so a request that is ' +
      'still `requested` an hour later is normal and is NOT a failure to report to the guest.',
    inputSchema: {
      type: 'object',
      required: ['member_id'],
      properties: {
        member_id: { type: 'string', description: 'The Num member whose requests to read.' },
        booking_id: { type: 'string', description: 'Optional: narrow to the one request returned by request_table.' },
      },
    },
  },
];

// Exported for tests: the descriptions ARE the contract with a calling agent.
export const TOOLS_FOR_TEST = TOOLS;

/**
 * Every tool goes through handleBooking — the same function BookSheet.tsx
 * reaches through /api/book. Not a parallel implementation: a second path to a
 * booking is a second set of rules about what a booking is, and the kill switch
 * would only be wired to one of them.
 */
async function callTool(env, request, name, args) {
  const origin = new URL(request.url).origin;
  const { handleBooking } = await import('./bookdesk.mjs');

  if (name === 'request_table') {
    if (!args.member_id || !args.venue_name) {
      return { error: 'request_table needs member_id and venue_name.', requested: false };
    }
    const inner = new Request(new URL('/api/book/request', origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        me: args.member_id,
        venue_name: args.venue_name,
        venue_phone: args.venue_phone,
        place_id: args.place_id,
        party_size: args.party_size,
        on_date: args.on_date,
        at_time: args.at_time,
        note: args.note,
      }),
    });
    const res = await handleBooking(inner, env, '/request');
    const body = await res.json();

    if (!res.ok) {
      // Pass the desk's own sentence through rather than rewriting it. The
      // kill-switch message and the bad-phone message are both written to be
      // read aloud to a guest, and a paraphrase loses the part that tells the
      // agent what to do instead.
      return {
        error: body.error ?? 'Num could not take that request.',
        booked: false,
        confirmed: false,
        // `disabled` distinguishes "we are not taking requests right now" from
        // "your request was wrong" — the difference between offering the phone
        // number and asking the guest to fix something.
        booking_desk_closed: !!body.disabled,
        bad_phone: !!body.bad_phone,
      };
    }

    return {
      booking_id: body.id,
      state: 'requested',
      // Three fields saying the same thing, because one of them is the field
      // the model happens to look at.
      booked: false,
      confirmed: false,
      venue_notified: !!body.texted,
      next: 'Call booking_status with this member_id to see what the venue decided.',
      say_to_guest: body.note,
      must_not_say: 'Do not tell the guest the table is booked, held or confirmed. It has been requested.',
      attribution: ATTRIBUTION,
    };
  }

  if (name === 'booking_status') {
    if (!args.member_id) return { error: 'booking_status needs member_id.' };
    const u = new URL('/api/book/mine', origin);
    u.searchParams.set('me', String(args.member_id));
    const res = await handleBooking(new Request(u, { method: 'GET' }), env, '/mine');
    const body = await res.json();
    let requests = body.requests ?? [];
    if (args.booking_id) requests = requests.filter((r) => r.id === String(args.booking_id));
    return {
      requests: requests.map((r) => ({
        booking_id: r.id,
        venue: r.venue_name,
        party_size: r.party_size,
        on_date: r.on_date,
        at_time: r.at_time,
        state: r.state,
        // Derived rather than left to the model to infer from a string. A
        // confirmed table and a pending one differ by one word and the model
        // that gets it wrong sends somebody to a restaurant.
        confirmed: r.state === 'confirmed',
        requested_at: r.created_at,
        answered_at: r.answered_at ?? null,
      })),
      attribution: ATTRIBUTION,
    };
  }

  return { error: `Unknown tool: ${name}` };
}

export async function handleConciergeMcp(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return rpcErr(null, -32600, 'POST a JSON-RPC 2.0 request.');

  let body;
  try { body = await request.json(); } catch { return rpcErr(null, -32700, 'Invalid JSON.'); }
  const { id = null, method, params = {} } = body ?? {};
  const partner = partnerFrom(request);

  if (method === 'initialize') {
    return rpc(id, {
      // Echo the client's version when we speak it, rather than announcing one
      // and hoping. num-partners hardcodes 2024-11-05 and that is a bug being
      // fixed separately; it is not one worth copying into a new file.
      protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(params?.protocolVersion)
        ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'num-concierge', title: 'Num Concierge — bookings', version: '1.0.0' },
      instructions:
        'Num can ask a venue to hold a table for a Num member. It asks; the venue decides. ' +
        'request_table NEVER confirms a booking — it returns state "requested" and booked:false, and you must not ' +
        'tell a guest a table is held until booking_status reports "confirmed". ' +
        'Every call needs an X-Partner-Key: this surface makes a real restaurant\'s phone ring, so unlike the ' +
        'read-only directory at /api/partner/mcp there is no anonymous path. Find places there, book them here. ' +
        'Bookings are for existing Num members only — you cannot book for an anonymous traveller.',
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return new Response(null, { status: 202, headers: CORS });
  }
  if (method === 'ping') return rpc(id, {});
  // Discovery is open. A partner must be able to read what this surface does
  // before asking for a key — otherwise the only way to learn the shape of the
  // integration is to sign something, and nobody signs blind.
  if (method === 'tools/list') return rpc(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);

    // The key rule, enforced before anything is read or written. -32001 is the
    // code partnersignup documents for "you need a key"; the 401 is for the
    // proxies and the humans reading logs.
    if (!partner.keyed) {
      return rpcErr(id, -32001,
        'This surface needs an X-Partner-Key header — it can cause a real venue to be contacted, so there is no ' +
        'anonymous path. Get one from POST /api/partner/signup. Read-only directory tools need no key: ' +
        'POST /api/partner/mcp. Nothing was changed.', 401);
    }

    // Scoped to the partner, not the IP — a platform books from one server and
    // an IP bucket would throttle all of its guests as if they were one person.
    // Attribution is what makes that safe: logPartnerCall puts a name on every
    // call, so a partner that runs away with it can be found.
    const { enforceRateLimit } = await import('./guard.mjs');
    const limit = await enforceRateLimit(env, `partner:${partner.id}`, 'PARTNER_LIMITER');
    if (limit.degraded) console.warn('[concierge-mcp] rate limiting is DEGRADED — booking calls are not being limited');
    if (!limit.ok) {
      return rpcErr(id, -32003,
        `Too many booking calls — retry in ${limit.retryAfter}s. Nothing was changed and no venue was contacted.`,
        429, { 'Retry-After': String(limit.retryAfter) });
    }

    try {
      const out = await callTool(env, request, name, params?.arguments ?? {});
      await logPartnerCall(env, partner, name, !out.error);
      return rpc(id, { isError: !!out.error, content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      console.log('concierge mcp', name, String(e));
      await logPartnerCall(env, partner, name, false);
      // "Nothing was changed" is load-bearing: on a booking surface, an agent
      // that cannot tell a failed write from an uncertain one retries, and the
      // venue gets texted twice about one table.
      return rpcErr(id, -32603, 'Num had a problem with that. Nothing was changed and no venue was contacted.');
    }
  }

  return rpcErr(id, -32601, `Unsupported method: ${method}`);
}

/** GET /api/concierge — the front door, and the listing mcp-integrity diffs against. */
export function conciergeIndex(env) {
  return new Response(
    JSON.stringify({
      service: 'Num Concierge',
      mcp: 'POST /api/concierge/mcp (JSON-RPC 2.0, streamable-HTTP MCP)',
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description.split('.')[0] + '.' })),
      auth: 'X-Partner-Key REQUIRED on tools/call. No anonymous path: this surface contacts real venues. ' +
        'Discovery (initialize, tools/list) is open. Get a key: POST /api/partner/signup.',
      guarantees: [
        'Confirm-first: Num asks, the venue decides. request_table never returns a confirmed booking.',
        'Members only: bookings need an existing Num member_id, so no new personal data is taken here.',
        'Kill switch: BOOKDESK_ENABLED stops agents and humans at the same instant, with no deploy.',
        'E.164 or nothing: a venue number without a country code is refused, never guessed.',
      ],
      // Honest about being off. A partner reading a 200 with an empty promise
      // is worse served than one told the desk is closed.
      accepting_requests: bookdeskEnabled(env),
      read_only_directory: 'POST /api/partner/mcp',
      attribution: ATTRIBUTION,
      contact: 'partners@itsnum.com',
    }, null, 2),
    { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
  );
}
