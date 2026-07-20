# NuM — Partner Breakdown
### What we have. What we need from you. How fast we go live in your network.

**Document date:** 2026-06-17
**Audience:** Phuket AI, Phuket InCar Group, and future regional partners (Bali, Bangkok, Singapore, KL)
**Prepared by:** Dre · Lumi
**Confidentiality:** Partner-share — shareable inside your org under NDA. Please don't post publicly.

---

## TL;DR

We've built the spine. The brain talks, identity persists, the database is live in Singapore, every LLM call is cost-tracked, and inbound messages are language-detected before they hit the router. We're three workstreams away from running real pilot traffic in any partner network — and most of the remaining work is **on us**, not on you. Here's what we need from you to plug NuM into your network and start serving your users this quarter.

---

## 1. What's actually built (current state, 2026-06-17)

NuM is a real codebase, not a deck. Concrete state across the eight layers a partner cares about:

### 1.1 Channels — how users reach NuM

| Channel | Inbound | Reply | Production-ready |
|---|---|---|---|
| WhatsApp (Twilio) | ✅ | ✅ | ✅ Yes — WhatsApp Business sender approval pending |
| SMS (Twilio) | ✅ | ✅ | ✅ Yes |
| LINE (Messaging API v3) | ✅ | ✅ | ✅ Yes — channel-create only |
| WeChat Service Account | 🟡 GET handshake | 🔴 No XML reply yet | 🔴 2–3 days work, blocked on Service Account verification |
| In-car / hotel QR | ✅ Per-code attribution into a chat channel | n/a | ✅ Yes |
| Web widget · Voice | 🔴 | 🔴 | ⚪ Phase 2/3 |

**The one channel gap is WeChat reply.** Code is written for handshake; XML parse + customer-service push (48h window) is the missing piece. Same-week fix once we know whether your team has a verified Service Account or we register fresh.

### 1.2 Languages — auto-detect on every inbound

Shipped 2026-06-17. **Zero-LLM Unicode-script detector** — no model call, no token cost, deterministic for Thai, Mandarin, Japanese, Korean, Russian, Arabic, Hebrew, Hindi. Latin-script messages route through `langdetect` for en/fr/de/es/pt/it discrimination. Persists to `messages.lang` and refreshes `users.preferred_lang`; analytics view `v_language_mix` ready for the dashboard.

| Language | Detection | Reply | Localized fallback strings | Native QA reviewer |
|---|---|---|---|---|
| English | ✅ | ✅ | ✅ | n/a |
| Thai (TH) | ✅ deterministic | ✅ Claude native | 🔴 EN-only | 🔴 partner ask |
| Mandarin (ZH-CN) | ✅ deterministic | ✅ | 🔴 | 🔴 partner ask |
| Japanese (JA) | ✅ deterministic | ✅ | 🔴 | 🔴 partner ask |
| Korean (KO) | ✅ deterministic | ✅ | 🔴 | 🔴 partner ask |
| Russian (RU) | ✅ deterministic | ✅ | 🔴 | 🔴 partner ask |
| Hindi (HI) | ✅ deterministic | ✅ | 🔴 | 🔴 partner ask |
| French / German / Spanish / Italian / Portuguese | ✅ via langdetect | ✅ | 🔴 | n/a (low pilot priority) |
| Arabic (AR) · Hebrew (HE) | ✅ deterministic | ✅ | 🔴 | n/a (low pilot priority) |

**One thing we need from you:** a native reviewer per top language in your market (typically TH + ZH-CN + RU for Phuket, plus EN). Two hours of review per week is enough during pilot. This is brand-voice tuning, not bug-fixing — the model speaks every language fluently; we want it to *sound right* in yours.

### 1.3 The AI brain

| Layer | State |
|---|---|
| Intent router (Claude Haiku 4.5, 6 classes: TOURIST · WHALE_LEAD · BOOKING · SUPPORT · SMALLTALK · PARTNER_CMD) | ✅ Working |
| Concierge agent (Claude Sonnet 4.6) | 🟡 Single-turn. Tool-use loop is the next critical piece. |
| System prompt | ✅ Voice-tuneable — `apps/api/prompts/system_prompt.txt` |
| Memory: persistent per-user, encrypted profile, vector retrieval | 🟡 Schema + write path done. Embedding worker + retrieval = ~2 days. |
| PII scrubber (cards · passports · Thai national ID) | ✅ Regex working. Haiku-pass for hard cases comes later. |
| Tools (`search_vendors`, `create_booking`, `create_lead`, `escalate_to_human`) | 🔴 5–7 days work after vendor data ingest |

