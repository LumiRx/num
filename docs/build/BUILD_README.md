# NUM — Developer Build Package (`/build/`)

**Hand this folder + `/01_MASTER_ARCHITECTURE.md` + `/04_IMPLEMENTATION_ROADMAP.md` to Claude Code or a senior dev.**

This folder is the **starting scaffold** — five files that get you from zero to a deployable FastAPI server on Railway. The master architecture document is the *what* and *why*; this folder is the *how* (concrete code/config) for the first iteration.

---

## What's in here

| File | Purpose |
|---|---|
| `requirements.txt` | Python dependencies pinned for Railway deploy |
| `.env.example` | Every secret the app needs — copy to `.env` and fill in |
| `schema.sql` | Postgres schema for Supabase (pointer to the full master schema + a minimal-deploy starter) |
| `system_prompt.txt` | The Concierge Agent's system prompt with guardrails + tool-call instructions |
| `main.py` | FastAPI app: webhook routing, identity, intent routing skeleton, Claude integration stub |

---

## How this differs from the Gemini handoff package

The original Gemini handoff was clean but minimal. We extended it in five ways to match the architecture we locked:

1. **LLM:** Switched from `google-generativeai` to **`anthropic`** (Claude Sonnet for chat, Haiku for routing). See `01_MASTER_ARCHITECTURE.md` §3 for the rationale.
2. **Channels:** Original was Twilio-only. We added handler stubs for **LINE** and **WeChat** because the Phuket partner pilot requires all three on day one.
3. **Schema:** Original had 3 tables (users, high_ticket_leads, partners). The master architecture has 13 tables including `memories` (pgvector), `partner_tenants` (multi-tenant), `acquisition_sources` (per-vehicle QR attribution), and a split `user_profile` / `user_profile_secure` for encrypted PII. The full schema is in `01_MASTER_ARCHITECTURE.md` §6 and reproduced as `schema_full.sql` here. We kept a `schema_minimal.sql` for a "deploy something in 1 hour" path.
4. **Identity:** Original keyed users on `phone_number`. We key on a **`user_uuid`** with channel handles as a join table — required for cross-channel identity and the "one user, one AI, follows them everywhere" experience.
5. **Memory:** Original was stateless extraction. We added **persistent vector memory** (`memories` table + embed-on-write + retrieve-on-read) — this is the core product differentiation.

---

## The two paths to first deploy

### Path A — "Get something live in an afternoon" (recommended for first dogfood)
1. Use `schema_minimal.sql` (5 tables, no vector memory, no encryption).
2. Use the SMS-only path in `main.py`.
3. Deploy to Railway, point a Twilio number at `/sms`.
4. Confirm a real text message round-trips through Claude and back.

### Path B — "Pilot-ready build" (do this before partner pilot launches)
1. Use `schema_full.sql` (full multi-tenant, vector memory, encrypted PII).
2. Enable LINE and WeChat adapters.
3. Wire pgvector and the memory worker.
4. Add the partner dashboard (Next.js, separate repo).
5. Follow the 8-week sequence in `/04_IMPLEMENTATION_ROADMAP.md` §4.

Start with Path A this week; convert to Path B during weeks 1–3 of the build sequence.

---

## Critical pre-deploy checklist

- [ ] Supabase project created in `ap-southeast-1` (Singapore — closest to Phuket).
- [ ] Twilio account verified, WhatsApp Business sender approved (this can take 1–3 days, start now).
- [ ] LINE Messaging API channel created.
- [ ] WeChat Service Account verification path decided (partner's existing account vs. fresh Lumi registration).
- [ ] Anthropic API key issued, with rate-limit headroom for pilot volume (~5k convos/mo target).
- [ ] Railway project provisioned with health-check + autoscaling on.
- [ ] Doppler (or Railway env) configured — **no keys in repo**.
- [ ] KMS key created (Supabase Vault for v0, AWS KMS for v1+).
- [ ] Sentry / Logfire wired before first deploy.

---

## Files in this folder

- `BUILD_README.md` — this file
- `requirements.txt`
- `.env.example`
- `schema_minimal.sql` — Path A starter (5 tables)
- `schema_full.sql` — Path B production schema (mirrors `01_MASTER_ARCHITECTURE.md` §6)
- `system_prompt.txt`
- `main.py`
- `next_steps.md` — the immediate "make it runnable" task list
