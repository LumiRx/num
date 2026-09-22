# Handoff — eSIM: text ESIM to buy (21 Sep 2026, cowork-esim)

Built and tested. **Not deployed.** Nothing sells until the supplier key is set.

## What exists

| Piece | File |
|---|---|
| Map of the whole feature | `worker/esim.mjs` |
| Stand-in supplier (eSIM Access) | `worker/esimaccess.mjs` |
| Price engine: break-even after card fees + thin cushion, capped under supplier retail | `worker/esimprice.mjs` |
| Listing: priced, deduped, three picks | `worker/esimcatalogue.mjs`, cache in `worker/esimstore.mjs` |
| Orders, guarded state moves | `worker/esimorders.mjs` |
| Paid -> supplier -> installed, or refunded; the sweep | `worker/esimfulfil.mjs` |
| "Text ESIM" on SMS and WhatsApp | `worker/esimtext.mjs` (hooks in `sms.mjs`, `whatsapp.mjs`) |
| Pages | `worker/esimpages.mjs` |
| Stripe Checkout + refunds via pay.mjs's client | `worker/esimstripe.mjs` (hook in `pay.mjs`) |
| Every word a traveller reads | `worker/esimcopy.mjs` (travel-speak and voice lints cover it) |
| Destinations and 4,079 airports (OurAirports, public domain) | `worker/esimplaces.mjs`, `worker/esimairports.data.mjs`, `scripts/build-esim-airports.mjs` |
| Tables | `worker/migrations/0033_esim.sql` (registered, pending; `release:stage` applies it) |
| The concierge offers it when data is the question | `esimBlock()` in `worker/services.mjs` |

Routes (all on num-app, `app.itsnum.com`): `/esim`, `/esim/<cc>`, `/esim/airport/<iata>`,
`/esim/region/<eu|as|na|sa|af|me|oc|world>`, `/esim/find?q=`, `/esim/sitemap.xml`,
`/esim/pay/<token>` (-> Stripe), `/esim/o/<token>` (install page), `/api/esim/quote`,
`/api/esim/plans`, `/api/esim/order/<token>`, `/api/esim/doorbell/<secret>`, `/api/admin/esim`.

## 22 Sep: the first live check found the pages unreachable (fixed, needs a release)

v0.8.317 shipped the eSIM code and applied 0033, but `app.itsnum.com/esim` answered with the React
app shell: `run_worker_first` in `wrangler.app.jsonc` did not list `/esim`, so Cloudflare's asset
layer served the SPA fallback for every eSIM page, the pay link and the install link. Now listed,
and `app-public/sw.js` lets `/esim` (and `/go/`) navigations through to the browser. A wiring test
in `worker/esim.test.mjs` reads both files. The live check after the next release:
`curl -s https://app.itsnum.com/esim | grep -c "Land connected"` must print 1.

## Go live, in order

1. Sign up at eSIM Access, copy the Access Code, top up the prepaid balance.
2. Deploy num-app (`release:stage` applies 0033, then `release:ship`).
3. Secrets on num-app: `ESIMACCESS_ACCESS_CODE`, `ESIMACCESS_WEBHOOK_SECRET` (random, 16+ chars).
4. In the eSIM Access console, set the webhook to `https://app.itsnum.com/api/esim/doorbell/<that secret>`.
5. `POST /api/admin/esim {"action":"refresh"}` (or wait one cron tick), then `GET /api/admin/esim`.
6. Twilio: Messaging Geographic Permissions must allow the countries travellers text from.
7. One real purchase from Dre's phone (text ESIM THAILAND, pick 1), then refund it if it was
   never installed: `{"action":"refund","token":"<the code at the end of the install link>"}`,
   or `{"action":"refund","id":"eso_..."}` with the id from `recent` in `GET /api/admin/esim`.
   A ready order is cancelled with the supplier first (their money back to our balance); if they
   refuse because it was installed, the call says so and only `{"force":true}` refunds at our cost.

