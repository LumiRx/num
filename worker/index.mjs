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
import { pickLane, smallReply, guardReply, soundsLikeASwitchboard } from './router.mjs';
import { handleSocialSafe } from './social.mjs';
import { handleEvents, handleEventPage } from './events.mjs';
import { handleConsole, logUsage } from './console.mjs';
import { handleClaim, handleClaimConfirm } from './claim.mjs';
import { servicesBlock, optionsFor } from './services.mjs';
import { VOICE, pickSpecialist, specialistBrief, styleBlock } from './specialists.mjs';

// Opus by default — it is the concierge and the concierge is the product.
// Overridable without a code change (`wrangler secret put NUM_MODEL`, or a var)
// because the latency/cost trade against Sonnet is a business call, not a
// technical one, and it should be flippable in a minute.
const DEFAULT_MODEL = 'claude-opus-5';

const FALLBACK_REPLY = 'Sorry — I garbled that. Say it once more and I’ll take care of it.';

async function askNum(client, messages, state, grounding, profile, extraSystem, env, userText) {
  // PERSONA + VOICE are identical on every request, so they sit above the
  // cache breakpoint. Everything below it changes per turn.
  const specialist = pickSpecialist(userText ?? '');
  const system = [
    { type: 'text', text: PERSONA + '\n\n' + VOICE, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: contextBlock({
        place: grounding.place,
        partners: grounding.partners,
        guide: grounding.guide,
        profile,
        buzz: grounding.buzz,
        services: servicesBlock(grounding.place, env ?? {}),
        style: styleBlock(state?.style),
        party: state?.party,
        trip: state?.tripCheck,
      }),
    },
    { type: 'text', text: 'Current trip state (source of truth — reference ids exactly):\n' + JSON.stringify(state) },
  ];
  const brief = specialistBrief(specialist);
  if (brief) system.push({ type: 'text', text: brief });
  if (extraSystem) system.push({ type: 'text', text: extraSystem });
  const response = await client.messages.create({
    model: env?.NUM_MODEL || DEFAULT_MODEL,
    // 4096 was ~3x what a real turn needs and let the model ramble into the
    // action payloads — measured p50 was 950 output tokens for a 115-token
    // reply, which is both the biggest slice of the bill AND the reason a
    // reply took 15s. Output tokens are generated serially: fewer is faster.
    max_tokens: 1400,
    system,
    output_config: { format: { type: 'json_schema', schema: REPLY_SCHEMA } },
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { reply: 'I can’t help with that one — anything else on the trip?', card: null, chips: null, actions: [], _usage: response.usage, _specialist: specialist };
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  // usage rides back with the reply so the caller can bill it to a day. Real
  // counts, not an estimate — this is what the admin dashboard reports.
  return { ...normalizeReply(JSON.parse(text)), _usage: response.usage, _specialist: specialist };
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

/**
 * Photos are attached SERVER-side by matching the model's card title against
 * the grounded partner list — the model never emits a URL, so it can never
 * invent one. Attribution rides along because CC images require it.
 */
async function attachPhoto(env, result, grounding) {
  const card = result?.card;
  if (!card?.title) return result;
  // Fold accents before comparing: the directory stores 'ARCH Café' while the
  // model writes 'ARCH Cafe', and SQL LIKE cannot bridge that.
  const norm = (v) =>
    String(v || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const title = norm(card.title);
  if (!title) return result;

  const withPhoto = (hit) => ({
    ...result,
    card: { ...card, photo: hit.photo_url, photoAttr: hit.photo_attr ?? null, photoLicense: hit.photo_license ?? null },
  });

  // 1. The partners already in context — free, no extra query.
  const near = (grounding.partners ?? []).find((p) => {
    const n = norm(p.name);
    return p.photo_url && n.length > 3 && (title.includes(n) || n.includes(title));
  });
  if (near) return withPhoto(near);

  // 2. Otherwise ask the directory directly: the model names venues outside
  //    the top-6 nearby set constantly, and those deserve their photo too.
  const slug = grounding.place?.slug;
  if (!env.DB || !slug) return result;
  try {
    // Strip the leading "Dinner — " / "Coffee — " label the model prefixes.
    // The model writes "Coffee — ARCH Cafe": drop the leading label, then use
    // the longest word as a cheap SQL prefilter and settle it in JS.
    const core = String(card.title).split(/[—–|,]/).pop().replace(/^\s*\w+\s+(?:at|@)\s+/i, '').trim();
    const words = (core.match(/[\p{L}\p{N}]{3,}/gu) ?? []).sort((a, b) => b.length - a.length);
    if (!words.length) return result;
    const { results } = await env.DB.prepare(
      `SELECT name, photo_url, photo_attr, photo_license FROM places
        WHERE dest = ?1 AND photo_url IS NOT NULL AND name LIKE ?2
        ORDER BY (rating IS NULL), rating DESC LIMIT 25`,
    )
      .bind(slug, `%${words[0]}%`)
      .all();
    const coreN = norm(core);
    const hit = (results ?? []).find((r) => {
      const n = norm(r.name);
      return n.length > 3 && (title.includes(n) || coreN.includes(n) || n.includes(coreN));
    });
    if (hit) return withPhoto(hit);
  } catch (err) {
    console.warn('[photo] lookup failed:', err?.message ?? err);
  }
  return result;
}

/**
 * A `service` action names a kind ('ride', 'food'…); the app needs the actual
 * providers to open. Resolving it here — not in the model — is deliberate: the
 * model cannot name a provider that doesn't operate in this country, and
 * cannot hand out a URL it invented.
 */
function attachServiceOptions(env, result, grounding) {
  const actions = (result.actions ?? []).map((a) => {
    if (a.type !== 'service') return a;
    const place = grounding.place ?? {};
    const { mode, options } = optionsFor(
      a.kind,
      {
        country: place.country_code || place.country,
        city: a.city || place.name,
        to: a.to,
        q: a.query,
        from: a.from,
        fromCode: a.fromCode,
        toCode: a.toCode,
        depart: a.depart,
        ret: a.ret,
        checkin: a.checkin,
        checkout: a.checkout,
        adults: a.adults,
      },
      env,
    );
    return { ...a, mode, options };
  });
  return { ...result, actions };
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
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
    }
    // Identity, invites, friend links and shared plans. Separate surface from
    // the AI endpoint: no model call, no Anthropic key, its own rate profile.
    // The guest-facing RSVP page. Public, server-rendered, no app required —
    // that is the whole point of inviting people by text.
    if (url.pathname.startsWith('/e/')) {
      return await handleEventPage(request, env, url.pathname.slice(3).split('/')[0], url.origin);
    }
    if (url.pathname.startsWith('/api/events')) {
      const res = await handleEvents(request, env, url.pathname.slice('/api/events'.length) || '/', url.origin);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // The claim magic link — opened from the business's own inbox, so it must
    // be a real page and must not require the app.
    if (url.pathname === '/claim/confirm') return await handleClaimConfirm(request, env);
    if (url.pathname.startsWith('/api/claim')) {
      const res = await handleClaim(request, env, url.pathname.slice('/api/claim'.length) || '/', url.origin);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/business') || url.pathname.startsWith('/api/admin')) {
      const res = await handleConsole(request, env, url.pathname.slice('/api'.length));
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/social')) {
      // Writes here create rows and mint invite links, so they need the same
      // per-IP ceiling the AI endpoint has. Reads (friends, plans, the sync
      // poll) stay free — every app in the foreground makes one a minute, and
      // throttling those would break the product to stop nothing.
      if (request.method === 'POST') {
        const socialLimit = await enforceRateLimit(env, request.headers.get('CF-Connecting-IP') ?? 'unknown');
        if (!socialLimit.ok) return json(429, { error: 'Too many requests — give me a moment.' }, { 'Retry-After': String(socialLimit.retryAfter) });
      }
      const res = await handleSocialSafe(request, env, url.pathname.slice('/api/social'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
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
        // HANDOFF, or switchboard filler, both mean: this one deserves Claude.
        if (small && !/\bHANDOFF\b/.test(small) && !soundsLikeASwitchboard(small)) {
          const guard = guardReply(small);
          if (guard.ok) {
            // The cheap lane is the reason the bill stays sane; count how often
            // it actually fires so that claim can be checked, not assumed.
            ctx.waitUntil(logUsage(env, { lane: 'small', model: 'workers-ai', place: grounding.place?.name ?? null, usage: null, ms: null }));
            return json(200, { reply: guard.cleaned, card: null, chips: null, actions: [], place: grounding.place?.name ?? null });
          }
        }
      }

      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const callNum = async (extraSystem) => {
        try {
          return await askNum(client, history, parsed.state, grounding, profile, extraSystem, env, lastUser);
        } catch (err) {
          // Grammar compilation is cached once it succeeds but can time out on a
          // cold schema — one retry usually lands on the warmed cache.
          if (!/grammar compilation/i.test(err?.message ?? '')) throw err;
          await new Promise((r) => setTimeout(r, 1500));
          return askNum(client, history, parsed.state, grounding, profile, extraSystem, env, lastUser);
        }
      };

      const startedAt = Date.now();
      let result = await callNum();
      ctx.waitUntil(
        logUsage(env, {
          lane: 'big',
          model: env.NUM_MODEL || DEFAULT_MODEL,
          specialist: result._specialist ?? null,
          place: grounding.place?.name ?? null,
          usage: result._usage,
          ms: Date.now() - startedAt,
        }),
      );
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
      const withPhoto = await attachPhoto(env, result, grounding);
      const withServices = attachServiceOptions(env, withPhoto, grounding);
      // Internals never leave the Worker.
      const { _usage, _specialist, ...clean } = withServices;
      void _usage;
      void _specialist;
      return json(200, { ...clean, place: grounding.place ? grounding.place.name : null });
    } catch (err) {
      console.error('[num-ai]', err);
      const status = err?.status === 401 ? 401 : err?.status === 429 ? 429 : 500;
      return json(status, { error: err?.message ?? 'unknown error' });
    }
  },
};