**This is the single biggest remaining build.** The brain talks today; the tools are what let it *act*. Without them, NuM can recommend a restaurant but can't reserve a table; can spot a school-enrollment signal but can't open a routed lead in your team's queue.

### 1.4 Data infrastructure

- ✅ **Supabase project live** — `txabrxbobyxznkgarpkc`, region `ap-southeast-1` (Singapore, closest PDPA-aligned region for Phuket).
- ✅ **13-table multi-tenant schema** applied: users · channel_identities · user_profile · user_profile_secure (encrypted) · conversations · messages · memories (pgvector) · leads (whale routing) · vendors · bookings · partner_tenants · acquisition_sources · events.
- ✅ **Per-LLM-call cost tracking** — every Sonnet / Haiku / embedding call writes `llm_usage` (tokens · USD), so per-active-user economics are honest, not estimated. View `v_cost_per_user_daily` ready for the dashboard.
- ✅ **Language analytics view** — `v_language_mix` aggregates message share by language per tenant.
- 🟡 **RLS policies** — enabled on the 8 public tables (incl. `channel_identities` PII) via staged migration `0004`. Tenant-scoped policies write next, once dashboard JWTs are issued.
- ✅ **`partner_tenant_id` on every row** — multi-tenant from day one, no retrofit later.

### 1.5 Tests + verification

- ✅ **17 unit tests passing** — `tests/test_costing.py` (16 cases covering Sonnet/Haiku/embedding pricing + edge cases) + `tests/test_lang_detect.py` (script detector across all 9 supported scripts).
- ✅ **End-to-end DB write-path proven** — synthetic Thai message wrote cost row + populated views, then cleanly rolled back.
- ⏳ **Live LLM smoke test** ready — `scripts/smoke_pipeline.py` exercises the real chain (identity → lang detect → intent → persist → reply → cost) once Anthropic + Supabase secrets are loaded into the API's `.env`. Will run in the next 24h.

### 1.6 Channel adapters — code state

```
apps/api/adapters/
    twilio.py    ✅  SMS + WhatsApp inbound parse + TwiML reply
    line.py      ✅  HMAC-SHA256 verify · v3 SDK reply via reply token
    wechat.py    🟡  GET handshake done; XML parse + customer-service push pending
```

### 1.7 Operator surfaces

- **Marketing website** — 🔴 not live yet. Will mirror the Aeroz Webflow stack we already operate. **~1 day to ship.**
- **Operator dashboard** — 🔴 directory exists, no code. Full **wireframe shipped** (1,047 lines of HTML, 18 nav sections, 11 panels). See `dashboard-wireframe.html` in this folder. **5–8 days to ship read-only v1**, another 3–5 days for admin actions.

### 1.8 Workers (background jobs)

```
apps/workers/
    embed.py        🔴  Vector embed new memories  ← critical for "memory" being real
    expire.py       🔴  Prune time-bound memories
    nudge.py        🔴  Proactive messages
    payouts.py      🔴  Stripe Connect rev-share splits   (defer to Phase 2)
    digest.py       🔴  Weekly KPI digest email
    language_qa.py  🔴  Sample N/day messages per language for human review
```

Two of these matter for pilot launch (`embed.py`, `digest.py`); the rest are Phase 2.

---

## 2. The economics, with real numbers

Per-active-user variable cost — measured, not estimated, from the now-live `llm_usage` table:

| Cost line | Est. $/active user/mo |
|---|---|
| Claude Sonnet (chat) | $0.32 |
| Claude Haiku (routing + classification) | $0.09 |
| OpenAI embeddings | $0.02 |
| Twilio / WeChat / LINE message fees | $0.18 |
| Supabase + workers | $0.05 |
| Sentry + logs | $0.03 |
| **Total variable COGS** | **~$0.69 / active user / mo** |

At a $8.50 blended ARPU target by Month 6, that's a **~12× revenue-to-COGS ratio before partner rev-share**. After the standard Pro-tier 35/65 booking split + 25/75 whale-lead split in the partner's favor, Lumi nets ~$3–4/active user/mo and the partner nets significantly more because the partner closes the high-LTV verticals.

The whole point of having the `llm_usage` table live is that **we will not bullshit you on Pro-tier pricing.** We'll show you our true per-user cost from the pilot, then propose splits that work for both sides.

---

## 3. What we need from your network to go live

This is the operational ask — the specific things only a regional partner can provide. Sequenced from blocking to nice-to-have.

### 3.1 Channels & identity

