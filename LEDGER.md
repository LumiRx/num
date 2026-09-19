# NUM — MASTER LEDGER

**GENERATED FILE. Do not edit it — your changes are erased on the next build.**

Add to the ledger instead, and it appears here:

```
npm run ledger:add -- --who dre --area "host console" --state in-flight --note "tabs, not eleven cards"
```

_Built 2026-09-19 19:46 UTC from 43 entries._

## Deployed right now

Read from what each worker actually bundles, not from anyone's memory.

| Worker | State |
|---|---|
| num-console | 🟢 up to date (2026-09-19 01:37) |
| num-app | 🔴 **STALE** — 1 file changed since it shipped |
| num-growth | 🟢 up to date (2026-09-19 19:34) |
| num-ai | ⚪ never recorded from this machine |
| num-accounts | 🟢 up to date (2026-09-19 19:45) |
| num-payouts | ⚪ never recorded from this machine |
| num-claim | ⚪ never recorded from this machine |
| num-agents | 🟢 up to date (2026-09-17 19:40) |
| num-scout | ⚪ never recorded from this machine |

## Blocked

- 🔴 **expert docs migration 0030** — num_expert_docs does not exist in production. Unblocked by: npx wrangler d1 execute num-db --remote --file=worker/migrations/0030_expert_docs.sql
  _claude, 2026-09-15 16:32_

## In flight

- 🟡 **bill photo** — worker/billphoto.mjs - staff photograph the paper bill and the total fills the Amount box. The Thailand path: Ocha/FoodStory/StoreHub have no public API and a large share of Thai restaurants run on a paper slip, so growth/pos can never help them. THE MODEL PROPOSES, STAFF CONFIRM, THE GUEST NEVER SETS THE AMOUNT - nothing here mints a code; that is still the button a human presses, because billqr.mjs's case that a venue cannot under-report rests on a person being accountable for the figure. A read below MIN_CONFIDENCE (0.75) is refused rather than shown, because staff typing four digits is never wrong. Currency comes from num_business_profiles, never the photograph (a slip reading 2,400 in Phuket is baht; a model calling it dollars multiplies the bill by 35). The photograph is NEVER stored - only the raw answer, confidence and a SHA-256, because a restaurant bill can carry a guest's name and a card's last four. Staff's typed figure wins over the model's and the difference is recorded in the corrected column, which over a few hundred bills is the only honest measure of whether this beats typing. Anthropic vision via the same pattern as growth/fleetvision.mjs. Console: 'Photograph the bill instead' on the tables page, back camera via capture=environment, downscaled to 1600px in the browser before upload (restaurant wifi). Routes /api/venue/bill/photo + /confirm, bill permission. Migration 0041 (num_bill_proposals) PENDING. features.mjs: billphoto. 6,252 tests green. NOT SHIPPED. Needs 0041 run and ANTHROPIC_API_KEY on num-growth.
  _claude, 2026-09-18 18:29_
- 🟡 **business comms** — A business could not reach us. Invitations carried Reply-To: info@thatislumi.com - another company's domain, one person's mailbox - so no reply from a venue has ever entered this system. Hugo's arrived as a screenshot. The funnel says why it matters: 3,538 invited, 668 opened, 77 clicked, 9 filled the form, 4 started verification, 2 verified. Built: bizthread.mjs (a thread per contact, every message both ways, matched by reply+<key>@itsnum.com then headers then From, and the record says WHICH be
  _claude, 2026-09-19 00:52_
- 🟡 **business onboarding** — Hugo's Restaurant (4 LA sites) answered an invite and named four holes. (1) The claim form's submit handler refused every claim with <7 digits of phone, under a label reading (optional), against a server that accepts phone OR email — the mobile requirement was removed on 15 Sep in the label and the server and never in the validator, and the test that said 'the form no longer demands a mobile number' was checking the required attribute on a novalidate form. Now a four-way question: sms / email / 
  _claude, 2026-09-18 22:40_
- 🟡 **clover and autopay** — Clover adapter + capped auto-pay. growth/pos/clover.mjs: the second till, and the one that proves the registry earns its keep - Clover disagrees with Square about everything (GET+query vs POST+filter, an external tender id you must look up per merchant vs a first-class EXTERNAL source, total-minus-payments vs net_amount_due_money) and none of it escapes the adapter. v2 OAuth with expiring access AND refresh tokens, unix expiries converted to ISO. pickTender NEVER falls back to cash - a NUM payme
  _claude, 2026-09-18 18:39_
