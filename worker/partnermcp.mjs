/**
 * Num for Partners — MCP server.
 *
 * The supply side of a distribution deal, expressed as tools instead of a PDF.
 * A travel platform (LetsGo2Trip is the first) points its assistant at this
 * endpoint and can immediately answer "where should we eat tonight near Kata?"
 * with real, verified, ranked places — the thing that takes eighteen months
 * and a ground team to build, and about four minutes to connect.
 *
 * WHY THIS IS SEPARATE FROM bizmcp.mjs
 *
 * `/api/biz/mcp` is for a business managing its OWN listing: it authenticates
 * as an owner and writes. This is the opposite shape — a partner reading the
 * whole directory on behalf of THEIR travellers, never writing, never seeing
 * another partner's numbers. Two audiences, two trust levels, two files. One
 * endpoint serving both would eventually leak one into the other.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No bookings, no payments, no guest PII in or out. A partner integration that
 * can move money on day one is a partner integration that gets audited before
 * it gets used. Recommendations first; commerce when there is a signed deal and
 * a settlement path (see docs/partners/LETSGO2TRIP-INTEGRATION.md §6).
 *
 * ATTRIBUTION IS A LICENCE TERM, NOT A COURTESY
 *
 * Place data derives from OpenStreetMap (ODbL) and Google. Every response
 * carries the attribution string, and the tool descriptions tell the calling
 * model it must be displayed. A partner who strips it puts BOTH of us in
 * breach, so it travels with the payload rather than living in a contract
 * nobody reads.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST (streamable-HTTP MCP), matching
 * bizmcp.mjs so partners and businesses learn one shape.
 */

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Partner-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const rpc = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: CORS });
const rpcErr = (id, code, message) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers: CORS });

/** Travels with every payload. See the header note — this is a licence term. */
export const ATTRIBUTION =
  'Places © OpenStreetMap contributors (ODbL) and Google, verified by Num. ' +
  'This attribution must be displayed wherever these results are shown.';

/**
 * Tool descriptions ARE the interface — a model chooses by reading them. Each
 * one says what it does, what it will NOT do, and what the caller must render.
 * The refusals matter as much as the capabilities: an agent that discovers a
 * limit by hitting an error reports "Num is broken", not "that was out of
 * bounds".
 */
