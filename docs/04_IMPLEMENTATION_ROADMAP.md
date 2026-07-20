# NUM — Implementation Roadmap & Build Additions

**Version:** 1.0
**Owner:** Lumi
**Last updated:** 2026-05-26

This is the operational build plan. It assumes the Gemini blueprint as a starting point and lists, by phase, exactly what we keep, what we change, and what we add — so a Claude Code session (or any engineer) can execute without guessing.

---

## 1. What we keep from the Gemini blueprint

- FastAPI + Python backend on Railway.
- Supabase (Postgres) as the primary DB, accessed via `supabase-py`.
- Twilio webhook pattern for inbound messages.
- Drip-feed extraction concept (we re-domain it from legal intake to concierge intake).
- Hard guardrails in the system prompt — UPL is the right *style* of disclaimer; we extend it to medical, financial, and broker licensing.
- `viability_score` concept — promoted into the `leads` table for whale-lead routing.

## 2. What we change from the Gemini blueprint

| Change | Why |
|---|---|
| Replace `leads` table with full concierge schema (§6 of `01_MASTER_ARCHITECTURE.md`) | Concierge ≠ paralegal — different fields, plus we need a separate `leads` table for whale routing. |
| Replace single-LLM call pattern with **router + agent + tools** | Cheaper (Haiku for routing), smarter (tool calls for memory + bookings), auditable. |
| Add `partner_tenant_id` to every row from day one | We're licensing this — multi-tenancy can't be retrofitted later. |
| Move Twilio from "the channel" to "one channel" — make a generic `ChannelAdapter` interface | LINE + WeChat have to plug in cleanly. |
| Move from "stateless extraction" to **persistent vector memory per user** | This is the core product differentiation. |

## 3. What we add (the "additions list")

### Must-have for pilot (Phase 1)
1. **Channel adapters layer** with `WhatsAppAdapter`, `LineAdapter`, `WeChatAdapter`, `SmsAdapter`, `WebWidgetAdapter` — all normalize into a single `IncomingMessage{}` Pydantic model.
2. **Identity / UUID service** — handle-to-UUID lookup, idempotent create, cross-channel merge candidate detection.
3. **In-car QR system** — per-vehicle short URLs that pre-fill a kickoff message (`START car_PHK_017`); landing endpoint logs the acquisition source before redirecting to the chat channel.
4. **Intent router** (Claude Haiku) — categories defined in §4 of `01_MASTER_ARCHITECTURE.md`.
5. **Concierge Agent** (Claude Sonnet) with tool calls:
   - `lookup_user_memory(query)`
   - `save_user_memory(fact, tags, confidence, expires_at?)`
   - `save_secure_pii(field, value)`
   - `search_vendors(category, geo, filters)`
   - `create_booking(vendor_id, slot, party)`
   - `create_lead(vertical, details)`
   - `escalate_to_human(reason)`
6. **Memory subsystem** — pgvector table, embedding worker, retrieval hybrid (vector + tag filter), pruning + expiry job.
7. **Encryption layer** — envelope encryption for `user_profile_secure` using KMS (Supabase Vault for MVP; AWS KMS for Pro+).
8. **Multi-tenant scoping** — middleware that resolves `partner_tenant_id` from acquisition source or channel mapping; every query scoped.
9. **Admin / merchant ingestion tool** — minimal Streamlit or Next.js admin to add/edit vendors quickly with the partner team. (Build vendor data ingestion as Postgres-first, UI second.)
10. **Partner read-only dashboard** — KPIs from §B.2 of the partner proposal: scan rate, activation, depth, D7, conversions, whale leads. Use Supabase + a small Next.js app on Vercel.
11. **Observability** — Logfire or Sentry + structured logs to BetterStack from request 1.
12. **PDPA / consent flow** — first-message disclosure + opt-in; `delete_me` slash-command path.
13. **PII scrubber** — regex + Haiku pass on every inbound message; strip national IDs, full card numbers, passports from `messages.content`; route to `user_profile_secure` instead.
14. **Language detection + routing** — every message detect language, store preference, respond in same language.

### Phase 2 (Months 2–4, post-pilot)
15. **Stripe Connect** — automated rev-share payouts to tenants and merchants.
16. **Booking integrations** — Agoda, Klook, GetYourGuide, Viator, Booking.com affiliate.
17. **Vendor self-service portal** — vendors edit their own listings, see leads, accept/decline bookings.
18. **Proactive nudges (cron + worker)** — "You arrive in 3 days, want a starter itinerary?" "How was dinner last night?"
19. **Web widget** — embed for hotel and partner websites.
20. **Group / family profile** — link multiple UUIDs into a `household` for trip planning.
21. **Voice channel (Twilio Voice + Whisper + TTS)** — optional, for in-car hands-free.
22. **NUM+ subscription paywall** — Stripe consumer subs, feature gating.

