# NUM — Deploy Runbook (Railway + channels, ~half a day of clicking)

**Updated:** 2026-07-17 · Everything below is verified against the current repo: `railway.json` builds from `apps/api/requirements.txt` (pinned today, boot-tested, incl. the `python-multipart` fix that would have 500'd Twilio webhooks), healthcheck at `/healthz`, keep-alive at `/healthz/db`.

**Order matters — the two slow approvals go FIRST:**

---

## 0. Start the slow clocks (do these before anything else)

**a. WhatsApp Business sender (1–3 days, sometimes longer)**
1. Twilio Console → Messaging → Senders → WhatsApp senders → New sender.
2. Needs a Meta Business Manager account (partner's or Lumi's) + the Twilio number below + display name "NUM".
3. Submit now; use the **WhatsApp Sandbox** for all testing until approved.

**b. WeChat Service Account — make the decision**
- Partner's existing verified SA → configure webhook (step 5) in days.
- Fresh registration under Lumi → 4–6 weeks; start the paperwork now if that's the call.
- **Pilot can launch WA + LINE + SMS while this clears.**

---

## 1. Supabase (10 min)

1. **Upgrade project `num` (`txabrxbobyxznkgarpkc`) to Pro** — free tier auto-pauses on idle and has already paused twice. (If staying free for another week: the §6 pinger keeps it awake, but Pro before real traffic.)
2. Dashboard → Settings → API: copy **Project URL** + **service_role key** into your secrets stash.
3. Migrations 0001–0006 are already applied — nothing to run.

## 2. Seed the tenant (5 min, SQL editor)

```sql
insert into partner_tenants (name) values ('Phuket InCar Group') returning id;
```
Copy the returned uuid → it becomes `DEFAULT_PARTNER_TENANT_ID`. (Vehicle QR codes come later: one `acquisition_sources` row per car, `code` like `car_PHK_001`.)

## 3. Railway (30 min)

1. railway.app → New Project → **Deploy from GitHub repo** → select the NUM repo (push it first if it only lives locally).
2. Railway reads `railway.json` automatically: Nixpacks build from `apps/api/requirements.txt`, start `uvicorn apps.api.main:app`, healthcheck `/healthz`. `.python-version` pins 3.12.
3. Service → Variables → paste from `.env.example`, filling: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEFAULT_PARTNER_TENANT_ID`, `APP_ENV=production`, and Twilio/LINE creds from steps 4–5. `APP_BASE_URL` = the Railway domain after first deploy.
4. Settings → Networking → **Generate Domain** → note `https://<app>.up.railway.app`.
5. Verify: `GET /healthz` → `{"status":"ok"}` and `GET /healthz/db` → `{"status":"ok","db":"ok"}`.
6. **Embed worker** (memory backfill): same project → **New Service** → same repo → start command `python -m apps.workers.embed` (uses the same variables via shared environment). Cheaper alternative: Railway cron `python -m apps.workers.embed --once --drain` every 5 min.

## 4. Twilio (20 min)

1. Buy a number (US local is fine for pilot; Thai virtual numbers are a separate rabbit hole — WA/LINE are the real channels).
2. Phone Numbers → your number → Messaging: webhook `https://<app>.up.railway.app/sms` (POST).
3. Messaging → WhatsApp Sandbox (until sender approved): inbound webhook `https://<app>.up.railway.app/whatsapp` (POST). Join the sandbox from your phone and send "hi" — expect a concierge reply + PDPA notice in <3s.
4. Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_WHATSAPP_FROM` (sandbox number until approval).

## 5. LINE (20 min) + WeChat (when unblocked)

**LINE** — developers.line.biz → new provider "Lumi" → **Messaging API channel** "NUM":
1. Webhook URL `https://<app>.up.railway.app/line/webhook` → Verify → enable "Use webhook"; disable auto-reply messages.
2. Env: `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` (issue long-lived token). Add the bot via QR, send a message, confirm round-trip.

**WeChat** (after §0b) — SA admin console → Basic Config: URL `https://<app>.up.railway.app/wechat/webhook`, Token = the value you set as `WECHAT_TOKEN`, plaintext mode. The GET handshake passes once env is set.

## 6. Keep-alive + observability (15 min)

1. **Uptime pinger** — betterstack.com (free) or UptimeRobot: monitor `GET https://<app>.up.railway.app/healthz/db` every **5 min**. One monitor = Railway stays warm + Supabase never pauses + you get downtime alerts. Point alerts at your email + phone.
2. **Sentry** — sentry.io → new FastAPI project → copy DSN → `SENTRY_DSN` env → redeploy → trigger a test error, confirm capture.
3. **Slack #num-ops** — create channel → Slack app → Incoming Webhook → `SLACK_OPS_WEBHOOK_URL` env. Whale leads + escalations ping here.

## 7. Smoke test (15 min)

```bash
# 1. Health
curl https://<app>.up.railway.app/healthz/db
# 2. Seed one vendor so search_vendors has data
python scripts/ingest_vendors.py docs/ops/vendor_template.csv --dry-run   # then without --dry-run
# 3. WhatsApp sandbox conversation:
#    "hi"                → reply + PDPA consent notice (new user)
#    "สวัสดี หาร้านอาหารทะเลให้หน่อย" → Thai reply, recommends ONLY the seeded vendor
#    "I want to buy a villa, 20M THB, this quarter" → whale-lead capture → Slack ping
#    "DELETE"            → erasure confirmation; consent_events shows the trail
# 4. Check llm_usage rows + v_cost_per_user_daily for the turn costs
```

## 8. Done-when

- [ ] `/healthz/db` green from the public internet, pinger armed
- [ ] WA sandbox + SMS + LINE all round-trip < 3s
- [ ] PDPA notice fires once for new users; DELETE erases + audits
- [ ] Vendor search returns seeded data, never invents
- [ ] Whale lead lands in `leads` + Slack
- [ ] Sentry catches a forced error
- [ ] WhatsApp sender approval in flight · WeChat decision logged

**Then the Thai team switches from collection to dogfooding** (`VENDOR_ONBOARDING.md` §Test conversations) — and vehicles get QRs once the domain decision lands (QRs should point at the final domain, not the Railway URL).
