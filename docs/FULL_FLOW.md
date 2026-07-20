# NUM — The Full Flow

**Updated:** 2026-07-17 · The complete circuit: a tourist's text → the AI → the management system → money — and the supply loop where businesses feed the AI. One page; every stage marked **LIVE** (code shipped + tested) or **GAP** (what closes it).
**Renders live in:** `apps/dashboard/mobile_prototype.html` → role **Master** → Flow tab.

---

## The two loops + the command layer

NUM is a marketplace with an AI in the middle. Demand flows in from vehicles and hotels; supply flows in from businesses; the AI matches them; whales get extracted to humans; you over-manage the whole circuit.

```
DEMAND LOOP (users)                          SUPPLY LOOP (businesses)
 QR in car/hotel                              Merchant collected/self-serve
   ↓ scan                                       ↓ submit listing + offers
 WhatsApp / LINE / WeChat / SMS                 ↓ APPROVAL GATE (quality)
   ↓ text                                     vendors table (tenant-scoped)
 ═══════════════ THE AI (pipeline + concierge) ═══════════════
   identity → consent → scrub → lang → intent
   → memory lookup → Claude + tools:
        search_vendors ──── reads SUPPLY
        create_lead ─────── spawns WHALE FLOW
        escalate_to_human ─ spawns OPS FLOW
        save_user_memory ── deepens next turn
   ↓ reply (user's language, <3s)
 OUTCOMES: booking referrals → merchant accepts → commission
           whale leads → specialist closes → fee
           memory → user returns (D7) → lifecycle deepens
 ═══════════════ MANAGEMENT (the console) ═══════════════
   Merchant portal · Operator · Specialist · Executive · AI Quality
   → MASTER (Dre): whole circuit, all tenants, all controls
```

---

## Stage by stage — status

### A · Demand: text in

| # | Stage | What happens | Status |
|---|---|---|---|
| A1 | QR scan in vehicle/hotel | `/qr/{code}` binds `acquisition_source` → channel handoff | **LIVE** — codes not yet printed/installed (domain decision) |
| A2 | Message arrives | Twilio (WA/SMS), LINE, WeChat webhooks; signatures verified | **LIVE** — WA sender approval + LINE channel + WeChat SA are account tasks |
| A3 | Identity | (channel,handle) → `user_uuid`; tenant resolved from source | **LIVE** |
| A4 | Consent (PDPA) | First contact: disclosure in user's language + audit row; DELETE = real erasure | **LIVE** |
| A5 | Scrub + language + intent | Regex PII scrub → script-based lang detect → Haiku intent (6 classes) | **LIVE** |

### B · The AI

| # | Stage | What happens | Status |
|---|---|---|---|
| B1 | Memory recall | Embed query → pgvector `match_memories` → top-5 facts into prompt | **LIVE** (needs OPENAI key in prod) |
| B2 | Concierge tool loop | Sonnet, max 5 turns; never invents vendors | **LIVE** |
| B3 | `search_vendors` | Tenant catalogue, featured-tier ranked | **LIVE** — needs vendor DATA (Thai team) |
| B4 | `create_lead` | Whale insert + Slack ping | **LIVE** |
| B5 | `escalate_to_human` | Event + Slack ping | **LIVE** |
| B6 | `save_user_memory` | Fact + expiry; embed worker backfills | **LIVE** |
| B7 | Reply | User's language; localized fallback if LLM down; cost logged per call | **LIVE** |

### C · Supply: businesses → the AI

| # | Stage | What happens | Status |
|---|---|---|---|
| C1 | Collection (now) | Thai team sheet → `ingest_vendors.py` → vendors table | **LIVE** — fieldwork running |
| C2 | Merchant self-serve (v3) | Portal: edit listing/hours/promo, see "what guests asked" | **GAP** — designed (Merchant role in console), build wk 5–6 |
| C3 | **Approval gate** | New/edited listings held in `pending` until approved → only then visible to AI | **GAP** — needs `vendors.status` column + approve action; **this is the quality moat** |
| C4 | Freshness loop | Stale content flagged → nudge merchant → AI recommends fresh vendors more | **GAP** — freshness tracked in prototype; nudge worker not built |
| C5 | Offers/promos to AI | `metadata.promo` surfaces in recommendations ("free dessert via NUM") | **LIVE** (schema) — merchants can't self-edit until C2 |

### D · Whale flow (the money)

| # | Stage | What happens | Status |
|---|---|---|---|
| D1 | Detect + qualify | Intent WHALE → AI gathers budget band + timeline → `create_lead` | **LIVE** |
| D2 | Alert | Slack #num-ops instant ping | **LIVE** (webhook URL pending) |
| D3 | Assign | Lead → specialist by vertical | **GAP** — `leads.handed_off_to` exists; assign UI = Master/Operator action |
| D4 | Work + SLA | Specialist workbench: memory context, status pipeline, SLA timers | **Designed** (console) — mutations = build v2 |
| D5 | Close + fee | `closed_won` + fee recorded; 30/70 split | **GAP** — needs `leads.fee_amount` + settlement ledger |

### E · Management + money

| # | Stage | What happens | Status |
|---|---|---|---|
| E1 | Role consoles | Operator/Exec/Specialist/Merchant/Quality/Admin — designed, clickable | **Prototype LIVE** — Next.js build sequenced |
| E2 | **Master (Dre)** | Whole circuit: flow, whales, supply, traffic, ops controls | **Prototype LIVE** (role: Master) |
| E3 | Booking commission | Referral model: vendor link + monthly settle (`commission_pct` captured) | **LIVE** (model) — settlement ledger GAP |
| E4 | Cost/margin | Per-call `llm_usage` → cost/user views | **LIVE** |
| E5 | Weekly digest | Monday email to partner + Dre | **GAP** — 1-day worker |

---

## The critical path through this map

1. **Deploy** (runbook) → A2 accounts live → the demand loop breathes.
2. **Vendor data** (Thai team, running) → B3 has supply → bookings flow.
3. **Whale assign action** (D3) + fee field (D5) → the money loop closes end-to-end.
4. **Approval gate** (C3) → merchants can eventually self-serve without polluting the AI.
5. Everything else is leverage, not blockage.

**North-star mechanic:** every stage above emits events already (`events`, `leads`, `llm_usage`, `consent_events`, `bookings`) — the Master dash reads the circuit in real time. When a stage's number drops, that's where you look. Traffic → conversation → action → outcome → revenue: four conversions, one screen.
