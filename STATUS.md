# NUM — STATUS

The ledger. **Read this first in a fresh chat; do not re-read the codebase to
learn what is already known.** One screen of state, updated at the end of every
run. Detail lives in the project docs, not here.

_Last updated: 2026-09-12 · production **0.8.275 live and healthy** (health verdict ok, 0 failing)_

---

## Where things stand

| Area | State |
|---|---|
| App (num-app) | **0.8.275 live**, shipped 18:45 UTC 12 Sep. `/api/health` ok, 0 failing. `verify_5arz` now true from `FIVEARZ_API_KEY`, `google_auth` reported separately. |
| Growth (num-growth) | Deployed 12 Sep — host client book live. |
| Tests | 4,485 green, 0 lint errors, tsc clean |
| Release | `stage` then `ship`. Ship alone refuses; that guard is correct. |

## Live and working

- **Business side** — claim, promote-as-owner (`--owner`), sign-in links, SMS opt-in at signup, venue disclosures, add-to-home-screen prompt, stalled-claim queue and grant route.
- **Host side** — clients, requests (7 statuses), `.ics` calendar feed, products, host network, intros, messages, plan/billing, close account, integrity checker.
- **Host client book** (12 Sep) — `GET /api/host/book`: every client with their work folded in, whose move it is, days waiting, quiet clients, plus the next 30 days. Console shows "Your week" above the book.

## In flight

- **Luxury asset layer** (12 Sep) — WIRED END TO END, awaiting Dre's deploy. Migration `0021`
  applied in production (all four tables and both ALTERs verified live). R2 bucket
  `num-asset-photos` created and bound as `PHOTOS` on **both** `num-app` (writes: a photo arrives
  by text) and `num-growth` (reads: the console serves and moderates it). `worker/inboundmedia.mjs`
  is the ingest; `growth/hostassets.mjs` is the five endpoints (`/api/host/assets`,
  `asset-photo`, `asset-holds`, `asset-image`, `offerable`) plus the public `/p/asset/:id`;
  the Fleet card in `public/host/index.html` is the console. 4,336 tests green.

  **Two live bugs fixed on the way through.** `worker/sms.mjs` and `worker/whatsapp.mjs` both had
  `if (!text) return xmlOk()` — a photo sent with no caption was dropped before anything saw it,
  and Twilio recorded a 200. Every photo-only message either webhook has ever received was lost,
  silently, on both channels.

  **The regional limit, which decides how this is actually used.** Twilio receives inbound MMS in
  only a handful of regions and answers error 30011 elsewhere, so a supplier on a Thai or UK number
  cannot text a photo to an MMS number at all — **WhatsApp is the working door outside North
  America**, which is why it is wired too. Turning it on for suppliers is a config job
  (`WHATSAPP_ENABLED` + the Twilio sandbox or a WhatsApp sender), not a code one.

- **Supplier layer** (12 Sep) — BUILT, awaiting the same deploy. 0019 shipped eight tables and zero
  endpoints; `growth/hostsuppliers.mjs` is the missing half. `GET/POST /api/host/suppliers` (add,
  label, end, revive) and `GET /api/host/supplier-assets`, plus the Your suppliers card and an owner
  picker on the fleet form so a boat can actually be Marco's rather than the host's.

  **Migration 0022 puts a phone number on a supplier, and it is load-bearing.** Before it, inbound
  photo resolution depended on the supplier already being a NUM member with a matching verified
  number — which a marina manager in Phuket is not and never will be, so every photo he sent queued
  as `unknown_sender` forever. `resolveSupplier` now matches `num_suppliers.phone` first and falls
  back to the member join. A phone number is the entire onboarding: no app, no account.

  **An ownership hole closed on the way.** `owner_id` arrives in the request body, so a host could
  have named any supplier id at all — including a competitor's, who would then see a boat they had
  never heard of with that host's rate on it, and whose texted-in photo could auto-file against it.
  It is now checked against a live accepted link.

  **A CHECK caught a real bug**: `ended_by` is constrained to a role — `host`, `supplier`, `num` —
  and the first version wrote `host:h1`. It failed outright in test and would have failed in
  production identically.

  **Still to build:** the member-facing charter browse that consumes `/api/host/offerable`; Duffel
  for flights; a supplier-side page (today a supplier interacts entirely by text, which is the
  point, but there is nothing they can open).

- **Host job board** — `growth/hostjobs.mjs` shaping layer built and tested (30 tests). Routes, `num_host_jobs` table, member-facing section and console card still to build. Three product questions open, below.

## Notifications could not reach an iPhone at all — 13 Sep

What production said before any of this was built:

| | |
|---|---|
| Members | 148 |
| Web-push subscriptions | **2** |
| Notifications written (6 weeks, 42 people) | 117 |
| Ever **delivered** | **1** |
| Ever marked **read** | 0 — and `read_at` had no writer anywhere, so this was unknowable rather than true |
| Stored preferences | 2 rows |

And the worst of it, on the app that just cleared review: `src/lib/native.ts` asked for
notification permission, received an APNs token, and POSTed it to `/api/push/native` — **a route
with no handler**. The client's `catch` swallowed the 404. So every iPhone user who said yes had
that yes thrown away, and on iOS permission is close to one-shot: once declined it is very hard to
win back. There was no APNs or FCM sending code anywhere in the repo.

So the engine Dre asked for — auto suggestions catering to preferences — would have been a roof on
no walls: correct logic, reaching 2 people out of 148, with no way to tell whether anyone read it.

### What now exists

- **`worker/apns.mjs`** — sending to Apple, written against Apple's published specification rather
  than memory, because every mistake here fails silently. ES256 JWT signed with the `.p8`, **cached
  for 45 minutes** because Apple refuses more than one token update per 20 minutes and answers 429
  `TooManyProviderTokenUpdates` — minting per send would fail the whole batch. Correct `apns-topic`,
  `apns-push-type`, `apns-expiration`; **priority 5, not 10**, for anything proactive, because 10
  means "interrupt them now" and using it for everything is how an app earns a reputation for being
  rude. Payload trimmed to Apple's 4 KB by **bytes**, so Thai or emoji cannot smuggle it over.
- **Apple's retry rules followed exactly.** `Unregistered`, `ExpiredToken`, `BadDeviceToken` and
  `DeviceTokenNotForTopic` disable the token with Apple's own reason on it; 429 and 5xx back off
  (15 minutes for 5xx, as Apple asks); a stale provider token clears the cache so the *next* send in
  the batch succeeds instead of the whole run failing behind one expired JWT.
- **`/api/push/native`** — the handler that did not exist. Upserts on the token, so a reinstall
  updates its row rather than adding a second (two rows means every notification arrives twice,
  which is worse than not arriving), and revives a token we had disabled.
- **`/api/push/read`** — `read_at` finally has a writer, plus `acted_at` for a tap. **Acted is the
  only number that says a notification earned its interruption**, and it is the one worth sending
  more on.
- **Both clients close the loop.** The service worker reports what it showed and what was tapped;
  the native app now has `pushNotificationActionPerformed` (it had none, so a tap opened the home
  screen and the suggestion was lost) and refuses any push url that is not same-origin.
- **`notifyAll()`** replaces `notify()` for new work and logs **NOBODY REACHED** when a send
  reaches zero devices. That line is the whole lesson of the 117.

### The limits, in the schema rather than in code

`num_notify_prefs` carries `enabled`, `quiet_from`/`quiet_to` in the member's own `tz`, a
`paused_until` date that expires by itself, and a **`weekly_cap` defaulting to 3** for everything
proactive combined. That number is the difference between a concierge and a marketing list, and it
lives in one place so no future feature can add "just one more kind" of message without either
fitting the budget or visibly raising it.

`num_notify_log` records **suppressions as well as sends, with a reason required by CHECK** — "why
did NUM not tell me about that" is a question a real member asks. `num_taste` separates `stated`
from `observed` and requires a confidence on a guess, so a suggestion built on inference can be
phrased less confidently than one built on their own words.

`worker/nudge.mjs` already said the principle out loud in August: *"No 'haven't seen you in a
while', no engagement bait, ever. The moment a nudge exists to serve us instead of them, this file
is a growth-hacking tool wearing a concierge's clothes."* The schema above is that sentence given
teeth.

### Needed from Apple before any of it sends

Four secrets. Until they are set, tokens are stored and `sendable: false` is returned honestly
rather than a bare ok: `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`.

### Still to build

The preference-capture screen, and the suggestion engine itself. Both are better built once a
notification can be watched arriving — the engine's whole quality bar is `acted_at`, and that number
does not exist yet.

## Empty is not broken — the habit that cost 12 Sep

`.catch(() => ({ results: [] }))` on a list query is the single most expensive habit in this
codebase. It turns a schema problem into a blank page and a 200 OK. Three separate failures on
12 Sep were all this shape, and a fourth was waiting:

- `/api/host/requests` answered 500 for **weeks** because `booking_fee_minor` was missing. The POSTs
  kept working, so "Log it" looked merely unloved.
- `resolveSupplier` selected a column added by an ALTER. Had that ALTER ever been missing, **every
  supplier would have become an unknown sender** and every texted photo would have queued forever.
