# Status for Duke — 2026-08-01 (from Dre's session, digest of #num + today's work)

Duke reads the artifacts, so this is your copy of record. Sources: Viv's
production-verified status (Slack #num, 15:28 PT) + Dre-side session logs.

## 1. The 5arz connection is LIVE in prod — finish it, don't build it (Viv, verified)
- LEDGER->5arz-ledger bound; verify/5arz past guard; /api/air connected:true
- 5arz: 141 members / 102 verified / 91 google_sub / 15 scored sessions / 0 UHA
- NUM: 74 members / 1 linked / 0 phone-verified / 0 AiR calls
- **Gap 1 (SECURITY, yours): GOOGLE_CLIENT_ID unset** — audience check skipped;
  any Google token from any app accepted. `npx wrangler secret put
  GOOGLE_CLIENT_ID --config wrangler.app.jsonc`
- **Gap 2: CLOSED by Dre's session (0.8.87)** — Verify5arz.tsx in the profile:
  GIS sign-in -> POST verify/5arz -> all four outcomes rendered. Dark until
  your Gap-1 secret exists; /api/version serves google_client_id so client
  and audience check can never disagree. Verified dark-safe in prod.
- **Gap 3 (yours): AIR_SHARED_KEY unset** — /api/trust 401s everyone.
- NOT blockers for this path: JWKS oracle mismatch (gates UHA only, 0 rows),
  num-core migration. Track A-prime still gates UHA/nodes.
- Claim limit: sell "verified identity + scored work sessions" (102/15), not
  "attested unique humans" (0).

## 2. Email (Viv's 29h audit): 800 sends, 709 ok, 91 bounce, 0 complaints
- Merchant campaign bounce 17.25
## UPDATE 2026-08-01 late — Gap 1 CLOSED by Dre
GOOGLE_CLIENT_ID set on num-app (the existing "NUM Web" OAuth client in the
5arz GCP project, origins verified). Confirmed live: /api/version reports
verify_5arz:true and serves the client id; audience check now enforced.
Remaining from your list: AIR_SHARED_KEY only.

## Addendum 2 — pay rail + connections (0.8.91/0.8.92, later 08-01)

- **Connect Your World is real now** (0.8.91): contact/photo pickers, calendar auto-mirror, read-only wallet link, per-member email forward address (`num+<id>@itsnum.com`, worker `email()` handler shipped — needs Email Routing catch-all on itsnum.com flipped to the num-app worker), and inbound SMS at `/api/sms/inbound` with **Twilio signature verification** (403 otherwise — probed live).
- **Pay rail** (0.8.92): Stripe Checkout end-to-end behind `STRIPE_SECRET_KEY`; `/api/pay/webhook` verifies Stripe signatures per your §8 rule (unsigned → 400, probed live). The wallet's top-up buttons no longer fake-credit Stars.
- **§8 "Never sell Stars" is enforced in code**: `/api/pay/request` refuses any `stars:*` purchase with a 403 unless `STARS_SALE_OK=1` is set. That env var is yours to set or never set — bills/tabs/bookings/bounties are unaffected and can charge the moment a Stripe key exists. Money flows provider→recipient via Stripe; we hold nothing.
