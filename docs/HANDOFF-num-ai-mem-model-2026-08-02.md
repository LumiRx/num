# num-ai — dead model, dead request log, dead relay (2026-08-02)

## What was wrong

Cloudflare retired `@cf/meta/llama-3.1-8b-instruct` on **30 May 2026**. `ai/` used it twice:
`SMALL_MODEL` (tier t1) and `MEM_MODEL` (the guest brain). Every call threw, every throw was
caught and `console.log`'d, and nothing else happened — so the platform looked healthy while
two features were dead for two months.

The evidence, from `num_llm_calls`:

```
tier t1, ok=1 →  2 calls, both on 2026-07-30 between 00:30:46 and 00:31:30
tier t1, ok=0 → 15 calls, everything before and everything after
```

Those two successes are the entire 90-minute window in which the corrected id was live.
Nothing else about the code changed. That is the diagnosis.

## Why it kept coming back

It was fixed on 29 July **over the Cloudflare script API**, not in this repo. Deploys built
from this tree on 30 Jul (v27) and 1 Aug (v34) put the retired id straight back, twice —
the same class of loss AGENTS.md already records for member DMs.

Two other things were reverted with it and had also only ever existed as API patches:

- **`logRequest()`** — the writer for `num_requests` / `num_unmet_demand`. That table had
  **zero rows in three days**. Intent, fulfilment and response time are what the demand and
  supply-gap views are built on.
- **`/internal/push` + `linePush()`** — the path num-biz uses to send anything on LINE:
  booking confirmations to venues, and the watchman's own alerts. Without it the outbox
  cannot deliver, so **a failure alarm cannot reach anyone.**

All three now live in this commit. That is the point of the commit.

## What changed

| File | Change |
|---|---|
| `ai/router.js` | `SMALL_MODEL` → `…-instruct-fast` |
| `ai/worker.js` | `MEM_MODEL` → `…-instruct-fast` |
| `ai/worker.js` | `updateMemory()` falls back to `BIG_MODEL` and records every outcome to `num_llm_calls` under tier `mem` |
| `ai/worker.js` | `logRequest()` restored and wired into all three exits of `ask()` |
| `ai/worker.js` | `relayEq()`, `linePush()`, `POST /internal/push` restored |
| `ai/models.test.mjs` | **new** — fails the build if a retired id ever returns |

Tests: 15 → 18, all green.

## The part worth keeping

The bug was never hard. It was invisible because `updateMemory()` ended in
`catch(e){ console.log('memory', …) }` — which made "the model is dead" and "this guest said
nothing worth remembering" produce identical silence.

`updateMemory()` now writes tier `mem` rows to `num_llm_calls` on **every** outcome, tagged
`ok` / `ok_fallback` / `no_json` / `bad_json` / `ai_error`, with the model's reply *length*
but never its content — MEM_SYS is strict about what may be stored and a debug column is not
a way around it. `num-biz` runs a watchman every 10 minutes that alerts on any tier called
without a single success, so this failure can now raise its own hand.

`ai/models.test.mjs` is the same idea applied to the revert: a comment would have been
reverted just as quietly as the fix was.

## Drift to be aware of

Live num-ai versions **35, 36 and 37** were deployed by an assistant session on 2 Aug via the
script API, straight to 100% — a violation of AGENTS.md §3 that should not be repeated, and
the reason `wrangler` will warn "last updated via the script API" on the next deploy. Their
content is exactly v34 plus the four changes above, so **shipping this branch supersedes them
with a reviewed, tested, tagged equivalent** and returns git to being the source of truth.
`ai/.previous-version` and `ai/.staged-version` were written before those API deploys and are
therefore stale — do not trust `release.sh rollback` until after the next clean `ship`.

## Still open

- **Guest memory is fixed but unproven.** A guest at 20:44 UTC got a working t1 reply and
  still no brain — so the retired model was only half the fault. The `mem` rows will name the
  remaining cause on the next inbound message.
- **The proof ladder has no fuel**: 3 guests at L1, none at L2/L3, `consented = 0`, one test
  credential and no live ones. Nothing can be attested to 5arz until a guest is asked and
  agrees. That is a product decision about where consent sits in the guest flow.
- `num-biz` now holds a `NUM_AI` service binding to this Worker and a `*/10` cron.