- 🟡 **mobile venues** — Hugo's answered: Resy on the two restaurants, nothing on the tacos. RESY IS PARTNERSHIP-ONLY - no self-serve developer portal, integration restricted to approved partners, and their own integrations page lists 'Reservations & Discovery' as a category alongside Google, MICHELIN, Meta and The Infatuation, which is exactly what NUM is. That is the door. The private endpoints people reverse-engineer are not an option and would end the partnership. Also removed the invented seats/date query params fr
  _claude, 2026-09-19 16:48_
- 🟡 **num-expert-kit** — worker/scoutkit.mjs: three print-ready sheets per Expert at /api/scouts/kit?code=CODE — business one-pager, counter cards 4-up, pitch+objections card. Personalised: every sheet carries the Expert's code and a QR of itsnum.com/s/CODE drawn by worker/qr.mjs. Verified by decoding a render: 28.7mm on A4, resolves correctly. Prices copied verbatim from public/flyers/business; sample answer names no real venue (the live flyer names three — flagged to Dre). Linked from the dashboard. 15 tests.
  _claude, 2026-09-18 04:19_
- 🟡 **num-expert-leads** — 0036 num_scout_leads: an Expert can add a shop they found themselves and work it. A lead earns nothing, spends no cap and reserves nothing — promoteLead() calls the same introduce() so the cap and first-come still apply, asserted by test. Dashboard counts leads beside businesses, never inside them. Add form and state list on /scout/. 19 lead tests, 5915 suite green.
  _claude, 2026-09-18 07:04_
- 🟡 **num-expert-paperwork-desk** — FOUND: isAdmin is (env, req) but expertdocs.mjs:331 and scouts.mjs:798 called it (request, env) — env.ADMIN_KEY read off a Request is undefined, so both returned false for EVERY caller since they shipped. /api/expert-docs/review was unreachable, meaning no NDA or W-9 could ever be accepted and no Expert could ever become payable; /api/scouts/admin fell through to 404 so it read as 'not found' not 'not allowed'. Both fixed, plus worker/adminargs.test.mjs which greps every call site and demonstrat
  _claude, 2026-09-18 06:27_
- 🟡 **num-expert-referrals** — 0032: referred_by_scout_id + referred_by_note on num_scouts, referrer stamped on each place, num_scout_earnings kind widened for referrer_override (safe: 0 rows today). One level only, asserted by test. Smart fields: server tidies name/email/phone (reuses claim/verify normalisePhone), /who confirms a referrer code live, /hello prefills country. 204 scout tests pass. NOT SHIPPED — another session has uncommitted work in this worktree.
  _claude, 2026-09-18 04:06_
- 🟡 **num-expert-wallet** — 0034: num_scout_milestones (UNIQUE scout_id+key = awarded once ever) and the last free widening of earnings kind for 'milestone'. scoutmilestones.mjs: six milestones, every bonus_cents 0 — recognition now, cash is one number later. Milestones count 'activated' (real revenue), never signatures. nextGate names the venue closest to its gate and what it still needs. Wallet on the dashboard says what is blocking payment instead of letting 'earned' read as 'arriving Friday'. 17 tests, 5800 green.
  _claude, 2026-09-18 05:07_
- 🟡 **qr bill pay** — Unblocked npm test for everyone, and clearing the gate showed what it had been hiding. coverage-claims runs BEFORE any test and was aborting the whole suite. Another session had fixed three of the four stale claims; the last was public/guides/index.html saying 'across 77 destinations' against a list of 106. I checked what 77 meant before changing it - the sentence is about the DIRECTORY, not about how many guides exist (there are none yet besides the index), so 106 is right. Its place count was 
  _claude, 2026-09-19 19:46_
- 🟡 **qr pay rails** — worker/payrails.mjs: every approved way to pay a bill, decided by venue country, ordered by guest device/language/phone; four tests as data (instant, own device, refundable, not financing); crypto HELD for TH (CRYPTO_HELD) per Dre 17 Sep. worker/billpay.mjs: Stripe Checkout as a DIRECT charge on the venue's own connected account with NUM's application fee (10% verified booking / flat floor) — GET /api/bill/<token> + /checkout, POST /api/pay/webhook/connect settles via settleBillCode and markPaid
  _claude, 2026-09-18 06:34_
- 🟡 **wallets and till** — Privy member wallets + Square POS adapter. worker/privy.mjs: a Base wallet pregenerated from the phone number NUM already verified, idempotent on member id, four rules asserted in tests — NUM never holds the key, never funds it (a test fails if a fund/buy/transfer export appears), Stars and USDC are never one number, only a phone-verified member gets one. Read-only usdcBalance via eth_call returns null not 0 when the chain is unreachable. createBillPolicy scopes a Privy policy to one venue addre
  _claude, 2026-09-18 07:44_

