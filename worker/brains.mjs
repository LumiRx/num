// More than one brain, so a turn never dies with the first one.
//
// Three kinds, and the distinction that matters is STRUCTURED vs PROSE:
//
//   anthropic         Claude. Structured output, so it can create bookings,
//                     cards and chips — the full concierge.
//   workers-ai        Open models already running on Cloudflare's edge. No
//                     hosting, no extra account, no key. Prose only.
//   openai-compatible Anything speaking the OpenAI chat API: Jan, Ollama,
//                     LM Studio, vLLM, OpenRouter, Groq, Together, Fireworks.
//                     ONE adapter covers all of them, which is why this is the
//                     right abstraction rather than one per vendor.
//
// A prose brain cannot book anything, and the honest consequence is that it is
// told not to claim it did. A slightly less capable answer beats an outage;
// an answer that invents a reservation is worse than either.

/**
 * The chain, best first. Override the order with the NUM_BRAIN_ORDER var
 * (comma-separated ids) — useful for putting a cheap brain first during a
 * spend freeze without touching code.
 */
import {
  load as loadBrainState,
  plan as planChain,
  recordFailure as recordBrainFailure,
  recordSuccess as recordBrainSuccess,
} from './brainstate.mjs';
// The default output guard. Imported rather than optional — see the call site.
import { guardReply } from './router.mjs';
// The one REPLY_SCHEMA, translated for vendors that promise strict shapes.
import { REPLY_SCHEMA, normalizeReply } from './prompt.mjs';
import { responseFormat } from './strictschema.mjs';

