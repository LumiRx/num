# NUM — STATUS

The ledger. **Read this first in a fresh chat; do not re-read the codebase to
learn what is already known.** One screen of state, updated at the end of every
run. Detail lives in the project docs, not here.

_Last updated: 2026-09-14 · production **0.8.298 live and healthy** (health verdict ok, 0 failing, 02:25 UTC) · voice layer and the deep-tissue retrieval fix both LIVE_

---

## Where things stand

| Area | State |
|---|---|
| App (num-app) | **0.8.275 live**, shipped 18:45 UTC 12 Sep. `/api/health` ok, 0 failing. `verify_5arz` now true from `FIVEARZ_API_KEY`, `google_auth` reported separately. |
| Growth (num-growth) | Deployed 12 Sep — host client book live. |
| Tests | 4,801 green, 0 lint errors, tsc clean (travel-speak + voice lints both wired into `npm test`) |
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

## The business console has a front door — 13 Sep

`itsnum.com/biz` was a **404** and five of the seven console pages linked to nothing. Worse,
there were **two auth systems that never consulted each other**: `/biz/tables` and
`/biz/statement` use `qrWho` (email magic-link session); `/biz/codes`, `/visitors`, `/offers`,
`/pay` and `/settings` use `bizAuth` (a permanent `console_key` in the query string). A venue
that signed in by email could reach TWO pages out of seven.

- **`/biz` is the hub**: venue name, this week's running total read off *their* ledger (rate from
  `num_business_settings`, never typed), tiles to the other six filtered by role.
- **One nav, rendered by `qrShell`**, so a new page cannot be built without it.
- **`bizAuth` now accepts an OWNER's session.** Owner only — a console key is owner-level
  authority and staff/readonly must not inherit it. Logged `via=owner_session`.
- **Route pattern changed `itsnum.com/biz/*` → `itsnum.com/biz*`.** "/biz/*" does not match a bare
  "/biz". Fourth time that trap has appeared here. `growth/bizhub.test.mjs` asserts the pattern.

**The link to give a business is now `itsnum.com/biz` and nothing else.**

**Still open:** `console_key` is a permanent bearer token in a URL — history, referrers,
screenshots. Now that an owner session reaches everything it does, it can be retired: stop
putting it in outbound links, keep accepting it, remove it last.

## Small connections — and the one number Num may not guess — 13 Sep

Four specialists ahead of the commercial ones, so "I need a chemist" cannot route to the spa:
**urgent** (pharmacy, doctor, lost passport/phone/wallet), **arrival** (SIM, money, plug, water,
tipping, holidays), **access** (wheelchair, pushchair, baby, dog, allergies), **errand**
(laundry, barber, repairs, printing, parcels).

**`worker/emergency.mjs` is a CHECKED TABLE, and the model is forbidden from answering from
memory.** Ambulance in Thailand is 1669, Japan 119, UAE 998 — almost nowhere is it 911. The
verified sentence is pushed into the prompt **only when asked**, with "reproduce this exactly,
never substitute one you remember".

**An unknown country returns null** — never 911, never a neighbour's. It gets the honest
fallback (112, and that it dials from a locked screen with no SIM). **BB and BS are absent on
purpose**: both run three-digit services alongside 911 routing and neither could be verified to
the standard. A test asserts every covered country is present or knowingly absent, so adding a
destination Num cannot answer this for fails the build.

**The limit worth knowing:** the urgent brief is only as good as `hours_mask` on pharmacies and
clinics, and the places index was built for restaurants. A pharmacy shown as open at midnight
and shut is the one failure this cluster cannot afford — check hours coverage on those
categories in the three live cities before leaning on it.

## The Friday pack draw — LIVE as of 13 Sep 2026

Ten sealed Pokémon packs a week, **ten winners, one each**. Dre bought the packs 12 Sep.

| Piece | Where | State |
|---|---|---|
| Entry code `PACKS`, both doors | `worker/giveaway.mjs` (the only writer) → num-app | **live** (0.8.292) |
| Card-shop search | `worker/cardshops.mjs` → num-app | **live** |
| Official Rules | `growth/fridayrules.mjs` → num-growth | **live**, itsnum.com/friday-rules returns 200 |
| The draw | `worker/fridaydraw.mjs` → num-app | **live**, `POST /api/admin/draw` behind `isAdmin` |
| The button | app.itsnum.com/ops/ → **Friday draw** tab | **live** — preview the count, then confirm |

### It was broken in production until 13 Sep, and the shape is worth remembering

