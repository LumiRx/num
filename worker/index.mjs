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
import { ask as askBrains, roster as brainRoster, probe as brainProbe } from './brains.mjs';
import { AIR_TOOLS, airReady, callAir, trustEnvelope } from './air.mjs';
import { handlePush, notify, pushReady } from './push.mjs';
import { driveReady, handleDrive } from './doordash.mjs';
import { handleSabre, sabreReady } from './sabre.mjs';
import { bookingConfigured, handleBooking } from './sabre-booking.mjs';
import { handleErrands } from './errands.mjs';
import { handleEmail } from './email.mjs';
import { handlePay, payMode } from './pay.mjs';
import { handleVoice, voiceReady } from './voice.mjs';
import { handleSmsInbound, handleSmsStatus, handleInboxRead, handleEmailIn } from './sms.mjs';
import { handleCashout } from './cashout.mjs';
import { handleHealth, healthCron } from './health.mjs';
import { handleBizReferral } from './bizreferral.mjs';
import { markReferralEarned } from './referral.mjs';
import { handleBizApi, bizApiIndex } from './bizapi.mjs';
import { handleBizMcp } from './bizmcp.mjs';
import { recordImpressions } from './impressions.mjs';
import { handleAccount } from './account.mjs';
import { handleMembership } from './membership.mjs';
import { handleDm } from './dm.mjs';
import { handleAvailability } from './availability.mjs';
import { servicesBlock, optionsFor } from './services.mjs';
import { VOICE, pickSpecialist, specialistBrief, styleBlock } from './specialists.mjs';

// Opus by default — it is the concierge and the concierge is the product.
// Overridable without a code change (`wrangler secret put NUM_MODEL`, or a var)
// because the latency/cost trade against Sonnet is a business call, not a
// technical one, and it should be flippable in a minute.
const DEFAULT_MODEL = 'claude-opus-5';

const FALLBACK_REPLY = 'Sorry — I garbled that. Say it once more and I’ll take care of it.';

