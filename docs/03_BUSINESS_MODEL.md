# NUM — Business Model & Financial Structure

**Version:** 1.0
**Owner:** Lumi
**Last updated:** 2026-05-26

---

## 0. The Frame

Most "AI concierge" plays die because they pick *one* revenue stream and underprice it. NUM monetizes on **two sides** of the same conversation:

- **B2B side:** regional operators (like the Phuket InCar Group) license the NUM platform on a tenant basis to deploy in their territory.
- **B2C / transactional side:** the platform earns from the user journey itself — affiliate commissions, premium tier, and high-ticket lead-gen.

Neither side alone is the business. Together they compound: more partners → more vehicles/QRs → more users → more conversations → more transactional revenue → better AI → better conversion → more partners want in.

---

## 1. Revenue Streams (overview)

| # | Stream | Who pays | When it kicks in | 12-mo target % of revenue |
|---|---|---|---|---|
| 1 | **Tenant license (B2B)** | Regional operators | Pilot → Pro → Enterprise | 35% |
| 2 | **Setup / onboarding fee** | New tenants | At signing | 5% |
| 3 | **Booking / affiliate commissions** | Vendors (or via Agoda/Klook/etc.) | Each completed booking | 25% |
| 4 | **Whale-lead fees** | Real-estate / school / relocation partners | Per qualified lead + success bonus | 20% |
| 5 | **Merchant featured-listing** | Local vendors paying for placement | Monthly subscription | 8% |
| 6 | **Consumer premium ("NUM+")** | End users | Optional upgrade | 5% |
| 7 | **Data products (aggregated, opt-in)** | Tourism boards, hotels | Quarterly reports | 2% |

Rough mix — will rebalance as the Phuket pilot tells us where the cash actually comes from.

---

## 2. Stream-by-Stream Detail

### 2.1 Tenant license (B2B) — the platform fee

This is what we charge operators like the Phuket partner for the right to deploy NUM in a defined territory.

| Tier | **Pilot** | **Pro** | **Enterprise / Territory** |
|---|---|---|---|
| **Target customer** | New regional partner running a 30-day test | Active operator post-pilot, single city/region | Multi-city operator, exclusive territory, white-label |
| **Setup fee (one-time, USD)** | Waived | **$5,000** | **$25,000** |
| **Monthly platform fee (USD)** | $0 (we cover infra) | **$2,500/mo** base + usage | **$8,000–$15,000/mo** depending on territory size |
| **Usage component** | n/a | **$0.04 per active conversation** above 5,000/mo included | **$0.025 per active conversation** above 25,000/mo included |
| **Channels included** | WA, LINE, WeChat | WA, LINE, WeChat + 1 custom (in-car QR, hotel kiosks) | All + custom integrations |
| **Languages** | EN + ZH-CN + TH | + 2 more on request | Unlimited |
| **White-label / co-brand** | Co-brand "Powered by NUM" | Co-brand | Full white-label |
| **Tenant-isolated data** | ✅ | ✅ | ✅ + dedicated KMS keys |
| **Revenue share Lumi : Partner — bookings** | 50 : 50 | 35 : 65 | 25 : 75 |
| **Revenue share Lumi : Partner — whale leads** | 30 : 70 | 25 : 75 | 20 : 80 |
| **Revenue share Lumi : Partner — merchant subs** | 40 : 60 | 30 : 70 | 25 : 75 |
| **Min annual commitment** | 1 month | 6 months | 24 months |
| **Exclusivity** | None | Optional (+30% fee) | Included for defined territory |
| **SLAs** | 95% uptime | 99% uptime, 24h support | 99.9% uptime, 4h support, named CSM |

**How we land a tenant:**
1. Pilot (Month 1) — free/cost-covered, prove KPIs.
2. Pro contract (Months 2–7) — monthly cash + rev share.
3. Enterprise (Month 7+) — exclusivity, multi-city, multi-year.

### 2.2 Booking / affiliate commissions

The user books *through* NUM. We earn either:

- **Direct vendor commissions** (negotiated): typical 10–20% of transaction value for restaurants, tours, transfers; 5–10% for hotel add-ons.
- **OTA affiliate** (Agoda, Klook, Booking, Viator, GetYourGuide): 4–10% depending on category.
- **Activity / tour operators:** 15–25% (high margin).

Split with the tenant per the table in §2.1.

### 2.3 Whale-lead fees (the real upside)

Routed via the `leads` table when the agent detects high-LTV intent.

