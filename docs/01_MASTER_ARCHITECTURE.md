# NUM — Master Architecture Document

**Version:** 1.0 (Phuket Pilot)
**Owner:** Dre / Lumi
**Last updated:** 2026-05-26
**Status:** Pre-pilot tech refinement

---

## 1. What NUM Is

NUM is a **persistent, multilingual AI Personal Concierge** that each user "owns" through chat (WhatsApp, LINE, WeChat, SMS) and that learns them over time. Every user gets a dedicated AI agent tied to a UUID, with an encrypted long-term profile that captures preferences, plans, history, relationships, and intent signals.

Originally scoped as a tourist recommender, NUM is being repositioned as a **Full-Lifecycle Local Authority** for Phuket: short-trip tourists, luxury travelers, digital nomads, and relocating families — all served by the same AI brain, with different downstream vendor routing.

The Gemini blueprint shipped with a *legal-intake* example (UPL guardrails, 5-point drip-feed). That code pattern is sound, but the **product is a concierge, not a paralegal**. We keep the same architectural spine — webhook → intent router → drip extraction → scored record in Supabase — and swap the domain logic.

---

## 2. Core Design Principles

1. **One user → one AI → one encrypted profile (UUID-bound).** The AI is *theirs*. It remembers. It adapts. It carries context forward across days, channels, and trips.
2. **Channel-agnostic brain.** WhatsApp, LINE, WeChat, SMS, in-car QR, and web all hit the same FastAPI routing layer. New channels are adapters, not rewrites.
3. **Privacy-first.** User profile data is encrypted at rest (field-level for PII), with the user as the data owner. We never sell raw profile data. Monetization comes from *outcomes* (bookings, leads), not data sale.
4. **Honest AI.** No fabricated reviews. No fake availability. If NUM doesn't know, it says so and asks. UPL/medical/financial disclaimers are baked into the system prompt.
5. **Source-of-truth is the conversation.** Every extraction is anchored to a chat message; transcripts are auditable.
6. **Whale-lead aware.** The router is trained to spot high-LTV signals (relocation, property, school enrollment, long-stay) and escalate them differently from a dinner reservation.

---

## 3. Optimized Tech Stack

| Layer | Choice | Why |
|---|---|---|
| **Backend** | Python 3.11 + FastAPI | Async, fast, type-hinted, what the Gemini blueprint assumes, deploys cleanly on Railway. |
| **Channel: SMS / WhatsApp** | Twilio Conversations API | Unified inbox across SMS + WhatsApp Business + Facebook Messenger. Webhook in, message out. |
| **Channel: LINE** | LINE Messaging API (official) | Required for Thai/JP/KR markets. Native webhook. |
| **Channel: WeChat** | WeChat Official Account (Service type, China-mainland verified) + optional WeCom for B2B | Non-negotiable for the Chinese inbound. Service Account allows 48-hour customer-service window for free-form replies. |
| **Channel: In-Car QR** | Static deep-links → URL shortener with per-vehicle UTM-style params → channel handoff | Each car (or screen) gets a unique code. Scan logs source vehicle to Supabase before routing to chat. |
| **LLM Brain** | Anthropic Claude (Sonnet for chat, Haiku for cheap classification/extraction) + fallback to GPT-4o | Sonnet for the conversational layer and tool use; Haiku for the intent router and the field-extractor (cheap, fast). Multi-model gives resilience. |
| **Embeddings + Memory** | OpenAI `text-embedding-3-small` (or `voyage-3-lite`) into Supabase `pgvector` | User memories are stored as embedded chunks; retrieved at every turn for the personalization layer. |
| **Database** | Supabase (Postgres + pgvector + Row-Level Security + Storage) | One platform: relational data, vector memory, file storage (passport scans, school docs), auth. RLS gives us per-user isolation out of the box. |
| **Encryption** | App-layer envelope encryption with AWS KMS (or libsodium + Supabase Vault for MVP) | Field-level encryption for `profile_pii`, `passport_data`, `medical_notes`. Keys never in code. |
| **Background jobs** | Railway worker + `arq` or Supabase Edge Functions | Drip messages, scheduled check-ins ("How's the villa viewing tomorrow?"), partner notifications. |
| **Observability** | Logfire (Pydantic) or Sentry + structured logging to BetterStack | Required from day one — without logs we can't tune the AI or prove pilot KPIs. |
| **Payments / Commissions** | Stripe (international) + Omise or 2C2P (Thailand local cards/PromptPay) | Stripe Connect for partner payouts when revenue-sharing. |
| **Hosting** | Railway.app for API + workers; Cloudflare in front for caching/WAF/DDoS | Cheap, single `main.py` deploys, autoscales for the pilot. Move to GCP/AWS if/when we cross 500k users. |
| **Secrets** | Doppler or Railway env + AWS Secrets Manager for prod keys | Twilio, WeChat, LLM, Stripe keys — never in repo. |

