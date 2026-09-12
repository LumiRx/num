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
| Tests | 4,072 green, 0 lint errors, tsc clean |
| Release | `stage` then `ship`. Ship alone refuses; that guard is correct. |

## Live and working

- **Business side** — claim, promote-as-owner (`--owner`), sign-in links, SMS opt-in at signup, venue disclosures, add-to-home-screen prompt, stalled-claim queue and grant route.
- **Host side** — clients, requests (7 statuses), `.ics` calendar feed, products, host network, intros, messages, plan/billing, close account, integrity checker.
- **Host client book** (12 Sep) — `GET /api/host/book`: every client with their work folded in, whose move it is, days waiting, quiet clients, plus the next 30 days. Console shows "Your week" above the book.

## In flight

- **Luxury asset layer** (12 Sep) — migration `0021_luxury_assets.sql` + `worker/assetintegrity.mjs`
  built and tested (47 tests). Four tables: `num_assets` (yachts, jets, cars, villas with spec,
  home port, rate and settle mode), `num_asset_photos` (moderated), `num_asset_holds` (the table
  that stops one hull being sold twice), `num_inbound_media` (a photo texted in before we know
  which boat it is of). Service keys `yacht` / `jet` / `provisioning` added, and the three copies
  of that list are now bound by `worker/hostservices.test.mjs`. **Not yet built:** R2 binding, the
  Twilio MMS inbound route, endpoints, console cards.

- **Host job board** — `growth/hostjobs.mjs` shaping layer built and tested (30 tests). Routes, `num_host_jobs` table, member-facing section and console card still to build. Three product questions open, below.

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

**Posting needs three things true at once.** `growth/xpost.mjs`: a bearer token, `NUM_X_POSTING=1`,
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
