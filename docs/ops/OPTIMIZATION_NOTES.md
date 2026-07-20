# NUM by 5arz — Optimization Pass (2026-07-17)

Pre-traffic audit of the live request path. Six issues found, six fixed, 95 tests green. Two were correctness bugs that would have shipped into the pilot; one was a security hole.

---

## 1 · Event-loop blocking — every passenger queued behind the last one 🔴→✅

**Found:** routes were `async def` while everything under them (Anthropic SDK, Supabase SDK) blocks. A blocking call inside an async route occupies the event loop, so with one worker, message #2 waits for message #1's full LLM round-trip. At 30–40 cars that's a queue, not a service.

**Fixed:** Twilio routes are now sync `def` (FastAPI threadpools them automatically). LINE and WeChat must stay async (they `await` the raw body for signature checks), so their blocking work goes through `run_in_threadpool`.

**Impact:** concurrency goes from ~1 conversation at a time to the threadpool width. This was the single biggest risk in the build.

## 2 · The AI had no conversation memory *within* a conversation 🔴→✅

**Found:** `generate_reply` sent only the current message. Durable facts were injected, but the live thread wasn't — so "what about tomorrow?" or "book the second one" had no referent. Every message was turn one.

**Fixed:** `persistence.recent_turns()` loads the last 12 turns (oldest-first, blank rows dropped, consecutive same-role rows merged since the API rejects those) and they're prepended to the prompt. History is read *before* the current message is logged, so it never duplicates.

**Impact:** the product now actually behaves like a conversation. This was a bug, not a tuning knob.

## 3 · Intent classification sat on the critical path for nothing ⚠️→✅

**Found:** a Haiku call ran *before* the reply — but its label is only used for analytics; the concierge never receives it. Every passenger paid ~0.5s for a log field.

**Fixed:** intent, history, and memory now run concurrently in a `ThreadPoolExecutor`; intent is collected after the reply is generated (it finishes long before). 

**Impact:** ~0.5s off every single message, no behavior change.

## 4 · No ceiling on turn latency — channel timeouts were reachable ⚠️→✅

**Found:** the tool loop allowed 5 Sonnet round-trips. Worst case ran past Twilio's ~15s webhook abandon and far past WeChat's ~5s passive-reply window — the passenger would see *nothing*.

**Fixed:** max tool turns 5 → 3 (covers every real flow: search → refine → answer) plus a 12s wall-clock budget. On budget-exceeded the model returns whatever text it has rather than continuing to call tools.

## 5 · Twilio webhooks accepted unsigned requests 🔴→✅ (security)

**Found:** `/sms` and `/whatsapp` processed any POST. LINE verified HMAC and WeChat verified SHA-1, but Twilio's `X-Twilio-Signature` was never checked — the June readiness doc wrongly recorded this as "Twilio handles it." Anyone who discovered the URL could fabricate conversations, pollute the pilot's data, and spend LLM budget.

**Fixed:** `twilio_adapter.verify_request()` validates the signature (rebuilding the `https://` URL Twilio signed, since Railway terminates TLS at its proxy). Rejections return empty TwiML — a probe learns nothing and Twilio doesn't retry. Fails open **only** when `TWILIO_AUTH_TOKEN` is unset (local dev), with a loud warning.

## 6 · A database hiccup meant silence ⚠️→✅

**Found:** any unhandled exception produced a 500; the passenger got nothing back at all.

**Fixed:** every channel now calls `handle_inbound_safe()`, which catches everything and returns the localized fallback — script-detected from the raw inbound text, so a Thai user gets the Thai apology even when the DB storing their preference is unreachable. **Verified with the DB fully down: 200 + correct Thai reply.**

## Also: 3 event inserts → 1

`persistence.log_events()` batches the per-turn analytics into a single insert (3 sequential HTTP hops → 1).

---

## Expected turn shape now

| Stage | Before | After |
|---|---|---|
| identity + conversation | 2–3 DB | unchanged |
| intent (Haiku) | ~0.5s **serial** | overlapped (free) |
| history + memory | memory only, serial | both, parallel |
| reply (Sonnet + tools) | ≤5 turns, unbounded | ≤3 turns, ≤12s |
| telemetry | 7 round trips | 5 |
| concurrency | ~1 at a time | threadpool-wide |
| DB down | 500 / silence | localized fallback |

## Deliberately deferred (do when data says so)

- **Fire-and-forget telemetry.** Moving the post-reply writes off the response path saves a few hundred ms more, but risks losing cost rows on shutdown. Revisit with real latency numbers.
- **Inbound dedupe.** Twilio retries on timeout; with the budget in place this is now unlikely. If duplicates appear, key on Twilio's `MessageSid`.
- **Prompt caching** on the system prompt (it's stable and re-sent every turn) — worthwhile once volume justifies it.
- **Async SDK migration.** The threadpool is the right answer at pilot scale; going fully async is a bigger change to buy headroom we don't need yet.
- **Redis conversation cache** — only if `recent_turns` shows up hot in real traffic.
