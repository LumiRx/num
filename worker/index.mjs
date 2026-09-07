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
import { resolvePicks } from './placelink.mjs';
import { redactProfile, redactState } from './redact.mjs';
import { readCache, writeCache, cacheable } from './answercache.mjs';
// Gate zero: the lookups that need no model at all. See knownanswer.mjs.
import { knownAnswer } from './knownanswer.mjs';
import { recordAsk, scrubAsk } from './asks.mjs';
import { keepRouting, fallbackRouting, laneLabel } from './routinglabel.mjs';
import { publicNumber as whatsAppNumber } from './whatsapp.mjs';
import { corsHeaders, enforceRateLimit, validatePayload, LIMITS } from './guard.mjs';
import { groundRequest } from './grounding.mjs';
// How Num suggests a place — one house style, read on every turn.
import { SUGGESTION_STYLE } from './suggestionstyle.mjs';
import { formatEvents } from './cityevents.mjs';
import { formatSearchedEvents } from './eventsearch.mjs';
import { loadFacts, saveFacts } from './memory.mjs';
import { loadTurns, saveTurn, mergeHistory, subjectFor } from './turns.mjs';
// The member's VIP host, if they have one — looked up beside grounding, told
// to the brain, and the `ask_host` action relayed into the host's console.
// See worker/hostaware.mjs for why this bridge did not exist before 4 Sep.
import { hostFor, hostBlock, relayToHost } from './hostaware.mjs';
// Partners that DELIVER to where the guest is, offered to the brain as a
// DELIVERY PARTNERS block, and the `request_delivery` action turned into a
// real order server-side. In-app, never SMS — worker/delivery.mjs says why.
import { partnersNear, allowedFor, deliveryBlock, createOrder } from './delivery.mjs';
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
import { servicesBlock, optionsFor, canIssueFlight } from './services.mjs';
import { blockFor as viatorBlock } from './viator.mjs';
import { carLink, carBlock } from './localrent.mjs';
import { blockFor as eventsBlockFor } from './events.tm.mjs';
import { luggageLink, luggageBlock, wantsLuggage } from './luggage.mjs';
import {
  flightLink, stayLink, flightBlock, stayBlock, wantsFlight, wantsStay, openReferral, lgtReady,
} from './letsgo2trip.mjs';
import { policyFor, policyBrief, screen as screenReply, substituteFor } from './geopolicy.mjs';
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

