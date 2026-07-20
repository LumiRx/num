# NuM — Dashboard Information Architecture
### Every feature mapped to a user role, every dashboard scoped to a job, with the rules for what shares a surface and what doesn't.

**Owner:** Lumi / Dre
**Generated:** 2026-06-17
**Audience:** Lumi engineering · partner ops leads · whoever ends up implementing the Next.js build
**Status:** Blueprint. Pairs with `prototype.html` (the working, clickable mock).

---

## 0 · Design principle

> The dashboard exists to **let a partner company run its business off NuM's data** — not to let Lumi show off what it tracks.

Two consequences:
1. Every screen answers a **single role-and-job pair**. ("As an ops manager, what do I act on this morning.") If you can't say it in one sentence, that screen needs to be split.
2. Mixed audiences = mixed signal. Executive + Operator can co-exist on one app (role-toggle), but Merchant + Whale-Lead-Specialist + Lumi-Admin each need their own surface. People log in for different reasons; their landing screen should reflect that.

---

## 1 · The six dashboards

| # | Dashboard | Who logs in | Job-to-be-done in 1 sentence | Lives in |
|---|---|---|---|---|
| 1 | **Operator Console** | Partner ops manager (Phuket AI day-to-day) | "What's happening right now and what do I act on this morning." | `dashboard.num.<domain>` |
| 2 | **Executive View** | Partner CEO / partnership lead | "Are we winning the pilot. What's the trend. What's the gap to the decision gate." | Same app as #1, role-toggle |
| 3 | **Lead Workbench** | Whale-lead specialist (RE, school, relocation agent) | "Which leads are mine, who's hottest, what do they want, what did NuM already learn." | Same app as #1, role-toggle (specialist persona) |
| 4 | **Merchant Portal** | Restaurant / spa / tour operator | "How am I doing this week. Is my listing fresh. Are bookings flowing." | `merchants.num.<domain>` — separate app |
| 5 | **AI Quality Studio** | Lumi ML / partner AI team | "Where is the model wrong, in what way, on what data, and what should we ship to fix it." | `quality.num.<domain>` — separate app, allow-listed |
| 6 | **Lumi Platform Admin** | Lumi internal only | "All tenants, all cost, all margin, all health." | `admin.lumi.com/num` — Lumi-only |

**Why six and not one giant SaaS:** the data is shared, the auth model is shared, the design tokens are shared — but the jobs are different enough that one screen for all of them produces a "loaded everywhere" experience where no role finds what they need fast. Six surfaces, three apps (Operator/Executive/Lead all share the partner app; Merchant is its own; Lumi-internal is its own).

---

## 2 · The shared building blocks (every dashboard uses these)

These are the underlying data primitives every dashboard reads from. Build once, reuse everywhere.

| Block | What it produces | Backed by |
|---|---|---|
| **Time selector** | `from / to / granularity` global state | URL query param |
| **Tenant selector** | active `partner_tenant_id` (single for partners, multi for Lumi admin) | JWT claim |
| **Anonymized handle** | `user_uuid` → `#a4f2` (4 hex chars, stable per session) | Pure function |
| **PII-safe message renderer** | replaces scrubbed tokens with chips; never shows raw card/passport | Pre-render filter |
| **Channel badge** | WA · WC · LN · SM · QR · WEB pill with brand color | `messages.channel` |
| **Language badge** | ISO 639-1 → 2-letter pill (TH · ZH · JA · etc.) | `messages.lang` from `lang_detect` |
| **Intent badge** | TOURIST · WHALE · BOOKING · SUPPORT · SMALLTALK · PARTNER pill | `messages.detected_intent` |
| **Lifecycle stage badge** | new · tourist · repeat_visitor · exploring_relocation · resident_prospect | `users.lifecycle_stage` |
| **Whale-lead score** | A · B · C colored chip | `leads.viability_score` |
| **SLA timer** | green < 4h, amber 4–24h, red > 24h | `leads.created_at` vs SLA |
| **Currency formatter** | THB / USD / CNY auto-display, hover for the other | client locale + tenant region |

