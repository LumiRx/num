# NUM — STATUS

The ledger. **Read this first in a fresh chat; do not re-read the codebase to
learn what is already known.** One screen of state, updated at the end of every
run. Detail lives in the project docs, not here.

_Last updated: 2026-09-12 · production 0.8.259 (app) · growth deployed same day_

---

## Where things stand

| Area | State |
|---|---|
| App (num-app) | 0.8.259 live. Crash on `inbox.connects` fixed and shipped 9 Sep. |
| Growth (num-growth) | Deployed 12 Sep — host client book live. |
| Tests | 3,847 green, 0 lint errors |
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

**`/api/version` reports `verify_5arz: true` and it is a lie** — the field is `!!env.GOOGLE_CLIENT_ID`.
There is no 5arz call anywhere in this codebase yet.

## Known gaps

- `/api/social/requests` drops the connection (status 000) when a member id contains a quote character. The app survives it now; the endpoint still falls over.
- Host console is eleven stacked cards with no tabs.
- D1 token at `~/num-worktrees/.secrets/cf-d1.token` is still a placeholder.
- A Cowork session cannot delete files in the connected folder, so it cannot run `npm run build`. Deploys are Dre's until that permission is granted.

## Facts that cost tokens to rediscover

- **Two workers.** `worker/` → num-app (`app.itsnum.com`). `growth/worker.js` → num-growth (`itsnum.com/api/host/*`, `/api/admin/*` on that zone). Anything host-side ships with `npx wrangler deploy --config growth/wrangler.jsonc`.
- **`/api/admin/claims` is served by `index.mjs`, not `console.mjs`**, and is gated on an `X-Admin-Key` header. It answers 404, not 401, when the header is missing — deliberately, so a probe cannot confirm it exists.
- **Three claim tables**: `claims` (growth funnel), `num_claims` (canonical), `num_app_claims`. The morning alert reads `num_claims`; the approvals endpoint reads `claims`.
- **Git is fine.** The repo is at `/Users/dre/Documents/Claude/Projects/NUM/.git` with four worktrees. A Cowork shell cannot see `/Users` at all — that is a sandbox boundary, not a missing repo.
- **The release script commits only after tests pass**, so a failing stage leaves work uncommitted as well as unshipped.