Two sessions built it in parallel and the halves were half-shipped. 0023 keyed entries
`(phone, week_start)`; `giveaway.mjs` wrote that and worked, `packdraw.mjs` — wired into the
app's reply path — wrote `week_key`, **so every in-app entry failed**, and `fridaydraw.mjs`
read `week_key` too and could not have run even with a route. All three carried their own
`CREATE TABLE IF NOT EXISTS`, silent no-ops against a table that already existed.

Worst of it: the draw's entrant read ended `.catch(() => ({ results: [] }))`, so **a broken
query would have reported "nobody entered"** — indistinguishable from a quiet week, so
nobody would have looked.

Migration **0026** gives an entry one identity, `entrant_key`: `phone:+44…` when we hold a
number, `member:mem_…` otherwise, because **107 of 147 members have no phone**. The app
resolves the phone first, so one human cannot hold two tickets. One writer now
(`giveaway.mjs`); `worker/drawwiring.test.mjs` asserts the draw has a caller, the caller has
a route, the route sits behind the guard, and no module has grown its own table again.

**Both test files were rewritten against the real migration SQL.** They ran on hand-written
fakes before, which accept any statement — that is precisely why this shipped.

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

**Still not done: telling the winners.** `runDraw` returns a phone or a member id for each
winner and records both on the claim row, but nothing sends the message. With outbound SMS
failing 30034 and in-app delivery at 1 of 117, **how a winner actually hears is unsolved** —
and it is the same four Apple secrets that block the whole notification layer.

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

## The voice layer — Num now writes the way the guest writes — 13 Sep

`soulprofile.mjs` learns WHAT to recommend. The house `VOICE` in
`specialists.mjs` is one voice for everybody. Nothing decided how Num sounds to
**this** guest. `worker/register.mjs` is that missing half, and it is the
cheapest possible version of it.

**Why it is worth doing at all.** Montoya, Horton & Kirchner's meta-analysis:
actual similarity predicts liking at r = .55 with no interaction, r = .25 after
a short conversation, r = .12 in established relationships — and nothing at all
in field studies once publication bias is corrected. *Perceived* similarity
never decays. Num cannot be like anybody; it can sound like them, and that is
the half that was carrying the weight. The mechanism is language style matching
(Ireland/Pennebaker 2011: OR 3.05 for wanting a second date, OR 1.95 for still
dating at three months) and it works entirely **below conscious awareness** —
undetectable by speakers and by trained observers. That is why this reads
behaviour and never asks. People cannot report how they write.

**NO TABLE, NO MIGRATION, NOTHING STORED.** The first design stored dials per
subject like soulprofile and it was wrong: register is not a lasting fact, it
is how somebody is typing right now, and the messages are already in `history`
on every turn. Pure synchronous function over at most 8 strings. There is no
row to leak, subpoena or migrate — the strongest form of the rule soulprofile
already states. It cannot go stale, it works on the first conversation for
anonymous devices, and applied migrations here are sealed for good reason.

**It reads three things** off the guest's own messages, and returns null — Num
exactly as today — unless it is sure: length (terse / expansive), emoji
(yes / no), warmth (warm / brisk). `CONFIDENT_AT = 3`, borrowed whole from
soulprofile: one mention is a mood, three is a pattern.

**Two things the first cut got wrong, both caught before shipping:**

- **Thai read as maximally terse.** Thai does not put spaces between words, so
  splitting on whitespace returned 1 for a full sentence — every Thai guest, in
  a live market, served clipped replies for ever. `wordsIn` is script-aware
  (Thai/Japanese/Chinese counted by character). Thai and Japanese warmth
  markers added too: ครับ/ค่ะ/ขอบคุณ/สวัสดี are the clearest register signal
  Thai has, and an English-only word list made every Thai guest invisible.
- **Nearly everybody read as brisk.** Short lowercase messages with no full
  stop are just how people type on a phone. `BRISK_AT = 5` — a higher floor for
  DROPPING warmth than for matching length, because the cost is not symmetric:
  Tickle-Degnen & Rosenthal find positivity carries most weight *early*, so
  being wrongly cold in the first messages costs more than being wrongly warm.

**Where it attaches, and the cache trap it avoids.** NOT into `PERSONA + VOICE`
at `index.mjs:130` — that prefix sits above the `cache_control` breakpoint
precisely because it is identical for every guest, and a per-guest line there
would miss the prompt cache on **every single request**. It goes into the
per-turn `contextBlock` `style` slot instead, merged with the existing
`styleBlock`, at both the Claude path and the fallback chain. The two do not
conflict: `styleBlock` is learned from what a guest reacted well and badly to,
`registerFor` from how they write; reactions win.

