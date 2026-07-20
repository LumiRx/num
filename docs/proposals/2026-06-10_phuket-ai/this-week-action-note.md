# NuM — This-week action note

**Date:** 2026-06-15
**Goal:** website + dashboard live, monitoring real (or seeded) users by Sunday next.
**Bias:** ship something monitorable now, polish during the pilot.

---

## What you should do this week (Mon → Sun)

### Mon · provisioning day (4 hours of admin work)
- [x] ~~Create Supabase project in `ap-southeast-1`. Apply migrations.~~ ✅ Project `num` is live + `0001`/`0002`/`0003` applied and verified (2026-06-17).
- [ ] Create Railway project. Connect to the `NUM` GitHub repo. Procfile is in place.
- [ ] Provision Doppler (or use Railway env). Load every key from `apps/api/.env.example`.
- [ ] Create an Anthropic project key for "NuM-pilot" with cost cap = $500/mo for now.
- [ ] Register domain. **Open decision in your README.md — recommend `num.ai` if available, else `numlive.com` or stick with `num.lumi.com` as subdomain on the existing Lumi domain.** Pick today, register today.
- [ ] Spin a Cloudflare zone for the chosen domain — DNS, WAF, basic rate-limiting.

### Tue–Wed · the brain works end-to-end (2 days)
- [ ] **Wire the tool-use loop in `services/concierge.py`.** This is the single biggest unlock. Implement `search_vendors`, `create_lead`, `escalate_to_human` first; defer `create_booking` to Phase 2.
- [ ] **Embed worker** — `apps/workers/embed.py`. Listens to `memories` rows with NULL embedding, calls OpenAI embeddings, writes back. 50 lines.
- [x] ~~**Language detection on inbound**~~ ✅ Shipped — zero-LLM Unicode detector (`services/lang_detect.py`), persists `messages.lang` + refreshes `users.preferred_lang`, `v_language_mix` view. (No Haiku call needed — cheaper + faster than planned.)
- [x] ~~**Per-message cost tracking**~~ ✅ Shipped — `llm_usage` table (per call: purpose · model · tokens · `cost_usd`) + `v_cost_per_user_daily`; pricing in `services/costing.py`.

### Wed–Thu · WeChat finished (the China unlock)
- [ ] Finish `adapters/wechat.py`: XML parse for `MsgType=text` / `event subscribe` / `event unsubscribe`, passive XML reply within the 5-second window for first message, customer-service push for follow-ups inside the 48h window.
- [ ] If Phuket AI doesn't have a Service Account yet: register one under Lumi this week (it's a 4–6 week verify, start the clock).
- [ ] Acceptance: send a test Chinese-language message from your phone, get a Mandarin reply within 3 seconds.

### Thu · marketing site (1 day, mostly content)
- [ ] Set up `num.<domain>` on Webflow (mirror the Aeroz Webflow stack — assets in `aeroz_webflow_fixes/`).
- [ ] 1 page, 5 sections: hero ("Your AI concierge. It remembers."), how-it-works (3 panels), channels (WhatsApp/LINE/WeChat icons), trust (PDPA + encrypted PII + open about disclaimers), CTA (QR + WhatsApp + LINE links).
- [ ] One footer line for partnerships: "Operating in Phuket via [partner]. Talk to us: andre@thatislumi.com".

### Fri–Sat · dashboard v0 live (2 days)
- [ ] **Scaffold Next.js in `apps/dashboard/`.** Use App Router. Supabase JS client. Tailwind. Deploy to Vercel.
- [ ] Copy the design tokens, palette, panel structure from `wireframe.html` (you have it). The wireframe is intentionally close to component-shaped — sections map to components.
- [ ] Wire read-only Supabase queries for the 6 panels that have data already:
  - KPI strip (scans / activation / depth / D7 / leads · all from `events` and `messages` tables)
  - Live conversation stream (last 8 messages, anonymized handle, channel, lang)
  - Whale lead queue (`leads` table where status != closed)
  - Channel health (last message timestamp + count per channel, last 1h)
  - Funnel (events aggregated)
  - Language share (`messages.lang_detected` grouped)