async function askNum(client, messages, state, grounding, profile, extraSystem, env, userText, acceptLang, modelOverride = null) {
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
    // The house style rides with the persona and shares its cache block: it is
    // the same on every turn for every guest, so it costs nothing after the
    // first call, and putting it anywhere else would mean some turns get it
    // and some do not — which is exactly the inconsistency it exists to fix.
    { type: 'text', text: PERSONA + '\n\n' + VOICE + '\n\n' + SUGGESTION_STYLE, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: contextBlock({
        place: grounding.place,
        partners: grounding.partners,
        guide: grounding.guide,
        showtimes: grounding.showtimes ?? null,
        events: [formatEvents(grounding.events ?? []), formatSearchedEvents(grounding.searchedEvents)].filter(Boolean).join('\n\n'),
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
  // Where the traveller is standing changes what may be said. Pushed near the
  // end so it sits AFTER the specialist brief that might otherwise cheerfully
  // recommend a bar, and screened again after generation — a prompt is a
  // request, the screen is the gate.
  const geo = policyBrief(policyFor(grounding?.place?.country_code));
  if (geo) system.push({ type: 'text', text: geo });
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
  // LetsGo2Trip — THE FALLBACK, and only ever the fallback.
  //
  // It is the only rail that can actually ISSUE a ticket, which sabre_air and
  // duffel cannot. It is also the only rail that sends a traveller out of the
  // app to a checkout that charges them a fee, so it must never fire while Num
  // could have finished the job itself. `canIssueFlight` is services.mjs's
  // single definition of that, shared rather than re-derived: the day Sabre
  // booking is switched on, this rail goes quiet on its own and nobody has to
  // remember to turn it off.
  //
  // The referral row is AWAITED rather than fired off. askNum has no
  // execution context, and an un-awaited promise after the response returns
  // is cancelled by the runtime — the row would silently never land, and
  // this row is the only independent record that Num sent anybody. It is one
  // INSERT and it never throws; a bookkeeping failure costs a row, never a
  // reply and never the link.
  if (lgtReady(env ?? {}) && !canIssueFlight(env ?? {})) {
    const memberId = state?.memberId ?? state?.member_id ?? null;
    if (wantsFlight(userText ?? '')) {
      const f = flightLink(env, {});
      if (f) {
        system.push({ type: 'text', text: flightBlock(f, env, {}) });
        await openReferral(env, { ref: f.ref, memberId, product: 'flight' });
      }
    } else if (wantsStay(userText ?? '')) {
      // `else if` on purpose: a turn that asks for both gets the flight, which
      // is the one with a deadline. Two booking links and two fee disclosures
      // in one reply is not a concierge, it is a banner.
      const s = stayLink(env, grounding.place);
      if (s) {
        system.push({ type: 'text', text: stayBlock(s, env, grounding.place) });
        await openReferral(env, {
          ref: s.ref, memberId, product: 'stay', destination: grounding.place?.name ?? null,
        });
      }
    }
  }
  // An open flight booking, if there is one.
  //
  // Gated on `canIssueFlight` — the same single definition the LetsGo2Trip
  // fallback uses. Today that is false everywhere, so this is inert: no
  // issuer is configured, and collecting a passport number for a ticket Num
  // cannot issue would be asking for something we have no use for.
  //
  // The day an issuer is switched on, this connects on its own. That is also
  // the day the seller-of-travel registration has to be in hand — /api/pay/status
  // flips its published claim at the same moment, from the same function.
  if (canIssueFlight(env ?? {}) && state?.flightBooking) {
    const { bookingBlock } = await import('./flightbooking.mjs');
    const { payBlock } = await import('./flightpay.mjs');
    const b = state.flightBooking;
    const open = bookingBlock(b);
    if (open) system.push({ type: 'text', text: open });
    // The money is read back only once everything is collected — quoting a
    // total while three passport numbers are still missing invites them to
    // agree to a number that is not yet the number.
    const { readyToIssue } = await import('./flightbooking.mjs');
    if (readyToIssue(b).ok) {
      const pay = payBlock(b, env ?? {});
      if (pay) system.push({ type: 'text', text: pay });
    }
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
  //
  // `modelOverride` is the director's per-tier choice, arriving via the brain
  // chain (brains.ask → structuredCall). It wins when present because it was
  // decided with the tier in hand; pickModel remains the answer for every
  // caller that does not route through the director.
  const model = modelOverride || pickModel(userText, state, env ?? {});
  // WHICH MODEL ACTUALLY ANSWERED, not which one we intended to call.
  // The garbled-reply path below escalates to the strong model, and the
  // caller prices the turn from this field — so it has to follow the
  // escalation or an Opus rescue bills as a Haiku answer.
  let usedModel = model;
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
    return { reply: 'I can’t help with that one — anything else on the trip?', card: null, chips: null, actions: [], _usage: response.usage, _specialist: specialist, _model: usedModel };
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
    usedModel = env?.NUM_MODEL_STRONG || 'claude-opus-5';
    response = await call(4096, env?.NUM_MODEL_STRONG || 'claude-opus-5');
    if (response.stop_reason !== 'refusal') {
      text = response.content.find((b) => b.type === 'text')?.text ?? '';
      parsed = parseStructured(text);
    }
    if (!parsed || !guardReply(parsed.reply).ok) {
      console.error('[num-ai] retry ALSO garbled — clean miss beats a leak');
      return { reply: 'I lost my thread for a second — ask me that once more?', card: null, chips: null, actions: [], _usage: response.usage, _specialist: specialist, _model: usedModel };
    }
  }
  // ── THE LAST GATE ──────────────────────────────────────────────────────
  //
  // The system prompt is where the model is TOLD what it may say; this is
  // where we find out whether it listened. In the Gulf that difference is not
  // stylistic: naming a bar in Riyadh or surfacing an LGBTQ venue in either
  // country is a criminal offence under the Saudi Anti-Cyber Crime Law and
  // UAE Federal Decree-Law 34/2021, and the exposure lands on Num.
  //
  // The substitution is deliberate rather than a bare refusal. Somebody asked
  // a real question; they get the true reason and somewhere else to go.
  const reply = normalizeReply(parsed);
  const policy = policyFor(grounding?.place?.country_code);
  if (policy) {
    const verdict = screenReply(reply.reply, policy);
    if (!verdict.ok) {
      console.log(`[geopolicy] ${policy.country}/${verdict.rule} caught after generation: ${verdict.sentence}`);
      return {
        ...reply,
        reply: substituteFor(verdict.rule),
        // The card and actions came from the same turn that produced the
        // blocked line, so they are not to be trusted either.
        card: null, actions: [],
        _usage: response.usage, _specialist: specialist, _blocked: verdict.rule, _model: usedModel,
      };
    }
  }

  // usage rides back with the reply so the caller can bill it to a day. Real
  // counts, not an estimate — this is what the admin dashboard reports.
  return { ...reply, _usage: response.usage, _specialist: specialist, _model: usedModel };
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
        // scrubAsk, as num_asks does: row 5 of this table held a raw phone
        // number for a month because this path skipped the redaction.
        ins.bind(new Date().toISOString(), place ?? null, scrubAsk(userAsk ?? '').slice(0, 500), f.summary.slice(0, 500), f.suggestion.slice(0, 800)),
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
    // The thread, server-side (worker/turns.mjs). Loaded in the same
    // Promise.all as facts, so continuity across devices costs no latency.
    const turnSubject = subjectFor({ memberId, anonId: parsed.state?.anon ?? null });
    const [groundResult, rememberedFacts, storedTurns, memberHost] = await Promise.all([
      groundRequest(env, {
        userText: lastUser,
        statedPlace: parsed.place,
        cf: request.cf,
        fix: parsed.here && Number.isFinite(parsed.here.lat) && Number.isFinite(parsed.here.lng)
          ? { lat: parsed.here.lat, lng: parsed.here.lng }
          : null,
      }),
      memberId ? loadFacts(env, memberId).catch(() => ({})) : Promise.resolve({}),
      turnSubject ? loadTurns(env, turnSubject).catch(() => []) : Promise.resolve([]),
      // Who looks after this person, if anyone. Null for the nine in ten asks
      // with no member id, and for every member without a host.
      memberId ? hostFor(env, memberId).catch(() => null) : Promise.resolve(null),
    ]);
    grounding = groundResult;

    // Who delivers to where this guest is (worker/delivery.mjs). Members only:
    // an order needs a member to belong to, so an anonymous guest is never
    // read a menu that ends nowhere. A hosted member is never offered one —
    // their host arranges it — and an age-gated partner reaches only a member
    // whose identity Num has verified. Empty for nearly everyone.
    let deliveryPartners = [];
    if (memberId && env?.DB && grounding?.place?.lat != null && grounding?.place?.lng != null) {
      try {
        const near = await partnersNear(env, { lat: grounding.place.lat, lng: grounding.place.lng, dest: grounding.place.slug });
        if (near.length) {
          const member = near.some((p) => p.age_min)
            ? await env.DB.prepare('SELECT identity_verified FROM num_members WHERE id=?1').bind(memberId).first().catch(() => null)
            : null;
          deliveryPartners = allowedFor(near, { member, hasHost: !!memberHost });
        }
      } catch (e) { console.warn('[delivery] near', e?.message ?? e); }
    }

    // The browser's own preference, as a tiebreaker only. What the person
    // actually TYPED wins every time — somebody with an English phone asking
    // in Thai wants Thai back — but on a first message of two words there is
    // nothing else to go on.
    const acceptLang = String(request.headers.get('Accept-Language') ?? '').split(',')[0].trim().slice(0, 12) || null;

    // Profile + trip state carry long-term context now, so the model only
    // needs the recent turns.
    //
    // The client's thread wins; what it lacks — a fresh device, a cleared
    // browser — is filled from the server copy, never the other way round.
    const history = mergeHistory(parsed.messages.slice(-14), storedTurns);
    // Server memory (worker/memory.mjs) is the FLOOR, never the ceiling: a
    // durable fact survives losing the app, but a correction the guest
    // just made THIS session — still only living in state.profile until
    // the next remember action lands it server-side — always wins.
    const stated = { ...rememberedFacts, ...(parsed.state?.profile ?? {}) };
    // THE SOULPROFILE — what we have noticed often enough to trust, under
    // everything the guest actually said.
    //
    // Keyed on member OR device, because 370 of 412 asks have no member id: a
    // member-keyed profile would be a feature for 10% of traffic that looks
    // broken to everyone else, and would learn nothing during the first
    // conversation, which is the one where somebody decides if Num is any
    // good. Stated facts are spread on top, so an observation can never argue
    // with something the guest told us. See worker/soulprofile.mjs.
    const anonId = parsed.state?.anon ?? null;
    const soul = await (async () => {
      try {
        const { profileFor } = await import('./soulprofile.mjs');
        return await profileFor(env, { stated, memberId, anonId });
      } catch { return stated; }
    })();
    const profile = soul;

    // Small lane: chit-chat goes to Workers AI, no Claude call at all. Any
    // wobble — HANDOFF, null, or a guard failure — falls through to the big
    // lane rather than to a worse answer.
    // An answer we already paid for. Costs one D1 read and zero tokens, and
    // returns in milliseconds — so it runs before the lane is even chosen.
    // cacheable() gates the WRITE strictly; this read is keyed on the same
    // rules, so a personal question can never match a shared entry.
    // Where the asker is, to ~1 km, so "near me" answers are shared only
    // among people standing in the same place (answercache.mjs).
    const cachePos = grounding.place?.lat != null ? { lat: grounding.place.lat, lng: grounding.place.lng } : null;

    // ── GATE ZERO: the answer is already in our hand ──────────────────────
    //
    // "What time does it open." "What's the address." The verified row that
    // built the partner block above holds the answer, and sending 4,000
    // tokens to a language model so it can read one field out of a block we
    // just constructed is a lookup with a surcharge.
    //
    // Zero tokens, milliseconds, and it cannot be wrong because it does not
    // generate — there is no temperature on a database field. It fires only
    // when exactly ONE verified place is in play and the field is actually
    // populated; anything else falls through to a brain, which is the right
    // way round. See worker/knownanswer.mjs for the three rules.
    //
    // Runs before the cache read because it is cheaper still: the cache costs
    // a D1 round trip, this costs nothing at all.
    {
      const prevAssistant = [...history].reverse().find((m) => m?.role === 'assistant')?.content ?? '';
      const known = knownAnswer({
        text: lastUser,
        prevAssistant: typeof prevAssistant === 'string' ? prevAssistant : '',
        partners: grounding?.partners ?? [],
        tz: grounding?.place?.tz ?? null,
      });
      if (known) {
        // The place still goes through resolvePicks and enrichPicks, so the
        // guest gets the identical card — link, map, tappable call button,
        // opening state — that a model answer would have produced. They
        // cannot tell this one was free, which is the point.
        const resolved = resolvePicks([known.pick], grounding?.partners ?? []);
        const { enrichPicks } = await import('./pickdetail.mjs');
        const picks = enrichPicks(resolved.picks, grounding?.partners ?? [], grounding?.place?.tz, new Date(), grounding?.place?.country ?? null);
        console.log(`[num-ai] answered from the row (${known.fact}), no model called`);
        ctx.waitUntil(recordAsk(env, { text: lastUser, dest: grounding.place?.slug ?? null, lane: `known:${known.fact}`, cached: true, memberId: parsed.state?.me?.id ?? null }));
        if (turnSubject) ctx.waitUntil(saveTurn(env, turnSubject, lastUser, known.reply));
        return json(200, { reply: known.reply, card: null, chips: null, actions: [], picks, place: grounding.place?.name ?? null });
      }
    }

    if (cacheable({ userText: lastUser, profile, state: parsed.state ?? {}, reply: {}, pos: cachePos })) {
      const hit = await readCache(env, { userText: lastUser, place: grounding.place?.name ?? null, lang: acceptLang, pos: cachePos });
      if (hit) {
        console.log('[num-ai] served from cache, no model called');
        ctx.waitUntil(recordAsk(env, { text: lastUser, dest: grounding.place?.slug ?? null, lane: 'cache', cached: true, memberId: parsed.state?.me?.id ?? null }));
        // A cached answer is still a turn the person saw; the thread keeps it.
        if (turnSubject) ctx.waitUntil(saveTurn(env, turnSubject, lastUser, typeof hit.reply === 'string' ? hit.reply : ''));
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

    // THE ONE QUESTION NUM MAY EARN THIS TURN.
    //
    // Picked here, deterministically, rather than left to the model. A model
    // told "ask when it would help" asks constantly; a guest being interviewed
    // is a guest filling in a form, and people leave forms. The picker returns
    // null far more often than it returns a question — it refuses when the
    // topic is unclear, when the answer is already known, and when Num has
    // already put that question in this conversation. See soulprofile.mjs.
    let earnedBlock = null;
    try {
      const { nextQuestion, questionBlock, topicOf, askedAlready } = await import('./soulprofile.mjs');
      earnedBlock = questionBlock(nextQuestion(profile, {
        topic: topicOf(lastUser),
        asked: askedAlready(history),
      }));
    } catch { /* a question is a bonus; the answer is the job */ }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const callNum = async (extraSystem, modelOverride = null) => {
      // The earned question rides along unless a caller has its own system
      // note (a quality retry), in which case fixing the answer outranks
      // learning something new.
      extraSystem = extraSystem ?? earnedBlock;
      // The host rides on every call, retries included: a corrected answer
      // that forgets the guest has a host is a second wrong answer.
      const hostNote = hostBlock(memberHost);
      if (hostNote) extraSystem = [hostNote, extraSystem].filter(Boolean).join('\n\n');
      // Same for who delivers here: the prices the guest was read must be the
      // prices the retry reads too.
      const deliveryNote = deliveryBlock(deliveryPartners);
      if (deliveryNote) extraSystem = [deliveryNote, extraSystem].filter(Boolean).join('\n\n');
      try {
        return await askNum(client, history, parsed.state, grounding, profile, extraSystem, env, lastUser, acceptLang, modelOverride);
      } catch (err) {
        // Grammar compilation is cached once it succeeds but can time out on a
        // cold schema — one retry usually lands on the warmed cache.
        if (!/grammar compilation/i.test(err?.message ?? '')) throw err;
        await new Promise((r) => setTimeout(r, 1500));
        return askNum(client, history, parsed.state, grounding, profile, extraSystem, env, lastUser, acceptLang, modelOverride);
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
      events: [formatEvents(grounding.events ?? []), formatSearchedEvents(grounding.searchedEvents)].filter(Boolean).join('\n\n'),
    });
    const startedAt = Date.now();
    // Hoisted: the directive decides who answers AND is the honest label for
    // what this turn was. Computing it inline meant the tier existed for one
    // expression and was never written down — see the lane/category note
    // below.
    // The PREVIOUS user message rides along so the classifier can tell a
    // continuation from a question. "Yes" on its own carries no signal and was
    // being escalated to the frontier model; "yes" after "shall I book it?"
    // inherits critical, and "yes" after "want three more?" inherits the bulk
    // lane. See director.isContinuation.
    const prevUser = [...history].reverse().find((m) => m?.role === 'user' && m.content !== lastUser)?.content ?? null;
    const directive = direct(lastUser, { ...(parsed.state ?? {}), prevUser: typeof prevUser === 'string' ? prevUser : null }, env);
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
      directive,
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
    // Who answered, kept honest across the two corrective retries below.
    // Both call the structured Claude path directly, bypassing the brain
    // chain, so a bare spread erased `_brain`/`_tried`/`_degraded` and filed
    // a healthy answer as lane `<tier>:none`. See worker/routinglabel.mjs.
    const guard = guardReply(result.reply);
    if (guard.ok) {
      result = { ...result, reply: guard.cleaned };
    } else {
      const retry = await callNum(
        'Your previous output leaked JSON structure into the reply field. The reply field must contain ONLY clean conversational prose.',
      );
      const retryGuard = guardReply(retry.reply);
      if (retryGuard.ok) {
        result = keepRouting({ ...retry, reply: retryGuard.cleaned }, result);
      } else {
        const cleaned = retryGuard.cleaned ?? guard.cleaned;
        result = cleaned
          ? keepRouting({ ...retry, reply: cleaned }, result)
          // NOT keepRouting: no brain produced this line. The hard-coded
          // fallback is the one case where lane `:none` is the truth and
          // the probe SHOULD page — so it is labelled as what it is.
          : fallbackRouting(FALLBACK_REPLY, result);
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
    // ── ATTACH THE VERIFIED LINKS, BEFORE ANYTHING IS GRADED ────────────
    //
    // The model named places; this turns each into a card the guest can tap,
    // using the row the grounding step actually read. A pick that matches no
    // verified row is dropped here rather than shown as a name with no way to
    // reach it. Runs BEFORE inspect() on purpose: the grader must judge the
    // message that will actually be sent, links and all.
    {
      const resolved = resolvePicks(result.picks, grounding?.partners ?? []);
      // Then the details a concierge actually says — "4 min walk", "open,
      // closes 23:00 (40 min)", the local-script name, the rating with the
      // count that earned it. All from the row, none invented, and absent
      // where the row is silent. See worker/pickdetail.mjs.
      const { enrichPicks } = await import('./pickdetail.mjs');
      // WHAT EACH OF THESE PLACES OFFERS, WHERE THE BUSINESS HAS TOLD US.
      //
      // One indexed read across every row already in hand, attached before
      // enrichment so pickdetail stays pure. Capped per place inside
      // bizoffer.forPlaces — a concierge reciting a 200-line menu is worse
      // than one that says nothing. Best-effort: a business with nothing
      // listed, or a read that fails, simply produces the answer NUM gave
      // before this existed.
      // Attached to the grounding rows in place, so the enrichPicks call below
      // stays byte-for-byte what pickdetail.test.mjs pins — that test is the
      // guard on both the first-answer and the quality-retry path, and it is
      // worth more than a local variable.
      try {
        const { forPlaces } = await import('./bizoffer.mjs');
        const rows = grounding?.partners ?? [];
        const byPlace = await forPlaces(env, rows.map((r) => r?.id).filter(Boolean));
        if (byPlace.size) {
          for (const r of rows) {
            const offers = r?.id != null ? byPlace.get(String(r.id)) : null;
            if (offers?.length) r.offerings = offers;
          }
        }
      } catch (e) { console.warn('[bizoffer]', e?.message ?? e); }
      result = { ...result, picks: enrichPicks(resolved.picks, grounding?.partners ?? [], grounding?.place?.tz, new Date(), grounding?.place?.country ?? null) };
      // A FIRST ANSWER WITH PLACES ALWAYS OFFERS A NEXT TAP.
      //
      // The bulk lane (Haiku) reliably returns picks and reliably returns no
      // chips — measured live 3 Sep 2026: three places, zero chips. `null`
      // means "keep the current chips", which is right mid-conversation and
      // empty on the first turn, so a guest's very first answer ended in a
      // bare text box. Only the first turn is filled, and only from what the
      // picks can actually do; later turns keep the model's contract.
      const firstTurn = !history.some((m) => m?.role === 'assistant');
      if (firstTurn && !(result.chips?.length) && result.picks?.length) {
        const anyBookable = result.picks.some((pk) => pk?.bookable);
        result = {
          ...result,
          chips: [
            anyBookable ? { id: 'book', label: 'Book a table' } : { id: 'directions', label: 'Get directions' },
            { id: 'nearby', label: 'Something else nearby' },
            { id: 'later', label: 'Save these for later' },
          ],
        };
      }
      if (resolved.dropped.length) {
        console.warn(`[num-ai] dropped ${resolved.dropped.length} unverifiable pick(s): ${resolved.dropped.join(', ')}`);
      }
    }

    let quality = inspect({ ask: lastUser, reply: result.reply, picks: result.picks, context: groundingBlock });
    if (quality.hard) {
      try {
        const fixed = await callNum(quality.note);
        const fixedGuard = guardReply(fixed.reply);
        if (fixedGuard.ok) {
          const reFixedRaw = resolvePicks(fixed.picks, grounding?.partners ?? []);
          const { enrichPicks: enrichAgain } = await import('./pickdetail.mjs');
          const reFixed = { ...reFixedRaw, picks: enrichAgain(reFixedRaw.picks, grounding?.partners ?? [], grounding?.place?.tz, new Date(), grounding?.place?.country ?? null) };
          const after = inspect({ ask: lastUser, reply: fixedGuard.cleaned, picks: reFixed.picks, context: groundingBlock });
          // Take the retry only if it is genuinely better. A retry that
          // trades an invented price for an off-topic answer is not a fix.
          if (!after.hard) {
            result = keepRouting({ ...fixed, reply: fixedGuard.cleaned, picks: reFixed.picks }, result);
            // WHY it was retried travels with the row. Until 3 Sep 2026 the
            // second grade replaced the first, so 60% of bulk-lane turns read
            // "retried" with no trace of the hard flag that earned it — the
            // one fact that tells you whether the cheap model or the grader
            // is the thing to fix.
            quality = { ...after, flags: [...after.flags, 'retried', ...quality.flags.filter((f) => !after.flags.includes(f)).map((f) => `was:${f}`)] };
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
    // WHAT THE LANE COLUMN USED TO SAY, AND WHY IT WAS USELESS.
    //
    // This was the literal string 'big' on every turn, so all 383 asks ever
    // recorded claimed the expensive lane — including every one the director
    // had actually sent to a cheap brain. The column that exists to answer
    // "is the router saving us anything" could only ever answer "no", and it
    // would have said that just as loudly on the day the router worked
    // perfectly. Recording the tier the director actually chose is what makes
    // every routing change after this one measurable.
    const answeredLane = laneLabel(directive, result);
    if (!isProbe) ctx.waitUntil(
      recordAsk(env, {
        text: lastUser,
        // The demand class, finally written down. `category` has been NULL on
        // every row since the table was created, which is why no question has
        // ever been gradeable BY KIND — we could see that an answer was
        // off-topic but never that recommendations specifically were.
        category: directive.tier,
        dest: grounding.place?.slug ?? null,
        lane: answeredLane,
        brain: result._brain ?? null,
        degraded: !!result._degraded,
        quality: quality.flags,
        memberId: parsed.state?.me?.id ?? null,
        anonId: parsed.state?.anon ?? null,
      }).then((askId) =>
        logUsage(env, {
          lane: answeredLane,
          // The MODEL, not the brain slot. `hosted` is a position in the
          // chain; `deepseek-v4-flash` is a thing with a price. Logging the
          // slot is why every fallback turn priced at zero.
          // The MODEL, not the brain slot. Both Anthropic brains now carry
          // `_model` from the directive, so a Haiku turn prices as Haiku
          // rather than inheriting Opus's rate and overstating the bill.
          model: result._model
            ?? (result._brain === 'claude' ? env.NUM_MODEL || DEFAULT_MODEL : result._brain),
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
    //
    // Written as "drop every underscore-prefixed key", not a named list, since
    // 7 Sep 2026: the list was the bug. `_model` was added to every brain's
    // return on 30 Aug so a Haiku turn could be priced as Haiku, and nothing
    // added it here — so it shipped to every guest for a week, alongside
    // `_blocked`, which names the moderation rule a reply tripped. Found by
    // reading a live /api/num response during a status check, not by a test.
    // A convention the compiler cannot forget beats a list someone must
    // remember to update.
    // `_brain` is re-published deliberately below as `brain` on a degraded
    // reply, so the app can say which fallback answered — keep the handle.
    const { _degraded, _brain } = withServices;
    const clean = Object.fromEntries(Object.entries(withServices).filter(([k]) => !k.startsWith('_')));
    // `degraded` tells the app a fallback brain answered, so it can avoid
    // treating a prose reply as if it created bookings.
    // Pay for this answer once. cacheable() is strict — anything shaped by
    // who asked, or carrying an action, is never stored. A degraded reply is
    // never stored either: caching lean mode would outlive the outage that
    // caused it.
    if (!_degraded && cacheable({ userText: lastUser, profile, state: parsed.state ?? {}, reply: clean, pos: cachePos })) {
      ctx.waitUntil(writeCache(env, { userText: lastUser, place: grounding.place?.name ?? null, lang: acceptLang, reply: clean, pos: cachePos }));
    }
    // Durable memory: whatever `remember` actions this turn produced,
    // mirrored server-side (worker/memory.mjs) so they survive losing the
    // app — a reinstall, a new phone, a browser with cleared storage.
    // Fire-and-forget, like every other post-response write here: a fact
    // failing to save costs nothing this turn, only a possible re-ask
    // later, which is the status quo everywhere today.
    if (memberId) ctx.waitUntil(saveFacts(env, memberId, clean.actions));
    // The guest said "send it to my host": their words become a NEW request in
    // the host's console. Executed here, not in the app — the app sends
    // nothing — and only for a member whose host we established above.
    if (memberId && memberHost) {
      ctx.waitUntil(relayToHost(env, { memberId, host: memberHost, actions: clean.actions, userText: lastUser })
        .then((r) => { if (r.relayed) console.log(`[hostaware] ${r.relayed} request(s) relayed to ${memberHost.hostName}`); })
        .catch((e) => console.warn('[hostaware] relay', e?.message ?? e)));
    }
    // The guest said yes to a delivery read-back: the order is created HERE,
    // never by the app, and only for a partner this very call offered — an
    // invented business_id, or one from a block the guest never saw, creates
    // nothing. delivery.mjs prices it from the partner's own list, tells the
    // guest it is pending, and emails the partner.
    if (memberId && deliveryPartners.length) {
      const offered = new Set(deliveryPartners.map((p) => p.business_id));
      for (const a of clean.actions ?? []) {
        if (a?.type !== 'request_delivery' || !a.order?.confirmed || !offered.has(a.order.business_id)) continue;
        ctx.waitUntil(createOrder(env, { businessId: a.order.business_id, memberId, items: a.order.items, address: a.order.address, note: a.order.note, channel: 'agent' })
          .then((r) => console.log(r.ok ? `[delivery] order ${r.short_code} pending at ${r.partner}` : `[delivery] refused: ${r.error}`))
          .catch((e) => console.warn('[delivery] order', e?.message ?? e)));
      }
    }
    // The exchange itself, so the next device picks up mid-thought. Degraded
    // replies are stored too: the person saw them, so the thread has them.
    if (turnSubject) ctx.waitUntil(saveTurn(env, turnSubject, lastUser, typeof clean.reply === 'string' ? clean.reply : ''));
    // The same remember actions, read a second way. memory.mjs keeps them as
    // authoritative "never re-ask this" facts; soulprofile keeps the taste
    // dimensions with a confidence count, so a one-off mention does not
    // become a permanent belief. It also runs for guests with no member id,
    // which is almost all of them.
    {
      const subj = memberId ?? (parsed.state?.anon ? `anon:${parsed.state.anon}` : null);
      if (subj) {
        ctx.waitUntil((async () => {
          try {
            const { observe } = await import('./soulprofile.mjs');
            for (const a of clean.actions ?? []) {
              if (a?.type !== 'remember') continue;
              const { key, value } = (typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload) ?? {};
              if (key && value) await observe(env, subj, String(key), String(value));
            }
          } catch (e) { console.warn('[soul]', e?.message ?? e); }
        })());
      }
    }
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
        || url.pathname === '/api/sms/status' || url.pathname === '/api/whatsapp/inbound'
        // Resend delivery events, for the same reason: it retries on a non-2xx,
        // and the events a throttle would drop are precisely the bounces and
        // delivery confirmations this product spent a month unable to see.
        || url.pathname === '/api/webhooks/resend';
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
      // /api/biz/mcp joined this list on 31 Aug 2026, after the blanket gate's
      // non-JSON-RPC 429 failed the MCP integrity check on a live deploy and
      // reported two perfectly working tools as broken. It now limits itself
      // in bizmcp.mjs, on the same binding, exempting discovery.
      const isSelfLimitedMcp = url.pathname === '/api/partner/mcp'
        || url.pathname === '/api/concierge/mcp'
        || url.pathname === '/api/biz/mcp';
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
    // The member's calendar: a confirmed table, a plan, an event, as .ics.
    // Read-only, floating local times, bearer-safe headers. worker/calendar.mjs.
    // The host programme, from the app's side: who my host is, my host's
    // confirmed work as a calendar feed, the host's plan and the host desk.
    // worker/hostmoney.mjs (the growth worker keeps the host console routes on itsnum.com).
    // "Something is wrong." Open to everyone, signed in or not — the guest
    // most likely to hit a bug is the one who could not finish signing up.
    // worker/support.mjs.
    if (url.pathname.startsWith('/api/support')) {
      const { handleSupport } = await import('./support.mjs');
      const res = await handleSupport(request, env, url);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
    // Delivery from a Num partner, from the app's side: my orders, a web
    // order, who delivers near here (coarse). worker/delivery.mjs.
    if (url.pathname.startsWith('/api/delivery/')) {
      const { handleDelivery } = await import('./delivery.mjs');
      const res = await handleDelivery(request, env, url);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
    if (url.pathname.startsWith('/api/host/')) {
      const { handleHost } = await import('./hostmoney.mjs');
      const res = await handleHost(request, env, url);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
    if (url.pathname.startsWith('/api/calendar/')) {
      const { handleCalendar } = await import('./calendar.mjs');
      const res = await handleCalendar(request, env, url);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
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

    // WHAT NUM WORKS WITH — public, and generated from what is actually
    // configured rather than from a list somebody typed.
    //
    // Named `/api/works-with` and not `/api/connections` on purpose: there is
    // already an admin-gated `/api/connectors`, and two routes one letter
    // apart, one public and one privileged, is a mistake waiting to be made at
    // 2am. See worker/connections.mjs for why the page is generated.
    // NUM FOR AI — the self-serve developer API. Sign up, get a key, serve
    // your own users local information. Read-only and nothing that touches a
    // person; see worker/devapi.mjs for why that is the whole reason a key
    // can be issued in one click.
    if (url.pathname === '/api/dev' || url.pathname.startsWith('/api/dev/')) {
      const { handleDevApi } = await import('./devapi.mjs');
      return handleDevApi(request, env, url.pathname.slice('/api/dev'.length) || '/');
    }

    if (url.pathname === '/api/works-with') {
      const { connectionsPayload } = await import('./connections.mjs');
      return json(200, connectionsPayload(env), { 'Cache-Control': 'public, max-age=300' });
    }

    if (url.pathname === '/api/air') {
      return json(200, { connected: airReady(env), tools: AIR_TOOLS });
    }

    if (url.pathname === '/api/brains') {
      const admin = env.ADMIN_KEY && request.headers.get('X-Admin-Key') === env.ADMIN_KEY;
      // The probe costs Workers AI neurons and takes seconds, so it is gated
      // on the admin key rather than left open.
      if (url.searchParams.get('probe') && admin) {
        return json(200, { brains: brainRoster(env), probe: await brainProbe(env) });
      }
      // WHICH Anthropic account is answering our guests. Admin-gated because
      // the organisation we buy from is a commercial fact, not a public one —
      // and because it costs an outbound call. See worker/brainorg.mjs.
      // WHAT WOULD THE SCORER CHOOSE FOR THIS QUESTION?
      //
      // `?plan=<any question>` runs the whole routing web — classify the
      // demand, rank every configured brain by capability, health and price —
      // and shows the answer WITHOUT calling anything. It is the way to see
      // the policy before trusting it with traffic, and the way to check a
      // surprising bill afterwards. Admin-gated: it names our costs.
      if (url.searchParams.get('plan') != null && admin) {
        const [{ classifyDemand }, score, brainstate] = await Promise.all([
          import('./director.mjs'), import('./brainscore.mjs'), import('./brainstate.mjs'),
        ]);
        const text = url.searchParams.get('plan') ?? '';
        const prevUser = url.searchParams.get('prev') ?? null;
        const demand = classifyDemand(text, { prevUser });
        const health = score.healthFrom(await brainstate.load(env));
        return json(200, {
          ask: text,
          demand,
          needs: score.NEEDS[demand.tier],
          health,
          plan: score.plan(env, demand.tier, health),
          slots: score.SLOTS,
        });
      }
      if (url.searchParams.get('org') && admin) {
        const { brainOrg, matchesExpected } = await import('./brainorg.mjs');
        const org = await brainOrg(env, { force: !!url.searchParams.get('fresh') });
        return json(200, { brains: brainRoster(env), org, expected: matchesExpected(org, env.BRAIN_ORG_EXPECT) });
      }
      return json(200, { brains: brainRoster(env) });
    }

    // "Which Messaging Service SID should be set?" — asked of Twilio itself,
    // using the credentials this Worker already holds. Admin-gated; returns
    // SIDs and statuses, never a credential. See twiliodiag.mjs.
    // The approvals queue. Admin-gated: which businesses have asked to be
    // listed is a commercial fact, not a public one.
    if (url.pathname === '/api/admin/claims') {
      if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return json(404, { error: 'not found' });
      }
      const biz = await import('./bizapproval.mjs');
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const out = await biz.decideClaim(env, {
          id: body.id,
          decision: body.decision,
          by: `admin:${(request.headers.get('CF-Connecting-IP') ?? 'console').slice(0, 40)}`,
          note: typeof body.note === 'string' ? body.note.slice(0, 300) : null,
        });
        if (!out.ok) return json(400, out);
        // The onboarding email goes ONLY on approval, only once, and only when
        // the send actually succeeds — see bizonboard.sendOnboarding.
        if (out.decision === 'approved' && !out.alreadyDecided && env.BIZ_ONBOARD_EMAIL === 'on') {
          const { sendOnboarding } = await import('./bizonboard.mjs');
          ctx.waitUntil(sendOnboarding(env, out.claim).catch(() => {}));
        }
        return json(200, out);
      }
      return json(200, { pending: await biz.pendingClaims(env) });
    }

    // SEE WHAT THEY SEE.
    //
    // The owner's dashboard and this preview are built by the SAME function
    // (bizdash.dashboardData). A preview that assembled its own numbers would
    // be a preview of a screen nobody has, and the first time a merchant
    // phoned about a figure it would not be on Dre's version of the page.
    //
    // Read-only on purpose: it renders what the business sees, it does not
    // hand out a session that could edit their listing. Admin-gated.
    if (url.pathname === '/api/admin/biz-view') {
      if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return json(404, { error: 'not found' });
      }
      const placeId = url.searchParams.get('place') ?? '';
      if (!placeId) {
        // No listing named: list the ones there are to look at.
        const { results } = await env.DB.prepare(
          `SELECT po.place_id, p.name, p.dest, po.business_id
             FROM num_place_owners po JOIN places p ON p.id = po.place_id
            WHERE po.revoked_at IS NULL ORDER BY po.verified_at DESC LIMIT 50`,
        ).all().catch(() => ({ results: [] }));
        return json(200, { businesses: results ?? [], hint: 'add ?place=<place_id>' });
      }
      const place = await env.DB.prepare(
        `SELECT id AS place_id, name, category, dest, area, address, phone, website, hours, cuisine
           FROM places WHERE id = ?1`,
      ).bind(placeId).first();
      if (!place) return json(404, { error: 'no such listing' });
      const [{ dashboardData }, { bizEntitlements }] = await Promise.all([
        import('./bizdash.mjs'), import('./bizbilling.mjs'),
      ]);
      const owner = await env.DB.prepare(
        'SELECT business_id FROM num_place_owners WHERE place_id=?1 AND revoked_at IS NULL',
      ).bind(placeId).first().catch(() => null);
      const plan = owner?.business_id
        ? await bizEntitlements(env, owner.business_id)
        : { tier: 'free', analytics_days: 7, promotions: false, name: 'Listed' };
      const { results: bookings } = await env.DB.prepare(
        `SELECT created_at, guest_name, party, when_text, date, state
           FROM num_booking_requests WHERE place_id=?1 ORDER BY rowid DESC LIMIT 25`,
      ).bind(placeId).all().catch(() => ({ results: [] }));
      const insights = await (await import('./bizconsole.mjs')).insightsForAdmin?.(env, placeId, Math.min(30, plan.analytics_days ?? 7))
        ?? null;
      return json(200, await dashboardData(env, {
        place, plan: { ...plan, business_id: owner?.business_id ?? null }, insights, bookings: bookings ?? [],
      }));
    }

    // WHERE IS EVERY BUSINESS, AND WHOSE MOVE IS IT?
    //
    // /api/admin/claims answers "who is waiting on a decision" and
    // /api/admin/biz-view answers "what does one merchant see". Neither could
    // answer the question that actually runs the pilot: has this business got
    // everything it needs to operate, and if not, is the delay ours or theirs?
    //
    // Read-only and admin-gated, like the two above. `?business=<id>` for one;
    // no argument returns the rollup every agent reports into. The rollup
    // groups what NUM owes BY THE SWITCH THAT FIXES IT, because eleven
    // businesses missing the same email is one job, not eleven errands.
    if (url.pathname === '/api/admin/biz-onboarding') {
      if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return json(404, { error: 'not found' });
      }
      const businessId = url.searchParams.get('business');
      if (businessId) {
        const { agentBrief } = await import('./bizagent.mjs');
        const brief = await agentBrief(env, businessId);
        return brief ? json(200, brief) : json(404, { error: 'no such business' });
      }
      const { rollup } = await import('./bizagent.mjs');
      return json(200, await rollup(env, {
        limit: Math.min(500, Number(url.searchParams.get('limit')) || 200),
      }));
    }

    if (url.pathname === '/api/admin/twilio') {
      const { handleTwilioDiag } = await import('./twiliodiag.mjs');
      return await handleTwilioDiag(request, env);
    }

    // The OTHER pipe. /api/admin/twilio inspects Programmable Messaging; every
    // sign-in code goes through Twilio Verify, which is a separate service
    // with a separate sender pool and no delivery webhook at all. Fixing one
    // has never told you anything about the other, which is how a repaired
    // Messaging Service SID and a signup that received no text were true on
    // the same evening.
    if (url.pathname === '/api/admin/verify') {
      const { handleVerifyDiag } = await import('./verifydiag.mjs');
      return await handleVerifyDiag(request, env);
    }

    // What NUM handed out on a scout's behalf — the statement you can send
    // them. It reports handoffs and earnings as separate, differently-named
    // numbers on purpose: see scoutusage.mjs for why calling a handoff a
    // booking is the one mistake this endpoint must never make.
    if (url.pathname === '/api/admin/scout-usage') {
      const { handleScoutUsage } = await import('./scoutusage.mjs');
      return await handleScoutUsage(request, env);
    }

    // The funnel the money is judged on: arrived → asked → answered → offered
    // the home screen → kept it. Reported per install path, because an in-app
    // browser cannot add a home screen icon at all and averaging it with
    // Chrome produces a number that argues for better copy when the problem is
    // the browser. See worker/installfunnel.mjs.
    // WHAT IS BROKEN, PULLED RATHER THAN PUSHED.
    //
    // The watchman spent a month reporting four real failures into a LINE
    // channel that answered 404 on every send. An alerting system that can
    // only push has a single point of failure at the exact moment it matters.
    // This is the surface that cannot be silenced by the thing it reports.
    // Resend tells us what actually happened to each message. Without this,
    // "delivered" is a word nobody in this system has ever been able to say.
    if (url.pathname === '/api/webhooks/resend') {
      const { handleResendWebhook } = await import('./maildelivery.mjs');
      return await handleResendWebhook(request, env);
    }

    if (url.pathname === '/api/admin/failures') {
      const denied = (await import('./adminkey.mjs')).adminGuard(request, env, cors);
      if (denied) return denied;
      const { open, summary } = await import('./failures.mjs');
      return json(200, { ...(await summary(env)), failures: await open(env, { limit: 100 }) });
    }

    if (url.pathname === '/api/admin/install-funnel') {
      const { handleInstallFunnel } = await import('./installfunnel.mjs');
      return await handleInstallFunnel(request, env);
    }

    // What Num can actually do where this guest is standing. One indexed D1
    // read, no model call — see suggest.mjs for why this must never cost a
    // generation.
    if (url.pathname === '/api/suggest') {
      const { handleSuggest } = await import('./suggest.mjs');
      return await handleSuggest(request, env);
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
          // Off by configuration until WHATSAPP_ENABLED + TWILIO_WHATSAPP_FROM are set.
          whatsapp: !!whatsAppNumber(env),
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
        // The WhatsApp line, in the same public shape as the SMS one, and
        // ONLY when the channel is actually live. The landing page reads
        // this to decide whether to show its WhatsApp button, so switching
        // the channel on is one secret and no site deploy — and, more
        // importantly, the button can never appear before there is a real
        // sender behind it. A dead "Message us on WhatsApp" is worse than no
        // button: it spends the one click a stranger was ever going to give.
        whatsapp_number: whatsAppNumber(env),
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
    // WhatsApp as a front door — same brain, same memory, same thread as the
    // app. Signed by Twilio, dark until WHATSAPP_ENABLED + TWILIO_WHATSAPP_FROM
    // are set. Its concierge turn rides on handleNum in-process; the per-sender
    // limit there is what protects the brain, which is why this webhook itself
    // is exempt from the blanket gate above. See worker/whatsapp.mjs.
    if (url.pathname === '/api/whatsapp/inbound') {
      const { handleWhatsAppInbound } = await import('./whatsapp.mjs');
      return await handleWhatsAppInbound(request, env, ctx);
    }
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
    // Does mail actually leave the building? For five days in August the
    // answer was no and nothing said so — the evidence was one column in
    // num_invites nobody read. Set MAIL_SELFTEST to an address and the next
    // tick answers it in num_health, from a real send rather than from
    // configuration. No-op when the variable is unset.
    ctx.waitUntil(
      import('./mailer.mjs')
        .then((m) => m.selfTest(env))
        .catch((e) => console.error('[mailer]', e?.message ?? e)),
    );
    // IS THE BRAIN ACTUALLY ANSWERING?
    //
    // On 31 Aug 2026 both Anthropic brains failed at 13:33, stood down for an
    // hour, and the health check went green at 14:33 when the cooldown lapsed
    // — with nothing proven either way, because the only "brain" check we had
    // tested whether a key was SET. The next guest would have been the one to
    // find out. This spends one token instead, and only for a brain that is
    // carrying a failure whose cooldown has already run out. A healthy chain
    // probes nothing and costs nothing. See worker/brainprobe.mjs.
    ctx.waitUntil(
      import('./brainprobe.mjs')
        .then((m) => m.proveBrains(env))
        .then((r) => {
          if (r?.recovered?.length) console.log(`[brainprobe] recovered: ${r.recovered.join(', ')}`);
          if (r?.still_down?.length) console.warn(`[brainprobe] STILL DOWN: ${JSON.stringify(r.still_down)}`);
        })
        .catch((e) => console.error('[brainprobe]', e?.message ?? e)),
    );
    // DID THE SIGN-IN CODES ACTUALLY ARRIVE?
    //
    // Twilio Verify has no StatusCallback, so unlike Programmable Messaging
    // nothing ever calls us back to say a carrier dropped a code. The outcome
    // exists — Twilio records it per attempt — but only if somebody asks. For
    // as long as nobody did, `num_signin_events` reported a healthy send rate
    // for a channel that was delivering nothing, and `num_sms_delivery` sat
    // nine days stale because it only ever saw the pipe sign-in stopped using.
    // This is the ask. See worker/verifydiag.mjs.
    ctx.waitUntil(
      import('./verifydiag.mjs')
        .then((m) => m.reconcileVerifySends(env))
        .then((r) => {
          if (r?.undelivered) {
            console.warn(`[verify] ${r.undelivered}/${r.seen} sign-in codes did NOT reach a carrier — ${JSON.stringify(r.reasons)}`);
          }
        })
        .catch((e) => console.error('[verify-reconcile]', e?.message ?? e)),
    );
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
    // ...and the other half of it. nudge.mjs alerts US about a business that
    // started a claim and stopped; it has done so correctly since 24 Aug 2026
    // and nobody acted for fourteen days. This writes to the BUSINESS, which
    // is the only message that was ever going to move the thing along.
    // At-most-once per round, forever — see worker/claimchase.mjs.
    ctx.waitUntil(
      import('./claimchase.mjs')
        .then(async (m) => {
          const r = await m.chaseStalledClaims(env);
          if (r.sent) console.log('[claimchase]', r.sent, 'chased', JSON.stringify(r.rows));
          if (r.failed) console.warn('[claimchase]', r.failed, 'could not be sent', JSON.stringify(r.rows));
        })
        .catch((e) => console.error('[claimchase]', e?.message ?? e)),
    );
    // Before and after a confirmed table: the reminder three hours out, and
    // the after-visit ask the next morning. worker/tablefollowup.mjs. Same
    // dedup discipline as nudge.mjs, its own failure domain.
    ctx.waitUntil(
      import('./tablefollowup.mjs')
        .then(async (m) => {
          const before = await m.reminderSweep(env);
          const after = await m.afterVisitSweep(env);
          if (before.sent || after.sent) console.log(`[table] reminded ${before.sent} (texted ${before.texted}), asked ${after.sent} (texted ${after.texted})`);
        })
        .catch((e) => console.error('[table]', e?.message ?? e)),
    );
    // A BUSINESS SIGNUP MUST NOT BE LOST TO ONE DROPPED TEXT.
    //
    // claimSweep already alerts on every new claim, once, deduped forever.
    // That is right for noise and wrong for certainty: claim 15 (Fingal Hotel)
    // was announced at 14:45 on 29 Aug — three days into the SMS outage, when
    // every message went out on a bare long code and carriers dropped it. One
    // shot, into a dead channel, and the dedupe meant it never came back.
    //
    // This re-raises anything still undecided on a widening schedule
    // (2h, 8h, 1d, 3d, 1w…) and stops the moment somebody decides — which is
    // the only evidence that a human actually saw it. Own failure domain, so a
    // broken digest never takes health monitoring down with it.
    ctx.waitUntil(
      (async () => {
        const { autoApproveAll, staleDigest } = await import('./bizapproval.mjs');
        // EVERY business gets an account and a dashboard, immediately.
        // Verification is a separate badge earned by proof (bizverify.mjs) —
        // refusing an account until then costs a real business and protects
        // nothing, since the dashboard only ever edits that listing's own
        // hours, phone and address.
        await autoApproveAll(env);
        // Approving is not telling. autoApproveAll never called sendOnboarding
        // — only the manual admin route did — so eight businesses sat approved
        // and uninformed. This sweep re-reads the world every tick, so one
        // approved while the mailer is down is told when it comes back. It is
        // gated on BIZ_ONBOARD_EMAIL, which stays off until you switch it on.
        const { onboardApproved } = await import('./bizonboard.mjs');
        const told = await onboardApproved(env);
        // `repeated` means this exact failure was already reported. alert()
        // fans out to webhook, SMS and email with no throttle of its own, and
        // this runs every five minutes.
        if (told.failed && !told.repeated) {
          const { alert } = await import('./health.mjs');
          await alert(env, `[biz] ${told.failed} onboarding email(s) failed: ${(told.errors ?? []).join(' | ')}`);
        }
        // The directory reading its own notes: hours text → weekly mask, a
        // few hundred rows per tick, until 124,117 more places can say
        // whether they are open. See worker/hoursbackfill.mjs.
        try {
          const { backfillHours } = await import('./hoursbackfill.mjs');
          const h = await backfillHours(env);
          if (h.scanned) console.log(`[hoursbackfill] ${h.parsed} parsed, ${h.refused} refused of ${h.scanned}`);
        } catch (e) { console.warn('[cron] hours backfill', e?.message ?? e); }

        // ACCEPTED IS NOT DELIVERED. Anything handed to a transport and still
        // unconfirmed after thirty minutes becomes a named, visible failure.
        // On 30 Aug this would have shown six of them by 20:56 — the evening
        // it happened — instead of four days of silence.
        try {
          const { checkUnconfirmed } = await import('./maildelivery.mjs');
          await checkUnconfirmed(env);
        } catch (e) { console.warn('[cron] unconfirmed sweep', e?.message ?? e); }

        // A client asked NUM for their host: the host is told by email, once,
        // with a receipt, and a host the mailer cannot reach is a named
        // failure. The writer never emails; this watchman does.
        try {
          const { notifyHosts } = await import('./hostaware.mjs');
          const h = await notifyHosts(env);
          if (h.sent || h.failed) console.log(`[hostaware] told ${h.sent} host(s), ${h.failed} failed`);
        } catch (e) { console.warn('[cron] host requests', e?.message ?? e); }

        // The rest of the host loop that runs without a host typing:
        // NUM's draft reply on each new request, the venue's answer written
        // back onto a request that went through the desk, and the monthly
        // booking-fee invoice (dry until HOST_FEE_INVOICING=on).
        try {
          const { draftSweep } = await import('./hostdraft.mjs');
          const d = await draftSweep(env);
          if (d.drafted || d.skipped) console.log(`[hostdraft] drafted ${d.drafted}, skipped ${d.skipped}`);
        } catch (e) { console.warn('[cron] host drafts', e?.message ?? e); }
        try {
          const { venueAnswerSweep } = await import('./hostbookdesk.mjs');
          const v = await venueAnswerSweep(env);
          if (v.written) console.log(`[hostbookdesk] ${v.written} venue answer(s) written back`);
        } catch (e) { console.warn('[cron] host venue answers', e?.message ?? e); }
        try {
          const { feeSweep } = await import('./hostmoney.mjs');
          const f = await feeSweep(env);
          if (f.hosts) console.log(`[hostmoney] fees owed by ${f.hosts} host(s): ${f.pence}p${f.dry ? ' (dry — HOST_FEE_INVOICING is off)' : `, ${f.invoiced} invoiced`}`);
        } catch (e) { console.warn('[cron] host fees', e?.message ?? e); }

        // A LISTING THAT WENT LIVE AND NOBODY WAS TOLD.
        //
        // bizsubmit promises, in writing on the owner's screen, "we will email
        // you the moment your listing is live". Promoting it wrote the places
        // row and told the admin who pressed the button. This keeps the other
        // half of that promise. Same switch as the onboarding email.
        const { goLiveSweep } = await import('./bizgolive.mjs');
        const live = await goLiveSweep(env);
        if (live.failed) {
          const { alert } = await import('./health.mjs');
          await alert(env, `[biz] ${live.failed} go-live email(s) failed: ${(live.errors ?? []).join(' | ')}`);
        }
        const digest = await staleDigest(env);
        if (digest) {
          const { alert } = await import('./health.mjs');
          await alert(env, digest.text);
        }
        // The business's own weekly note. Sends only to owners who opted in,
        // only when the week actually held something, and at most once every
        // seven days — see biznotify.weeklySweep. An empty digest is how a
        // sender becomes spam, so it simply does not go.
        if (env.BIZ_WEEKLY_EMAIL === 'on') {
          const { weeklySweep } = await import('./biznotify.mjs');
          await weeklySweep(env);
        }
      })().catch((e) => console.error('[bizapproval]', e?.message ?? e)),
    );
    // EVERY BUSINESS GETS ITS OWN AGENT, AND THE AGENT KEEPS UP.
    //
    // `num_business_profiles.owner_agent` has existed since 31 Jul and nothing
    // ever wrote it. This is the sweep that does — and it is a sweep rather
    // than a hook on the signup path for the reason bizonboard.mjs sets out:
    // every failure this codebase has found was a one-shot hook that fired
    // into a broken channel and then believed the job was done. A business
    // whose agent could not be created on Tuesday gets one on Wednesday.
    //
    // Own failure domain. It creates records and refreshes what they know; it
    // sends nothing, so it cannot reach a merchant even if it is wrong.
    ctx.waitUntil(
      import('./bizagent.mjs')
        .then((m) => m.agentSweep(env))
        .then((r) => { if (r?.created) console.log(`[bizagent] ${r.created} new agent(s)`); })
        .catch((e) => console.error('[bizagent]', e?.message ?? e)),
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
      // Retention: make num_retention_policy true. Every row had
      // last_purged_at NULL on 4 Sep 2026 — the policy existed, nothing read
      // it. Also drains soft-deleted messages, expired cached answers and
      // the passenger sweep that had no caller. See worker/retention.mjs.
      ctx.waitUntil(
        import('./retention.mjs')
          .then((m) => m.runRetention(env))
          .then((r) => console.log('[retention]', JSON.stringify(r)))
          .catch((e) => console.error('[retention]', e?.message ?? e)),
      );
      // Neighbourhood centroids: rebuilt hourly from the directory into
      // num_dest_areas (0016) so no request re-aggregates 290K rows.
      ctx.waitUntil(
        import('../ai/places.js')
          .then((m) => m.refreshDestAreas(env))
          .then((r) => console.log('[dest-areas]', JSON.stringify(r)))
          .catch((e) => console.error('[dest-areas]', e?.message ?? e)),
      );
    }
  },
};