**The guardrail, and it is the load-bearing part.** A voice layer that can
reach the recommendation is a personalised sales engine, and the difference is
the whole reason NUM can say it cannot be bought. `register.test.mjs` greps the
module for venue, ranking, price and ordering vocabulary and fails on any of
it, and asserts the module touches no database, network or storage. It also
asserts the block can never raise the 3-sentence/40-word cap and never tells
the guest it exists — style matching works because it is invisible. The
guardrail already earned itself: it caught the word "pick" in the block's own
output text on the first run.

**Superseded the same day** — the wheel, framing and reassurance dials and the
house-voice rewrite landed in the second pass below. Still not built: the
onboarding quiz, and choice width as a separate dial (the wheel covers most of
it in practice). Framing and reassurance touch money and trust
and should be set from behaviour, not one tap on a signup card. Full framework
in the project doc `num-VOICE-MATCHING-PSYCHOLOGY-2026-09-13`.

## The voice itself — the house voice now follows the research, and forms per guest — 13 Sep

Second pass on the voice layer. The first built the mechanism; this one wrote
the actual voice and made the rules enforceable. Framework docs:
`num-VOICE-MATCHING-PSYCHOLOGY-2026-09-13` and
`num-VOICE-HOW-TO-BE-BELIEVED-2026-09-13`.

**`VOICE` in `specialists.mjs` gained six rules and lost one contradiction.**

1. Never instruct ("you should/must/need to") — controlling language reliably
   produces resistance, r ≈ .20 across 33 studies. **With one exception that
   overrides every softening rule above it:** when a guest is about to lose
   money, miss a deadline, be turned away at a border or eat something they
   avoid, it is said flat and said FIRST. This is the fix for a real conflict —
   the existing line *"never contradict flatly, fold the correction in gently"*
   is right for an ordinary turn and produces, on a safety turn, exactly the
   hedged deferential speech the aviation literature identifies as the thing
   that gets missed (first officers hint; 75% of 37 NTSB accidents reviewed
   involved monitoring or challenging errors). That line now carries the carve-out.
2. Confidence on the advice, honesty on the facts — and name what was actually
   checked. Evidence of real work was the *only* unique predictor of whether
   advice gets taken across 346 effect sizes.
3. Never invent a reason. Langer's placebic "because" collapses to baseline on
   any request that matters (24% vs 24% at twenty pages).
4. Do the work, do not narrate the rescue. Help the recipient notices as help
   was **worse than no help at all** (d = 0.63–1.09), ~55% of it through
   perceived inefficacy.
5. Never mention the arrangement — no tiers, plans, allowances or costs inside
   a conversation. Exchange language is punished far harder inside a warm frame
   (3.33 vs 6.04) than inside a transactional one.
6. Never claim the friendship. Behave like somebody who cares; never say it.

Plus: name every wait; never ask deeper than the guest has gone; teasing is
earned and never aimed at them.

**`worker/register.mjs` now reads six things, all from behaviour, none stored.**
Length, emoji and warmth (shipped this morning) plus **the wheel** (hands it
over → Num decides; holds it → Num lays out the field — the one dial the
evidence says to INVERT, and honestly it is ergonomics not affection: only
warmth complementarity predicted liking), **framing** (prevention vs promotion,
two hits and a clear margin, because it changes how money and plans are
described) and **reassurance** (chased twice = speak before being asked).

**`worker/goodnews.mjs` is new — the one turn Num must not answer efficiently.**
Active-constructive responding predicts satisfaction r = .29–.47 and trust
.33–.70; the reason it needs its own module is that **passive-constructive
responding predicts POORER outcomes** — the mild, efficient, entirely
inoffensive "glad it went well" is a cost, not a neutral, and it is exactly
what a length-capped concierge says by default. It lands in `extraSystem`
(pushed LAST into the system array) and **suppresses the soulprofile earned
question**, because a guest who has just said their anniversary dinner was
perfect must not be asked whether they prefer buzzing or quiet.

Three corrections made during the build, all before shipping:

- **It does not lift the length cap.** The first draft did. `proseSystem` puts
  the style slot BEFORE the brief carrying the cap, and the fallback chain has
  no slot after it — so a cap-lifting instruction would have worked on Claude
  and silently failed on every other brain. And the evidence never said brevity
  was the failure: passive-constructive fails because it CLOSES THE SUBJECT.
  *"That is brilliant, what did you end up ordering?"* is nine words and right.
