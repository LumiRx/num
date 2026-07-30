# Launch readiness — measured, not estimated

Everything below was run against the live Worker on 30 Jul 2026 and the numbers
came out of `num_usage` and real load runs, not from reasoning about limits.

## Can it take 100 users signing up at once?

**Yes.** 100 simultaneous signups plus everything a new user immediately does:

| Step (100 users at once) | Result |
|---|---|
| `POST /api/social/me` ×100 | 100/100 OK · p50 **1.87s** · p95 2.64s |
| `POST /api/social/plan` ×100 | 100/100 OK · p50 1.82s · p95 2.14s |
| `POST /api/social/plan/item` ×100 | 100/100 OK · p50 1.39s |
| `GET` friends + plans ×200 | 200/200 OK · p50 0.78s |
| **500 requests total** | **zero failures, 9.3s wall clock** |

Signup was **3.6s** before this pass. It ran nine sequential D1 queries; folding
them into one read and one batched write halved it. D1 round-trip latency is
essentially the whole cost of that endpoint, so the shape of the function
matters more than anything inside it.

## What it costs — real token counts

Measured per turn on Claude Opus 5 with a warm prompt cache:

| | Before this pass | Now |
|---|---|---|
| Output tokens | 950 | **744** |
| Latency | 15.5s | **12.8s** |
| Cost per turn | $0.0575 | **$0.0258** |

Two things were wrong and are fixed:

1. **`max_tokens` was 4096** — about 3× what a real turn needs. The model
   rambled into the action payloads. Output tokens are generated serially, so
   this was both the biggest slice of the bill *and* the reason a reply took
   15 seconds.
2. **The prompt cache looked broken** (`cache_read: 0` on every row). It was
   not: concurrent cold requests all race to write. Sequential requests read
   4,516 cached tokens every time. Worth knowing, because a burst of first-ever
   traffic pays cache-write prices on all of it.

At $0.0258/turn: **100 daily-active users × ~12 turns/day ≈ $31/day (~$930/mo)**
in model spend. The admin dashboard shows this live and projects it.

## The honest weak points

**1. 12.8s per reply is the biggest problem, and it is not really a model
problem.** Sonnet 5 measured 11.2s against Opus's 12.8s — barely different, and
its cost came out *higher* only because the cache was cold for a different
model. Latency tracks the ~740 output tokens through a structured-output
grammar. To go materially faster you cut what the model writes, not which model
writes it. `NUM_MODEL` is now a Worker var so the trade is flippable in a
minute without a deploy of new code.

**2. Rate limiting is not a hard guarantee.** Cloudflare documents the
rate-limiting binding as "permissive, eventually consistent… not an accurate
accounting system," and 30 spaced probes never tripped it. The only hard ceiling
is the Anthropic spend cap. Set one before launch.

**3. `POST /api/social/*` was completely unrate-limited** until this pass —
signup, invite minting and plan writes could be hammered. Now behind the same
per-IP limiter as `/api/num`. Reads stay free because every foreground app polls
one a minute.

**4. Per-IP limiting punishes shared IPs.** 12 requests/60s per IP is right for
100 users on 100 phones, and wrong for a conference, an office, or a hotel where
everyone is behind one NAT. If the first demo is a room full of people on one
wifi, raise it.

**5. No SMS provider.** Numbers are saved but explicitly **not** verified, and
the UI says so. Three secrets (`TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`) turn
it on with no code change.

**6. Everything is one Worker and one D1.** Fine at this size; D1's write path
is the thing to watch first if signups spike.

## What to do before you publish

| | |
|---|---|
| Set an Anthropic spend cap | The only hard cost ceiling that exists |
| `wrangler secret put ADMIN_KEY --config wrangler.app.jsonc` | The operator dashboard is dark until you do — the key is yours to choose and it is checked server-side on every request |
| Decide on `NUM_MODEL` | Opus reads better; the latency is near-identical either way |
| Add Twilio if verified numbers matter for the demo | Otherwise identity is claimed, not proved — and consent still gates all data sharing, so the product works either way |
| Raise the per-IP limit if demoing on shared wifi | `wrangler.app.jsonc` → `ratelimits.simple.limit` |

## Dashboards

- **Operator** — `/?admin=<ADMIN_KEY>`. Signups, verified, active 24h, invites
  sent/joined, group plans, events, RSVPs, referrals, the open capability gaps
  Num flagged, newest signups, and measured AI spend by day and lane with a
  100-DAU projection. No link points at it; the key is verified server-side.
- **Business** — in the app under YOU → Business. Scoped by
  `num_place_owners`: you see the listings you proved you own and nothing else,
  checked on every route. Edit the public phone/website/area, see your events,
  and see the requests Num could not fulfil that mentioned you — labelled as
  demand, not bookings, because that is what they are.
