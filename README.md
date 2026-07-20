# NUM — Project Index

**Owner:** Dre / Lumi · **Date:** 2026-05-26 · **Phase:** Pre-pilot tech refinement

NUM is an AI Personal Concierge — a multilingual, persistent chat assistant that lives across WhatsApp / LINE / WeChat / SMS / in-car QR. Every user gets their own AI agent tied to a UUID, with an encrypted profile that learns and adapts over time.

The Phuket pilot (with a local partner running 100+ in-car advertising screens and a 100+ hotel network) is the wedge.

---

## The package

### Strategy & spec (read these first)
| # | File | What it's for |
|---|---|---|
| 01 | [Master Architecture](./01_MASTER_ARCHITECTURE.md) | The canonical technical spec — tech stack, data model, per-user AI design, security, schema. Feed this to Claude Code when you're ready to build. |
| 02 | [Partner Proposal — Phuket](./02_PARTNER_PROPOSAL_PHUKET.md) | The personal reply to send + the structured 30-day pilot terms (scope, KPIs, roles, timeline, economics, decision gate). |
| 03 | [Business Model & Financials](./03_BUSINESS_MODEL.md) | Dual monetization: B2B licensing tiers (Pilot / Pro / Enterprise) + consumer-side streams (commissions, whale leads, NUM+ subscription). Unit economics + pilot snapshot + annualized tenant economics. |
| 04 | [Implementation Roadmap](./04_IMPLEMENTATION_ROADMAP.md) | What to keep / change / add vs. the original blueprint, 8-week build sequence to pilot launch, repo layout, and "done" definition. |

### Business plan, financials & pitch
| # | File | What it's for |
|---|---|---|
| 05 | [Financial Model](./05_FINANCIAL_MODEL.xlsx) | 36-month driver-based model — Assumptions, Pilot, Y1 monthly, Y2–Y3 quarterly, 3-year P&L summary, funding scenarios. Flex blue cells to test scenarios. |
| 06 | [Business Plan](./06_BUSINESS_PLAN.docx) | Investor- and partner-ready Word doc covering Lumi/AEROZ/NUM brand architecture, market, product, GTM, business model, financials, risks, ask. |
| 07 | [Partner Pitch Deck](./07_PARTNER_PITCH_DECK.pptx) | 15-slide partner-facing deck for the Phuket InCar Group. AEROZ-aligned dark aesthetic. Closes on five concrete decisions. |

### Developer build package (`/build/`) — hand this to whoever builds it
| File | What it's for |
|---|---|
| [`build/BUILD_README.md`](./build/BUILD_README.md) | Overview of the dev package, Path A (afternoon deploy) vs Path B (pilot-ready), pre-deploy checklist |
| [`build/requirements.txt`](./build/requirements.txt) | Pinned Python deps for Railway |
| [`build/.env.example`](./build/.env.example) | Every secret the app needs |
| [`build/schema_minimal.sql`](./build/schema_minimal.sql) | 5-table starter schema (Path A) |
| [`build/schema_full.sql`](./build/schema_full.sql) | Full multi-tenant schema with vector memory + encrypted PII (Path B) |
| [`build/system_prompt.txt`](./build/system_prompt.txt) | The Concierge Agent's brain — guardrails + tool-call instructions |
| [`build/main.py`](./build/main.py) | FastAPI app: webhooks for SMS / WhatsApp / LINE / WeChat, identity service, intent router, Claude integration |
| [`build/next_steps.md`](./build/next_steps.md) | The "make it runnable" checklist — today, this week, next 2 weeks, pre-launch |

---

## How to use this package

- **To respond to the partner:** open `02_PARTNER_PROPOSAL_PHUKET.md` — send section A as the reply, attach (or paste) section B onward as the formal terms.
- **To start building:** open `04_IMPLEMENTATION_ROADMAP.md` and hand its §4 sequence + `01_MASTER_ARCHITECTURE.md` to Claude Code.
- **To talk pricing with the partner or any future tenant:** `03_BUSINESS_MODEL.md` §2 (tiers) and §4 (pilot snapshot) are the conversational artifacts.
- **For your own clarity on what we're protecting:** `03_BUSINESS_MODEL.md` §8 (protective clauses).

---

## What's intentionally NOT here yet

- MOU / contract templates (next deliverable — needs a lawyer pass).
- System prompt v1 (drafted in §7 of `01_MASTER_ARCHITECTURE.md`, but needs voice-tuning once we have real conversation samples).
- Fine-grained merchant onboarding script (Phase 1 Week 4 deliverable).
- Pitch deck (derive from `03_BUSINESS_MODEL.md` when needed — happy to generate as `.pptx` on request).

---

## Open decisions for Dre

1. **Pilot vehicle count** — 30 / 35 / 40? (Drives infra sizing and merchant onboarding workload.)
2. **WeChat Service Account** — register fresh under Lumi, or use partner's existing? (Affects timeline by ~4–6 weeks.)
3. **Local concierge handler in pilot** — partner-side person, Lumi-side person, or shared? (Affects support SLA + cost split.)
4. **Naming + brand polish** — "NUM" as final consumer brand, or working name? (Affects domain + WeChat handle registration.)
5. **Bootstrapped vs. raise** — `03_BUSINESS_MODEL.md` §7 assumes bootstrapped through Year 2. Confirm or revisit.

Answer any one of these and I can move that workstream forward.
