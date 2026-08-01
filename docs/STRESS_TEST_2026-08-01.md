# Stress test + surface check — 2026-08-01

Run from Dre's machine against live production. Method: direct probes of every
API route the frontends call (enumerated from `worker/*.mjs` + `src/`), then
25-way concurrent load per surface.

## Load (25 concurrent requests each, cold)

| Surface | Result | p50 | p95 | max |
|---|---|---|---|---|
| app.itsnum.com PWA shell | 25×200, 0 errors | 1.2s | 2.3s | 2.3s |
| itsnum.com `/api/places` (D1) | 25×200, 0 errors | 1.7s | 2.7s | 2.7s |
| num-ai worker | 25×200, 0 errors | 1.6s | 2.5s | 2.5s |
| Railway FastAPI `/healthz` | 15×200, 0 errors | 0.2s | 1.2s | 1.2s |

No failures, no rate-limit trips, no timeouts under burst. Latency is fine for
a directory; the p50s above are under 25-way burst — single-request p50s are
~150–800ms.

## Endpoint surface — what the app's buttons actually hit

**Working (reads):**

| Endpoint | Status | Note |
|---|---|---|
| `GET /api/version` | 200 | v0.8.78, model claude-opus-5 |
| `GET /api/places?dest=…` | 200 | Edinburgh + Phuket both serve |
| `GET /` (PWA shell) | 200 | |
| `GET /c/ID?ref=CODE` | 302 | share-link fix verified by 07-31 session |
| num-ai `GET /` | 200 | |

**Failing — ALL because of the num-db size cap, not code:**

| Endpoint / button | Status | Meaning |
|---|---|---|
| `POST /api/social/me` (signup) | 500 masked | `D1_ERROR: Exceeded maximum DB size` |
| connect / invites / plans / stars / tabs / DMs | same | every write path |
| num-ai guest memory / signup | silent | try/catch swallows the same error |

**Correctly rejecting bad input (routes alive, validation works):**

| Endpoint | Status | |
|---|---|---|
| `POST /api/events/rsvp` (junk id) | 404 "unknown invite" | ✓ |
| `POST /api/push/subscribe` (no sub) | 400 "subscription required" | ✓ |
| `GET /api/availability?member=junk` | 404 | ✓ |

**Security posture:**

| Check | Result |
|---|---|
| num-ai unsigned webhook | **403 "bad signature"** ✓ |
| app unsigned write | reaches D1 (auth = member ID — SEC-001, unchanged, migration written) |
| Railway unsigned Twilio POST | **200 — fails open.** `TWILIO_AUTH_TOKEN` unset. This directly violates CTO standing rule §8 "every webhook verifies a signature — no assume-valid branch, ever" (`docs/cto-handoff-duke.md`). Run `ops/set_twilio_secrets.sh` (branch `backend-fastapi`) before fixing that stack's Anthropic key. |

## Button verdict

Every button wired to a **read** works. Every button wired to a **write** fails
with the generic "didn't go through" message — one cause, the D1 size cap, not
N bugs. **There is no point testing write-buttons individually, and no point
"fixing" them, until the `num-core` import runs.** After the import, the write
column above is the exact re-test checklist (plus: close/reopen the app once so
the new service worker activates before QR re-test).

Not testable without a device: LINE flows end-to-end (needs a signed webhook),
push delivery (VAPID mismatch open item), scanner (Android-only, not wired).

## Suites at time of test

`ai/` 15 ✓ · `sw.test.mjs` 22 (not re-run here) · `capability.test.mjs` 24 (not
re-run here) · FastAPI backend 129 ✓ (its own branch). None in CI — still open.

## What shipped alongside this test

- `AGENTS.md` — cross-machine session rules (root of repo)
- `ai/release.sh` — staged releases for num-ai; first release went through it
  (staged `3f296912` at 0% → preview probed → promoted 100%)
- Merge `9338e8e` reconciling `guessed` + `unsupported` location models —
  **restored member DMs that raw deploys had removed from live**
- Tag `num-ai/2026-08-01-merged`