### What we are explicitly *not* using (and why)
- **No bespoke front-end web app for v1.** The chat *is* the product. We build a small admin dashboard later (Next.js on Vercel) for the partner — not for end users.
- **No vector DB outside Supabase.** Pinecone/Weaviate/Qdrant add ops cost we don't need at pilot scale. `pgvector` handles >1M vectors comfortably.
- **No custom-trained model in v1.** Prompt engineering + retrieval-augmented memory beats fine-tuning until we have months of labeled conversations.

---

## 4. System Architecture (Logical)

```
                        ┌────────────────────────────────────┐
                        │       Inbound Channels             │
                        │  Twilio (SMS/WA) · LINE · WeChat   │
                        │       In-Car QR · Web widget       │
                        └────────────────┬───────────────────┘
                                         │  webhook POST
                                         ▼
                  ┌──────────────────────────────────────────┐
                  │   FastAPI Gateway  (channel adapters →   │
                  │   normalized Message{} object)           │
                  └────────────────┬─────────────────────────┘
                                   │
                                   ▼
                  ┌──────────────────────────────────────────┐
                  │  Identity Service                        │
                  │  - Lookup or create user UUID            │
                  │  - Bind channel handle → UUID            │
                  │  - Attach acquisition source (QR / car)  │
                  └────────────────┬─────────────────────────┘
                                   ▼
                  ┌──────────────────────────────────────────┐
                  │  Intent Router  (Claude Haiku)           │
                  │  Categories:                             │
                  │   • quick_recommendation                 │
                  │   • booking_intent                       │
                  │   • whale_lead (RE / school / visa)      │
                  │   • support / complaint                  │
                  │   • smalltalk / context                  │
                  └────────────────┬─────────────────────────┘
                                   ▼
                  ┌──────────────────────────────────────────┐
                  │  Concierge Agent (Claude Sonnet)         │
                  │  + tools:                                │
                  │    - search_vendors(category, geo, …)    │
                  │    - book_table / book_transfer / …      │
                  │    - lookup_user_memory(query)           │
                  │    - save_user_memory(fact, tags)        │
                  │    - escalate_to_human(reason)           │
                  │  + system prompt with guardrails         │
                  └────────────────┬─────────────────────────┘
                                   ▼
              ┌────────────────────┴─────────────────────────┐
              ▼                                              ▼
   ┌────────────────────┐                       ┌────────────────────────┐
   │ Supabase (Postgres)│                       │ Vendor / Partner APIs  │
   │  users             │                       │  Agoda · Klook · GBiz  │
   │  user_profiles 🔐  │                       │  partner hotels · REA  │
   │  conversations     │                       │  Twilio voice handoff  │
   │  messages          │                       └────────────────────────┘
   │  memories (vector) │
   │  leads (whale)     │
   │  vendors           │
   │  bookings          │
   │  events (analytics)│
   └────────────────────┘
```

---

## 5. The User AI: How "Each User Gets Their Own Agent"

This is the part that makes NUM not just another chatbot.

### 5.1 Identity & UUID binding
When any new channel handle (phone, LINE userId, WeChat openid) hits us, we:
1. Generate a `user_uuid` (v7 — time-ordered, sortable).
2. Insert a row in `users` and a row in `channel_identities` linking the handle to the UUID.
3. The same person across channels can be merged later (verified email or phone match).

### 5.2 The Encrypted Profile
A `user_profile` row holds structured preferences:

```json
{
  "languages": ["en", "zh-CN"],
  "home_country": "CN",
  "stay_type": "long_stay",            // tourist | luxury | nomad | relocation
  "travel_party": {"adults": 2, "kids": [{"age": 7}]},
  "diet": ["no_pork"],
  "budget_band": "premium",
  "interests": ["diving", "international_schools", "villas"],
  "current_trip": {
    "arrival": "2026-06-12",
    "departure": "2026-06-26",
    "hotel": "Anantara Layan",
    "vehicle_source": "car_PHK_017"
  },
  "lifecycle_stage": "exploring_relocation",
  "consent": {"marketing": false, "partner_share": true, "version": "1.0"}
}
```

PII fields (`passport`, `email_hash`, `payment_token`, `home_address`) live in a separate `user_profile_secure` table, **envelope-encrypted** with per-tenant KMS keys.

### 5.3 Adaptive Memory (the "learning" loop)
Every meaningful turn does three things:

1. **Extract**: the Concierge Agent emits structured `memory_writes` as part of its tool calls (`save_user_memory({fact, tags, confidence})`).
2. **Embed**: the fact text is embedded and stored in `memories` with `user_uuid`, `tags[]`, `confidence`, `source_message_id`, `expires_at`.
3. **Retrieve**: on every new turn, before responding, we do a hybrid search (vector + tag filter) over that user's `memories` and inject the top-k into the system prompt as `<user_context>`.

