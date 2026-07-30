// Launch guards for the public /api/num endpoint.
//
// The endpoint is unauthenticated by design (the app has no login), so every
// request spends Anthropic tokens on our account. These guards make casual
// abuse expensive and accidents cheap:
//
//   • per-IP sliding-window rate limit  → one client can't loop the endpoint
//   • isolate-wide ceiling              → caps worst-case spend per colo
//   • strict input validation           → no 1 MB prompts, no 500-turn threads
//   • same-origin CORS                  → other sites can't read our responses
//
// Rate limiting runs in two layers, because one alone isn't enough:
//
//   1. env.RATE_LIMITER (Cloudflare's Rate Limiting binding) is the real
//      control. Its counters live in Cloudflare's infrastructure, so they
//      survive isolate churn — this is what actually stops a looping client.
//   2. The isolate-local Map below is a cheap burst brake for requests that
//      land on the same isolate. On its own it is nearly useless: Cloudflare
//      hands out fresh isolates freely, so a sequential client can sail past
//      it (verified in production — 14 rapid requests never tripped it).
//      Keep it as defense in depth, never as the guarantee.

export const LIMITS = {
  perIpPerMin: 12,
  perIsolatePerMin: 240,
  windowMs: 60_000,
  maxBodyBytes: 128 * 1024,
  maxMessages: 40,
  maxMessageChars: 8_000,
  maxTotalChars: 60_000,
  maxStateBytes: 64 * 1024,
};

/** ip → array of request timestamps (ms) inside the current window. */
const hits = new Map();
let isolateHits = [];

const prune = (arr, now) => arr.filter((t) => now - t < LIMITS.windowMs);

/**
 * Best-effort sliding-window limiter.
 * @returns {{ok: true} | {ok: false, retryAfter: number, scope: 'ip'|'global'}}
 */
export function rateLimit(ip, now = Date.now()) {
  isolateHits = prune(isolateHits, now);
  if (isolateHits.length >= LIMITS.perIsolatePerMin) {
    return { ok: false, retryAfter: retryAfterFor(isolateHits, now), scope: 'global' };
  }

  const mine = prune(hits.get(ip) ?? [], now);
  if (mine.length >= LIMITS.perIpPerMin) {
    hits.set(ip, mine);
    return { ok: false, retryAfter: retryAfterFor(mine, now), scope: 'ip' };
  }

  mine.push(now);
  hits.set(ip, mine);
  isolateHits.push(now);

  // Keep the map from growing without bound across a long-lived isolate.
  if (hits.size > 5_000) {
    for (const [key, times] of hits) {
      if (prune(times, now).length === 0) hits.delete(key);
    }
  }
  return { ok: true };
}

function retryAfterFor(times, now) {
  const oldest = times[0] ?? now;
  return Math.max(1, Math.ceil((LIMITS.windowMs - (now - oldest)) / 1000));
}

/**
 * The authoritative limit: Cloudflare's Rate Limiting binding, keyed per IP.
 * Counters live outside the isolate, so they hold across requests. Falls back
 * to the isolate-local brake when the binding is absent (e.g. `wrangler dev`
 * without the binding, or a stale deploy) rather than failing open silently.
 *
 * @returns {Promise<{ok: true} | {ok: false, retryAfter: number, scope: 'ip'|'global'}>}
 */
export async function enforceRateLimit(env, ip) {
  const local = rateLimit(ip);
  if (!local.ok) return local;

  const limiter = env?.RATE_LIMITER;
  if (!limiter?.limit) {
    console.warn('[guard] RATE_LIMITER binding missing — per-IP limiting is degraded');
    return { ok: true, degraded: true };
  }

  try {
    const outcome = await limiter.limit({ key: ip });
    if (!outcome?.success) return { ok: false, retryAfter: LIMITS.windowMs / 1000, scope: 'ip' };
  } catch (err) {
    // A limiter outage must not take the API down with it; the local brake
    // and the Anthropic spend cap remain in force. Log it — silent failure
    // here means we think we're protected when we aren't.
    console.warn('[guard] RATE_LIMITER.limit threw — per-IP limiting is degraded:', err?.message ?? err);
    return { ok: true, degraded: true };
  }
  return { ok: true };
}

/**
 * Validate the request payload shape and size.
 * @returns {{ok: true, messages: object[], state: object} | {ok: false, status: number, error: string}}
 */
export function validatePayload(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const { messages, state } = raw;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, status: 400, error: 'messages must be a non-empty array' };
  }
  if (messages.length > LIMITS.maxMessages) {
    return { ok: false, status: 400, error: `messages exceeds ${LIMITS.maxMessages} entries` };
  }

  let total = 0;
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) {
      return { ok: false, status: 400, error: 'each message must be an object' };
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      return { ok: false, status: 400, error: 'message role must be "user" or "assistant"' };
    }
    if (typeof m.content !== 'string' || m.content.length === 0) {
      return { ok: false, status: 400, error: 'message content must be a non-empty string' };
    }
    if (m.content.length > LIMITS.maxMessageChars) {
      return { ok: false, status: 400, error: `message content exceeds ${LIMITS.maxMessageChars} characters` };
    }
    total += m.content.length;
  }
  if (total > LIMITS.maxTotalChars) {
    return { ok: false, status: 400, error: `combined message content exceeds ${LIMITS.maxTotalChars} characters` };
  }

  if (state !== undefined && (typeof state !== 'object' || state === null || Array.isArray(state))) {
    return { ok: false, status: 400, error: 'state must be an object' };
  }
  if (state !== undefined && JSON.stringify(state).length > LIMITS.maxStateBytes) {
    return { ok: false, status: 400, error: 'state payload too large' };
  }

  // Optional: the user's stated location from onboarding ("Tokyo", "Paris…").
  const { place } = raw;
  if (place !== undefined && place !== null && (typeof place !== 'string' || place.length > 120)) {
    return { ok: false, status: 400, error: 'place must be a string of at most 120 characters' };
  }

  // Only the fields the model needs — drops anything unexpected a client sends.
  return {
    ok: true,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    state: state ?? {},
    place: typeof place === 'string' && place.trim() ? place.trim() : null,
  };
}

/**
 * CORS headers for the caller's origin. The app and API are same-origin in
 * production, so we echo only our own origin (plus localhost for dev) and omit
 * the header entirely for anything else — a cross-site page can still POST,
 * but the browser won't let it read the response.
 */
export function corsHeaders(request, selfOrigin) {
  const origin = request.headers.get('Origin');
  const allowed =
    origin &&
    (origin === selfOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...(allowed ? { 'Access-Control-Allow-Origin': origin } : {}),
  };
}