- `/api/host/suppliers` shipped ahead of 0022 and the supplier list swallowed `no such column: phone`
  into an empty array — a live card, reporting success, that could never show a supplier or accept
  one.
- **The worst one, never hit:** the double-booking clash check read the existing holds through the
  same silent catch. A failed query gave an empty list, the overlap loop found nothing to clash
  with, and **the second booking on the same hull went through.** A guest on a quay watching
  somebody else board their boat was one dropped query away.

`growth/readfail.mjs` is the fix. `rows(query, what)` lets an empty result be empty and makes a
failed query throw, named. Handlers answer **503** with `error: read_failed`, the real SQLite
message, and a sentence that tells a host it is not their fault and tells whoever investigates to
check migrations first. The console already hides a card on 503.

The clash check **fails closed**: if we cannot read the calendar we do not know whether the hull is
free, and "I do not know" is never answered as "yes". `growth/readfail.test.mjs` proves it by
dropping the holds table and asserting the booking is refused.

`growth/readfail.test.mjs` also greps both handler files for the bare pattern, so the habit cannot
come back one line at a time.

## Migrations are sealed — the guard for the booking_fee_minor class

How `booking_fee_minor` actually went missing, stated exactly, because the obvious explanation is
the wrong one: 0014 created `num_host_requests` and was applied. Later somebody **edited 0014** to
add the column. Re-running it then did nothing, because the table existed and the statement is
`IF NOT EXISTS` — so the column reached every fresh database and no live one. `/api/host/requests`
answered 500 for weeks while every test passed and every POST to the same endpoint succeeded.

No amount of reading the SQL finds that. The file is correct. The problem is that it changed after
it had been applied.

So applied migrations are now **sealed by content hash** in `worker/migrations/APPLIED.json`, and
`worker/migrationhygiene.test.mjs` fails if a sealed file changes. The failure message says what to
do: add a new migration with an ALTER. `scripts/apply-host-migrations.mjs` seals a file after a
successful **remote** apply (never `--local` — a local database is not production), and `--seal`
re-seals an already-applied file for the one legitimate edit, a comment or a typo in prose. It
deliberately refuses to seal a migration that has never been applied: that would protect a hash
production has never seen, and lock the file before anyone could fix it.

The same file also checks, across every **registered** migration rather than four named ones, that
no semicolon hides in a comment, that every ALTER is its own statement, and that no `.sql` file sits
in the folder with nothing applying it.

## The console/API split — a live break on 12 Sep, and the guard for it

`public/host/index.html` ships from **num-console**. Every endpoint it calls ships from
**num-growth**. Two workers, two deploys, so one can go out alone — and on 12 Sep one did: the
Fleet card was live on itsnum.com while `/api/host/assets` answered 404. A host opening their
console found a section where every button did nothing.

**No test can catch this.** The code was correct in both workers; only one of them was deployed.
The live site is the only thing that knows.

Two guards now exist:

1. **`scripts/console-api-agree.mjs`** — reads the LIVE console, extracts every endpoint it calls,
   and asks the live API about each one. A 404 fails the deploy. It retries a 404 as POST, because
   several host endpoints are POST-only and reporting those as missing is how a check earns a
   reputation for crying wolf and gets switched off. Wired into `scripts/deploy-host-system.sh`.
   Run it any time: `node scripts/console-api-agree.mjs`.
2. **The Fleet card takes itself off the page** when its endpoints answer 404 or 503. A section
   that is absent says "not ready yet"; a section of dead buttons says the product is broken.

If you deploy by hand, deploy **both** or run the script. `npx wrangler deploy` alone ships the
console without its API.

## The Friday pack draw — LIVE as of 13 Sep 2026

Ten sealed Pokémon packs a week, **ten winners, one each**. Dre bought the packs 12 Sep.

| Piece | Where | State |
|---|---|---|
| Entry code `PACKS` | `worker/packdraw.mjs` → num-app | **live** (0.8.287) |
| Card-shop search | `worker/cardshops.mjs` → num-app | **live** |
| Official Rules | `growth/fridayrules.mjs` → num-growth | **live**, itsnum.com/friday-rules returns 200 |
| The draw itself | `growth/fridaydraw.mjs` | built, tested — **NO ROUTE OR BUTTON. Cannot be run.** |

- **Entry is opt-in.** A member sends Num the single word `PACKS`. The message must BE the code, so
  "where can I buy packs" still reaches the card-shop search. One entry per member per week, enforced
  by the primary key. Checked BEFORE the brain — a model asked "PACKS" answers plausibly and the entry
  is silently never recorded, which is the worst outcome because the member believes they entered.