async function askNum(client, messages, state, grounding, profile, extraSystem, env, userText, acceptLang) {
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
        showtimes: grounding.showtimes ?? null,
        profile,
        buzz: grounding.buzz,
        services: servicesBlock(grounding.place, env ?? {}),
        style: styleBlock(state?.style),
        party: state?.party,
        trip: state?.tripCheck,
        air: airReady(env),
        acceptLang,
      }),
    },
    { type: 'text', text: 'Current trip state (source of truth — reference ids exactly):\n' + JSON.stringify(state) },
  ];
  const brief = specialistBrief(specialist);
  if (brief) system.push({ type: 'text', text: brief });
  if (extraSystem) system.push({ type: 'text', text: extraSystem });
  // A structured reply is one long JSON string. If the model runs out of room
  // it stops MID-STRING, JSON.parse throws, and the user gets an error instead
  // of an answer — which is exactly what a 1400 ceiling did to "cocktails near
  // the beach in Malibu for six". Headroom is cheaper than a dead end. Trimming
  // cost belongs in the prompt that tells the model to keep payloads lean, not
  // in a ceiling that cuts it off mid-sentence.
  const call = (maxTokens) =>
    client.messages.create({
      model: env?.NUM_MODEL || DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      output_config: { format: { type: 'json_schema', schema: REPLY_SCHEMA } },
      messages,
    });

  let response = await call(3000);
  if (response.stop_reason === 'max_tokens') {
    console.warn('[num-ai] hit the 3000 ceiling, retrying wider');
    response = await call(4096);
  }

  if (response.stop_reason === 'refusal') {
    return { reply: 'I can’t help with that one — anything else on the trip?', card: null, chips: null, actions: [], _usage: response.usage, _specialist: specialist };
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Last resort: `reply` is the first field in the schema, so even a truncated
    // payload almost always holds a complete one. Salvaging it turns a hard
    // failure into a slightly less useful answer — a trade worth making every
    // single time.
    const salvaged = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (!salvaged) throw new Error('reply could not be parsed or salvaged');
    console.warn('[num-ai] salvaged a truncated reply');
    parsed = { reply: JSON.parse('"' + salvaged[1] + '"'), card: null, chips: null, actions: [] };
  }
  // usage rides back with the reply so the caller can bill it to a day. Real
  // counts, not an estimate — this is what the admin dashboard reports.
  return { ...normalizeReply(parsed), _usage: response.usage, _specialist: specialist };
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
    // no-store on every API response, without exception. These are all
    // per-user or per-moment answers, and a cached one is a wrong one — most
    // sharply on /api/version, which exists to say what is running RIGHT NOW
    // and which the release script polls to decide whether a deploy landed.
    // A cached version string makes that check confidently wrong, which is
    // worse than having no check at all.
    const json = (status, body, extra) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra },
      });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
    }

    // ── One limiter, in front of everything that WRITES ──────────────────
    //
    // Rate limiting used to guard exactly two endpoints. Everything else was
    // open at full speed, including: unauthenticated Workers-AI transcription
    // (8 MB an upload, billed to us), real courier dispatch, Stripe session
    // creation, Star movements, and — worst — /api/admin/session, which had no
    // lockout at all and could be brute-forced offline-fast.
    //
    // Applying it here, once, means a new route is covered the day it is added
    // instead of the day someone remembers. GETs stay unmetered: they are the
    // polling surface, and throttling them breaks the app before it stops an
    // attacker.
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      // Webhooks are machine-to-machine, signature-verified, and retried by
      // the sender on any non-2xx — throttling them turns a retry storm into
      // lost payments and lost texts.
      // /api/sms/status joins the exempt list for the same reason as the other
      // two: Twilio retries on any non-2xx, so rate-limiting a status callback
      // would turn a busy minute into a retry storm — and would drop exactly
      // the delivery failures we most need to see.
      const isWebhook = url.pathname === '/api/pay/webhook' || url.pathname === '/api/sms/inbound'
        || url.pathname === '/api/sms/status';
      if (!isWebhook) {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        // The admin door gets its own, much smaller bucket: a password guess
        // is not a user action and there is no legitimate reason to make more
        // than a handful a minute.
        const scope = url.pathname === '/api/admin/session' ? `admin:${ip}` : ip;
        const gate = await enforceRateLimit(env, scope);
        if (!gate.ok) {
          return json(429, {
            error: url.pathname === '/api/admin/session'
              ? 'Too many attempts. Wait a minute.'
              : 'You’re going faster than I can keep up — give me a moment.',
          });
        }
      }
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
    // What the server is running. The app compares it with its own stamp, so a
    // phone on a stale cache can be told rather than guessed at.
    // Which brains are wired up. The operator console reads this.
    // What Num/5arz can attest about a person. This is the half of the
    // exchange we provide: AiR holds the calendar, we hold the verification.
    // Keyed, because it is somebody's identity, not a public fact.
    if (url.pathname === '/api/trust') {
      if (!env.AIR_SHARED_KEY || request.headers.get('X-Num-Key') !== env.AIR_SHARED_KEY) {
        return json(401, { error: 'unauthorized' });
      }
      const member = url.searchParams.get('member');
      if (!member) return json(400, { error: 'member required' });
      return json(200, await trustEnvelope(env, { memberId: member }));
    }

    if (url.pathname === '/api/air') {
      return json(200, { connected: airReady(env), tools: AIR_TOOLS });
    }

    if (url.pathname === '/api/brains') {
      // The probe costs Workers AI neurons and takes seconds, so it is gated
      // on the admin key rather than left open.
      if (url.searchParams.get('probe') && env.ADMIN_KEY && request.headers.get('X-Admin-Key') === env.ADMIN_KEY) {
        return json(200, { brains: brainRoster(env), probe: await brainProbe(env) });
      }
      return json(200, { brains: brainRoster(env) });
    }

    if (url.pathname === '/api/version') {
      // What is actually wired, in one place. Each flag is a capability claim,
      // so it reads the same predicate the code paths do rather than a list
      // someone has to remember to update.
      return json(200, {
        version: env.NUM_VERSION ?? 'unknown',
        model: env.NUM_MODEL || DEFAULT_MODEL,
        connected: {
          brain: !!env.ANTHROPIC_API_KEY,
          push: pushReady(env),
          courier: driveReady(env),
          air: airReady(env),
          // Shopping, not booking — the name says so on purpose.
          flight_shopping: sabreReady(env),
          booking: bookingConfigured(env),
          email: !!env.EMAIL,
          payments: payMode(env),
          voice_in: voiceReady(env),
          verify_5arz: !!env.GOOGLE_CLIENT_ID,
        },
        // Public by design — a Google OAuth client id ships inside every page
        // that uses Google Sign-In; the SECRET part of the pair never leaves
        // Google. Serving it here means the frontend and the worker's audience
        // check can never disagree, and the whole 5arz flow stays dark until
        // Viv/Duke set the secret (Gap 1 in Viv's 08-01 status).
        google_client_id: env.GOOGLE_CLIENT_ID ?? null,
        // The number members text to reach Num. A phone number is public by
        // nature; serving it here keeps the app and the worker agreeing.
        sms_number: env.TWILIO_FROM ?? null,
        // The SHAPE of the Twilio SID — never the value.
        //
        // Twilio answered 401 for every send in this product's life, and no
        // amount of reading could tell us whether the stored SID was the right
        // kind of thing. The two failure modes are invisible from outside and
        // need different fixes: an `SK…` API Key SID where an `AC…` Account SID
        // belongs (our code uses it as both URL path and auth username, so it
        // fails twice), or trailing whitespace from a paste, which makes a
        // correct value fail in a way that looks identical to a wrong one.
        //
        // Two characters and a length settle both and reveal nothing usable —
        // an Account SID is not a credential, and this is not even that. The
        // token is never described here in any form.
        twilio_sid_shape: env.TWILIO_SID
          ? { prefix: String(env.TWILIO_SID).slice(0, 2), length: String(env.TWILIO_SID).length, clean: String(env.TWILIO_SID) === String(env.TWILIO_SID).trim() }
          : null,
      });
    }

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

    if (url.pathname.startsWith('/api/drive')) {
      const res = await handleDrive(request, env, url.pathname.slice('/api/drive'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Booking sits on its own prefix, not under /api/sabre, so that the
    // committing surface is never reachable by fat-fingering a shopping path.
    // Short share paths. /r/CODE, /i/TOKEN and /c/ID exist so a link that gets
    // read aloud, screenshotted or printed is short enough to survive it. They
    // 302 to the query form the app already understands, so there is exactly
    // one place that parses them and no new client code.
    const short = /^\/(r|i|c)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
    if (short) {
      const key = { r: 'ref', i: 'i', c: 'c' }[short[1]];
      const q = new URLSearchParams(url.search);
      q.delete(key);
      q.set(key, short[2]);
      return new Response(null, {
        status: 302,
        headers: { Location: `/?${q.toString()}`, 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/api/dm')) {
      const res = await handleDm(request, env, url.pathname.slice('/api/dm'.length) || '/', ctx);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/availability')) {
      const res = await handleAvailability(request, env, url.pathname.slice('/api/availability'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/voice')) {
      const res = await handleVoice(request, env, url.pathname.slice('/api/voice'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Twilio's inbound-SMS webhook and the member's inbox view of it.
    if (url.pathname === '/api/sms/inbound') return await handleSmsInbound(request, env);
    // Twilio's delivery receipts. Signature-verified inside, like inbound.
    if (url.pathname === '/api/sms/status') return await handleSmsStatus(request, env);
    if (url.pathname === '/api/sms/inbox') {
      const res = await handleInboxRead(request, env);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Deep health. Point an uptime checker at /api/health — it answers 503
    // when the product is actually broken, not just when the Worker is down.
    if (url.pathname.startsWith('/api/health')) {
      const res = await handleHealth(request, env, url.pathname.slice('/api/health'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Leaving: unfriend, remove a plan, delete an account.
    // ── Analytics loader ───────────────────────────────────────────────
    //
    // Static assets never pass through the Worker, so the Cloudflare Web
    // Analytics beacon can't be injected at the edge. Instead index.html
    // loads THIS, and the token lives in env (CF_BEACON_TOKEN) — paste the
    // token once as a secret and analytics is live, no code deploy. Until
    // it's set, this serves a comment rather than a broken script tag.
    // Two loaders in one file: the Cloudflare beacon (traffic) and GA4
    // (conversions). GA4 must be here, not just referenced by app code:
    // src/lib/social.ts fires `window.gtag?.('event','verified_signup')`,
    // and the `?.` means that on a page with no gtag library it does
    // NOTHING, silently, forever. That is exactly what shipped — the event
    // existed in code, was never installed on the page, and so never
    // appeared in GA4 for Google Ads to optimize toward. The optional
    // chaining that made it crash-proof also made it invisible.
    //
    // GA_MEASUREMENT_ID is config, not code: paste it once as a var and
    // conversions start flowing with no deploy.
    if (url.pathname === '/api/analytics.js') {
      const token = env.CF_BEACON_TOKEN;
      const ga = env.GA_MEASUREMENT_ID;
      const parts = [];
      if (token) {
        parts.push(
          `(function(){var s=document.createElement('script');s.defer=true;` +
          `s.src='https://static.cloudflareinsights.com/beacon.min.js';` +
          `s.setAttribute('data-cf-beacon', JSON.stringify({ token: ${JSON.stringify(String(token))} }));` +
          `document.head.appendChild(s);})();`,
        );
      }
      if (ga) {
        // dataLayer + gtag stub FIRST, synchronously. The stub queues calls
        // made before gtag.js finishes downloading — without it, a fast
        // verifier who signs up in the first second loses their conversion.
        parts.push(
          `(function(){var id=${JSON.stringify(String(ga))};` +
          `window.dataLayer=window.dataLayer||[];` +
          `window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};` +
          `window.gtag('js',new Date());` +
          // The app is a single-page PWA: gtag's automatic page_view fires
          // once and never again as the user moves between tabs. Conversions
          // are event-based here, so that's fine — but say so explicitly
          // rather than leaving someone to wonder why sessions look short.
          `window.gtag('config',id,{send_page_view:true});` +
          `var s=document.createElement('script');s.async=true;` +
          `s.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(id);` +
          `document.head.appendChild(s);})();`,
        );
      }
      const js = parts.length
        ? parts.join('\n')
        : '/* analytics: set CF_BEACON_TOKEN and/or GA_MEASUREMENT_ID to enable */';
      return new Response(js, {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300', ...cors },
      });
    }

    // ── /media/* — video with real byte ranges ─────────────────────────
    //
    // The static asset handler answers a Range request with a 200 and the
    // whole file. Desktop Chrome shrugs and plays anyway; iPhones REFUSE —
    // AVPlayer demands a 206 or shows a black box. The ad traffic is
    // iPhones. So video is served here, by the worker, which reads the
    // asset once and slices the bytes the player actually asked for.
    if (url.pathname.startsWith('/media/') && env.ASSETS) {
      const asset = await env.ASSETS.fetch(new URL('/assets/' + url.pathname.slice(7), url.origin));
      if (!asset.ok) return new Response('not found', { status: 404 });
      const buf = await asset.arrayBuffer();
      const range = request.headers.get('range');
      const type = asset.headers.get('content-type') ?? 'video/mp4';
      const common = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        ...cors,
      };
      const m = range && /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), buf.byteLength - 1) : buf.byteLength - 1;
        if (start >= buf.byteLength) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.byteLength}`, ...cors } });
        }
        return new Response(buf.slice(start, end + 1), {
          status: 206,
          headers: { ...common, 'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`, 'Content-Length': String(end - start + 1) },
        });
      }
      return new Response(buf, { headers: { ...common, 'Content-Length': String(buf.byteLength) } });
    }

    // ── Tiny ad links: /go/<code> ──────────────────────────────────────
    //
    // An ad link full of utm_ parameters looks like tracking because it is,
    // and on a poster or in a bio it's unusable. So the campaign lives in a
    // CODE and the server expands it — the link people see is tiny and
    // branded, and the attribution arrives intact anyway.
    //
    // The map lives HERE, in code, on purpose: adding a campaign is one line
    // and one deploy, and the git history becomes the registry of every link
    // we've ever put money behind.
    if (url.pathname.startsWith('/go/')) {
      const GO = {
        yt: '/watch/?utm_source=youtube&utm_medium=video&utm_campaign=phuket-pretrip-film1',
        ytb: '/watch/?utm_source=youtube&utm_medium=video&utm_campaign=bkk-pretrip-film1',
        ig: '/watch/?utm_source=instagram&utm_medium=reels&utm_campaign=phuket-intrip-film1',
        tt: '/watch/?utm_source=tiktok&utm_medium=video&utm_campaign=phuket-intrip-film1',
        // Destination-agnostic campaigns. The film is shot in Phuket but the
        // copy sells the concierge, so these carry `global` — the campaign
        // name has to describe the TARGETING, or the by_source table lies
        // about what was bought.
        //
        // Reddit specifically: some placements append Reddit's own utm_source
        // to the destination URL, overwriting ours. Redirecting from here
        // keeps the params server-side where Reddit can't reach them.
        rd: '/watch/?utm_source=reddit&utm_medium=social&utm_campaign=global-pretrip-film1',
        dg: '/watch/?utm_source=google&utm_medium=demandgen&utm_campaign=global-pretrip-film1',
      };
      const to = GO[url.pathname.slice(4).replace(/\/$/, '')];
      // Unknown code → the watch page untagged, not a 404. A typo on a poster
      // should cost us attribution, never a visitor.
      return Response.redirect(new URL(to ?? '/watch/', url.origin).toString(), 302);
    }

    if (url.pathname.startsWith('/api/book')) {
      const { handleBooking } = await import('./bookdesk.mjs');
      const res = await handleBooking(request, env, url.pathname.slice('/api/book'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/account')) {
      const res = await handleAccount(request, env, url.pathname.slice('/api/account'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Tiers, entitlements, subscribe.
    if (url.pathname.startsWith('/api/membership')) {
      const res = await handleMembership(request, env, url.pathname.slice('/api/membership'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Refer a business, earn a share of what it pays Num.
    // Num for Business: public API + MCP. Mounted here rather than on its own
    // Worker so it shares the D1 binding and the claim/verify code; the paths
    // are chosen so it can be lifted to api.itsnum.com without renaming.
    if (url.pathname === '/api/biz' || url.pathname === '/api/biz/') return bizApiIndex();
    if (url.pathname === '/api/biz/mcp') return await handleBizMcp(request, env);
    if (url.pathname.startsWith('/api/biz/')) {
      return await handleBizApi(request, env, url.pathname.slice('/api/biz'.length));
    }

    if (url.pathname.startsWith('/api/bizref')) {
      const res = await handleBizReferral(request, env, url.pathname.slice('/api/bizref'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/cashout')) {
      const res = await handleCashout(request, env, url.pathname.slice('/api/cashout'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/pay')) {
      const res = await handlePay(request, env, url.pathname.slice('/api/pay'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/email')) {
      const res = await handleEmail(request, env, url.pathname.slice('/api/email'.length) || '/', ctx);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/errands')) {
      const res = await handleErrands(request, env, url.pathname.slice('/api/errands'.length) || '/', ctx);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/booking')) {
      const res = await handleBooking(request, env, url.pathname.slice('/api/booking'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/sabre')) {
      const res = await handleSabre(request, env, url.pathname.slice('/api/sabre'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname.startsWith('/api/push')) {
      const res = await handlePush(request, env, url.pathname.slice('/api/push'.length) || '/', ctx);
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
      // A real GPS fix from the device outranks the edge's IP guess. When the
      // app sends `here`, hand it to grounding as a precise, NOT-inferred
      // position — that is knowledge; request.cf is a hint.
      const grounding = await groundRequest(env, {
        userText: lastUser,
        statedPlace: parsed.place,
        cf: request.cf,
        fix: parsed.here && Number.isFinite(parsed.here.lat) && Number.isFinite(parsed.here.lng)
          ? { lat: parsed.here.lat, lng: parsed.here.lng }
          : null,
      });

      // The browser's own preference, as a tiebreaker only. What the person
      // actually TYPED wins every time — somebody with an English phone asking
      // in Thai wants Thai back — but on a first message of two words there is
      // nothing else to go on.
      const acceptLang = String(request.headers.get('Accept-Language') ?? '').split(',')[0].trim().slice(0, 12) || null;

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
            ctx.waitUntil(logUsage(env, { lane: 'small', model: 'workers-ai', place: grounding.place?.name ?? null, usage: null, ms: null, memberId: parsed.state?.me?.id ?? null }));
            return json(200, { reply: guard.cleaned, card: null, chips: null, actions: [], place: grounding.place?.name ?? null });
          }
        }
      }

      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const callNum = async (extraSystem) => {
        try {
          return await askNum(client, history, parsed.state, grounding, profile, extraSystem, env, lastUser, acceptLang);
        } catch (err) {
          // Grammar compilation is cached once it succeeds but can time out on a
          // cold schema — one retry usually lands on the warmed cache.
          if (!/grammar compilation/i.test(err?.message ?? '')) throw err;
          await new Promise((r) => setTimeout(r, 1500));
          return askNum(client, history, parsed.state, grounding, profile, extraSystem, env, lastUser, acceptLang);
        }
      };

      // Group intelligence: if the conversation is happening inside a shared
      // plan, fetch what the group needs — server-side, from consented rows
      // only. The client names the plan; it never assembles the needs itself,
      // because the merged list must come from consent flags the client
      // can't forge.
      if (parsed.state?.party?.id) {
        try {
          const { groupNeeds } = await import('./social.mjs');
          const fit = await groupNeeds(env, String(parsed.state.party.id).slice(0, 40));
          if (fit.summary) parsed.state.party.needs = fit.summary;
        } catch { /* the plan context is seasoning — never block the answer */ }
      }

      const startedAt = Date.now();
      // The chain, not one model. Claude first for the full concierge; if it
      // fails for any reason, an open model on Cloudflare's edge (or a
      // self-hosted one) answers in prose rather than the user hitting a wall.
      let result = await askBrains(env, {
        structuredCall: callNum,
        messages: history,
        persona: PERSONA,
        voice: VOICE,
        context: contextBlock({
          place: grounding.place,
          partners: grounding.partners,
          guide: grounding.guide,
          profile,
          buzz: grounding.buzz,
        }),
        style: styleBlock(parsed.state?.style),
        guard: (t) => guardReply(t),
      });
      ctx.waitUntil(
        logUsage(env, {
          lane: result._brain === 'claude' ? 'big' : `fallback:${result._brain}`,
          model: result._brain === 'claude' ? env.NUM_MODEL || DEFAULT_MODEL : result._brain,
          specialist: result._specialist ?? null,
          place: grounding.place?.name ?? null,
          usage: result._usage,
          ms: Date.now() - startedAt,
          memberId: parsed.state?.me?.id ?? null,
        }),
      );
      // Somebody asked their concierge something, which is the moment a
      // referral stops being a signup and starts being a user. Runs after the
      // response is on its way, and is a no-op once already earned, so calling
      // it on every ask costs one indexed write attempt and never adds latency
      // — cheaper than reading first to find out it has nothing to do.
      if (parsed.state?.me?.id) {
        ctx.waitUntil(markReferralEarned(env, parsed.state.me.id, 'first_ask'));
      }
      // Which businesses the guest was actually shown. Deferred, never awaited:
      // the answer is already on its way and a merchant's analytics must never
      // be a reason somebody waits. Only places NAMED in the reply or featured
      // as the card are counted — being a candidate and passed over is not an
      // impression, and inflating that number would corrupt the one figure a
      // merchant makes decisions on.
      ctx.waitUntil(recordImpressions(env, {
        partners: grounding.partners,
        reply: result.reply,
        card: result.card,
        memberId: parsed.state?.me?.id ?? null,
        dest: grounding.place?.slug ?? null,
        asked: userText,
      }));
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
      // AiR actions run HERE, not on the device: they need the trust envelope,
      // which is assembled from two databases the browser cannot see.
      const airActions = (result.actions ?? []).filter((x) => x.type === 'air');
      if (airActions.length && airReady(env)) {
        const memberId = parsed.state?.me?.id ?? null;
        const trust = await trustEnvelope(env, { memberId }).catch(() => null);
        for (const a of airActions) {
          try {
            a.result = await callAir(env, a.tool, a.args, { trust, memberId, ctx });
          } catch (err) {
            a.error = String(err?.message ?? err).slice(0, 200);
          }
        }
      } else if (airActions.length) {
        airActions.forEach((a) => (a.error = 'AiR is not connected'));
      }

      const withPhoto = await attachPhoto(env, result, grounding);
      const withServices = attachServiceOptions(env, withPhoto, grounding);
      // Internals never leave the Worker.
      const { _usage, _specialist, _brain, _tried, _ms, _degraded, ...clean } = withServices;
      void _usage;
      void _specialist;
      void _tried;
      void _ms;
      // `degraded` tells the app a fallback brain answered, so it can avoid
      // treating a prose reply as if it created bookings.
      return json(200, { ...clean, place: grounding.place ? grounding.place.name : null, ...(_degraded ? { degraded: true, brain: _brain } : {}) });
    } catch (err) {
      console.error('[num-ai]', err);
      // A guest never hears "the kitchen is broken". If the big model failed
      // for any reason, try the cheap one — it cannot book anything, but it can
      // hold the conversation open, which is the whole job at this moment.
      try {
        const rescue = await smallReply(env, parsed.messages.slice(-4), parsed.state?.profile ?? {}, parsed.place ?? null);
        const guard = rescue ? guardReply(rescue) : { ok: false };
        if (guard.ok && !/\bHANDOFF\b/.test(guard.cleaned) && !soundsLikeASwitchboard(guard.cleaned)) {
          ctx.waitUntil(logUsage(env, { lane: 'rescue', model: 'workers-ai', place: parsed.place ?? null, usage: null, ms: null, memberId: parsed.state?.me?.id ?? null }));
          return json(200, { reply: guard.cleaned, card: null, chips: null, actions: [], place: parsed.place ?? null });
        }
      } catch (rescueErr) {
        console.warn('[num-ai] rescue lane also failed:', rescueErr?.message ?? rescueErr);
      }

      // Both lanes down. Own it, keep it warm, and give them the one thing that
      // actually helps — a nudge to say it again — rather than blaming their
      // connection, which is almost never the cause and always sounds like it
      // is their fault.
      const status = err?.status === 429 ? 429 : 200;
      return json(status, {
        reply:
          err?.status === 429
            ? 'You’ve got me moving faster than I can keep up — give me a few seconds and ask me again.'
            : 'That one slipped away from me — entirely my end, nothing to do with you. Say it once more and I’ll pick it straight up.',
        card: null,
        chips: null,
        actions: [],
        place: parsed.place ?? null,
        degraded: true,
      });
    }
  },

  // Email Routing hands forwarded mail here once the itsnum.com catch-all
  // points at this worker. num+<member id>@itsnum.com files it to the member.
  async email(message, env) {
    await handleEmailIn(message, env);
  },

  // Num watching Num. Every 5 minutes: probe the paths that fail silently,
  // record the verdict, and shout ONLY when the state changes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(healthCron(env).catch((e) => console.error('[health-cron]', e?.message ?? e)));
    // The concierge that speaks first. Same cron, its own failure domain —
    // a broken nudge must never take health monitoring down with it.
    ctx.waitUntil(
      import('./nudge.mjs')
        .then((m) => m.nudgeSweep(env))
        .catch((e) => console.error('[nudge]', e?.message ?? e)),
    );
    // Stalled business onboardings — the pilot's highest-value follow-up.
    ctx.waitUntil(
      import('./nudge.mjs')
        .then((m) => m.claimSweep(env))
        .catch((e) => console.error('[claimsweep]', e?.message ?? e)),
    );
    // Every signup gets researched — dossier with its own data and promo
    // options, three per tick so a backlog clears in minutes, not budgets.
    ctx.waitUntil(
      import('./bizdossier.mjs')
        .then((m) => m.dossierSweep(env))
        .catch((e) => console.error('[dossier]', e?.message ?? e)),
    );
  },
};
