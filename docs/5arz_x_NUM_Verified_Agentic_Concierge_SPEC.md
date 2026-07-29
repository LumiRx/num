# 5arz × NUM — Verified Agentic Concierge: Build Spec
**2026-07-21 · v1 · design-first (implement in `Projects/NUM`) · owner: Andre**

> Goal: turn NUM (the multilingual AI concierge) into a **two-sided verified agentic marketplace** — every human verified by 5arz, every business self-onboarded and verified, and the user↔business interaction run agent-to-agent through NUM's brain, managed and tuned to each user. This is 5arz's proof-of-human thesis made tangible in a live consumer product.

---

## 0 · TL;DR

Three pieces, sequenced. Each maps to a known NUM gap and threads 5arz through it:

| # | Piece | Closes NUM gap | 5arz role |
|---|---|---|---|
| 1 | **Verify the human (users)** | A3/A4 identity+consent has no *real-human* proof | PoHF credential per user; Unique-Human anti-Sybil; identity tier for whales |
| 2 | **Self-serve business onboarding** | C2 merchant portal + C3 approval gate = GAP | Verify the *operator* is a real human; verified-operator required to publish |
| 3 | **Managed agentic interaction** | The match loop isn't agent-to-agent or settled | Agent-Tx-Binding (human↔agent↔payment) + x402 settlement; console tunes per-user policy |

The result: a marketplace where a **verified human's agent transacts with a verified business's agent**, brokered by NUM, settled and attested by 5arz. Nobody else can say that.

---

## 1 · What already exists (build on it, don't rebuild)

From NUM's architecture + FULL_FLOW:
- **Demand loop LIVE**: QR/hotel → WhatsApp/LINE/WeChat/SMS → FastAPI gateway → Identity → PDPA consent → PII scrub → language → Haiku intent (6 classes) → memory recall (pgvector) → Sonnet concierge + tools (`search_vendors`, `create_lead`, `escalate_to_human`, `save_user_memory`) → reply.
- **Supply**: `vendors` table, tenant-scoped, featured-ranked. Collection is manual (Thai team → `ingest_vendors.py`). **Self-serve (C2) + approval gate (C3) = GAP.**
- **Console**: role-based (Merchant / Operator / Specialist / Executive / AI Quality / **Master**), prototype live.
- **Stack**: Python 3.11 + FastAPI, Supabase (Postgres + pgvector + RLS), Claude Sonnet/Haiku, Twilio/LINE/WeChat, Railway, Stripe/Omise.

5arz brings what NUM lacks: **proof that the human on each end is real**, and a **rail to settle agent-to-agent** — the two things a trust-based, high-value-lead marketplace needs most.

---

## 2 · Piece 1 — 5arz verifies the human (users)

**Where it hooks:** the Identity + Consent stage (FULL_FLOW A3–A4), immediately after `user_uuid` is resolved and PDPA consent is captured, *before* any booking or whale hand-off.

**Two tiers (friction matched to stakes):**
- **Tier L — Proof-of-Human (light):** device + liveness/behavioral signal via 5arz. Near-zero friction, runs in the chat flow. Blocks bots/Sybils on the demand side. Default for every user.
- **Tier I — Identity-verified (full):** 5arz identity verification (Stripe Identity) — triggered only when it matters: a booking that needs a name, or a **whale lead** (property, school enrolment, visa/relocation) where the specialist effectively needs KYC-grade trust. This is where verification becomes *revenue-protecting*, not just anti-bot.

**Flow (Tier L, inline):**
```
user first contact → NUM resolves UUID + PDPA consent
  → NUM (as a registered 5arz agent) opens a 5arz verify session for this user
  → NUM sends a one-tap verify link in the user's language (or embeds a lightweight check)
  → 5arz issues a PoHF credential (ES256 JWT) bound to the user + a Unique-Human attestation
  → NUM stores { pohf_jti, unique_human_jti, tier, verified_at } on the user
  → concierge proceeds; businesses now see "verified human"
```
Tier I is the same flow with 5arz's identity step; upgrades the user's record on completion.