- **The wheel line said "say it is done or ready"** — which contradicts the
  house rule that nothing is ever stated as held, booked or confirmed. Caught in
  a demo, not a test. `worker/register.mjs` and `worker/goodnews.mjs` are now in
  **travelspeak-lint's LINTED list** so a per-guest line can never teach booking
  language again.
- False-positive discipline on good news: a request that merely contains a warm
  word ("find somewhere incredible") is a brief, not good news. Answering a
  booking request with delighted questions is the embarrassing failure, so
  ASKING shapes win outright and the test suite holds that line.

**`scripts/voice-lint.mjs` — the rules are now enforceable.** Same family as
travelspeak-lint and head-price-lint, wired into `npm test`, so a hit fails the
build. Five rules: instructing, accounting language in conversation, claiming
friendship, taking credit, closing down good news. String literals only (same
reason travelspeak-lint learned: linting comments in a repo that comments this
heavily gets the rule switched off within a week), **with a negation escape
hatch** so the house voice can teach "never say you should" without tripping —
window is 48 characters so a distant "never" cannot smuggle one through. Its own
test fires every rule deliberately: a lint proved only by passing is not proved.

4,800 tests green, both lints clean. **SHIPPED 0.8.296, 23:55 UTC 13 Sep — health ok, 0 failing.**

## A barbershop was offered for deep-tissue massage — three faults — 14 Sep

A guest in Los Angeles asked for deep tissue and got **one** result: Platinum
Cuts Barbershop, whose website 403s. Three independent faults, all now fixed and
all covered by `ai/places.subintent.test.js`, which reproduces the exact query
against a real SQLite.

**1 · "Deep tissue" matched no category keyword.** `detectCat('Deep tissue')`
returned null — the phrase contains neither "massage" nor "spa" — so the search
fell through to `DEFAULT_PATTERNS`, which include `%spa%`. Sub-intent words are
now in `CATS.spa` (deep tissue, sports massage, shiatsu, reflexology, hot stone,
facial, manicure, sauna…).

**2 · The topic was in the PREVIOUS turn, and nothing read it.** Num had just
asked "full-service spa, quick walk-in, or sports/deep-tissue massage?" — the
answer only makes sense against the question. `nearbyPlaces` now takes a
`topicHint` (the last four turns, built in `index.mjs`, threaded through
`grounding.mjs`). It is used for the **category only** — never for location, so a
city named three turns ago cannot follow a guest around — and it never overrides
a category the current message states outright. A test pins both.

**3 · Google files a barbershop and a real day spa under the SAME category.**
Both are "Beauty & spa", so no category pattern can separate them and `%beauty%`
could not simply be dropped without losing genuine spas. The separation moved to
the **name**: `GROOMING` excludes barber/nail/braid/lash/brow/waxing/hair-salon
names. **The exclusion follows the SUB-INTENT, not the category** — the first cut
keyed it on the category and its own test caught that a manicure ask could no
longer reach a nail bar.

**Plus: the specific ask now survives the category.** `subIntent()` turns "deep
tissue" into a `%massage%` ranking bonus (0.6 — about the gap between a 4.2 and a
4.8, so it reorders a good set without dragging a bad place up). Before this,
"deep tissue" and "manicure" searched identically.

**And one fault was mine, from yesterday's voice layer.** The register block told
a terse guest to "answer first… well under the cap", which reads as permission to
name one place, against the house rule of three. The wheel dial said "give ONE
answer" outright. Both now say the LIST is never negotiable: terse controls
length, the wheel controls how hard Num steers *inside* the list. Dre, 14 Sep:
*"when we are recommending locations, just make sure to get a list of locations
not just one."*

### The 403 is not a bug, and that is the problem

`scripts/enrich_liveness.mjs` deliberately does **not** mark a 403 dead — only
404/410 and DNS failure earn `alive = 0`, because a bot wall is not a closed
business. It records `unknown: http403` instead. So **we already know which sites
403 our crawler and we do nothing with it.** A site that blocks a crawler very
often blocks an in-app webview too, which is exactly what the guest hit.

Two possible fixes, **Dre's call, neither built**:
- **Data:** treat a repeatedly-403 site as "not reliably reachable" and prefer the
  map link (`placelink.mjs` already has that fallback for dead sites). Needs
  somewhere to record the repeat — `alive` is ternary and should not be overloaded,
  so this is a migration.
- **Client:** open external links in the system browser rather than the in-app
  webview. Probably the real fix for the guest, and no schema change.

4,801 tests green, both lints clean. **SHIPPED 0.8.298, 02:25 UTC 14 Sep — health ok, 0 failing. Not yet re-tested against live data** — the seeded test proves the logic, only a live ask proves the category labels in production match it.

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
