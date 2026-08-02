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

## Addendum 3 — NUM Stars are closed-loop (0.8.99)

Clarifying a conflation in Addendum 2. There are **two Star economies** and they
must not be reasoned about together:

| | 5arz `stars_ledger` | NUM `num_star_balances` |
|---|---|---|
| Worker | `num-payouts` / 5arz | `num-app` |
| Cash-out | yes — USDC payout methods on file | **none, by construction** |
| Your §8 rule | applies | see below |

NUM Stars have **no path to money**: no cash-out endpoint, no refund-to-card, no
transfer to an outside wallet. They move member → escrow → member inside
`worker/errands.mjs` and stop. This is now stated and exported as `CLOSED_LOOP`
in `worker/pay.mjs`, served on `/api/pay/status`, and reflected in app copy —
the wallet's old "1★ ≈ $0.30" line read as an exchange rate and is gone.

Because we never owe a Star holder money back — only service inside Num — a
paid top-up is prepaid credit for our own service rather than stored value we
hold and remit. That is a materially narrower question than the one §8 was
written against, but it is **still your call with counsel**, so the switch is
untouched: `/api/pay/request` refuses `stars:*` unless `STARS_SALE_OK=1`.

**If you do open it, the invariant to defend is:** never add a cash-out to
`num_star_balances`, and never merge it with `stars_ledger`. That single line is
what the posture rests on.

## Addendum 4 — two wallets, one direction (0.8.101)

Dre's call, and it is the right one: **Num and 5arz are separate wallets.**

```
NUM wallet  ──── cash out ────▶  5arz wallet
NUM wallet  ◀──── NOTHING ────   5arz wallet
```

5arz Stars never enter Num — not as a transfer, a top-up, or a "link your
balance" convenience. Reasons, in order of how much they'd cost us:

1. If 5arz Stars could enter Num and leave through Num's payout, Num becomes a
   second exit for someone else's balance — a value-transfer service, which is
   the licensing shape we are avoiding.
2. Your Track-A drift (21 of 80 members) lives in `stars_ledger`. Importing its
   numbers imports its bugs into a ledger that is currently clean.
3. One-way means a bug over there can never mint Stars over here.

**Enforced, not just written down.** `worker/cashout.test.mjs` reads the actual
source and fails the build on: a new place that credits `num_star_balances`
(allowlisted by file, with reasons), any `fetch` to a 5arz host, and any query
naming `stars_ledger` / `member_finance` / `payable_stars`. I verified it bites
by adding a real import and watching two tests fail.

That test also surfaced three credit sites in `social.mjs` I had not audited —
member→member transfer, its rollback, and tab settlement. All three move Stars
between Num members; none mints and none reaches outside. Recorded in the
allowlist with that reasoning.

Cash-out itself remains gated on `CASHOUT_OK` pending your Track A.