| Vertical | Fee model | Indicative size (USD) |
|---|---|---|
| **International school inquiry** | Qualified-lead fee + 1-time placement bonus on enrollment | $50–$200/lead, $1,500–$5,000/enrollment |
| **Real estate — long-term rental** | % of first month rent | 25–50% of one month (~$500–$2,000) |
| **Real estate — purchase** | % of agency commission (sub-broker fee) | 10–25% of agent's commission; for a $500k villa at 3% agent comm = $1,500–$3,750 |
| **Relocation services** | Flat referral + % of services package | $200–$500 + 10–15% of package |
| **Visa / immigration consultants** | Per qualified consultation | $30–$80/lead |
| **Medical / wellness retreats** | % of package | 10–15% of package |
| **Luxury concierge / private jet / yacht** | Flat referral + bonus | $250–$1,500/lead |

Even modest pilot conversion math: **30 qualified whale leads × $300 blended fee = $9,000** in a single month from one operator. That alone can pay the platform fee twice over.

### 2.4 Merchant featured-listing (subscription)

Local vendors pay a monthly fee for:
- Priority placement in NUM recommendations (transparently labeled as "featured").
- Photo + menu + promo updates managed via simple admin form.
- Booking-button integration.

| Tier | Monthly fee (USD) | What they get |
|---|---|---|
| **Local** | $49 | 1 location, basic listing, photos |
| **Standard** | $149 | 1 location, featured priority, promos, weekly metrics |
| **Premium** | $399 | Multi-location, top-tier ranking, push campaigns, dedicated support |

Soft target: 60 vendors in Phuket within 6 months × blended $120 = ~$7.2k/mo recurring (split with tenant per §2.1).

### 2.5 Consumer premium — "NUM+"

A clearly-optional upgrade. The free tier is generous and stays generous — we don't paywall the assistant.

| Tier | Price | What's included |
|---|---|---|
| **NUM (free)** | $0 | Full concierge, all channels, persistent memory, recommendations, transparent featured listings. |
| **NUM+** | **$9.99/mo** or **$79/yr** | Priority response queue, no featured-listing bias (pure ranking), proactive trip planning ("you're flying in next week, here's a curated plan"), itinerary export, family-share (up to 4 profiles), expense splitting, early access to new verticals. |
| **NUM Concierge** | **$199/mo** | NUM+ features + escalation to a real human concierge within 1 hour, 24/7. For luxury and long-stay segments. |

Realistic take-rate at scale: **2–4%** on NUM+, **0.2–0.5%** on Concierge. With 10k MAU per tenant that's ~$2.5k–$5k/mo extra per tenant, almost pure margin.

### 2.6 Data products (opt-in only, aggregated)

Quarterly anonymized intelligence reports for tourism boards, hotel groups, and DMOs:
- Top user origins, query trends, sentiment by neighborhood, seasonal demand shifts.
- Price: **$2,500–$10,000 per report**.
- **Strict rule:** never sell individual user data; only aggregates from users who opted in.

---

## 3. Unit Economics

### 3.1 Cost per active user (per month)

Built on conservative LLM + infra estimates for an *active* user (avg 35 messages/mo across two short sessions):

| Item | $/active user/mo |
|---|---|
| LLM tokens (Sonnet for chat ~70%, Haiku for routing/extract ~30%, with memory caching) | $0.32 |
| Embeddings + vector storage | $0.02 |
| Twilio/WeChat/LINE messaging fees (blended) | $0.18 |
| Postgres + Supabase compute share | $0.05 |
| Observability, logs | $0.03 |
| Misc (KMS, queues, CDN) | $0.04 |
| **Total variable COGS** | **~$0.64 per active user/mo** |

A dormant or low-touch user costs essentially $0.

### 3.2 Revenue per active user (per month) — blended target by Month 6

| Stream | Per-active-user contribution |
|---|---|
| Booking commissions (12% convert × $40 avg comm) | $4.80 |
| Whale leads (1% rate × $300 blended) | $3.00 |
| Premium take-rate (3% × $9.99) | $0.30 |
| Featured-listing allocation (per user share) | $0.40 |
| **ARPU (blended)** | **~$8.50/mo** |

That's a **~13× revenue:COGS ratio** before tenant rev-share. Even after a 50/50 split in pilot tier, Lumi's net contribution per active user is ~$3.60/mo — and that's pessimistic.

### 3.3 LTV vs. CAC

- **Avg active lifetime (tourist segment):** 2.5 months (trip + post-trip reactivation).
- **Avg active lifetime (long-stay / relocating):** 14+ months.
- **Blended LTV:** ~$45 per user (mixed segment).
- **CAC in partnered model:** ~$0 direct (the partner brings the funnel). Lumi pays only platform/AI build cost.
- **LTV/CAC in partnered model:** effectively bounded by tenant economics, not user acquisition.

This is why the partnered model is so efficient — we don't pay to acquire users; tenants do that with their existing distribution.

---

## 4. Pilot Financial Snapshot (Phuket, Month 1)

Conservative pilot assumptions: 35 vehicles, ~25 rides/day/vehicle, 8% scan rate, 60% activation, 30-day month.