const TOOLS = [
  {
    name: 'search_places',
    description:
      'Find real, currently-operating places near a location — restaurants, bars, beaches, spas, viewpoints, temples. ' +
      'Ranked by a blend of quality and distance, not distance alone, so a 4.8★ institution two streets away beats an ' +
      'unrated snack bar next door. Returns name, category, area, rating, review count, distance, phone, address and ' +
      'opening hours where known. NEVER invents a place: if Num does not hold it, it is not returned. ' +
      'You MUST display the returned `attribution` string wherever you show these results.',
    inputSchema: {
      type: 'object',
      required: ['destination'],
      properties: {
        destination: { type: 'string', description: 'Destination slug or city name, e.g. "phuket", "bangkok".' },
        category: { type: 'string', description: 'restaurant | bar | beach | spa | viewpoint | temple | waterfall | cafe. Omit for all.' },
        near: { type: 'string', description: 'Neighbourhood or landmark to centre on, e.g. "Kata Beach", "Patong".' },
        query: { type: 'string', description: 'Free text, e.g. "thai seafood", "rooftop".' },
        limit: { type: 'integer', description: 'Max results, 1–20. Default 8.' },
      },
    },
  },
  {
    name: 'concierge_answer',
    description:
      'Ask Num the way a traveller would — "where should we eat tonight near Kata?", "which beach for sunset?" — and get ' +
      'a short concierge answer grounded in Num\'s verified directory, plus the places it names as structured data so you ' +
      'can render your own cards. This is the whole product in one tool. ' +
      'It answers about the place asked and NEVER substitutes a different city. If Num has no coverage there it says so ' +
      'rather than guessing. It does not book, charge, or take personal details — send none. ' +
      'You MUST display the returned `attribution`.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: "The traveller's question, in their own words. Any language." },
        destination: { type: 'string', description: 'Where they are, if you know it. Improves grounding.' },
        near: { type: 'string', description: 'Neighbourhood or hotel area, if known.' },
        language: { type: 'string', description: 'BCP-47 tag for the reply, e.g. "th", "ru". Defaults to the language of the question.' },
      },
    },
  },
  {
    name: 'list_destinations',
    description:
      'Which destinations Num covers, with the number of verified places in each. Call this FIRST when you do not know ' +
      'whether a city is supported — it is cheaper than a failed search and stops you promising a traveller coverage ' +
      'that does not exist. Coverage is honest: a destination appears here only when it has a real, maintained directory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'place_details',
    description:
      'Everything Num holds on one place, by place_id from search_places: contact details, hours, rating, review count, ' +
      'area, category and photo attribution. Use before showing a detail page or handing a traveller a phone number. ' +
      'Returns only what is verified — absent fields are absent because Num does not know them, never because they were ' +
      'omitted for brevity. Do not fill gaps from memory; an invented phone number is worse than a missing one.',
    inputSchema: {
      type: 'object',
      required: ['place_id'],
      properties: { place_id: { type: 'string', description: 'From search_places.' } },
    },
  },
  {
    name: 'open_places',
    description:
      'Places that are OPEN RIGHT NOW in a destination, computed in the destination\'s own timezone. ' +
      'Businesses whose own website is a dead domain or a 404 are excluded entirely — they have closed down. ' +
      'IMPORTANT: only venues whose opening hours Num has verified can appear here, so a short list means thin ' +
      'hours coverage, NOT an empty city. Never tell a traveller "nothing is open" on the strength of this tool; ' +
      'say that these are the ones Num can confirm are open. Use search_places for the full directory.',
    inputSchema: {
      type: 'object',
      required: ['destination'],
      properties: {
        destination: { type: 'string', description: 'Destination slug, e.g. "los-angeles".' },
        category: { type: 'string', description: 'Exact category, e.g. "Restaurant". Omit for all.' },
        near: { type: 'string', description: 'Neighbourhood, e.g. "Silver Lake".' },
        bookable_only: { type: 'boolean', description: 'Only venues Num can hand off a booking page for.' },
        limit: { type: 'integer', description: 'Max results, 1–50. Default 20.' },
      },
    },
  },
  {
    name: 'booking_link',
    description:
      'A booking page for one place with the party size, date and time ALREADY FILLED IN. ' +
      'This does NOT make a reservation and Num does not hold a table — the traveller completes it on the venue\'s ' +
      'own platform (OpenTable, Resy, Tock, SevenRooms, Square and others). The response always carries ' +
      '`booked: false` and `mode: "deeplink"`. You MUST NOT render this as a confirmation, and you MUST NOT tell a ' +
      'traveller a table is held. If the venue has no booking platform the response says so and returns the phone ' +
      'number instead — offer that rather than implying it cannot be visited.',
    inputSchema: {
      type: 'object',
      required: ['place_id'],
      properties: {
        place_id: { type: 'string', description: 'From search_places or open_places.' },
        party: { type: 'integer', description: 'Number of covers, 1–20.' },
        date: { type: 'string', description: 'YYYY-MM-DD.' },
        time: { type: 'string', description: 'HH:MM, 24-hour, local to the venue.' },
      },
    },
  },
];

// Exported for tests only: the descriptions ARE the contract with a calling
// agent, so they are asserted on directly rather than through a live handshake.
export const TOOLS_FOR_TEST = TOOLS;

/* ── partner identity ──────────────────────────────────────────────────────
 * A key identifies WHICH partner is asking, so usage can be attributed and a
 * rev-share can be computed from something both sides can audit. It is not a
 * paywall: unkeyed calls still work, rate-limited and unattributed, because a
 * partner evaluating an integration should never have to email anyone to see
 * whether it returns anything useful. The friction belongs at the money, not
 * at the demo.
 * ---------------------------------------------------------------------- */
export function partnerFrom(request) {
  const key = request.headers.get('X-Partner-Key') || '';
  if (!key) return { id: null, keyed: false };
  return { id: key.split('_')[0] || 'unknown', keyed: true };
}

/**
 * Record what a partner asked for. This is the rev-share ledger's raw material
 * and the reason the deal can be settled on evidence rather than assertion —
 * both sides read the same counter.
 * Fail-soft on purpose: a logging failure must never cost a partner an answer.
 */
async function logPartnerCall(env, partner, tool, ok) {
  if (!env.DB || !partner.keyed) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS num_partner_calls (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         partner TEXT NOT NULL, tool TEXT NOT NULL, ok INTEGER NOT NULL,
         ts TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
    await env.DB.prepare('INSERT INTO num_partner_calls (partner, tool, ok) VALUES (?1, ?2, ?3)')
      .bind(partner.id, tool, ok ? 1 : 0).run();
  } catch (e) {
    console.log('logPartnerCall', String(e));
  }
}