### Phase 3 (Months 5–9, multi-tenant scale)
23. **Tenant self-onboarding** — sign-up, KYC, billing, tenant provisioning automated.
24. **Cross-tenant user portability** — same user, different city, correct revenue attribution.
25. **Fine-tuned small model for intent + extraction** — to cut LLM cost as volume grows.
26. **Mobile thin client** (iOS/Android) — same chat, but native push notifications and saved itineraries.
27. **Data products pipeline** — anonymized aggregate exports for tourism boards (opt-in only).
28. **Localized model variants** — small dialect tweaks for ZH-CN vs ZH-TW, TH-North vs TH-South.

---

## 4. Phase 1 build sequence (8 weeks to pilot launch)

| Week | Workstream | Deliverable |
|---|---|---|
| **W1** | Project bootstrap | Railway project, Supabase project (ap-southeast-1), Doppler secrets, GitHub repo, CI (pytest + ruff). Tenant + acquisition_source tables migrated. |
| **W1** | FastAPI skeleton | `/healthz`, `/sms`, `/whatsapp`, `/line`, `/wechat`, `/qr/{code}` endpoints stubbed. |
| **W2** | Identity service | UUID generation, channel-handle binding, source attribution from `/qr/{code}` redirect. |
| **W2** | Channel adapters | Twilio (SMS + WA), LINE adapters live and echoing. WeChat stubbed pending Service Account. |
| **W3** | Intent router + Concierge Agent (v0) | Haiku router → Sonnet agent with first 4 tools (memory r/w, vendor search, escalate). Hardcoded vendor list. |
| **W3** | Memory subsystem | pgvector table + embed-on-write + retrieve-on-read. |
| **W4** | Encryption + PII scrubber | `user_profile_secure` writes through KMS envelope; PII scrubber on inbound. |
| **W4** | Admin ingestion tool | Minimal CRUD on `vendors` + `acquisition_sources`. Partner team starts loading data. |
| **W5** | WeChat adapter | Live once Service Account verified; same message contract. |
| **W5** | Per-vehicle QR generator | Codes printed for 35 cars. |
| **W6** | Partner dashboard (read-only) | KPIs live from Supabase via Next.js on Vercel. |
| **W6** | Observability + alerting | Logfire/Sentry wired; alert on 5xx, LLM timeouts, payment failures. |
| **W7** | Internal dogfood week | Partner team uses NUM in 5 cars on 5 routes. AI prompt + vendor data tuning. |
| **W8** | Public pilot launch | All 35 cars live. Daily metrics review. |

---

## 5. The repo layout (suggested)

```
num/
├── apps/
│   ├── api/                      # FastAPI service
│   │   ├── main.py
│   │   ├── adapters/             # twilio.py, line.py, wechat.py, sms.py, web.py
│   │   ├── routers/              # /sms, /whatsapp, /line, /wechat, /qr, /admin
│   │   ├── services/
│   │   │   ├── identity.py
│   │   │   ├── intent_router.py
│   │   │   ├── concierge_agent.py
│   │   │   ├── memory.py
│   │   │   ├── tenancy.py
│   │   │   ├── pii_scrubber.py
│   │   │   └── encryption.py
│   │   ├── tools/                # tool implementations for the agent
│   │   ├── schemas/              # Pydantic models
│   │   └── prompts/              # system prompts, per-vertical addendums
│   ├── workers/                  # arq workers: embed, expire, nudge, payouts
│   └── dashboard/                # Next.js partner read-only KPI dashboard
├── infra/
│   ├── supabase/                 # migrations (sql), policies
│   └── railway/                  # railway.json, env templates
├── docs/
│   ├── 01_MASTER_ARCHITECTURE.md
│   ├── 02_PARTNER_PROPOSAL_PHUKET.md
│   ├── 03_BUSINESS_MODEL.md
│   └── 04_IMPLEMENTATION_ROADMAP.md
└── tests/
```

---

## 6. Streamlining recommendations (MCP / tooling)

A few automations worth wiring early — saves us hours per week and reduces human error:

1. **Stripe MCP** for revenue-share payouts and merchant subscription management — already available in Cowork; will let NUM automate splits to the partner without manual calc.
2. **Slack or Telegram MCP** for partner ops channel — pilot alerts (new whale lead, escalation needed) pushed in real time so the partner's human responder can act inside SLA.
3. **Postiz** (already installed) — for the partner's outbound social once the pilot is live and we want to post case studies.
4. **Anthropic Claude Code as the build agent** — feed it `01_MASTER_ARCHITECTURE.md` + `04_IMPLEMENTATION_ROADMAP.md` and have it scaffold the FastAPI repo end-to-end.
5. **Scheduled task** to email a weekly KPI digest to you + the partner every Monday morning.

---

## 7. What "done" looks like for Phase 1

A user in a Phuket taxi can:
1. Scan a QR on the in-car screen.
2. Get a friendly greeting in their detected language within 2 seconds.
3. Ask for a kid-friendly dinner near their hotel and get 3 real options with photos and a one-tap booking.
4. Come back 4 days later and have NUM remember they're vegetarian, traveling with a 7-year-old, and staying at Anantara Layan.
5. Casually ask about international schools — and have a real human from the partner's network follow up within 24 hours.
6. None of their PII is in plain text anywhere we can see.
7. The partner can log into a dashboard and see every step of that journey as a metric.

If all seven are true on Week 8, we launch publicly and move to monetization.
