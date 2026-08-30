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
import { redactProfile, redactState } from './redact.mjs';
import { readCache, writeCache, cacheable } from './answercache.mjs';
import { recordAsk } from './asks.mjs';
import { corsHeaders, enforceRateLimit, validatePayload, LIMITS } from './guard.mjs';
import { groundRequest } from './grounding.mjs';
import { formatEvents } from './cityevents.mjs';
import { loadFacts, saveFacts } from './memory.mjs';
import { pickLane, pickModel, smallReply, guardReply, soundsLikeASwitchboard } from './router.mjs';
import { scrubPayload as scrubTravelSpeak } from './travelspeak.mjs';
import { direct } from './director.mjs';
import { inspect } from './quality.mjs';
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
import { handleDuffelSearch, duffelCapability } from './duffel.mjs';
import { partners as travelPartners } from './travelpartners.mjs';
import { handlePassengersSafe, assertNoPassengerData } from './passengers.mjs';
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
import { handlePartnerMcp, partnerIndex } from './partnermcp.mjs';
import { handleConciergeMcp, conciergeIndex } from './conciergemcp.mjs';
import { handleOpen, handleBookLink, handlePlatforms } from './openapi.mjs';
import { recordImpressions } from './impressions.mjs';
import { handleAccount } from './account.mjs';
import { handleMembership } from './membership.mjs';
import { handleDm } from './dm.mjs';
import { handleAvailability } from './availability.mjs';
import { servicesBlock, optionsFor } from './services.mjs';
import { blockFor as viatorBlock } from './viator.mjs';
import { carLink, carBlock } from './localrent.mjs';
import { blockFor as eventsBlockFor } from './events.tm.mjs';
import { luggageLink, luggageBlock, wantsLuggage } from './luggage.mjs';
import { tagged } from './affiliate.mjs';
import { logHandoffs } from './affiliateclicks.mjs';
import { VOICE, pickSpecialist, specialistBrief, styleBlock } from './specialists.mjs';

// Opus by default — it is the concierge and the concierge is the product.
// Overridable without a code change (`wrangler secret put NUM_MODEL`, or a var)
// because the latency/cost trade against Sonnet is a business call, not a
// technical one, and it should be flippable in a minute.
const DEFAULT_MODEL = 'claude-opus-5';

// Renting a car is a different request from ordering one with a driver, and
// conflating them is how somebody asking for a lift to the airport gets handed
// a week-long hire. "rent/hire a car", "self drive", "4wd" — never "a car to
// the airport", which belongs to the ride specialist.
// A bare 4WD/4x4/jeep is a self-drive word in a way "car" and "SUV" are not —
// nobody orders a 4x4 with a driver to the airport. It is also how the
// ferry-with-a-vehicle ask was actually phrased in our own data.
const WANTS_CAR = /\b(rent(?:al|ing)?|hire|hiring)\s+(?:a\s+|an\s+)?(?:car|suv|4.?wd|jeep|van|vehicle|scooter|bike|motorbike)\b|\b(?:car|suv|4.?wd|jeep|van)\s+(?:rental|hire)\b|\bself.?drive\b|\b(?:4.?wd|4x4|jeep)\b/i;

const FALLBACK_REPLY = 'Sorry — I garbled that. Say it once more and I’ll take care of it.';