| # | Ask | Why | Lead time |
|---|---|---|---|
| 1 | **WhatsApp Business sender number or display name** under your brand, with the meta verification email forwarded to us so we can finish the WABA approval | Day-one channel for your existing users | 1–3 days if you already have a number; 1–3 weeks for fresh approval |
| 2 | **WeChat Service Account verified in mainland China** (or: confirmation we should register fresh under Lumi) | Reaches the 4.2M Chinese visitors / yr who don't use WhatsApp. Lumi-fresh = 4–6 weeks for verify | Decide this week |
| 3 | **LINE Official Account** in the partner's name | JP / KR / TH mainland users | 1 day |
| 4 | **In-car / hotel QR estate inventory** — addresses, vehicle IDs, hotel lobbies, expected scan volume per location | We generate per-source attribution codes; per-vehicle ROI lives or dies on this | 2 days from you |

### 3.2 Merchant content (the make-or-break workstream)

**Honest flag we made on the proposal:** the biggest pilot risk isn't tech — it's vendor data quality. A polished AI over stale merchant content sounds like every other chatbot. We need:

| # | Ask | Volume | Lead time |
|---|---|---|---|
| 5 | **40–60 seed merchants** mixed across dining · tours · transfers · spa · hotels | Pilot covers your top-performing partners + 5 "long tail" picks for variety | Partner-led, ~10 days |
| 6 | **Per-merchant content kit**: name, address, geo, hours, 3–5 real photos, contact for booking, honest segment notes (kid-friendly · couples · solo · halal · veg · etc.), commission tier | Determines AI quality more than prompt engineering | Concurrent with #5 |
| 7 | **4–6 high-ticket partners** — 1–2 real estate agencies, 1–2 international schools, 1 relocation services firm, 1 medical/wellness | These are the whale-lead route | Partner-led, ~5–10 days |

We build the admin tool to ingest this; you bring the relationships. We will not fabricate vendor info — if NuM doesn't know, it says so and asks.

### 3.3 Human handoff & escalation

| # | Ask | SLA | Notes |
|---|---|---|---|
| 8 | **Named human responder** on your side for whale-lead escalations | Same-day during business hours, 24h max overnight | One person per vertical is fine — they don't need to live in the dashboard |
| 9 | **Named partnership lead** for the engagement itself | Weekly sync | One thread, one decision-maker, no committee |
| 10 | **Native-language reviewer** per top market language (typically TH + ZH-CN + RU + EN for Phuket) | 2 hours/week during pilot | Brand-voice tuning, not bug-fixing |

### 3.4 Compliance & legal

| # | Ask | Why |
|---|---|---|
| 11 | **Local counsel sign-off on the PDPA consent string** in your market language(s) | We provide the template; you review |
| 12 | **GDPR DPA acceptance** (EU traveler exposure) | Standard template, 1-page |
| 13 | **WeChat compliance posture** — confirm acceptable Service-Window behavior with your team | We don't push outside the 48h window without an approved template |
| 14 | **Mutual two-page NDA** signed first | We send a clean template — no committee version |

### 3.5 Brand & launch

| # | Ask | Lead time |
|---|---|---|
| 15 | **Co-brand decision** — "Phuket AI, powered by NuM" or full white-label or independent NuM brand in your network | Decision in scoping call |
| 16 | **Brand assets** — logo lockup, primary palette, typography, tone-of-voice samples | 2 days from you, after decision |
| 17 | **One launch announcement channel** — WhatsApp broadcast, hotel concierge brief, in-car driver brief — whatever your network already uses to tell its merchants and end-users something new is live | Partner-led |

### 3.6 Settlement & billing

| # | Ask | Phase |
|---|---|---|
| 18 | **Monthly settlement model** for pilot — Lumi invoices a single rev-share number; you handle merchant payouts on your existing rails | Pilot only |
| 19 | **Stripe Connect onboarding** for automatic splits | Phase 2, after Pro contract |
| 20 | **Thai-local rails** (Omise / 2C2P / PromptPay) | Phase 2 |

---

## 4. The launch sequence

**Week 0 — NDA + scoping call (you commit a partnership lead).**
Sign mutual NDA. 45-min call: their tech lead + our team. We answer "what does your stack look like" honestly; you answer the same. Decide WeChat path. Decide co-brand vs white-label.

**Week 1 — Provisioning + content.**
We: provision Railway, finish WeChat XML, wire the tool-use loop, ship the embed worker, stand up the marketing site at the chosen domain.
You: deliver the merchant content kit (40–60 vendors), name human responders, sign DPA, choose brand identity.