The prototype already implements every one of these.

---

## 3 · Dashboard #1 — Operator Console (the daily driver)

**Persona:** "I run Phuket AI's ops desk. I open the laptop at 8 AM, I want to know what to act on by 8:15."

**Landing screen panels — sequenced top-to-bottom in order of "what I scan first":**

| Order | Panel | Why this position |
|---|---|---|
| 1 | KPI strip (6 tiles) | Glanceable. Anything red is the rest of my morning. |
| 2 | Live conversation stream | Pulse check — is anything broken right now. |
| 3 | Whale-lead queue | Where the money is. SLA breaches are personal phone calls. |
| 4 | Channel health | Anything degraded blocks revenue. |
| 5 | Funnel (7d) | Mid-week tuning loop. Where's the biggest drop. |
| 6 | Language share | Are we serving the right markets in the right tongues. |
| 7 | Merchant performance | Vendor freshness = AI quality. |
| 8 | Trust strip (consent · delete_me · scrubber) | One-line compliance pulse. |

**Sub-screens reachable from the landing:**

- **Conversation Explorer** — click a row in the stream → full transcript, memory state, scrubbed PII inline, intent timeline. Auditable for compliance.
- **User Profile** — click a `#a4f2` → lifecycle stage, language preference, memory chunks, trip context, consent state, all bookings + leads attributed to them.
- **QR/Acquisition Map** — click a `car_PHK_017` source code → per-source scan/activate/conversion funnel.
- **Merchant Detail** — click a merchant row → bookings · commissions · NPS · content freshness · "request refresh" button.
- **Escalation Workbench** — every flagged conversation (frustrated user, hallucination flag, support escalation) in a single queue.

**Out of scope on this dashboard:** strategic / executive views, lead-specialist tooling, merchant self-service, AI engineering, Lumi platform admin. Those have their own homes.

---

## 4 · Dashboard #2 — Executive View (same app, different lens)

**Persona:** "I'm the partnership lead. I look at this weekly, not daily. I want to know: is the pilot working, what's the trend, what gates close when."

**Triggered by:** role-toggle in the top nav (`Operator ⇄ Executive`). Same auth, same tenant, different view of the same data.

**Landing screen panels:**

| Order | Panel | What it shows |
|---|---|---|
| 1 | **Decision-gate scorecard** | 7 KPIs vs pilot targets, traffic-light status, weeks remaining to Week 7 gate |
| 2 | **Revenue chart (28d)** | Stacked: bookings · whale leads · merchant subs. Lumi share + partner share. |
| 3 | **Whale-lead pipeline value** | Open · qualified · in-negotiation · closed. Forecasted close value next 30d. |
| 4 | **Cost-per-active-user trend** | Plotted against budget. Direction matters more than absolute. |
| 5 | **Tenant health summary** | NPS · D7 return · activation · 1 line each. |
| 6 | **Open commitments + risks** | Manually-curated, gets surfaced via Slack to ops; "5 things we owe the partner" / "3 things we're worried about". |
| 7 | **Weekly digest preview** | The exact thing that ships to your inbox Monday 8 AM. |

**Why it co-exists with Operator:** identical data plumbing, identical auth scope. The Operator and Executive both work *at the partner*, just with different time horizons.

---

## 5 · Dashboard #3 — Lead Workbench (same app, specialist persona)

**Persona:** "I'm a real-estate agent / school admissions counselor / relocation specialist on the partner side. NuM hands me qualified leads. I close them."

**Triggered by:** role assignment — user has `role = lead_specialist` and 1+ vertical assignments. Top-nav toggle still shows it, but the default landing is this view.

**Landing screen panels:**

| Order | Panel | What it shows |
|---|---|---|
| 1 | **My queue** | Just my open leads, by vertical, sorted by score then age |
| 2 | **Hot today (≤ 4h old, A-score)** | Pinned-to-top hotlist. SLA is alive. |
| 3 | **Awaiting partner response** | Leads I've contacted but customer hasn't replied — for follow-up |
| 4 | **Closed this month** | Conversion + commission earned. Personal scoreboard. |
| 5 | **Stuck leads** | > 14 days no movement. Either re-engage or mark cold. |

