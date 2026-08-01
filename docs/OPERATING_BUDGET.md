# Operating budget — NUM / 5arz platform spend

*Started 2026-08-01, the day of the Free-plan incident. Every number in the
"actuals" column was queried, not remembered. Refresh queries at the bottom.*

## Why this exists

The product was down for two days because nobody knew the account was on a
free plan. A budget line with an owner would have caught it in July. Same
class of problem as the $10 overnight Twilio spend: costs nobody watches.

## Monthly recurring (fixed)

| Platform | Account | Plan | $/mo | Owner | Notes |
|---|---|---|---|---|---|
| Cloudflare Workers Paid | thatislumi@gmail.com | Paid (as of 08-01) | **$5.00** | Dre | Upgraded to lift D1 500MB→10GB cap. Includes 10M req/mo, 5GB D1 storage. |
| Railway | info@thatislumi.com | Hobby | **$5.00** | Dre | FastAPI backend (dormant — see decision below) |
| Supabase | (5arz org) | Free | $0 | Dre | Auto-pauses when idle |
| Twilio | — | pay-as-you-go | usage | Dre | See usage section. Set Usage Triggers $25/$50/$100. |
| Anthropic API | — | pay-as-you-go | usage | Dre | Two keys: app's (working) + Railway's (invalid) |
| LINE Messaging API | — | free tier | $0 | — | Reply messages free; push has free monthly quota |
| Domains (itsnum.com, 5arz.com, aeroz.io, cupidtoday.com, thatislumi…) | — | annual | ~$4–6/mo amortised | Dre | |

**Fixed floor: ~$15/mo.**

## Usage-driven (the ones that can surprise you)

### LLM spend — tracked per call in the database (`num_usage.micro_usd`)

Actuals as of 2026-08-01:

| Month | Model | Calls | Spend | Avg/call |
|---|---|---|---|---|
| Jul 2026 | claude-opus-5 (app brain) | 72 | **$3.27** | $0.045 |
| Jul 2026 | claude-sonnet-5 | 3 | $0.10 | $0.033 |
| Jul 2026 | workers-ai / llama / gpt-oss lanes | 35 | ~$0 | Cloudflare-side |
| Aug 2026 | claude-opus-5 | 2 | $0.08 | $0.038 |

Read: **the AI brain costs ~4.5¢ per answered message** on Opus. At real usage:

| Volume | Opus/mo | With small-lane routing (~60% cheap lane) |
|---|---|---|
| 10 msgs/day | ~$14 | ~$6 |
| 100 msgs/day | ~$136 | ~$55 |
| 1,000 msgs/day | ~$1,360 | ~$550 |

The `micro_usd` column makes this self-auditing — no estimating needed, ever.
The LINE worker (`num-ai`) runs on Workers AI (llama), billed in Cloudflare
neurons: currently negligible (10k neurons/day free allowance).

### Cloudflare beyond the $5

Included in Paid: 10M requests, 5GB D1, 25B D1 row-reads, 50M row-writes /mo.
Current run rate (July): 60k requests, ~2B row-reads — comfortably inside.
**Watch one thing: D1 storage.** `num-db` is 1.24GB of 5GB included. If the
Overture ingest resumes it costs $0.75/GB-mo past 5GB and re-runs the incident
at 10GB. Ingest stays paused until the num-core split.

### Twilio (currently ~$0 — dormant stack)

The $10 overnight spend in July was investigated: per-message WhatsApp/SMS
charges. Nothing sends today (Railway's Anthropic key invalid). Before that
stack goes live: Usage Triggers at $25/$50/$100, auto-recharge OFF,
UK-only geo permissions. At Edinburgh launch volumes, COST_MODEL.md (branch
`backend-fastapi`) projects ~$171/mo at 1,000 users — SMS is the dominant cost
of that stack, above the LLM.

## Budget to operate, honestly stated

| Phase | $/mo |
|---|---|
| **Today** (pilot, low traffic, LINE+app) | **~$20** (fixed $15 + ~$5 LLM) |
| First 100 active users | ~$40–75 |
| 1,000 active users, messaging live | ~$400–900 (LLM + SMS dominate; cache + small-lane routing are the levers) |

## Alerts to set (10 minutes, prevents the next incident)

1. ✅ Cloudflare: **Billing → Add Budget Alert** (suggest $25) — button is on
   the dashboard page you used for the upgrade.
2. ☐ Anthropic console: usage limit + email alert on the app's key.
3. ☐ Twilio: Usage Triggers $25/$50/$100, auto-recharge off.
4. ☐ Railway: usage limit in project settings (Hobby includes $5 usage).
5. ☐ Calendar: 1st of month — run the refresh queries below, update this file.

## Open decision

**Railway ($5/mo + invalid Anthropic key):** the FastAPI stack has never served
a guest. Either commission it (fix key, set TWILIO_AUTH_TOKEN, point WhatsApp
at it) or pause the service and stop paying for a dormant stack. $60/yr is
small; an unowned production surface is not.

## Refresh queries (1st of each month)

```bash
# LLM spend by month/model — the real number, from the app's own metering
npx wrangler d1 execute num-db --remote --json --command \
 "SELECT substr(day,1,7) mo, model, COUNT(*) calls,
         ROUND(SUM(micro_usd)/1.0e6,2) usd
  FROM num_usage GROUP BY 1,2 ORDER BY 1 DESC, usd DESC"

# LINE worker (Workers AI) token volume
npx wrangler d1 execute num-db --remote --json --command \
 "SELECT substr(created_at,1,7) mo, model, COUNT(*) calls,
         SUM(in_tokens) tin, SUM(out_tokens) tout
  FROM num_llm_calls GROUP BY 1,2"

# D1 size — the number that took production down
npx wrangler d1 info num-db --remote
```

Cloudflare request/CPU actuals: dashboard → Workers & Pages → right rail.
Anthropic actuals: console.anthropic.com → Usage. Twilio: Monitor → Usage.