export const BRAINS = [
  {
    id: 'claude',
    label: 'Claude Opus 5',
    kind: 'anthropic',
    structured: true,
    ready: (env) => !!env.ANTHROPIC_API_KEY,
    note: 'The concierge. Books, remembers, uses the specialists.',
  },
  {
    // ── THE BULK LANE ──────────────────────────────────────────────────────
    //
    // The everyday turn — "where should we eat", "best beach", "what's on
    // tonight" — answered by Haiku at one fifth of Opus's price.
    //
    // WHY A SECOND ANTHROPIC BRAIN RATHER THAN A CHEAPER VENDOR: everything
    // below this line in the chain is `structured: false`, and a prose brain
    // is forbidden — correctly — from minting cards or actions. That boundary
    // exists so a cheap model can never fake a reservation. But it means that
    // routing the MAJORITY of traffic to a prose brain quietly removed the
    // ability to offer a booking from the majority of conversations. Haiku
    // produces the full REPLY_SCHEMA, so the cheap lane keeps every capability
    // the expensive one has.
    //
    // It shares Anthropic's quota with `claude`, which is why it is not a
    // substitute for the independent-bill brains below — it is a cost lane,
    // not a redundancy lane. The redundancy still lives underneath it.
    id: 'haiku',
    label: 'Claude Haiku 4.5',
    kind: 'anthropic',
    structured: true,
    ready: (env) => !!env.ANTHROPIC_API_KEY,
    note: 'The bulk lane. Recommendations and lookups at a fifth of Opus, with the full schema — so a cheap answer can still offer a booking.',
  },
  {
    // ── THE BACKUP THAT CAN ACTUALLY BOOK (7 Sep 2026) ────────────────────
    //
    // Every brain under the two Anthropic ones has been prose-only, and on
    // 7 Sep they gained `picks` — so a backup answer now arrives as tappable
    // place cards. What it still could not do was produce a booking card or an
    // action, and that is the gap that made sixty hours of Anthropic being out
    // of credit feel like an outage even though nothing errored.
    //
    // The reason was never the vendor's intelligence, it was the CONTRACT.
    // DeepSeek's JSON mode promises "some JSON"; a booking state we merely
    // hope is well formed is not a booking state. OpenAI's strict mode
    // promises the response matches a schema we supply — so this brain can be
    // handed the full REPLY_SCHEMA and trusted with the shape that comes back.
    // See worker/strictschema.mjs for the translation.
    //
    // WHY IT SITS BELOW HAIKU AND ABOVE EVERYTHING ELSE: it is a third
    // independent bill, it produces the same SHAPE of answer as the Anthropic
    // lane, and at our measured token shape it costs about $0.002 a turn
    // against Opus's $0.105. It is the first brain in this list that is both
    // cheap and complete.
    //
    // ACTIONS ARE OFF BY DEFAULT, AND THAT IS NOT A DETAIL. An action makes
    // something happen in the world — a table requested, a delivery ordered, a
    // fact remembered. Until 7 Sep only Claude could reach them. Widening that
    // to a new vendor on its first day, quietly, is exactly the kind of change
    // that is discovered later rather than decided now. So this brain produces
    // cards and picks immediately, and `NUM_OPENAI_ACTIONS=1` is the separate,
    // deliberate decision to let it act — made after watching it, not before.
    //
    // Set NUM_OPENAI_BASE_URL (https://api.openai.com/v1), NUM_OPENAI_KEY and
    // NUM_OPENAI_MODEL (gpt-5-mini). Any vendor with STRICT schema support
    // fits the same three variables — Gemini and xAI both do.
    id: 'openai',
    label: 'GPT-5 mini (strict schema)',
    kind: 'openai-compatible',
    structured: true,
    env: { base: ['NUM_OPENAI_BASE_URL'], key: ['NUM_OPENAI_KEY'], model: ['NUM_OPENAI_MODEL'] },
    ready: (env) => !!env.NUM_OPENAI_BASE_URL,
    note: 'A strict-schema brain on a third independent bill — full cards and places, at about 2% of the frontier model. Actions stay off until NUM_OPENAI_ACTIONS=1.',
  },
  {
    // A hosted model on a SEPARATE bill from Anthropic and from Workers AI.
    //
    // This is the layer the 2026-08-06 and 08-07 outages were actually missing.
    // Rotation cannot help when every brain draws on one of two pools and both
    // are empty at the same moment — the chain had seven brains and two
    // quotas. This adds a third, independent one, high enough in the order to
    // carry real conversation rather than merely avoid silence.
    //
    // Any OpenAI-compatible provider works. Groq (llama-3.3-70b) is fast and
    // has a free tier; OpenAI, DeepSeek, Together and OpenRouter all fit the
    // same three variables. Set NUM_LLM_BASE_URL, NUM_LLM_MODEL, NUM_LLM_KEY.
    id: 'hosted',
    label: 'Hosted (independent quota)',
    kind: 'openai-compatible',
    structured: false,
    env: { base: ['NUM_LLM_BASE_URL'], key: ['NUM_LLM_KEY'], model: ['NUM_LLM_MODEL'] },
    ready: (env) => !!env.NUM_LLM_BASE_URL,
    note: 'A hosted OpenAI-compatible model on its own bill — Groq, OpenAI, DeepSeek, Together, OpenRouter. Ranked above Workers AI because it does not share a quota with anything else in this chain.',
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    kind: 'workers-ai',
    model: '@cf/openai/gpt-oss-120b',
    structured: false,
    ready: (env) => !!env.AI,
    note: 'Open weights on Cloudflare’s edge. Nothing to host, no key.',
  },
  {
    id: 'llama-4-scout',
    label: 'Llama 4 Scout 17B',
    kind: 'workers-ai',
    model: '@cf/meta/llama-4-scout-17b-16e-instruct',
    structured: false,
    ready: (env) => !!env.AI,
  },
  {
    id: 'llama-3.3-70b',
    label: 'Llama 3.3 70B',
    kind: 'workers-ai',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    structured: false,
    ready: (env) => !!env.AI,
    note: 'The fast lane for chit-chat.',
  },
  {
    id: 'qwen3-30b',
    label: 'Qwen3 30B',
    kind: 'workers-ai',
    model: '@cf/qwen/qwen3-30b-a3b-fp8',
    structured: false,
    ready: (env) => !!env.AI,
  },
  {
    id: 'mistral-small',
    label: 'Mistral Small 24B',
    kind: 'workers-ai',
    model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    structured: false,
    ready: (env) => !!env.AI,
  },
  {
    // Jan, Ollama, LM Studio, vLLM, OpenRouter, Groq, Together — all of them.
    // A Worker cannot reach localhost, so a laptop needs a tunnel; see
    // docs/brains.md before pointing this at a machine under a desk.
    //
    // ── WHY THIS ONE MATTERS MOST ────────────────────────────────────────
    //
    // Every other brain in this list can be switched off by somebody else.
    // Anthropic bills by the token and stops at a spend cap; Workers AI meters
    // neurons and stops at a daily allowance. On 2026-08-06 both ran out in
    // the same window and the whole chain died with them.
    //
    // A self-hosted model has no quota to exhaust. It is not the best answer
    // in the list and it is not meant to be — it is the one that is still
    // there at 3am on the day the invoices bounce. Keep it configured even
    // when everything else is healthy, because the day you need it is
    // precisely the day you cannot set it up.
    //
    // OLLAMA_BASE_URL is accepted as an alias so nobody has to remember that
    // the Ollama endpoint lives under a variable named after a different
    // product. Ollama speaks the OpenAI API at /v1 — point this at
    // https://<your-tunnel>/v1 and set OLLAMA_MODEL (e.g. llama3.1).
    id: 'jan',
    label: 'Ollama / Jan / self-hosted',
    kind: 'openai-compatible',
    structured: false,
    env: {
      base: ['OLLAMA_BASE_URL', 'JAN_BASE_URL'],
      key: ['OLLAMA_API_KEY', 'JAN_API_KEY'],
      model: ['OLLAMA_MODEL', 'JAN_MODEL'],
    },
    ready: (env) => !!(env.OLLAMA_BASE_URL || env.JAN_BASE_URL),
    note: 'Any OpenAI-compatible endpoint — Ollama, Jan, LM Studio, vLLM, OpenRouter, Groq. Set OLLAMA_BASE_URL (or JAN_BASE_URL), plus OLLAMA_MODEL and optionally OLLAMA_API_KEY. No quota to run out of: this is the floor under the whole chain.',
  },
];

export const byId = (id) => BRAINS.find((b) => b.id === id);