**Lead detail screen (click any lead):**
- Customer summary: lifecycle stage, language, party composition, budget band, timeline
- **Conversation excerpt** — the actual messages that triggered the lead, with NuM's qualification reasoning highlighted
- **Memory context** — what NuM has learned about this customer across all their sessions
- Status pipeline: new → contacted → qualified → in-discussion → closed_won / closed_lost
- Status-change form with notes (writes back to `leads.notes`, `leads.handed_off_to`, `leads.status`)
- **Next-touch suggestion** from NuM (proactive nudge)

**Why this is its own persona but the same app:** the specialist works in your network. They authenticate with the same tenant. Same RLS. Their screen is just radically different from Operator/Exec because their job is.

---

## 6 · Dashboard #4 — Merchant Portal (separate app — `merchants.num.<domain>`)

**Persona:** "I run a restaurant / spa / tour. NuM sends me bookings. I want to see them, manage my listing, and refresh my content without emailing anyone."

**Why this is its own app:** different auth domain (vendor login, not partner-staff login). Different RLS (scoped to single `vendor_id`, not whole tenant). Different visual chrome (less dense — vendors aren't operators).

**Landing screen panels:**

| Order | Panel | What it shows |
|---|---|---|
| 1 | **This week** | Bookings · revenue · NPS — three big numbers |
| 2 | **Booking queue** | Pending / confirmed / completed with quick-accept |
| 3 | **My listing** | Photos · hours · promo · description with inline edit |
| 4 | **Reviews** | Last 10, with reply button |
| 5 | **Featured-listing status** | If subscribed: spend · impressions · CTR · upgrade/downgrade |
| 6 | **What guests asked for** | Anonymized excerpts of NuM-routed conversations that mentioned this vendor (without violating PDPA) — operator coaching tool |
| 7 | **Refresh reminder** | If content > 14 days stale, a friendly "your photos are aging" prompt |

**Out of scope on this dashboard:** anything cross-vendor, anything financial that isn't theirs, any data on other merchants.

---

## 7 · Dashboard #5 — AI Quality Studio (separate app — `quality.num.<domain>`)

**Persona:** "I'm a Lumi ML engineer (or a partner technical lead who wants visibility). I tune the model. I need to see where it's wrong and ship fixes."

**Why this is its own app:** the workflows are radically different (prompt versioning, conversation sampling, A/B comparison), the user count is tiny (3–10 people), and the tools should not pollute the Operator's daily view.

**Landing screen panels:**

| Order | Panel | What it shows |
|---|---|---|
| 1 | **Sampled grading queue** | N conversations / day, randomly sampled, human grades intent + reply quality |
| 2 | **Hallucination flag review** | Auto-flagged turns (fabricated review, stale price, made-up vendor) for confirm/dismiss |
| 3 | **Intent classifier accuracy** | Confusion matrix on the human-graded sample. Per-language. Per-intent. |
| 4 | **Escalation analysis** | Why did users escalate. By bucket. By language. By prompt version. |
| 5 | **Prompt version timeline** | Every system_prompt change, who made it, what shipped before/after, KPI delta |
| 6 | **A/B test runner** | Set up split tests on prompt variants (e.g., "warmer tone vs more concise" → compare D7 return) |
| 7 | **Conversation deep-dive** | Search by user, time, intent, language, channel. Full transcript with tool calls + memory state. Replay turn-by-turn. |

**Out of scope:** anything operational, anything financial, anything merchant-specific.

---

## 8 · Dashboard #6 — Lumi Platform Admin (separate, internal)

**Persona:** "I'm Dre / Lumi engineering. I watch all tenants. I see what costs what. I catch problems before partners do."

**Why this is its own app:** Lumi-only. Different host (`admin.lumi.com/num`). Cross-tenant. Anything that says "all tenants" or "Lumi vs partner" lives here only.

**Landing screen panels:**

| Order | Panel | What it shows |
|---|---|---|
| 1 | **All tenants table** | Phuket AI · Phuket InCar · Bali prospect · etc. Tier · MAU · MTD revenue · margin · contract expiry. |
| 2 | **Platform health** | LLM provider status · Supabase health · channel adapter uptime |
| 3 | **Cost ledger** | $ this month by tenant. Forecasts vs budget. Anomalies. |
| 4 | **Tenant onboarding pipeline** | Prospect → MOU → pilot → Pro → Enterprise. Stage age. Owner. |
| 5 | **Contract calendar** | Renewals · expirations · territory exclusivity reviews |
| 6 | **Cross-tenant analytics** | Aggregate (de-identified): which markets, what languages, what verticals work everywhere |
| 7 | **Provider cost rate card** | Live Anthropic + OpenAI pricing, auto-updated, drives `costing.py` |

**Out of scope on the partner-facing apps:** all of the above. The partner never sees what other tenants pay, what other tenants earn, or what Lumi's margin is on their account.

---

## 9 · Feature-to-dashboard mapping (the full table)

For every feature we will eventually ship, here's where it lives and who sees it.

| Feature / Panel | Operator | Executive | Lead Wkb | Merchant | AI Quality | Lumi Admin |
|---|---|---|---|---|---|---|
| **KPI strip (active now · scans · activation · depth · D7 · whale-leads)** | ✅ live | ✅ trend view | — | — | — | ✅ all tenants |
| **Live conversation stream** (anonymized) | ✅ | — | only my leads' convos | — | ✅ full unfiltered + tools | — |
| **Conversation Explorer / search** | ✅ | — | ✅ | — | ✅ | ✅ |
| **User profile view** | ✅ | — | ✅ (their lead) | — | ✅ | — |
| **Whale-lead queue (tenant-wide)** | ✅ | summary only | — | — | — | — |
| **Whale-lead queue (mine only)** | — | — | ✅ | — | — | — |
| **Whale-lead detail + status changer** | view-only | — | ✅ edit | — | — | — |
| **SLA monitor** | ✅ | summary | ✅ mine | — | — | ✅ all |
| **Channel health (live pulse)** | ✅ | — | — | — | — | ✅ all tenants |
| **Funnel (scan → ... → whale-qualified)** | ✅ | ✅ trends | — | — | breakdown by version | ✅ |
| **Language share + detector accuracy** | ✅ | — | — | — | ✅ + confusion matrix | ✅ |
| **Merchant performance grid** | ✅ tenant-wide | — | — | own row only | — | — |
| **Merchant detail (bookings · NPS · freshness)** | ✅ | — | — | own only | — | — |
| **Merchant listing editor** | — | — | — | ✅ | — | — |
| **Merchant booking queue** | — | — | — | ✅ | — | — |
| **Reviews + reply** | — | — | — | ✅ | — | — |
| **Revenue chart + splits** | summary | ✅ | — | own row only | — | ✅ all tenants |
| **Cost per active user** | summary | ✅ trend | — | — | — | ✅ |
| **Sampled grading queue** | — | — | — | — | ✅ | — |
| **Hallucination flag review** | summary | — | — | — | ✅ | — |
| **Prompt version timeline** | — | — | — | — | ✅ | ✅ |
| **A/B test runner** | — | — | — | — | ✅ | — |
| **PDPA consent ledger** | summary | summary | — | — | — | ✅ |
| **delete_me request queue** | ✅ | summary | — | — | — | ✅ |
| **KMS rotation status** | — | — | — | — | — | ✅ |
| **PII scrubber hits** | summary | — | — | — | ✅ pattern analysis | ✅ |
| **Audit log (every memory write + lead create)** | — | — | — | — | ✅ | ✅ |
| **All-tenants table** | — | — | — | — | — | ✅ |
| **Tenant onboarding pipeline** | — | — | — | — | — | ✅ |
| **Provider cost rate card** | — | — | — | — | — | ✅ |
| **Weekly digest preview** | — | ✅ | — | — | — | ✅ |
| **Open commitments + risks** | — | ✅ | — | — | — | — |

---

## 10 · The shared shell

All three apps (Partner · Merchant · Lumi-Admin) share:

- **Design tokens** — `--bg-0` (midnight) · `--teal` · `--sand` · `--coral` · `--green`, Georgia display + Calibri body
- **Auth model** — Supabase Auth (magic link or SSO), JWT carries `partner_tenant_id` + `role` + (for merchants) `vendor_id`
- **RLS enforcement** — every query scoped server-side, never trust client filter
- **Component library** — KPI tile · panel card · table · live-pulse indicator · channel/lang/intent badge · whale-score chip · SLA timer · funnel bar · stacked-share bar — extracted to a shared package (`@num/ui`) consumed by all three apps
- **Realtime layer** — Supabase Realtime channels per `partner_tenant_id` so live stream + KPI strip + SLA timers update without polling
- **Time/tenant selector** — top-bar global, all panels react to it

---

## 11 · The role and the right of action

Every panel has a default permission. The matrix:

| Role | Read | Annotate | Edit | Approve | Configure |
|---|---|---|---|---|---|
| Partner ops manager | ✅ all panels in Operator + Executive | ✅ flag, comment | ✅ assign lead, mark escalation handled | — | — |
| Partner CEO / partnership lead | ✅ all panels in Executive | ✅ comment | — | ✅ MOU, escalations | — |
| Lead specialist | ✅ mine only | ✅ on my leads | ✅ status, notes | — | — |
| Merchant | ✅ own data only | ✅ replies to reviews | ✅ listing, hours, photos | ✅ accept booking | — |
| AI Quality / ML | ✅ all conversations | ✅ grade samples | ✅ confirm/dismiss flags | ✅ ship prompt change | ✅ A/B tests |
| Lumi admin | ✅ everything | ✅ | ✅ | ✅ | ✅ |

Permissions enforced both client-side (UI hides what you can't do) and server-side (RLS + RPC checks).

---

## 12 · Build sequence (most → least leverage)

**v1 (Weeks 1–2):** Operator Console only. Read-only. The 6 panels with data we already persist. Auth, tenant scoping, magic link. Ship to Vercel.

**v1.1 (Week 3):** Executive role-toggle on the same app. No new data — re-cuts of what v1 already has plus the manually-curated commitments/risks block.

**v2 (Week 4):** Lead Workbench as a third role on the same app. New: lead detail + status changer + memory excerpt + transcript.

**v3 (Week 5–6):** Merchant Portal as its own app. Auth + listing editor + booking queue + reviews.

**v4 (Month 2):** AI Quality Studio. Sampled grading queue + hallucination review + prompt timeline.

**v5 (Month 3, when 2nd tenant signs):** Lumi Platform Admin. All-tenants table + cost ledger.

---

## 13 · What we will deliberately NOT build

- A "build your own dashboard" widget editor. Operators want decided opinions, not Lego.
- A general BI tool. We're not Tableau. If someone wants ad-hoc SQL, give them read-only Supabase.
- ~~A mobile app for the dashboard. Responsive web is enough. Operators sit at desks.~~ **REVERSED 2026-07-17:** field reality is phone-first (Thai staff, specialists, and merchants all operate from phones, LINE-first). The apps are **mobile-first responsive PWAs** — see `MOBILE_UI_SPEC.md` + `mobile_prototype.html`. Still no native binaries.
- A public-facing analytics page. Aggregate intelligence reports for tourism boards ship as PDFs, not dashboards.
- Chat with the dashboard (LLM-driven Q&A). Maybe later. Not v1.

---

*Pairs with `prototype.html` (desktop mock) and — primary since 2026-07-17 — **`mobile_prototype.html`** + **`MOBILE_UI_SPEC.md`**: the phone-first version of all six roles with EN⇄TH toggle. Open it on an actual phone; that's the experience we're building.*
