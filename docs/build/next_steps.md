# NUM — Next Steps (the "make it runnable" checklist)

Hand this to whoever is doing the build (Claude Code, contractor, or you).

## Today (2–4 hours to live echo)
1. `python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
2. Copy `.env.example` → `.env` and fill in Supabase URL/keys + Anthropic API key (skip LINE/WeChat/Twilio for now).
3. Create the Supabase project in **ap-southeast-1**, run `schema_minimal.sql` in the SQL editor.
4. `uvicorn main:app --reload` — confirm `GET /healthz` returns ok.
5. Use `curl -X POST http://localhost:8000/sms -d "From=+15551234567&Body=Hi"` to confirm a Claude reply comes back.

## This week (get a real channel live)
6. Provision Twilio account + buy 1 number for the pilot region. Verify WhatsApp Business sender (1–3 days lag — start now).
7. Deploy to Railway: connect GitHub repo, set env vars, add `Procfile`:
   ```
   web: uvicorn main:app --host 0.0.0.0 --port $PORT
   ```
8. Point Twilio webhook at `https://<your-railway-app>/sms` and `/whatsapp`.
9. Send a real SMS to the Twilio number. Confirm round-trip in <3 seconds.
10. Add Sentry DSN and confirm an intentional 500 is captured.

## Next 2 weeks (upgrade to Path B — pilot-ready)
11. Migrate to `schema_full.sql` (drop & recreate in a fresh DB; we don't have prod data yet).
12. Set `DEFAULT_PARTNER_TENANT_ID` from the row you create in `partner_tenants` for the Phuket partner.
13. Implement `LineAdapter` in `/line/webhook` using `line-bot-sdk`. Test with LINE Messaging API console.
14. Either register a fresh WeChat Service Account (4–6 weeks for verification) OR get partner-side access to theirs. Implement `WeChatAdapter` in `/wechat/webhook`.
15. Wire vector memory: embed every assistant message + extracted facts; implement `lookup_user_memory` and `save_user_memory` tools; switch `generate_concierge_reply` to use Anthropic tool-use loop.
16. Implement envelope encryption for `user_profile_secure` (start with Supabase Vault; move to AWS KMS at Pro tier).
17. Stand up the partner read-only Next.js dashboard (separate repo, Vercel deploy). KPIs from `/02_PARTNER_PROPOSAL_PHUKET.md` §B.2.
18. Wire per-vehicle QR codes — generate codes, populate `acquisition_sources`, print QR PNGs, hand to partner for install.

## Before pilot launch (Week 8)
19. PDPA consent flow: first inbound message replies with a one-line consent disclosure + opt-out instruction.
20. PII scrubber: Haiku pass on every inbound, redact passport/card/national ID patterns before storing in `messages.content`.
21. Load-test: simulate 200 concurrent conversations, confirm <2s P95 reply time.
22. Internal dogfood: partner team uses NUM in 5 cars for 5 days; tune prompts and vendor data from real conversations.

## Reference
- Master spec: `/01_MASTER_ARCHITECTURE.md`
- Pilot terms + KPIs: `/02_PARTNER_PROPOSAL_PHUKET.md`
- Business model: `/03_BUSINESS_MODEL.md`
- Full roadmap: `/04_IMPLEMENTATION_ROADMAP.md`
