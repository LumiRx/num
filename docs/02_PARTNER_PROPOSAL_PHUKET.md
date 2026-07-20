# NUM × Phuket InCar Group — Pilot Integration Proposal

**Prepared by:** Lumi (Dre)
**For:** Phuket InCar / Hospitality Network partner
**Date:** 2026-05-26
**Status:** Discussion draft — ready to send

---

## A. Personal Reply (the message to send)

Hey ——

Really appreciated your note. Your timing is almost suspicious — we've been building NUM with exactly the model you described in mind, and a captive in-car moment plus an existing hospitality network is the entry point we've been trying to design *toward*. So instead of going back and forth on basics, I want to lay out what we have, what we'd add for Phuket, and a concrete pilot you can say yes/no to.

**On where we are.** Yes — development has started. The core is built: a multilingual AI brain with persistent per-user memory, a Python/FastAPI backend, a Postgres+vector database for the user profile and "learning" layer, and channel adapters for WhatsApp, LINE, and SMS already mapped. We're in pre-pilot tech refinement — the perfect moment to fold in your in-car QR parameters, your hotel/merchant network, and a WeChat adapter for the Chinese segment.

**On WeChat.** Total agreement. For the Chinese inbound, WeChat isn't optional — it's the front door. Our architecture is channel-agnostic, so adding a verified Service Account is a 2-week add-on, not a rebuild. If you (or your team) already have a verified Service Account in mainland China, that saves us 4–6 weeks of registration — happy to use yours under a tenant key.

**On the bigger vision.** You're right that the LTV ceiling is way higher than restaurant commissions. The same AI that books a beach dinner on day 2 can recommend an international school on day 6, surface a long-term rental on day 9, and route a relocation services lead on day 30 — *because it remembers the user across all of those touches*. That continuity is the product, and it's exactly what makes long-stay and relocating-family segments make sense.

**On a pilot.** Yes, let's do it. 30–40 vehicles, one month, clear KPIs. I've structured the proposal below. The short version: you bring the cars, the hotel network, and the Chinese-market knowledge; we bring the AI, the multi-channel infra, and the analytics. We split outcomes fairly. If the numbers work, we move to a structured Phuket operating agreement with an exclusive territory window for you.

I do plan to be back in Phuket — happy to lock a date once you've reviewed the pilot terms below. In the meantime, anything in here you want to adjust, push back on, or expand?

— Dre

---

## B. The Pilot — Structured Terms

### B.1 Scope (Month 1)
- **30–40 vehicles** equipped with NUM QR + landing message ("Your AI guide to Phuket — scan to chat in your language").
- **3 channels live:** WhatsApp, LINE, WeChat (Service Account).
- **5 verticals seeded:** dining, transfers, tours/activities, hotel-add-ons (spa, late check-out), introductory **whale leads** (real estate inquiry, school inquiry, long-stay).
- **Languages:** EN, ZH-CN, TH (auto-detected per message); JP / RU optional if your vehicle mix needs it.
- **Merchant onboarding from your existing network:** target 40–60 vendors (restaurants, tours, transfers) and 4–6 high-ticket partners (1–2 real-estate agencies, 1–2 international schools, 1 relocation-services firm, 1 medical/wellness).

### B.2 KPIs (what we measure together, weekly)

| KPI | Target (Month 1) | Why it matters |
|---|---|---|
| **Scan rate per ride** | ≥ 8% of passengers scan QR | Tests in-car attention + creative |
| **Activation rate** | ≥ 60% of scanners send ≥ 1 message | Tests landing flow + first reply |
| **Avg session depth** | ≥ 6 messages | Proxy for usefulness |
| **D7 return rate** | ≥ 25% (any channel) | The memory product working |
| **Booking conversions** | ≥ 12% of activated users complete ≥ 1 booking | Direct revenue proof |
| **Whale leads** | ≥ 30 qualified (RE/school/relocation/long-stay) | The real upside |
| **Partner NPS** | ≥ 8/10 from onboarded merchants | Operational fit |

### B.3 Roles & responsibilities

| Workstream | Lumi (NUM) | Partner (Phuket InCar) |
|---|---|---|
| AI brain, memory, prompts | ✅ | — |
| Backend, infra, security | ✅ | — |
| Channel adapters (WA/LINE/WeChat) | ✅ | WeChat Service Account access |
| Vendor / merchant data ingestion | Build the schema + admin tool | Bring the relationships + content |
| In-car QR design & physical install | Generate per-vehicle codes | Print + install + train drivers |
| Local language QA (TH, ZH-CN) | LLM + spot review | Native reviewers from your team |
| Local merchant negotiations | Templates + commission tiers | Lead conversations |
| Customer support (escalations) | Auto-escalation logic | Human responder during pilot |
| Analytics dashboard | ✅ (read-only login for you) | Weekly review meeting |
| Legal / PDPA paperwork | Provide templates | Local counsel review |

