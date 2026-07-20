# NUM — Mobile-First UI Spec

**Updated:** 2026-07-17 · **Supersedes** `DASHBOARD_IA.md` §13's "operators sit at desks" line. Field reality: partner staff, lead specialists, and every merchant operate from a phone, LINE-first. Desktop is the enhancement, not the baseline.
**Pairs with:** `mobile_prototype.html` — open it on an actual phone (or any browser; it renders in a phone frame on desktop). Same roles, same data shapes as `DASHBOARD_IA.md`; this doc defines *how it feels in the hand*.

---

## 1 · Design principles (phone edition)

1. **One glance, one thumb.** Every screen answers its role's question ("what do I act on?") in the first viewport — no pinching, no horizontal scrolling, no tables wider than the screen.
2. **Cards, not tables.** Every table from the desktop IA becomes a stack of tap-able card rows. A card shows 2–4 facts max; everything else is one tap deeper.
3. **Bottom tabs are the app.** 4–5 tabs per role, thumb-reachable, labeled. The tab set IS the mental model of the job.
4. **Act from the card.** The one action that matters (accept booking, claim lead, mark handled) is a button on the card itself — never buried in a detail screen.
5. **Sunlight-grade contrast.** Dark brand chrome, but all text ≥ 4.5:1, key numbers ≥ 7:1, and status is never color-alone (icon + label + color).
6. **Their language.** EN ⇄ TH toggle in the header, one tap, persists per user. All chrome, labels, and empty-states localized. (ZH for merchant portal later — many Phuket vendors are Chinese-operated.)
7. **Numbers you can read from a motorbike.** KPI values 28px+, one decimal max, THB formatted with `k`/`M` shorthand.

## 2 · The shell

```
┌──────────────────────────────┐
│ NUM · [Role ▾]     [TH] [●]  │ ← header: role sheet, lang toggle, live dot
│                              │
│   (screen content — cards)   │ ← single column, 16px gutters, pull-to-refresh
│                              │
│ [Tab] [Tab] [Tab] [Tab] [Tab]│ ← bottom nav, 56px, safe-area padded
└──────────────────────────────┘
```

- **Role switcher** = bottom sheet listing the roles this login is entitled to (JWT `role` claims). Prototype shows all six for demo; production shows 1–3.
- **Live dot** = Supabase Realtime connection state (green pulsing / amber reconnecting / red).
- **Breakpoint:** ≥ 768px the same app goes two-column (cards flow into a masonry grid); ≥ 1100px it adds the desktop side-rail. One codebase, mobile-first CSS.

## 3 · Tab map — all six roles

| Role | Tab 1 (land) | Tab 2 | Tab 3 | Tab 4 | Tab 5 |
|---|---|---|---|---|---|
| **Master (Dre)** | Flow (live circuit: traffic → AI → outcomes → ฿) | Whales (cross-tenant command, assign, breach alerts) | Supply (approval gate, coverage vs demand, stale) | Traffic (per-QR source ranking, channel mix) | Ops (channel pause, prompt/model, cost, quick actions) |
| **Operator** | Today (KPIs + live stream) | Leads (whale queue, SLA) | Channels (health) | Merchants (freshness grid) | More (funnel · languages · trust) |
| **Executive** | Scorecard (decision gate) | Revenue (28d splits) | Pipeline (whale value) | Health (NPS · D7 · cost/user) | Digest (Monday preview) |
| **Lead Specialist** | Hot (A-score ≤ 4h) | My Queue | Waiting (follow-ups) | Closed (scoreboard) | — |
| **Merchant** | This Week (3 big numbers) | Bookings (accept queue) | My Listing (inline edit) | Reviews (reply) | Asks (guest demand) |
| **AI Quality** | Grade (sampling queue) | Flags (hallucination review) | Accuracy (per-lang) | Prompts (version timeline) | — |
| **Lumi Admin** | Tenants | Platform (health) | Costs (ledger + forecast) | Pipeline (onboarding) | Contracts |

Landing tab = the role's most time-critical question. Specialist lands on **Hot** (SLA is money); Merchant lands on **This Week** (pride + pulse).

## 4 · Component adaptations (desktop IA → phone)