- **The draw is reproducible.** Seeded, recorded, sorted before shuffling; same seed and same entrants
  give the same ten winners forever. No `Math.random` — a test pins that.
- **Eligibility cannot be checked at draw time.** `num_members` has no country and no age; `dest` is
  where somebody is TRAVELLING, not where they live. Filtering on it would look like enforcement and
  be wrong about most people. So 18+/US-UK is verified AT CLAIM, with a clean forfeit-and-redraw.
- **Thailand is excluded and the page says why.** Thai law requires a Gambling Act s.8 licence for
  prize draws INCLUDING free-entry ones — 15+ working days, up to a year's imprisonment. A one-year
  licence is ~฿9,000 (~$275) if Thailand is wanted in.
- **Trademark:** genuine sealed product bought at retail (keep the receipts — that is the first-sale
  position), no logos or artwork anywhere, disclaimer on the page and on both social graphics.

**Not done:** the draw has no way to be run. It is a function with no route and no button.

## A HANDLER IS NOT A ROUTE — the third time, 12 Sep

`/friday-rules` was written, wired into the growth worker, tested and **successfully deployed** — and
still returned 404, because no pattern in `growth/wrangler.jsonc` sends that path to num-growth.
`itsnum.com` is served by several workers and the growth one only receives the paths listed there.

The same omission had already shipped **`/api/pay/*`** broken for weeks (every merchant pay QR
resolving to the site's 404 page instead of an image) and **`/p/*`** broken until 22 Aug (guests
getting a 404 instead of a payment screen). Both are recorded in comments in that file. There is now
a test asserting the rules page has a route, not just a handler.

**Rule: code and secrets take effect on deploy; ROUTE PATTERNS are configuration and only change when
the deploy carries the config.** That is why the entry code went live and the page did not.

## Open decisions (Dre's, not mine)

0. **Legal review before the first real charter settles.** Dre chose "NUM collects and settles,
   no commission" for luxury assets on 12 Sep. Zero commission keeps NUM a conduit rather than a
   broker taking a spread, which helps — but collecting £200k for a yacht week is not collecting
   £80 for dinner. Needs somebody qualified on money transmission / safeguarding and on whether
   arranging air charter triggers broker rules, **before** the first settlement, not after.

1. **Does offering on a job cost a host anything?** Free fills the board with speculative offers; priced suppresses the hosts with the emptiest weeks, who are who it should help.
2. **How many hosts may offer on one job?** Unlimited is a bad read for the member. Three is my recommendation.
3. **Should the concierge post to the board itself** when no listed business covers a request? Strongest version of the feature; needs an explicit "shall I ask a local host?" rather than silent posting.

## 5arz integration — what is already there, and the two rules

NUM is a **wholly-owned subsidiary of 5arz**, and its stated strategic purpose is to be the
top-of-funnel: it collects users and signal for 5arz. Relevant to the host job board:

- **`mcp.5arz.com` already does agent-to-human binding.** It is revenue surface #3 in the 5arz
  context brief — "binding an AI agent to a verified present human". The board does not need a new
  primitive; it needs to be the first real consumer of one that exists.
- **24 agents registered, 18 activated, 0 paid — and all 24 are 5arz's own test agents.** No
  external party has ever paid for a binding. NUM would be the first, which is the opportunity and
  also the reason to expect rough edges in the interface.
- **C2 (active member → consents to verification) is 1.35% and needs to be 20%.** A host being
  chosen by a stranger is the highest-intent moment NUM has ever had to ask for verification.

**Two hard rules, both from 5arz's own risk register:**

1. **Verify PoHF against the live JWKS (oracle-2). Never `hmac-v0`.** Their exec review is explicit:
   a symmetric key means *every verifier can forge a credential*. A NUM that verified over the
   symmetric path would be a forgeable verifier of its own parent's product.
2. **Every Num→5arz transfer needs a replayable, revocable consent receipt** with a
   buyer-propagation window. Their words: the only failure mode that is *instantly fatal and
   non-recoverable*. Posting a member's task into 5arz is such a transfer.

**Fixed 12 Sep:** `/api/version` used to report `verify_5arz` from `!!env.GOOGLE_CLIENT_ID`. It now
reports `google_auth` separately and `verify_5arz` from `!!env.FIVEARZ_API_KEY`.

**`growth/fivearz.mjs`** verifies a Proof-of-Personhood credential. The rule that shapes it:
**sandbox credentials are signed by the production key and verify** — and a sandbox key comes from
an unauthenticated endpoint. So `test:true` / `sample:true` are checked LAST, after everything else
has passed, and are what decide whether the badge means anything. ES256 only; `alg:none` and HMAC
refused before a key is fetched. `unique_human` never read; `liveness` surfaced only as
`liveness_claimed`. **39 tests.** Secret required: `FIVEARZ_API_KEY` on the growth worker.

