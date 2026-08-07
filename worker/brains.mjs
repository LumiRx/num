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
 * What a prose brain is allowed to be. It has the voice and the local
 * knowledge but none of the machinery, so the one thing it must never do is
 * imply a booking exists.
 */
function proseSystem({ persona, voice, context, style }) {
  return [
    persona,
    voice,
    context,
    style,
    'IMPORTANT — you are answering while the main system is unavailable. You can recommend, explain, compare and plan, and you should do all of that well. ' +
      'You CANNOT book, hold, cancel, or change anything, and you must not imply that you have. No "I\'ve booked", no "that\'s held", no confirmation numbers. ' +
      'If they want something actually booked, say plainly that you will get it locked in shortly and ask them to say the word again in a minute. ' +
      'Reply in plain prose. Never output JSON, brackets, or role labels.',
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
  return '';
}

/** Workers AI and OpenAI-compatible endpoints both take chat messages. */
async function callProse(env, brain, { messages, system, maxTokens = 700 }) {
  const chat = [{ role: 'system', content: system }, ...messages.slice(-8)];

  if (brain.kind === 'workers-ai') {
    const res = await env.AI.run(brain.model, { messages: chat, max_tokens: maxTokens });
    const text = extractText(res);
    if (!text) throw new Error(`${brain.id} returned nothing (keys: ${Object.keys(res ?? {}).join(',') || 'none'})`);
    return text;
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
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: pick(brain.env.model) || 'default',
        messages: chat,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
      // A brain behind a home tunnel must never hold a user's turn hostage.
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${brain.id} HTTP ${res.status}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error(`${brain.id} returned nothing`);
    return String(text).trim();
  }

  throw new Error(`${brain.id} has no prose path`);
}

/**
 * Try each configured brain in turn until one answers.
 *
 * `structuredCall` is the Claude path and is only attempted for brains that
 * can actually produce the schema. Everything else falls back to prose, which
 * is the difference between a degraded answer and a dead end.
 */
export async function ask(env, { structuredCall, messages, persona, voice, context, style, guard }) {
  const tried = [];
  // Prefer brains that are not currently standing down. A brain that just
  // returned "out of credit" will still be out of credit four seconds later,
  // and paying a round trip to rediscover that adds latency to a guest who is
  // already waiting. Cooling brains are demoted, never dropped — see
  // brainstate.plan(); refusing to try them would turn a partial outage into
  // a total one of our own making.
  const state = await loadBrainState(env);
  const { order, healthy, cooling } = planChain(chain(env), state);
  if (cooling && !healthy) console.warn(`[brains] every brain is cooling (${cooling}) — trying anyway`);

  for (const brain of order) {
    const started = Date.now();
    try {
      if (brain.structured) {
        const out = await structuredCall();
        await recordBrainSuccess(env, brain.id, state);
        return { ...out, _brain: brain.id, _tried: tried, _ms: Date.now() - started };
      }
      const text = await callProse(env, brain, { messages, system: proseSystem({ persona, voice, context, style }) });
      const clean = guard ? guard(text) : { ok: true, cleaned: text };
      if (!clean.ok) throw new Error(`${brain.id} output failed the guard`);
      await recordBrainSuccess(env, brain.id, state);
      return {
        reply: clean.cleaned,
        card: null,
        chips: null,
        actions: [],
        _brain: brain.id,
        _degraded: true,
        _tried: tried,
        _ms: Date.now() - started,
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
      // Probing Claude means paying for a real turn; the chain proves itself in
      // production every time it answers.
      out.push({ id: brain.id, ready: true, ok: null, note: 'primary — not probed (a probe costs a real turn)' });
      continue;
    }
    const t0 = Date.now();
    try {
      const text = await callProse(env, brain, {
        messages: [{ role: 'user', content: 'Say hello in under 10 words.' }],
        system: 'You are a warm concierge. Reply in under 10 words, plain prose.',
        maxTokens: 40,
      });
      out.push({ id: brain.id, ready: true, ok: true, ms: Date.now() - t0, sample: text.slice(0, 90) });
    } catch (err) {
      out.push({ id: brain.id, ready: true, ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 140) });
    }
  }
  return out;
}

/** For the operator dashboard: what is wired up, and what each one is for. */
export const roster = (env) =>
  BRAINS.map((b) => ({
    id: b.id,
    label: b.label,
    kind: b.kind,
    model: b.model ?? null,
    structured: b.structured,
    ready: b.ready(env),
    note: b.note ?? null,
    in_chain: chain(env).some((c) => c.id === b.id),
  }));
