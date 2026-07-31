# Brains — more than one, so a turn never dies

`worker/brains.mjs`. Six are live today; `GET /api/brains` says which.

| | Brain | Structured? | Needs |
|---|---|---|---|
| 1 | **Claude Opus 5** | **yes** — books, cards, chips, specialists | `ANTHROPIC_API_KEY` |
| 2 | GPT-OSS 120B | prose | nothing |
| 3 | Llama 4 Scout 17B | prose | nothing |
| 4 | Llama 3.3 70B | prose | nothing |
| 5 | Qwen3 30B | prose | nothing |
| 6 | Mistral Small 24B | prose | nothing |
| 7 | **Jan / Ollama / anything** | prose | `JAN_BASE_URL` |

Brains 2–6 are open models already running on **Cloudflare's edge**. Nothing to
download, nothing to host, no second account, no key — they are reachable
through the `AI` binding the Worker already has. That is the cheapest possible
answer to "never run out of tokens", and it was already sitting there.

## Structured vs prose — the distinction that matters

Only Claude produces the JSON schema, so only Claude can create a booking, a
card or a chip. A prose brain writes a genuinely good answer and **nothing
else**, and it is explicitly told not to imply otherwise — no "I've booked", no
"that's held", no confirmation numbers. It offers to lock it in once the main
system is back.

A slightly less capable answer beats an outage. An answer that invents a
reservation is worse than either.

Replies from a fallback carry `degraded: true` and the brain's id, so the app
and the operator both know what answered.

## Verified

Forcing the chain to skip Claude (`NUM_BRAIN_ORDER`) on a preview version with
no live traffic:

```
brain: gpt-oss-120b   degraded: true   4.6s
"A rooftop vibe, you say — I'd steer you to Vertigo & Moon Bar at the Banyan
 Tree… If you'd like me to lock a table for tonight, just give me the word"
```

Warm, useful, and honest about what it cannot do. Claude, unchanged, still
returns `add_booking` + `service` + `remember`.

**One bug this caught:** Workers AI is not one response shape. Chat models
return `{response}`; the reasoning models (gpt-oss and friends) return an
`output` array where the answer is the last message and everything before it is
chain-of-thought. Reading only `.response` made a perfectly healthy 120B model
look dead — and it was silently skipped in favour of a model **3× slower**.

## Jan, Ollama, and anything else

One adapter covers every OpenAI-compatible server, which is nearly all of them:

```bash
cd . && npx wrangler secret put JAN_BASE_URL --config wrangler.app.jsonc
#   Jan:        https://<your-tunnel>/v1
#   Ollama:     https://<your-tunnel>/v1
#   OpenRouter: https://openrouter.ai/api/v1
#   Groq:       https://api.groq.com/openai/v1
npx wrangler secret put JAN_MODEL   --config wrangler.app.jsonc   # e.g. llama3.3:70b
npx wrangler secret put JAN_API_KEY --config wrangler.app.jsonc   # if the host wants one
```

### The catch with running it on your own machine

**A Cloudflare Worker cannot reach `localhost`.** Jan and Ollama listen on your
laptop; the Worker runs in Cloudflare's network. Pointing `JAN_BASE_URL` at
`http://localhost:1337/v1` will never work, from anywhere.

To use your own machine you need a public hostname for it, and since you are
already on Cloudflare the clean way is a tunnel:

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create num-brain
cloudflared tunnel route dns num-brain brain.itsnum.com
cloudflared tunnel run --url http://localhost:11434 num-brain   # Ollama's port
# Jan's local server is 1337 by default
```

Then `JAN_BASE_URL=https://brain.itsnum.com/v1`.

**Be honest about what that is.** Routing user traffic through a laptop means
the app depends on that laptop being awake, plugged in, and on a good
connection. It is a fine overflow brain and a great way to test a model before
paying for it. It is not somewhere to put your primary. If you want
self-hosted *serving*, rent a GPU (Runpod, Together, Fireworks) and point the
same `JAN_BASE_URL` at it — no code change.

## Changing the order

```bash
npx wrangler secret put NUM_BRAIN_ORDER --config wrangler.app.jsonc
# e.g. gpt-oss-120b,claude   → open model first, Claude only as backup
```

Useful during a spend freeze: put a free brain first and the bill stops, at the
cost of bookings until you switch back.

## Checking they are actually alive

```bash
curl -s https://app.itsnum.com/api/brains | jq
curl -s -H "X-Admin-Key: $ADMIN_KEY" 'https://app.itsnum.com/api/brains?probe=1' | jq
```

The probe asks every prose brain a real question and reports who answered, how
fast, and what they said. "Six brains are configured" is a claim about a config
file; the probe is the only thing that knows.
