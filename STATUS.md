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
| Tests | 3,929 green, 0 lint errors |
| Release | `stage` then `ship`. Ship alone refuses; that guard is correct. |

## Live and working

- **Business side** — claim, promote-as-owner (`--owner`), sign-in links, SMS opt-in at signup, venue disclosures, add-to-home-screen prompt, stalled-claim queue and grant route.
- **Host side** — clients, requests (7 statuses), `.ics` calendar feed, products, host network, intros, messages, plan/billing, close account, integrity checker.
- **Host client book** (12 Sep) — `GET /api/host/book`: every client with their work folded in, whose move it is, days waiting, quiet clients, plus the next 30 days. Console shows "Your week" above the book.

## In flight

- **Host job board** — `growth/hostjobs.mjs` shaping layer built and tested (30 tests). Routes, `num_host_jobs` table, member-facing section and console card still to build. Three product questions open, below.

## Open decisions (Dre's, not mine)

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
- **`git` in a worktree needs two env vars from a Cowork shell.** `.git` there reads `gitdir: /Users/dre/Documents/…`, an absolute path the VM cannot resolve, which looks exactly like a broken repo. `export GIT_DIR="$HOME/mnt/NUM/.git/worktrees/app-main" GIT_WORK_TREE="$HOME/mnt/num-worktrees/app-main"` and it works. The repo is fine.

## Facts that cost tokens to rediscover

- **Two workers.** `worker/` → num-app (`app.itsnum.com`). `growth/worker.js` → num-growth (`itsnum.com/api/host/*`, `/api/admin/*` on that zone). Anything host-side ships with `npx wrangler deploy --config growth/wrangler.jsonc`.
- **`/api/admin/claims` is served by `index.mjs`, not `console.mjs`**, and is gated on an `X-Admin-Key` header. It answers 404, not 401, when the header is missing — deliberately, so a probe cannot confirm it exists.
- **Three claim tables**: `claims` (growth funnel), `num_claims` (canonical), `num_app_claims`. The morning alert reads `num_claims`; the approvals endpoint reads `claims`.
- **Git is fine.** The repo is at `/Users/dre/Documents/Claude/Projects/NUM/.git` with four worktrees. A Cowork shell cannot see `/Users` at all — that is a sandbox boundary, not a missing repo.
- **The release script commits only after tests pass**, so a failing stage leaves work uncommitted as well as unshipped.
