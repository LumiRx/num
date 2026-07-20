# NUM — Launch Readiness Map

**Updated:** 2026-07-17 (full audit: code + tests + live DB verified)
**Frame:** What it takes to run NUM in production across every language and every channel — what's coded, what's stubbed, what's missing.

Legend: ✅ shipped · 🟡 stubbed (shape exists, logic incomplete) · 🔴 missing · ⚪ deferred (post-pilot)

---

## 0. Update log

**2026-07-17 (optimization pass) — see `docs/ops/OPTIMIZATION_NOTES.md`:** pre-traffic audit of the live request path fixed six issues. Two were correctness bugs (**every request blocked the event loop**, serialising all passengers; **the concierge had no in-conversation history**, so follow-ups had no referent), one was a security hole (**Twilio webhooks accepted unsigned POSTs** — this doc previously recorded that wrongly as "Twilio handles"), plus a turn-latency budget (≤3 tool turns, ≤12s) so channel timeouts are unreachable, intent classification moved off the critical path (~0.5s saved per message), and a guaranteed-reply wrapper — **verified: with the DB fully down a Thai user still gets a Thai apology and a 200, not silence.** Memory also no longer needs an embedding vendor (recency+confidence recall; pgvector optional). **95 tests green.**

**2026-07-17 (later) — Deploy-prep sprint:** requirements re-pinned to verified versions (caught missing `python-multipart` — Twilio form webhooks would have 500'd in prod), unused heavy deps dropped, `.python-version` pinned 3.12, app boot-tested end-to-end (all 7 routes), `/healthz/db` keep-alive endpoint added (one uptime pinger now keeps Railway warm AND stops Supabase free-tier auto-pause), root `.env.example` rewritten, and **`docs/ops/DEPLOY_RUNBOOK.md`** created — the half-day click-path: slow approvals first (WA sender, WeChat decision), Supabase Pro, tenant seed SQL, Railway + embed-worker service, Twilio/LINE/WeChat webhooks, pinger + Sentry + Slack, smoke script, done-when checklist. §9 blocker #1 is now runbook-ready.

**2026-07-17 — Full audit + PDPA/consent sprint:**

- ✅ **All 84 unit tests pass** (was 44). Audit confirmed the June "hard blockers" #1 and #2 are DONE: WeChat XML parse + passive reply (adapter + router + tests), and the full Sonnet tool-use loop with `search_vendors` / `create_lead` / `escalate_to_human` / `save_user_memory` dispatching against live tables, with per-turn cost summing.
- ✅ **Vector memory shipped end-to-end**: `memory.lookup()` embeds via OpenAI + `match_memories` pgvector RPC; `apps/workers/embed.py` backfills embeddings (loop/once/drain modes). Graceful degradation without `OPENAI_API_KEY`.
- ✅ **PDPA consent + right-to-erasure shipped (today)**: `services/privacy.py` + `services/strings.py`. First-contact consent disclosure auto-appended in the user's language (script-detected; Latin → EN), audited to the new `consent_events` table (migration 0006, applied). Whole-message DELETE triggers (9 languages) run a real erasure: business records anonymized (leads/bookings/llm_usage), behavioral events deleted, user row cascade-wiped, audit trail retained. Confirmed in the user's language without touching the LLM.
- ✅ **Localized system strings**: consent notice, LLM-down fallback, delete confirmation in EN/TH/ZH/RU/JA/KO/DE/FR/ES. Concierge fallback now speaks the user's preferred language. ⚠️ TH/ZH/RU copy needs native review — hand to the Thai team + partner (tracked §1).
- ✅ **Vendor ingest pipeline for the ground team**: `scripts/ingest_vendors.py` (CSV → validated upsert, dedupe on tenant+name+category, dry-run mode) + `docs/ops/vendor_template.csv` + `docs/ops/VENDOR_ONBOARDING.md` (bilingual guide). The Thai team can start collecting merchants today.
- ✅ **Live DB verified (project `txabrxbobyxznkgarpkc`, ap-southeast-1)**: migrations 0001–0005 were already applied (0004 RLS + 0005 match_memories landed 2026-06-18 — June doc was stale on this); 0006 applied today. Security advisors: **zero critical findings on app tables** — RLS enabled everywhere incl. `channel_identities` (PII). Remaining lints are PostGIS system-table noise (`spatial_ref_sys`, `st_estimatedextent`) + extensions-in-public — accepted for pilot.
- ⚠️ **Free-tier Supabase auto-pauses on idle** (found it INACTIVE today; restored). Before any real traffic: upgrade to Pro or wire a keep-alive ping. Added to critical path.

**2026-06-17 — Foundation + fast-wins sprint:** cost tracking (`llm_usage` + views), zero-LLM language detection (`messages.lang` + `v_language_mix`), 17 tests, RLS remediation staged.

---

## 1. The user-facing surface

### Channels — inbound + outbound

| Channel | Inbound parse | Signature verify | Reply path | Production-ready? |
|---|---|---|---|---|
| **WhatsApp (Twilio)** | ✅ | ✅ **X-Twilio-Signature validated** (fixed 2026-07-17 — was unverified) | ✅ TwiML | ✅ Code-ready — Business sender approval is the gate (1–3 days; start now) |
| **SMS (Twilio)** | ✅ | ✅ **X-Twilio-Signature validated** | ✅ TwiML | ✅ Yes |
| **LINE** | ✅ | ✅ HMAC-SHA256 | ✅ Reply token via SDK v3 | ✅ Yes — once Messaging API channel is created |
| **WeChat Service Account** | ✅ XML parse + events | ✅ SHA-1 (GET + POST) | ✅ Passive XML reply (~5s window) | 🟡 Code-ready — **blocked on Service Account decision** (partner's vs fresh 4–6wk registration). Encrypted/AES mode + 48h push deferred. |
| **In-car / hotel QR** | ✅ `/qr/{code}` → channel handoff | ✅ acquisition_source binding | n/a | ✅ Yes |
| **Web widget** | 🔴 | 🔴 | 🔴 | ⚪ Phase 2 |
| **Voice (Twilio Voice + Whisper)** | 🔴 | 🔴 | 🔴 | ⚪ Phase 3 |

### Languages — auto-detect + reply

| Language | Auto-detect | Reply path | Localized system strings | Native QA |
|---|---|---|---|---|
| English | ✅ deterministic | ✅ | ✅ | n/a |
| Thai (TH) | ✅ script-based | ✅ | ✅ drafted | 🔴 **→ Thai team, this week** |
| Mandarin (ZH) | ✅ script-based | ✅ | ✅ drafted | 🔴 → partner's Chinese-market staff |
| Russian (RU) | ✅ script-based | ✅ | ✅ drafted | 🔴 |
| Japanese / Korean | ✅ script-based | ✅ | ✅ drafted | 🔴 (lower priority) |
| DE / FR / ES (EU bucket) | 🟡 statistical | ✅ | ✅ drafted | ⚪ |
| Hindi (IN) | 🟡 | ✅ | 🔴 falls back to EN | ⚪ |

Still open for true multilingual ops: **per-language analytics rollups** (schema logs everything; no aggregation views yet) and the native-QA pass above.

---

## 2. The AI brain

| Component | State | Notes |
|---|---|---|
| Intent router (Haiku, 6 classes) | ✅ | TOURIST · WHALE_LEAD · BOOKING_INTENT · SUPPORT · SMALLTALK · PARTNER_COMMAND |
| Concierge agent (Sonnet) | ✅ | **Full tool-use loop** (max 5 turns, summed usage, never-raise) |
| System prompt | ✅ | `apps/api/prompts/system_prompt.txt` — voice-tune with Thai team feedback |
| Tool: `search_vendors` | ✅ | Tenant-scoped, tier-ranked, anti-hallucination guardrail on empty catalogue |
| Tool: `create_lead` (whale) | ✅ | Inserts lead + event + Slack #num-ops alert |
| Tool: `escalate_to_human` | ✅ | Event + Slack alert |
| Tool: `save_user_memory` | ✅ | With `expires_at` for trip-scoped facts |
| Tool: `create_booking` | ⚪ | Phase 2 — pilot runs referral-style (vendor link + monthly settle) |
| Tool: `save_secure_pii` | 🔴 | Blocked on encryption layer |
| Vector memory subsystem | ✅ | lookup (RPC) + save + embed worker; degrades gracefully |
| PII scrubber (regex) | ✅ | Card, passport, Thai national ID |
| PII scrubber (Haiku pass) | 🔴 | Recommend before live property/school flows |
| PDPA consent + erasure | ✅ | **Shipped today** — disclosure, audit trail, working DELETE in 9 languages |
| Encryption layer (`user_profile_secure`) | 🔴 | Schema exists; KMS envelope not wired. Needed before storing passport-grade PII |

**The AI brain is pilot-grade.** What it needs now is not code — it's **vendor data** (see §9.2).

---

## 3. Data + multi-tenancy

| Component | State | Notes |
|---|---|---|
| Postgres schema (13 tables + consent_events) | ✅ | Migrations 0001–0006 applied + verified live |
| RLS enabled on all app tables | ✅ | Verified via security advisors today — PII gap closed |
| RLS tenant policies | 🟡 | Enable-only is correct until dashboard JWTs exist; policies land with dashboard |
| `partner_tenant_id` scoping | ✅ | Identity resolves from acquisition_source; tools scope queries |
| Per-tenant KMS keys | 🔴 | Pilot: single shared key fine; per-tenant at Pro tier |
| Acquisition source attribution | ✅ | Per-vehicle QR codes generate-able |
| Vendor catalogue **content** | 🔴 | **THE operational blocker — Thai team activated with ingest pipeline today** |
| Vendor ingest tooling | ✅ | CSV template + validated upsert script + bilingual field guide |

**Bali readiness note:** the multi-tenant layer (tenant on every row, tenant-scoped tools, per-vehicle QR attribution) means market #2 is a **data + partner problem, not a code problem** — new `partner_tenants` row, new acquisition codes, new vendor CSV. WhatsApp-dominant Indonesia also skips the WeChat/LINE dependency for launch.

---

## 4. Operator surface (the partner's view)

- **Consumer landing page:** 🔴 nothing live. 1 day on the Aeroz Webflow stack once domain is decided.
- **Partner dashboard:** 🔴 `apps/dashboard/` has IA + wireframe + prototype HTML, no build. 5–8 days for read-only v1. **Workaround for pilot weeks 1–2:** SQL views by hand + the weekly digest worker.

---

## 5. Workers (background processing)

| Worker | Purpose | State |
|---|---|---|
| `embed.py` | Embed new memories into pgvector | ✅ **Shipped** (loop / --once / --drain) |
| `expire.py` | Prune time-bound memories | 🔴 (low-risk: lookup already filters `expires_at`) |
| `nudge.py` | Proactive messages | ⚪ Phase 2 (needs WhatsApp template messages) |
| `payouts.py` | Stripe Connect splits | ⚪ Phase 2 — pilot is referral-model |
| `digest.py` | Weekly KPI digest to partner + Dre | 🔴 **Wanted for pilot** (dashboard workaround) |
| `language_qa.py` | Sample messages per language for human review | 🔴 Nice-to-have; Thai team dogfooding covers it for now |

---

## 6. Observability + compliance

| Item | State |
|---|---|
| Structured logs (structlog) | ✅ |
| Sentry init | 🟡 code present, DSN not set |
| Per-LLM-call cost tracking | ✅ `llm_usage` + `v_cost_per_user_daily` |
| Slack #num-ops alerts (whale lead, escalation) | ✅ code shipped — webhook URL not provisioned |
| PDPA consent flow (first-message disclosure) | ✅ **Shipped today** |
| PDPA `delete_me` self-service | ✅ **Shipped today** (whole-message DELETE, 9 languages, audited) |
| Consent audit trail | ✅ `consent_events` (versioned copy, survives erasure) |
| Audit log for memory writes + lead creates | 🟡 events table covers leads/escalations; memory writes not evented |
| GDPR DPA template | 🔴 needs counsel pass |
| WeChat compliance (Service Window, openid handling) | 🟡 architectural — plaintext mode only |

---

## 7. Payments + commerce

Unchanged — pilot runs **referral-style** (vendor booking link + monthly commission settle), so Stripe/Omise/2C2P stay ⚪ for the first 60 days. `commission_pct` is captured per vendor in the ingest sheet, so the ledger has data from day one.

---

## 8. Hosting + secrets

| Item | State |
|---|---|
| Supabase (ap-southeast-1) | ✅ Live, migrations 0001–0006 verified. ⚠️ **Free tier auto-pauses — upgrade to Pro (or keep-alive) before pilot traffic** |
| Railway project | 🟡 `railway.json` + Procfile in repo; not deployed |
| Secrets provisioned (Anthropic, OpenAI, Twilio, LINE, Slack webhook, Sentry) | 🔴 `.env` locally only |
| AWS KMS key | 🔴 (needed only for `save_secure_pii`) |
| Cloudflare WAF | 🔴 nice-to-have for pilot |
| Domain | 🔴 **open decision** — blocks landing page + LINE/WeChat handles + QR print |

---

## 9. Critical-path summary — what blocks "live in pilot"

**The code is no longer the bottleneck.** Remaining blockers are ops + data + accounts:

**🔴 Hard blockers:**
1. **Deploy**: Railway up + secrets + Supabase Pro (or keep-alive) + webhooks pointed. ~1 day.
2. **Vendor data**: 40+ real merchants via the new ingest pipeline. **Thai team, starting now** — tech is done; this is fieldwork. 5–10 days in parallel.
3. **WhatsApp Business sender approval** (1–3 days lag — submit immediately) + LINE Messaging API channel creation (hours).
4. **WeChat Service Account decision** (partner's existing = days; fresh = 4–6 weeks). Pilot CAN launch WA+LINE+SMS while WeChat clears.
5. **Domain decision** → QR codes printed → vehicle install.

**🟡 Soft blockers (credibility, workaround exists):**
6. Native QA of TH/ZH/RU system strings + prompt voice-tune — **Thai team dogfooding this week**.
7. Weekly digest worker (dashboard workaround). 1 day.
8. Sentry DSN + Slack webhook provisioned. 0.5 day.
9. Read-only dashboard v1. 5–8 days (can trail launch by 2 weeks).

**⚪ Deferred:** payments, web widget, voice, dashboard admin actions, Haiku PII pass (revisit before property/school flows), encryption layer (before passport-grade PII).

**Bottom line: with the partner's accounts + Thai team fieldwork running in parallel, the build-side work remaining before first-5-cars is ~2–3 days, not weeks.**

---

## 10. Thai team — start-this-week pack

Ready for them today (`test conversations` + `vendor onboarding` both unblocked):

1. **Vendor collection** → `docs/ops/VENDOR_ONBOARDING.md` + `vendor_template.csv`. One shared Google Sheet, export CSV, ingest runs `--dry-run` first. Priorities: airport↔Patong/Kata corridors, ZH/RU-speaking staff, whale-adjacent (`agent`/`school`/`medical`).
2. **Test conversations (dogfood)** → once deployed (blocker #1), message NUM in Thai: ask for what they just ingested, try to make it hallucinate, try DELETE flow, screenshot anything off. Their feedback tunes `system_prompt.txt` voice.
3. **Native string QA** → review the TH consent/fallback/delete strings in `apps/api/services/strings.py` (and get partner staff on ZH/RU).

## 11. Bali (market #2) — what the audit says

Multi-tenancy is live in the schema and tools, so Bali = `partner_tenants` row + acquisition codes + vendor CSV + WhatsApp sender (Indonesia is WA-first — no WeChat/LINE gate). The right sequence: prove the Phuket playbook (vendor pipeline → pilot KPIs), then hand the Bali partner-prospect the same pilot proposal structure with Phuket numbers in it. Partner-proposal template exists (`02_PARTNER_PROPOSAL_PHUKET.md`) and adapts in an afternoon when the relationship is ready.