| IA block | Phone form |
|---|---|
| KPI strip (6 tiles) | 2×3 grid of tiles, 28px numbers, delta arrow + 7d sparkline |
| Live conversation stream | Vertical feed cards: handle chip · channel/lang badges · last line · intent pill · relative time. Tap → transcript sheet. |
| Whale-lead queue | Card rows: vertical icon · budget band · SLA timer chip (green/amber/red + label) · score chip · [Claim/View] button |
| Channel health | One card per channel: status icon + label, p95 latency, msgs/hr, sparkline |
| Funnel | Horizontal segmented bar with per-stage % below (no chart lib needed) |
| Language share | Stacked bar + legend chips |
| Merchant grid | Card rows: name · category emoji · bookings 7d · freshness dot (fresh/aging/stale) · [Nudge] |
| Trust strip | Single compliance card: consents today · deletes honored · scrubber hits |
| Decision-gate scorecard | Vertical checklist: KPI · actual vs target · traffic light · weeks-to-gate header |
| Revenue chart | CSS stacked bars by week; splits as legend chips (bookings / whale / subs · Lumi / partner share) |
| Booking queue (merchant) | Card: guest party · time · pax · value · [Accept] [Decline] inline — the single most important button in the whole system |
| Listing editor | Preview card exactly as NUM describes the vendor in chat + per-field edit rows (photos · hours · promo) |
| Grading queue (AI) | Full-screen card swipe: transcript excerpt → grade chips (intent right? reply good?) → next |
| Confusion matrix | Per-language accuracy card rows (matrix itself is a desktop luxury) |
| All-tenants table (Lumi) | Tenant cards: name · tier chip · MAU · MTD rev · margin % · health dot |

## 5 · Interaction grammar

- **Tap** card → detail sheet (slides up, 90% height, swipe-down to dismiss). Never a new page for read paths.
- **Primary action** = solid teal button on card. **Destructive** (decline/dismiss) = ghost coral.
- **SLA/status chips** always icon+text: `🟢 2h` `🟠 9h` `🔴 26h` — readable colorblind + sunlight.
- **Pull-to-refresh** everywhere; realtime pushes make it mostly ceremonial.
- **Empty states teach:** "No hot leads right now — leads land here within seconds of NUM qualifying them."
- **Offline-tolerant:** last-fetched data stays visible with an "as of 14:32" stamp; actions queue and retry (production: service worker + mutation queue).

## 6 · EN ⇄ TH

- Single dictionary (`i18n.en` / `i18n.th`) for all chrome, tab labels, panel titles, buttons, empty states, relative-time words. Data values (names, figures) pass through.
- Thai strings drafted in the prototype → **native QA by the Thai team** alongside the `strings.py` review (same reviewer, same pass).
- Font: system Thai stack (`Sukhumvit Set` on iOS / `Noto Sans Thai` Android) — no webfont weight for the prototype; Georgia display stays for numerals/latin brand moments.
- Numbers stay Arabic numerals; THB symbol leads: `฿12.4k`.

## 7 · Auth + data (unchanged from IA, restated for the build)

Supabase Auth magic-link; JWT carries `partner_tenant_id` + `role` (+ `vendor_id` for merchants). RLS per §11 of the IA. Realtime channels per tenant. The mobile app is the SAME Next.js app (partner) / merchant app — responsive, installable as PWA (manifest + icons + service worker), NOT a native build. "Add to Home Screen" is the deployment story for the pilot: no app-store review, instant updates, LINE-shareable URL.

## 8 · Build sequence (revised from IA §12)

1. **v1 (wk 1–2):** Partner app, mobile-first: Operator tabs Today/Leads/Channels read-only + role shell + EN/TH. PWA manifest. Vercel.
2. **v1.1 (wk 3):** Executive + remaining Operator tabs. Weekly digest wire-up.
3. **v2 (wk 4):** Lead Workbench + lead status mutations (the first write path).
4. **v3 (wk 5–6):** Merchant Portal app: This Week + Bookings (accept flow) + Listing editor.
5. **v4 (mo 2):** AI Quality Studio (desktop-leaning is fine; grading works surprisingly well as phone card-swipe).
6. **v5 (mo 3 / 2nd tenant):** Lumi Admin.

## 9 · Deliberately NOT building (mobile edition)

- Native iOS/Android binaries — PWA covers pilot; revisit only if push-notification depth demands it (LINE Notify covers alerting until then).
- Landscape layouts, tablet-special layouts, widget/watch complications.
- Charts requiring libraries — every viz above is CSS-only. (Chart.js earns its way in at v1.1 revenue view, maybe.)
- Per-user dashboard customization. Opinionated defaults win on a 6-inch screen.