**Week 2 — Channels live in staging.**
WhatsApp + LINE + WeChat all answer real test messages. Per-vehicle/hotel QR codes generated and printed for the first 5 locations. Internal dogfood with your team — 5 days, 5 users, your team's real preferences.

**Week 3 — Soft launch in pilot vehicles / lobbies.**
Live traffic, low volume. Dashboard read-only v1 live for you to watch. Daily standup (15 min) for the first 5 days.

**Weeks 4–6 — Steady-state pilot.**
Weekly KPI sync. AI prompt tuning from native-reviewer feedback. Whale-lead pipeline flowing.

**Week 7 — Decision gate.**
Hit ≥ 4 of 7 KPIs → Pro contract for Month 2 forward. Miss them → no-fault wrap, you keep merchant relationships, we keep platform learnings, friendly parting.

**Total clock time: ~7 weeks from NDA signed to pilot end-of-month report.**

---

## 5. The dashboard you'll be looking at

Open `dashboard-wireframe.html` in any browser. Operator-grade. 11 panels grouped Today · Pipeline · Network · Quality · Business · Trust · Admin. Highlights for the partner view:

- **KPI strip** — active now · QR scans 24h · activation % · avg depth · D7 return · whale leads in flight, each with target lines
- **Live conversation stream** — anonymized, channel + language + lifecycle-stage badges, intent labels, scrubs PII before render
- **Whale-lead queue** — vertical, A/B/C score, SLA timer, assignee, click-through to user profile
- **Channel health** — live pulse per adapter, last-message ago, p95 reply time, error rate
- **Funnel** — QR scan → first msg → engaged → D7 → booking → whale-qualified
- **Language share + detector accuracy** — donut + per-language conversion
- **AI quality** — intent accuracy on sampled set, hallucination flags, escalation rate
- **Merchant performance** — top + at-risk vendors, NPS, content freshness
- **Revenue + splits** — stacked bars with Lumi / Partner share, MTD totals, net to each side
- **Cost monitor** — per-active-user breakdown, budget compare, drift analysis
- **PDPA / compliance** — consent rate, delete_me in flight, KMS rotation, scrubber hits

Partner sees their tenant's data only — RLS enforced by `partner_tenant_id` once dashboard JWTs are issued.

---

## 6. The economics that should sit alongside this (already in the proposal deck)

Pilot (Month 1): Lumi absorbs infra, 50/50 booking splits, 30/70 whale-lead splits in your favor, 40/60 merchant subscriptions in your favor. Setup fee waived.

Pro (Month 2+): [TBD: $5,000] setup, [TBD: $2,500/mo] platform fee, 35/65 booking split in your favor, 25/75 whale-lead split in your favor, 30/70 merchant subscriptions in your favor. Territory exclusivity available at +30%.

Both numbers will move in your favor as we learn from real cost data. They will not move secretly.

---

## 7. Five honest things we want to flag

1. **The tool-use loop isn't shipped yet.** The brain talks, but until tools fire it can't reserve, route, or create leads. Same-week build. Won't deceive about timing.

2. **WeChat is the China unlock and it's the slowest path.** If you have a verified Service Account, we light it up this month. If not, the 4–6 week verification clock starts the day we apply.

3. **Vendor content quality matters more than model quality.** A NuM with thin merchant data feels like every other chatbot. The first 10 days of pilot are heavy on content load-in, light on AI tuning. We need your network engaged, not just your distribution.

4. **The dashboard isn't built — we have a wireframe.** Read-only v1 ships in 5–8 days of focused work. Until then, weekly KPI emails (we already have the data to generate them).

5. **Lumi is bootstrapped through Year 2 by design.** We're not racing to a raise — we're racing to a profitable Pro contract with you. That should change how you think about the partnership's commercial terms and our motivation to make you happy versus impress investors.

---

## 8. What we need to hear from you to move

Three sentences in your reply:

1. Names of your **tech lead** (45-min scoping call) and **partnership lead** (weekly thread).
2. **Yes/no** on whether you have a verified WeChat Service Account.
3. Your **first 10-merchant pick** from your existing network for the seed data — mix of dining, tours, at least one school, at least one real-estate agency.

Once those three are answered, we get the first vehicle/lobby/QR live within 14 days of NDA.

---

*— Dre · CEO, Lumi · andre@thatislumi.com*
*Last updated: 2026-06-17*
*Files in this packet: this document · proposal.pptx · cover-email.md · dashboard-wireframe.html · LAUNCH_READINESS.md · this-week-action-note.md · PARTNER_INTEGRATION_CHECKLIST.md*