**Data model (Supabase `users` / `user_profiles`):**
```
+ human_tier          text   -- 'unverified' | 'proof_of_human' | 'identity'
+ pohf_jti            text   -- 5arz credential id (portable, JWKS-verifiable)
+ unique_human_jti    text   -- anti-Sybil attestation id
+ human_verified_at   timestamptz
+ human_verify_ref    text   -- 5arz session/ref for re-check
```

**5arz calls NUM makes** (NUM holds an `arz_live_` agent key in secrets):
- Start/verify: `POST https://api.5arz.com/api/agents/verify` (session/member path) → returns the signed PoHF.
- Anti-Sybil: request the Unique-Human attestation so one person can't run many NUM profiles (protects whale-lead integrity + referral fairness).
- Re-verify on sensitive actions: cache the credential; re-check `jti` validity via JWKS before a whale hand-off or a payment.

**Why it matters (say this to partners/investors):**
- **Demand integrity:** bots and fake accounts can't farm offers, referrals, or specialist time.
- **Whale-lead trust:** a property agent or international school is receiving a *verified real person*, not a scraped lead — materially higher close rate and price.
- **Business confidence:** merchants know NUM sends real humans, which is exactly what they pay for.

---

## 3 · Piece 2 — Self-serve business onboarding (agentic supply)

Closes **C2 (merchant self-serve)** + **C3 (approval gate)**. Turns supply from "Thai team types a sheet" into "businesses onboard themselves, verified."

**Flow:**
```
business visits self-serve portal (new: apps/site or apps/dashboard 'Merchant' role)
  → creates account; the OPERATOR completes 5arz human-verification (Tier I)
  → submits listing: category, geo, hours, media, offers/promos, engagement rules
  → listing enters `pending` (C3 approval gate)
  → AI-assisted quality check (Haiku): completeness, policy, plausibility, dup-detection
  → Operator/Master approves → status `approved` → only now visible to the concierge AI
  → freshness loop (C4): stale listings nudged; verified+fresh rank higher
```

**5arz on the supply side:**
- **Operator verification required to publish.** No verified real operator → listing can't go live. Kills fake/fraud vendors at the source.
- Optionally bind offers to the operator with an **Agent-Tx-Binding**-style credential so a promo is provably issued by a verified business.

**Data model (`vendors`):**
```
+ status              text   -- 'pending' | 'approved' | 'rejected' | 'stale'   (the quality moat)
+ operator_pohf_jti   text   -- verified business operator
+ operator_verified   boolean
+ self_serve          boolean
+ engagement_config   jsonb  -- how this business wants its agent to behave (see Piece 3)
+ freshness_at        timestamptz
```

**Agentic business config (`engagement_config`)** — what a business sets about *how* NUM represents it:
- Offers + rules ("free dessert via NUM after 8pm", "20% off villa viewings this month").
- Availability / booking policy (auto-accept under $X, else human-confirm).
- Tone/positioning line the AI may use.
- Escalation ("send me high-value enquiries directly").

This is the "agentic" supply side: the business configures an agent; NUM's brain *is* that agent to the user, inside the rules the business set and the quality gate you enforce.

---

## 4 · Piece 3 — Managed agentic interaction (the core loop)

The heart of your ask: *"businesses interact with the user through our system we manage and set according to what the user needs."*

**Model it as agent-to-agent with a verified human on each end:**
- **User side:** NUM's concierge = the *user's* agent. It holds the encrypted profile + memory and acts on the user's behalf, tuned to their needs.
- **Business side:** each approved vendor = a *business* agent defined by its `engagement_config`.
- **NUM (the platform) is the broker + the manager:** it matches, negotiates within the business's rules and the user's preferences, and **you over-manage** via the console (per-user and per-tenant policy).

**"Managed and set to what the user needs" — concretely:**
- Per-user policy the AI enforces: budget band, quality bar, language, do/don't, whale-vertical routing — set from the user's profile and, for VIPs, tuned by an Operator in the console.
- The AI never exceeds a business's rules (config) or a user's policy. Both sides are bounded; the platform holds the middle.

