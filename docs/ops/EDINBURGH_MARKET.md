# NUM — Edinburgh Market Pack

**Created:** 2026-07-24 · **Status:** 2 businesses signed (1 hospitality, 1 tours) · **Goal:** first 100 users, then 1,000
**Reads with:** `COST_MODEL.md` (unit economics) · `BUSINESS_OFFERING.md` (what merchants get)

Edinburgh is now the lead market. This pack is what changes from the Phuket design, and the path to first users.

---

## 1 · What changes from Phuket

Most of the platform ports untouched — multi-tenant was built for exactly this. What moves is the market layer.

| | Phuket | **Edinburgh** | Impact |
|---|---|---|---|
| **Channels** | LINE (primary) + WeChat + WhatsApp | **WhatsApp (primary) + SMS** | LINE/WeChat adapters idle. WhatsApp becomes the workhorse |
| **Language** | 9, heavy ZH/RU | **English-first**; visitor languages secondary (ES/FR/DE/IT) | Shorter prompts, lower cost/msg |
| **Currency** | THB | **GBP** | Formatting + commission maths |
| **SMS regime** | US A2P 10DLC | **UK** — no 10DLC; UK sender rules | The A2P rejection is *not* a blocker here |
| **Seasonality** | Year-round, monsoon dip | **Extreme** — Fringe (Aug) is the whole year in one month | Capacity planning, cost spikes |
| **Distribution** | In-car QR, 100+ vehicles | **TBD** — no fleet partner yet | ⚠️ **The open question** (§3) |
| **Whale verticals** | Property, schools, relocation, visas | Weaker — short-stay tourism dominates | Revenue leans on booking commission, not whale fees |

**Two honest consequences.**

**The whale-lead engine matters less here.** Phuket's thesis was long-stay and relocation — one property lead worth a month of dinners. Edinburgh is short-stay tourism. The commission engine and merchant subscriptions carry the revenue instead. That's a *different* business model on the same platform, and the deck's economics need re-cutting before you pitch UK partners.

**Distribution is unsolved.** Phuket had 100+ in-car screens handed to us. Edinburgh has two signed businesses and no funnel. §3 is the real work.

---

## 2 · The two signed businesses

One hospitality, one tours — which is genuinely lucky, because it forces the dashboard to handle both models from day one rather than being retrofitted later.

| | **Hospitality** (restaurant/bar) | **Tours / activities** |
|---|---|---|
| Booking shape | Table for N, at a time, tonight-ish | Seat(s) on a departure, a date ahead |
| Constraint | Covers per service | Capacity per slot |
| Lead time | Hours | Days–weeks |
| Cancellation cost | Low | High (whole departure) |
| Dashboard leads with | **Tonight's requests** | **Tomorrow's departures + seats left** |
| NUM's value | Fills tables in dead windows | Fills unsold seats |
| Commission logic | % of covers, or flat per booking | % of ticket |

**The shared insight worth telling both of them:** NUM is best at *filling the gaps you'd otherwise lose*. A Tuesday 6pm table and three unsold seats on Thursday's walking tour are worth nothing at the end of the day. That's the pitch — not "more bookings" but "revenue from inventory you were about to waste."

### Onboarding the two, week 1
1. **Sit with each for 30 minutes.** Capture the listing exactly as NUM will say it, hours, the channel they actually answer, and the *specific* dead windows they want filled.
2. **Set commission before go-live.** Verbal is fine to start; record it in `vendors.commission_pct` so the ledger is honest from message one.
3. **Approve through 5arz Verify** — nothing reaches a traveler unvetted, even at two vendors.
4. **Give them the dashboard link on their phone** and watch them accept one test booking in front of you. If they can't do it one-handed, the UX is wrong, not them.
5. **Agree a check-in cadence** — weekly for the first month. Their complaints in week 2 are the roadmap.

---

## 3 · Getting to 100 users, then 1,000

**The honest constraint:** two vendors can't serve a broad concierge. A user asking "where's dinner?" needs choice, not one answer. **Supply depth gates user growth** — pushing users before ~20 vendors produces a bad first impression that you don't get to redo.

### Phase 0 — Supply first (weeks 1–3) · target 20 vendors
Do not run acquisition yet. Use the two signed businesses as reference customers to recruit their neighbours — hospitality owners talk to each other, and "X down the road is on it" is the only cold-open that works. Target mix: 8 food/drink, 4 tours, 3 bars, 2 spa/wellness, 3 experiences.

### Phase 1 — First 100 users (weeks 3–6)
Highest-intent, lowest-cost channels, in order:

| Channel | Why it works here | Cost |
|---|---|---|
| **QR in the 2 signed venues** — table tents, bar, tour meeting point | Already-warm guests, zero acquisition cost, proves the loop | ~£0 |
| **Partner venue staff** mentioning it at the table | Highest conversion of anything | £0 |
| **Accommodation partners** — small hotels/B&Bs/Airbnb hosts | Guests arrive with "what should we do?" — exactly NUM's moment | Rev-share |
| **Fringe/festival context** (if timing aligns) | Enormous concentrated visitor volume | Effort |

**Target:** 100 users at ~£0 marginal acquisition cost. At £0.55/user/month (see COST_MODEL §3), 100 users ≈ **£55/month all-in.** Trivial. The scarce resource is vendor quality, not budget.

### Phase 2 — 1,000 users (months 2–4)
Only unlock after: D7 return ≥ 20%, ≥ 40 vendors live, booking conversion ≥ 10%. Then add accommodation partnerships at scale, tourist-information placement, and paid social geo-targeted to arrivals. At 1,000 users, optimized: **~£130/month** — still small against the commission it should produce.

**Gate honestly.** If D7 return is under 15% at 100 users, more users just means more people who try it once. Fix retention before scaling — that's what the memory feature exists for.

---

## 4 · Compliance — what actually applies here

| | Status |
|---|---|
| **UK GDPR + DPA 2018** | Replaces PDPA as primary regime. Existing privacy policy is close — needs a UK/GDPR lawful-basis line and an ICO reference alongside the PDPC one |
| **US A2P 10DLC** | ⚠️ **Not required for UK-to-UK SMS.** The rejection sitting in Twilio blocks US numbers only — it does **not** block Edinburgh launch |
| **WhatsApp Business** | Required. Same privacy-policy language we already fixed satisfies Meta's review |
| **PECR** (UK e-marketing) | Consent needed before marketing texts. NUM sends service messages only — but keep that line clean |
| **ICO registration** | Likely required as a data controller. Small annual fee. **Worth confirming — flagging for Duke/counsel** |

**The useful headline: Edinburgh is not blocked by the A2P rejection.** WhatsApp-first launch can proceed now.

---

## 5 · What to do this week

1. **Re-point the tenant** — create the Edinburgh `partner_tenants` row; the Phuket row stays for when that partner reactivates.
2. **Vendor onboarding visits** with the two signed businesses (§2).
3. **Recruit to 20 vendors** using them as references.
4. **WhatsApp Business sender** for a UK number — start it now, it's the long pole.
5. **Print QR table tents** for both venues.
6. **Apply migration 0007** (`infra/supabase/migrations/0007_cost_views.sql`) in the Supabase SQL editor so cost tracking is live before users arrive.

**Not this week:** paid acquisition, the whale-lead workflow, the Bali conversation. Supply depth first.
