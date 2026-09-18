# LetsGo2Trip — go-live runbook

State as of 18 Sep 2026, verified against production 0.8.345.

## Where we actually are

Everything is built, tested and deployed. 161 tests pass across
letsgo2trip / handoff / flighthandoff / travelreferral. Production answers:

    POST /api/flights/handoff  ->  200 {"available":false,"why":"No booking partner is configured."}
    POST /api/partner/reconcile ->  401 {"error":"Send your key in the X-Partner-Key header."}
    /api/version  ->  travel_referral {enabled:false, partners:0}

The whole rail is wired and waiting on ONE environment variable. Nothing
else on our side blocks a traveller booking a flight through the partner.

## The one command that turns it on

    npx wrangler secret put LGT_PARTNER_ID --name num-app   # value: our slug, from Tina

That single secret flips fulfilment().primary from null to 'lgt', makes
handoffAvailable() true, and the booking button renders at the end of the
Sabre fares tray. Verified by dry-run:

    https://letsgo2trip.com/flights?origin=DXB&dest=LHR&depart=2026-10-14
      &return=2026-10-21&adults=2&partner_id=num&ref_id=lgt_<16 hex>   prefilled:true

## The surcharge, which decides the traveller-facing sentence

`LGT_SURCHARGE_CS` is NUM's BELIEF about what their checkout charges. It is
not a switch on their fee — only LetsGo2Trip can move that toggle.

| Tina's answer | What to set | What the traveller sees |
|---|---|---|
| Surcharge is OFF for our slug, in writing | `LGT_SURCHARGE_CS=0` | no fee sentence (correct — there is no fee) |
| Still on at $15 | leave unset (defaults 1500) | the disclosure sentence fires |
| On at some other amount | that amount in cents | sentence with the real number |

Setting 0 while their toggle is still on is the one genuinely dangerous
move: it silences a disclosure for a fee the traveller still pays. Keep the
written confirmation.

## THE ONE CODE CHANGE THE NEW MODEL FORCES

The disclosure sentence in `surchargeLine()` currently says:

  "...their checkout adds it on top of the fare for bookings Num sends..."

That was true of the August referral deal, where the extra cost was THEIR
surcharge. Under the new dashboard model the extra cost is OUR markup —
we set it, we receive it. The sentence would then be attributing our own
margin to the partner, which is exactly the kind of misdescription the 12
Sep fix existed to remove.

So before the first booking under markup terms, `surchargeLine()` needs to
say the true thing: that Num adds a margin to the fare, how much, and that
booking direct avoids it. Same rule as before — the fee is a commercial
choice, the silence is not one we get to make.

This is a small change and it is BLOCKING. It cannot be written until Tina
says what baseline means, because the sentence has to quote a real number.

## The rest, once we know the numbers

    npx wrangler secret put LGT_RATE --name num-app
      # {"flight":{"flat_cs":1500},"stay":{"bp":600}}  — only what they agree in writing.
      # Unset is the honest state: expectedFor() returns null and the referral
      # row carries NULL rather than our guess.

    npx wrangler secret put TRAVEL_PARTNERS --name num-app
      # [{"id":"letsgo2trip","name":"LetsGo2Trip","email":"ops@letsgo2trip.com",
      #   "products":["flight","hotel","esim","tour"],"dests":["*"],
      #   "commission_bp":{},"priority":10,"active":true,
      #   "checkout_url":"https://letsgo2trip.com/flights?origin={from}&dest={to}"}]

    npx wrangler secret put TRAVEL_REFERRAL_ENABLED --name num-app   # 'true'
      # only needed for the EMAIL-QUOTE rail (agency quotes by hand).
      # The deep-link rail does not need it.

## Verify after switching on

    curl -s -X POST https://app.itsnum.com/api/flights/handoff \
      -H 'Content-Type: application/json' \
      -d '{"fromCode":"DXB","toCode":"LHR","depart":"2026-10-14","adults":1,"price":"305.45","currency":"USD"}'

Expect: available true, a prefilled URL carrying partner_id and ref_id, and
the fee sentence. Then click it for real, book nothing, and confirm with
Tina that the ref_id landed on their side. That handshake is the whole
integration — if their ledger does not echo our ref, reconciliation is
guesswork.

    npx wrangler d1 execute num-db --remote \
      --command "SELECT ref, product, state, created_at FROM num_travel_referrals ORDER BY created_at DESC LIMIT 5"

## Rollback

    npx wrangler secret delete LGT_PARTNER_ID --name num-app

Everything reverts to "No booking partner is configured." and the button
stops rendering. No data is lost; referral rows stay.

## Money, on their own $305.45 example

    1.5%        -> $4.58   (p6 partner dashboard)
    +$10 flat   -> $10.00  (p4 profit flow)
    $15/pax     -> $15.00  (p10 admin rules)
    spread $10.42 on one booking
    Stripe 4.5% gateway on that booking: $13.75

If gateway comes out of our share, the bottom reading loses money. That is
why the baseline question matters more than the rate question.

## Known gap, not blocking

`worker/index.mjs:305` calls `flightLink(env, {})` with no route — so a
flight link offered mid-conversation lands on a blank search even when the
concierge knows the city and dates. The fares-tray button is fully
prefilled; only the chat-turn link is bare. Worth fixing once traffic
exists to justify it.