Optional: `SMS_CONCIERGE=on` (concierge answers texts from eSIM buyers only),
`ESIM_MARGIN_PCT` / `ESIM_MIN_MARGIN_CS`, `ESIM_MAX_LOSS_CS` (deliberate subsidy per sale),
`ESIM_SALES=off` (pause), `ESIM_MIN_BALANCE_CS` (default $10), `ESIM_BALANCE_ALERT_CS` (default $50).

## Unverified until the live key answers

eSIM Access publishes its docs as a JavaScript app. Request and response shapes come from their
published examples and one open-source client: `RT-AccessCode` header, money in 1/10,000 USD, data
in bytes, `/package/list`, `/esim/order` (our order id is their `transactionId`), `/esim/query`,
`/esim/cancel`, `/balance/query`, webhook `{notifyType, notifyId, content}`. The first
`GET /api/admin/esim` after the key is set shows balance and plan count; if either is missing,
the driver is wrong, not the traveller's order. Nothing is sold until both are present.

## Decisions taken, and why

- Num is the SELLER of eSIMs (unlike flights). Money that lands is Num's revenue for Num's product,
  not funds held for somebody else. Tax on digital/telecom sales is an accountant question.
- Webhook from the supplier is unsigned, so: secret in the path, body never believed, order
  re-read through the authenticated API, and a profile whose transaction id is not ours goes to
  `attention`, never to a traveller. (Section 8: every webhook verifies something.)
- Only large airports with plans go in the search index; the rest stay live for texts and QR codes.
- No "cheapest" / "best price" / "guaranteed" anywhere (`BANNED` in esimcopy.mjs, tested).
- Checkout offers card only, which carries Apple Pay and Google Pay on Stripe's hosted page. A bank
  debit would complete "unpaid", pay.mjs ignores unpaid sessions, and the money would arrive days
  later against an expired order. An eSIM arrives in seconds, so only instant payment is offered.
- The footer promises "we refund you in full", not "automatically": clear supplier refusals refund
  themselves in seconds, but an unclear one (supplier silent for an hour, unreachable three times)
  goes to `attention` and alerts a person. Candidate next step once real traffic exists: refund any
  `attention` order a person has not resolved in 12 hours.
- US texts: the eSIM replies ride +1 424 346 0888 like every other text. The campaign was approved in
  July and sends go through the Messaging Service since 30 Aug, but no programmable text has reached
  a real phone since (only Verify codes have). `GET /api/admin/twilio` -> `carries_our_number: true`
  settles it before the first sale.

## Adversarial review, 21 Sep evening: five money-path defects, all fixed and mutation-tested

1. A payment landing after its quote expired was kept with no eSIM and no refund. Now a late
   payment revives the order (`expired -> paid`) and it is fulfilled; any payment an order cannot
   use is refunded under its own key (`esim_unapplied_<pi>`), judged on a fresh read of the order.
2. Webhook errors were answered 200, so Stripe never retried. The eSIM branch of `pay.mjs` now
   answers 500 on any error; every retry is safe because an order only moves once.
3. Admin refunds could race a delivery or refund an eSIM nobody cancelled. New state `refunding`
   is claimed before Stripe is called; the sweep finishes stuck ones; `ordering` and `ready`
   without a profile number need `force`; a profile that arrives after a refund is cancelled.
4. A retry after an unanswered first call auto-refunded on any "no". Now it goes to a person
   with the transaction id: the first call may have bought the eSIM.
5. Consent: WhatsApp no longer joins the SMS list; the web marketing box is recorded only once the
   order is paid, never over an opt-out, with its evidence then cleared from the order.
Also: `refunding` has its own page (no install codes) and the pay link never opens a checkout for it.
Checked and unchanged: Adaptive Pricing keeps the Session in USD (Stripe docs), so the amount check holds.
Still open: whether eSIM Access refuses a repeated transactionId (a retry that SUCCEEDS could buy a
second eSIM if it does not) — confirm with their support or on the live account.

Tests: 150 in `worker/esim*.test.mjs`; full suite 5,918+ green on the eSIM side (21 Sep, 20:30 UTC); eslint 0 errors; four lints clean;
`wrangler deploy --dry-run` bundles.