## Live

- 🟢 **client file** — 0038: likes, dislikes, interests, dietary, access_needs, company, birthday, portal_trips on num_host_clients; num_client_events; invoiced_at/paid_at/invoice_ref on num_host_requests (no invoices table - a confirmed request already is the line). GET+POST /api/host/client and /api/host/client-import (.ics, re-import updates on UID rather than doubling). Console: a file per client with its own tabs. /my-host/ now shows their diary and NAMES the new fields in 'what they can see'. 36 tests.
  _claude, 2026-09-18 07:31_
- 🟢 **deploy drift guard** — npm run deploy:check. Hashes what each worker bundles against what it last shipped.
  _claude, 2026-09-15 16:32_
- 🟢 **first line** — 0.8.339: /api/num answers in two lines when asked; first line ~0.2s, answer unchanged; app shows it under the dots
  _claude, 2026-09-18 04:17_
- 🟢 **fleet from photographs** — 0037: identified_json+draft on num_assets, batch_id on photos, asset_id on products. fleet-upload (one image, raw body, sha256 dedupe, R2) then fleet-intake (Haiku vision groups photos of the same vehicle into one DRAFT asset, listing text written, plate kept private and scrubbed from client copy) then fleet-draft confirm/discard/product. Degrades to one draft per photo with no ANTHROPIC_API_KEY on num-growth - Dre must set that secret. Verified end to end in production and the probe rows remove
  _claude, 2026-09-18 07:31_
- 🟢 **fleet vision without a second key** — Dre: no second API key. num-growth gets the Workers AI binding instead (num-console already uses it for translation); fleetvision prefers ANTHROPIC_API_KEY when set and falls back, so setting that secret later upgrades the reader with no code change. MEASURED, NOT ASSUMED, against five real stills from our own Pexels stock through the live endpoint. First version invented things: a cove with no boat in it came back 'a blue yacht on the water', and a Lisbon tram numbered 559 came back make 'volvo
  _claude, 2026-09-19 00:54_
- 🟢 **health** — 0.8.337: held alerts are deferred, not blind — the 503/DOWN loop since 3 Sep is closed; 0.8.334-336 finally live
  _claude, 2026-09-18 03:28_
- 🟢 **Hollywood retrieval** — Named neighbourhood now beats a coarse IP guess; never-empty floor under nearbyPlaces. Live on num-ai and num-app (v0.8.309).
  _claude, 2026-09-15 16:32_
- 🟢 **host console** — Tabs (Today/Clients/Work/Fleet/Products/Network/Money/Settings) built additively over the existing 1,500-line console JS; host identity fields editable; client country+languages; fleet country+notes.
  _claude, 2026-09-18 07:31_
- 🟢 **host launch check** — Signed up as a real host through the live form and opened the console in a browser, desktop and phone. Found and fixed: the Fleet tab opened on somebody else's suppliers because the tab module renders in DOM order; EVERY .price block in the console was centring its text because shared site.css styles .price as a centred pricing box and the console's own rule never reset text-align; a new host landed on eight empty tabs with no next step, so Today now carries a three-step START HERE that reads it
  _claude, 2026-09-19 01:38_
- 🟢 **host search** — GET /api/host/find: one question across hosts, their listable assets and their areas. Ranked connection > service > place > has-inventory. LIKE wildcards escaped. No email, no phone, no registration - assets go through clientView. 21 tests.
  _claude, 2026-09-18 07:31_
- 🟢 **host system audit** — Pre-launch double-check found four. TWO WERE HOLES I OPENED: a draft could be made listable (intake approves the host's own uploads, which satisfied the only gate - a model's guess would have reached a booker unread; now refused with still_a_draft) and every host saw every other host's unfiled uploads in their photo queue and could attach one to their own boat (the queue's 'supplier_id IS NULL' arm meant 'a text we could not place' until uploads also arrived with no supplier; now scoped to own u
  _claude, 2026-09-18 07:43_
- 🟢 **num-expert-programme** — 0.8.345 carried the isAdmin fix and the paperwork desk. Verified live: desk, queue and file all 403 unauthenticated and leak no name, email or object key. Also fixed the business leave-behind, which recommended Catch, Bimi and Siam Supper Club and advertised an offer at Bang Tao Bar — none of the four are in businesses, claims or num_place_owners, ie real venues that never signed up, on our own paper. Generic now and deployed. app-preview still names Catch Beach Club in three places; left for a 
  _claude, 2026-09-18 06:35_
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