### B.4 Timeline

| Week | Milestone |
|---|---|
| **Week 0 (now)** | Sign pilot MOU. You start WeChat Service Account check; we start tenant provisioning. |
| **Week 1** | Backend tenant + per-vehicle QR codes generated. First 10 vendors onboarded. Driver briefing pack. |
| **Week 2** | All 3 channels live in staging. 30–40 cars equipped. Internal dogfood with your team for 5 days. |
| **Week 3 (pilot start)** | Public launch in pilot vehicles. Daily monitoring; AI prompt tuning; merchant fill-ins. |
| **Weeks 4–6** | Steady-state pilot run. Weekly KPI reviews. |
| **Week 7** | Pilot wrap: results pack + decision on Phase 2 (territory agreement, scale-up plan). |

### B.5 Pilot economics (this pilot only)

We keep this simple and aligned during the test:

- **Setup fee:** waived for the pilot.
- **Software / hosting cost during pilot:** Lumi absorbs (estimated USD 1.8k–2.5k for the month — infra, LLM tokens, observability).
- **Revenue split during pilot** (any revenue NUM generates):
  - **Affiliate / booking commissions:** 50% Lumi / 50% Partner.
  - **Whale leads (RE / school / relocation):** 30% Lumi / 70% Partner (you do the closing).
  - **Merchant subscription fees (if any merchant pays a featured-listing fee):** 60% Partner / 40% Lumi (your network, your sale).
- **No charge to passengers.** Free to use, always.
- **Data:** Partner gets aggregated, anonymized pilot analytics + a read-only dashboard. Personal user data stays with the user (we are the processor, not the seller).

### B.6 Decision gate at Week 7
If the pilot hits **at least 4 of 7 KPIs**, we proceed to a structured Phuket operating agreement (terms in `03_BUSINESS_MODEL.md` §3 — Licensing Tiers, Territory model). If it doesn't, we do a no-fault wrap-up, you keep the merchant relationships, we keep the platform learnings, and we part on good terms.

---

## C. Strategic Upgrades We're Adding *Because* of Your Note

These were not in the v1 plan and are being added specifically because the partnership shape changes the product:

1. **WeChat Service Account adapter** — promoted from "Phase 2 nice-to-have" to **Phase 1 must-have**.
2. **Per-vehicle QR attribution** — new `acquisition_sources` table; every conversation traceable to a car, route, and driver.
3. **Lifecycle stage on the user profile** — `tourist → repeat_visitor → exploring_relocation → resident_prospect → customer`. Drives different agent prompts.
4. **Whale-lead router** — separate qualification flow for RE/school/visa/long-stay; auto-creates a `leads` record with viability score and routes to a partner specialist.
5. **Multi-tenant from day one** — `partner_tenant_id` on every row, so when we sign Bali / Bangkok / KL later, your data and theirs never mix.
6. **Partner read-only dashboard** — pilot KPIs visible to you in real time, not in monthly emails.

---

## D. What I'd Like From You to Move Forward

1. **Confirm pilot scope** — are 30–40 vehicles right, or do you want to start tighter (20) or wider (60)?
2. **WeChat Service Account** — do you already have a verified one we can leverage, or do we register fresh under Lumi?
3. **First merchant list** — pick 10–15 vendors from your network to seed week 1 (mix of dining, tours, and at least one school + one RE agency).
4. **Local lead handler** — who on your side fields the whale-lead escalations during pilot? Need a name, email, and rough response SLA (we'll target same-day during business hours).
5. **Phuket dates** — let me know your availability for an in-person session; I'll commit a window once I have yours.

Once we're aligned on those five, I can have the tenant provisioned and the first 5 cars live within 14 days of the MOU.

---

## E. One thing I want to flag honestly

The biggest risk in this pilot is **content quality, not technology**. The AI will only be as good as the vendor data + local nuance you and your team feed it. A polished prompt over a thin or stale vendor list will feel like every other chatbot. We need to invest the first 10 days hard on merchant content — opening hours, real photos, current promos, actual booking contact, honest "good for kids / good for couples / good for solo" notes. If we do that, NUM becomes the recommendation people trust. If we don't, no amount of model tuning fixes it.

That's why I want your network involved, not just your vehicles. The vehicles are the *funnel*; the network is the *product*.

Looking forward to your reply.