async function askNum(client, messages, state, grounding, profile, extraSystem, env, userText, acceptLang) {
  // PERSONA + VOICE are identical on every request, so they sit above the
  // cache breakpoint. Everything below it changes per turn.
  const specialist = pickSpecialist(userText ?? '');
  // Nothing that identifies a person leaves this Worker. The profile is
  // printed verbatim as KNOWN FACTS and the state is stringified whole, so
  // both are filtered here — once, at the only point where every brain,
  // present and future, is downstream of it.
  const safeProfile = redactProfile(profile);
  const safeState = redactState(state);
  if (safeProfile.removed || safeState.removed) {
    // Count only. Logging WHICH fields were dropped would put them in the log
    // instead of the prompt, which is not an improvement.
    console.log(`[num-ai] redacted ${safeProfile.removed + safeState.removed} identifying field(s) before the model saw them`);
  }
  const system = [
    { type: 'text', text: PERSONA + '\n\n' + VOICE, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: contextBlock({
        place: grounding.place,
        partners: grounding.partners,
        guide: grounding.guide,
        showtimes: grounding.showtimes ?? null,
        events: formatEvents(grounding.events ?? []),
        profile: safeProfile.profile,
        buzz: grounding.buzz,
        services: servicesBlock(grounding.place, env ?? {}),
        style: styleBlock(state?.style),
        party: state?.party,
        trip: state?.tripCheck,
        air: airReady(env),
        acceptLang,
      }),
    },
    { type: 'text', text: 'Current trip state (source of truth — reference ids exactly):\n' + JSON.stringify(safeState.state) },
  ];
  const brief = specialistBrief(specialist);
  if (brief) system.push({ type: 'text', text: brief });
  // Real tours for the turns that are actually about doing something. Gated on
  // intent inside blockFor, and it swallows every failure — a slow or broken
  // Viator must never cost somebody their reply, it just means Num answers
  // from what it already knows about the place.
  const activities = await viatorBlock(env ?? {}, grounding.place, userText);
  if (activities) system.push({ type: 'text', text: activities });
  // Car hire, when they asked for one and Localrent is actually in this
  // country. No network call — it is a URL builder — so there is nothing to
  // gate on latency, only on relevance. carLink returns null outside their
  // coverage, which is the whole point: a dead link carrying our marker is
  // worse than no link.
  if (WANTS_CAR.test(userText ?? '')) {
    const car = carBlock(carLink(env ?? {}, grounding.place), grounding.place);
    if (car) system.push({ type: 'text', text: car });
  }
  // Real ticketed events, gated on intent and on Ticketmaster actually
  // carrying the country. Silent in Thailand on purpose: "nothing is on
  // tonight" would be a claim about Phuket when it is only a fact about
  // Ticketmaster.
  const onTonight = await eventsBlockFor(env ?? {}, grounding.place, userText);
  if (onTonight) system.push({ type: 'text', text: onTonight });
  // Luggage. No network call — a URL builder — so only relevance gates it.
  if (wantsLuggage(userText ?? '')) {
    const bags = luggageBlock(luggageLink(env ?? {}, grounding.place), grounding.place);
    if (bags) system.push({ type: 'text', text: bags });
  }
  if (extraSystem) system.push({ type: 'text', text: extraSystem });
  // A structured reply is one long JSON string. If the model runs out of room
  // it stops MID-STRING, JSON.parse throws, and the user gets an error instead
  // of an answer — which is exactly what a 1400 ceiling did to "cocktails near
  // the beach in Malibu for six". Headroom is cheaper than a dead end. Trimming
  // cost belongs in the prompt that tells the model to keep payloads lean, not
  // in a ceiling that cuts it off mid-sentence.
  // Opus for the turns that deserve it, Sonnet for one-line lookups. Fails
  // toward Opus on anything ambiguous — see router.pickModel.
  const model = pickModel(userText, state, env ?? {});
  const call = (maxTokens, m = model) =>
    client.messages.create({
      model: m,
      max_tokens: maxTokens,
      system,
      output_config: { format: { type: 'json_schema', schema: REPLY_SCHEMA } },
      messages,
    });

  // `reply` is the first field in the schema, so even a truncated payload
  // almost always holds a complete one. Salvaging it turns a hard failure
  // into a slightly less useful answer.
  const parseStructured = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      const salvaged = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (!salvaged) return null;
      console.warn('[num-ai] salvaged a truncated reply');
      return { reply: JSON.parse('"' + salvaged[1] + '"'), card: null, chips: null, actions: [] };
    }
  };

  let response = await call(3000);
  if (response.stop_reason === 'max_tokens') {
    console.warn('[num-ai] hit the 3000 ceiling, retrying wider');
    response = await call(4096);
  }

  if (response.stop_reason === 'refusal') {
    return { reply: 'I can’t help with that one — anything else on the trip?', card: null, chips: null, actions: [], _usage: response.usage, _specialist: specialist };
  }
  let text = response.content.find((b) => b.type === 'text')?.text ?? '';
  let parsed = parseStructured(text);
  // Sanity gate — 9 Aug incident: a weak-model turn wrote its half-finished
  // draft INTO the reply field (garbled prose, "<br>", "let me produce final
  // answer") and the app rendered it, junk card and all. Structured output
  // constrains the shape, not the sanity. A reply that fails the guard is
  // DISCARDED whole — card, chips, actions too — and the turn is retried once
  // on the strong model. Rendering junk to a guest is never on the menu.
  if (!parsed || !guardReply(parsed.reply).ok) {
    console.error(`[num-ai] GARBLED REPLY suppressed (model=${model}) — retrying strong`);
    response = await call(4096, env?.NUM_MODEL_STRONG || 'claude-opus-5');
    if (response.stop_reason !== 'refusal') {
      text = response.content.find((b) => b.type === 'text')?.text ?? '';
      parsed = parseStructured(text);
    }
    if (!parsed || !guardReply(parsed.reply).ok) {
      console.error('[num-ai] retry ALSO garbled — clean miss beats a leak');
      return { reply: 'I lost my thread for a second — ask me that once more?', card: null, chips: null, actions: [], _usage: response.usage, _specialist: specialist };
    }
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
    // \p{M} is not optional here. Thai, Arabic, Devanagari and decomposed
    // Vietnamese carry vowels and tones as combining marks, so a letters-only
    // class chops every such name into one- and two-character fragments, all
    // of them under the {3,} floor. The result was not a worse match — it was
    // no match at all: `words` came back empty and every Thai place card
    // returned without a photo.
    const words = (core.match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? []).sort((a, b) => b.length - a.length);
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
function attachServiceOptions(env, result, grounding, log = {}) {
  const place = grounding.place ?? {};
  // Every outbound link this reply will show, collected as it is built. See
  // the note above the logHandoffs() call at the bottom for why.
  const handed = [];
  const actions = (result.actions ?? []).map((a) => {
    if (a.type !== 'service') return a;
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
    // Tagged LAST, on options already ordered on merit by optionsFor(). Same
    // rule as openapi.mjs and for the same reason: there is no code path by
    // which a referral rate can reach the ranking, and there must never be.
    const priced = options.map((o) => {
      const t = tagged(o.url, env, { extra: place.slug ?? null });
      handed.push({ ...t, kind: a.kind });
      return { ...o, url: t.url };
    });
    return { ...a, mode, options: priced };
  });
  // ── WHY THE LOG LIVES HERE AND NOWHERE ELSE ──────────────────────────
  //
  // Until now the ONLY caller of logHandoffs was openapi.mjs — the agent
  // surface. Every human using Num sees their deep-links through this
  // function, and not one of those handoffs was ever recorded: the table had
  // never been created because nothing had ever written to it. So the answer
  // to "how much traffic do we send OpenTable" — the exact evidence an
  // affiliate application asks for — was a shrug, on the busiest path we
  // have.
  //
  // Logged whether or not a programme matched. An UNTAGGED handoff with real
  // volume is the most valuable row in the table while NUM_AFFILIATES is
  // still mostly empty: it is the ranked list of which programme to apply for
  // next. Dropping it because we earned nothing on it is how that list stays
  // a guess.
  if (handed.length) {
    logHandoffs(env, log.ctx, handed, {
      surface: 'concierge',
      memberId: log.memberId ?? null,
      // grounding.mjs calls the destination `slug`; openapi.mjs calls the
      // same value `dest` because that is the column name. One column, two
      // names, and a log split across both is a log that cannot be grouped.
      dest: place.slug ?? place.dest ?? null,
    });
  }
  return { ...result, actions };
}

/**
 * Test seam. `attachServiceOptions` is the single place every human-facing
 * deep-link is produced, so it is the single place worth asserting on — and a
 * regex over this file would have passed happily on the day the click log had
 * exactly one caller and it was the agent surface.
 */
export const __testables = { attachServiceOptions };

/**
 * Builds the one `json(status, body, extra)` response helper every route in
 * this Worker returns through, plus a `setTravelContext` setter for it.
 *
 * ── THE TRAVEL-SPEAK FILTER, AT THE ONE DOOR EVERY REPLY LEAVES BY ───
 *
 * /api/num has eight return sites: cache hit, small lane, the main path,
 * the rescue lane, two guard fallbacks, the 429 and the apology. A filter
 * wired to one of them is a filter that is off six times out of eight, and
 * the seventh is the failure path where a degraded model is MOST likely to
 * say "I've booked that". So it sits here instead, in the helper all eight
 * already go through, keyed on the shape of a concierge payload rather
 * than on the route — which means the next return site added is covered on
 * the day it is written.
 *
 * It REWRITES, never blocks. worker/travelspeak.mjs explains why at length;
 * the short version is that the legal exposure is the forbidden words
 * reaching the traveller, a deterministic rewrite removes exactly those
 * with certainty, and a block removes the answer too.
 *
 * A factory, not a module-level singleton, because two independent request
 * paths build one each: fetch()'s own preamble, and handleNum() below when
 * it is called directly (in-process, no self-fetch) rather than through
 * fetch() — see the 18 Aug 2026 note on handleNum for why that matters.
 */
function jsonFactory(cors) {
  // What the guest actually asked this turn. Set once /api/num has parsed
  // the body; the travel-speak filter below uses it to tell a flight from a
  // dinner when the reply itself is ambiguous.
  let travelContext = '';
  const setTravelContext = (text) => { travelContext = text; };
  const json = (status, body, extra) => {
    let out = body;
    if (body && typeof body === 'object' && typeof body.reply === 'string') {
      const scrubbed = scrubTravelSpeak(body, { context: travelContext });
      const found = scrubbed._travelspeak;
      if (found) {
        const { _travelspeak, ...clean } = scrubbed;
        void _travelspeak;
        out = clean;
        if (found.hits.length) {
          console.warn(
            `[travelspeak] rewrote ${found.hits.length} travel claim(s) before send: ` +
            found.hits.map((h) => `${h.rule}="${h.match}"`).join(', '),
          );
        }
        // Soft hits are matches with no topic anywhere — never rewritten,
        // recorded so drift is visible before it becomes an exposure.
        if (found.soft.length) {
          console.log(`[travelspeak] ${found.soft.length} ambiguous match(es), left alone: ` +
            found.soft.map((h) => `${h.rule}="${h.match}"`).join(', '));
        }
      }
    }
    return new Response(JSON.stringify(out), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra },
    });
  };
  return { json, setTravelContext };
}

