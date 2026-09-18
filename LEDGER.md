# NUM — MASTER LEDGER

**GENERATED FILE. Do not edit it — your changes are erased on the next build.**

Add to the ledger instead, and it appears here:

```
npm run ledger:add -- --who dre --area "host console" --state in-flight --note "tabs, not eleven cards"
```

_Built 2026-09-18 06:34 UTC from 20 entries._

## Deployed right now

Read from what each worker actually bundles, not from anyone's memory.

| Worker | State |
|---|---|
| num-console | ⚪ never recorded from this machine |
| num-app | 🔴 **STALE** — 1 file changed since it shipped |
| num-growth | ⚪ never recorded from this machine |
| num-ai | ⚪ never recorded from this machine |
| num-accounts | 🟢 up to date (2026-09-17 04:51) |
| num-payouts | ⚪ never recorded from this machine |
| num-claim | ⚪ never recorded from this machine |
| num-agents | 🟢 up to date (2026-09-17 19:40) |
| num-scout | ⚪ never recorded from this machine |

## Blocked

- 🔴 **expert docs migration 0030** — num_expert_docs does not exist in production. Unblocked by: npx wrangler d1 execute num-db --remote --file=worker/migrations/0030_expert_docs.sql
  _claude, 2026-09-15 16:32_

## In flight

- 🟡 **num-expert-kit** — worker/scoutkit.mjs: three print-ready sheets per Expert at /api/scouts/kit?code=CODE — business one-pager, counter cards 4-up, pitch+objections card. Personalised: every sheet carries the Expert's code and a QR of itsnum.com/s/CODE drawn by worker/qr.mjs. Verified by decoding a render: 28.7mm on A4, resolves correctly. Prices copied verbatim from public/flyers/business; sample answer names no real venue (the live flyer names three — flagged to Dre). Linked from the dashboard. 15 tests.
  _claude, 2026-09-18 04:19_
- 🟡 **num-expert-paperwork-desk** — FOUND: isAdmin is (env, req) but expertdocs.mjs:331 and scouts.mjs:798 called it (request, env) — env.ADMIN_KEY read off a Request is undefined, so both returned false for EVERY caller since they shipped. /api/expert-docs/review was unreachable, meaning no NDA or W-9 could ever be accepted and no Expert could ever become payable; /api/scouts/admin fell through to 404 so it read as 'not found' not 'not allowed'. Both fixed, plus worker/adminargs.test.mjs which greps every call site and demonstrat
  _claude, 2026-09-18 06:27_
- 🟡 **num-expert-referrals** — 0032: referred_by_scout_id + referred_by_note on num_scouts, referrer stamped on each place, num_scout_earnings kind widened for referrer_override (safe: 0 rows today). One level only, asserted by test. Smart fields: server tidies name/email/phone (reuses claim/verify normalisePhone), /who confirms a referrer code live, /hello prefills country. 204 scout tests pass. NOT SHIPPED — another session has uncommitted work in this worktree.
  _claude, 2026-09-18 04:06_
- 🟡 **num-expert-wallet** — 0034: num_scout_milestones (UNIQUE scout_id+key = awarded once ever) and the last free widening of earnings kind for 'milestone'. scoutmilestones.mjs: six milestones, every bonus_cents 0 — recognition now, cash is one number later. Milestones count 'activated' (real revenue), never signatures. nextGate names the venue closest to its gate and what it still needs. Wallet on the dashboard says what is blocking payment instead of letting 'earned' read as 'arriving Friday'. 17 tests, 5800 green.
  _claude, 2026-09-18 05:07_
- 🟡 **qr pay rails** — worker/payrails.mjs: every approved way to pay a bill, decided by venue country, ordered by guest device/language/phone; four tests as data (instant, own device, refundable, not financing); crypto HELD for TH (CRYPTO_HELD) per Dre 17 Sep. worker/billpay.mjs: Stripe Checkout as a DIRECT charge on the venue's own connected account with NUM's application fee (10% verified booking / flat floor) — GET /api/bill/<token> + /checkout, POST /api/pay/webhook/connect settles via settleBillCode and markPaid
  _claude, 2026-09-18 06:34_

## Live

- 🟢 **deploy drift guard** — npm run deploy:check. Hashes what each worker bundles against what it last shipped.
  _claude, 2026-09-15 16:32_
- 🟢 **first line** — 0.8.339: /api/num answers in two lines when asked; first line ~0.2s, answer unchanged; app shows it under the dots
  _claude, 2026-09-18 04:17_
- 🟢 **health** — 0.8.337: held alerts are deferred, not blind — the 503/DOWN loop since 3 Sep is closed; 0.8.334-336 finally live
  _claude, 2026-09-18 03:28_
- 🟢 **Hollywood retrieval** — Named neighbourhood now beats a coarse IP guess; never-empty floor under nearbyPlaces. Live on num-ai and num-app (v0.8.309).
  _claude, 2026-09-15 16:32_
- 🟢 **num-expert-programme** — Verified end to end on 0.8.344: sign-up + referrer code check, /s/CODE card pages, /claim/?scout= carrying the code, the kit on all three sheets, wallet and milestones, and the in-app ?me= path. Proved attribution by introducing a throwaway place against ZM3CEN — place row created, first_intro milestone auto-awarded with bonus 0 and no earnings row, gate showed needs 500 to release 500 — then deleted both and confirmed the dashboard back to empty. Isaiah's duplicate WFBU77 merged into FARMER wit
  _claude, 2026-09-18 05:30_
- 🟢 **num-expert-signup** — itsnum.com/scout/ enrol form and dashboard were 404ing: page fetched /api/scouts on itsnum.com, which only num-app serves. Now points at app.itsnum.com (CORS already allowed). num-console redeployed 18 Sep. Zero self-enrolled scouts existed before this; Isaiah and Adam were inserted by hand.
  _claude, 2026-09-18 03:46_
- 🟢 **reactions** — 0.8.338: emoji reactions land in num_reactions with lane/brain/place; HOW THEY RATE THE ANSWERS panel on admin ACTIVITY tab
  _claude, 2026-09-18 04:17_
- 🟢 **social inbox** — /api/social/requests 500'd for every real member on a database where the events routes had never run — not the quote character STATUS blamed for two weeks; events.mjs now exports ensureEvents() and the inbox calls it. 16 tests in worker/socialrequests.test.mjs
  _claude, 2026-09-18 04:20_
- 🟢 **TODAY grid** — 0.8.345: audited all 12 doors against production; charter promises the relay it performs (num_assets empty), events asks what is on instead of opening the host form; scripts/featureaudit.mjs is the repeatable check
  _claude, 2026-09-18 06:33_

## Built, not deployed

- 🔵 **Num Expert card page** — Correcting my own earlier entry: dre is right, this is built but num-growth is not deployed, so /s/FARMER still 404s on itsnum.com.
  _claude, 2026-09-15 16:33_

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