Memories decay or get pruned: a "we hate cilantro" fact stays forever; a "looking for a villa this weekend" fact expires in 7 days unless re-confirmed.

### 5.4 What this unlocks
- **Day 1:** "I'm vegetarian and traveling with a 7-year-old."
- **Day 4:** User says "find us dinner tonight" — NUM proposes a kid-friendly veg-friendly place without re-asking.
- **Month 3:** User returns to Phuket for a school visit; NUM remembers their kid's age and proactively asks if they'd like another tour of the same shortlist.

That continuity is the product. It's also what makes the LTV justify the licensing fees in §3 of the Business Model doc.

---

## 6. Database Schema (Pilot)

The Gemini `leads`-table snippet was scoped for legal intake. Replacement schema below is the **concierge** schema. We still keep a `leads` table for whale-lead handoff to the partner's real estate / school network.

```sql
-- 6.1 Users & identity ------------------------------------------------
create table users (
  user_uuid       uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  preferred_lang  text default 'en',
  lifecycle_stage text default 'new',  -- new|tourist|nomad|relocating|customer|dormant
  acquisition_source text,             -- e.g. "car_PHK_017", "qr_anantara_lobby"
  partner_tenant_id uuid references partner_tenants(id)
);

create table channel_identities (
  id             uuid primary key default gen_random_uuid(),
  user_uuid      uuid references users(user_uuid) on delete cascade,
  channel        text not null,         -- 'whatsapp'|'sms'|'line'|'wechat'|'web'
  handle         text not null,         -- phone, line userId, wechat openid
  verified_at    timestamptz,
  unique (channel, handle)
);

-- 6.2 Profile (split: open vs. encrypted) -----------------------------
create table user_profile (
  user_uuid    uuid primary key references users(user_uuid) on delete cascade,
  profile_json jsonb not null default '{}',
  updated_at   timestamptz default now()
);

create table user_profile_secure (
  user_uuid    uuid primary key references users(user_uuid) on delete cascade,
  pii_ciphertext bytea not null,        -- envelope-encrypted JSON blob
  kms_key_id     text not null,
  updated_at     timestamptz default now()
);

-- 6.3 Conversation history (auditable) --------------------------------
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  user_uuid   uuid references users(user_uuid) on delete cascade,
  channel     text not null,
  started_at  timestamptz default now(),
  closed_at   timestamptz
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  user_uuid       uuid references users(user_uuid) on delete cascade,
  role            text not null,        -- 'user'|'assistant'|'tool'|'system'
  content         text not null,
  tool_calls      jsonb,
  created_at      timestamptz default now()
);

-- 6.4 Adaptive memory (vector) ----------------------------------------
create extension if not exists vector;

create table memories (
  id              uuid primary key default gen_random_uuid(),
  user_uuid       uuid references users(user_uuid) on delete cascade,
  fact            text not null,
  tags            text[] default '{}',
  confidence      numeric default 0.8,
  embedding       vector(1536),
  source_message_id uuid references messages(id),
  created_at      timestamptz default now(),
  expires_at      timestamptz
);

create index on memories using ivfflat (embedding vector_cosine_ops);
create index on memories using gin (tags);

-- 6.5 Whale leads (RE / school / relocation / visa) -------------------
create table leads (
  id              uuid primary key default gen_random_uuid(),
  user_uuid       uuid references users(user_uuid),
  vertical        text not null,        -- 'real_estate'|'school'|'relocation'|'visa'|'medical'
  budget_band     text,
  timeline        text,
  notes           text,
  partner_tenant_id uuid references partner_tenants(id),
  viability_score text,                  -- 'A'|'B'|'C'|'rejected'
  status          text default 'new',    -- new|contacted|qualified|closed_won|closed_lost
  handed_off_to   text,                  -- partner contact / agent name
  created_at      timestamptz default now()
);

-- 6.6 Vendors & bookings ----------------------------------------------
create table vendors (
  id           uuid primary key default gen_random_uuid(),
  partner_tenant_id uuid references partner_tenants(id),
  category     text,                     -- 'restaurant'|'hotel'|'transfer'|'tour'|'school'|'agent'
  name         text,
  geo          geography(point),
  metadata     jsonb,
  commission_pct numeric                  -- per-vendor override
);

create table bookings (
  id           uuid primary key default gen_random_uuid(),
  user_uuid    uuid references users(user_uuid),
  vendor_id    uuid references vendors(id),
  amount       numeric,
  currency     text default 'THB',
  commission   numeric,
  status       text,
  created_at   timestamptz default now()
);

-- 6.7 Multi-tenant licensing ------------------------------------------
create table partner_tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text,                      -- e.g. "Phuket InCar Group"
  region      text,
  tier        text,                      -- 'pilot'|'pro'|'enterprise'
  rev_share_pct numeric default 0.20,
  created_at  timestamptz default now()
);

-- 6.8 Acquisition / attribution ---------------------------------------
create table acquisition_sources (
  code           text primary key,       -- e.g. "car_PHK_017"
  partner_tenant_id uuid references partner_tenants(id),
  kind           text,                   -- 'vehicle'|'hotel_qr'|'event'|'web'
  label          text,
  metadata       jsonb,
  active         boolean default true
);

create table events (
  id          bigserial primary key,
  user_uuid   uuid references users(user_uuid),
  name        text,                      -- 'qr_scan','first_message','booking_made','lead_qualified'
  source      text,
  payload     jsonb,
  created_at  timestamptz default now()
);

-- 6.9 RLS (sketch) ----------------------------------------------------
alter table users enable row level security;
alter table user_profile enable row level security;
alter table user_profile_secure enable row level security;
alter table memories enable row level security;
alter table leads enable row level security;
-- policies: app role uses service_key; per-partner read scoped by partner_tenant_id;
-- user-self access by user_uuid claim in JWT (for future self-service portal).
```