| Metric | Calc | Value |
|---|---|---|
| Rides | 35 × 25 × 30 | 26,250 |
| Scans | × 8% | 2,100 |
| Activated users | × 60% | 1,260 |
| Active users (≥6 msgs) | × 70% | 882 |
| Bookings | × 12% × $40 avg comm | $4,234 |
| Whale leads (qualified) | × 3.5% = ~30 leads × $300 | $9,000 |
| **Pilot gross revenue** | | **~$13,234** |
| Lumi share (50% bookings, 30% leads) | $2,117 + $2,700 | **$4,817** |
| Partner share | $2,117 + $6,300 | **$8,417** |
| Lumi pilot costs (infra + tokens absorbed) | | **~$2,300** |
| **Lumi net (pilot, month 1)** | | **~$2,500** |

That's break-even-plus on a free pilot — proof we can hand this to a partner without losing money, and the *real* win is the Pro contract that follows.

---

## 5. Post-pilot Annualized — Single Tenant (Pro tier)

If Phuket converts to Pro (Month 2 onward):

| Line | Monthly | Annual |
|---|---|---|
| Pro platform fee | $2,500 | $30,000 |
| Usage overage (~15k convos/mo × $0.04) | $400 | $4,800 |
| Lumi share of bookings (35% × ~$8k/mo gross) | $2,800 | $33,600 |
| Lumi share of whale leads (25% × ~$15k/mo) | $3,750 | $45,000 |
| Lumi share of merchant subs (30% × ~$7k/mo) | $2,100 | $25,200 |
| **Lumi gross / tenant** | **~$11,550** | **~$138,600** |
| Tenant COGS (infra, AI, support allocation) | ~$1,800 | ~$21,600 |
| **Lumi net / tenant** | **~$9,750** | **~$117,000** |

**Net contribution per active tenant: ~$117k/yr, ~85% gross margin** at this stage.

Stack five tenants (Phuket → Bangkok → Bali → KL → Saigon) by Month 18 and you're at ~$585k/yr net contribution from the B2B + transactional layer alone, before NUM+ subscription revenue.

---

## 6. Licensing & Territory Rules

To keep partners motivated and avoid land grabs:

1. **Default territory unit = single city/island.** Phuket is one. Bangkok is one. Bali (Denpasar + Ubud + Canggu corridor) is one.
2. **Exclusivity is earned.** Pilot tier = no exclusivity. Pro tier = optional add-on (+30%). Enterprise tier = exclusive by default within defined territory.
3. **Use-it-or-lose-it.** Exclusivity requires hitting agreed minimum activation thresholds (e.g., 5,000 MAU by month 6, 20,000 by month 12). Miss them two quarters in a row and exclusivity converts to non-exclusive.
4. **No re-selling.** Tenants cannot sub-license NUM to other operators in their territory without Lumi consent.
5. **Cross-tenant user portability.** If a Phuket user travels to Bali, NUM follows them — their profile is theirs. The Bali tenant earns the transactional revenue for bookings made there; the Phuket tenant earns nothing on those. Encourages users-as-product, not users-as-property.

---

## 7. Margin & Cap Table Implications (informal)

- **Year-1 target:** 1 pilot + 1 paying tenant + ~15k MAU → ~$140k revenue, slim margin, mostly reinvested.
- **Year-2 target:** 4 paying tenants + ~80k MAU → ~$700k–$900k revenue, ~60% gross margin, first profit.
- **Year-3 target:** 8–10 tenants across SEA + ~300k MAU → ~$3M–$4M revenue, ~70% gross margin, raise or stay bootstrapped depending on competitive heat.

The economics support staying lean and bootstrapped through Year 2. We only raise if (a) a clear land-grab opens in SEA, or (b) a partner like the Phuket group wants to invest at a fair valuation to lock exclusivity for a larger region.

---

## 8. Protective Clauses (what we never give up)

1. **The AI/model layer.** We never license source code, prompts, or memory architecture — only platform access via tenant.
2. **Aggregate user behavior data.** Belongs to Lumi for product improvement; never resold raw.
3. **The brand.** "NUM" stays Lumi-owned; tenants get "Powered by NUM" or co-brand at Pro, white-label only at Enterprise.
4. **Cross-territory user accounts.** A user's profile is portable; a tenant cannot "lock" them.
5. **Compliance & safety overrides.** Lumi retains final say on prompts, guardrails, and what we will/won't allow the AI to do — even inside a tenant deployment.

---

## 9. TL;DR for a partner conversation

> "You bring the distribution (cars, hotels, network, Chinese-market knowledge). We bring the AI brain and infra. We split the booking revenue 50/50 during the pilot and 35/65 in your favor once you're paying the platform fee. The high-ticket real-estate and school leads — where the real money is — split 30/70 in your favor, because you do the closing. Five high-performing tenants like Phuket and the B2B + transactional stack alone is a multi-hundred-thousand-USD annual net business with 70%+ gross margin, before consumer subscriptions or data products. The model is built to make you rich first; that's how we both win."