**When an interaction becomes a transaction (booking / lead / commission):**
```
concierge proposes → user accepts (verified human) → business agent accepts (rules/human-confirm)
  → 5arz issues an Agent-Tx-Binding credential:  human(user) ↔ agent(NUM) ↔ business ↔ payment_ref
  → settlement: commission via x402 (USDC) or Stripe Connect; recorded to a settlement ledger
  → both sides hold a portable, verifiable receipt that a real human authorized a real business action
```
This is 5arz's exact thesis (proof-of-human + agentic settlement) running inside a consumer concierge. It also closes NUM's **D5 (close + fee)** and **E3 (settlement ledger)** gaps.

**Console over-management (Master/Operator):** live view of every interaction, per-user policy controls, whale assignment (D3), SLA timers (D4), and settlement (D5/E3) — the "we manage" layer you described.

---

## 5 · The two-sided verified marketplace

```
 VERIFIED HUMANS (demand)                         VERIFIED BUSINESSES (supply)
  user ──5arz PoHF──► verified                     operator ──5arz PoHF──► verified
   │  (Unique-Human anti-Sybil)                       │  self-serve listing + config
   │  encrypted profile / needs                       │  APPROVAL GATE (quality moat)
   ▼                                                  ▼
 ════════════ NUM: the user's agent ⇄ the business's agent ════════════
        matched + negotiated within user policy ∩ business rules
        transaction → 5arz Agent-Tx-Binding + x402/Stripe settlement
 ═══════════════ CONSOLE: you manage + tune per user / tenant ═══════════════
        Master · Operator · Specialist · Merchant · AI-Quality
```

Every arrow that touches money or a whale has a **verified human on each end and a portable 5arz receipt**. That is the moat.

---

## 6 · Build sequence (what to build first)

**Sprint 1 — Verify the human (Piece 1).** NUM registers as a 5arz agent; add the two-tier verify flow at identity/consent; add `users` columns; gate whale hand-off + payments on a valid credential. *Highest differentiation, smallest surface.*

**Sprint 2 — Self-serve business onboarding (Piece 2).** Merchant self-serve portal + operator 5arz-verify + the `vendors.status` approval gate + `engagement_config`. *Opens supply; the approval gate is the quality moat.*

**Sprint 3 — Managed agentic interaction + settlement (Piece 3).** Agent-to-agent negotiation within user-policy ∩ business-rules; Agent-Tx-Binding on transactions; x402/Stripe settlement ledger; console controls. *Closes the money loop (D5/E3) and lands the thesis.*

Each sprint is shippable on its own and strictly additive to the current NUM code.

---

## 7 · Compliance & guardrails (carry these into the build)

- **PDPA first:** 5arz verification is layered *after* consent; the PoHF stores no raw PII in NUM (only a credential id + tier). Right-to-delete cascades to the credential ref.
- **Honest AI (NUM principle #4):** never imply a business is verified/available when it isn't; "verified human" and "verified business" claims must be literally true and backed by a live credential.
- **Firewall the raise from the product:** NUM is a consumer/B2B product; keep any 5arz *token/node* capital language entirely out of NUM surfaces (per the 5arz counsel pass).
- **Whale-lead KYC:** Tier-I identity for property/visa/school leads — but store the minimum, encrypted, and treat it as regulated data.
- **Data ownership:** monetize outcomes (bookings, leads, settlement), never raw profile data — unchanged from NUM's model.

---

## 8 · Why this is strategic for 5arz

NUM becomes the **flagship consumer demonstration** of the 5arz layer: real verified humans on both sides, agent-to-agent commerce, x402 settlement, portable on-chain-anchorable receipts — in a product that already has channels, a brain, and a Phuket pilot. It's the most tangible proof-of-thesis 5arz can put in front of a partner or investor: *"here's the proof-of-human layer running a live marketplace."*

---

### Immediate next step
On your go, I'll (a) drop this into `Projects/NUM/docs/` so the NUM/Duke session has it, and (b) write **Sprint 1** as an implementation-ready module (the 5arz verification service + the identity/consent hook + the `users` migration) — additive files, coordinated so nothing in the parallel session is overwritten.
