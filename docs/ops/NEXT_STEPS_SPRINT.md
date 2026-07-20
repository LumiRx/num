# NUM by 5arz — Current Sprint (redefined 2026-07-17)

**Supersedes** `docs/build/next_steps.md` (June — everything in it except deploy is done).
**Track live in:** the *Launch Command* artifact (Cowork sidebar) — pulse is wired to the real DB.
**The one sentence:** the machine is built; this sprint turns it on, feeds it supply, and starts the pilot clock.

---

## Sprint 1 — LIVE (this week)

| # | Step | Owner | Status source |
|---|---|---|---|
| 1 | Push repo → GitHub, Railway up, env vars, domain, `/healthz/db` green | Dre (15 min + runbook) | artifact checklist |
| 2 | WA sender submitted **day 1** · Twilio number + webhooks · LINE channel | Dre | artifact |
| 3 | WeChat SA decision with partner (their SA = days; fresh = 4–6 wks; launch WA+LINE+SMS regardless) | Dre + partner | artifact |
| 4 | Supabase Pro (or pinger) · Sentry · Slack #num-ops · tenant seeded | Dre | artifact |
| 5 | Vendor batch 1 (10 real merchants) ingested · **first real conversation end-to-end** | Thai team + Dre | pulse: vendors ≥ 10 |

**Exit:** a tourist-shaped message gets a real vendor recommendation on a real channel, logged with cost, in <3s.

## Sprint 2 — HARDEN + FEED (next week)

| # | Step | Why now |
|---|---|---|
| 6 | **Close the 4 backend gaps** so the console's buttons are real: `leads.handed_off_to` assign action · `leads.fee_amount` + settlement view (5arz PayRails ledger v0) · `vendors.status` approval gate (5arz Verify v0) · `digest.py` weekly worker | The demo promised it; the pilot needs it |
| 7 | Thai dogfood day: 5 team members, Thai conversations, string QA, prompt voice tune | Quality before tourists |
| 8 | Vendor waves per `ONBOARDING_200.md` — Wave 1 → 40 live | search_vendors needs depth |
| 9 | QRs printed on final domain → install batch 1 vehicles + driver briefing | Physical funnel |
| 10 | Partner meeting: deck + phone demo → the 5 decisions signed off | Pilot start date set |

**Exit:** 40 vendors live · buttons write to DB · cars carry QRs · pilot date on calendar.

## Sprint 3 — PILOT (weeks 3–7)

Daily: Master dash Flow check (any conversion stage drops >20% w/w → investigate same day) · SLA breaches = phone call, not ticket. Weekly: Executive scorecard review with partner · digest ships Monday 08:00 · vendor waves continue → 100 by gate. Week 7: **the gate** — 4/7 KPIs → operating agreement + territory window; then Bali fork opens with this exact playbook.

## Fine-tuning backlog (do when data says so, not before)

- Prompt v1.5 from dogfood feedback (Thai particles, reply length per channel)
- Memory nudge experiment if D7 < 25% trend by week 4 (`nudge.py` — needs WA template messages)
- Haiku PII second-pass before property/school flows scale
- `expire.py` memory pruning (lookup already filters expired — low urgency)
- Per-language conversion analytics view (`v_language_mix` exists; add conversion cut)
- Dashboard (Next.js) build starts only after pilot start — prototype + SQL carries the first weeks

## Standing rule

Anything new gets one question before it's added: **does it move scan→chat, chat→booking, or lead→close this month?** If not, it's Phase 2.