/** The chain to try, in order, filtered to what is actually configured. */
export function chain(env) {
  const order = String(env?.NUM_BRAIN_ORDER ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ordered = order.length ? order.map(byId).filter(Boolean) : BRAINS;
  return ordered.filter((b) => b.ready(env));
}

/**
 * Read a hosted brain's reply, whether or not it came back as JSON.
 *
 * ── WHAT A CHEAP BRAIN IS TRUSTED TO PRODUCE ─────────────────────────────
 *
 * Three fields: `reply`, `chips` and `picks`. That is a deliberate boundary,
 * not a limitation we ran out of time to lift.
 *
 *   reply  — prose. Already guarded downstream.
 *   chips  — follow-up suggestions. Pure text, no side effects, and the one
 *            thing everyday turns were actually losing.
 *   picks  — (added 7 Sep 2026) the places being recommended, as `id`, `name`
 *            and `why` and NOTHING else. This is safe for exactly the reason
 *            it is safe on Claude: the model never supplies a link, a phone
 *            number, an address, an opening time or a bookable flag. Every one
 *            of those is attached SERVER-SIDE from the verified row by
 *            placelink.resolvePicks and pickdetail.enrichPicks, and a pick
 *            that matches no verified row is DROPPED before the guest sees it.
 *            A model that cannot type a URL cannot get one wrong.
 *
 *            Why it was worth adding: from 5 Sep both Anthropic brains were
 *            out of credit for sixty hours, and for those sixty hours every
 *            recommendation arrived as a paragraph — no card, no tappable
 *            phone, no map, no booking offer — because picks were the one
 *            thing the backup lane could not carry. The backup existed and it
 *            still felt like an outage. It does not any more.
 *
 * NOT `card`: every card tag in REPLY_SCHEMA is a booking state — confirmed,
 * hold, deposit, paid. A recommendation turn has `card: null` even on Claude,
 * so there was never anything to lose there, and letting a prose model mint a
 * "confirmed" card would be the worst bug this product could ship.
 *
 * NOT `actions`: actions cause things to happen — AiR calls, bookings,
 * reminders. A brain answering on the cheap lane must not be able to reach
 * them. That is a security boundary, and it stays where it is.
 *
 * ── TOLERANT BY CONSTRUCTION ─────────────────────────────────────────────
 *
 * Vendors that ignore `response_format` return prose; vendors that honour it
 * sometimes wrap JSON in a code fence anyway. Both are handled, and anything
 * unparseable falls back to "the whole text is the reply" — the behaviour
 * from before this existed. There is no input to this function that loses a
 * guest their answer.
 */
export function readHosted(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { reply: '', chips: null, picks: null };
  // A fenced block is the single most common shape when a model is asked for
  // JSON and also told to be conversational.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced ? fenced[1] : raw).trim();
  if (!candidate.startsWith('{')) return { reply: raw, chips: null, picks: null };
  let j;
  try {
    j = JSON.parse(candidate);
  } catch {
    // TRUNCATED JSON IS THE COMMON FAILURE, AND IT USED TO COST US TWICE.
    //
    // DeepSeek's own JSON-mode documentation warns that a low token ceiling
    // truncates the object and that the API can return empty content. When
    // that happened the whole broken object became the reply, guardReply
    // rightly refused to show a guest a half-written `{"reply": "...`, the
    // turn fell through to a weaker brain — and we had already paid for the
    // good answer sitting inside the broken wrapper.
    //
    // So pull the reply string out by hand. It is the first quoted value after
    // `"reply":`, with escaped quotes respected; if there is nothing there,
    // returning an empty reply lets the caller fail the brain honestly rather
    // than shipping JSON to a person.
    const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(candidate);
    if (!m) return { reply: '', chips: null, picks: null };
    let salvaged;
    try {
      salvaged = JSON.parse(`"${m[1]}"`);
    } catch {
      salvaged = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    salvaged = String(salvaged).trim();
    return salvaged ? { reply: salvaged, chips: null, picks: null } : { reply: '', chips: null, picks: null };
  }
  if (!j || typeof j !== 'object') return { reply: raw, chips: null, picks: null };
  const reply = typeof j.reply === 'string' && j.reply.trim() ? j.reply.trim() : null;
  // JSON that parsed but carries no reply is worse than no JSON: returning it
  // would show a guest an empty bubble. Keep the raw text instead.
  if (!reply) return { reply: raw, chips: null, picks: null };
  // ONLY these three keys survive. A hosted brain that invents `card`,
  // `actions`, `link`, `phone` or `bookable` has them silently ignored — the
  // boundary is enforced by what is READ, not by what the model was asked for,
  // because a security rule that lives only in a prompt is a request.
  const picks = Array.isArray(j.picks)
    ? j.picks
        .map((pk) => {
          if (!pk || typeof pk !== 'object') return null;
          const name = typeof pk.name === 'string' ? pk.name.trim().slice(0, 120) : '';
          if (!name) return null;
          const why = typeof pk.why === 'string' ? pk.why.trim().slice(0, 160) : '';
          const id = pk.id == null ? null : String(pk.id).slice(0, 60);
          return { ...(id ? { id } : {}), name, ...(why ? { why } : {}) };
        })
        .filter(Boolean)
        .slice(0, 5)
    : null;
  const chips = Array.isArray(j.chips)
    ? j.chips
        .map((c) => (typeof c === 'string'
          ? { id: c.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40), label: c.slice(0, 40) }
          : c && typeof c.label === 'string'
            ? { id: String(c.id ?? c.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40), label: String(c.label).slice(0, 40) }
            : null))
        .filter(Boolean)
        .slice(0, 4)
    : null;
  return { reply, chips: chips?.length ? chips : null, picks: picks?.length ? picks : null };
}

/**
 * What a prose brain is allowed to be. It has the voice and the local
 * knowledge but none of the machinery, so the one thing it must never do is
 * imply a booking exists.
 */
function proseSystem({ persona, voice, context, style, json = false }) {
  return [
    persona,
    voice,
    context,
    style,
    // Asked for LAST, so a model that only reads the tail of a long system
    // block still sees it. Chips are optional on purpose: a model that
    // returns `{"reply": "..."}` alone is correct, and demanding four chips
    // produces four bad ones.
    json
      ? 'OUTPUT FORMAT: reply with a single json object and nothing else — no code fence, no commentary.\n' +
        '{"reply": "<your answer, following every rule below>", "picks": [{"id":"<id copied from the verified block>","name":"<name copied exactly>","why":"<twelve words or fewer>"}], "chips": [{"id":"short-slug","label":"Under 22 chars"}]}\n' +
        'The `reply` string is the whole message the guest reads; every length, honesty and format rule below applies to it exactly as if you were writing it directly.\n' +
        // PLACES GO IN `picks`. This is the whole reason the field exists.
        //
        // Num attaches the real link, phone, address, walking time and opening
        // state to each pick from its own verified directory and renders it as
        // a tappable card. A place named in prose gets none of that — it is a
        // name in a sentence that a guest standing in a city cannot act on.
        //
        // It also has to say "instead of listing them", because the brief
        // further down TELLS this model to name three places on three short
        // lines. That instruction is right for a brain with no picks field and
        // wrong for one with it, and a model handed two rules follows the last
        // one it can see.
        'PLACES GO IN `picks`, NOT IN `reply`. When you are recommending somewhere — one place or three — put each one in `picks` and keep `reply` to ONE short framing line plus, at most, one line saying which you would choose. This REPLACES the "three short lines" instruction below: do not also list them in the reply, or the guest reads every name twice.\n' +
        'Every pick MUST be copied from the verified partners block above — its `id` and `name` exactly as written. A pick that is not in that block is thrown away before the guest sees it, so inventing one costs them the recommendation. Give three when the block holds three.\n' +
        'Put NOTHING else in a pick. No link, no phone number, no address, no price, no opening hours, no rating — Num attaches all of those itself from its verified records, and it renders each pick as a card with a call button and a map button. Anything you type there is discarded.\n' +
        '`chips` are up to 3 tappable follow-ups — the obvious next thing THIS guest would ask, e.g. "Book a table", "Somewhere cheaper", "How do I get there". Omit chips entirely rather than pad with generic ones.\n' +
        'Never put json, brackets or field names inside the `reply` string itself.'
      : '',
    // The response brain's whole brief. It is NOT a degraded stand-in any
    // more — from 11 Aug it answers the everyday turn by design, so this text
    // is the product's voice for most guests, most of the time. Written as
    // rules a cheaper model can follow literally, because a cheaper model
    // follows literally: every line is an instruction, not a sentiment.
    [
      'YOU ARE NUM. Answer as the concierge, in first person. Never mention models, systems, brains, fallbacks, or that anything is unavailable — a guest asked a friend for a recommendation, not a status page.',
      '',
      'LENGTH — HARD CAP: three sentences, 40 words, for any ordinary ask. The FIRST sentence is the answer: the pick, the time, the yes or no. Never open with preamble ("Great question", "Let me help you with that", "You\'re in Kata and hungry"). At most ONE question, and only if you need it to act.',
      '',
      'RECOMMENDATIONS ARE THE EXCEPTION — give THREE options, always. When they ask where to eat, drink, go, swim or stay, name three real places from the verified block, each on its own short line with the one detail that separates it (distance, rating, or the thing they asked for). Then say which ONE you would pick and why, in a single line. Three gives them a choice; one pick means they never have to think. Under 70 words even so — a list is not permission to ramble. If the verified block holds fewer than three, give what it holds and say plainly that is all you have there.',
      '',
      'GROUND TRUTH — the VERIFIED NEARBY PARTNERS block above is the only place names may come from. Use their details exactly. NEVER invent or half-remember a place, address, phone number, price, or opening hour. If the block is empty, say you do not have verified places there and recommend nothing specific — an honest gap beats an invented address, always.',
      '',
      'NUMBERS — quote a rating, distance or price ONLY if it appears in the context above, verbatim. No "around", no "about", no estimates. A traveller budgets on your numbers.',
      '',
      'WHAT YOU CANNOT DO: book, hold, cancel, change, charge, or issue a ticket. Never imply you have. No "I\'ve booked", no "that\'s held", no confirmation numbers. If they want something actually booked, say plainly what you can do instead — point them at the venue\'s number from the verified block, or the booking link — and never promise it will be "locked in shortly": nothing is queued behind that sentence, so it is a stall dressed as service.',
      '',
      'FORMAT: plain prose. No JSON, no brackets, no markdown headers, no bullet lists, no role labels, no emoji. Reply in the language the guest wrote in.',
      '',
      'FOR EVERYTHING THAT IS NOT A PLACE — a time, a route, which product, yes or no — ONE answer with its single deciding detail, then the next step in six words or fewer. Three is for places (above); one is for decisions. Never hedge across both.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Workers AI is not one response shape, it is several. Chat models return
 * `{response}`; the reasoning models (gpt-oss and friends) return an `output`
 * array in the Responses format, where the visible answer is the last message
 * and everything before it is chain-of-thought. Reading only `.response` is why
 * a perfectly healthy 120B model looked dead.
 */
function extractText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res.trim();
  if (typeof res.response === 'string' && res.response.trim()) return res.response.trim();
  if (typeof res.result?.response === 'string' && res.result.response.trim()) return res.result.response.trim();

  const out = res.output ?? res.result?.output;
  if (Array.isArray(out)) {
    const parts = out
      .filter((o) => o?.type !== 'reasoning')
      .flatMap((o) => (Array.isArray(o?.content) ? o.content : []))
      .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
      .filter(Boolean);
    if (parts.length) return parts.join('\n').trim();
  }
  const choice = res.choices?.[0]?.message?.content;
  if (typeof choice === 'string' && choice.trim()) return choice.trim();
  // Completion-style shape, still used by some Workers AI models.
  const legacy = res.choices?.[0]?.text;
  if (typeof legacy === 'string' && legacy.trim()) return legacy.trim();
  // REASONING MODELS THAT RAN OUT OF ROOM TO ANSWER.
  //
  // gpt-oss-120b and qwen3-30b spend their budget thinking before they say
  // anything, and put the thinking in `reasoning_content` with `content` left
  // empty. On 31 Aug the health probe called them with a 40-token ceiling —
  // enough to think, not enough to speak — and both were reported broken while
  // production, which allows 700, was using them happily.
  //
  // Read as a last resort rather than a peer: reasoning is not an answer, and
  // preferring it over real content would put chain-of-thought in front of a
  // guest. But a model that produced reasoning is unambiguously ALIVE, and a
  // liveness check that calls it dead is worse than no check.
  const thought = res.choices?.[0]?.message?.reasoning_content;
  if (typeof thought === 'string' && thought.trim()) return thought.trim();
  return '';
}

/** Workers AI and OpenAI-compatible endpoints both take chat messages.
 *  `model` overrides the brain's default — used by the director for per-class
 *  model selection (flash for bulk, kimi for harder prose). */
/**
 * A STRUCTURED call to an OpenAI-compatible vendor.
 *
 * The same REPLY_SCHEMA the Anthropic lane uses, translated into strict mode
 * (strictschema.mjs) and sent as `response_format`. Strict mode means the
 * vendor guarantees the shape, which is the entire reason this path is allowed
 * to produce cards at all — see the header on the `openai` brain.
 *
 * Deliberately its own function rather than a flag on callProse: the prose
 * path is tolerant by construction, falling back to "the whole text is the
 * reply" whenever parsing fails, and that tolerance is exactly wrong here. A
 * booking card recovered from half-parsed text is worse than no card. So this
 * path is strict all the way down: if the shape is not what we asked for, it
 * throws and the chain moves on.
 */
async function callStructuredJson(env, brain, { messages, system, model = null, maxTokens = 1400 }) {
  const pick = (names) => names.map((n) => env[n]).find((v) => v);
  const base = String(pick(brain.env.base)).replace(/\/+$/, '');
  const key = pick(brain.env.key);
  // Same rule as the prose path, same reason: guest conversations and a bearer
  // key travel in this request, and over http they travel readable.
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(base)) {
    throw new Error(`${brain.id} base URL must be https (or localhost) — refusing to send guest data in cleartext`);
  }

  const format = responseFormat(REPLY_SCHEMA);
  // A schema that cannot be expressed strictly is a reason to SKIP this brain,
  // not a reason to send it loosely and hope. strictschema.problems() has
  // already logged what was wrong.
  if (!format) throw new Error(`${brain.id} cannot be sent the reply schema strictly`);

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: model || pick(brain.env.model) || 'gpt-5-mini',
      messages: [{ role: 'system', content: system }, ...messages.slice(-8)],
      max_completion_tokens: maxTokens,
      response_format: format,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const why = await res.text().catch(() => '');
    const err = new Error(`${brain.id} HTTP ${res.status}${why ? ` — ${why.slice(0, 160)}` : ''}`);
    // Carried so brainstate.classify() files a 402 as `quota` rather than
    // retrying it every twenty seconds for ever.
    err.status = res.status;
    throw err;
  }

  const body = await res.json();
  const choice = body?.choices?.[0];
  // A vendor refusal is a first-class field in strict mode, not an error. It
  // means the model declined rather than failed, and the honest handling is to
  // let the chain try somebody else rather than show a guest a refusal aimed
  // at us.
  if (choice?.message?.refusal) throw new Error(`${brain.id} refused: ${String(choice.message.refusal).slice(0, 120)}`);
  if (choice?.finish_reason === 'length') throw new Error(`${brain.id} ran out of room mid-object`);

  const text = extractText(body);
  if (!text) throw new Error(`${brain.id} returned nothing (fields: ${Object.keys(choice?.message ?? body ?? {}).join(',') || 'none'})`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${brain.id} returned unparseable JSON despite strict mode`);
  }
  return { reply: normalizeReply(parsed), usage: body?.usage ?? null, model: body?.model ?? model ?? null };
}

async function callProse(env, brain, { messages, system, maxTokens = 700, model = null, wantJson = false }) {
  const chat = [{ role: 'system', content: system }, ...messages.slice(-8)];

  if (brain.kind === 'workers-ai') {
    const res = await env.AI.run(brain.model, { messages: chat, max_tokens: maxTokens });
    const text = extractText(res);
    if (!text) throw new Error(`${brain.id} returned nothing (keys: ${Object.keys(res ?? {}).join(',') || 'none'})`);
    // Workers AI is neuron-billed, not token-billed: no usage to report, and
    // that zero is true rather than missing.
    return { text, usage: null, model: brain.model };
  }

  if (brain.kind === 'openai-compatible') {
    // Alias-aware: ready() accepts either name, so the caller must too —
    // reading only JAN_BASE_URL here would let a brain report itself ready and
    // then fetch 'undefined/chat/completions' on the one night it is needed.
    // Each openai-compatible brain names its own env vars, so two of them can
    // run side by side — a hosted model with real capability AND the box under
    // the desk — without one silently borrowing the other's endpoint.
    const pick = (names) => names.map((n) => env[n]).find((v) => v);
    const base = String(pick(brain.env.base)).replace(/\/+$/, '');
    const key = pick(brain.env.key);
    // Guest conversations and a bearer key travel in this request. Over http
    // they travel readable — one mistyped secret away from broadcasting every
    // ask in cleartext. Localhost is the only exception (the box under the
    // desk); everything remote is https or it is nothing.
    if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(base)) {
      throw new Error(`${brain.id} base URL must be https (or localhost) — refusing to send guest data in cleartext`);
    }
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: model || pick(brain.env.model) || 'default',
        messages: chat,
        max_tokens: maxTokens,
        temperature: 0.7,
        // JSON mode where the vendor supports it. Every OpenAI-compatible
        // provider that implements `response_format` ignores it harmlessly
        // when it does not, and the parse below tolerates plain prose either
        // way — so this can never cost a guest an answer. See `wantJson`.
        ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
      }),
      // A brain behind a home tunnel must never hold a user's turn hostage.
      signal: AbortSignal.timeout(20_000),
    });
    // 6 Sep 2026: carry the STATUS on the error, not just in its text.
    // `brainstate.classify()` reads `err.status` first and only then pattern-
    // matches the message — so a bare `Error("hosted HTTP 402")` was being
    // filed as `transient` and retried every 20 seconds, for ever, silently.
    // A provider that is out of credit or has a dead key is not transient, and
    // the difference is the difference between an alert and an eternal shrug.
    if (!res.ok) {
      const why = await res.text().catch(() => '');
      const err = new Error(`${brain.id} HTTP ${res.status}${why ? ` — ${why.slice(0, 160)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    // Read the SAME way Workers AI is read.
    //
    // This path used to look in exactly one place — `choices[0].message.content`
    // — while the Workers AI path next door used `extractText`, which also
    // knows about content arrays and `reasoning_content`. Reasoning models
    // (deepseek among them) routinely answer with `content` empty and the
    // answer in a sibling field, so a perfectly good, already-PAID-FOR reply
    // was thrown away and the turn fell through to a weaker brain. The brain
    // was billed and the guest got the worse answer: the most expensive
    // possible way to fail. Same reader, both paths, one behaviour.
    const text = extractText(body);
    if (!text) {
      const shape = Object.keys(body?.choices?.[0]?.message ?? body ?? {}).join(',') || 'none';
      throw new Error(`${brain.id} returned nothing (fields: ${shape})`);
    }
    // The vendor's own token counts. Dropping these on the floor is why every
    // DeepSeek day cost $0.00 in our ledger — see console.mjs PRICES.
    return { text, usage: body?.usage ?? null, model: body?.model ?? model ?? pick(brain.env.model) ?? null };
  }

  throw new Error(`${brain.id} has no prose path`);
}

/**
 * Try each configured brain in turn until one answers.
 *
 * `structuredCall` is the Claude path and is only attempted for brains that
 * can actually produce the schema. Everything else falls back to prose, which
 * is the difference between a degraded answer and a dead end.
 *
 * `directive` is an optional Response Directing Manager result (director.mjs)
 * that names which model the hosted brain should use per class. When a
 * directive is present and the hosted brain answers, it picks the model from
 * the directive's first step — letting the director's cost-vs-demand policy
 * select flash for the bulk, kimi for harder prose, without a deploy.
 */
export async function ask(env, { structuredCall, messages, persona, voice, context, style, guard, directive = null }) {
  const tried = [];
  // Prefer brains that are not currently standing down. A brain that just
  // returned "out of credit" will still be out of credit four seconds later,
  // and paying a round trip to rediscover that adds latency to a guest who is
  // already waiting. Cooling brains are demoted, never dropped — see
  // brainstate.plan(); refusing to try them would turn a partial outage into
  // a total one of our own making.
  const state = await loadBrainState(env);
  const { order: healthOrder, healthy, cooling } = planChain(chain(env), state);
  if (cooling && !healthy) console.warn(`[brains] every brain is cooling (${cooling}) — trying anyway`);

  // THE DIRECTOR DECIDES WHO ANSWERS FIRST — but never who answers LAST.
  //
  // A directive names the brains this class of question should go to, cheapest
  // capable first: recommendations to the hosted response brain, money and
  // bookings straight to Claude. Its steps go to the front of the order.
  //
  // Everything else stays behind them, in health order, as a backstop. That is
  // deliberate and it is the whole safety property: the director can be wrong,
  // a vendor can be down, a model name can be retired — and the guest still
  // gets an answer, because the rest of the chain is still there underneath.
  // A router that can strand a turn is worse than no router.
  let order = healthOrder;
  if (directive?.steps?.length) {
    const wanted = [];
    for (const step of directive.steps) {
      const b = healthOrder.find((x) => x.id === step.brain);
      if (b && !wanted.includes(b)) wanted.push(b);
    }
    order = [...wanted, ...healthOrder.filter((b) => !wanted.includes(b))];
  }

  for (const brain of order) {
    const started = Date.now();
    try {
      // A STRUCTURED brain that is not Anthropic. Same schema, same shape of
      // answer, different vendor and a different bill — and, until somebody
      // says otherwise, no ability to act. See canAct().
      if (brain.structured && brain.kind === 'openai-compatible') {
        const modelFor = (directive?.steps ?? []).find((s2) => s2.brain === brain.id)?.model ?? null;
        const out = await callStructuredJson(env, brain, {
          messages,
          // The FULL concierge system prompt, exactly as the Anthropic lane
          // gets it. A brain producing the same schema on a thinner brief
          // would produce the same shape and a worse answer, which is the
          // harder failure to notice.
          system: [persona, voice, context, style].filter(Boolean).join('\n\n'),
          model: modelFor,
        });
        const clean = (guard ?? guardReply)(out.reply?.reply ?? '');
        if (!clean.ok) throw new Error(`${brain.id} output failed the guard`);
        await recordBrainSuccess(env, brain.id, state);
        const mayAct = canAct(brain, env);
        return {
          ...out.reply,
          reply: clean.cleaned,
          // Stripped unless this brain has been explicitly trusted to act.
          // An action makes something happen in the world; a card only says
          // that something already did.
          actions: mayAct ? (out.reply?.actions ?? []) : [],
          _brain: brain.id,
          _tried: tried,
          _ms: Date.now() - started,
          _usage: out.usage,
          _model: out.model,
          // Not degraded: this brain produced the same schema the Anthropic
          // lane produces. It is degraded only when the turn wanted an action
          // it is not allowed to take.
          _degraded: !mayAct && (out.reply?.actions?.length ?? 0) > 0,
        };
      }
      if (brain.structured) {
        // The directive names WHICH Anthropic model this tier deserves —
        // Haiku for the bulk, Opus for money and trouble. Without passing it
        // through, both structured brains would call the same model and the
        // whole bulk lane would be a relabelling exercise that saved nothing.
        const structuredModel =
          (directive?.steps ?? []).find((s2) => s2.brain === brain.id)?.model ?? null;
        const out = await structuredCall(null, structuredModel);
        await recordBrainSuccess(env, brain.id, state);
        // `?? out._model`: when the directive names no model for this brain,
        // structuredModel is null and used to overwrite the model askNum
        // actually chose — so every un-directed Claude turn priced at the
        // default rate whether pickModel had chosen Opus or Sonnet.
        return { ...out, _brain: brain.id, _tried: tried, _ms: Date.now() - started, _model: structuredModel ?? out._model ?? null };
      }
      // The director may name a model for this brain (per-class override).
      // Match the FIRST step naming this brain — not step 0. With the chain
      // reordered, the brain now being tried may be the directive's second or
      // third choice (flash bounced, kimi's turn), and reading step 0 would
      // send the escalation back to the model that just failed.
      const modelOverride =
        brain.kind === 'openai-compatible'
          ? (directive?.steps ?? []).find((s2) => s2.brain === brain.id)?.model ?? null
          : null;
      // JSON only from the hosted lane. Workers AI models are small enough
      // that asking for a wrapper reliably costs more answers than it gains
      // chips, so they stay on plain prose.
      const wantJson = brain.kind === 'openai-compatible';
      const prose = await callProse(env, brain, {
        messages,
        system: proseSystem({ persona, voice, context, style, json: wantJson }),
        model: modelOverride,
        wantJson,
        // Room for the wrapper AND three picks. 700 was set when the object
        // held a reply and three chips; picks add roughly a third again, and a
        // reasoning model spends tokens thinking before it writes any of it.
        // A ceiling that truncates the object is not a saving — the answer is
        // billed either way and then thrown away. See the salvage in
        // readHosted for what truncation actually cost us.
        ...(wantJson ? { maxTokens: 1100 } : {}),
      });
      const read = wantJson ? readHosted(prose.text) : { reply: prose.text, chips: null, picks: null };
      // The guard is NOT optional. It used to be — `guard ? … : passthrough`
      // — which meant any future caller that forgot the argument would ship
      // raw model text to a guest. One forgotten parameter should not be able
      // to undo worker/router.mjs. Callers may pass a stricter guard; nobody
      // gets to pass none.
      const clean = (guard ?? guardReply)(read.reply);
      if (!clean.ok) throw new Error(`${brain.id} output failed the guard`);
      await recordBrainSuccess(env, brain.id, state);
      return {
        reply: clean.cleaned,
        // NEVER a card and NEVER an action from this lane, whatever the model
        // returned. Every card tag is a booking state and every action makes
        // something happen in the world; a prose brain reaches neither. That
        // boundary is unchanged and is not negotiable.
        card: null,
        chips: read.chips,
        // Places, though, are safe: the model supplies a name and a reason,
        // and index.mjs resolves each one against the verified row it was
        // shown. An unmatched pick is dropped, and nothing actionable on a
        // pick ever came from the model. See readHosted.
        picks: read.picks,
        actions: [],
        _brain: brain.id,
        // DEGRADED MEANS "THIS TURN NEEDED SOMETHING WE COULD NOT DO", not
        // "a brain other than Claude answered".
        //
        // The distinction became load-bearing the moment the router started
        // sending everyday traffic here on purpose. The uptime probe treats
        // `degraded: true` as an outage (`downIfBodyMatches` in
        // scripts/uptime.mjs) — so leaving this hard-coded true would have
        // paged us on every correctly-routed recommendation, forever, from
        // the first minute the router worked. A monitor that cries wolf on
        // success is worse than no monitor: it trains you to ignore it on the
        // night it is right.
        //
        // Cards and actions only exist on booking, money, group and trouble
        // turns, and the director sends every one of those to Claude first.
        // So a turn that reached this lane and got prose + chips got
        // everything it was ever going to need. A turn that landed here
        // BECAUSE Claude failed did not — and the director's tier is how we
        // tell those two apart.
        _degraded: !directive || directive.tier === 'critical' || directive.tier === 'complex',
        _tried: tried,
        _ms: Date.now() - started,
        // Carried so the caller can meter a fallback turn exactly as it meters
        // a Claude turn. Same ledger, same units, one truth.
        _usage: prose.usage,
        _model: prose.model,
      };
    } catch (err) {
      const noted = await recordBrainFailure(env, brain.id, err);
      tried.push({ brain: brain.id, class: noted.class, error: String(err?.message ?? err).slice(0, 160) });
      // The class is in the log line on purpose: "claude failed: quota" is a
      // billing job, "claude failed: auth" is a key job, and reading the raw
      // message to work out which one has cost us hours before.
      console.warn(`[brains] ${brain.id} failed (${noted.class}):`, err?.message ?? err);
    }
  }
  const err = new Error('every brain failed');
  err.tried = tried;
  // Whole-chain failure is the one condition that must never be inferred from
  // a status code — /api/num answers 200 with a graceful apology, which is
  // right for the guest and invisible to a monitor. Say it plainly here so the
  // tail, the alerting cron and the operator console all see the same words.
  console.error('[brains] EVERY BRAIN FAILED —', JSON.stringify(tried));
  throw err;
}

/**
 * Ask every configured brain the same tiny question and report who answered.
 *
 * "Six brains are configured" is a claim about a config file. This is the only
 * way to know they are actually alive, and it is cheap enough to run whenever
 * something looks wrong.
 */
export async function probe(env) {
  const out = [];
  for (const brain of BRAINS) {
    if (!brain.ready(env)) {
      out.push({ id: brain.id, ready: false, ok: false, note: 'not configured' });
      continue;
    }
    if (brain.structured) {
      // THIS USED TO REFUSE TO ANSWER, and it refused about the only two
      // brains that have ever taken the product down.
      //
      // It read: `ok: null, note: 'primary — not probed (a probe costs a real
      // turn)'`, on the reasoning that "the chain proves itself in production
      // every time it answers". On 31 Aug 2026 both Anthropic brains failed at
      // 13:33 and no guest asked anything for the next two hours, so the chain
      // proved nothing, the cooldown lapsed, and health went green on a timer.
      // `/api/brains?probe=1` — the one diagnostic reachable by hand during
      // that window — would have reported `ok: null` for both.
      //
      // The caution was right and the price was wrong: it assumed the probe
      // below, a 40-token reply behind the full concierge system prompt. A
      // reachability check needs one token and no prompt at all. See
      // worker/brainprobe.mjs, which is the same call the cron makes — so this
      // endpoint and the automatic check can never disagree about a brain.
      const { probeBrain } = await import('./brainprobe.mjs');
      const t0 = Date.now();
      const r = await probeBrain(env, brain.id);
      out.push(r.probed
        ? { id: brain.id, ready: true, ok: r.ok, ms: r.ms, ...(r.ok ? {} : { error: r.error, class: r.class }) }
        : { id: brain.id, ready: true, ok: null, note: r.reason, ms: Date.now() - t0 });
      continue;
    }
    const t0 = Date.now();
    try {
      const probe = await callProse(env, brain, {
        messages: [{ role: 'user', content: 'Say hello in under 10 words.' }],
        system: 'You are a warm concierge. Reply in under 10 words, plain prose.',
        // 40 was too mean for a reasoning model: it thinks first, and a
        // ceiling that stops it mid-thought produced an empty completion that
        // this endpoint then reported as a dead brain. 256 is still trivial
        // and leaves room for a short answer after the thinking.
        maxTokens: 256,
      });
      out.push({ id: brain.id, ready: true, ok: true, ms: Date.now() - t0, sample: probe.text.slice(0, 90) });
    } catch (err) {
      out.push({ id: brain.id, ready: true, ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 140) });
    }
  }
  return out;
}