/**
 * The /api/num handler, importable directly.
 *
 * Until 29 Aug 2026 this logic lived only inline in fetch()'s POST /api/num
 * branch, which meant the only way for another Worker route to reach it was
 * a fetch() back to this Worker's own public hostname. Cloudflare answers a
 * same-zone self-fetch with an instant 522 (.github/workflows/uptime.yml:6
 * already documented this), which is exactly what killed concierge_answer
 * on the num-partners MCP surface — see worker/partnermcp.test.mjs, dated
 * 18 Aug 2026, for the measured symptom. open_places and booking_link never
 * had this problem because they already import their handler directly
 * instead of fetch()-ing it; concierge_answer now does the same, importing
 * and calling this function with a synthetic Request instead of a
 * subrequest to app.itsnum.com.
 *
 * fetch()'s own POST /api/num branch is just `return await handleNum(request, env, ctx);`
 * below — same code, same behavior, zero duplication.
 */
export async function handleNum(request, env, ctx) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, url.origin);
  const { json, setTravelContext } = jsonFactory(cors);

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

  // Declared OUTSIDE the try so the catch can still use them. The grounding
  // step is the expensive half of a turn — location resolved, real partners
  // pulled from D1 — and it completes before any model is called. Scoping it
  // to the try meant that when every brain failed we threw away work we had
  // already done and apologised instead of answering with it.
  let grounding = null;
  let lastUser = '';
  try {
    // Same brain as the texts: resolve the user's location and pull
    // verified partners from the shared num-db before Claude answers.
    lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // The last few turns, not just this one: "book it" arrives a turn after
    // "what's the fare to Bangkok", and the word that makes it travel is in
    // the earlier message.
    setTravelContext(parsed.messages.slice(-4).map((m) => String(m?.content ?? '')).join('\n'));
    // A real GPS fix from the device outranks the edge's IP guess. When the
    // app sends `here`, hand it to grounding as a precise, NOT-inferred
    // position — that is knowledge; request.cf is a hint.
    // Who is asking, if anyone — a phone-verified member (num_members),
    // not a device. Loaded in parallel with grounding so durable, per-
    // member memory (worker/memory.mjs) never adds sequential latency.
    const memberId = parsed.state?.me?.id ?? null;
    const [groundResult, rememberedFacts] = await Promise.all([
      groundRequest(env, {
        userText: lastUser,
        statedPlace: parsed.place,
        cf: request.cf,
        fix: parsed.here && Number.isFinite(parsed.here.lat) && Number.isFinite(parsed.here.lng)
          ? { lat: parsed.here.lat, lng: parsed.here.lng }
          : null,
      }),
      memberId ? loadFacts(env, memberId).catch(() => ({})) : Promise.resolve({}),
    ]);
    grounding = groundResult;

    // The browser's own preference, as a tiebreaker only. What the person
    // actually TYPED wins every time — somebody with an English phone asking
    // in Thai wants Thai back — but on a first message of two words there is
    // nothing else to go on.
    const acceptLang = String(request.headers.get('Accept-Language') ?? '').split(',')[0].trim().slice(0, 12) || null;

    // Profile + trip state carry long-term context now, so the model only
    // needs the recent turns.
    const history = parsed.messages.slice(-14);
    // Server memory (worker/memory.mjs) is the FLOOR, never the ceiling: a
    // durable fact survives losing the app, but a correction the guest
    // just made THIS session — still only living in state.profile until
    // the next remember action lands it server-side — always wins.
    const profile = { ...rememberedFacts, ...(parsed.state?.profile ?? {}) };

    // Small lane: chit-chat goes to Workers AI, no Claude call at all. Any
    // wobble — HANDOFF, null, or a guard failure — falls through to the big
    // lane rather than to a worse answer.
    // An answer we already paid for. Costs one D1 read and zero tokens, and
    // returns in milliseconds — so it runs before the lane is even chosen.
    // cacheable() gates the WRITE strictly; this read is keyed on the same
    // rules, so a personal question can never match a shared entry.
    if (cacheable({ userText: lastUser, profile, state: parsed.state ?? {}, reply: {} })) {
      const hit = await readCache(env, { userText: lastUser, place: grounding.place?.name ?? null, lang: acceptLang });
      if (hit) {
        console.log('[num-ai] served from cache, no model called');
        ctx.waitUntil(recordAsk(env, { text: lastUser, dest: grounding.place?.slug ?? null, lane: 'cache', cached: true, memberId: parsed.state?.me?.id ?? null }));
        return json(200, { ...hit, actions: [], place: grounding.place?.name ?? null });
      }
    }

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

    // Hoisted: the quality check needs to see exactly what the model saw.
    // A price is only defensible if it is IN here.
    const groundingBlock = contextBlock({
      place: grounding.place,
      partners: grounding.partners,
      guide: grounding.guide,
      profile: redactProfile(profile).profile,
      buzz: grounding.buzz,
      events: formatEvents(grounding.events ?? []),
    });
    const startedAt = Date.now();
    // The chain, not one model. Claude first for the full concierge; if it
    // fails for any reason, an open model on Cloudflare's edge (or a
    // self-hosted one) answers in prose rather than the user hitting a wall.
    let result = await askBrains(env, {
      structuredCall: callNum,
      messages: history,
      persona: PERSONA,
      voice: VOICE,
      // Redacted, same as the Claude path. Found 11 Aug while auditing the
      // Bionic seam: the structured path scrubbed the profile (safeProfile,
      // askNum) but THIS context — the one every fallback vendor receives —
      // passed it raw. The cheaper the model, the less we know about its
      // operator; the fallback must see less, never more.
      context: groundingBlock,
      style: styleBlock(parsed.state?.style),
      guard: (t) => guardReply(t),
      // Who should answer THIS question. Money, bookings, groups and trouble
      // go to Claude first; recommendations and lookups go to the hosted
      // response brain, which costs 1/76th as much. The rest of the chain
      // stays underneath either way — the director chooses the order, never
      // the last resort.
      directive: direct(lastUser, parsed.state, env),
    });
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
      // `lastUser`, NOT `userText`. `userText` is a parameter of askNum and
      // does not exist in this scope — referencing it threw a ReferenceError
      // on every big-lane request, AFTER the model had already produced a
      // good answer, and the catch below quietly replaced it with the
      // directory fallback. Days of "the chat is down" were this line.
      asked: lastUser,
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

    // ── RESPONSE QUALITY CONTROL ───────────────────────────────────────
    //
    // The guard above asks "is this well-formed prose". This asks the
    // question Dre actually posed on 11 Aug: does it ANSWER what was asked.
    // Deterministic, so it costs nothing and cannot be down — see
    // quality.mjs for why this is not a second model call.
    //
    // A hard flag (an invented price, a deflection with the answer sitting
    // in context, a reply that is only a question) earns ONE corrective
    // retry. If the retry is no better the original still ships: grading
    // never produces silence. Soft flags are recorded and nothing else.
    let quality = inspect({ ask: lastUser, reply: result.reply, context: groundingBlock });
    if (quality.hard) {
      try {
        const fixed = await callNum(quality.note);
        const fixedGuard = guardReply(fixed.reply);
        if (fixedGuard.ok) {
          const after = inspect({ ask: lastUser, reply: fixedGuard.cleaned, context: groundingBlock });
          // Take the retry only if it is genuinely better. A retry that
          // trades an invented price for an off-topic answer is not a fix.
          if (!after.hard) {
            result = { ...fixed, reply: fixedGuard.cleaned };
            quality = { ...after, flags: [...after.flags, 'retried'] };
          } else {
            quality = { ...quality, flags: [...quality.flags, 'retry-failed'] };
          }
        }
      } catch {
        // The first answer is already good enough to send. A failed retry
        // must never cost the guest the reply they had.
        quality = { ...quality, flags: [...quality.flags, 'retry-error'] };
      }
    }
    // The ask FIRST, then the cost that answered it, joined by ask_id.
    // Ordered deliberately: recorded separately they are two facts about the
    // same second that nothing can put back together, and "what did this
    // kind of question cost" — the number that tunes the router — stays
    // unanswerable. Both still run after the reply is on its way.
    // THE MONITOR IS NOT A GUEST.
    //
    // scripts/uptime.mjs asks a real question through the real model path
    // every five minutes, deliberately — it is the only check that measures
    // what a visitor experiences, and it caught a two-day outage every
    // status-code check missed. But it is not a person, and on 15 Aug its
    // one string was 183 of 283 recorded questions: 65% of everything Num
    // had ever been asked. Every funnel number, every cost-per-ask, every
    // "what do people want" answer was computed against a robot asking the
    // same thing about Patong.
    //
    // So it still runs the full path and still costs a model call; it just
    // stops writing to the tables we make decisions from.
    const isProbe = request.headers.get('X-Num-Probe') === '1';
    if (!isProbe) ctx.waitUntil(
      recordAsk(env, {
        text: lastUser,
        dest: grounding.place?.slug ?? null,
        lane: 'big',
        brain: result._brain ?? null,
        degraded: !!result._degraded,
        quality: quality.flags,
        memberId: parsed.state?.me?.id ?? null,
        anonId: parsed.state?.anon ?? null,
      }).then((askId) =>
        logUsage(env, {
          lane: result._brain === 'claude' ? 'big' : `fallback:${result._brain}`,
          // The MODEL, not the brain slot. `hosted` is a position in the
          // chain; `deepseek-v4-flash` is a thing with a price. Logging the
          // slot is why every fallback turn priced at zero.
          model: result._brain === 'claude'
            ? env.NUM_MODEL || DEFAULT_MODEL
            : result._model ?? result._brain,
          specialist: result._specialist ?? null,
          place: grounding.place?.name ?? null,
          usage: result._usage,
          ms: Date.now() - startedAt,
          memberId: parsed.state?.me?.id ?? null,
          askId,
        }),
      ),
    );
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
    const withServices = attachServiceOptions(env, withPhoto, grounding, {
      ctx,
      memberId: parsed.state?.me?.id ?? null,
    });
    // Internals never leave the Worker.
    const { _usage, _specialist, _brain, _tried, _ms, _degraded, ...clean } = withServices;
    void _usage;
    void _specialist;
    void _tried;
    void _ms;
    // `degraded` tells the app a fallback brain answered, so it can avoid
    // treating a prose reply as if it created bookings.
    // Pay for this answer once. cacheable() is strict — anything shaped by
    // who asked, or carrying an action, is never stored. A degraded reply is
    // never stored either: caching lean mode would outlive the outage that
    // caused it.
    if (!_degraded && cacheable({ userText: lastUser, profile, state: parsed.state ?? {}, reply: clean })) {
      ctx.waitUntil(writeCache(env, { userText: lastUser, place: grounding.place?.name ?? null, lang: acceptLang, reply: clean }));
    }
    // Durable memory: whatever `remember` actions this turn produced,
    // mirrored server-side (worker/memory.mjs) so they survive losing the
    // app — a reinstall, a new phone, a browser with cleared storage.
    // Fire-and-forget, like every other post-response write here: a fact
    // failing to save costs nothing this turn, only a possible re-ask
    // later, which is the status quo everywhere today.
    if (memberId) ctx.waitUntil(saveFacts(env, memberId, clean.actions));
    // The question itself, kept (scrubbed inside recordAsk). Until this
    // line, the text only survived when a partner impression fired — the
    // asks nobody could serve, the exact ones that write the roadmap, were
    // the ones being dropped.
    // (the ask was recorded above, with its cost joined by ask_id)
    return json(200, { ...clean, place: grounding.place ? grounding.place.name : null, ...(_degraded ? { degraded: true, brain: _brain } : {}) });
  } catch (err) {
    console.error('[num-ai]', err);
    // A ReferenceError or TypeError is OUR bug, not an outage. The two look
    // identical from here — both land in this catch and both get the polite
    // fallback — and that is exactly how `asked: userText` survived for days
    // looking like a quota problem while every brain was answering perfectly.
    //
    // The guest still gets the fallback; there is nothing better to give
    // them mid-request. But the log must not let a programming error wear an
    // outage's clothes, so it says so in terms no one can skim past.
    if (err instanceof ReferenceError || err instanceof TypeError || err instanceof SyntaxError) {
      console.error(
        `[num-ai] THIS IS A CODE BUG, NOT AN OUTAGE — ${err.name}: ${err.message}. ` +
        'The brains are probably fine. Fix the line in the stack above; do not go looking at quota.',
        err.stack,
      );
    }
    // A guest never hears "the kitchen is broken". If the big model failed
    // for any reason, try the cheap one — it cannot book anything, but it can
    // hold the conversation open, which is the whole job at this moment.
    try {
      const rescue = await smallReply(env, parsed.messages.slice(-4), parsed.state?.profile ?? {}, parsed.place ?? null);
      const guard = rescue ? guardReply(rescue) : { ok: false };
      if (guard.ok && !/\bHANDOFF\b/.test(guard.cleaned) && !soundsLikeASwitchboard(guard.cleaned)) {
        ctx.waitUntil(logUsage(env, { lane: 'rescue', model: 'workers-ai', place: parsed.place ?? null, usage: null, ms: null, memberId: parsed.state?.me?.id ?? null }));
        // `degraded: true` matters more here than anywhere else. This lane
        // only runs when the main path has already failed, and without the
        // flag its answer is indistinguishable from a healthy one. On
        // 6–7 Aug it returned "Kata Beach is a fave." with degraded absent,
        // which read as a working concierge having an off day — and sent two
        // days of debugging toward quota instead of toward the real bug.
        return json(200, { reply: guard.cleaned, card: null, chips: null, actions: [], place: parsed.place ?? null, degraded: true, brain: 'rescue' });
      }
    } catch (rescueErr) {
      console.warn('[num-ai] rescue lane also failed:', rescueErr?.message ?? rescueErr);
    }

    // Every brain is down. Before apologising, answer from what we already
    // have: grounding resolved their location and pulled real partners from
    // D1 before any model was called, and that data is still sitting here.
    // Three real places beats "say it again" — especially for somebody who
    // arrived from an ad thirty seconds ago and has no reason to come back.
    //
    // This makes no network call, so it cannot fail the way the models just
    // did. It never claims to have booked anything.
    if (err?.status !== 429) {
      try {
        const { lastResort } = await import('./lastresort.mjs');
        const saved = lastResort({
          userText: lastUser,
          grounding,
          place: parsed.place ?? null,
        });
        if (saved) {
          console.warn('[num-ai] answered from the directory with no model');
          return json(200, saved);
        }
      } catch (lastErr) {
        console.warn('[num-ai] last resort failed:', lastErr?.message ?? lastErr);
      }
    }

    // Nothing to offer — no partners resolved either. Own it, keep it warm,
    // and give them the one thing that actually helps rather than blaming
    // their connection, which is almost never the cause and always sounds
    // like it is their fault.
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
    //
    // json/setTravelContext come from jsonFactory(cors) — the same factory
    // handleNum() below builds its own copy from, so a synthetic call into
    // handleNum (concierge_answer, partnermcp.mjs) gets identical travel-speak
    // scrubbing, CORS and no-store behavior without duplicating this logic.
    const { json, setTravelContext } = jsonFactory(cors);

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
      // The MCP endpoints limit themselves, and must. Everything about the
      // blanket gate is wrong for JSON-RPC:
      //   • It throttles the HANDSHAKE. initialize and tools/list are POSTs, so
      //     an agent discovering the server competes with its own tool calls
      //     for the same twelve.
      //   • Its 429 body is `{"error": …}` with no `jsonrpc` and no `id`. An MCP
      //     client cannot correlate that to a pending request; a throttle
      //     therefore reads as a protocol fault, and the partner reports Num as
      //     broken rather than as busy.
      //   • It buckets a signed partner's production traffic — one server, one
      //     IP — with anonymous evaluation traffic.
      // partnermcp.mjs and conciergemcp.mjs apply the same limiter with the
      // scope each trust level deserves, and answer in JSON-RPC. Do NOT add a
      // route here without giving it a limiter of its own.
      const isSelfLimitedMcp = url.pathname === '/api/partner/mcp' || url.pathname === '/api/concierge/mcp';
      if (!isWebhook && !isSelfLimitedMcp) {
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
      const envelope = await trustEnvelope(env, { memberId: member });
      // The envelope is assembled from num_members and the 5arz ledger and has
      // never contained a passenger field. This asserts that rather than
      // assuming it: /api/trust hands a named member's data to a third party
      // holding a static shared secret, and it is the one route where a future
      // "while we're here, send the traveller details too" would look helpful.
      assertNoPassengerData(envelope, 'GET /api/trust');
      return json(200, envelope);
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
          // Duffel, reported as the two separate permissions it actually is.
          // `search` is whether a fare can be priced; `commit` is one of
          // 'no_token' | 'locked' | 'live' and is derived from the same gate
          // the code path uses, so it cannot claim a lock that is not there.
          // `estate` is read off the token prefix, so it cannot disagree with
          // the credential — a 'live' estate means real inventory.
          // This is additive: `booking` above is Sabre's flag and is untouched.
          duffel: duffelCapability(env),
          // The referral rail: whether the desk is switched on, and how many
          // agencies are configured to receive a handoff. Both matter and they
          // fail differently — a live switch with zero partners routes nothing,
          // and configured partners behind a dead switch send nothing.
          travel_referral: {
            enabled: env.TRAVEL_REFERRAL_ENABLED === 'true',
            // ACTIVE partners only. A configured-but-switched-off agency can
            // receive nothing, and a count that includes it reads as coverage
            // that does not exist.
            partners: travelPartners(env).filter((p) => p.active).length,
          },
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

    // The connector pipeline. Admin-only, because the pipeline names which
    // partners we have applied to and which we have written off — commercially
    // sensitive in a way the health endpoint is not.
    //
    // `live` here is derived from the same ADAPTERS.ready(env) the concierge
    // consults, so this endpoint cannot tell the operator a rail is connected
    // while Num is still handing it off. That is the whole point of it.
    if (url.pathname === '/api/connectors') {
      if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const { pipeline, actionable, gaps } = await import('./connectors.mjs');
      const { ADAPTERS } = await import('./services.mjs');
      return new Response(
        JSON.stringify(
          {
            live: pipeline(env, ADAPTERS).filter((c) => c.state === 'live').map((c) => c.id),
            next: actionable(env, ADAPTERS).map((c) => ({ id: c.id, state: c.state, power: c.power, do: c.next })),
            cannot_transact: gaps(env, ADAPTERS).map((g) => g.category),
            all: pipeline(env, ADAPTERS),
          },
          null,
          2,
        ),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } },
      );
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
        // Reddit goes STRAIGHT INTO THE APP, not to the film page.
        //
        // The first 300 clicks landed on /watch/, which is a good page and the
        // wrong one for this traffic: the ad creative already did the
        // persuading, and a second video before anyone can type is a stop.
        // Landing on the app root puts them in the thread they were sold, and
        // InstallPrompt (see src/components/app/InstallPrompt.tsx) offers
        // add-to-home-screen 1.2s in, with the right instructions per platform
        // and never when Num is already installed.
        // 2026-08-08, Dre's call: Reddit now lands on /install/, a funnel page
        // whose only job is add-to-home-screen. This is NOT a return to the old
        // mistake — the thing that lost 300 clicks was a second 30-second film
        // before anyone could act. /install/ has no video: the button is above
        // the fold, again in a sticky bar, and the platform-specific steps are
        // already open to the reader's own OS. If installs per click do not
        // beat the app-root baseline, put this back to '/?…' and say so here.
        rd: '/install/?utm_source=reddit&utm_medium=social&utm_campaign=global-pretrip-film1',
        dg: '/watch/?utm_source=google&utm_medium=demandgen&utm_campaign=global-pretrip-film1',
      };
      const to = GO[url.pathname.slice(4).replace(/\/$/, '')];
      // Unknown code → the watch page untagged, not a 404. A typo on a poster
      // should cost us attribution, never a visitor.
      return Response.redirect(new URL(to ?? '/watch/', url.origin).toString(), 302);
    }

    // These three must be tested BEFORE the `/api/book` prefix below, or that
    // prefix swallows them and bookdesk 404s on paths it has never heard of.
    // It did exactly that between being written and being caught, which is
    // the standing hazard of prefix routing: a new sibling route is dead on
    // arrival and nothing fails loudly enough to notice.
    //
    // `/api/booking` (Sabre air, sabre-booking.mjs) was the third victim and
    // went unnoticed longer than the other two, because it is a PREFIX rather
    // than an exact path and so did not look like a sibling. It is one: the
    // string '/api/booking/status' begins with the bookdesk prefix, so every
    // request to it reached bookdesk as the path 'ing/status' and came back
    // {"error":"not found"} with a 404. Its own block still stands further
    // down where the other /api/* prefixes live; this is the rescue, in the
    // same shape as the two above — longest prefix first.
    //
    // The rule, stated once so the next sibling is not born dead: any route
    // whose path begins with '/api/book' must be matched HERE, above the
    // bookdesk prefix. worker/bookdesk.wiring.test.mjs drives real requests at
    // all four and fails if one of them starts answering bookdesk's 404.
    if (url.pathname === '/api/book/link') return await handleBookLink(request, env);
    if (url.pathname === '/api/book/platforms') return handlePlatforms();
    if (url.pathname.startsWith('/api/booking')) {
      const res = await handleBooking(request, env, url.pathname.slice('/api/booking'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
    if (url.pathname.startsWith('/api/book')) {
      const { handleBooking } = await import('./bookdesk.mjs');
      const res = await handleBooking(request, env, url.pathname.slice('/api/book'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Travel referrals — Num hands a qualified request to an agency, the agency
    // quotes, takes the traveller's payment and issues the confirmation.
    // Deliberately NOT under /api/book (which is bookdesk's restaurant loop)
    // and NOT under /api/booking (which is Sabre air): three different
    // counterparties, three prefixes, no shadowing. `/api/trust` is an exact
    // match far above and shares no prefix with this one.
    //
    // Lazily imported for the same reason bookdesk is — it pulls in the mail
    // templates and the ledger, and a chat request should not pay for them.
    if (url.pathname.startsWith('/api/travel')) {
      const { handleTravelReferral } = await import('./travelreferral.mjs');
      const res = await handleTravelReferral(request, env, url.pathname.slice('/api/travel'.length) || '/', ctx);
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
    // The human surface, ABOVE the API routes because '/api/biz/console'
    // would otherwise be read as an API path and answered with a JSON 404 —
    // the same prefix-shadowing that cost bookdesk a working feature for days.
    if (url.pathname === '/api/biz/console') {
      const { handleBizConsole } = await import('./bizconsole.mjs');
      return await handleBizConsole(request, env, url);
    }
    if (url.pathname === '/api/biz' || url.pathname === '/api/biz/') return bizApiIndex();
    if (url.pathname === '/api/biz/mcp') return await handleBizMcp(request, env);
    if (url.pathname.startsWith('/api/biz/')) {
      return await handleBizApi(request, env, url.pathname.slice('/api/biz'.length));
    }

    // Num for Partners — the supply side of a distribution deal. Separate from
    // /api/biz (a business managing its OWN listing) because the trust level is
    // different: a partner reads the whole directory for their travellers and
    // writes nothing. See worker/partnermcp.mjs.
    // Open businesses. The two booking siblings (link, platforms) are routed
    // far earlier, above the /api/book prefix that would otherwise swallow
    // them.
    if (url.pathname === '/api/open') return await handleOpen(request, env);
    // Self-serve signup and usage BEFORE the /api/partner index and MCP
    // routes — same prefix-shadowing hazard as /api/book/link, avoided this
    // time instead of found in production.
    // The partner settlement feed. Above the /api/partner index below, and
    // above the MCP route, because both are prefix-adjacent and a settlement
    // posted to the wrong handler comes back as a JSON-RPC parse error rather
    // than as anything a finance team could act on.
    if (url.pathname === '/api/partner/reconcile') {
      const { handleReconcile } = await import('./handoff.mjs');
      const res = await handleReconcile(request, env);
      return res;
    }
    if (url.pathname === '/api/partner/signup' || url.pathname === '/api/partner/usage') {
      const { handlePartnerSignup } = await import('./partnersignup.mjs');
      return await handlePartnerSignup(request, env);
    }
    if (url.pathname === '/api/partner' || url.pathname === '/api/partner/') return partnerIndex();
    if (url.pathname === '/api/partner/mcp') return await handlePartnerMcp(request, env, ctx);

    // Num Concierge — the third trust level. /api/biz writes a business's own
    // listing, /api/partner reads the directory for a partner's travellers,
    // and this one can make a real venue's phone ring. Separate route because
    // it is the only one of the three with no anonymous path.
    // See worker/conciergemcp.mjs for why request_table is not a partner tool.
    if (url.pathname === '/api/concierge' || url.pathname === '/api/concierge/') return conciergeIndex(env);
    if (url.pathname === '/api/concierge/mcp') return await handleConciergeMcp(request, env);

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

    // /api/booking (Sabre air) is routed ABOVE the /api/book prefix — see the
    // comment there. Leaving a second copy here would look like the live one
    // and never run.

    if (url.pathname.startsWith('/api/sabre')) {
      const res = await handleSabre(request, env, url.pathname.slice('/api/sabre'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Duffel — SEARCH ONLY, and by construction rather than by convention.
    //
    // It sits beside /api/sabre because it answers the same question, and it
    // routes to handleDuffelSearch rather than handleDuffel because the
    // difference between those two names is the difference between quoting a
    // fare and spending somebody's money. handleDuffelSearch serves three
    // read-only paths and 404s the rest, so POST /api/duffel/order never
    // reaches createOrder — and if this line were ever changed to point at
    // handleDuffel, `permitted` would still refuse the commit. Both halves are
    // driven through this router in worker/duffel.test.mjs.
    //
    // Prefix safety, per the /api/book lesson above: no other registered
    // prefix is a prefix of '/api/duffel' and '/api/duffel' is a prefix of no
    // other, so this cannot be shadowed and cannot shadow.
    if (url.pathname.startsWith('/api/duffel')) {
      const res = await handleDuffelSearch(request, env, url.pathname.slice('/api/duffel'.length) || '/');
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Passenger records — the identity data an airline requires and Num had
    // never held. Its own prefix, its own module, its own schema file, because
    // it is the most sensitive table in num-db and it should be obvious in a
    // router which requests can touch it. Members-only: the handler resolves
    // `me` against num_members and scopes every read and write to the owner.
    //
    // Nothing here is reachable from the concierge or from a model. It is a
    // form the traveller fills in, and worker/redact.mjs keeps its fields out
    // of any prompt if one ever finds its way into `state`.
    if (url.pathname.startsWith('/api/passengers')) {
      const res = await handlePassengersSafe(request, env, url.pathname.slice('/api/passengers'.length) || '/');
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

    // The route-table probe (worker/routetable.test.mjs) reads this exact
    // guard, at this exact indentation, to find /api/num — it is written as a
    // negation (a fall-through 404) rather than a positive match, which is the
    // one dispatch shape the router's positive-match reader cannot see on its
    // own. handleNum() carries the identical check too, since it is also
    // reachable directly (concierge_answer, worker/partnermcp.mjs) with a
    // synthetic Request that never passed through this dispatcher at all.
    if (request.method !== 'POST' || url.pathname !== '/api/num') {
      return new Response('not found', { status: 404 });
    }
    return await handleNum(request, env, ctx);
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
    // Self-submitted businesses, turned into coordinates. Migration 0007 was
    // written for this step and nothing ever performed it, so every submission
    // has sat at `new` with null lat/lng — and `places.lat` is NOT NULL, so
    // none of them could ever be promoted. The table was a waiting room with
    // no door. Ten per tick, and a row it cannot place confidently stays put
    // with a note rather than getting a guessed pin.
    ctx.waitUntil(
      import('./geocode.mjs')
        .then((m) => m.geocodeSweep(env))
        .then((r) => { if (r?.geocoded) console.log(`[geocode] ${r.geocoded}/${r.seen} placed`); })
        .catch((e) => console.error('[geocode]', e?.message ?? e)),
    );
    // Every signup gets researched — dossier with its own data and promo
    // options, three per tick so a backlog clears in minutes, not budgets.
    ctx.waitUntil(
      import('./bizdossier.mjs')
        .then((m) => m.dossierSweep(env))
        .catch((e) => console.error('[dossier]', e?.message ?? e)),
    );
    // Fold what guests said after they went back into what the next guest is
    // shown. Hourly, not every five minutes: this cron fires twelve times an
    // hour and the number it recomputes changes a few times a day, so eleven
    // of those passes would be a write over 2.5M-row table for nothing. See
    // worker/learn.mjs — this is the only closed loop NUM has.
    if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() < 5) {
      ctx.waitUntil(
        import('./learn.mjs')
          .then((m) => m.rollupRatings(env))
          .then((r) => { if (r?.places) console.log('[learn]', JSON.stringify(r)); })
          .catch((e) => console.error('[learn]', e?.message ?? e)),
      );
    }
  },
};
