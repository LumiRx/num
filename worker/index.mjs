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
import { pickLane, smallReply, guardReply } from './router.mjs';

const MODEL = 'claude-opus-5';

const FALLBACK_REPLY = 'Sorry — I garbled that. Say it once more and I’ll take care of it.';

async function askNum(client, messages, state, grounding, profile, extraSystem) {
  const system = [
    { type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contextBlock({ place: grounding.place, partners: grounding.partners, guide: grounding.guide, profile }) },
    { type: 'text', text: 'Current trip state (source of truth — reference ids exactly):\n' + JSON.stringify(state) },
  ];
  if (extraSystem) system.push({ type: 'text', text: extraSystem });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    output_config: { format: { type: 'json_schema', schema: REPLY_SCHEMA } },
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { reply: 'I can’t help with that one — anything else on the trip?', card: null, chips: null, actions: [] };
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  return normalizeReply(JSON.parse(text));
}

/**
 * "Notify the dashboard": persist every capability gap Num flags into the
 * shared num-db (same D1 the LINE brain and partner console read), so the
 * team sees what users are asking for that the product can't do yet.
 * Fail-soft: a logging failure must never break the user's reply.
 */
async function logFeatureRequests(env, result, userAsk, place) {
  const flagged = (result.actions ?? []).filter((a) => a.type === 'feature_request');
  if (!flagged.length || !env.DB) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feature_requests (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         place TEXT,
         asked TEXT,
         summary TEXT,
         suggestion TEXT,
         status TEXT NOT NULL DEFAULT 'new'
       )`,
    ).run();
    const ins = env.DB.prepare(
      'INSERT INTO feature_requests (ts, place, asked, summary, suggestion) VALUES (?1, ?2, ?3, ?4, ?5)',
    );
    await env.DB.batch(
      flagged.map((f) =>
        ins.bind(new Date().toISOString(), place ?? null, (userAsk ?? '').slice(0, 500), f.summary.slice(0, 500), f.suggestion.slice(0, 800)),
      ),
    );
    console.log('[feature-request]', ...flagged.map((f) => f.summary));
  } catch (err) {
    console.warn('[feature-request] failed to log:', err?.message ?? err);
  }
}

export default {
  async fetch(request, env, ctx) {
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

      // Profile + trip state carry long-term context now, so the model only
      // needs the recent turns.
      const history = parsed.messages.slice(-14);
      const profile = parsed.state?.profile ?? {};

      // Small lane: chit-chat goes to Workers AI, no Claude call at all. Any
      // wobble — HANDOFF, null, or a guard failure — falls through to the big
      // lane rather than to a worse answer.
      const lane = pickLane(lastUser, parsed.state ?? {});
      if (lane === 'small') {
        const small = await smallReply(env, history, profile, grounding.place?.name ?? null);
        if (small && !/\bHANDOFF\b/.test(small)) {
          const guard = guardReply(small);
          if (guard.ok) {
            return json(200, { reply: guard.cleaned, card: null, chips: null, actions: [], place: grounding.place?.name ?? null });
          }
        }
      }

      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const callNum = async (extraSystem) => {
        try {
          return await askNum(client, history, parsed.state, grounding, profile, extraSystem);
        } catch (err) {
          // Grammar compilation is cached once it succeeds but can time out on a
          // cold schema — one retry usually lands on the warmed cache.
          if (!/grammar compilation/i.test(err?.message ?? '')) throw err;
          await new Promise((r) => setTimeout(r, 1500));
          return askNum(client, history, parsed.state, grounding, profile, extraSystem);
        }
      };

      let result = await callNum();
      // Output guard: never let leaked JSON scaffolding reach the user. One
      // corrective retry, then salvage, then the safe fallback.
      const guard = guardReply(result.reply);
      if (guard.ok) {
        result = { ...result, reply: guard.cleaned };
      } else {
        const retry = await callNum(
          'Your previous output leaked JSON structure into the reply field. The reply field must contain ONLY clean conversational prose.',
        );
        const retryGuard = guardReply(retry.reply);
        if (retryGuard.ok) {
          result = { ...retry, reply: retryGuard.cleaned };
        } else {
          const cleaned = retryGuard.cleaned ?? guard.cleaned;
          result = cleaned
            ? { ...retry, reply: cleaned }
            : { reply: FALLBACK_REPLY, card: null, chips: null, actions: [] };
        }
      }
      // Capability gaps go to the team dashboard without delaying the reply.
      ctx.waitUntil(logFeatureRequests(env, result, typeof lastUser === 'string' ? lastUser : '', grounding.place?.name ?? null));
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
