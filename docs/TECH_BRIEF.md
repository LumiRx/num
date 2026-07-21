# NUM by 5arz — Technical Brief for Duke (CTO)

**Purpose:** get you oriented on the whole system in ten minutes — what it is, how it's built, what's live, and where the four open seams are. Everything here is running code, not a plan.

---

## 1 · What it is, in one breath

A multilingual AI concierge that lives in WhatsApp / LINE / WeChat / SMS. A traveler texts; NUM resolves identity + language + intent, recalls what it knows about them, calls Claude with a tool loop (search the tenant's vendor catalogue, create a whale lead, escalate to a human, save a memory), replies in their language in <3s, and logs cost + outcome per turn. Multi-tenant from row one, so market #2 is config, not a rebuild.

## 2 · Stack (deliberately small)

| Layer | Choice | Why |
|---|---|---|
| API | Python 3.12 · FastAPI | Sync routes → threadpool so blocking SDKs don't serialize traffic |
| LLM | Claude Sonnet (reply) + Haiku (intent) | Anthropic-only; no second AI vendor |
| Data | Supabase (Postgres + pgvector + PostGIS) | RLS on every table; ap-southeast-1 (Singapore) for TH latency |
| Memory | recency+confidence recall (default) · pgvector optional | Works with **zero** embedding vendor; loads a user's live facts and lets Claude judge relevance. pgvector switches on if `OPENAI_API_KEY` is ever set, and falls back on failure |
| Channels | Twilio (SMS+WA), LINE SDK v3, WeChat (stdlib XML) | All signature-verified inbound |
| Host | Railway (Nixpacks) | `railway.json` builds from `apps/api/requirements.txt`; healthcheck `/healthz` |
| Alerts | Slack incoming webhook (#num-ops) | whale-lead + escalation pings |

No Redis, no queue, no ORM. Added only when data demands it.

## 3 · Request path (the hot loop)

`channel webhook → verify signature → handle_inbound_safe() → identity → [PDPA delete short-circuit] → scrub PII → detect language → { intent (Haiku) ∥ history read ∥ memory recall } in a threadpool → concierge tool loop (≤3 turns, ≤12s budget) → reply → log messages + cost + events (batched) → [first-contact consent notice] → TwiML/XML back`

Key properties, all tested:
- **Never blocks the loop** — sync routes / `run_in_threadpool`.
- **Never silent** — `handle_inbound_safe` returns a localized fallback (script-detected from raw text) if anything throws. Verified: DB fully down → Thai user still gets a Thai apology + HTTP 200.
- **Never times out the channel** — 12s wall-clock budget returns partial text before Twilio (~15s) / WeChat (~5s) abandon.
- **Never invents vendors** — `search_vendors` returns only approved catalogue rows; empty result tells the model to say so.

## 4 · Repo map

```
apps/api/
  main.py                 FastAPI app + lifespan (Sentry optional)
  settings.py             pydantic-settings — every env var
  routers/                twilio · line · wechat · qr · healthz
  adapters/               channel parse + signature verify + reply
  services/
    pipeline.py           handle_inbound[_safe] — the orchestrator
    identity.py           (channel,handle) → user_uuid, tenant from QR source
    concierge.py          Sonnet tool loop (history, budget, fallback)
    intent_router.py      Haiku 6-class classifier
    memory.py             recency recall + optional pgvector
    persistence.py        conversations · messages · llm_usage · events · recent_turns
    lang_detect.py        zero-LLM script detector
    pii_scrubber.py       card / passport / Thai national ID regex
    privacy.py            PDPA consent log + right-to-erasure
    strings.py            localized consent/fallback/delete (9 langs)
    costing.py            per-call USD from token counts
    alerts.py             Slack #num-ops
  tools/                  search_vendors · create_lead · escalate · save_memory
  prompts/system_prompt.txt
apps/workers/embed.py     memory embedding backfill (only if pgvector enabled)
apps/dashboard/           mobile console prototype (7 roles) + IA + spec
apps/site/index.html      the 5arz.com/num landing page
infra/supabase/migrations 0001–0006 (also combined: outputs/NUM_SCHEMA_ALL.sql)
tests/                    95 tests, offline (SDKs stubbed)
docs/                     architecture · business · FULL_FLOW · LAUNCH_READINESS · ops/*
```

## 5 · What's live right now

- **Deployed:** `https://web-production-d6ed4.up.railway.app` — `/healthz` green. `/healthz/db` goes green the moment the Supabase service-role key resolves to the right project (see §7).
- **DB:** Supabase project `num` (`txabrxbobyxznkgarpkc`), migrations 0001–0006 applied, RLS on, security advisors clean, Phuket tenant seeded.
- **Tests:** `python -m pytest tests/ -q` → 95 passing, fully offline.
- **Console:** clickable 7-role mobile prototype at `apps/dashboard/mobile_prototype.html` (open on a phone).

## 6 · The four open seams (next backend sprint)

The console's buttons are designed; these make them write to the DB:
1. **Lead assign** — `leads.handed_off_to` + the assign action (routes to specialist by vertical, Slack ping). ~½ day.
2. **Lead fee + settlement** — `leads.fee_amount` + a settlement view = 5arz PayRails ledger v0. ~1 day.
3. **Approval gate** — `vendors.status` (pending→approved) so nothing reaches the AI unvetted = 5arz Verify v0. ~½ day.
4. **Digest worker** — `apps/workers/digest.py`, Monday 08:00 KPI email. ~1 day.

Deferred (documented in `docs/ops/OPTIMIZATION_NOTES.md`): fire-and-forget telemetry, prompt caching, inbound dedupe, async SDK migration, Redis conversation cache — all "when real latency data says so," not before.

## 7 · Run it locally (5 minutes)

```bash
git clone <repo>              # ask Dre for access under the 5arz GitHub
cd num
python -m venv .venv && source .venv/bin/activate
pip install -r apps/api/requirements.txt
cp .env.example .env          # fill ANTHROPIC_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
pytest tests/ -q             # 95 green, no keys needed
uvicorn apps.api.main:app --reload
curl -X POST localhost:8000/sms -d "From=+15551234567&Body=hi"   # real Claude reply
```

**One gotcha we hit and you should know:** there are currently two Supabase accounts under the "5arz" name (org-level naming collision) and the Railway login is `info@thatislumi.com` while GitHub is `LumiRx`. The `SUPABASE_SERVICE_ROLE_KEY` must come from the **same project** the app points `SUPABASE_URL` at, or you get a 401 "Invalid API key" that looks like a bad key but is actually a wrong-project key. **Consolidating to one owner login for 5arz before the pilot is the single most valuable ops cleanup** — flagging it for you as CTO.

## 8 · Deploy + runbook

Full click-path in `docs/ops/DEPLOY_RUNBOOK.md`. Short version: Railway builds on push, env vars are the gate, `/healthz/db` is the keep-alive endpoint (point an uptime pinger at it — keeps Railway warm AND stops Supabase free-tier auto-pause). Channels are account tasks (WA sender approval is the long pole at 1–3 days).

**Questions worth your call as CTO:** WeChat account (partner's vs fresh 4–6wk), Supabase Pro timing, and whether we consolidate the 5arz accounts now or post-pilot. Everything else is green-lit and moving.
