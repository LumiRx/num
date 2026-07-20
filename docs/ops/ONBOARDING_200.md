# NUM by 5arz — Onboarding the Partner Network (200+ companies)

**Created:** 2026-07-17 · The partner's book — 100+ hotels, 100+ merchant relationships from 5 years on-island — is NUM's unfair advantage. This is the machine that turns those connections into AI-recommendable supply without ever lowering the quality bar.
**Track live:** Launch Command artifact → wave bars fill from the real `vendors` table.

---

## The principle

**The AI is only as good as its worst listing.** Every company enters through the same pipe: *collect → verify (5arz Verify) → live to AI → kept fresh.* Volume never skips the gate — at 10 vendors or at 200.

## The three waves

### Wave 1 — Pilot core · 40 companies · by launch
The minimum for the AI to feel omniscient in pilot conversations.

| Category | Target | Why |
|---|---|---|
| Restaurants (Patong · Kata · Karon · Chalong) | 12 | Highest ask volume |
| Spa & wellness | 6 | High-margin, high-frequency, ZH/RU demand |
| Tours & activities | 8 | The "what should we do" default |
| Transfers | 5 | **Thin today** — every airport ride is a booking chance |
| RE / relocation agents | 4 | **Whale-critical** — license-checked via 5arz Verify |
| Schools + medical | 5 | Whale-adjacent; one good school contact = fee pipeline |

Selection: partner ranks their 40 *strongest* relationships in these splits — strength = answers their phone, honors referrals, has capacity. Thai team fieldwork per `VENDOR_ONBOARDING.md`.

### Wave 2 — Gate strength · 100 total · by week 7
Fill what conversation data says is thin (Master → Supply coverage view decides — demand-driven, not guess-driven). Activate the **hotel network** here: hotels are both venues (spa/restaurant listings) and **acquisition sources** (lobby QRs — new `hotel_*` codes, tracked like cars). Second RE agent + second school per vertical so whale leads never bottleneck on one closer's calendar.

### Wave 3 — Full network · 200+ · post-gate
The partner's entire book, plus inbound (merchants asking to join — featured-tier is the upsell, 60/40 partner-favoring). At this scale the manual gate becomes assisted: batch field-verification days, then **merchant self-serve** (v3 portal) with 5arz Verify approvals in the Master console. This wave IS the Bali playbook rehearsal — same pipe, new tenant.

## The intro machine (how 200 connections become 200 listings)

1. **Partner sends the blessing** — one LINE message from THEM to the merchant (template below). Their name opens the door; we never cold-knock their network.
2. **Thai team visits** — 20 min: photos, hours, prices, answering channel, notes. One sheet row.
3. **Commission agreed** — partner leads (their relationship); standard tiers, recorded in `commission_pct`. No commission agreed = listed as `local` tier (still recommendable, no fee) — supply first, monetize second.
4. **5arz Verify** — Dre/ops approves in Master → Supply. License check for whale verticals. Only then does the AI see it.
5. **Live + fresh** — merchant gets their portal link (v3) or the team refreshes monthly. Stale >21 days = nudge → recommendation priority decays.

**Partner intro template (LINE, Thai):**
> พี่ครับ/ค่ะ — ผมกำลังทำระบบ AI แนะนำร้านให้นักท่องเที่ยวในรถของเรา 30–40 คัน อยากให้ร้านพี่อยู่ในระบบตั้งแต่แรก ทีมงานขอแวะไปถ่ายรูป เก็บข้อมูล 20 นาที ไม่มีค่าใช้จ่าย — นักท่องเที่ยวจีน/รัสเซีย/ฝรั่งถามหาร้านแบบนี้ทุกวันครับ เดี๋ยวทีม NUM ติดต่อไปนะครับ

**Capacity math:** one field person ≈ 4 visits/day → 2 people hit Wave 1 (40) in ~5 working days; Wave 2's +60 lands inside the pilot window using batch days at hotel clusters.

## What each side counts

| Metric | Where |
|---|---|
| Intros committed by partner | Launch Command artifact counter (meeting tally) |
| Collected → approved → live | `vendors` count by status (artifact wave bars = live) |
| Coverage vs demand | Master console → Supply |
| Revenue per vendor | bookings + `commission_pct` ledger (5arz PayRails v0) |
| Freshness | Master → Supply stale list |

**The partner meeting ask, precisely:** "Rank your 40 strongest relationships against this category grid, send each one the blessing message, and tell us which 4 people close real-estate, school, relocation, and visa leads. We do everything else."