/** Shape a places row for a partner: verified fields only, no internal ids. */
const publicPlace = (r) => ({
  place_id: String(r.id),
  name: r.name,
  name_local: r.name_local || undefined,
  category: r.category || undefined,
  area: r.area || undefined,
  rating: r.rating ?? undefined,
  reviews: r.reviews ?? undefined,
  phone: r.phone || undefined,
  address: r.address || undefined,
  hours: r.hours || undefined,
  website: r.website || undefined,
  distance_m: r.distance_m ?? undefined,
});

async function callTool(env, request, name, args) {
  const base = new URL(request.url).origin;
  // Forward the caller's IP so the concierge's rate limiter buckets partner
  // traffic per client. Without it every partner in the world shares one
  // 'unknown' bucket and the busiest one throttles everybody else.
  const fwd = (path, body) =>
    fetch(new URL(path, base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') ?? 'partner',
      },
      body: JSON.stringify(body),
    });

  if (name === 'list_destinations') {
    const rows = await env.DB.prepare(
      `SELECT d.slug, d.name, d.country, COUNT(p.id) places
         FROM destinations d LEFT JOIN places p ON p.dest = d.slug
        GROUP BY d.slug HAVING places > 0 ORDER BY places DESC`,
    ).all();
    return { destinations: rows.results ?? [], attribution: ATTRIBUTION };
  }

  // Open now, and bookable — both delegate to the same handlers the public
  // REST endpoints use. One implementation, so the MCP and the HTTP surface
  // cannot drift into disagreeing about whether a restaurant is open.
  if (name === 'open_places') {
    const u = new URL('/api/open', new URL(request.url).origin);
    u.searchParams.set('dest', String(args.destination || '').toLowerCase());
    u.searchParams.set('open', 'now');
    if (args.category) u.searchParams.set('category', args.category);
    if (args.near) u.searchParams.set('near', args.near);
    if (args.bookable_only) u.searchParams.set('bookable', '1');
    u.searchParams.set('limit', String(Math.min(Math.max(Number(args.limit) || 20, 1), 50)));
    const { handleOpen } = await import('./openapi.mjs');
    return await (await handleOpen(new Request(u, { method: 'GET' }), env)).json();
  }

  if (name === 'booking_link') {
    const { handleBookLink } = await import('./openapi.mjs');
    const req = new Request(new URL('/api/book/link', new URL(request.url).origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place_id: args.place_id, party: args.party, date: args.date, time: args.time }),
    });
    return await (await handleBookLink(req, env)).json();
  }

  if (name === 'search_places') {
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
    // Same exclusion as the guest path: a venue whose own site is a dead
    // domain has closed, and a partner shipping it to a traveller is our
    // mistake landing in someone else's product.
    const where = ['p.dest = ?1', '(p.alive IS NULL OR p.alive = 1)'];
    const bind = [String(args.destination || '').toLowerCase()];
    if (args.category) { where.push('p.category = ?' + (bind.length + 1)); bind.push(args.category); }
    if (args.near) { where.push('p.area LIKE ?' + (bind.length + 1) + ' COLLATE NOCASE'); bind.push('%' + args.near + '%'); }
    if (args.query) {
      const i = bind.length + 1;
      where.push(`(p.name LIKE ?${i} COLLATE NOCASE OR p.cuisine LIKE ?${i} COLLATE NOCASE)`);
      bind.push('%' + args.query + '%');
    }
    const rows = await env.DB.prepare(
      `SELECT id, name, name_local, category, area, rating, reviews, phone, address, hours, website
         FROM places p WHERE ${where.join(' AND ')}
        ORDER BY (COALESCE(rating,0) * LOG(COALESCE(reviews,0) + 10)) DESC
        LIMIT ${limit}`,
    ).bind(...bind).all();
    return { places: (rows.results ?? []).map(publicPlace), attribution: ATTRIBUTION };
  }

  if (name === 'place_details') {
    const r = await env.DB.prepare(
      `SELECT id, name, name_local, category, area, rating, reviews, phone, address, hours, website,
              photo_url, photo_attr FROM places WHERE id = ?1`,
    ).bind(String(args.place_id)).first();
    if (!r) return { error: 'No such place. Use search_places to get a valid place_id.' };
    return {
      place: { ...publicPlace(r), photo_url: r.photo_url || undefined, photo_attribution: r.photo_attr || undefined },
      attribution: ATTRIBUTION,
    };
  }

  if (name === 'concierge_answer') {
    // Reuse the guest path rather than reimplementing it. Two code paths to the
    // same answer drift, and a partner would be the last to notice.
    //
    // The endpoint is `/api/num` — the concierge's only POST route. Worth
    // stating because the first draft of this file guessed `/api/ask`, which
    // would have 404'd on the most important tool in the integration.
    //
    // The guest's own question carries the location when they gave one ("we
    // are in kata"); prepending the partner's `near`/`destination` hint keeps
    // grounding honest without overriding what the traveller actually said.
    const hint = args.near || args.destination;
    const question = String(args.question || '');
    const content = hint && !new RegExp(hint, 'i').test(question)
      ? `I'm in ${hint}. ${question}`
      : question;

    const r = await fwd('/api/num', {
      messages: [{ role: 'user', content }],
      state: {},
      profile: { locale: args.language || null },
    });
    if (!r.ok) {
      return { error: `Num could not answer right now (${r.status}). Nothing was changed; retry shortly.` };
    }
    const j = await r.json();

    // The reply schema carries prose, a card, chips and actions — it does NOT
    // carry a places array. Rather than invent one, run the same directory
    // query the answer was grounded on, so a partner can render its own cards
    // from rows that actually exist.
    let places = [];
    if (args.destination) {
      try {
        const rows = await env.DB.prepare(
          `SELECT id, name, name_local, category, area, rating, reviews, phone, address, hours, website
             FROM places WHERE dest = ?1 ${args.near ? 'AND area LIKE ?2 COLLATE NOCASE' : ''}
            ORDER BY (COALESCE(rating,0) * LOG(COALESCE(reviews,0) + 10)) DESC LIMIT 6`,
        ).bind(...(args.near ? [String(args.destination).toLowerCase(), '%' + args.near + '%']
                             : [String(args.destination).toLowerCase()])).all();
        places = (rows.results ?? []).map(publicPlace);
      } catch (e) { console.log('partner places', String(e)); }
    }

    return {
      answer: j.reply ?? '',
      places,
      destination: j.place ?? null,
      // A fallback brain answered: prose is still useful, structured extras may
      // be thin. Partners must render the answer and not treat this as an error
      // — on 9–10 Aug 2026 this flag was true for eighteen hours.
      degraded: !!j.degraded,
      attribution: ATTRIBUTION,
    };
  }

  return { error: `Unknown tool: ${name}` };
}