/**
 * Can this brain name places the app will render as cards?
 *
 * Not the same question as `structured`. A structured brain produces the whole
 * REPLY_SCHEMA — picks, cards, actions, bookings. The hosted JSON lane
 * produces picks and nothing else that matters, which is enough for a
 * recommendation to arrive with a link, a map and a phone number instead of as
 * a paragraph. Workers AI stays on plain prose: those models are small enough
 * that asking for a wrapper reliably costs more answers than it gains.
 *
 * Stated as a function so /api/brains can report it, because "the backup can
 * still show you a restaurant card" is the single most useful thing to know
 * about the chain on a night the top of it is down.
 */
/**
 * May this brain's actions actually run?
 *
 * An action is the only thing a brain produces that changes the world — a
 * table requested, a delivery placed, a fact written to somebody's record.
 * Claude has always been the only brain allowed to reach them, and that stays
 * true unless somebody deliberately says otherwise for a specific brain.
 *
 * Stated as a function rather than a field so the answer can depend on env:
 * turning it on is a secret, not a deploy, which means it can also be turned
 * off in the same instant if the answers are wrong.
 */
export const canAct = (brain, env = {}) => {
  if (!brain?.structured) return false;
  if (brain.kind === 'anthropic') return true;
  if (brain.id === 'openai') return env.NUM_OPENAI_ACTIONS === '1';
  return false;
};

export const emitsPicks = (brain) =>
  !!brain && (brain.structured === true || brain.kind === 'openai-compatible');

/** For the operator dashboard: what is wired up, and what each one is for. */
export const roster = (env) =>
  BRAINS.map((b) => ({
    id: b.id,
    label: b.label,
    kind: b.kind,
    // A model NAME is identity, not a secret — and for env-configured brains
    // it was invisible: /api/brains said `model: null` for `hosted`, so during
    // the 10 Aug outage nobody could say WHICH vendor was answering guests
    // without reading Cloudflare secrets nobody can read. The key stays
    // secret; who we are talking to must never be.
    model: b.model ?? (b.env?.model ? (b.env.model.map((n) => env[n]).find((v) => v) ?? null) : null),
    structured: b.structured,
    picks: emitsPicks(b),
    // Said out loud on the roster because "it can produce a booking card" and
    // "it is allowed to actually request the booking" are different claims,
    // and on a bad night the difference is the whole question.
    can_act: canAct(b, env),
    ready: b.ready(env),
    note: b.note ?? null,
    in_chain: chain(env).some((c) => c.id === b.id),
  }));
