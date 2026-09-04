# Get the outreach out — 3 September 2026, 20:00 UTC

## Already done (by me, verified)

**The six businesses are un-marked.** `num_claim_decisions.onboarded` reset to 0 for claims
8, 9, 10, 13, 14, 15 — Morrisons Lounge, makani, Awafi, **Holiday Inn Express**, Giuliano's,
Fingal. 6 rows changed, re-read and confirmed. None of the six is on the suppression list.
They are now queued for the five-minute sweep.

## Step 1 — a new Resend key (2 minutes)

**https://resend.com/api-keys** → *Create API Key* → name it `num-app-prod`, permission
**Sending access**, domain **itsnum.com**. Copy it once; it is never shown again.

Then check the domain is actually verified — the current key returning 401 may not be the only
problem:

**https://resend.com/domains** → `itsnum.com` must read **Verified**, with DKIM, SPF and DMARC
all green. If `mail.itsnum.com` is listed and unverified, ignore it — `MAIL_FROM` was moved to
`itsnum.com` on 1 Sep for exactly that reason.

Set it:

    npx wrangler secret put RESEND_KEY --config wrangler.app.jsonc

Paste the key at the prompt. NOTE: no `#` comments on the same line as a
wrangler command — zsh passes them through as arguments and wrangler errors
with "Unknown arguments". Every value below is typed at the prompt, not on the
command line, which is also why it never lands in your shell history.

`RESEND_KEY` is the name the codebase reads. (`health.mjs` also checks `RESEND_API_KEY`; setting
both costs nothing and closes a real gap — that mismatch is why the alert email path never ran on
most deployments.)

## Step 2 — the delivery webhook (2 minutes) — THIS IS THE ONE THAT MATTERS

**https://resend.com/webhooks** → *Add Webhook*

    Endpoint   https://app.itsnum.com/api/webhooks/resend
    Events     email.delivered, email.bounced, email.complained

Copy the signing secret (`whsec_…`) and set it:

    npx wrangler secret put RESEND_WEBHOOK_SECRET --config wrangler.app.jsonc

Without this, "delivered" is a word this system can never say. With it, `onboarded` finally
means what its name claims, bounces un-mark the send so a corrected address can be tried, and a
spam complaint suppresses the address automatically.

## Step 3 — deploy

    npx wrangler deploy --config growth/wrangler.jsonc   # tracker, bot filter, suppression fix
    npm run release:ship                                 # app: failures ledger, mail audience, webhook
    npx wrangler deploy --config wrangler.jsonc          # site: /ask/ redesign, nav

## Step 4 — turn the outreach on

    npx wrangler secret put BIZ_ONBOARD_EMAIL --config wrangler.app.jsonc

At the prompt type exactly:

    on

Lowercase, no quotes. The code checks `env.BIZ_ONBOARD_EMAIL === 'on'`, so
"ON", "true" and "yes" all leave the outreach switched off.

The cron picks the six up within five minutes.

## Step 5 — watch it, and believe only the evidence

    curl -s -H "X-Admin-Key: $ADMIN_KEY" https://app.itsnum.com/api/admin/failures | head -40

What you should see over the next hour:

- **Nothing at all** — the six were accepted AND confirmed delivered. That is success, and it is
  the first time this system has been able to tell you so.
- `biz_onboard_unsent` — Resend refused. The key or the domain is still wrong. Nobody was marked
  told, so fixing it and waiting five minutes is the whole remedy.
- `biz_onboard_unconfirmed` — accepted, and thirty minutes later still no delivery event. Either
  the webhook is not configured or it never reached a mailbox. **This is the alarm that would have
  fired at 20:56 on 30 Aug instead of four days of silence.**
- `mail_bounced` — a real bad address. `onboarded` is cleared automatically so a corrected address
  can be tried.

And the same thing without a key, from anywhere:

    curl -s https://app.itsnum.com/api/health | head -5

An open failure that nobody was successfully told about now makes that endpoint report **down**.
The uptime probe outside Cloudflare has been reading it every five minutes for a month.

## Still yours to decide

**`claims` vs `num_claims`.** `claims` id 13 says Holiday Inn Express is approved
(`auto:unverified`, `verified_at` NULL); `num_claims` says pending. My read: `claims` is
operational — onboarding, decisions and the admin routes all join against it — and `num_claims` is
the newer verification flow those legacy web claims never entered. Nothing else should be built on
either until you say which is canonical.

**The LINE watchman.** 81 dead `ops.alert` rows live in `num_outbox`, and `num_outbox` appears
nowhere in `num-worktrees`. It is another worker — most likely `num-send`. Connect that folder and
I will give it the same treatment: ledger first, delivery second, and a channel that cannot
silence its own alarm.