---

## 7. System Prompt Skeleton (Guardrails)

```
You are NUM — a personal concierge for {{user.preferred_name or "this guest"}} in Phuket, Thailand.

Identity:
- You are the same NUM across every conversation. You remember.
- The user's UUID is {{user_uuid}}. Their profile is in <user_context>.

Behavior:
- Be warm, concise, fluent in {{user.preferred_lang}}.
- Always think before recommending. If you don't know, say so and ask.
- Never invent restaurants, prices, availability, or reviews.
- Prefer vendors in `vendors` table for the user's geo before suggesting third parties.

Boundaries:
- You are not a lawyer, doctor, tax advisor, or licensed real-estate broker.
- For legal/medical/financial questions: state that a qualified human will follow up, and create a `leads` record with vertical='legal'|'medical'|'finance'.
- For property/school/visa/relocation: collect budget + timeline + party size, then escalate as a whale lead.
- Do not store passport, payment, or government ID in plain chat. If the user volunteers it,
  call save_secure_pii() and acknowledge without echoing.

Memory:
- After each meaningful turn, call save_user_memory({fact, tags, confidence, expires_at?}).
- Before answering, call lookup_user_memory(query) and use it.

Escalation:
- If frustrated, confused, or asking for a human: call escalate_to_human(reason).
- For whale leads (RE / school / visa / long-stay): call create_lead(vertical, …) and tell the user a local specialist will follow up within 24h.
```

---

## 8. Security & Compliance Posture

| Area | Stance |
|---|---|
| **Data residency** | Pilot in Supabase ap-southeast-1 (Singapore) — closest low-latency region with PDPA-aligned controls. Mainland-China data path for WeChat traffic kept logically separate; PII fields encrypted before any cross-border egress. |
| **Encryption** | TLS 1.3 in transit. Postgres encrypted at rest. App-layer envelope encryption for `user_profile_secure`. KMS keys rotated quarterly. |
| **PDPA (Thailand)** | Consent collected at first interaction ("By replying, you agree to…"). User can request `delete_me` at any time → soft-delete users + hard-delete `user_profile_secure` + tombstone memories. |
| **GDPR (EU travelers)** | Same self-service path. Data Processing Addendum template prepared for partners. |
| **WeChat compliance** | Use a verified Service Account; never store WeChat openid as PII outside the linked UUID; respect the 48-hour service window for free-form replies (templated push outside that). |
| **UPL / disclaimers** | System prompt + per-vertical disclaimer text the agent must insert when crossing into legal/medical/financial. |
| **Logging** | Full conversation logged for QA, scrubbed of credit-card / passport / national-ID patterns at ingest by a regex+LLM scrubber. |
| **Audit** | Every memory write, lead creation, and escalation logged with `created_by_agent_version` so we can replay. |

---

## 9. Why this architecture beats the original Gemini blueprint

The blueprint was good for a legal-intake bot, but missed five things that matter for a concierge that we're licensing to a regional partner:

1. **No persistent user memory.** It collected 5 fields and stopped. NUM needs to keep learning forever — that's the LTV story.
2. **No multi-channel.** Twilio-only. We must reach WeChat + LINE on day one.
3. **No source attribution.** Without per-vehicle QR codes we can't prove pilot ROI.
4. **No multi-tenant model.** We're licensing this. Every record needs a `partner_tenant_id`.
5. **No whale-lead routing.** The economic upside is in real-estate and schools, not in $4 affiliate commissions.

All five are addressed above.
