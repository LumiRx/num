# NuM — Partner Integration Checklist
### Tick through with your ops + tech leads. 35 items. Most are < 1 day each.

**Partner:** _________________________________
**Partnership lead (you):** ___________________________
**Tech lead (you):** ___________________________
**Lumi counterpart:** Dre · andre@thatislumi.com
**Start date:** ___________
**Target soft-launch:** ___________

Tick boxes as you go. The first eleven items unblock everything else. Items marked 🔵 are Lumi's responsibility (we tick on your behalf); items marked 🟠 are yours.

---

## 0 · Agreement & access (Week 0 — Day 1–3)

- [ ] 🟠 Mutual two-page NDA signed
- [ ] 🟠 Partnership lead named (one decision-maker, no committee)
- [ ] 🟠 Tech lead named (for 45-min scoping call)
- [ ] 🟠 PDPA / DPA path agreed (we provide templates; your counsel reviews)
- [ ] 🔵 Pilot MOU + commercial terms shared (week-1 send)
- [ ] 🟠 Pilot MOU signed
- [ ] 🟠 Branch decision: **co-brand** ("Phuket AI, powered by NuM") · **white-label** · **independent NuM brand**
- [ ] 🟠 First 10-merchant seed list shared (mix: dining · tours · transfers · 1 spa · 1 school · 1 RE)
- [ ] 🟠 WeChat Service Account status confirmed: ☐ verified (yours) · ☐ register fresh under Lumi · ☐ skip China for now
- [ ] 🟠 Pilot scope confirmed: ☐ 20 vehicles · ☐ 30–40 · ☐ 60 · ☐ hotel lobbies only · ☐ mixed
- [ ] 🟠 Named human responder per vertical for whale-lead escalations (one name + email per RE · school · relocation · visa)

---

## 1 · Channels (Week 1)

### 1a · WhatsApp
- [ ] 🟠 Partner WhatsApp Business number or display name confirmed
- [ ] 🟠 Meta Business Manager access granted to Lumi (or admin email forwarded)
- [ ] 🔵 Twilio WhatsApp sender wired and approved
- [ ] 🔵 Webhook live at `https://<partner-subdomain>/whatsapp`
- [ ] 🔵 Test message round-trips: real partner phone → Sonnet reply, < 3s

### 1b · LINE
- [ ] 🟠 LINE Official Account created in partner's name (or existing one transferred)
- [ ] 🟠 LINE channel ID + secret + access token shared via 1Password / Doppler
- [ ] 🔵 Adapter live; reply token flow confirmed
- [ ] 🔵 Test message round-trips, < 3s

### 1c · WeChat (China unlock)
- [ ] 🟠 / 🔵 Service Account verification path chosen (yours or fresh)
- [ ] 🟠 / 🔵 App ID, App Secret, encryption AES key, server token configured
- [ ] 🔵 WeChat XML parse + reply path finished (currently 🟡 handshake-only)
- [ ] 🔵 48h customer-service window respected; no out-of-window pushes without approved templates
- [ ] 🔵 Test message in Mandarin round-trips, < 3s

### 1d · SMS (fallback)
- [ ] 🔵 Twilio number purchased in TH (or Cloudflare-routed alphanumeric sender)
- [ ] 🔵 Webhook live at `/sms`

### 1e · In-car / hotel QR
- [ ] 🟠 Vehicle / lobby inventory delivered (IDs, addresses, expected scan volume)
- [ ] 🔵 Per-source acquisition codes generated (`car_PHK_xxx`, `qr_<hotel>_<location>`)
- [ ] 🟠 QR codes printed + installed; drivers / front-desk briefed
- [ ] 🟠 Brand-aligned landing creative produced (logo + 1-line value prop + "scan to chat")

---

## 2 · Languages (Week 1–2)

- [ ] 🔵 Inbound language auto-detect live (Unicode-script + langdetect; shipped 2026-06-17)
- [ ] 🟠 Native-language reviewer named for **Thai** (2 hrs/wk during pilot)
- [ ] 🟠 Native-language reviewer named for **Mandarin (ZH-CN)** (2 hrs/wk)
- [ ] 🟠 Native-language reviewer named for **Russian** (2 hrs/wk)
- [ ] 🔵 Localized fallback strings ("AI unreachable" · "human takeover" · consent) translated for top 4 languages
- [ ] 🔵 `v_language_mix` view powering the dashboard language donut

---

## 3 · Merchant content (Week 1–2 — the make-or-break workstream)

- [ ] 🟠 Merchant content template delivered to your team (we provide a Google Sheet)
- [ ] 🟠 40–60 vendors loaded with: name · address · geo · hours · 3–5 real photos · contact for booking · honest segment notes · commission tier
- [ ] 🟠 4–6 high-ticket partners loaded: 1–2 RE agencies · 1–2 international schools · 1 relocation services firm · 1 medical/wellness
- [ ] 🔵 Vendor admin tool (minimal) live so your ops team can edit hours / photos / promos without engineering
- [ ] 🔵 Vendor-freshness flag wired to the merchant performance panel ("stale > 14d" warning)
- [ ] 🟠 Three vendor "voice samples" — examples of how your brand currently talks about these places — so the AI matches your tone, not a generic one

---

## 4 · AI brain & tools (Week 1–2 — Lumi-side)

