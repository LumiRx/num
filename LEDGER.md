# NUM — MASTER LEDGER

**GENERATED FILE. Do not edit it — your changes are erased on the next build.**

Add to the ledger instead, and it appears here:

```
npm run ledger:add -- --who dre --area "host console" --state in-flight --note "tabs, not eleven cards"
```

_Built 2026-09-16 05:02 UTC from 12 entries._

## Deployed right now

Read from what each worker actually bundles, not from anyone's memory.

| Worker | State |
|---|---|
| num-app | 🔴 **STALE** — 98 files changed since it shipped |
| num-growth | 🟢 up to date (2026-09-16 01:50) |
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
- 🔵 **deploy drift guard** — Was blind to all 93 client files. npm run build ships them with num-app, so a client-only change read as up to date. Fixed + tested.
  _claude, 2026-09-16 03:38_
- 🔵 **Num Expert card page** — Correcting my own earlier entry: dre is right, this is built but num-growth is not deployed, so /s/FARMER still 404s on itsnum.com.
  _claude, 2026-09-15 16:33_
- 🔵 **subscription checkout loop** — Confirmation after Stripe (nothing read ?paid=) and a cancel button (endpoint existed, nothing called it). Built, NOT deployed.
  _claude, 2026-09-16 05:02_
- 🔵 **subscription offer** — Post-signup plans sheet + asked-detection + iOS gate on all three doors. Built, NOT deployed.
  _claude, 2026-09-16 02:39_

## Known gaps

- ⚪ **area name normalisation** — W Hollywood, N. Hollywood etc get their own centroid rows. ~28 places unmatchable. Not urgent.
  _claude, 2026-09-15 16:32_

---

## How this works

Everyone appends to their **own** file under `ledger/entries/`. Nobody edits
anybody else's, so two people working at once never collide — two appends to
two different files merge without a conflict. This board is rebuilt from all
of them, so it cannot drift out of step with what was actually recorded.

Nothing is ever edited or deleted. To change a state, add a new entry for the
same area; the old one stays in the history, which is the point.