- [ ] **Skip for v0:** AI quality (needs sampled human grading pipeline), Revenue/splits (needs Stripe — fake numbers from manual entry are fine for the pilot week), PDPA card (build after first 100 real users).
- [ ] Gate behind a magic-link login restricted to your email + the partner contact's email.

### Sun · verify + send the proposal
- [ ] Send yourself 20 test messages across WhatsApp, LINE, and Web. Watch them land on the dashboard.
- [ ] Take a 90-second Loom of the dashboard live. Attach to the Phuket AI proposal email.
- [ ] Send the proposal + cover-email + Loom to Phuket AI.

---

## What to monitor once you go live

The wireframe is sequenced top-to-bottom in the order of "what an operator scans first." Use it that way:

1. **First glance — KPI strip.** Are we hitting target activation / depth / D7? Anything red is a same-day fix.
2. **Live conversation stream.** Scroll for 30 seconds. Anything weird (intent misclassification, repeated questions, frustration) you spot here saves a Sentry alert later.
3. **Whale leads queue.** Anything sitting unassigned > 12h gets reassigned. Anything past SLA = personal call to apologize. This is where the *real money* is — don't let it cool.
4. **Channel health.** If anything is yellow/red, escalate to the right adapter owner.
5. **Funnel.** Once a week, look for the biggest stage-to-stage drop. That's your next prompt-tune / vendor-content fix.
6. **AI quality.** Once a week. Sample 50 messages by hand. Tune the system prompt where needed.
7. **Revenue + cost.** Weekly partner sync — open this page side-by-side with the Phuket AI partnership lead.

---

## What goes into the partner-facing version

The dashboard has two flavors:

- **Lumi-only view** — everything above, including Tenants panel and Cost monitor.
- **Partner read-only view** — same dashboard, but Tenants and per-tenant cost-margin numbers are hidden. Partner sees KPIs, conversation stream (their tenant only), whale leads (their tenant only), channel health, revenue (their side only).

Implementation: single Next.js app, RLS in Supabase by `partner_tenant_id`, role flag on the user (`role: 'lumi_admin' | 'partner_admin'`) controls panel visibility.

---

## Two MCP automations worth wiring this week (compounding wins)

You said it: when there's something we can automate, suggest it. Both of these save real hours:

1. **Slack MCP for ops alerts.** Pipe these events to a `#num-ops` channel:
   - New whale lead created (vertical + score + age)
   - Lead breaching SLA
   - Channel adapter error rate > 1% over 5min
   - Hallucination flag from AI quality sampler
   - Cost-per-active-user breaches budget by > 10%
   Single Slack workspace, single channel, no email noise. Already-installed plugin.

2. **Scheduled task — Monday 8am ICT digest.** Auto-email Dre + partnership lead a 1-pager with: last 7d KPIs, top 3 wins, top 3 risks, the 5 whale leads still open. Use the `schedule` skill — it's installed and idle.

Both can ship in under 2 hours combined.

---

## What I'd push back on if you started cutting scope

- **Don't ship without the embed worker.** Without it, "persistent memory" is a lie. Even one user who comes back on Day 4 and gets re-asked their kid's age kills the trust story.
- **Don't ship without per-message cost tracking.** You can't price the Pro tier honestly if you don't know what an active user actually costs. Two hours of work; never have to revisit it.
- **Don't ship the dashboard without `partner_tenant_id` enforcement on every query.** When the Bali tenant signs, you don't want to learn the hard way that Phuket queries leaked across.

---

## What I think we should NOT touch this week

- Stripe Connect (Phase 2 — pilot can settle commissions monthly by spreadsheet).
- NUM+ subscription paywall.
- Mobile thin client.
- Voice channel.
- Fine-tuned intent model.

All of these compound later. None unblock anything this month.