- [ ] 🔵 Tool-use loop wired in the Concierge agent (`apps/api/services/concierge.py`)
- [ ] 🔵 Tool: `search_vendors(category, geo, filters)` — pgvector + tag filter
- [ ] 🔵 Tool: `create_lead(vertical, …)` — whale-lead route into the partner queue
- [ ] 🔵 Tool: `escalate_to_human(reason)` — escalations table + Slack ping
- [ ] 🔵 Tool: `lookup_user_memory(query)` + `save_user_memory(fact, tags, …)` end-to-end
- [ ] 🔵 Embedding worker (`apps/workers/embed.py`) live — memories actually become searchable
- [ ] 🟠 System-prompt voice review with your team (60-min Loom, you give written notes)

---

## 5 · Identity, security & compliance (Week 1–2)

- [ ] 🔵 RLS migration `0004` applied (Supabase) — 8 public tables locked down behind service role + future tenant JWTs
- [ ] 🔵 Encryption layer wired for `user_profile_secure` (Supabase Vault for v0, AWS KMS at Pro)
- [ ] 🔵 PII scrubber Haiku-pass added before going live with property / school flows
- [ ] 🔵 PDPA consent string drafted in EN + TH + ZH-CN
- [ ] 🟠 Local counsel sign-off on consent string in your market language(s)
- [ ] 🔵 `delete_me` slash-command path live (self-service)
- [ ] 🔵 GDPR DPA template signed for EU traveler exposure
- [ ] 🔵 Per-LLM-call cost tracking confirmed live (`llm_usage` table writing; shipped 2026-06-17)
- [ ] 🔵 Audit log table for memory writes + lead creates wired (post-pilot recommended)

---

## 6 · Operator surfaces (Week 2)

### 6a · Dashboard
- [ ] 🔵 Next.js scaffold + Supabase client + Tailwind deployed to Vercel
- [ ] 🔵 Read-only v1 with the 6 panels that have data: KPI strip · live convo stream · whale-lead queue · channel health · funnel · language share
- [ ] 🔵 Magic-link login (Dre + partner email allowlisted)
- [ ] 🟠 Partner partnership lead + named human responders' emails delivered
- [ ] 🔵 Tenant-scoped JWT policies live so partner sees their data only

### 6b · Marketing website
- [ ] 🔵 Domain registered (`num.<tld>` or partner-co-branded)
- [ ] 🔵 1-page Webflow site live — hero · how-it-works · channels · trust · CTA
- [ ] 🟠 Partner approves co-brand placement and footer attribution

### 6c · Slack alerts
- [ ] 🟠 `#num-ops` Slack channel created with both teams + Lumi
- [ ] 🔵 Alerts wired: new whale lead · SLA breach · channel error > 1% · hallucination flag · cost-over-budget > 10%
- [ ] 🔵 Monday 8am ICT digest email scheduled to Dre + partner lead

---

## 7 · Settlement & billing (Pilot)

- [ ] 🟠 Settlement model agreed (we recommend: pilot = referral monthly settlement; Pro = Stripe Connect splits)
- [ ] 🔵 Booking commission ledger schema in place
- [ ] 🔵 Whale-lead fee tracking schema in place
- [ ] 🟠 First-month commission reconciliation reviewed jointly
- [ ] 🔵 Pro-tier setup invoice issued at Week 7 if KPIs hit
- [ ] ⚪ Stripe Connect Phase 2 onboarding (post-pilot)

---

## 8 · Go-live, monitoring, decision gate (Weeks 3–7)

### Soft launch (Week 3)
- [ ] 🔵 5 vehicles / lobbies live with QR codes pointing at the channel handoff
- [ ] 🟠 Drivers / front-desk briefed in writing + 1 in-person walkthrough
- [ ] 🔵 Daily 15-min standup (both sides) for first 5 days
- [ ] 🔵 Dashboard live + watched

### Steady state (Weeks 4–6)
- [ ] 🟠 Native-language reviewers submitting weekly notes
- [ ] 🟠 Vendor freshness pass weekly (stale > 14d items refreshed)
- [ ] 🔵 AI prompt tuning from feedback (weekly)
- [ ] 🟠 Whale-lead pipeline health review (weekly) — SLA hit rate, conversion rate, close rate
- [ ] 🔵 Weekly KPI digest sent Monday 8am ICT

### Decision gate (Week 7)
- [ ] 🔵 7-KPI scorecard delivered: scan rate · activation · depth · D7 · bookings · whale leads · partner NPS
- [ ] 🟠 ≥ 4 of 7 hit → proceed to Pro contract for Month 2
- [ ] 🟠 Phase 2 territory + exclusivity terms negotiated if proceeding
- [ ] 🟠 If not proceeding: friendly wrap, partner keeps merchant relationships, Lumi keeps platform learnings

---

## What's NOT in this pilot (intentional — to keep scope honest)

- [ ] ⚪ Stripe Connect splits (Phase 2)
- [ ] ⚪ NUM+ consumer subscription paywall
- [ ] ⚪ Web widget on partner sites
- [ ] ⚪ Voice channel (Twilio Voice + Whisper)
- [ ] ⚪ Mobile thin client (iOS / Android)
- [ ] ⚪ Fine-tuned intent / extraction model
- [ ] ⚪ Multi-tenant cross-region user portability (lands at Enterprise tier)

Each of these has a clear post-pilot trigger. Listing them here so neither side is surprised when they don't ship in Week 1.

---

## Sign-offs

**Partner:** ____________________________  Date: ____________

**Lumi (Dre):** ____________________________  Date: ____________

*Working document. Update inline as items tick. Versioned in `~/Documents/Claude/Projects/LIFE/NuM/proposals/2026-06-10_phuket-ai/PARTNER_INTEGRATION_CHECKLIST.md`.*
