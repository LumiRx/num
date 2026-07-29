# WhatsApp — Billing Truth & Connection Checklist

**Updated:** 2026-07-29 · **Market:** Edinburgh (UK) · **Provider:** Twilio → Meta

---

## Part 1 — What you actually pay

**Yes, you pay per message — in both directions.** Two separate charges stack:

| Charge | Who | Amount | When |
|---|---|---|---|
| **Twilio handling fee** | Twilio | **~$0.005 per message, sent AND received** | Every single message, always — including inside the free window |
| **Meta conversation/template fee** | Meta (passed through) | **$0.0014 – $0.0499**, varies by country + category | Only on business-initiated templates |
| Failed message | Twilio | ~$0.001 | Each failure |
| Number rental | Twilio | ~$1–2/month | Monthly |

### The nuance that matters most
The **24-hour customer service window** — opened when a user messages you first — makes **Meta's** fee free for replies inside it. It does **not** make Twilio's $0.005 free. So a normal conversation where a traveler texts NUM and gets 6 replies costs roughly:

> 7 messages × $0.005 = **$0.035 in Twilio fees**, $0 in Meta fees.

That's the good case, and it's why NUM's design (always user-initiated, always replying inside the window) is the cheap one. Business-initiated marketing templates are where costs explode — we don't send those.

### So what is $10 overnight?

Pure Twilio fees at $0.005 → **$10 ≈ 2,000 messages.** With template fees in the mix, fewer — but still hundreds. **For a pre-launch product with no users, overnight, that is not organic traffic.**

#### The diagnostic fork — do this first
Check whether your **Anthropic** bill moved in the same window.

- **Anthropic also spiked** (~$0.013/message → 2,000 msgs ≈ $26) → real messages reached the pipeline. Something is *generating* them: a loop, a scanner, or test traffic left running.
- **Anthropic flat** → messages never reached your app. That's Twilio-side: failed sends, retries against a dead webhook, or the charge isn't message volume at all (number rental, sandbox fees, or a different product on the bill).

This single check tells you which half of the system to debug.

#### Where to look, in order
1. **Twilio Console → Monitor → Logs → Messaging.** Filter to last 24h. You'll see every message, direction, status, and price. This *is* the answer — it names the number and the volume.
2. **Twilio Console → Usage → Summary.** Break the $10 into categories. If it's not "WhatsApp messages," stop chasing message volume.
3. **Look at the `From` numbers.** All one number → a loop or a tester. Many numbers → scanners found your sandbox.
4. **Check status = `failed`/`undelivered`.** High failure counts with retries is a classic silent burn.

#### Known amplifier in our stack — worth checking
Twilio abandons a webhook at ~15s and **retries**. Our tool loop is capped at 12s, which is deliberately inside that — but if the API is cold-starting (Railway free tier sleeps) the first request can exceed it. Each retry re-runs the whole pipeline: **another Twilio message fee AND another Sonnet call.** If you see duplicate inbound records for the same message SID, that's this.

**Fix:** keep the container warm (the `/healthz/db` pinger already does this if it's actually running) and confirm p95 response time is under 10s.

---

## Part 2 — Protect the account today

Do these before you connect a single real user. Twilio has no hard spend cap by default — it will keep spending.

1. **Set a spend alert.** Twilio Console → Billing → **Usage Triggers**. Create triggers at **$25, $50, $100** on total usage, emailed to you. This is the single most important thing on this page.
2. **Turn off auto-recharge**, or set it to the minimum, until traffic is understood. Auto-recharge plus a loop is how a $10 night becomes a $500 night.
3. **Set geographic permissions.** Console → Messaging → Settings → **Geo Permissions**. Enable only **UK** (and wherever you actually operate). This kills international abuse traffic instantly.
4. **Know your kill switch.** If spend runs away: Console → Phone Numbers → your number → set the inbound webhook to blank, or point it at a URL that returns empty TwiML. Traffic stops immediately without deleting anything.
5. **Verify the Railway app isn't erroring.** Every 500 that Twilio retries is billed twice. `handle_inbound_safe` should prevent this — confirm in the logs.

---

## Part 3 — What's needed to let people connect

You have two paths. **Start on the sandbox today; run the production application in parallel.**

### Path A — Sandbox (live in 10 minutes, for testing only)
Already available on any Twilio account.

1. Console → Messaging → **Try it out → Send a WhatsApp message**.
2. Note the sandbox number and join code (e.g. `join <two-words>`).
3. Set **"When a message comes in"** → `https://<your-app>.up.railway.app/whatsapp` (POST).
4. Testers message the sandbox number with the join code, then chat normally.

**Limits:** every user must send the join code first, the number is shared and Twilio-branded, and sessions expire after 72h of inactivity. Fine for you and the two Edinburgh businesses. Not for real travelers.

### Path B — Production WhatsApp sender (the real thing)

| # | Step | Owner | Time |
|---|---|---|---|
| 1 | **Meta Business Manager account** — create or use existing for 5arz | Dre | 30 min |
| 2 | **Business verification** — legal name, address, website, business document | Dre | **1–5 days** ⏳ |
| 3 | **A phone number that has never been on WhatsApp** — a new Twilio UK number is cleanest. It cannot be your personal number | Dre | 10 min |
| 4 | **Twilio Console → Senders → WhatsApp senders → New sender** — connects Twilio to your Meta account | Dre | 20 min |
| 5 | **Display name approval** — "NUM" or "NUM Travel Concierge". Must reflect the real business | Meta | 1–2 days |
| 6 | **Privacy policy live** — ✅ already fixed and ready to publish (`docs/compliance/`) | — | done |
| 7 | **Point the webhook** at `/whatsapp` on the production number | Dre | 5 min |
| 8 | **Message templates** — only if you ever message users first (reminders, follow-ups). Not needed for reply-only | Later | — |

**The long pole is step 2** — business verification. Start it today; everything else is minutes.

### What you do *not* need
- ❌ **US A2P 10DLC** — that's US SMS only. The rejection sitting in your console does not block WhatsApp or UK messaging.
- ❌ Message templates for launch — NUM replies inside the service window, which needs no templates.
- ❌ A Facebook page (Meta dropped that requirement).

---

## Part 4 — Cost expectations once live

From `COST_MODEL.md`, with real Twilio numbers:

| | 100 users/mo | 1,000 users/mo |
|---|---|---|
| Messages (12/user) | 1,200 | 12,000 |
| **Twilio @ $0.005** | **$6** | **$60** |
| Meta fees (service window) | ~$0 | ~$0 |
| Anthropic | $16 | $156 |
| Infra | $45 | $65 |
| **Total** | **~$67** | **~$281** |

**WhatsApp is cheap when users start the conversation** — $60/month at a thousand users. The costs that hurt are business-initiated templates and SMS. Neither is in NUM's normal flow.

**Which makes the $10 overnight the anomaly worth chasing.** At normal rates that's 2,000 messages — more than a hundred real users would send in a night. Find it before you invite anyone.

---

*Sources: [Twilio WhatsApp pricing](https://www.twilio.com/en-us/whatsapp/pricing) · [Twilio messaging pricing](https://www.twilio.com/en-us/pricing/messaging)*