export async function handlePartnerMcp(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') return rpcErr(null, -32600, 'POST a JSON-RPC 2.0 request.');

  let body;
  try { body = await request.json(); } catch { return rpcErr(null, -32700, 'Invalid JSON.'); }
  const { id = null, method, params = {} } = body ?? {};
  const partner = partnerFrom(request);

  if (method === 'initialize') {
    return rpc(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'num-partners', version: '1.0.0' },
      instructions:
        'Num is an AI travel concierge with a verified directory of real places. These tools let you answer ' +
        'travellers’ "where should we…" questions with places that actually exist and are open. ' +
        'Call list_destinations first if you are unsure of coverage. Every response carries an `attribution` ' +
        'string that you are required to display. These tools never book, charge, or accept personal data.',
    });
  }
  if (method === 'notifications/initialized') return new Response(null, { status: 202, headers: CORS });
  if (method === 'tools/list') return rpc(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
    try {
      const out = await callTool(env, request, name, args);
      await logPartnerCall(env, partner, name, !out.error);
      return rpc(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      console.log('partner mcp', name, String(e));
      await logPartnerCall(env, partner, name, false);
      return rpcErr(id, -32603, 'Num had a problem serving that. Nothing was changed.');
    }
  }

  return rpcErr(id, -32601, `Unsupported method: ${method}`);
}

/** Human-readable index at GET /api/partner — the front door for an engineer. */
export function partnerIndex() {
  return new Response(
    JSON.stringify({
      service: 'Num for Partners',
      mcp: 'POST /api/partner/mcp (JSON-RPC 2.0, streamable-HTTP MCP)',
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description.split('.')[0] + '.' })),
      auth: 'Optional X-Partner-Key. Unkeyed calls work, rate-limited and unattributed, so you can evaluate before you sign anything.',
      attribution: ATTRIBUTION,
      contact: 'partners@itsnum.com',
    }, null, 2),
    { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
  );
}
