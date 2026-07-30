// NUM AI backend — Cloudflare Worker port of server/index.mjs, so one deploy
// ships the app and the API together.
//
// POST /api/num
//   body:    { messages: [{role: "user"|"assistant", content: string}], state: {...} }
//   returns: { reply, card, chips, actions }
//
// Static assets are served by the assets config in wrangler.app.jsonc; with
// run_worker_first, only /api/* reaches this Worker. Auth: env.ANTHROPIC_API_KEY
// (`wrangler secret put ANTHROPIC_API_KEY` in prod, .dev.vars for wrangler dev).
// The endpoint is public, so worker/guard.mjs rate-limits and validates every
// request before we spend a token — see DEPLOY.md § Launch hardening.
import Anthropic from '@anthropic-ai/sdk';
import { PERSONA, REPLY_SCHEMA, contextBlock, normalizeReply } from './prompt.mjs';
import { corsHeaders, enforceRateLimit, validatePayload, LIMITS } from './guard.mjs';
import { groundRequest } from './grounding.mjs';

const MODEL = 'claude-opus-5';

async function askNum(client, messages, state, grounding) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: contextBlock({ place: grounding.place, partners: grounding.partners, guide: grounding.guide }) },
      { type: 'text', text: 'Current trip state (source of truth — reference ids exactly):\n' + JSON.stringify(state) },
    ],
    output_config: { format: { type: 'json_schema', schema: REPLY_SCHEMA } },
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { reply: 'I can’t help with that one — anything else on the trip?', card: null, chips: null, actions: [] };
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  return normalizeReply(JSON.parse(text));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, url.origin);
    const json = (status, body, extra) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors, ...extra },
      });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
    }
    if (request.method !== 'POST' || url.pathname !== '/api/num') {
      return new Response('not found', { status: 404 });
    }

    // Cheapest rejections first: size, then rate, then key, then shape.
    const declaredSize = Number(request.headers.get('Content-Length') ?? 0);
    if (declaredSize > LIMITS.maxBodyBytes) {
      return json(413, { error: 'request body too large' });
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const limit = await enforceRateLimit(env, ip);
    if (!limit.ok) {
      return json(
        429,
        { error: limit.scope === 'ip' ? 'Too many requests — give me a moment.' : 'Num is busy right now — try again shortly.' },
        { 'Retry-After': String(limit.retryAfter) },
      );
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json(401, { error: 'ANTHROPIC_API_KEY not configured' });
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > LIMITS.maxBodyBytes) return json(413, { error: 'request body too large' });
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'invalid JSON body' });
    }

    const parsed = validatePayload(body);
    if (!parsed.ok) return json(parsed.status, { error: parsed.error });

    try {
      // Same brain as the texts: resolve the user's location and pull
      // verified partners from the shared num-db before Claude answers.
      const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const grounding = await groundRequest(env, { userText: lastUser, statedPlace: parsed.place, cf: request.cf });

      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      let result;
      try {
        result = await askNum(client, parsed.messages, parsed.state, grounding);
      } catch (err) {
        // Grammar compilation is cached once it succeeds but can time out on a
        // cold schema — one retry usually lands on the warmed cache.
        if (!/grammar compilation/i.test(err?.message ?? '')) throw err;
        await new Promise((r) => setTimeout(r, 1500));
        result = await askNum(client, parsed.messages, parsed.state, grounding);
      }
      // Tell the app where Num thinks the user is (drives the header) —
      // computed server-side, never by the model.
      return json(200, { ...result, place: grounding.place ? grounding.place.name : null });
    } catch (err) {
      console.error('[num-ai]', err);
      const status = err?.status === 401 ? 401 : err?.status === 429 ? 429 : 500;
      return json(status, { error: err?.message ?? 'unknown error' });
    }
  },
};
