# Launch checklist — go / no-go (2026-08-01, post-0.8.86)

Every status verified by live probe on 08-01, not assumed. Green = ready today.

## 🟢 GREEN — verified working
- Signups, profiles, plans, invites, stars, DMs — all writes (cap lifted, probed)
- Group plans: chat, ✓/✗ votes, invite-to-app delivery for existing members
  (Vivian bug fixed 0.8.86), clickable cards → plan screen
- Push config: client VAPID key === server key (probed /api/push/config);
  targeted invite pushes wired — first real buzz = final confirmation
- Concierge brain: correct city behavior, real venues, no invented times
- Share/send: OS share sheet, sms/whatsapp prefills, on-Num phone lookup
- Ops: staged releases + one-command rollback on both workers, budget doc with
  metered actuals (~$20/mo today), AGENTS.md discipline, backups

## 🟡 YELLOW — finish before inviting strangers (each ≤ 1 session)
- Showtimes parser: agent live, key valid; read `[showtimes] keys:` log line,
  match the field (QA_SPRINT_PLAN §5) — 10 min
- Coach-mark popups for feature walkthroughs (QA plan §4)
- iOS Contacts toggle OFF, replaced by SEND & SHARE row (decided, QA plan §3)
- One end-to-end push confirmed on a physical phone (Vivian's invite buzz)
- Re-run write-button checklist from STRESS_TEST doc (was cap-blocked)
- `workers_dev: false` — ONLY after all installs moved to app.itsnum.com

## 🔴 RED — gated, do not launch these claims
- **Payments**: stays `none` until ledger reconciled + webhook signatures
  verified + ONE real payout clears (Duke Track A/B). No copy says pay works.
  Note: 11/11 payout methods are USDC — first rail is crypto, not Stripe.
- **5arz verification**: gated on key registry fix + hmac-v0 death
  (5ARZ_CONNECT_BRIEF.md — in progress on Viv's machine tonight)
- **Public coverage number**: site says 567,793; truth ~2.53M. Fix the
  generators from live D1 before any press/partner sees the site, or we're a
  proof company publishing a wrong number about itself
- 538 stored Google ratings — delete (now unblocked); admin key in query
  strings (SEC-003) — rotate
- Cash-out copy stays: "Every Star = $1. Always. Cash-out is coming soon."

## Launch-day runbook
- Watch: `npx wrangler tail num-app --config wrangler.app.jsonc` (app) ·
  `wrangler tail num-ai` (LINE)
- Rollback: `node scripts/release.mjs rollback` (app) · `ai/release.sh rollback`
- Budget alerts: Cloudflare budget alert ☐ · Anthropic limit ☐ · Twilio
  triggers ☐ (OPERATING_BUDGET.md checklist)
- First-hour signals: signup completes on a fresh phone · invite → buzz →
  plan appears · movie ask returns real venues · llm spend visible in
  num_usage · zero 500s in tail