### Proven against live production, 12 Sep — S3 is CLOSED

`POST /api/agents/verify-personhood` **returns 200 with `ok:true` and a valid signature.** The 4 Sep
fix is live; the 10 Aug–4 Sep 500s are over. Run with a throwaway sandbox key minted for the probe
(`agt_lc6bpc7wfir2`) because the real key lives only in a Worker secret and cannot be read back.

Three things the run corrected, each of which had been silently wrong:

1. **The response field is `pop_jwt`.** Not `credential`/`jwt`/`token` (our guess) and not
   `jwt`/`pohf_jwt` (the 5arz handoff's own documentation). Reading the wrong field returned
   `ok:true` with `credential:null` — a pass with nothing to verify. Also present:
   `attestationId`, and a top-level `testMode`.
2. **There is no `sub` claim at all.** The verifier read `p.sub`, so every verification reported
   `subject:null`. The real field is `sub_hash` (SHA-256 of the member id) — which is also the
   right thing to store, since it is pseudonymous.
3. **`env` is a third sandbox marker.** A sandbox credential carries `env:"test"`; the public
   sample carries `env:"sample"`. Rejected when present and not `production` — not required
   outright, because we have never seen a live credential and do not know whether it sets the
   field. `test`/`sample` remain the gates that decide.

Live payload, for the record: `id_verified:true`, `liveness:true`, `sybil_checked:false`,
`method:"stripe_identity+bio_bridge"`, `assurance:"direct_document_liveness"`, 90-day `exp`,
no `unique_human`, no `verified`.

Also closed from the handoff's verifier list: explicit `User-Agent` on the JWKS fetch (their edge
403'd a default one), one rate-limited refetch on an unknown `kid` so a key rotation is picked up
without a deploy, `jti` returned so a consent receipt can be revoked, and `verified` handled as a
bare literal alongside `liveness`.

### S7 — the `LEDGER` binding: what it actually is

`wrangler.app.jsonc` binds **`LEDGER` → `5arz-ledger`** (`479dfff2-…`) on num-app. Read in full
on 12 Sep, so the picture is now exact rather than inherited:

- **Nothing writes to it.** Every statement across `worker/` and `growth/` is a `SELECT`; scanned
  for INSERT/UPDATE/DELETE/ALTER/DROP and there are none. The *capability* is still full write,
  because a D1 binding has no read-only mode — that is the standing risk, not a current act.
- **Two consumers, not one.** `worker/air.mjs` (the trust envelope) and `worker/social.mjs`
  (`POST /verify/5arz`, the member-facing identity link). Removing the binding today would
  **503 a live feature** — 2 of our 147 members are linked through it. That is why this has sat
  as decision #1 for eight days: it needs replace-then-remove, not remove.
- **The handoff's "no auth" is not quite right.** `/verify/5arz` validates a Google ID token with
  Google and checks the audience, so the *person* is authenticated. What is missing is
  authorisation from 5arz (we read their database directly, bypassing their API, rate limits and
  audit) and a consent receipt. Those are the real gaps.

**Fixed 12 Sep, and it was both a security hole and a bug that had never worked:** `trustEnvelope`
bound the caller-supplied `memberId` straight into `5arz-ledger.members WHERE id=?1`.
A Num member id and a 5arz member id are **different namespaces that both start `mem_`** — ours is
`mem_`+20 hex (or legacy `v5_…`), theirs is `mem_`+12. Verified in production: of 147 members the 2
who are genuinely 5arz-verified both have a 5arz id **not equal** to their Num id, so that lookup
had never matched for anybody, and the envelope told AiR "no id_check" for the two people who had
completed one. Meanwhile `GET /api/trust?member=` is reachable by any holder of `AIR_SHARED_KEY`,
so a partner could put a **5arz** member id in the query string and read that member's verification
state, country and session scores out of our parent's database. The 5arz id is now read from the
link *we* stored during the consented `/verify/5arz` flow and never from input, which enforces
their hard rule and closes the oracle. Side effect: the 145 unlinked members no longer issue three
cross-company reads that could never have returned anything, so the common path got faster.

## Rate card — settled 12 Sep 2026

Checked against the market rather than argued. PayPal takes 2.29%–3.49% — but that is the price of
**moving money**, and NUM never holds it. For what NUM actually does (sending a guest who spends),
the category is DoorDash/Uber Eats 15–30%, Grubhub 10–25%, Expedia 15–30%, Booking.com ~15%,
Airbnb ~15.5%, OpenTable $1–1.50/cover **plus** $149–499/month. **10% is the floor, not a high rate.**

| What happened | Charge |
|---|---|
| Num sent the guest, bill visible | 10% restaurants/bars · **15% hotels** |
| Num sent the guest, bill not visible | $2 floor |
| Guest was already theirs, paid via our QR | **$2 flat** |

- **Hotels corrected to 1500 bp** (Arroyo del Sol, Holiday Inn Express Edinburgh) — live in D1, no
  deploy. Closes the decision open since 30 Aug. Neither had taken a booking.
- **Walk-ins were FREE and are now $2 flat.** Not 3%: the money goes straight to the venue, so a
  percentage from Num stacks on their processor's ~2.9% and charges an acquisition rate for a guest
  Num did not acquire — ~6% all-in. A flat fee also cannot scale into a tax on their own regulars,
  which is the objection that actually loses merchants. 3% becomes right only if Num becomes the
  processor (Stripe Connect), because then it REPLACES their fee. Parked, not rejected.
- **`accrueBillPayment()` is a separate function on purpose.** `accrue()` resolves its rate as
  `rateBp ?? terms?.commission_bp ?? rate.bp`, and every venue carries `commission_bp = 1000` — so
  routing the walk-in through it would have billed 10% on the one path that must never scale. No
  percentage exists in the new function, so no override can resurrect one.
- Walk-in lines are keyed `bill:<token>` on `booking_id` (NOT NULL + unique index), so idempotency
  reuses the guard the table already has. `owed()`/`invoiceVenue()` select by `business_id`, so they
  invoice normally.
- **The volume being priced for does not exist.** 0 paylinks, 0 bills, 0 commissions, 0 invoices;
  15 scans, all unknown tokens, all from August test venues. Raising a price on a live merchant base
  is far harder than lowering one — stay at the category floor with room to discount.

## The flat fee was never $2 — fixed 12 Sep

Every flat fee was the bare integer `200`, and every `amount_cs` is minor units of the BILL'S OWN
currency. One number meant three prices: **US $2.00 · UK £2.00 (~$2.70) · Thailand ฿2.00 (~$0.06)**.
Bang Tao's "$2 per confirmed table" floor had been six cents since 26 Aug, and `money()` printed a
`$` regardless, so copy called 2 baht "$2". Found while updating the Thai invite, which would
otherwise have promised ฿2 in Thai beside $2 in English.

- `FLOOR_BY_CURRENCY`: **USD 200 · GBP 150 · EUR 200 · THB 7000**. Round numbers a merchant reads as
  a price, deliberately NOT from live FX — a floor that moves with the baht is one a venue cannot
  predict, and it would re-price unreported tables retroactively.
- `CURRENCY_BY_COUNTRY` now lives in the money layer and `growth/worker.js`'s `RAIL_BY_COUNTRY` is
  computed from it. The rail knew the currency and the thing that sets prices did not.
- **`booking_fee_cs` is `NOT NULL DEFAULT 200`, so the column always wins** and a fallback in the
  commission code can never fire. The fix had to go where the row is CREATED
  (`growth/venuesettings.mjs`), and `max_booking_fee_cs` with it — a CHECK refuses
  `booking_fee_cs > max_booking_fee_cs` and ฿70 (7000) exceeds its default 5000.
- Live D1, all six: TH → 7000 (max 175000), GB → 150, US → 200. **This raises a Thai venue's
  unreported-table floor from ฿2 to ฿70.** No retroactive effect — `num_commissions` is empty.

## Rate copy — one source, 12 Sep

- **The settle email was live and wrong.** It branched on `out.billed`, which went true for walk-ins,
  so a venue whose own regular paid by QR would have been emailed "NUM brought this table, so NUM's
  10% applies." It now branches on what was RECORDED and quotes `rate_bp` off the row.
- Statement page, console, invite generator and templates all read the rate from the ledger. Two
  venues bill 15% and every surface said 10%.
- Removed "About half of what OTAs take" — OTAs are 10–20%, so at 10% we are level, not half. A test
  already banned that claim elsewhere; it had survived in `invite_email.html`.
- `campaign/previews/*.html` left UNTOUCHED on purpose: they record what venues were actually sent.

## Job board fee — the poster pays, 12 Sep

The host welcome email promises "no commission on your work, no cut of anything you arrange".
`split(total)` took 5% OUT of the host — 200 quoted, 190 received. The board was not live, so nothing
was broken, but it would have been the day it shipped and the email had already gone out. Now
`quote(price)`: host paid in full, poster pays price + fee. **Renamed, not edited** — both take the
same shape of argument and mean different things by it, so a call site inheriting the old meaning
would have underpaid hosts in silence. `canConfirm` checks the GROSS, or the fee falls back onto the
host through the confirm path instead of the split.

## Walk-ins: the six are grandfathered

The invite said "You pay 10% only when a booking actually happens", and a walk-in is not a booking.
The six signed up as of 12 Sep keep free walk-ins **for good** — `walkin_fee_cs = 0`, held as data,
not a date check in code. New venues are invited on copy stating the fee before they sign.

## X and Grok — BUILT 12 Sep, two of three need keys

**Grok is a brain slot, not a new adapter.** `openai-compatible` already covered it — the note on the
`openai` brain said so. Added below `openai` and above `hosted`: structured (keeps cards and places)
and a FOURTH independent quota, which is what the 6–7 Aug outage was missing. **Ranked for
independence, not price** — grok-4.6 is $2/$6 per Mtok, dearer than the lanes above it, and the note
says so rather than implying a saving. Actions OFF until `NUM_XAI_ACTIONS=1`, on its own switch so
approving OpenAI's actions cannot approve xAI's. Needs `NUM_XAI_BASE_URL` (https://api.x.ai/v1) and
`NUM_XAI_KEY`.

- Grok prices added to `console.mjs` — an unpriced model falls through to OPUS's rate, which would
  report a Grok turn at ~4× its real cost and make the redundancy lane look unaffordable.
- New `fallbackModel` on a brain: the shared adapter used to default ANY openai-compatible brain to
  `gpt-5-mini`, so a vendor configured without its model variable was sent a rival's model name and
  failed with something that read like an outage. A test derives the price check FROM `BRAINS`, so
  adding a vendor cannot quietly add an unpriced one.

**Sharing costs nothing and needs no key.** `src/lib/xshare.ts` + a POST ON X button in `ShareSheet`.
It is a Web Intent — X's own compose box, pre-filled, sent by the member from their own account.

- **The post carries a REFERRAL link, never the connect link.** `connectLink()` attaches whoever
  opens it to that member: right for a QR across a table, wrong broadcast publicly, where it invites
  any stranger scrolling past to attach themselves to a named person. A test pins it.
- Budgeted as X counts it: a link is **23 characters** whatever its length, so the text is trimmed to
  280 − 24. Budget by the real URL length and X rejects the whole post instead of trimming it.
- The module is PURE (no `window`, no imports) so its test loads and RUNS the shipped code rather than
  asserting against a re-implementation. That is why its annotations are named aliases only.
- An `<a>`, not `window.open` — an installed PWA blocks programmatic popups, and a share button that
  silently does nothing is worse than none.

**Posting is PARKED — Dre's call, 12 Sep.** Posting goes through a browser and a human pressing Post,
not through the API. A link post costs $0.20 through the API and nothing through a browser, X has
never sent Num a measured visitor, and the browser route uses the same Web Intent as the member share
button — so every post is reviewed before it goes out. `growth/xpost.mjs` stays built, tested and OFF;
`NUM_X_BEARER` has never existed. **Enabling it is Dre's decision, not a tidy-up** — a test asserts
the file still says so, because a later session finding a finished poster sitting unused will want to
"finish" it.

**If it is ever unparked, it needs three things true at once:** a bearer token, `NUM_X_POSTING=1`,
and a caller. **Nothing is wired to a schedule, deliberately** — an agent that posts publicly on a
timer is a different product from a tool that posts when asked, and a test asserts the file has not
acquired a cron.

- **$0.015 a post, $0.20 for a post WITH A LINK** — and every post Num would make has one. The cost
  is computed from the post's own text, and `hasLink` errs EXPENSIVE on purpose: wrong the generous
  way over-states by 18.5 cents, wrong the other way under-states thirteenfold and the cap stops
  being a cap.
- **An unset budget means NO posting, not unlimited** — forgetting to set a cap must not be the same
  act as approving everything. Money is integer tenth-cents; `dollars()` keeps a third decimal for
  sub-cent amounts because two turned $0.015 into "$0.01".
- A token alone does not enable posting. 401/403 is not marked retryable; 429/5xx is.
- Needs a paid X developer account, `NUM_X_BEARER`, `NUM_X_POSTING=1`, `NUM_X_BUDGET_TC`.

## X Pay — NOT possible, and the name is ambiguous (checked 12 Sep)

- **X Pay cannot be integrated, and the name is ambiguous.** X Money: US-only limited beta since Mar
  2026 (Cross River Bank), consumer P2P plus a debit card, **no merchant or developer API**. A crypto
  product literally called "X Pay" went live on mainnet 11 Sep — unrelated.
- **Sharing needs no API.** A pre-filled compose link (Web Intent) is free, keyless, approval-free.
- **Posting does.** Free tier closed to new devs Feb 2026. $0.015/post — but **$0.20 for a post
  containing a link**, and every NUM post has one. 1,000 posts = $200, not $15.
- **Grok API is live** — grok-4.6 $2 in / $6 out per Mtok. The multi-brain plumbing already logs
  per-model cost, so a Grok slot is contained. Needs `XAI_API_KEY`.
- **No X or xAI MCP connector** exists; both are direct integrations.

## TWO SESSIONS ARE EDITING THIS TREE

On 12 Sep `cowork-num` (rates and copy) and `cowork-connections` (false-outage handling:
`worker/failures.mjs`, `health.mjs`, `maildelivery.mjs`, `falsedown.test.mjs`) both had uncommitted
work here at once. `release.mjs` bundles the WORKING TREE, not a commit, so **a ship by either
session carries the other's in-progress work to production.** Check `git status --short` and the claim
file before staging, and do not assume your changes are the only ones.

## Do not roll back a healthy deploy

`release:rollback` was written as the third code block after stage and ship on 12 Sep, Dre ran all
three in order, and wrangler sat one Enter away from reverting a good deploy — the trust-envelope
security fix included. Only the interactive prompt saved it. **Rollback is the emergency undo, never
a step.** Check `/api/health` for `verdict: ok` and `failing: 0` first; at the message prompt, Ctrl+C
aborts cleanly because nothing has been applied yet. `recipes/deploy.md` now says so.

## Known gaps

- `/api/social/requests` drops the connection (status 000) when a member id contains a quote character. The app survives it now; the endpoint still falls over.
- Host console is eleven stacked cards with no tabs.
- D1 token at `~/num-worktrees/.secrets/cf-d1.token` is still a placeholder.
- **A Cowork session cannot deploy, and the reason is not the build.** File-delete permission was granted on 12 Sep, so `npm run build` works now. The wall is further on: wrangler in the Cowork VM has no Cloudflare credentials at all — `$HOME/.wrangler` there holds only `logs/` and `metrics.json`, because that VM's home is not Dre's home, so his `wrangler login` is invisible to it. Every `wrangler` call fails with "necessary to set a CLOUDFLARE_API_TOKEN". **Staging and shipping are Dre's, full stop**, unless a scoped `CLOUDFLARE_API_TOKEN` is put where the session can read it.
- **`git` in a worktree needs two env vars ONLY INSIDE A COWORK SHELL — NEVER ON DRE'S MAC.**
  In the Cowork VM the worktree's `.git` file reads `gitdir: /Users/dre/Documents/…`, an absolute path
  that VM cannot resolve, so git there looks exactly like a broken repo. The fix, **for that shell
  only**, is `export GIT_DIR="$HOME/mnt/NUM/.git/worktrees/app-main" GIT_WORK_TREE="$HOME/mnt/num-worktrees/app-main"`.
  On Dre's own Mac the paths are real and **plain `git` works with no variables at all** — pasting
  those exports into his terminal resolves `$HOME` to `/Users/dre`, produces
  `/Users/dre/mnt/NUM/...` which does not exist, and then breaks EVERY git command in that window
  until `unset GIT_DIR GIT_WORK_TREE`. This happened on 12 Sep because a Cowork-only command was
  handed to Dre in a deploy block. **Never put those exports in a command block for Dre.** The repo is
  fine.

## Facts that cost tokens to rediscover

- **Two workers.** `worker/` → num-app (`app.itsnum.com`). `growth/worker.js` → num-growth (`itsnum.com/api/host/*`, `/api/admin/*` on that zone). Anything host-side ships with `npx wrangler deploy --config growth/wrangler.jsonc`.
- **`/api/admin/claims` is served by `index.mjs`, not `console.mjs`**, and is gated on an `X-Admin-Key` header. It answers 404, not 401, when the header is missing — deliberately, so a probe cannot confirm it exists.
- **Three claim tables**: `claims` (growth funnel), `num_claims` (canonical), `num_app_claims`. The morning alert reads `num_claims`; the approvals endpoint reads `claims`.
- **Git is fine.** The repo is at `/Users/dre/Documents/Claude/Projects/NUM/.git` with four worktrees. A Cowork shell cannot see `/Users` at all — that is a sandbox boundary, not a missing repo.
- **The release script commits only after tests pass**, so a failing stage leaves work uncommitted as well as unshipped.
