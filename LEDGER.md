# NUM — MASTER LEDGER

**GENERATED FILE. Do not edit it — your changes are erased on the next build.**

Add to the ledger instead, and it appears here:

```
npm run ledger:add -- --who dre --area "host console" --state in-flight --note "tabs, not eleven cards"
```

_Built 2026-09-21 19:29 UTC from 22 entries._

## Deployed right now

Read from what each worker actually bundles, not from anyone's memory.

| Worker | State |
|---|---|
| num-app | 🔴 **STALE** — 19 files changed since it shipped |
| num-growth | 🔴 **STALE** — 161 files changed since it shipped |
| num-ai | 🟢 up to date (2026-09-15 08:19) |
| num-accounts | ⚪ never recorded from this machine |
| num-payouts | ⚪ never recorded from this machine |
| num-claim | ⚪ never recorded from this machine |
| num-agents | ⚪ never recorded from this machine |
| num-scout | ⚪ never recorded from this machine |

## Blocked

- 🔴 **expert docs migration 0030** — num_expert_docs does not exist in production. Unblocked by: npx wrangler d1 execute num-db --remote --file=worker/migrations/0030_expert_docs.sql
  _claude, 2026-09-15 16:32_

## Live

- 🟢 **Hollywood retrieval** — Named neighbourhood now beats a coarse IP guess; never-empty floor under nearbyPlaces. Live on num-ai and num-app (v0.8.309).
  _claude, 2026-09-15 16:32_

## Built, not deployed

- 🔵 **answer quality** — Pool 6 to 24, partner id now in the block, pick why is a sentence not 12 words. Built, NOT deployed.
  _claude, 2026-09-15 18:05_
- 🔵 **bugs** — WelcomePlans and ShareToSheet rendered transparent, no glass-strong; both fixed, guard test added
  _claude, 2026-09-16 20:16_
- 🔵 **deploy drift guard** — Was blind to all 93 client files. npm run build ships them with num-app, so a client-only change read as up to date. Fixed + tested.
  _claude, 2026-09-16 03:38_
- 🔵 **desktop** — Desktop gets the app: 720 routing gate removed, launch stage moved to ?stage, content centred at 760px
  _claude, 2026-09-16 20:16_
- 🔵 **esim** — Text ESIM to buy (SMS + WhatsApp), /esim listing + every country + 4,079 airport pages, Stripe Checkout, eSIM Access fulfilment with auto-refund, concierge-by-text for buyers (off). 5,901 tests green. NOT deployed: needs ESIMACCESS_ACCESS_CODE, migration 0033, release.
  _claude, 2026-09-21 19:29_
- 🔵 **Num Expert card page** — Correcting my own earlier entry: dre is right, this is built but num-growth is not deployed, so /s/FARMER still 404s on itsnum.com.
  _claude, 2026-09-15 16:33_
- 🔵 **stars** — Welcome grant cut 100 to 5; rebalance SQL for the 94 written as ledgered welcome moves (Dre runs it)
  _claude, 2026-09-16 20:16_
- 🔵 **subscription checkout loop** — Confirmation after Stripe (nothing read ?paid=) and a cancel button (endpoint existed, nothing called it). Built, NOT deployed.
  _claude, 2026-09-16 05:02_
- 🔵 **subscription offer** — Post-signup plans sheet + asked-detection + iOS gate on all three doors. Built, NOT deployed.
  _claude, 2026-09-16 02:39_
- 🔵 **subscriptions** — Plans listed in the wallet buy section; PlanNudge added, waits for 3rd ask, never on iOS
  _claude, 2026-09-16 20:16_

## Decisions

- 📌 **esim pricing** — Price = break-even after card fees + thin cushion (10%, min 25c), capped under supplier retail. Never below cost unless ESIM_MAX_LOSS_CS is set. No 'cheapest' claims in copy.
  _claude, 2026-09-21 19:29_

## Known gaps

- ⚪ **area name normalisation** — W Hollywood, N. Hollywood etc get their own centroid rows. ~28 places unmatchable. Not urgent.
  _claude, 2026-09-15 16:32_
- ⚪ **experts** — itsnum.com/api/* has never routed anywhere - the Expert signup form 404d silently since it was written; both Experts were seeded by SQL
  _claude, 2026-09-17 08:49_

---

## How this works

Everyone appends to their **own** file under `ledger/entries/`. Nobody edits
anybody else's, so two people working at once never collide — two appends to
two different files merge without a conflict. This board is rebuilt from all
of them, so it cannot drift out of step with what was actually recorded.

Nothing is ever edited or deleted. To change a state, add a new entry for the
same area; the old one stays in the history, which is the point.

